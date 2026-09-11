// Wspólny moduł sprawdzania wymowy (Web Speech API) dla stron lekcji i powtórek.
// iOS 26 WebKit (Safari i Chrome na iPhonie): mikrofon Web Speech nagrywa proces GPU na wspólnej sesji AVAudioSession,
// a element <audio> grający mp3 zapisuje do tej samej sesji (dezaktywacja po "ended", zmiana kategorii na Ambient po 2 s
// / po GC) — trafia to w start rozpoznawania i daje ciszę bez błędu (WebKit bug 317741/321436, poprawka nie w iOS 26.x).
// Zasady: 1. mp3 gramy przez Web Audio (jeden AudioContext na stronę, nigdy nie zamykany) — brak zapisów do sesji
// przy odtwarzaniu; 2. navigator.audioSession.type = "playback" na stałe (głośne mp3 przez głośnik, ignoruje przełącznik
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
//   Wymowa.bind(btn, { target: () => "朋友", onStart(), onInterim(text), onDone(result) });
//   Wymowa.graj(url, { onEnd(przerwane) }) -> Promise<bool>;  Wymowa.stopAudio();  Wymowa.preload(url)
//   result = { alts: [...], gotFinal, error, heldMs, started }
//   Wymowa.render(result, target) -> { cls, html, grade }
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const strip = s => s.replace(/[。？?！!，,、.\s]/g, "");
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
    }
    const line = new Date().toISOString().slice(11, 23) + " " + msg;
    console.log("[wymowa] " + msg);
    if (diagEl) { diagEl.textContent += line + "\n"; diagEl.scrollTop = diagEl.scrollHeight; }
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
    if (g.level === "tones") return { cls: "ok", html: `✓ Sylaby OK, sprawdź tony. Usłyszałem: <b>${g.best}</b> (${g.heardPy}), cel: ${g.targetPy}${note}`, grade: g };
    if (g.level === "close") return { cls: "mid", html: `~ Blisko. Usłyszałem: <b>${g.best}</b> (${g.heardPy})<br>cel: ${t} (${g.targetPy})${note}`, grade: g };
    return { cls: "bad", html: `✗ Usłyszałem: <b>${g.best}</b> (${g.heardPy})<br>cel: ${t} (${g.targetPy})${note}`, grade: g };
  }

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
  ustawSesje("playback");

  // ---- Web Audio: odtwarzanie mp3 (bez elementu <audio>, patrz komentarz na górze pliku) ----
  let ctx = null, zrodlo = null, nrGrania = 0;
  const bufory = new Map(); // url -> Promise<AudioBuffer>
  const MAX_BUFOROW = 30;
  function kontekst() {                       // wołać w geście użytkownika; nigdy nie close()/suspend()
    if (!AC) return null;
    if (!ctx) {
      ctx = new AC();
      ctx.addEventListener("statechange", () => diag("AudioContext: " + ctx.state));
      diag("AudioContext utworzony: " + ctx.state + ", " + ctx.sampleRate + " Hz");
    }
    if (ctx.state !== "running") ctx.resume().catch(e => diag("resume: " + e.message));
    return ctx;
  }
  for (const ev of ["pointerup", "touchend", "click", "keydown"]) document.addEventListener(ev, () => { kontekst(); }, { capture: true, passive: true });
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
  // Zwraca true po uruchomieniu odtwarzania, false gdy przerwane/pominięte; rzuca przy błędzie pobrania/dekodowania.
  async function graj(url, opts) {
    opts = opts || {};
    stopAudio();
    const nr = nrGrania;
    const c = kontekst(); if (!c) throw new Error("brak Web Audio");
    const t0 = Date.now();
    const buf = await dekoduj(url);
    if (nr !== nrGrania) return false;
    if (c.state !== "running") { await czekajNaRunning(c, 400); if (nr !== nrGrania) return false; }
    if (c.state !== "running") { diag("AudioContext " + c.state + " – nie gram (potrzebny gest)"); return false; }
    const z = c.createBufferSource(); z.buffer = buf; z.connect(c.destination);
    const g = { z, opts }; zrodlo = g;
    z.onended = () => { if (zrodlo === g) { zrodlo = null; if (opts.onEnd) { try { opts.onEnd(false); } catch (e) {} } } };
    z.start();
    diag("gram " + url.split("/").pop() + " " + buf.duration.toFixed(2) + " s (po " + (Date.now() - t0) + " ms, ctx " + c.state + ", sesja " + (AS ? AS.type : "-") + ")");
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
    const nowyCtx = !ctx; kontekst();
    stopAudio();
    if (W.beforeStart) { try { W.beforeStart(); } catch (e) {} }
    if ("speechSynthesis" in window) { if (speechSynthesis.speaking || speechSynthesis.pending) audioAktywne(); speechSynthesis.cancel(); }
    let target = ""; try { target = typeof opts.target === "function" ? opts.target() : opts.target; } catch (e) {}
    if (opts.onStart) { try { opts.onStart(); } catch (e) {} }
    // Odstęp: po poprzednim nasłuchu (stara jednostka mikrofonu w GPU), po głosie systemowym, po świeżym AudioContext
    // (jego aktywacja sesji właśnie poszła do GPU; ma dojść przed startem mikrofonu).
    const minCtx = nowyCtx ? 700 : 0;
    const potrzeba = () => Math.max(cfg().odstep - (Date.now() - ostatniKoniecSR), ODSTEP_PO_TTS - (Date.now() - ostatnieAudio), minCtx - (Date.now() - t0));
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
    else { kontekst(); przywrocPlayback("powrót na stronę"); }
  });
  window.addEventListener("pageshow", (e) => { if (e.persisted) { session = null; nagranie = null; zrodlo = null; kontekst(); przywrocPlayback("bfcache"); } });

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

  const W = { diag, supported: !!SR || GUM, iOS: !!IOS_VER, beforeStart: null, zapiszStan: null, bind, grade, render, strip, toPinyin, cfg, odbierzWynik,
              audioAktywne, graj, stopAudio, preload: dekoduj, kontekst, przywrocPlayback, LABEL_IDLE };
  window.Wymowa = W;
})();
