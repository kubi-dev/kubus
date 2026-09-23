// Wspólny moduł sprawdzania wymowy (Web Speech API) dla stron lekcji i powtórek.
// iOS 26 WebKit (Safari i Chrome na iPhonie): mikrofon Web Speech nagrywa proces GPU na wspólnej sesji AVAudioSession,
// a element <audio> grający mp3 zapisuje do tej samej sesji (dezaktywacja po "ended", zmiana kategorii na Ambient po 2 s
// / po GC) — trafia to w start rozpoznawania i daje ciszę bez błędu (WebKit bug 317741/321436, poprawka nie w iOS 26.x).
// Zasady: 1. mp3 gramy przez Web Audio (jeden AudioContext na stronę; wymiana tylko gdy stary jest martwy: iOS po uśpieniu
// karty zostawia "running" z zegarem w miejscu; nigdy przy mikrofonie, a nasłuch czeka 700 ms po każdym nowym kontekście)
// — brak zapisów do sesji przy odtwarzaniu; 2. navigator.audioSession.type = "playback" na stałe (głośne mp3 przez głośnik, ignoruje przełącznik
// wyciszenia), a po KAŻDYM zakończeniu nasłuchu "ambient" -> "playback", żeby cofnąć PlayAndRecord/VideoChat ustawione
// przez proces GPU (inaczej mp3 grałoby cicho); 3. żadnego getUserMedia przed start() (strumień trzymany przy starcie =
// głuche sesje); 4. między końcem nasłuchu a następnym start() odstęp (localStorage kubus.wymowa.odstep, domyślnie 4500 ms),
// żeby proces GPU zdążył zwinąć starą jednostkę mikrofonu; 5. nowa instancja SpeechRecognition na sesję, zdarzenia
// starych instancji ignorowane; 6. użytkownik sam kończy nasłuch puszczając przycisk.
//
// Silniki: "chmura" (getUserMedia + WAV 16 kHz -> worker Whisper) i "system" (Web Speech, na iOS Apple na urządzeniu).
// localStorage "kubus.wymowa.silnik" = auto | chmura | system | system-reload. Parametry testowe w URL: ?odstep=0 ?sesja=0 ?silnik=system
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
  const ODSTEP_PO_SR = 0;      // odstęp po końcu nasłuchu; 0 potwierdzone na iPhonie (iOS 26, Chrome), ?odstep=N nadpisuje
  const ODSTEP_PO_TTS = 3500;    // tylko po speechSynthesis (głos systemowy)
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // parametry testowe z URL -> localStorage
  (function () {
    try {
      const q = new URLSearchParams(location.search);
      for (const [p, k] of [["odstep", "kubus.wymowa.odstep"], ["sesja", "kubus.wymowa.sesja"], ["silnik", "kubus.wymowa.silnik"]])
        if (q.has(p)) localStorage.setItem(k, q.get(p));
    } catch (e) {}
  })();

  function cfg() {
    const ls = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    let sync = {}; try { sync = JSON.parse(ls("kubus.powtorka.sync") || "{}"); } catch (e) {}
    const silnik = ls("kubus.wymowa.silnik") || "auto";
    const url = (sync.url || window.SYNC_URL || "").replace(/\/$/, ""), klucz = sync.klucz || "";
    const chmuraOk = !!(url && klucz && GUM && AC);
    // system-reload: silnik systemowy + przeładowanie strony po każdym użyciu (zostaje jako awaryjny, tylko z wyboru)
    // auto = system (Apple na iOS, Google w Chrome); chmura (Whisper) tylko na wyraźne życzenie
    const uzyj = silnik === "system" ? "system" : silnik === "system-reload" ? "system-reload" : silnik === "chmura" ? (chmuraOk ? "chmura" : "system") : "system";
    const o = ls("kubus.wymowa.odstep");
    const odstep = (o === null || o === "" || isNaN(Number(o))) ? ODSTEP_PO_SR : Math.max(0, Number(o));
    return { url, klucz, silnik, uzyj, chmuraOk, reload: uzyj === "system-reload", odstep, sesjaAudio: ls("kubus.wymowa.sesja") !== "0" };
  }
  diag("UA: " + navigator.userAgent);
  diag("iOS: " + (IOS_VER || "nie") + ", SpeechRecognition: " + (SR ? "jest" : "BRAK") + ", getUserMedia: " + (GUM ? "jest" : "BRAK") + ", AudioContext: " + (AC ? "jest" : "BRAK") + ", audioSession: " + (AS ? "jest (" + AS.type + ")" : "BRAK"));
  diag("silnik: " + cfg().uzyj + " (ustawienie " + cfg().silnik + ", chmura " + (cfg().chmuraOk ? "dostępna" : "niedostępna: brak adresu/klucza") + "), odstęp po nasłuchu " + cfg().odstep + " ms, sterowanie sesją audio: " + (cfg().sesjaAudio ? "tak" : "NIE"));

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
  // esencja dźwięku: max 2 najważniejsze rzeczy dla tej sylaby (waga = trudność dla Polaka)
  function podpowiedzDzwiek(baza) {
    const r = rozbierz(baza), ini = r.ini, fin = r.fin, H = [];
    const q = x => "„" + x + "”";
    if (["p", "t", "k", "q", "ch", "c"].includes(ini)) { const [lit, slowo] = SLOWO_PL[ini]; H.push([5, `${q(INI_PL[ini])} to polskie ${q(lit)} jak w ${q(slowo)}, a zaraz po nim mocne dmuchnięcie, jak na gorącą zupę. „h” w zapisie znaczy właśnie: dmuchnij. Kartka przed ustami ma drgnąć.`]); }
    if (["b", "d", "g", "j", "zh", "z"].includes(ini)) { const [lit, slowo] = SLOWO_PL[ini]; H.push([5, `${q(INI_PL[ini])} to zwykłe polskie ${q(lit)} jak w ${q(slowo)}, bez dmuchnięcia. Kartka przed ustami stoi.`]); }
    if (fin.includes("ü")) H.push([4, "ü: usta w dzióbek jak do gwizdania i tak powiedz „i”. W lustrze usta nie rozjeżdżają się."]);
    if (r.twardeY) H.push([4, "„i” tu czytasz twardo, jako „y”, jak w „czy”, „szyć”."]);
    if (["e", "en", "eng"].includes(fin)) H.push([3, "„e” to zastanawiające „yyy…”, gdy szukasz słowa. Nie polskie „e”."]);
    if (fin === "er") H.push([3, "„a” z czubkiem języka zagiętym do góry. Nie trzęś nim jak w „rower”."]);
    if (/ng$/.test(fin)) H.push([3, "Końcówka jak „bank” bez „k”: czubek języka wisi, nie dotyka zębów."]);
    else if (/n$/.test(fin)) H.push([2, "Końcówka jak „ten”: czubek języka za górnymi zębami. Nie przez nos."]);
    if (ini === "r") H.push([2, "„r” to polskie „ż” jak w „żaba”. Nie warcz."]);
    if (ini === "h") H.push([2, "„h” to polskie „ch” jak w „chleb”."]);
    if (ini === "x") H.push([1, "„x” to „ś” jak w „siano”."]);
    if (ini === "sh") H.push([1, "„sh” to „sz” jak w „szal”."]);
    if (fin === "ian") H.push([2, "„ian” mówisz „ien”, jak w „cień”."]);
    if (fin === "iu") H.push([2, "„iu” mówisz „ioł”."]);
    if (fin === "ui") H.push([2, "„ui” mówisz „łej”, jak w „klej”."]);
    if (fin === "un") H.push([2, "„un” mówisz „łyn”."]);
    if (fin === "ong" || fin === "iong") H.push([2, "„ong” mówisz „ung”."]);
    if (fin === "uo") H.push([1, "„uo” to „ło”, jak w „łoś”."]);
    if (fin === "ao" || fin === "iao") H.push([1, "„ao” to „ał”, jak w „chałwa”."]);
    if (fin === "ou" || fin === "iu") H.push([1, "„ou” to „oł”."]);
    if (r.zero && fin[0] === "w") H.push([1, "„w” to polskie „ł”."]);
    if (r.zero && fin[0] === "y" && r.pl[0] === "j") H.push([1, "„y” to polskie „j”."]);
    if (!H.length) H.push([0, "Czytaj po polsku, litera po literze."]);
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

  // ---- sesja audio (kategoria AVAudioSession po stronie WebContent) ----
  let ostatniKoniecSR = 0;  // czas ostatniego przywrócenia kategorii; od niego liczymy odstęp do następnego start()
  function ustawSesje(typ) {
    if (!AS || !cfg().sesjaAudio) return false;
    try { AS.type = typ; const odczyt = AS.type; diag("audioSession := " + typ + (odczyt !== typ ? " (odczyt: " + odczyt + ")" : "")); return odczyt === typ; }
    catch (e) { diag("audioSession błąd: " + e.message); return false; }
  }
  // WebKit wysyła kategorię do procesu GPU tylko, gdy różni się od ostatnio WYSŁANEJ (nie od stanu systemu),
  // więc żeby cofnąć PlayAndRecord ustawione przez GPU, trzeba przejść przez inną wartość. NIGDY w trakcie nasłuchu.
  function przywrocPlayback(powod) {
    ustawSesje("ambient"); ustawSesje("playback");
    ostatniKoniecSR = Date.now();
    diag("kategoria audio przywrócona: playback (" + powod + ")" + (!AS ? " [brak API audioSession – zostaje sam odstęp]" : (!cfg().sesjaAudio ? " [sterowanie sesją wyłączone]" : "")));
  }
  // Start strony: pełne przełączenie (ambient -> playback), nie samo "playback". Po przejściu z innej podstrony proces GPU
  // trzyma kategorię po poprzedniej stronie (np. PlayAndRecord po mikrofonie), a WebKit nie wysyła wartości, której "już wysłał";
  // objaw: mp3 grało cicho (przez słuchawkę) po każdej zmianie podstrony.
  przywrocPlayback("start strony");

  // ---- Web Audio: odtwarzanie mp3 (bez elementu <audio>, patrz komentarz na górze pliku) ----
  let ctx = null, zrodlo = null, nrGrania = 0;
  let ctxOd = 0;            // kiedy powstał bieżący kontekst (mikrofon czeka 700 ms od tej chwili: aktywacja sesji ma dojść do GPU)
  let ctxMartwy = false;    // iOS: po uśpieniu karty kontekst zgłasza "running", ale jednostka audio nie żyje (currentTime stoi, cisza)
  let ostatniCzas = -1, ostatniStartMs = 0;  // currentTime i czas ostatniego start(): przy następnym graniu sprawdzamy, czy zegar szedł
  const bufory = new Map(); // url -> Promise<AudioBuffer>
  const MAX_BUFOROW = 30;
  // Jedyne miejsce tworzenia kontekstu. Wymiana TYLKO gdy stary jest martwy (closed / zegar stoi) i nigdy przy mikrofonie:
  // każdy nowy kontekst to zapis do sesji audio iOS, po którym nasłuch startujący zaraz potem nagrywa ciszę.
  function nowyKontekst(powod) {
    const stary = ctx;
    if (stary) { zrodlo = null; try { stary.close().catch(() => {}); } catch (e) {} }
    const c = ctx = new AC();
    ctxOd = Date.now(); ctxMartwy = false; ostatniCzas = -1; ostatniStartMs = 0;
    c.addEventListener("statechange", () => { if (ctx === c) diag("AudioContext: " + c.state); });
    diag("AudioContext utworzony (" + powod + "): " + c.state + ", " + c.sampleRate + " Hz");
    // pierwszy dźwięk na tej stronie: jeszcze raz przełącz kategorię (nigdy w trakcie nasłuchu)
    if (!session && !nagranie) przywrocPlayback("nowy AudioContext");
    return c;
  }
  function kontekst() {                       // wołać w geście użytkownika
    if (!AC) return null;
    if (!ctx) return nowyKontekst("pierwszy gest");
    if (!session && !nagranie) {
      if (ctx.state === "running" && ostatniCzas >= 0 && Date.now() - ostatniStartMs > 300 && ctx.currentTime === ostatniCzas) { diag("zegar kontekstu stoi od ostatniego grania"); ctxMartwy = true; }
      if (ctx.state === "closed" || ctxMartwy) return nowyKontekst(ctx.state === "closed" ? "stary zamknięty" : "stary martwy");
    }
    if (ctx.state !== "running") ctx.resume().catch(e => diag("resume: " + e.message));
    return ctx;
  }
  for (const ev of ["pointerup", "touchend", "click", "keydown"]) document.addEventListener(ev, () => { kontekst(); }, { capture: true, passive: true });
  // Po powrocie na stronę: czy kontekst naprawdę gra? "running" z zegarem w miejscu = martwy (wymiana przy następnym geście).
  function sprawdzZycie(powod) {
    const c = ctx; if (!c || session || nagranie) return;
    if (c.state !== "running") { c.resume().catch(() => {}); }
    const t = c.currentTime;
    setTimeout(() => {
      if (ctx !== c || session || nagranie) return;
      if (c.state === "running" && c.currentTime === t) { ctxMartwy = true; diag("kontekst martwy (" + powod + "): running, zegar stoi na " + t.toFixed(3)); }
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
  // Czeka aż kontekst gra: resume() ponawiany co 250 ms (po przerwaniu przez system iOS kończy przerwanie z opóźnieniem).
  async function obudz(c, ms) {
    const t0 = Date.now();
    while (c.state !== "running" && Date.now() - t0 < ms) {
      try { await c.resume(); } catch (e) { diag("resume: " + e.message); }
      if (c.state !== "running") await czekajNaRunning(c, 250);
    }
    return c.state === "running";
  }
  // Zwraca true po uruchomieniu odtwarzania, false gdy przerwane przez następne graj()/stopAudio();
  // rzuca (i pokazuje komunikat) gdy nie da się zagrać: brak pliku, błąd dekodowania, kontekst nie gra.
  // Jeden AudioContext na stronę, nigdy nie wymieniany ani nie zamykany: każdy nowy kontekst to zapis do sesji audio iOS,
  // po którym mikrofon (Web Speech w procesie GPU) nagrywa ciszę.
  async function graj(url, opts) {
    opts = opts || {};
    stopAudio();
    const nr = nrGrania;
    const c = kontekst(); if (!c) { komunikat("Ta przeglądarka nie odtwarza dźwięku (brak Web Audio)."); throw new Error("brak Web Audio"); }
    const t0 = Date.now();
    let buf;
    try { buf = await dekoduj(url); }
    catch (e) { if (nr === nrGrania) komunikat("Nie mogę pobrać nagrania (" + e.message + "). Sprawdź internet."); throw e; }
    if (nr !== nrGrania) return false;
    if (c.state !== "running") {
      diag("AudioContext " + c.state + " przed graniem – budzę");
      const ok = await obudz(c, 1500);
      if (nr !== nrGrania) return false;
      if (!ok) {
        diag("AudioContext " + c.state + " – nie gram (sesja " + (AS ? AS.type : "-") + ")");
        if (!session && !nagranie) ctxMartwy = true;   // nie wstał mimo gestu: następne dotknięcie tworzy nowy kontekst w geście
        komunikat("Dźwięk nie zagrał: system zablokował audio (" + c.state + "). Dotknij jeszcze raz.");
        throw new Error("AudioContext " + c.state);
      }
    }
    const z = c.createBufferSource(); z.buffer = buf; z.connect(c.destination);
    const g = { z, opts }; zrodlo = g;
    z.onended = () => { if (zrodlo === g) { zrodlo = null; if (opts.onEnd) { try { opts.onEnd(false); } catch (e) {} } } };
    z.start();
    const czasStartu = c.currentTime; ostatniCzas = czasStartu; ostatniStartMs = Date.now();
    diag("gram " + url.split("/").pop() + " " + buf.duration.toFixed(2) + " s (po " + (Date.now() - t0) + " ms, ctx " + c.state + ", zegar " + czasStartu.toFixed(3) + ", sesja " + (AS ? AS.type : "-") + ")");
    // Kontrola po 400 ms: zegar stoi = kontekst martwy (iOS po uśpieniu karty). Wtedy nowy kontekst i jeszcze raz;
    // bez gestu nowy może wstać zawieszony – wtedy komunikat, następne dotknięcie tworzy go już w geście.
    setTimeout(async () => {
      if (nr !== nrGrania || ctx !== c || c.state !== "running" || c.currentTime > czasStartu || session || nagranie) return;
      diag("zegar kontekstu stoi po start() – kontekst martwy, wymieniam");
      stopAudio(); const nr2 = nrGrania;
      const c2 = nowyKontekst("martwy po powrocie");
      if (!(await obudz(c2, 800)) || nr2 !== nrGrania) { if (nr2 === nrGrania) komunikat("Dźwięk nie zagrał: system uciął audio po powrocie do karty. Dotknij jeszcze raz."); return; }
      const z2 = c2.createBufferSource(); z2.buffer = buf; z2.connect(c2.destination);
      const g2 = { z: z2, opts }; zrodlo = g2;
      z2.onended = () => { if (zrodlo === g2) { zrodlo = null; if (opts.onEnd) { try { opts.onEnd(false); } catch (e) {} } } };
      z2.start(); ostatniCzas = c2.currentTime; ostatniStartMs = Date.now();
      diag("gram ponownie " + url.split("/").pop() + " (nowy ctx " + c2.state + ")");
    }, 400);
    return true;
  }

  // ---- głos systemowy: strony zgłaszają go tu (po nim odstęp jak dawniej) ----
  let ostatnieAudio = 0;
  function audioAktywne() { ostatnieAudio = Date.now(); }

  // ---- rozpoznawanie: nowa instancja na sesję, start() w zadaniu pointerdown, bez getUserMedia ----
  let session = null; // { btn, opts, rec, faza: starting|listening|stopping, startedAt, interim, finalAlts, gotFinal, error, released, timery }

  function finish(s, why) {
    clearTimeout(s.watchdog); clearTimeout(s.endGuard); clearTimeout(s.hardLimit); clearTimeout(s.noStart);
    s.btn.classList.remove("rec"); s.btn.textContent = LABEL_IDLE;
    const alts = (s.gotFinal ? s.finalAlts : (s.interim ? [s.interim] : [])).filter(a => a);
    const heldMs = s.startedAt ? Date.now() - s.startedAt : 0;
    diag("koniec (" + why + "): final=" + s.gotFinal + " interim=" + JSON.stringify(s.interim || "") + " trzymane " + heldMs + " ms");
    przywrocPlayback("koniec nasłuchu");           // ZAWSZE po sesji, nigdy w jej trakcie
    const res = { alts, gotFinal: s.gotFinal, error: s.error, heldMs, started: !!s.startedAt };
    if (s.opts.onDone) { try { s.opts.onDone(res); } catch (e) { diag("onDone błąd: " + e.message); } }
    if (cfg().reload && s.startedAt) przeladuj(s.opts, res); // przeładowanie tylko po realnej sesji nasłuchu
  }
  function forceFinish(s, why) {
    if (session !== s) return;
    diag("kończę na siłę: " + why);
    try { if (s.rec) s.rec.abort(); } catch (e) {}
    session = null; finish(s, why);
  }

  async function startListening(btn, opts) {
    if (!SR) { if (opts.onDone) opts.onDone({ alts: [], gotFinal: false, error: "Rozpoznawanie mowy działa tylko w Chrome, Edge lub Safari.", heldMs: 0, started: false }); return; }
    if (session) { diag("sesja trwa (" + session.faza + "), ignoruję naciśnięcie"); return; }   // brak kolejki `pending`
    const t0 = Date.now();
    const s = session = { btn, opts, rec: null, faza: "starting", startedAt: 0, interim: "", finalAlts: null, gotFinal: false, error: null, released: false };
    s.hardLimit = setTimeout(() => forceFinish(s, "limit 30 s"), 30000);
    btn.classList.add("rec"); btn.textContent = "⏳ uruchamiam…";
    kontekst();
    stopAudio();
    if (W.beforeStart) { try { W.beforeStart(); } catch (e) {} }
    if ("speechSynthesis" in window) { if (speechSynthesis.speaking || speechSynthesis.pending) audioAktywne(); speechSynthesis.cancel(); }
    let target = ""; try { target = typeof opts.target === "function" ? opts.target() : opts.target; } catch (e) {}
    if (opts.onStart) { try { opts.onStart(); } catch (e) {} }
    // Odstęp: po poprzednim nasłuchu (stara jednostka mikrofonu w GPU), po głosie systemowym, po świeżym AudioContext
    // (jego aktywacja sesji właśnie poszła do GPU; ma dojść przed startem mikrofonu) – 700 ms od utworzenia, także po wymianie.
    const potrzeba = () => Math.max(cfg().odstep - (Date.now() - ostatniKoniecSR), ODSTEP_PO_TTS - (Date.now() - ostatnieAudio), 700 - (Date.now() - ctxOd));
    let czekaj = potrzeba();
    const odKiedy = (t) => t ? (Date.now() - t) + " ms" : "nigdy";
    if (czekaj > 0) diag("czekam " + czekaj + " ms (po nasłuchu " + odKiedy(ostatniKoniecSR) + ", po głosie systemowym " + odKiedy(ostatnieAudio) + ")");
    while ((czekaj = potrzeba()) > 0) {
      btn.textContent = "⏳ chwila… " + Math.ceil(czekaj / 1000);
      await sleep(Math.min(czekaj, 200));
      if (session !== s) return;
      if (s.released) { diag("puszczony w trakcie odliczania"); session = null; finish(s, "puszczony przed startem"); return; }
    }
    if (ctx && ctx.state !== "running") { kontekst(); await czekajNaRunning(ctx, 500); if (session !== s) return; if (s.released) { session = null; finish(s, "puszczony przed startem"); return; } }
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    btn.textContent = "⏳ uruchamiam…";
    const r = s.rec = new SR();
    r.lang = "zh-CN"; r.interimResults = true; r.maxAlternatives = 5; r.continuous = true;
    const moja = () => session === s;
    r.onstart = () => {
      if (!moja()) return;
      diag("onstart po " + (Date.now() - t0) + " ms od naciśnięcia");
      s.faza = "listening"; s.startedAt = Date.now(); clearTimeout(s.noStart);
      btn.textContent = "🎙 mów teraz…";
      if (s.released) { diag("puszczony przed onstart, kończę"); stopNow(s); }
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
      // wynik wstępny pokazujemy w samym przycisku (stała szerokość): nic na stronie nie zmienia wysokości w trakcie mówienia
      if (alts[0]) btn.textContent = "🎙 " + (alts[0].length > 9 ? "…" + alts[0].slice(-9) : alts[0]);
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
    diag("start cel=" + target + " ctx=" + (ctx ? ctx.state : "brak") + " sesja=" + (AS ? AS.type : "-"));
    try { r.start(); }
    catch (e) { diag("start() wyjątek: " + e.name + " " + e.message); session = null; s.error = "Nie mogę uruchomić: " + e.message; finish(s, "wyjątek start()"); return; }
    s.noStart = setTimeout(() => { if (moja() && !s.startedAt) forceFinish(s, "brak onstart po 5 s"); }, 5000);
    s.watchdog = setTimeout(() => { if (moja() && s.faza === "listening") { diag("watchdog 15 s"); stopNow(s); } }, 15000);
  }

  function stopNow(s) {
    if (session !== s || s.faza !== "listening") return;
    s.faza = "stopping"; s.btn.textContent = "⏳ przetwarzam…";
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
    stopNow(s);
  }

  // ---- tryb "system-reload": po użyciu mikrofonu strona ładuje się od nowa, wynik i pozycję odtwarzamy po starcie ----
  const KLUCZ_WYNIK = "kubus.wymowa.wynik";
  function przeladuj(opts, res) {
    let target = ""; try { target = typeof opts.target === "function" ? opts.target() : opts.target; } catch (e) {}
    let stanStrony = null;
    if (W.zapiszStan) { try { stanStrony = W.zapiszStan(); } catch (e) { diag("zapiszStan błąd: " + e.message); } }
    try { sessionStorage.setItem(KLUCZ_WYNIK, JSON.stringify({ href: location.href, ts: Date.now(), target, res, scrollY: window.scrollY, strona: stanStrony })); } catch (e) {}
    diag("przeładowanie strony (tryb system-reload)");
    try { if (diagEl) sessionStorage.setItem(KLUCZ_DIAG, diagEl.textContent.split("\n").slice(-40).join("\n") + "\n"); } catch (e) {}
    setTimeout(() => location.reload(), 150);
  }
  // Zwraca zapisany wynik z poprzedniego załadowania (albo null) i kasuje go.
  function odbierzWynik() {
    let w = null;
    try { w = JSON.parse(sessionStorage.getItem(KLUCZ_WYNIK) || "null"); sessionStorage.removeItem(KLUCZ_WYNIK); } catch (e) {}
    if (!w || w.href !== location.href || Date.now() - w.ts > 60000) return null;
    diag("wynik odtworzony po przeładowaniu: " + JSON.stringify(w.res.alts));
    return w;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (session) forceFinish(session, "strona ukryta"); if (nagranie) chmuraStop(nagranie, true); stopAudio(); }
    else { kontekst(); przywrocPlayback("powrót na stronę"); sprawdzZycie("powrót na stronę"); }
  });
  window.addEventListener("pageshow", (e) => { if (e.persisted) { session = null; nagranie = null; zrodlo = null; kontekst(); przywrocPlayback("bfcache"); sprawdzZycie("bfcache"); } });

  // ---- silnik "chmura": nagranie WAV -> worker /wymowa (Whisper) ----
  let nagranie = null; // { btn, opts, ctx, stream, src, proc, cisza, chunks, rate, startedAt, released, done }

  function wav16k(chunks, rate) {
    let n = 0; for (const c of chunks) n += c.length;
    const all = new Float32Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    const ratio = rate / 16000, outLen = Math.floor(all.length / ratio);
    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      // średnia z okna (proste filtrowanie przy decymacji)
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

  async function chmuraStart(btn, opts) {
    if (nagranie) { diag("chmura: poprzednie nagranie trwa, przerywam"); chmuraStop(nagranie, true); }
    stopAudio();
    if (W.beforeStart) { try { W.beforeStart(); } catch (e) {} }
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    let target = ""; try { target = typeof opts.target === "function" ? opts.target() : opts.target; } catch (e) {}
    const n = { btn, opts, ctx: null, stream: null, src: null, proc: null, cisza: null, chunks: [], rate: 0, startedAt: 0, released: false, done: false };
    nagranie = n;
    btn.classList.add("rec"); btn.textContent = "⏳ uruchamiam…";
    if (opts.onStart) { try { opts.onStart(); } catch (e) {} }
    diag("chmura start cel=" + target);
    try {
      // wspólny AudioContext strony (nigdy nie zamykany); tworzony synchronicznie w geście użytkownika
      n.ctx = kontekst(); if (!n.ctx) throw new Error("brak AudioContext");
      const t0 = Date.now();
      n.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      diag("getUserMedia OK po " + (Date.now() - t0) + "ms, sampleRate=" + n.ctx.sampleRate);
      if (nagranie !== n) { n.stream.getTracks().forEach(t => t.stop()); return; }
      n.rate = n.ctx.sampleRate;
      n.src = n.ctx.createMediaStreamSource(n.stream);
      n.proc = n.ctx.createScriptProcessor(4096, 1, 1);
      n.proc.onaudioprocess = (e) => { if (!n.released) n.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
      n.cisza = n.ctx.createGain(); n.cisza.gain.value = 0; // ScriptProcessor musi być podpięty do wyjścia, ale nic nie gramy
      n.src.connect(n.proc); n.proc.connect(n.cisza); n.cisza.connect(n.ctx.destination);
      n.startedAt = Date.now();
      btn.textContent = "🎙 mów teraz…";
      n.watchdog = setTimeout(() => { if (nagranie === n && !n.released) { diag("chmura watchdog 15s"); chmuraStop(n); } }, 15000);
      if (n.released) chmuraStop(n);
    } catch (e) {
      diag("chmura start błąd: " + e.name + " " + e.message);
      chmuraSprzataj(n);
      if (nagranie === n) nagranie = null;
      btn.classList.remove("rec"); btn.textContent = LABEL_IDLE;
      const msg = e.name === "NotAllowedError" ? "Brak zgody na mikrofon. Zezwól w ustawieniach strony / przeglądarki." : "Nie mogę uruchomić mikrofonu: " + e.message;
      if (opts.onDone) opts.onDone({ alts: [], gotFinal: false, error: msg, heldMs: 0, started: false });
    }
  }

  function chmuraSprzataj(n) {
    clearTimeout(n.watchdog);
    try { if (n.proc) { n.proc.disconnect(); n.proc.onaudioprocess = null; } } catch (e) {}
    try { if (n.src) n.src.disconnect(); } catch (e) {}
    try { if (n.cisza) n.cisza.disconnect(); } catch (e) {}
    try { if (n.stream) n.stream.getTracks().forEach(t => t.stop()); } catch (e) {}   // bez ctx.close(): kontekst żyje ze stroną
    diag("mikrofon zwolniony");
    przywrocPlayback("koniec nagrania (chmura)");
  }

  async function chmuraStop(n, porzuc) {
    if (n.done) return;
    n.released = true;
    if (!n.startedAt && !porzuc) { diag("chmura: puszczony przed startem"); return; } // dokończy chmuraStart
    n.done = true;
    const heldMs = n.startedAt ? Date.now() - n.startedAt : 0;
    chmuraSprzataj(n);
    if (nagranie === n) nagranie = null;
    const fin = (res) => { n.btn.classList.remove("rec"); n.btn.textContent = LABEL_IDLE; if (!porzuc && n.opts.onDone) n.opts.onDone(res); };
    if (porzuc) { fin(null); return; }
    let probek = 0, szczyt = 0, suma = 0;
    for (const c of n.chunks) { probek += c.length; for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > szczyt) szczyt = v; suma += v * v; } }
    const rms = probek ? Math.sqrt(suma / probek) : 0;
    diag("chmura stop: " + heldMs + "ms, " + probek + " próbek, szczyt=" + szczyt.toFixed(3) + " rms=" + rms.toFixed(4));
    if (heldMs < 400 || probek < n.rate * 0.3) { fin({ alts: [], gotFinal: false, error: null, heldMs, started: !!n.startedAt }); return; }
    // cisza: nie wysyłamy (Whisper na ciszy zmyśla), traktujemy jak "nic nie usłyszałem"
    // szum tła w cichym pokoju: szczyt ~0.05, rms ~0.007; mowa z AGC: szczyt > 0.2, rms > 0.02
    if (szczyt < 0.08 || rms < 0.01) { diag("chmura: za cicho, nie wysyłam"); fin({ alts: [], gotFinal: false, error: null, heldMs, started: true }); return; }
    n.btn.textContent = "⏳ rozpoznaję…";
    const c = cfg();
    try {
      const wav = wav16k(n.chunks, n.rate);
      const t0 = Date.now();
      const r = await fetch(c.url + "/wymowa", { method: "POST", headers: { "Authorization": "Bearer " + c.klucz, "Content-Type": "audio/wav" }, body: wav });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      diag("whisper: " + JSON.stringify(j.text) + " po " + (Date.now() - t0) + "ms");
      fin({ alts: j.text ? [j.text] : [], gotFinal: true, error: null, heldMs, started: true });
    } catch (e) {
      diag("chmura błąd: " + e.message);
      fin({ alts: [], gotFinal: false, error: "Rozpoznawanie w chmurze nie działa: " + e.message, heldMs, started: true });
    }
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
      kontekst();                                 // pointerup jest na pewno gestem aktywującym
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
              audioAktywne, graj, stopAudio, preload: dekoduj, kontekst, przywrocPlayback, LABEL_IDLE };
  window.Wymowa = W;
})();
