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
// Silniki: "chmura" (domyślny, gdy jest adres workera i klucz: tylko nagranie + Whisper) i "system" (Web Speech + nagranie awaryjne).
// Domyślnie chmura, bo Web Speech na iOS zgaduje krótkie słowa (nasze nagranie 愿意 zaliczał 1 na 3, Whisper 3 na 3).
// localStorage "kubus.wymowa.silnik" = chmura | auto | system (auto i system = Web Speech); w URL: ?silnik=auto
// Adres workera: window.SYNC_URL (wstawia build.py); klucz: localStorage "kubus.powtorka.sync" (jak sync powtórek).
//
// Użycie:
//   Wymowa.beforeStart = () => { /* tylko UI, audio zatrzymuje moduł */ };
//   Wymowa.bind(btn, { target: () => "朋友", audio: () => "audio/x.mp3", onStart(), onInterim(text), onDone(result) });
//     audio = nagranie lektora (normalne tempo): z niego linia wysokości głosu, na której rysuje się twoja
//     tylkoGlos: true = ćwiczenie melodii: samo nagranie, bez rozpoznawania; tony: () => [2, 3] (Wymowa.tonyMowione) = co oceniać,
//       wynik ma pole ocena (Wymowa.renderTony); wzor: () => Wymowa.wzorTonu(2) = linia celu zamiast nagrania lektora
//     ekran: () => ({ polski, pinyin, znaczenie, bezWymowy }) = co widać nad guzikiem w trakcie mówienia (bezWymowy: bez polskiej wymowy i melodii)  wynik wstępny moduł pokazuje w przycisku; strony nie ruszają układu w trakcie mówienia
//   Wymowa.graj(url, { onEnd(przerwane) }) -> Promise<bool>;  Wymowa.stopAudio();  Wymowa.preload(url)
//   result = { alts: [...], gotFinal, error, heldMs, started, wys: { ty: [Hz], cel: [Hz] | null, ref }, ocena (tylkoGlos) }
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
    const silnik = ls("kubus.wymowa.silnik") || "chmura";
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
    if (result.zaciete) return { cls: "mid", html: "Rozpoznawanie się zacięło i nic sensownego nie wyszło. To nie twoja wina. Powiedz jeszcze raz.", grade: null };
    const g = grade(target, result.alts);
    const note = result.gotFinal ? "" : " <i>(wynik wstępny)</i>";
    const t = g.target, glos = wykresGlosu(result.wys);
    if (g.level === "none") {
      const html = result.started === false ? "Puściłeś przycisk, zanim nasłuch się uruchomił. Przytrzymaj, poczekaj na „mów teraz”, powiedz słowo, dopiero wtedy puść."
        : result.heldMs < 400 ? "Za krótko. Przytrzymaj przycisk, poczekaj na „mów teraz”, powiedz słowo, dopiero wtedy puść."
        : "Nic nie usłyszałem. Przytrzymaj, poczekaj na „mów teraz”, powiedz i puść.";
      return { cls: "bad", html, grade: g };
    }
    if (g.level === "exact") return { cls: "ok", html: `✓ Idealnie. Usłyszałem: <b>${t}</b> (${g.targetPy})${note}${glos}`, grade: g };
    const trener = glos + trenerHtml(g);
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
  // Ten sam zapis co zapis.json (słownik sylab kart) i prompt trenera (p/t/k = bez dmuchnięcia, ph/th/kh/czh/cch/ćh = z dmuchnięciem).
  const INICJALY = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s"];
  const INI_PL = { b: "p", p: "ph", m: "m", f: "f", d: "t", t: "th", n: "n", l: "l", g: "k", k: "kh", h: "ch", j: "dz", q: "ćh", x: "s", zh: "cz", ch: "czh", sh: "sz", r: "ż", z: "dz", c: "cch", s: "s", "": "" };
  const FIN_PL = { a: "a", o: "o", e: "y", i: "i", u: "u", "ü": "ü", ai: "aj", ei: "ej", ao: "ał", ou: "oł", an: "an", en: "en", ang: "ang", eng: "ang", ong: "ong", er: "ar",
    ia: "ia", ie: "ie", iao: "iał", iu: "ioł", ian: "ien", in: "in", iang: "iang", ing: "ing", iong: "iong",
    ua: "ła", uo: "ło", uai: "łaj", ui: "łej", uan: "łan", un: "łen", uang: "łang", ueng: "łang", "üe": "üe", "üan": "üan", "ün": "ün" };
  const ZERO_PL = { yi: "i", ya: "ja", ye: "je", yao: "jał", you: "joł", yan: "jen", yin: "in", yang: "jang", ying: "ing", yong: "jong", yu: "ü", yue: "jüe", yuan: "jüan", yun: "jün",
    wu: "łu", wa: "ła", wo: "ło", wai: "łaj", wei: "łej", wan: "łan", wen: "łen", wang: "łang", weng: "łang" };
  // polska litera + polskie słowo, na którym Polak słyszy ten dźwięk (do podpowiedzi o dmuchnięciu)
  const SLOWO_PL = { p: ["p", "pan"], t: ["t", "tak"], k: ["k", "kot"], q: ["ć", "ćma"], ch: ["cz", "czapka"], c: ["c", "cena"],
    b: ["p", "pan"], d: ["t", "tak"], g: ["k", "kot"], j: ["dzi", "dziura"], zh: ["cz", "czy"], z: ["dz", "dzwon"] };
  // rozbiór sylaby pinyin: { ini, fin, pl }; ton 5 (bez tonu) + samo "e" (的, 了, 呢, 么, 个) = luźne "a", jak w nagraniach
  function rozbierz(baza, ton) {
    const b = String(baza || "").toLowerCase().replace(/v/g, "ü").replace(/u:/g, "ü");
    if (ZERO_PL[b]) return { ini: "", fin: b, pl: ZERO_PL[b], zero: true };
    const ini = INICJALY.find(x => b.startsWith(x)) || "";
    let fin = b.slice(ini.length);
    if (["j", "q", "x"].includes(ini) && fin[0] === "u") fin = "ü" + fin.slice(1);
    const twardeY = ["z", "c", "s", "zh", "ch", "sh", "r"].includes(ini) && fin === "i";
    const lekkieE = ton === 5 && fin === "e" && ini !== "";
    const pl = twardeY ? INI_PL[ini] + "y" : lekkieE ? INI_PL[ini] + "a" : (FIN_PL[fin] != null ? INI_PL[ini] + FIN_PL[fin] : b);
    return { ini, fin, pl, twardeY, lekkieE };
  }
  const pinyinPl = baza => rozbierz(baza).pl;
  // esencja dźwięku: max 2 rzeczy (waga = trudność dla Polaka). Polski zapis stoi w nagłówku, więc tu tylko to,
  // czego zapis nie pokaże: usta, język, wydech. Nigdy „x to y”.
  function podpowiedzDzwiek(baza, ton) {
    const r = rozbierz(baza, ton), ini = r.ini, fin = r.fin, H = [];
    const q = x => "„" + x + "”";
    if (["p", "t", "k", "q", "ch", "c"].includes(ini)) H.push([5, `Zaraz po ${q(SLOWO_PL[ini][0])} mocne dmuchnięcie, jak na gorącą zupę. Kartka przed ustami ma drgnąć.`]);
    if (["b", "d", "g", "j", "zh", "z"].includes(ini)) H.push([5, "Zero dmuchnięcia, miękko. Kartka przed ustami stoi."]);
    if (ini === "zh" || ini === "ch") H.push([3, "Usta płasko, nie w dzióbek jak w polskim „cz”. Czubek języka cofnij trochę dalej po podniebieniu."]);
    if (ini === "sh") H.push([3, "Usta płasko, nie wysuwaj warg jak w polskim „sz”. Czubek języka cofnij trochę dalej po podniebieniu."]);
    if (ini === "r") H.push([3, "Miękko, prawie bez brzęczenia: czubek języka zagięty do góry, nie dotyka podniebienia. Usta płasko."]);
    if (["j", "q", "x"].includes(ini)) H.push([1, "Usta w lekki uśmiech, czubek języka oparty o dolne zęby."]);
    if (r.twardeY && ["z", "c", "s"].includes(ini)) H.push([4, `Po ${q({ z: "dz", c: "c", s: "s" }[ini])} język zostaje na miejscu, zęby prawie zamknięte, i tylko przeciągasz ten sam szum. Żadnego osobnego „y”.`]);
    else if (r.twardeY) H.push([4, "Język zostaje zagięty jak przy spółgłosce i przeciągasz ten sam szum. Nie otwieraj ust na osobne „y”."]);
    // ü także w sylabach bez spółgłoski (yu, yue, yuan, yun), gdzie pinyin pisze samo „u”
    const u = fin.includes("ü") || (r.zero && fin.startsWith("yu")), samoU = ["ü", "ün", "yu", "yun"].includes(fin);
    if (u && samoU) H.push([4, "Usta w dzióbek jak do gwizdania, a język jak do „i”. Dzióbek trzymaj do końca, w lustrze usta się nie rozjeżdżają."]);
    else if (u) H.push([4, "Zaczynasz od „ü”: usta w dzióbek jak do gwizdania, a język jak do „i”. Dopiero potem otwierasz usta na resztę."]);
    if (["e", "en", "eng"].includes(fin) && !r.lekkieE) H.push([3, "„y” z tyłu gardła, jak zastanawiające „yyy…”. Usta płasko, szczęka lekko w dół."]);
    if (fin === "er") H.push([3, "Mówiąc „a”, zawiń czubek języka do góry i do tyłu, bez dotykania podniebienia. Nic nie drga."]);
    if (/ng$/.test(fin)) H.push([3, "Na końcu żadnego „g”: tył języka zamyka gardło jak w „bank” tuż przed „k”. Czubek języka leży na dole."]);
    else if (/n$/.test(fin)) H.push([2, "Samogłoska czysta, nie „ą”/„ę”. Dopiero na końcu czubek języka dotyka dziąseł za górnymi zębami."]);
    if (fin === "ao" || fin === "iao") H.push([1, "„a” szeroko, potem usta lekko się zaokrąglają. „ł” słabe, prawie znika."]);
    if (fin === "un") H.push([1, "„y” krótkie, ledwo słyszalne."]);
    if (!H.length) H.push([0, "Nic chińskiego tu nie ma: mów dokładnie jak zapisane."]);
    return { pl: r.pl, rady: H.sort((a, b) => b[0] - a[0]).slice(0, 2).map(h => h[1]) };
  }
  // esencja tonu: polska sytuacja + słowo, potem sylaba tak samo (te same opisy co na stronie tony/)
  function podpowiedzTon(ton, pl) {
    const X = "„" + pl + "”";
    return {
      1: `Jak u lekarza, który każe otworzyć usta: równe, długie, wysokie „Aaaa”. Głos nie skacze. Powiedz „Aaaa”, potem ${X} dokładnie tak samo.`,
      2: `Jak zdziwione „Cooo?”, gdy ktoś mówi ci coś szokującego. Głos wędruje z dołu do góry. Powiedz „Cooo?”, potem ${X} tak samo.`,
      3: `Jak przeciągłe zastanowienie „Noooo…”. Zaczynasz normalnie, schodzisz bardzo nisko (jakbyś dusił dźwięk w gardle), na koniec lekko odbijasz w górę. Powiedz „Noooo…”, potem ${X} tak samo.`,
      4: `Jak stanowczy rozkaz „Nie!” albo „Zostaw!”: krótko, ostro, spada w dół. Powiedz „Nie!”, potem ${X} tak samo.`,
      5: `Bardzo krótko, lekko, bez nacisku, jak końcówka polskiego wyrazu (drugie „ma” w „mama”). Doklej do poprzedniego kawałka.`,
    }[ton] || "";
  }
  const KOTWICA_TONU = { 1: "„Aaaa” u lekarza", 2: "zdziwione „Cooo?”", 3: "przeciągłe „Noooo…”", 4: "stanowcze „Nie!”", 5: "lekka końcówka" };
  // ton do powiedzenia: dwa 3. tony pod rząd -> pierwszy mówisz jak 2. (你好); 不/一 liczy już pinyin-pro
  function tonMowiony(sylaby, i) { const t = sylaby[i].celTon; return t === 3 && sylaby[i + 1] && sylaby[i + 1].celTon === 3 ? 2 : t; }
  // podpowiedź dla jednej sylaby z wykresu: nie trafiony dźwięk -> jak zrobić dźwięk; dźwięk jest -> jak zrobić ton
  function podpowiedzSylaby(sylaby, i) {
    const s = sylaby[i], d = podpowiedzDzwiek(s.baza, s.celTon), ton = tonMowiony(sylaby, i);
    const naglowek = `<b>${esc(s.znak)}</b> powiedz: <b class="tp-pl">${esc(d.pl)}</b>`;
    if (!s.usl) return naglowek + `<div class="tp-lab">dźwięk</div>` + d.rady.map(r => `<div>${esc(r)}</div>`).join("");
    const sandhi = ton !== s.celTon ? ` <span class="tp-lab">(dwa „Noooo…” pod rząd: pierwsze mówisz jak „Cooo?”)</span>` : "";
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
      if (mic) bind(mic, { target: () => cw.znaki, ekran: () => ({ polski: cw.wymowa, pinyin: cw.pinyin, znaczenie: cw.polski }), audio: () => c.url + "/tts?k=" + encodeURIComponent(c.klucz) + "&q=" + encodeURIComponent(cw.znaki),
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
.glos, .glos-ekran, .ocena, .oc-rada { --glos-lektor: rgba(0,0,0,.18); --glos-ty: #1d4ed8; --glos-zle: #c2410c; --glos-siatka: rgba(0,0,0,.1); }
.glos { margin-top: 8px; }
.glos svg { display: block; width: 100%; height: 64px; }
.glos .glos-os { stroke: var(--glos-siatka); stroke-width: 1; vector-effect: non-scaling-stroke; }
.glos path { fill: none; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.glos .glos-lektor { stroke: var(--glos-lektor); stroke-width: 7; }
.glos .glos-ty { stroke: var(--glos-ty); stroke-width: 3; }
.glos .glos-zle { stroke: var(--glos-zle); stroke-width: 3.5; }
.ocena { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.ocena .oc { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid currentColor; opacity: .9; }
.ocena .oc.zle { color: var(--glos-zle); font-weight: 600; }
.ocena .oc.lekki { opacity: .55; }
.oc-rada { margin-top: 6px; font-size: 13px; }
.glos-pod { font-size: 11px; opacity: .7; text-align: left; }
.glos-pod span { display: inline-block; width: 16px; height: 4px; border-radius: 2px; vertical-align: middle; margin: 0 4px 0 0; }
.glos-pod .glos-l { background: var(--glos-lektor); height: 7px; }
.glos-pod .glos-t { background: var(--glos-ty); margin-left: 8px; }
.glos-ekran { position: fixed; inset: 0; pointer-events: none; z-index: 9998; display: none; }
.glos-ekran.on { display: block; }
.glos-ekran .ge-dziura { position: fixed; }
.glos-ekran .ge-blok { position: fixed; left: 50%; transform: translateX(-50%); width: min(92vw, 420px); box-sizing: border-box; padding: 10px 12px 8px; border-radius: 14px; background: #fff; color: #111; box-shadow: 0 2px 14px rgba(0,0,0,.14); text-align: center; }
.glos-ekran .ge-pl { font-size: 30px; font-weight: 600; line-height: 1.15; }
.glos-ekran .ge-mel { font-size: 15px; margin-top: 3px; opacity: .75; }
.glos-ekran .ge-zn { font-size: 17px; margin-top: 4px; }
.glos-ekran canvas { display: block; width: 100%; height: 110px; margin-top: 6px; }
@media (prefers-color-scheme: dark) { .glos, .glos-ekran, .ocena, .oc-rada { --glos-lektor: rgba(255,255,255,.22); --glos-ty: #60a5fa; --glos-zle: #fb923c; --glos-siatka: rgba(255,255,255,.12); } .glos-ekran .ge-blok { background: #202020; color: #eee; } }
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

  // ---- wysokość głosu: linia lektora (z mp3) i twoja (z mikrofonu, rysowana na żywo) ----
  // YIN na 16 kHz, ramka 25 ms co 10 ms. Linie w półtonach względem mediany mówiącego: liczy się kształt, nie to, czy głos niski.
  const F0_RATE = 16000, F0_WIN = 400, F0_TMIN = Math.floor(F0_RATE / 500), F0_TMAX = Math.ceil(F0_RATE / 70), F0_D = new Float32Array(F0_TMAX + 2);
  const KLUCZ_GLOS = "kubus.wymowa.glos";   // typowa wysokość twojego głosu (Hz): stała linia od pierwszej chwili mówienia
  function do16k(x, rate) {
    const ratio = rate / F0_RATE, n = Math.floor(x.length / ratio), out = new Float32Array(n);
    for (let i = 0; i < n; i++) { const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio)); let s = 0; for (let j = a; j < b; j++) s += x[j]; out[i] = s / (b - a); }
    return out;
  }
  function f0Ramka(x, o) {                    // Hz albo 0 (cisza, szum, spółgłoska bez głosu)
    let e = 0; for (let i = 0; i < F0_WIN; i++) e += x[o + i] * x[o + i];
    if (e / F0_WIN < 1e-4) return 0;          // rms < 0,01: szum w cichym pokoju to ~0,007
    const d = F0_D; let suma = 0; d[0] = 1;
    for (let t = 1; t <= F0_TMAX + 1; t++) {
      let s = 0; for (let i = 0; i < F0_WIN; i++) { const r = x[o + i] - x[o + i + t]; s += r * r; }
      suma += s; d[t] = suma ? s * t / suma : 1;
    }
    // pierwszy dołek poniżej 0,2; bez niego najgłębszy, jeśli wyraźny (szybko opadający ton 4. psuje okresowość w ramce)
    let t = F0_TMIN;
    for (; t <= F0_TMAX; t++) if (d[t] < 0.2) { while (t < F0_TMAX && d[t + 1] < d[t]) t++; break; }
    if (t > F0_TMAX) { t = F0_TMIN; for (let u = F0_TMIN + 1; u <= F0_TMAX; u++) if (d[u] < d[t]) t = u; if (d[t] > 0.65) return 0; }
    const a = d[t - 1], b = d[t], c = d[t + 1], m = a - 2 * b + c;
    return F0_RATE / (t + (m > 0 ? (a - c) / (2 * m) : 0));
  }
  function f0Ciagu(x) { const hz = []; for (let o = 0; o + F0_WIN + F0_TMAX + 1 <= x.length; o += 160) hz.push(f0Ramka(x, o)); return hz; }
  const mediana = a => { const v = Array.from(a).filter(x => x > 0).sort((p, q) => p - q); return v.length ? v[v.length >> 1] : 0; };
  // mediana z 5 ramek, kawałki krótsze niż 40 ms wypadają, skoki o oktawę (typowy błąd pomiaru) wracają na miejsce
  function wygladz(hz) {
    const n = hz.length, out = new Float32Array(n);
    for (let i = 0; i < n; i++) { if (!hz[i]) continue; const w = []; for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < n && hz[j]) w.push(hz[j]); w.sort((p, q) => p - q); out[i] = w[w.length >> 1]; }
    for (let i = 0; i < n;) { if (!out[i]) { i++; continue; } let j = i; while (j < n && out[j]) j++; if (j - i < 4) out.fill(0, i, j); i = j; }
    // oktawa względem poprzedniej ramki z głosem, nie mediany: 4. ton potrafi zjechać o całą oktawę
    for (let i = 0, prev = 0, gdzie = -99; i < n; i++) if (out[i]) {
      if (prev && i - gdzie < 10) { if (out[i] > prev * 1.7) out[i] /= 2; else if (out[i] < prev / 1.7) out[i] *= 2; }
      prev = out[i]; gdzie = i;
    }
    return out;
  }
  // tylko główna wypowiedź: kawałki głosu oddzielone ciszą dłuższą niż 0,4 s to osobne grupy, zostaje ta z największą
  // liczbą ramek (stuk, oddech czy echo po słowie nie rozciągają wykresu)
  function glowna(hz) {
    const out = Float32Array.from(hz), grupy = [];
    let g = null, cisza = 99;
    for (let i = 0; i < out.length; i++) {
      if (!out[i]) { cisza++; continue; }
      if (!g || cisza > 40) grupy.push(g = { a: i, b: i, n: 0 });
      g.b = i; g.n++; cisza = 0;
    }
    if (grupy.length < 2) return out;
    const naj = grupy.reduce((x, y) => y.n > x.n ? y : x);
    out.fill(0, 0, naj.a); out.fill(0, naj.b + 1);
    return out;
  }
  // { hz, i0, i1, med, glosne }: od pierwszej do ostatniej ramki z głosem; med = środek wykresu (bez podanego: środek
  // między najniższym a najwyższym głosem, żeby zjazd 4. tonu o oktawę zmieścił się na wykresie)
  function zakres(hz, med) {
    let i0 = -1, i1 = -1, glosne = 0, lo = Infinity, hi = 0;
    for (let i = 0; i < hz.length; i++) if (hz[i]) { if (i0 < 0) i0 = i; i1 = i; glosne++; if (hz[i] < lo) lo = hz[i]; if (hz[i] > hi) hi = hz[i]; }
    return glosne ? { hz, i0, i1, med: med || Math.sqrt(lo * hi), glosne } : null;
  }
  const liniaLektora = new Map();            // url -> Promise<Float32Array|null>
  function lektor(url) {
    if (!url) return Promise.resolve(null);
    if (!liniaLektora.has(url)) {
      liniaLektora.set(url, dekoduj(url).then(b => glowna(wygladz(f0Ciagu(do16k(b.getChannelData(0), b.sampleRate)))))
        .catch(e => { diag("linia lektora: " + e.message); liniaLektora.delete(url); return null; }));
      if (liniaLektora.size > MAX_BUFOROW) liniaLektora.delete(liniaLektora.keys().next().value);
    }
    return liniaLektora.get(url);
  }
  // wzór melodii do ćwiczenia po polsku, gdy nie ma nagrania: gładka linia w Hz (punkt co 10 ms), półtony od środka głosu
  const WZOR = { 1: [[0, 3], [1, 3]], 2: [[0, -2], [0.25, -2.5], [1, 4]], 3: [[0, 0], [0.65, -6], [1, -3.5]], 4: [[0, 4], [1, -8]] };
  const WZOR_HZ = 150;                         // 0 półtonów we wzorze = twój zwykły głos (wykres z wysokością)
  function wzorTonu(ton) {
    const p = WZOR[ton]; return p ? wzorLinii(p, ton === 4 ? 35 : ton === 3 ? 70 : 55) : null;
  }
  // p = [[x 0..1, półtony od zwykłego głosu]], n = liczba ramek (10 ms); 10 ramek ciszy z obu stron
  function wzorLinii(p, n) {
    const out = new Float32Array(n + 20);
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1); let k = 1; while (k < p.length - 1 && p[k][0] < x) k++;
      const [x0, y0] = p[k - 1], [x1, y1] = p[k];
      out[i + 10] = WZOR_HZ * Math.pow(2, (y0 + (y1 - y0) * (x - x0) / (x1 - x0)) / 12);
    }
    return out;
  }
  // linia, na której rysuje się twoja: wzór podany przez stronę (opts.wzor) albo linia lektora z mp3 (opts.audio)
  function liniaCelu(opts) {
    const wz = wartosc(opts.wzor);
    return wz ? Promise.resolve(wz) : lektor(wartosc(opts.audio));
  }
  const ST_MAX = 10;                           // ± półtonów na wykresie (najwięcej)
  // skala z linii na wykresie: mała melodia (3. ton lektora schodzi o 3–4 półtony) ma być dobrze widać
  function skalaSt(...lista) {
    let m = 0;
    for (const z of lista) if (z) for (let i = z.i0; i <= z.i1; i++) if (z.hz[i]) m = Math.max(m, Math.abs(12 * Math.log2(z.hz[i] / z.med)));
    return m ? Math.max(4, Math.min(ST_MAX, m * 1.2)) : ST_MAX;
  }
  // ścieżka SVG/canvas: x z indeksu ramki, y z półtonów; przerwy tam, gdzie nie ma głosu
  function punkty(z, x0, skala, y) {
    const seg = []; let cur = null;
    for (let i = z.i0; i <= z.i1; i++) {
      const v = z.hz[i]; if (!v) { cur = null; continue; }
      if (!cur) seg.push(cur = []);
      cur.push([x0 + (i - z.i0) * skala, y(12 * Math.log2(v / z.med))]);
    }
    return seg;
  }
  const yNa = (h, p, max = ST_MAX) => st => h / 2 - Math.max(-max, Math.min(max, st)) / max * (h / 2 - p);

  // ---- ton z samej linii głosu (bez rozpoznawania mowy) ----
  // Linia dzielona na tyle kawałków, ile sylab (cięcie w przerwie w głosie blisko oczekiwanego miejsca, inaczej po czasie;
  // lekka końcówka liczy się za pół). Z każdego kawałka bierzemy środek (brzegi to przejścia między sylabami) i patrzymy
  // tylko na kształt: w górę, w dół, dołek, równo. Ocena łagodna: „źle” tylko przy wyraźnie innym kształcie.
  function oktawy(hz) {                       // cały kawałek głosu o oktawę od reszty = błąd pomiaru, wraca na miejsce
    const out = Float32Array.from(hz), med = mediana(out); if (!med) return out;
    for (let i = 0; i < out.length;) {
      if (!out[i]) { i++; continue; }
      let j = i; while (j < out.length && out[j]) j++;
      const m = mediana(out.subarray(i, j));
      if (m > med * 1.7) for (let k = i; k < j; k++) out[k] /= 2;
      else if (m < med / 1.7) for (let k = i; k < j; k++) out[k] *= 2;
      i = j;
    }
    return out;
  }
  // bez przerwy w głosie cięcie tam, gdzie kończy się poprzedni ton: po 2. na szczycie, po 3. i 4. w dołku, inaczej po czasie
  function kawalki(hz, wagi, tony) {
    let i0 = -1, i1 = -1;
    for (let i = 0; i < hz.length; i++) if (hz[i]) { if (i0 < 0) i0 = i; i1 = i; }
    if (i0 < 0) return null;
    const n = wagi.length, dl = i1 - i0 + 1, suma = wagi.reduce((p, q) => p + q, 0), gr = [i0], wSzczycie = [];
    let acc = 0;
    for (let k = 0; k < n - 1; k++) {
      acc += wagi[k];
      const c = i0 + dl * acc / suma, od = Math.max(gr[gr.length - 1] + 3, Math.round(c - dl * 0.2)), doo = Math.min(i1 - 3, Math.round(c + dl * 0.2));
      let best = -1, bestD = Infinity;
      for (let i = od; i <= doo; i++) if (!hz[i] && hz[i - 1]) {
        let j = i; while (j <= i1 && !hz[j]) j++;
        const s = (i + j) / 2; if (j - i >= 2 && Math.abs(s - c) < bestD) { best = Math.round(s); bestD = Math.abs(s - c); }
      }
      if (best < 0) {
        const t = [].concat(tony ? tony[k] : 0)[0], znak = t === 2 ? 1 : t === 3 || t === 4 ? -1 : 0;
        best = Math.round(c); wSzczycie[k] = !!znak;
        if (znak) for (let i = od + 1, bv = -Infinity; i < doo; i++) {
          if (!hz[i] || !hz[i - 1] || !hz[i + 1]) continue;
          const v = znak * Math.log2(hz[i - 1] * hz[i] * hz[i + 1]);
          if (v > bv) { bv = v; best = i; }
        }
      }
      gr.push(best);
    }
    gr.push(i1 + 1);
    // trzeci element: cięcie w szczycie / dołku poprzedniego tonu, więc jego koniec to cel tonu, nie przejście
    return gr.slice(0, -1).map((a, k) => [a, gr[k + 1], !!wSzczycie[k]]);
  }
  // cechy kawałka w półtonach względem ref; brzeg przy innej sylabie obcinany mocniej (25%) niż brzeg słowa
  function cechy(hz, a, b, ref, lewySasiad, prawySasiad) {   // prawySasiad: true = przejście, "cel" = cięcie w szczycie/dołku
    const v = [];
    for (let i = a; i < b; i++) if (hz[i]) v.push(12 * Math.log2(hz[i] / ref));
    if (v.length < 6) return null;
    const t0 = Math.floor(v.length * (lewySasiad ? 0.25 : 0.12)), t1 = v.length - Math.floor(v.length * (prawySasiad === "cel" ? 0.05 : prawySasiad ? 0.25 : 0.1)), w = v.slice(t0, t1);
    if (w.length < 4) return null;
    const sr = (x, y) => { let s = 0; for (let i = x; i < y; i++) s += w[i]; return s / (y - x); };
    const q = Math.max(1, Math.round(w.length * 0.2)), poc = sr(0, q), kon = sr(w.length - q, w.length);
    let mn = Infinity, pmn = 0, mx = -Infinity, pmx = 0;
    for (let i = 1; i < w.length - 1; i++) { const m = (w[i - 1] + w[i] + w[i + 1]) / 3; if (m < mn) { mn = m; pmn = i / (w.length - 1); } if (m > mx) { mx = m; pmx = i / (w.length - 1); } }
    return { poc, kon, mn, pmn, mx, pmx, sr: sr(0, w.length), n: v.length };
  }
  // kształt kawałka zapisany tonem, który tak brzmi (do komunikatu „wyszło jak …”), i czy pasuje do celu
  // kształt kawałka zapisany tonem, który tak brzmi (do komunikatu „wyszło jak …”), i czy pasuje do celu.
  // s = sąsiedzi: { nast: początek następnej sylaby, nisko: kawałek wyraźnie niżej niż sąsiednie albo niż twój zwykły głos }.
  // 2. ton przed inną sylabą często wchodzi w górę dopiero na jej początku (4. ton w dół tak samo); 3. ton w środku słowa to samo „nisko”.
  function klasyfikuj(ton, c, s) {
    s = s || {};
    const doNast = (ton === 2 || ton === 4) && s.nast != null, szczyt = Math.max(c.kon, ton === 2 && doNast ? s.nast : -99);
    const zmiana = szczyt - c.poc, gora = szczyt - c.mn, dol = c.poc - c.mn, zakres = Math.max(c.mx, ton === 2 && doNast ? s.nast : -99) - c.mn;
    // spadek 4. tonu: do końca, do dołka (koniec często chrypi i pomiar skacze w górę) albo do początku następnej sylaby
    const spadek = Math.max(c.poc - c.kon, c.pmn > 0.25 ? c.poc - c.mn : -99, ton === 4 && doNast ? c.poc - s.nast : -99);
    const rowno = zakres < 1.5, wGore = zmiana >= 2.5 && c.pmn < 0.4, wDol = -zmiana >= 2.5 && c.pmn > 0.7,
      dolek = dol >= 2.5 && gora >= 2.5 && c.pmn > 0.2 && c.pmn < 0.7;
    // 0 = nic wyraźnego; zejście w dół i koniec niżej niż start, ale nie ostro: „Noooo…”
    const jak = rowno ? 1 : wGore ? 2 : dolek ? 3 : wDol ? 4 : -zmiana >= 1 && dol >= 2 ? 3 : 0;
    let ok = true;
    if (ton === 1) ok = !((zmiana >= 2 && c.pmn < 0.8) || gora >= 3 || -zmiana >= 3 || dolek);
    else if (ton === 2) ok = !(rowno || (wDol && gora < 1.5) || (-zmiana >= 1.5 && c.pmn > 0.75) || (s.sam && -zmiana >= 1 && dol >= 2));
    else if (ton === 3) ok = !((rowno && !s.nisko) || (gora >= 2 && dol < 2 && s.nast == null && !s.nisko) || (wGore && dol < 1.5) || (s.sam && -zmiana >= 8 && c.kon - c.mn < 1));
    else if (ton === 4) ok = !(rowno || spadek < 2);   // dołek przy 4. tonie to zwykle chrypka na końcu, więc liczy się tylko spadek
    return { ok, jak: ok ? ton : jak === ton ? 0 : jak };
  }
  // tony: tony do powiedzenia (po zmianach, np. 你好 = 2 3), pozycja może mieć dwa dobre tony ([2, 3]: pierwsze z trzech
  // „Noooo…” pod rząd ludzie mówią na oba sposoby); ref: typowy głos mówiącego (Hz), bez niego mediana tej linii.
  // Wynik: { h: linia po poprawce oktaw, kaw: granice sylab [od, do), sylaby: [{ ton, ok, jak, lekki }] } albo null (za mało głosu)
  function ocenTony(hz, tony, ref) {
    const h = oktawy(hz), z = zakres(h);
    if (!z || z.glosne < 12 || !tony || !tony.length) return null;
    const kaw = kawalki(h, tony.map(t => t === 5 ? 0.5 : 1), tony), r = ref || mediana(h);
    const c = kaw.map(([a, b, cel], i) => cechy(h, a, b, r, i > 0, i < tony.length - 1 && (cel ? "cel" : true)));
    const sylaby = tony.map((t, i) => {
      const dobre = [].concat(t), ton = dobre[0];
      if (ton === 5) return { ton, ok: true, lekki: true };
      if (!c[i]) return { ton, ok: true, brak: true };
      const obok = [c[i - 1], c[i + 1]].filter(Boolean).map(x => x.sr);
      const nisko = obok.length ? c[i].sr <= Math.min(...obok) - 2 : !!ref && c[i].sr <= -2.5;
      const s = { nast: c[i + 1] ? c[i + 1].poc : null, nisko, sam: tony.length === 1 }, wyn = dobre.map(x => klasyfikuj(x, c[i], s)), traf = wyn.findIndex(w => w.ok);
      return Object.assign({ ton: traf >= 0 ? dobre[traf] : ton }, traf >= 0 ? wyn[traf] : wyn[0]);
    });
    return { h, kaw, sylaby, c, ref: r };
  }
  // ćwiczenie „start z góry / start z dołu”: oprócz kształtu liczy się wysokość względem twojego zwykłego głosu (oc.ref).
  // „Nie!” zaczyna się wyraźnie nad zwykłym głosem (po „Cooo?”: tam, gdzie „Cooo?” się skończyło) i spada od razu;
  // „Noooo…” zaczyna się zwykłym głosem albo niżej (po „Nie!”: na dole) i nie podskakuje przed zejściem.
  // Wynik: sylaby z ok = false i własną radą, gdy wysokość się nie zgadza (kształt ocenia dalej ocenTony).
  function wysokoscTonow(oc) {
    if (!oc || !oc.c) return oc;
    oc.sylaby.forEach((s, i) => {
      const c = oc.c[i], p = oc.c[i - 1], pt = i > 0 ? oc.sylaby[i - 1].ton : 0;
      if (!c || s.lekki || s.brak || (s.ton !== 3 && s.ton !== 4)) return;
      let rada = "";
      if (s.ton === 4) {
        const start = c.pmx < 0.3 ? Math.max(c.poc, c.mx) : c.poc, spadek = start - Math.min(c.kon, c.mn);
        const poCooo = pt === 2 && p, prog = poCooo ? Math.max(3, p.kon - 3) : 4;
        if (c.mx - c.poc >= 2 && c.pmx > 0.15 && c.pmx < 0.75) rada = "głos najpierw poszedł w górę. „Nie!” od pierwszej chwili leci w dół.";
        else if (start < prog) rada = poCooo ? "„Nie!” zaczęło się niżej, niż skończyło się „Cooo?”. Nie schodź po drodze: rzuć „Nie!” prosto z tej góry."
          : "zacząłeś z wysokości zwykłej mowy. Zacznij wyżej, tam, gdzie kończy się zdziwione „Cooo?”.";
        else if (spadek < 5) rada = "spadło za mało. Rzuć głos na sam dół, jak siekierą.";
      } else {
        const poNie = pt === 4 && p;
        if (c.mx - c.poc >= 2 && c.pmx < 0.7 && (c.pmx < c.pmn || c.pmn < 0.15)) rada = "głos najpierw poszedł w górę, a dopiero potem w dół. Tu od razu w dół, bez podskoku.";
        else if (poNie ? c.poc > Math.max(p.kon + 4, -1) : c.poc > 1.5) rada = poNie ? "„Noooo…” zaczęło się za wysoko. Zacznij tam, gdzie skończyło się „Nie!”: na dole."
          : "zacząłeś wysoko, więc wyszło jak „Nie!”. Zacznij zwykłym głosem albo niżej.";
        else if (c.mn > c.poc - 1.5 && c.mn > -2) rada = "za mało nisko. Zejdź tam, gdzie dźwięk dusi się w gardle.";
      }
      if (rada) Object.assign(s, { ok: false, jak: 0, rada });
    });
    return oc;
  }

  // ekran mówienia: od naciśnięcia do puszczenia strona znika (warstwa w kolorze tła z „dziurą” na guzik, więc guzik
  // się nie rusza), nad guzikiem zostaje blok: polska wymowa, melodia sylab, znaczenie, linia lektora i twoja na żywo
  let ekrEl = null, ekr = null;               // ekr = { btn, cel, w, koniec }
  function ekranEl() {
    if (ekrEl) return ekrEl;
    ekrEl = document.createElement("div"); ekrEl.className = "glos-ekran";
    ekrEl.innerHTML = `<div class="ge-dziura"></div><div class="ge-blok"><div class="ge-pl"></div><div class="ge-mel"></div><div class="ge-zn"></div>` +
      `<canvas></canvas><div class="glos-pod"><span class="glos-l"></span>lektor <span class="glos-t"></span>ty</div></div>`;
    document.body.appendChild(ekrEl);
    return ekrEl;
  }
  const MELODIA = { 1: "Aaaa", 2: "Cooo?", 3: "Noooo…", 4: "Nie!", 5: "końcówka" };
  // tony z zapisu na karcie, gdy się da („péngyou”: 友 bez znaczka = lekka końcówka, tak jak w nagraniu), inaczej z pinyin-pro
  const TON_ZNAK = { "\u0304": 1, "\u0301": 2, "\u030C": 3, "\u0300": 4 };
  const bezTonu = s => Array.from(s.normalize("NFD").toLowerCase()).filter(c => !TON_ZNAK[c]);
  function tonyKarty(syl, pinyin) {
    const k = Array.from((pinyin || "").normalize("NFD").toLowerCase().replace(/[^a-z\u0300-\u036f]/g, ""));
    if (!k.length) return null;
    let j = 0;
    const tony = syl.map(x => {
      let ton = 5;
      for (const c of bezTonu(x.py)) {
        while (j < k.length && TON_ZNAK[k[j]]) ton = TON_ZNAK[k[j++]];
        if (k[j] !== c) return null;
        j++;
      }
      while (j < k.length && TON_ZNAK[k[j]]) ton = TON_ZNAK[k[j++]];
      return ton;
    });
    return tony.includes(null) || j !== k.length ? null : tony;
  }
  function melodia(znaki, pinyin) {
    const s0 = sylabyZTonami(strip(znaki)), tk = tonyKarty(s0, pinyin);
    const syl = s0.map((x, i) => ({ celTon: tk ? tk[i] : x.ton }));
    return syl.map((x, i) => MELODIA[tonMowiony(syl, i)] || "").filter(Boolean).join(" · ");
  }
  // tony do powiedzenia, sylaba po sylabie (do oceny z linii głosu): dwa „Noooo…” pod rząd = pierwsze „Cooo?”;
  // z trzech pod rząd pierwsze może być jednym albo drugim ([2, 3]), bo 我很好 mówi się na oba sposoby
  function tonyMowione(znaki, pinyin) {
    const s0 = sylabyZTonami(strip(znaki || "")), tk = tonyKarty(s0, pinyin), t = s0.map((x, i) => tk ? tk[i] : x.ton);
    return t.map((x, i) => x === 3 && t[i + 1] === 3 ? (t[i + 2] === 3 && t[i - 1] !== 3 ? [2, 3] : 2) : x);
  }
  const wartosc = v => { try { return (typeof v === "function" ? v() : v) || ""; } catch (e) { return ""; } };
  function tloStrony() {
    for (const el of [document.body, document.documentElement]) {
      const c = getComputedStyle(el).backgroundColor;
      if (c && c !== "transparent" && !/rgba\(.*,\s*0\)$/.test(c)) return c;
    }
    return matchMedia("(prefers-color-scheme: dark)").matches ? "#111" : "#fff";
  }
  // co klatkę: dziura dokładnie na guziku, blok nad nim (pod nim, gdy guzik jest za wysoko na ekranie)
  function ulozEkran(e, btn) {
    const r = btn.getBoundingClientRect(), d = e.firstChild, b = e.lastChild;
    Object.assign(d.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    const nad = r.top - 12 - b.offsetHeight;
    b.style.top = (nad >= 8 ? nad : r.bottom + 12) + "px";
  }
  function ekranPokaz(btn, opts) {
    try {
      ekranUkryj();
      const e = ekranEl(), info = wartosc(opts.ekran) || {}, znaki = wartosc(opts.target);
      let pl = "", mel = "";
      if (!info.bezWymowy) {
        pl = info.polski || (window.pinyinPro ? pinyinPro.pinyin(strip(znaki), { toneType: "none", type: "array" }).map(pinyinPl).join("-") : "");
        mel = melodia(znaki, info.pinyin);
      }
      const pola = [[".ge-pl", pl], [".ge-mel", mel ? "melodia: " + mel : ""], [".ge-zn", info.znaczenie || ""]];
      for (const [sel, t] of pola) { const el = e.querySelector(sel); el.textContent = t; el.hidden = !t; }
      const d = e.firstChild, cs = getComputedStyle(btn);
      d.style.borderRadius = cs.borderRadius; d.style.boxShadow = "0 0 0 200vmax " + tloStrony();
      const st = ekr = { btn, cel: null, w: null, koniec: false, skaluj: !!opts.tylkoGlos, wys: !!opts.wysokosc && !!wartosc(opts.wzor) };
      liniaCelu(opts).then(c => { st.cel = c; });
      e.classList.add("on");
      const cv = e.querySelector("canvas");
      const petla = () => {
        if (st.koniec) return;
        try { ulozEkran(e, btn); if (st.w) doczytaj(st.w); rysujPanel(cv, st.w, st.cel, st.skaluj, st.wys); } catch (err) { diag("ekran mówienia: " + err.message); return; }
        requestAnimationFrame(petla);
      };
      ulozEkran(e, btn); petla();
    } catch (err) { diag("ekran mówienia: " + err.message); }
  }
  function ekranUkryj() {
    if (ekr) { ekr.koniec = true; ekr = null; }
    if (ekrEl) ekrEl.classList.remove("on");
  }
  function doczytaj(w) {                      // nowe kawałki nagrania -> 16 kHz -> ramki
    const n = w.n;
    while (w.idx < n.chunks.length) {
      const x = do16k(n.chunks[w.idx++], n.rate);
      if (w.len + x.length > w.buf.length) break;
      w.buf.set(x, w.len); w.len += x.length;
    }
    while (w.pos + F0_WIN + F0_TMAX + 1 <= w.len) { w.hz.push(f0Ramka(w.buf, w.pos)); w.pos += 160; }
  }
  // błąd rysowania nigdy nie psuje nagrania: wtedy po prostu nie ma linii
  function glosStart(n, opts) {
    try { return glosStartDo(n, opts); } catch (e) { diag("linia głosu: " + e.message); return null; }
  }
  function glosStartDo(n, opts) {
    // bezZwyklego: ćwiczenie celowo wysoko / nisko, więc ta próba nie zmienia zapamiętanego zwykłego głosu
    const w = { n, idx: 0, buf: new Float32Array(F0_RATE * 32), len: 0, pos: 0, hz: [], cel: null, koniec: false, bezZwyklego: !!opts.bezZwyklego };
    liniaCelu(opts).then(c => { w.cel = c; }); w.wzor = !!wartosc(opts.wzor);
    try { w.zapisany = Number(localStorage.getItem(KLUCZ_GLOS)) || 0; } catch (e) { w.zapisany = 0; }
    if (ekr) ekr.w = w;                       // ekran mówienia rysuje twoją linię z tego nagrania
    return w;
  }
  function rysujPanel(cv, w, cel, skaluj, wys) {   // skaluj: skala z linii celu (strona tonów), inaczej stałe ±10 półtonów; wys: wzór na skali zwykłego głosu
    const dpr = window.devicePixelRatio || 1, cw = cv.clientWidth, ch = cv.clientHeight;
    if (!cw) return;
    if (cv.width !== Math.round(cw * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); }
    const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, cw, ch);
    const kolor = getComputedStyle(cv.parentNode), P = 8;
    g.strokeStyle = kolor.getPropertyValue("--glos-siatka").trim(); g.lineWidth = 1;
    g.beginPath(); g.moveTo(P, ch / 2); g.lineTo(cw - P, ch / 2); g.stroke();
    const ty = w && !w.koniec ? wygladz(w.hz) : [], zt = ty.length ? zakres(ty, w.zapisany || mediana(ty)) : null, zc = cel && zakres(cel, wys ? WZOR_HZ : 0);
    const y = yNa(ch, P, skaluj && zc ? Math.min(ST_MAX, skalaSt(zc) * 1.3) : ST_MAX);   // z linii celu, żeby nie skakała w trakcie mówienia
    // oś czasu w ramkach: tyle, ile trwa słowo lektora (z zapasem), dłużej, gdy mówisz dłużej
    const T = Math.max(zc ? (zc.i1 - zc.i0) * 1.25 : 0, 80, zt ? ty.length - zt.i0 : 0), skala = (cw - 2 * P) / T;
    const rysuj = (seg, styl, grub) => {
      g.strokeStyle = styl; g.lineWidth = grub; g.lineCap = "round"; g.lineJoin = "round";
      for (const s of seg) { g.beginPath(); s.forEach(([px, py], i) => i ? g.lineTo(px, py) : g.moveTo(px, py)); g.stroke(); }
    };
    if (zc) rysuj(punkty(zc, P, skala, y), kolor.getPropertyValue("--glos-lektor").trim(), 6);
    if (zt) rysuj(punkty({ ...zt, i1: ty.length - 1 }, P, skala, y), kolor.getPropertyValue("--glos-ty").trim(), 3);
  }
  function glosStop(w) {
    if (!w || w.koniec) return null;
    w.koniec = true;
    try { doczytaj(w); } catch (e) { return null; }
    const ty = glowna(wygladz(w.hz)), z = zakres(ty), med = mediana(ty);
    if (z && z.glosne >= 10 && !w.bezZwyklego) { try { localStorage.setItem(KLUCZ_GLOS, String(Math.round(w.zapisany ? w.zapisany * 0.7 + med * 0.3 : med))); } catch (e) {} }
    return { ty: Array.from(ty), cel: w.cel ? Array.from(w.cel) : null, ref: w.zapisany || 0, wzor: w.wzor };
  }
  // wykres pod wynikiem: obie linie rozciągnięte na całą szerokość, żeby porównać sam kształt
  // oc = wynik ocenTony (strona tonów): twoja linia po poprawce oktaw, źle powiedziana sylaba innym kolorem, skala z linii na wykresie
  // wys: środkowa linia = twój zwykły głos (oc.ref), wzór na tej samej skali, więc widać, czy zaczynasz wysoko, czy nisko
  function wykresGlosu(w, oc, wys) {
    wys = wys && oc && oc.ref;
    const zt = w && w.ty && zakres(oc ? oc.h : w.ty, wys ? oc.ref : 0);
    if (!zt || zt.glosne < 10) return "";
    const zc = w.cel && zakres(w.cel, wys && w.wzor ? WZOR_HZ : 0), S = 300, H = 80, P = 6, y = yNa(H, P, oc ? skalaSt(zc, zt) : ST_MAX);
    const sciezka = (z, x0, skala) => punkty(z, x0, skala, y).map(s => s.map(([x, yy], i) => (i ? "L" : "M") + x.toFixed(1) + " " + yy.toFixed(1)).join("")).join("");
    const d = (z) => sciezka(z, P, (S - 2 * P) / Math.max(1, z.i1 - z.i0));
    let ty = `<path class="glos-ty" d="${d(zt)}"/>`;
    if (oc && oc.sylaby.some(s => !s.ok)) {
      const skala = (S - 2 * P) / Math.max(1, zt.i1 - zt.i0);
      ty = oc.kaw.map(([a, b], k) => {
        const i0 = Math.max(a, zt.i0), i1 = Math.min(b - 1, zt.i1);
        // kawałek zaczyna się punkt wcześniej, żeby linia nie miała przerwy na granicy sylab
        const z = { ...zt, i0: Math.max(zt.i0, i0 - 1), i1 };
        return i1 > i0 ? `<path class="${oc.sylaby[k].ok ? "glos-ty" : "glos-zle"}" d="${sciezka(z, P + (z.i0 - zt.i0) * skala, skala)}"/>` : "";
      }).join("");
    }
    return `<div class="glos"><svg viewBox="0 0 ${S} ${H}" preserveAspectRatio="none" aria-label="wysokość głosu: lektor i ty">` +
      `<line x1="${P}" y1="${H / 2}" x2="${S - P}" y2="${H / 2}" class="glos-os"/>` +
      (zc ? `<path class="glos-lektor" d="${d(zc)}"/>` : "") + ty + `</svg>` +
      `<div class="glos-pod">${zc ? `<span class="glos-l"></span>${w.wzor ? "wzór" : "lektor"} ` : ""}<span class="glos-t"></span>ty${wys ? " · środkowa kreska: twój zwykły głos" : ""}</div></div>`;
  }
  // wynik ćwiczenia melodii (mikrofon z tylkoGlos): wykres i każda sylaba z polskim słowem z notatek.
  // info = { znaki, polski, ok, zle }: polski = zapis z karty, kawałki przez spację albo myślnik (gdy liczba się zgadza);
  // ok / zle = własny nagłówek wyniku zamiast „Melodia się zgadza” (ćwiczenie po polsku)
  const KOTW = { 1: "„Aaaa”", 2: "„Cooo?”", 3: "„Noooo…”", 4: "„Nie!”" };
  const ZAMIAST = { 1: "a głos się ruszał", 2: "a głos nie poszedł w górę", 3: "a głos nie zszedł nisko", 4: "a głos nie spadł" };
  function renderTony(res, info) {
    info = info || {};
    if (res && res.error) return { cls: "bad", html: "✗ " + esc(res.error), ok: false };
    const oc = res && res.ocena;
    if (!oc) return { cls: "bad", html: "Nie słyszę głosu. Przytrzymaj 🎤, powiedz głośno i wyraźnie, dopiero potem puść.", ok: false };
    const znaki = [...strip(info.znaki || "")], pl = String(info.polski || "").split(/[\s\-–]+/).filter(Boolean);
    const syl = oc.sylaby, ile = syl.length, zle = syl.filter(s => !s.ok);
    const nazwa = (i) => (znaki.length === ile ? znaki[i] + " " : "") + (pl.length === ile ? pl[i] : "");
    const chip = (s, i) => `<span class="oc ${s.lekki ? "lekki" : s.ok ? "ok" : "zle"}">${esc(nazwa(i))}${s.lekki ? " · lekko" : s.ok ? " ✓ " + KOTW[s.ton] : " ✗"}</span>`;
    const rada = zle.map(s => { const i = syl.indexOf(s), n = nazwa(i).trim();
      return `<div class="oc-rada">${n ? `<b>${esc(n)}</b>: ` : ""}${s.rada ? esc(s.rada) : `ma być ${KOTWICA_TONU[s.ton]}, ${s.jak ? "wyszło jak " + KOTWICA_TONU[s.jak] : ZAMIAST[s.ton]}.`}</div>`; }).join("");
    const head = !zle.length ? "✓ Melodia się zgadza." : zle.length === syl.filter(s => !s.lekki).length ? "✗ Melodia jeszcze nie ta."
      : `Prawie. ${zle.length === 1 ? "Jeden kawałek" : zle.length + " kawałki"} do poprawki.`;
    return { cls: zle.length ? (zle.length < ile ? "mid" : "bad") : "ok", ok: !zle.length,
      html: `<div>${esc((zle.length ? info.zle : info.ok) || head)}</div>` + wykresGlosu(res.wys, oc, info.wysokosc) + (ile > 1 ? `<div class="ocena">${syl.map(chip).join("")}</div>` : "") + rada };
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
  // cel i strona idą do workera razem z nagraniem: worker trzyma ostatnie próby 7 dni (KV „nagranie:”), żeby dało się je odsłuchać
  const celZ = opts => { try { return (typeof opts.target === "function" ? opts.target() : opts.target) || ""; } catch (e) { return ""; } };
  // Whisper czasem zapętla się na krótkim nagraniu (徐徐徐徐徐徐): kawałek 1–3 znaków 4+ razy pod rząd, a w celu tego nie ma
  const zapetla = /(.{1,3})\1{3,}/u;
  const zaciete = (t, cel) => zapetla.test(strip(t)) && !zapetla.test(strip(cel || ""));
  // ćwiczenie melodii nie potrzebuje Whispera, ale próba i jej ocena idą do workera (KV „nagranie:”, 7 dni), żeby dało się
  // sprawdzić ocenę na prawdziwym głosie; bez czekania na odpowiedź
  function zapiszProbe(n, opts, ocena) {
    const c = cfg(); if (!c.url || !c.klucz || !n || !n.chunks.length) return;
    const oc = ocena ? ocena.sylaby.map(x => x.ton + (x.ok ? "ok" : "zle" + x.jak)).join(" ") : "brak";
    fetch(c.url + "/wymowa?zapis=1&cel=" + encodeURIComponent(celZ(opts)) + "&strona=" + encodeURIComponent(location.pathname) + "&ocena=" + encodeURIComponent(oc),
      { method: "POST", headers: { "Authorization": "Bearer " + c.klucz, "Content-Type": "audio/wav" }, body: wav16k(n.chunks, n.rate) }).catch(e => diag("zapis próby: " + e.message));
  }
  async function whisper(n, cel) {
    const c = cfg(), t0 = Date.now();
    const r = await fetch(c.url + "/wymowa?cel=" + encodeURIComponent(cel || "") + "&strona=" + encodeURIComponent(location.pathname), { method: "POST", headers: { "Authorization": "Bearer " + c.klucz, "Content-Type": "audio/wav" }, body: wav16k(n.chunks, n.rate) });
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
    clearTimeout(s.watchdog); clearTimeout(s.endGuard); clearTimeout(s.hardLimit); clearTimeout(s.noStart); ekranUkryj();
    let alts = (s.gotFinal ? s.finalAlts : (s.interim ? [s.interim] : [])).filter(a => a);
    let gotFinal = s.gotFinal, error = s.error;
    const heldMs = s.startedAt ? Date.now() - s.startedAt : 0;
    const n = s.nagr; s.nagr = null; zamknijNagranie(n);
    const wys = glosStop(s.wys);
    ustawSesje("playback", "koniec nasłuchu");
    const lv = n ? poziom(n) : null;
    diag("koniec (" + why + "): final=" + gotFinal + " interim=" + JSON.stringify(s.interim || "") + " trzymane " + heldMs + " ms" +
      (lv ? ", nagranie " + lv.sekund.toFixed(1) + " s szczyt=" + lv.szczyt.toFixed(3) + " rms=" + lv.rms.toFixed(4) : ", bez nagrania"));
    if (!alts.length && !error && !s.porzuc && lv && lv.glos && cfg().chmuraOk) {
      diag("Web Speech nic nie zwrócił, a mikrofon nagrał głos: rozpoznaje Whisper");
      przetwarzanie = true; s.btn.textContent = "⏳ rozpoznaję…";
      try { const cel = celZ(s.opts), t = await whisper(n, cel); if (t && zaciete(t, cel)) { diag("whisper się zaciął, wynik odrzucony"); s.zaciete = true; } else if (t) { alts = [t]; gotFinal = true; } }
      catch (e) { diag("whisper błąd: " + e.message); }
      przetwarzanie = false;
    } else if (!alts.length && !error && lv && heldMs > 1500 && !lv.glos) diag("mikrofon nie nagrał głosu (cisza albo za cicho)");
    s.btn.classList.remove("rec"); s.btn.textContent = LABEL_IDLE;
    const res = { alts, gotFinal, error, heldMs, started: !!s.startedAt, zaciete: !!s.zaciete && !alts.length, wys };
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
    ekranPokaz(btn, opts);
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
        else { s.nagr = n; s.wys = glosStart(n, s.opts); diag("nagranie równoległe działa (" + n.rate + " Hz)"); }
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
    s.released = true; ekranUkryj();
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
  const START_MS = 5000;
  async function chmuraStart(btn, opts) {
    if (nagranie || przetwarzanie) return;
    stopAudio();
    const c = kontekst();
    ustawSesje("play-and-record", "nagranie (chmura)");
    if (W.beforeStart) { try { W.beforeStart(); } catch (e) {} }
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    const g = { btn, opts, n: null, startedAt: 0, released: false, done: false };
    nagranie = g;
    ekranPokaz(btn, opts);
    btn.classList.add("rec"); btn.textContent = "⏳ uruchamiam…";
    if (opts.onStart) { try { opts.onStart(); } catch (e) {} }
    let start = null;
    try {
      if (!c) throw new Error("brak AudioContext");
      // iOS po powrocie z innej aplikacji: getUserMedia albo budzenie kontekstu potrafi nie wrócić nigdy; bez limitu guzik wisi
      // na „uruchamiam…”, a ekran mówienia zasłania stronę. Po 5 s koniec, następny gest dostaje nowy kontekst.
      start = (async () => { if (c.state !== "running") await obudz(c, 800); return otworzNagranie(c); })();
      let limit;
      const n = await Promise.race([start, new Promise((_, rej) => { limit = setTimeout(() => rej(Object.assign(new Error("mikrofon nie ruszył w 5 s"), { name: "Limit" })), START_MS); })])
        .finally(() => clearTimeout(limit));
      if (nagranie !== g) { zamknijNagranie(n); return; }
      g.n = n; g.startedAt = Date.now(); g.wys = glosStart(n, opts);
      diag("chmura: nagrywam (" + n.rate + " Hz)");
      btn.textContent = MOW;
      g.watchdog = setTimeout(() => { if (nagranie === g) { diag("chmura watchdog 15 s"); chmuraStop(g); } }, 15000);
      if (g.released) chmuraStop(g);
    } catch (e) {
      diag("chmura start błąd: " + e.name + " " + e.message);
      if (e.name === "Limit") {               // spóźniony strumień zamknąć, kontekst uznać za martwy
        ctxMartwy = true;
        if (start) start.then(zamknijNagranie, () => {});
      }
      if (nagranie === g) { nagranie = null; ekranUkryj(); }
      ustawSesje("playback", "błąd nagrania");
      btn.classList.remove("rec"); btn.textContent = LABEL_IDLE;
      const msg = e.name === "NotAllowedError" ? "Brak zgody na mikrofon. Zezwól w ustawieniach strony / przeglądarki."
        : e.name === "Limit" ? "Mikrofon się nie uruchomił (telefon go zablokował, zwykle po przełączeniu na inną aplikację). Przytrzymaj 🎤 jeszcze raz."
        : "Nie mogę uruchomić mikrofonu: " + e.message;
      if (opts.onDone) opts.onDone({ alts: [], gotFinal: false, error: msg, heldMs: 0, started: false });
    }
  }
  async function chmuraStop(g, porzuc) {
    if (g.done) return;
    g.released = true; ekranUkryj();          // puszczony przycisk = od razu zwykły ekran
    if (!g.startedAt && !porzuc) return;        // dokończy chmuraStart
    g.done = true; clearTimeout(g.watchdog);
    const heldMs = g.startedAt ? Date.now() - g.startedAt : 0;
    zamknijNagranie(g.n);
    const wys = glosStop(g.wys);
    if (nagranie === g) nagranie = null;
    ustawSesje("playback", "koniec nagrania (chmura)");
    const fin = (res) => { if (res) res.wys = wys; przetwarzanie = false; g.btn.classList.remove("rec"); g.btn.textContent = LABEL_IDLE; if (!porzuc && g.opts.onDone) g.opts.onDone(res); };
    if (porzuc || !g.n) { fin(null); return; }
    const lv = poziom(g.n);
    diag("chmura stop: " + heldMs + " ms, szczyt=" + lv.szczyt.toFixed(3) + " rms=" + lv.rms.toFixed(4));
    if (g.opts.tylkoGlos) {                     // ćwiczenie melodii: ocena z linii głosu, bez rozpoznawania mowy
      let ocena = null;
      try { const tony = wartosc(g.opts.tony); if (wys && lv.glos && tony) ocena = ocenTony(Float32Array.from(wys.ty), tony, wys.ref); if (g.opts.wysokosc) wysokoscTonow(ocena); } catch (e) { diag("ocena tonów: " + e.message); }
      diag("ocena tonów: " + (ocena ? ocena.sylaby.map(x => x.ton + (x.ok ? "" : "✗" + x.jak)).join(" ") : "brak głosu"));
      zapiszProbe(g.n, g.opts, ocena);
      fin({ alts: [], gotFinal: false, error: null, heldMs, started: true, ocena });
      return;
    }
    if (!lv.glos) { fin({ alts: [], gotFinal: false, error: null, heldMs, started: true }); return; }   // Whisper na ciszy zmyśla
    przetwarzanie = true; g.btn.textContent = "⏳ rozpoznaję…";
    try {
      const cel = celZ(g.opts), t = await whisper(g.n, cel);
      if (t && zaciete(t, cel)) { diag("whisper się zaciął, wynik odrzucony"); fin({ alts: [], gotFinal: false, error: null, zaciete: true, heldMs, started: true }); }
      else fin({ alts: t ? [t] : [], gotFinal: true, error: null, heldMs, started: true });
    }
    catch (e) { diag("chmura błąd: " + e.message); fin({ alts: [], gotFinal: false, error: "Rozpoznawanie w chmurze nie działa: " + e.message, heldMs, started: true }); }
  }

  function bind(btn, opts) {
    btn.textContent = LABEL_IDLE;
    const down = (e) => {
      if (e.isPrimary === false || (e.button && e.button > 0)) return;
      e.preventDefault(); e.stopPropagation(); try { btn.setPointerCapture(e.pointerId); } catch (err) {}
      if ((session && session.btn === btn) || (nagranie && nagranie.btn === btn)) return; // powtórny pointerdown (multi-touch)
      if (opts.tylkoGlos || cfg().uzyj === "chmura") chmuraStart(btn, opts); else startListening(btn, opts);
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
              audioAktywne, graj, stopAudio, preload: dekoduj, kontekst, LABEL_IDLE, renderTony, tonyMowione, wzorTonu, wzorLinii, wysokoscTonow, KOTWICA_TONU };
  window.Wymowa = W;
})();
