// Wspólny moduł sprawdzania wymowy (Web Speech API) dla stron lekcji i powtórek.
// Audio i mikrofon na iOS 27 (Safari i Chrome = WebKit):
//  1. mp3 gra przez Web Audio (jeden AudioContext; martwy po uśpieniu karty = zegar stoi, wymieniany w geście), nigdy <audio>,
//     bo element <audio> dezaktywuje wspólną sesję audio po "ended" (WebKit bug 317741).
//  2. navigator.audioSession: "playback" bezczynnie (głośno, mimo przełącznika wyciszenia), "play-and-record" od naciśnięcia
//     mikrofonu do końca nasłuchu, ustawiane PRZED recognition.start(). Web Speech nagrywa w procesie GPU, a strona o tym nie
//     wie: przy "playback" jednostka nagrywająca dostaje ciszę (onstart/onaudiostart przychodzą i tak, nie dowodzą niczego).
//  3. Po onstart (nigdy przed start(): głuche sesje) getUserMedia nagrywa równolegle: widać, czy mikrofon coś słyszy,
//     a gdy Web Speech nic nie zwróci mimo głosu w nagraniu, tekst daje Whisper (worker /wymowa).
//  4. Nowa instancja SpeechRecognition na sesję, zdarzenia starych ignorowane; użytkownik kończy, puszczając przycisk;
//     strona ukryta = sesja porzucona.
//
// Silniki: "system" (domyślny: Web Speech + nagranie awaryjne) i "chmura" (tylko nagranie + Whisper).
// localStorage "kubus.wymowa.silnik" = auto | system | chmura; w URL: ?silnik=chmura
// Adres workera: window.SYNC_URL (wstawia build.py); klucz: localStorage "kubus.powtorka.sync" (jak sync powtórek).
//
// Użycie:
//   Wymowa.beforeStart = () => { /* tylko UI, audio zatrzymuje moduł */ };
//   Wymowa.bind(btn, { target: () => "朋友", onStart(), onInterim(text), onDone(result) });  wynik wstępny moduł pokazuje w przycisku; strony nie ruszają układu w trakcie mówienia
//   Wymowa.graj(url, { onEnd(przerwane) }) -> Promise<bool>;  Wymowa.stopAudio();  Wymowa.preload(url)
//   result = { alts: [...], gotFinal, error, heldMs, started }
//   Wymowa.render(result, target) -> { cls, html, grade }
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const strip = s => s.replace(/[\p{P}\p{S}\s]/gu, ""); // cała interpunkcja i symbole (też „……” w kartach typu 我想喝……)
  const toPinyin = s => (window.pinyinPro ? pinyinPro.pinyin(s) : "");
  const toPinyinNoTone = s => (window.pinyinPro ? pinyinPro.pinyin(s, { toneType: "none" }) : s);

  // Dziennik zdarzeń mikrofonu widoczny na stronie (na telefonie nie ma konsoli).
  let diagEl = null;
  const KLUCZ_DIAG = "kubus.wymowa.diag";
  function diag(msg) {
    if (!diagEl) {
      diagEl = document.getElementById("diag-log");
      // dziennik sprzed przeładowania (tryb system-reload)
      if (diagEl) { try { const stary = sessionStorage.getItem(KLUCZ_DIAG); if (stary) { diagEl.textContent = stary + "---------- przeładowanie strony ----------\n"; sessionStorage.removeItem(KLUCZ_DIAG); } } catch (e) {} }
      if (diagEl) dodajKopiuj(diagEl);
    }
    const line = new Date().toISOString().slice(11, 23) + " " + msg;
    console.log("[wymowa] " + msg);
    if (diagEl) { diagEl.textContent += line + "\n"; diagEl.scrollTop = diagEl.scrollHeight; }
  }
  // Guzik „kopiuj dziennik” nad <pre id="diag-log"> (jeden klik = cały dziennik w schowku, do wklejenia w wiadomości).
  function dodajKopiuj(pre) {
    if (pre.parentNode.querySelector(".diag-kopiuj")) return;
    const b = document.createElement("button"); b.type = "button"; b.className = "diag-kopiuj"; b.textContent = "kopiuj dziennik";
    b.style.cssText = "font: inherit; font-size: 12px; margin: 4px 0 6px; padding: 4px 10px; border-radius: 8px; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer;";
    const komunikat = (t) => { b.textContent = t; setTimeout(() => { b.textContent = "kopiuj dziennik"; }, 1500); };
    b.addEventListener("click", async () => {
      const tekst = pre.textContent;
      try { await navigator.clipboard.writeText(tekst); komunikat("skopiowano ✓"); return; } catch (e) {}
      // starsze WebKit / brak uprawnień: zaznacz i skopiuj przez execCommand
      try {
        const ta = document.createElement("textarea"); ta.value = tekst; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;left:-9999px;top:0;";
        document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, tekst.length);
        const ok = document.execCommand("copy"); document.body.removeChild(ta);
        komunikat(ok ? "skopiowano ✓" : "nie udało się – zaznacz ręcznie");
      } catch (e) { komunikat("nie udało się – zaznacz ręcznie"); }
    });
    pre.parentNode.insertBefore(b, pre);
  }
  const IOS_VER = (navigator.userAgent.match(/OS (\d+)_(\d+)/) || [])[1];
  const GUM = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const AC = window.AudioContext || window.webkitAudioContext;
  const AS = ("audioSession" in navigator) ? navigator.audioSession : null;
  const ODSTEP_PO_TTS = 3500;    // tylko po speechSynthesis (głos systemowy)
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // parametry testowe z URL -> localStorage
  (function () {
    try {
      const q = new URLSearchParams(location.search);
      for (const [p, k] of [["silnik", "kubus.wymowa.silnik"]])
        if (q.has(p)) localStorage.setItem(k, q.get(p));
    } catch (e) {}
  })();

  function cfg() {
    const ls = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    let sync = {}; try { sync = JSON.parse(ls("kubus.powtorka.sync") || "{}"); } catch (e) {}
    const silnik = ls("kubus.wymowa.silnik") || "auto";
    const url = (sync.url || window.SYNC_URL || "").replace(/\/$/, ""), klucz = sync.klucz || "";
    const chmuraOk = !!(url && klucz && GUM && AC);
    const uzyj = silnik === "chmura" && chmuraOk ? "chmura" : "system";
    return { url, klucz, silnik, uzyj, chmuraOk };
  }
  diag("UA: " + navigator.userAgent);
  diag("iOS: " + (IOS_VER || "nie") + ", SpeechRecognition: " + (SR ? "jest" : "BRAK") + ", getUserMedia: " + (GUM ? "jest" : "BRAK") + ", AudioContext: " + (AC ? "jest" : "BRAK") + ", audioSession: " + (AS ? "jest (" + AS.type + ")" : "BRAK"));
  diag("silnik: " + cfg().uzyj + " (ustawienie " + cfg().silnik + ", chmura " + (cfg().chmuraOk ? "dostępna" : "niedostępna: brak adresu/klucza") + ")");

  function similarity(a, b) {
    // LCS na sylabach pinyin bez tonów (odporne na homofony), fallback na znaki
    const A = toPinyinNoTone(a).split(" "), B = toPinyinNoTone(b).split(" ");
    const dp = Array.from({ length: A.length + 1 }, () => Array(B.length + 1).fill(0));
    for (let i = 1; i <= A.length; i++) for (let j = 1; j <= B.length; j++)
      dp[i][j] = A[i - 1] === B[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    return dp[A.length][B.length] / Math.max(A.length, B.length);
  }

  // Ocena rozpoznanego tekstu względem celu.
  // level: exact | tones (sylaby OK, tony do sprawdzenia) | close | bad | none
  function grade(target, alts) {
    const t = strip(target);
    alts = (alts || []).map(strip).filter(a => a);
    if (!alts.length) return { level: "none", best: "", heardPy: "", targetPy: toPinyin(t), score: 0, target: t };
    let best = alts[0], bestScore = -1;
    for (const a of alts) { const sc = similarity(t, a); if (sc > bestScore) { bestScore = sc; best = a; } }
    const level = alts.includes(t) ? "exact" : bestScore >= 0.99 ? "tones" : bestScore >= 0.5 ? "close" : "bad";
    return { level, best, heardPy: toPinyin(best), targetPy: toPinyin(t), score: bestScore, target: t };
  }

  const LABEL_IDLE = "🎤 przytrzymaj i mów";

  function render(result, target) {
    if (result.error) return { cls: "bad", html: result.error, grade: null };
    const g = grade(target, result.alts);
    const note = result.gotFinal ? "" : " <i>(wynik wstępny)</i>";
    const t = g.target;
    if (g.level === "none") {
      const html = result.started === false ? "Puściłeś przycisk, zanim nasłuch się uruchomił. Przytrzymaj, poczekaj na „mów teraz”, powiedz słowo, dopiero wtedy puść."
        : result.heldMs < 400 ? "Za krótko. Przytrzymaj przycisk, poczekaj na „mów teraz”, powiedz słowo, dopiero wtedy puść."
        : "Nic nie usłyszałem. Przytrzymaj, poczekaj na „mów teraz”, powiedz i puść.";
      return { cls: "bad", html, grade: g };
    }
    if (g.level === "exact") return { cls: "ok", html: `✓ Idealnie. Usłyszałem: <b>${t}</b> (${g.targetPy})${note}`, grade: g };
    const trener = trenerHtml(g);
    if (g.level === "tones") return { cls: "ok", html: `✓ Sylaby OK, sprawdź tony. Usłyszałem: <b>${g.best}</b> (${g.heardPy}), cel: ${g.targetPy}${note}${trener}`, grade: g };
    if (g.level === "close") return { cls: "mid", html: `~ Blisko. Usłyszałem: <b>${g.best}</b> (${g.heardPy})<br>cel: ${t} (${g.targetPy})${note}${trener}`, grade: g };
    return { cls: "bad", html: `✗ Usłyszałem: <b>${g.best}</b> (${g.heardPy})<br>cel: ${t} (${g.targetPy})${note}${trener}`, grade: g };
  }

  // ---- trener tonów: wykres konturów (cel vs usłyszane) + rada od Claude (worker /trener) ----
  // Tony "usłyszane" wynikają ze znaków, które zwróciło rozpoznawanie (homofon z innym tonem = zły ton).
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const KLUCZ_TONY = "kubus.tony";
  // kontury tonów w polu 40x30: 1 równy wysoko, 2 rosnący, 3 opadająco-rosnący, 4 opadający, 5 neutralny (kropka)
  const KONTUR = { 1: "M4 7 L36 7", 2: "M4 24 L36 6", 3: "M4 11 L20 26 L36 9", 4: "M4 4 L36 26" };
  const svgTon = (ton, cls) => `<svg class="ton ${cls}" viewBox="0 0 40 30" aria-label="ton ${ton || "?"}">` +
    (ton == null ? "" : ton === 5 ? `<circle cx="20" cy="16" r="3.5"/>` : `<path d="${KONTUR[ton]}"/>`) + `</svg>`;
  // sylaby pinyin z numerem tonu: [{py: "nǐ", baza: "ni", ton: 3}], nie-chińskie znaki pomijamy
  function sylabyZTonami(s) {
    if (!window.pinyinPro) return [];
    const num = pinyinPro.pinyin(s, { toneType: "num", type: "array" }), sym = pinyinPro.pinyin(s, { type: "array" }), znaki = [...s];
    const out = [];
    num.forEach((n, i) => { const m = /^([a-zü]+)(\d)$/i.exec(n); if (m) out.push({ py: sym[i], baza: m[1].toLowerCase(), ton: Number(m[2]) || 5, znak: znaki[i] || "" }); });
    return out;
  }
  // dopasowanie sylab celu do usłyszanych (LCS po bazie bez tonu); brak pary = null
  function dopasuj(cel, usl) {
    const n = cel.length, m = usl.length, dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++)
      dp[i][j] = cel[i - 1].baza === usl[j - 1].baza ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    const pary = Array(n).fill(null);
    for (let i = n, j = m; i > 0 && j > 0;) {
      if (cel[i - 1].baza === usl[j - 1].baza) { pary[i - 1] = usl[j - 1]; i--; j--; }
      else if (dp[i - 1][j] >= dp[i][j - 1]) i--; else j--;
    }
    return cel.map((c, i) => ({ znak: c.znak, cel: c.py, baza: c.baza, celTon: c.ton, usl: pary[i] ? pary[i].py : null, uslTon: pary[i] ? pary[i].ton : null }));
  }
  function zapiszTon(ton) { try { const t = JSON.parse(localStorage.getItem(KLUCZ_TONY) || "{}"); t[ton] = (t[ton] || 0) + 1; localStorage.setItem(KLUCZ_TONY, JSON.stringify(t)); } catch (e) {} }
  function slabyTon() { try { const t = JSON.parse(localStorage.getItem(KLUCZ_TONY) || "{}"); let b = null; for (const k in t) if (!b || t[k] > t[b]) b = k; return b && t[b] >= 3 ? { ton: b, razy: t[b] } : null; } catch (e) { return null; } }

  // ---- podpowiedzi deterministyczne (bez LLM): pinyin -> polski zapis + esencja, jak zrobić dźwięk i ton ----
  // Ten sam zapis co w wymowa.json i w prompcie trenera (p/t/k = bez dmuchnięcia, ph/th/kh/czh/cch/ćh = z dmuchnięciem).
  const INICJALY = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s"];
  const INI_PL = { b: "p", p: "ph", m: "m", f: "f", d: "t", t: "th", n: "n", l: "l", g: "k", k: "kh", h: "ch", j: "dz", q: "ćh", x: "s", zh: "cz", ch: "czh", sh: "sz", r: "ż", z: "dz", c: "cch", s: "s", "": "" };
  const FIN_PL = { a: "a", o: "o", e: "y", i: "i", u: "u", "ü": "ü", ai: "aj", ei: "ej", ao: "ał", ou: "oł", an: "an", en: "yn", ang: "ang", eng: "yng", ong: "ung", er: "ar",
    ia: "ia", ie: "ie", iao: "iał", iu: "ioł", ian: "ien", in: "in", iang: "iang", ing: "ing", iong: "iung",
    ua: "ła", uo: "ło", uai: "łaj", ui: "łej", uan: "łan", un: "łyn", uang: "łang", ueng: "łyng", "üe": "üe", "üan": "üen", "ün": "ün" };
  const ZERO_PL = { yi: "i", ya: "ja", ye: "je", yao: "jał", you: "joł", yan: "jen", yin: "in", yang: "jang", ying: "ing", yong: "jung", yu: "ü", yue: "üe", yuan: "jüen", yun: "ün",
    wu: "łu", wa: "ła", wo: "ło", wai: "łaj", wei: "łej", wan: "łan", wen: "łyn", wang: "łang", weng: "łyng" };
  // polska litera + polskie słowo, na którym Polak słyszy ten dźwięk (do podpowiedzi o dmuchnięciu)
  const SLOWO_PL = { p: ["p", "pan"], t: ["t", "tak"], k: ["k", "kot"], q: ["ć", "ćma"], ch: ["cz", "czapka"], c: ["c", "cena"],
    b: ["p", "pan"], d: ["t", "tak"], g: ["k", "kot"], j: ["dzi", "dziura"], zh: ["cz", "czy"], z: ["dz", "dzwon"] };
  // rozbiór sylaby pinyin (bez tonu): { ini, fin, pl }
  function rozbierz(baza) {
    const b = String(baza || "").toLowerCase().replace(/v/g, "ü").replace(/u:/g, "ü");
    if (ZERO_PL[b]) return { ini: "", fin: b, pl: ZERO_PL[b], zero: true };
    const ini = INICJALY.find(x => b.startsWith(x)) || "";
    let fin = b.slice(ini.length);
    if (["j", "q", "x"].includes(ini) && fin[0] === "u") fin = "ü" + fin.slice(1);
    const twardeY = ["z", "c", "s", "zh", "ch", "sh", "r"].includes(ini) && fin === "i";
    const pl = twardeY ? INI_PL[ini] + "y" : (FIN_PL[fin] != null ? INI_PL[ini] + FIN_PL[fin] : b);
    return { ini, fin, pl, twardeY };
  }
  const pinyinPl = baza => rozbierz(baza).pl;
  // esencja dźwięku: max 2 rzeczy (waga = trudność dla Polaka). Polski zapis stoi w nagłówku, więc tu tylko to,
  // czego zapis nie pokaże: usta, język, wydech. Nigdy „x to y”.
  function podpowiedzDzwiek(baza) {
    const r = rozbierz(baza), ini = r.ini, fin = r.fin, H = [];
    const q = x => "„" + x + "”";
    if (["p", "t", "k", "q", "ch", "c"].includes(ini)) H.push([5, `Zaraz po ${q(SLOWO_PL[ini][0])} mocne dmuchnięcie, jak na gorącą zupę. Kartka przed ustami ma drgnąć.`]);
    if (["b", "d", "g", "j", "zh", "z"].includes(ini)) H.push([5, "Zero dmuchnięcia, miękko. Kartka przed ustami stoi."]);
    if (ini === "zh" || ini === "ch") H.push([3, "Usta płasko, nie w dzióbek jak w polskim „cz”. Czubek języka cofnij trochę dalej po podniebieniu."]);
    if (ini === "sh") H.push([3, "Usta płasko, nie wysuwaj warg jak w polskim „sz”. Czubek języka cofnij trochę dalej po podniebieniu."]);
    if (ini === "r") H.push([3, "Miękko, prawie bez brzęczenia: czubek języka zagięty do góry, nie dotyka podniebienia. Usta płasko."]);
    if (["j", "q", "x"].includes(ini)) H.push([1, "Usta w lekki uśmiech, czubek języka oparty o dolne zęby."]);
    if (r.twardeY && ["z", "c", "s"].includes(ini)) H.push([4, `Po ${q({ z: "dz", c: "c", s: "s" }[ini])} język zostaje na miejscu, zęby prawie zamknięte, i tylko przeciągasz ten sam szum. Żadnego osobnego „y”.`]);
    else if (r.twardeY) H.push([4, "Język zostaje zagięty jak przy spółgłosce i przeciągasz ten sam szum. Nie otwieraj ust na osobne „y”."]);
    if (fin.includes("ü")) H.push([4, "Usta w dzióbek jak do gwizdania, a język jak do „i”. Dzióbek trzymaj do końca, w lustrze usta się nie rozjeżdżają."]);
    if (["e", "en", "eng"].includes(fin)) H.push([3, "„y” z tyłu gardła, jak zastanawiające „yyy…”. Usta płasko, szczęka lekko w dół."]);
    if (fin === "er") H.push([3, "Mówiąc „a”, zawiń czubek języka do góry i do tyłu, bez dotykania podniebienia. Nic nie drga."]);
    if (/ng$/.test(fin)) H.push([3, "Na końcu żadnego „g”: tył języka zamyka gardło jak w „bank” tuż przed „k”. Czubek języka leży na dole."]);
    else if (/n$/.test(fin)) H.push([2, "Samogłoska czysta, nie „ą”/„ę”. Dopiero na końcu czubek języka dotyka dziąseł za górnymi zębami."]);
    if (fin === "ao" || fin === "iao") H.push([1, "„a” szeroko, potem usta lekko się zaokrąglają. „ł” słabe, prawie znika."]);
    if (fin === "un") H.push([1, "„y” krótkie, ledwo słyszalne."]);
    if (!H.length) H.push([0, "Nic chińskiego tu nie ma: mów dokładnie jak zapisane."]);
    return { pl: r.pl, rady: H.sort((a, b) => b[0] - a[0]).slice(0, 2).map(h => h[1]) };
  }
  // esencja tonu: polska sytuacja + słowo, potem sylaba tak samo
  function podpowiedzTon(ton, pl) {
    const X = "„" + pl + "”";
    return {
      1: `Jak „aaa” u lekarza: jedna nuta do końca. Powiedz „aaa”, potem ${X} dokładnie tak samo.`,
      2: `Jak „Co?”, gdy nie dosłyszałeś. Powiedz „Co?”, potem ${X} tak samo, jak pytanie.`,
      3: `Jak zmęczone westchnięcie „eeech”, aż głos trzeszczy. Westchnij, potem ${X} tak samo, trzeszcząc. Nie kończ ładnie.`,
      4: `Jak „Nie!” do psa, który bierze kiełbasę. Krótko, ostro. Powiedz „Nie!”, potem ${X} tak samo.`,
      5: `Jak ciche „-ma” z „mama”: krótko, bez siły, doklejone do poprzedniego kawałka.`,
    }[ton] || "";
  }
  const KOTWICA_TONU = { 1: "„aaa” u lekarza", 2: "„Co?”", 3: "zmęczone „eeech”", 4: "„Nie!” do psa", 5: "ciche „-ma”" };
  // ton do powiedzenia: dwa 3. tony pod rząd -> pierwszy mówisz jak 2. (你好); 不/一 liczy już pinyin-pro
  function tonMowiony(sylaby, i) { const t = sylaby[i].celTon; return t === 3 && sylaby[i + 1] && sylaby[i + 1].celTon === 3 ? 2 : t; }
  // podpowiedź dla jednej sylaby z wykresu: nie trafiony dźwięk -> jak zrobić dźwięk; dźwięk jest -> jak zrobić ton
  function podpowiedzSylaby(sylaby, i) {
    const s = sylaby[i], d = podpowiedzDzwiek(s.baza), ton = tonMowiony(sylaby, i);
    const naglowek = `<b>${esc(s.znak)}</b> powiedz: <b class="tp-pl">${esc(d.pl)}</b>`;
    if (!s.usl) return naglowek + `<div class="tp-lab">dźwięk</div>` + d.rady.map(r => `<div>${esc(r)}</div>`).join("");
    const sandhi = ton !== s.celTon ? ` <span class="tp-lab">(dwa trzeszczące pod rząd: pierwszy mówisz jak „Co?”)</span>` : "";
    const ok = s.uslTon === s.celTon;
    return naglowek + `<div class="tp-lab">${ok ? "✓ dźwięk i ton dobrze · " : "dźwięk dobrze, teraz "}ton: ${KOTWICA_TONU[ton]}${sandhi}</div><div>${esc(podpowiedzTon(ton, d.pl))}</div>`;
  }
  function trenerHtml(g) {
    const sylaby = dopasuj(sylabyZTonami(g.target), sylabyZTonami(g.best));
    if (!sylaby.length) return "";
    sylaby.forEach(s => { if (s.uslTon != null && s.uslTon !== s.celTon) zapiszTon(s.celTon); });
    const wykres = `<div class="tony"><div class="tony-os"><span>cel</span><span>ty</span></div>` + sylaby.map((s, i) => {
      const zle = s.uslTon == null || s.uslTon !== s.celTon;
      return `<div class="syl${zle ? " zle" : ""}" data-i="${i}" role="button"><div class="py">${esc(s.cel)}</div>${svgTon(s.celTon, "cel")}${svgTon(s.uslTon, "usl")}<div class="py usl">${s.usl ? esc(s.usl) : "—"}</div></div>`;
    }).join("") + `</div><div class="tony-pod" data-s="${encodeURIComponent(JSON.stringify(sylaby))}">dotknij kawałek słowa: jak go powiedzieć</div>`;
    const c = cfg();
    if (!c.url || !c.klucz) return wykres;
    const w = { cel: { znaki: g.target, pinyin: g.targetPy }, uslyszane: { znaki: g.best, pinyin: g.heardPy }, poziom: g.level, sylaby };
    return wykres + `<div class="trener" data-w="${encodeURIComponent(JSON.stringify(w))}"><button class="tr-pytaj" type="button">Spytaj trenera</button></div>`;
  }
  async function uzupelnijTrenera(el) {
    el.innerHTML = "⏳ trener myśli…";
    const c = cfg(), t0 = Date.now();
    try {
      const w = JSON.parse(decodeURIComponent(el.dataset.w));
      const r = await fetch(c.url + "/trener", { method: "POST", headers: { "Authorization": "Bearer " + c.klucz, "Content-Type": "application/json" }, body: JSON.stringify(w) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      diag("trener: odpowiedź po " + (Date.now() - t0) + " ms");
      const slaby = slabyTon(), cw = j.cwiczenie || {};
      const zle = (w.sylaby || []).filter(s => s.znak && (s.uslTon == null || s.uslTon !== s.celTon));
      const play = (znaki, py) => `<button class="tr-play" type="button" data-q="${esc(znaki)}">▶ ${esc(znaki)} <span>${esc(py)}</span> wolno</button>`;
      const odsluch = zle.length ? `<div class="tr-odsluch">Posłuchaj: ${zle.map(s => play(s.znak, s.cel)).join(" ")} ${zle.length < (w.sylaby || []).length ? play(w.cel.znaki, "całość") : ""}</div>` : "";
      el.innerHTML = `<div class="tr-diag">${esc(j.diagnoza)}</div>${odsluch}<div class="tr-rada">${esc(j.wskazowka)}</div>` +
        (cw.znaki ? `<div class="tr-cw"><div class="tr-cw-tyt">${cw.ton ? "Ćwiczenie na " + cw.ton + ". ton" : "Ćwiczenie"} · powtórz:</div><b class="tr-znaki">${esc(cw.znaki)}</b> <span>${esc(cw.pinyin)}</span> · ${esc(cw.polski)}${cw.dlaczego ? `<div class="tr-cw-tyt">${esc(cw.dlaczego)}</div>` : ""}<div class="tr-wym">po polsku: <b>${esc(cw.wymowa)}</b></div><div class="tr-odsluch">${play(cw.znaki, cw.pinyin)}</div><button class="mic tr-mic" type="button"></button><div class="result tr-wynik" hidden></div></div>` : "") +
        (slaby ? `<div class="tr-stat">Najczęściej ucieka ci ${slaby.ton}. ton (${slaby.razy}×).</div>` : "");
      const mic = el.querySelector(".tr-mic"), out = el.querySelector(".tr-wynik");
      if (mic) bind(mic, { target: () => cw.znaki,
          onDone: (res) => { const x = render(res, cw.znaki); out.hidden = false; out.className = "result tr-wynik " + x.cls; out.innerHTML = x.html; } });
    } catch (e) { diag("trener błąd: " + e.message); el.textContent = "Trener niedostępny: " + e.message; }
  }
  // request do Claude dopiero po dotknięciu "Spytaj trenera" (strony wstawiają html z render() same, stąd delegacja zdarzenia)
  document.addEventListener("click", (e) => {
    const syl = e.target.closest(".tony .syl");
    if (syl) {
      e.preventDefault(); e.stopPropagation();
      const wykres = syl.closest(".tony"), pod = wykres && wykres.nextElementSibling;
      if (!pod || !pod.classList.contains("tony-pod")) return;
      let sylaby = []; try { sylaby = JSON.parse(decodeURIComponent(pod.dataset.s)); } catch (err) {}
      const i = Number(syl.dataset.i);
      if (syl.classList.contains("wybr")) { syl.classList.remove("wybr"); pod.innerHTML = "dotknij kawałek słowa: jak go powiedzieć"; pod.classList.remove("otw"); return; }
      for (const x of wykres.querySelectorAll(".syl.wybr")) x.classList.remove("wybr");
      syl.classList.add("wybr"); pod.classList.add("otw");
      pod.innerHTML = sylaby[i] ? podpowiedzSylaby(sylaby, i) : "";
      return;
    }
    const p = e.target.closest(".tr-play");
    if (p) { e.preventDefault(); e.stopPropagation(); const c = cfg(); graj(c.url + "/tts?k=" + encodeURIComponent(c.klucz) + "&slow=1&q=" + encodeURIComponent(p.dataset.q)); return; }
    const b = e.target.closest(".tr-pytaj"); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    uzupelnijTrenera(b.closest(".trener"));
  }, true);
  (function () {
    const st = document.createElement("style");
    st.textContent = `
.tony { display: flex; gap: 6px; margin-top: 8px; align-items: flex-end; flex-wrap: wrap; }
.tony-os { display: flex; flex-direction: column; justify-content: space-between; height: 62px; font-size: 10px; opacity: .6; padding: 12px 2px 0 0; }
.tony .syl { display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 3px 4px; border-radius: 8px; background: rgba(0,0,0,.05); }
.tony .syl.zle { background: rgba(220,60,60,.12); }
.tony .syl { cursor: pointer; -webkit-tap-highlight-color: transparent; }
.tony .syl.wybr { outline: 2px solid currentColor; outline-offset: 1px; }
.tony-pod { margin-top: 6px; font-size: 12px; opacity: .6; line-height: 1.4; text-align: left; }
.tony-pod.otw { opacity: 1; font-size: 14px; }
.tony-pod .tp-pl { font-size: 18px; }
.tony-pod .tp-lab { font-size: 12px; opacity: .7; margin: 3px 0 1px; }
.tony .py { font-size: 12px; line-height: 1.2; }
.tony .py.usl { opacity: .7; }
.tony .ton { width: 40px; height: 26px; }
.tony .ton path { fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
.tony .ton circle { fill: currentColor; }
.tony .ton.cel { color: #14532d; }
.tony .syl.zle .ton.cel { color: #7c4a03; }
.tony .ton.usl { color: #666; opacity: .8; }
.tony .syl.zle .ton.usl { color: #b91c1c; opacity: 1; }
.trener { margin-top: 8px; padding-top: 8px; border-top: 1px dashed rgba(0,0,0,.15); font-size: 13px; }
.trener .tr-pytaj { font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 999px; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; }
.trener .tr-diag { font-weight: 600; }
.trener .tr-odsluch { margin-top: 5px; display: flex; flex-wrap: wrap; gap: 6px; }
.trener .tr-play { font: inherit; font-size: 14px; padding: 5px 10px; border-radius: 8px; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; }
.trener .tr-play span { opacity: .7; font-size: 12px; }
.trener .tr-rada { margin-top: 3px; }
.trener .tr-cw { margin-top: 6px; }
.trener .tr-cw-tyt { font-size: 12px; opacity: .7; margin-bottom: 2px; }
.trener .tr-znaki { font-size: 20px; }
.trener .tr-wym { margin-top: 2px; font-size: 15px; }
.trener .tr-mic { margin-top: 6px; }
.trener .tr-wynik { margin-top: 6px; }
.trener .tr-stat { margin-top: 6px; font-size: 12px; opacity: .7; }
.wym-kom { position: fixed; left: 50%; bottom: 24px; transform: translate(-50%, 20px); max-width: min(92vw, 420px); padding: 10px 14px; border-radius: 12px; background: rgba(30,30,30,.94); color: #fff; font-size: 14px; line-height: 1.35; text-align: center; box-shadow: 0 4px 16px rgba(0,0,0,.25); opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; z-index: 9999; }
.wym-kom.on { opacity: 1; transform: translate(-50%, 0); }
@media (prefers-color-scheme: dark) { .wym-kom { background: rgba(245,245,245,.96); color: #111; } }
@media (prefers-color-scheme: dark) { .tony .syl { background: rgba(255,255,255,.08); } .tony .syl.zle { background: rgba(255,90,90,.18); } .tony .ton.cel { color: #9be2b0; } .tony .syl.zle .ton.cel { color: #f0c674; } .tony .ton.usl { color: #aaa; } .tony .syl.zle .ton.usl { color: #ff7b7b; } .trener { border-top-color: rgba(255,255,255,.2); } }`;
    document.head.appendChild(st);
  })();

  // ---- sesja audio iOS: dwa stany, przełączane tylko przy mikrofonie ----
  // bezczynnie: "playback" (mp3 głośno przez głośnik, mimo przełącznika wyciszenia)
  // nasłuch:    "play-and-record", ustawiane PRZED recognition.start(). Web Speech nagrywa w procesie GPU i strona o tym
  //             nie wie; bez tego WebContent dalej wysyła kategorię Playback i mikrofon dostaje ciszę (dziennik z iOS 27:
  //             świeża strona, mp3, potem 2,6 s nasłuchu bez jednego dźwięku).
  function ustawSesje(typ, powod) {
    if (!AS) return;
    try { if (AS.type !== typ) AS.type = typ; diag("audioSession = " + AS.type + " (" + powod + ")"); }
    catch (e) { diag("audioSession błąd: " + e.message); }
  }
  ustawSesje("playback", "start strony");

  // ---- Web Audio: odtwarzanie mp3 (bez elementu <audio>: ten dezaktywuje sesję audio po "ended") ----
  let ctx = null, zrodlo = null, nrGrania = 0;
  let ctxMartwy = false;    // iOS po uśpieniu karty: kontekst mówi "running", ale zegar stoi i nic nie gra
  const bufory = new Map(); // url -> Promise<AudioBuffer> (AudioBuffer działa w każdym kontekście)
  const MAX_BUFOROW = 30;
  function nowyKontekst(powod) {
    if (ctx) { const stary = ctx; zrodlo = null; try { stary.close().catch(() => {}); } catch (e) {} }
    const c = ctx = new AC();
    ctxMartwy = false;
    c.addEventListener("statechange", () => { if (ctx === c) diag("AudioContext: " + c.state); });
    diag("AudioContext utworzony (" + powod + "): " + c.state + ", " + c.sampleRate + " Hz");
    return c;
  }
  // Wołać w geście użytkownika: tworzy, wymienia martwy albo budzi kontekst.
  function kontekst() {
    if (!AC) return null;
    if (!ctx) return nowyKontekst("pierwszy gest");
    if (ctx.state === "closed" || ctxMartwy) return nowyKontekst(ctx.state === "closed" ? "stary zamknięty" : "stary martwy");
    if (ctx.state !== "running") ctx.resume().catch(e => diag("resume: " + e.message));
    return ctx;
  }
  for (const ev of ["pointerup", "touchend", "click", "keydown"]) document.addEventListener(ev, () => { if (!session && !nagranie) kontekst(); }, { capture: true, passive: true });
  // Po powrocie na stronę: czy zegar kontekstu idzie? Stoi = martwy, następny gest tworzy nowy.
  function sprawdzZycie(powod) {
    const c = ctx; if (!c) return;
    if (c.state !== "running") c.resume().catch(() => {});
    const t = c.currentTime;
    setTimeout(() => {
      if (ctx !== c) return;
      if (c.state === "running" && c.currentTime === t) { ctxMartwy = true; diag("kontekst martwy (" + powod + "): zegar stoi"); }
      else diag("kontekst po powrocie (" + powod + "): " + c.state + ", zegar " + (c.currentTime > t ? "idzie" : "stoi"));
    }, 500);
  }
  function czekajNaRunning(c, ms) {
    return new Promise(res => {
      if (c.state === "running") return res(true);
      const h = () => { if (c.state === "running") { clearTimeout(t); c.removeEventListener("statechange", h); res(true); } };
      const t = setTimeout(() => { c.removeEventListener("statechange", h); res(c.state === "running"); }, ms);
      c.addEventListener("statechange", h);
    });
  }
  // resume() ponawiany co 250 ms (po przerwaniu przez system iOS kończy przerwanie z opóźnieniem)
  async function obudz(c, ms) {
    const t0 = Date.now();
    while (c.state !== "running" && Date.now() - t0 < ms) {
      try { await c.resume(); } catch (e) { diag("resume: " + e.message); }
      if (c.state !== "running") await czekajNaRunning(c, 250);
    }
    return c.state === "running";
  }
  function stopAudio() {
    nrGrania++;                               // unieważnia trwające fetch/decode
    if (!zrodlo) return;
    const g = zrodlo; zrodlo = null; g.z.onended = null;
    try { g.z.stop(); } catch (e) {} try { g.z.disconnect(); } catch (e) {}
    diag("audio zatrzymane");
    if (g.opts.onEnd) { try { g.opts.onEnd(true); } catch (e) {} }
  }
  function dekoduj(url) {                     // preload: nie tworzy kontekstu poza gestem
    if (bufory.has(url)) return bufory.get(url);
    const c = ctx; if (!c) return Promise.reject(new Error("brak AudioContext (potrzebny gest)"));
    const p = fetch(url).then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); })
      .then(ab => new Promise((res, rej) => c.decodeAudioData(ab, res, e => rej(e || new Error("decodeAudioData")))))
      .catch(e => { bufory.delete(url); throw e; });
    bufory.set(url, p);
    if (bufory.size > MAX_BUFOROW) bufory.delete(bufory.keys().next().value);
    return p;
  }
  // Komunikat na ekranie (ten sam na każdej stronie): gdy dźwięk nie zagrał, użytkownik ma widzieć dlaczego, nie ciszę.
  let komEl = null, komTimer = 0;
  function komunikat(msg) {
    if (!komEl) { komEl = document.createElement("div"); komEl.className = "wym-kom"; komEl.setAttribute("role", "status"); document.body.appendChild(komEl); }
    komEl.textContent = msg; komEl.classList.add("on");
    clearTimeout(komTimer); komTimer = setTimeout(() => komEl.classList.remove("on"), 5000);
  }
  function zagraj(c, buf, opts) {
    const z = c.createBufferSource(); z.buffer = buf; z.connect(c.destination);
    const g = { z, opts }; zrodlo = g;
    z.onended = () => { if (zrodlo === g) { zrodlo = null; if (opts.onEnd) { try { opts.onEnd(false); } catch (e) {} } } };
    z.start();
    return c.currentTime;
  }
  // true po uruchomieniu odtwarzania, false gdy przerwane przez następne graj()/stopAudio()/mikrofon;
  // rzuca (i pokazuje komunikat) gdy nie da się zagrać.
  async function graj(url, opts) {
    opts = opts || {};
    stopAudio();
    if (session || nagranie || przetwarzanie) return false;   // mikrofon ma pierwszeństwo
    const nr = nrGrania;
    ustawSesje("playback", "granie");
    const c = kontekst(); if (!c) { komunikat("Ta przeglądarka nie odtwarza dźwięku (brak Web Audio)."); throw new Error("brak Web Audio"); }
    const t0 = Date.now();
    let buf;
    try { buf = await dekoduj(url); }
    catch (e) { if (nr === nrGrania) komunikat("Nie mogę pobrać nagrania (" + e.message + "). Sprawdź internet."); throw e; }
    if (nr !== nrGrania) return false;
    if (c.state !== "running" && !(await obudz(c, 1500))) {
      if (nr !== nrGrania) return false;
      diag("AudioContext " + c.state + " – nie gram");
      ctxMartwy = true;                       // następne dotknięcie tworzy nowy kontekst w geście
      komunikat("Dźwięk nie zagrał: system zablokował audio. Dotknij jeszcze raz.");
      throw new Error("AudioContext " + c.state);
    }
    if (nr !== nrGrania) return false;
    const czasStartu = zagraj(c, buf, opts);
    diag("gram " + url.split("/").pop() + " " + buf.duration.toFixed(2) + " s (po " + (Date.now() - t0) + " ms, zegar " + czasStartu.toFixed(3) + ", sesja " + (AS ? AS.type : "-") + ")");
    // po 400 ms zegar stoi = kontekst martwy (iOS po uśpieniu karty): nowy kontekst i jeszcze raz
    setTimeout(async () => {
      if (nr !== nrGrania || ctx !== c || c.currentTime > czasStartu || session || nagranie) return;
      diag("zegar stoi po start() – kontekst martwy, wymieniam");
      stopAudio(); const nr2 = nrGrania;
      const c2 = nowyKontekst("martwy po powrocie");
      if (!(await obudz(c2, 800)) || nr2 !== nrGrania) { if (nr2 === nrGrania) komunikat("Dźwięk nie zagrał po powrocie do karty. Dotknij jeszcze raz."); return; }
      zagraj(c2, buf, opts);
      diag("gram ponownie " + url.split("/").pop() + " (nowy kontekst)");
    }, 400);
    return true;
  }

  // ---- głos systemowy: strony zgłaszają go tu (po nim odstęp przed mikrofonem) ----
  let ostatnieAudio = 0;
  function audioAktywne() { ostatnieAudio = Date.now(); }

  // ---- nagranie getUserMedia: pomiar, czy mikrofon naprawdę coś słyszy, i WAV dla Whispera ----
  async function otworzNagranie(c) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const n = { stream, chunks: [], rate: c.sampleRate, stop: false };
    try {
      n.src = c.createMediaStreamSource(stream);
      n.proc = c.createScriptProcessor(4096, 1, 1);
      n.proc.onaudioprocess = (e) => { if (!n.stop) n.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
      n.cisza = c.createGain(); n.cisza.gain.value = 0;   // ScriptProcessor musi być podpięty do wyjścia
      n.src.connect(n.proc); n.proc.connect(n.cisza); n.cisza.connect(c.destination);
    } catch (e) { zamknijNagranie(n); throw e; }
    return n;
  }
  function zamknijNagranie(n) {
    if (!n || n.zamkniete) return; n.zamkniete = true; n.stop = true;
    try { if (n.proc) { n.proc.disconnect(); n.proc.onaudioprocess = null; } } catch (e) {}
    try { if (n.src) n.src.disconnect(); } catch (e) {}
    try { if (n.cisza) n.cisza.disconnect(); } catch (e) {}
    try { n.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  }
  // szum w cichym pokoju: szczyt ~0.05, rms ~0.007; mowa z AGC: szczyt > 0.2, rms > 0.02
  function poziom(n) {
    let probek = 0, szczyt = 0, suma = 0;
    for (const c of n.chunks) { probek += c.length; for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > szczyt) szczyt = v; suma += v * v; } }
    const rms = probek ? Math.sqrt(suma / probek) : 0;
    return { probek, szczyt, rms, sekund: n.rate ? probek / n.rate : 0, glos: probek > n.rate * 0.3 && szczyt >= 0.08 && rms >= 0.01 };
  }
  function wav16k(chunks, rate) {
    let n = 0; for (const c of chunks) n += c.length;
    const all = new Float32Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    const ratio = rate / 16000, outLen = Math.floor(all.length / ratio);
    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const a = Math.floor(i * ratio), b = Math.min(all.length, Math.floor((i + 1) * ratio)); let sum = 0;
      for (let j = a; j < b; j++) sum += all[j];
      const v = Math.max(-1, Math.min(1, sum / Math.max(1, b - a)));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7FFF;
    }
    const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf);
    const str = (p, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i)); };
    str(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true);
    dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, "data"); dv.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return buf;
  }
  async function whisper(n) {
    const c = cfg(), t0 = Date.now();
    const r = await fetch(c.url + "/wymowa", { method: "POST", headers: { "Authorization": "Bearer " + c.klucz, "Content-Type": "audio/wav" }, body: wav16k(n.chunks, n.rate) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
    diag("whisper: " + JSON.stringify(j.text) + " po " + (Date.now() - t0) + " ms");
    return j.text || "";
  }

  // ---- silnik "system": Web Speech + równoległe nagranie getUserMedia ----
  // Kolejność (sprawdzona na iPhone'ach przez innych, WebAudio/web-speech-api#96): getUserMedia dopiero PO onstart;
  // otwarte przed start() daje głuche sesje. Nagranie: 1) WebContent wie o mikrofonie i trzyma PlayAndRecord,
  // 2) mierzymy, czy mikrofon coś słyszy, 3) gdy Web Speech nic nie zwróci, a w nagraniu jest głos, rozpoznaje Whisper.
  let session = null;       // { btn, opts, rec, faza: starting|listening|stopping, startedAt, interim, finalAlts, gotFinal, error, released, nagr }
  let przetwarzanie = false; // wynik w drodze (Whisper): nowe naciśnięcie czeka
  const MOW = "🎙 mów teraz…";

  async function finish(s, why) {
    clearTimeout(s.watchdog); clearTimeout(s.endGuard); clearTimeout(s.hardLimit); clearTimeout(s.noStart);
    let alts = (s.gotFinal ? s.finalAlts : (s.interim ? [s.interim] : [])).filter(a => a);
    let gotFinal = s.gotFinal, error = s.error;
    const heldMs = s.startedAt ? Date.now() - s.startedAt : 0;
    const n = s.nagr; s.nagr = null; zamknijNagranie(n);
    ustawSesje("playback", "koniec nasłuchu");
    const lv = n ? poziom(n) : null;
    diag("koniec (" + why + "): final=" + gotFinal + " interim=" + JSON.stringify(s.interim || "") + " trzymane " + heldMs + " ms" +
      (lv ? ", nagranie " + lv.sekund.toFixed(1) + " s szczyt=" + lv.szczyt.toFixed(3) + " rms=" + lv.rms.toFixed(4) : ", bez nagrania"));
    if (!alts.length && !error && !s.porzuc && lv && lv.glos && cfg().chmuraOk) {
      diag("Web Speech nic nie zwrócił, a mikrofon nagrał głos: rozpoznaje Whisper");
      przetwarzanie = true; s.btn.textContent = "⏳ rozpoznaję…";
      try { const t = await whisper(n); if (t) { alts = [t]; gotFinal = true; } }
      catch (e) { diag("whisper błąd: " + e.message); }
      przetwarzanie = false;
    } else if (!alts.length && !error && lv && heldMs > 1500 && !lv.glos) diag("mikrofon nie nagrał głosu (cisza albo za cicho)");
    s.btn.classList.remove("rec"); s.btn.textContent = LABEL_IDLE;
    const res = { alts, gotFinal, error, heldMs, started: !!s.startedAt };
    if (s.opts.onDone && !s.porzuc) { try { s.opts.onDone(res); } catch (e) { diag("onDone błąd: " + e.message); } }
  }
  function forceFinish(s, why, porzuc) {
    if (session !== s) return;
    diag("kończę na siłę: " + why);
    s.porzuc = !!porzuc;
    try { if (s.rec) s.rec.abort(); } catch (e) {}
    session = null; finish(s, why);
  }

  async function startListening(btn, opts) {
    if (!SR) { if (opts.onDone) opts.onDone({ alts: [], gotFinal: false, error: "Rozpoznawanie mowy działa tylko w Chrome, Edge lub Safari.", heldMs: 0, started: false }); return; }
    if (session || przetwarzanie) { diag("mikrofon zajęty, ignoruję naciśnięcie"); return; }
    const t0 = Date.now();
    const s = session = { btn, opts, rec: null, faza: "starting", startedAt: 0, interim: "", finalAlts: null, gotFinal: false, error: null, released: false, nagr: null };
    s.hardLimit = setTimeout(() => forceFinish(s, "limit 30 s"), 30000);
    btn.classList.add("rec"); btn.textContent = "⏳ uruchamiam…";
    stopAudio();
    const c = kontekst();                       // w geście: potrzebny do nagrania
    ustawSesje("play-and-record", "nasłuch");   // PRZED start(), patrz góra sekcji
    if (W.beforeStart) { try { W.beforeStart(); } catch (e) {} }
    if ("speechSynthesis" in window) { if (speechSynthesis.speaking || speechSynthesis.pending) audioAktywne(); speechSynthesis.cancel(); }
    let target = ""; try { target = typeof opts.target === "function" ? opts.target() : opts.target; } catch (e) {}
    if (opts.onStart) { try { opts.onStart(); } catch (e) {} }
    // chwila, żeby kategoria doszła do procesu GPU przed startem jednostki mikrofonu; dłużej po głosie systemowym
    const czekaj = Math.max(150, ODSTEP_PO_TTS - (Date.now() - ostatnieAudio));
    const koniecCzekania = Date.now() + czekaj;
    while (Date.now() < koniecCzekania) {
      if (czekaj > 1000) btn.textContent = "⏳ chwila… " + Math.ceil((koniecCzekania - Date.now()) / 1000);
      await sleep(Math.min(200, koniecCzekania - Date.now()));
      if (session !== s) return;
      if (s.released) { session = null; finish(s, "puszczony przed startem"); return; }
    }
    btn.textContent = "⏳ uruchamiam…";
    const r = s.rec = new SR();
    r.lang = "zh-CN"; r.interimResults = true; r.maxAlternatives = 5; r.continuous = true;
    const moja = () => session === s;
    r.onstart = async () => {
      if (!moja()) return;
      diag("onstart po " + (Date.now() - t0) + " ms od naciśnięcia");
      s.faza = "listening"; s.startedAt = Date.now(); clearTimeout(s.noStart);
      if (s.released) { diag("puszczony przed onstart, kończę"); stopNow(s); return; }
      // równoległe nagranie; "mów teraz" dopiero gdy oba słuchają (najdłużej 1,5 s)
      if (GUM && c) {
        s.otwieram = true;
        const p = (async () => { if (c.state !== "running") await obudz(c, 800); return otworzNagranie(c); })();
        const n = await Promise.race([p.catch(e => { diag("getUserMedia błąd: " + e.name + " " + e.message); return null; }), sleep(1500).then(() => null)]);
        if (!n) p.then(zamknijNagranie, () => {});
        else if (!moja() || s.faza !== "listening") zamknijNagranie(n);
        else { s.nagr = n; diag("nagranie równoległe działa (" + n.rate + " Hz)"); }
        s.otwieram = false;
      }
      if (moja() && s.faza === "listening") {
        if (!s.interim && !s.gotFinal) btn.textContent = MOW;
        if (s.released) stopNow(s);
      }
    };
    r.onaudiostart = () => diag("onaudiostart (nie dowodzi, że mikrofon nagrywa)");
    r.onsoundstart = () => diag("onsoundstart");
    r.onspeechstart = () => diag("onspeechstart");
    r.onspeechend = () => diag("onspeechend");
    r.onnomatch = () => diag("onnomatch");
    r.onresult = (ev) => {
      if (!moja()) return;
      const last = ev.results[ev.results.length - 1]; let prefix = "";
      for (let i = 0; i < ev.results.length - 1; i++) prefix += ev.results[i][0].transcript;
      const alts = Array.from(last).map(x => strip(prefix + x.transcript));
      diag("result final=" + last.isFinal + " " + alts[0]);
      if (last.isFinal) { s.finalAlts = alts; s.gotFinal = true; } else s.interim = alts[0];
      // wynik wstępny w samym przycisku (stała szerokość): nic na stronie nie skacze w trakcie mówienia
      if (alts[0] && s.faza === "listening") btn.textContent = "🎙 " + (alts[0].length > 9 ? "…" + alts[0].slice(-9) : alts[0]);
      if (opts.onInterim) { try { opts.onInterim(alts[0]); } catch (e) {} }
    };
    r.onerror = (ev) => {
      diag("error " + ev.error + (ev.message ? " " + ev.message : "") + (s.startedAt ? " po " + (Date.now() - s.startedAt) + " ms" : " przed onstart") + (moja() ? "" : " (stara sesja)"));
      if (!moja() || ev.error === "aborted" || ev.error === "no-speech") return;
      s.error = ev.error === "not-allowed" || ev.error === "service-not-allowed" ? "Brak zgody na mikrofon. Zezwól w ustawieniach strony / przeglądarki."
        : ev.error === "network" ? "Błąd sieci przy rozpoznawaniu (sprawdź internet)."
        : ev.error === "audio-capture" ? "Mikrofon nie nagrywa (inna aplikacja go używa?)." : "Błąd rozpoznawania: " + ev.error;
    };
    r.onend = () => { if (!moja()) { diag("onend starej sesji, ignoruję"); return; } diag("onend"); session = null; finish(s, "onend"); };
    diag("start cel=" + target + " ctx=" + (c ? c.state : "brak") + " sesja=" + (AS ? AS.type : "-"));
    try { r.start(); }
    catch (e) { diag("start() wyjątek: " + e.name + " " + e.message); session = null; s.error = "Nie mogę uruchomić: " + e.message; finish(s, "wyjątek start()"); return; }
    s.noStart = setTimeout(() => { if (moja() && !s.startedAt) forceFinish(s, "brak onstart po 5 s"); }, 5000);
    s.watchdog = setTimeout(() => { if (moja() && s.faza === "listening") { diag("watchdog 15 s"); stopNow(s); } }, 15000);
  }

  function stopNow(s) {
    if (session !== s || s.faza !== "listening") return;
    s.faza = "stopping"; s.btn.textContent = "⏳ przetwarzam…";
    if (s.nagr) s.nagr.stop = true;             // nagranie kończy się razem z puszczeniem przycisku
    diag("stop() po " + (Date.now() - s.startedAt) + " ms nasłuchu");
    try { s.rec.stop(); } catch (e) { diag("stop() wyjątek: " + e.message); }
    s.endGuard = setTimeout(() => {
      if (session !== s) return;
      diag("brak onend po stop(), abort()"); try { s.rec.abort(); } catch (e) {}
      setTimeout(() => forceFinish(s, "brak onend po abort()"), 1500);
    }, 2500);
  }
  function stopListening() {
    const s = session; if (!s || s.released) return;
    s.released = true;
    if (s.faza === "starting") { diag("puszczony przed onstart" + (s.rec ? ", dokończę po onstart" : ", nie uruchomię")); return; }
    if (s.otwieram) return;                     // onstart jeszcze otwiera nagranie, potem sam zatrzyma
    stopNow(s);
  }

  // tryb "system-reload" usunięty; strony nadal wołają odbierzWynik() po starcie
  function odbierzWynik() { return null; }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (session) forceFinish(session, "strona ukryta", true); if (nagranie) chmuraStop(nagranie, true); stopAudio(); }
    else { ustawSesje("playback", "powrót na stronę"); sprawdzZycie("powrót na stronę"); }
  });
  window.addEventListener("pageshow", (e) => { if (e.persisted) { session = null; nagranie = null; zrodlo = null; przetwarzanie = false; ustawSesje("playback", "bfcache"); sprawdzZycie("bfcache"); } });

  // ---- silnik "chmura" (tylko z wyboru): nagranie getUserMedia -> Whisper ----
  let nagranie = null; // { btn, opts, n, startedAt, released, done }
  async function chmuraStart(btn, opts) {
    if (nagranie || przetwarzanie) return;
    stopAudio();
    const c = kontekst();
    ustawSesje("play-and-record", "nagranie (chmura)");
    if (W.beforeStart) { try { W.beforeStart(); } catch (e) {} }
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    const g = { btn, opts, n: null, startedAt: 0, released: false, done: false };
    nagranie = g;
    btn.classList.add("rec"); btn.textContent = "⏳ uruchamiam…";
    if (opts.onStart) { try { opts.onStart(); } catch (e) {} }
    try {
      if (!c) throw new Error("brak AudioContext");
      if (c.state !== "running") await obudz(c, 800);
      const n = await otworzNagranie(c);
      if (nagranie !== g) { zamknijNagranie(n); return; }
      g.n = n; g.startedAt = Date.now();
      diag("chmura: nagrywam (" + n.rate + " Hz)");
      btn.textContent = MOW;
      g.watchdog = setTimeout(() => { if (nagranie === g) { diag("chmura watchdog 15 s"); chmuraStop(g); } }, 15000);
      if (g.released) chmuraStop(g);
    } catch (e) {
      diag("chmura start błąd: " + e.name + " " + e.message);
      if (nagranie === g) nagranie = null;
      ustawSesje("playback", "błąd nagrania");
      btn.classList.remove("rec"); btn.textContent = LABEL_IDLE;
      const msg = e.name === "NotAllowedError" ? "Brak zgody na mikrofon. Zezwól w ustawieniach strony / przeglądarki." : "Nie mogę uruchomić mikrofonu: " + e.message;
      if (opts.onDone) opts.onDone({ alts: [], gotFinal: false, error: msg, heldMs: 0, started: false });
    }
  }
  async function chmuraStop(g, porzuc) {
    if (g.done) return;
    g.released = true;
    if (!g.startedAt && !porzuc) return;        // dokończy chmuraStart
    g.done = true; clearTimeout(g.watchdog);
    const heldMs = g.startedAt ? Date.now() - g.startedAt : 0;
    zamknijNagranie(g.n);
    if (nagranie === g) nagranie = null;
    ustawSesje("playback", "koniec nagrania (chmura)");
    const fin = (res) => { przetwarzanie = false; g.btn.classList.remove("rec"); g.btn.textContent = LABEL_IDLE; if (!porzuc && g.opts.onDone) g.opts.onDone(res); };
    if (porzuc || !g.n) { fin(null); return; }
    const lv = poziom(g.n);
    diag("chmura stop: " + heldMs + " ms, szczyt=" + lv.szczyt.toFixed(3) + " rms=" + lv.rms.toFixed(4));
    if (!lv.glos) { fin({ alts: [], gotFinal: false, error: null, heldMs, started: true }); return; }   // Whisper na ciszy zmyśla
    przetwarzanie = true; g.btn.textContent = "⏳ rozpoznaję…";
    try { const t = await whisper(g.n); fin({ alts: t ? [t] : [], gotFinal: true, error: null, heldMs, started: true }); }
    catch (e) { diag("chmura błąd: " + e.message); fin({ alts: [], gotFinal: false, error: "Rozpoznawanie w chmurze nie działa: " + e.message, heldMs, started: true }); }
  }

  function bind(btn, opts) {
    btn.textContent = LABEL_IDLE;
    const down = (e) => {
      if (e.isPrimary === false || (e.button && e.button > 0)) return;
      e.preventDefault(); e.stopPropagation(); try { btn.setPointerCapture(e.pointerId); } catch (err) {}
      if ((session && session.btn === btn) || (nagranie && nagranie.btn === btn)) return; // powtórny pointerdown (multi-touch)
      if (cfg().uzyj === "chmura") chmuraStart(btn, opts); else startListening(btn, opts);
    };
    const up = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (nagranie && nagranie.btn === btn) { chmuraStop(nagranie); return; }
      if (session && session.btn === btn) stopListening();
    };
    btn.addEventListener("pointerdown", down);
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointercancel", up);
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  const W = { diag, supported: !!SR || GUM, iOS: !!IOS_VER, beforeStart: null, zapiszStan: null, bind, grade, render, strip, toPinyin, cfg, odbierzWynik, pinyinPl, podpowiedzDzwiek, podpowiedzTon, podpowiedzSylaby,
              audioAktywne, graj, stopAudio, preload: dekoduj, kontekst, LABEL_IDLE };
  window.Wymowa = W;
})();
