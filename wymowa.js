// Wspólny moduł sprawdzania wymowy (Web Speech API) dla stron lekcji i powtórek.
// iOS WebKit (Safari i Chrome na iPhonie): nowa instancja przy każdym użyciu i automatyczne
// kończenie po ciszy są zawodne (druga sesja dostaje ciszę, stop() nie daje wyniku "final").
// Wzorzec, który działa: 1. jedna instancja SpeechRecognition, 2. otwarty strumień getUserMedia
// na czas nasłuchu (wymusza kategorię sesji audio play-and-record, po zwolnieniu wraca playback
// dla mp3), 3. użytkownik sam kończy nasłuch puszczając przycisk.
//
// Dwa silniki rozpoznawania:
//   "chmura": własne nagranie (getUserMedia + WAV 16 kHz) wysyłane do workera (Whisper, Workers AI).
//             Niezależne od bugów WebKit, działa za każdym razem, wynik po puszczeniu przycisku (1-4 s).
//   "system": Web Speech API (Google w Chrome, Apple w Safari/iOS). Wyniki na żywo, ale na iOS zawodne.
// Wybór: localStorage "kubus.wymowa.silnik" = auto | chmura | system. Auto = chmura, gdy jest adres i klucz.
// Adres workera: window.SYNC_URL (wstawia build.py); klucz: localStorage "kubus.powtorka.sync" (jak sync powtórek).
//
// Użycie:
//   Wymowa.beforeStart = () => { /* zatrzymaj odtwarzanie */ };
//   Wymowa.bind(btn, { target: () => "朋友", onInterim(text), onDone(result) });
//   result = { alts: [...], gotFinal, error, heldMs }
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

  function cfg() {
    let sync = {}; try { sync = JSON.parse(localStorage.getItem("kubus.powtorka.sync") || "{}"); } catch (e) {}
    let silnik = "auto"; try { silnik = localStorage.getItem("kubus.wymowa.silnik") || "auto"; } catch (e) {}
    const url = (sync.url || window.SYNC_URL || "").replace(/\/$/, ""), klucz = sync.klucz || "";
    const chmuraOk = !!(url && klucz && GUM && AC);
    // system-reload: silnik systemowy + przeładowanie strony po każdym użyciu (iOS: działa tylko pierwsza sesja po załadowaniu)
    // auto: iOS -> system + przeładowanie (jedyny tryb systemowy, który tam działa za każdym razem), inne -> system
    const uzyj = silnik === "system" ? "system" : silnik === "system-reload" ? "system-reload" : silnik === "chmura" ? (chmuraOk ? "chmura" : "system") : (IOS_VER ? "system-reload" : "system");
    return { url, klucz, silnik, uzyj, chmuraOk, reload: uzyj === "system-reload" };
  }
  diag("UA: " + navigator.userAgent);
  diag("iOS: " + (IOS_VER || "nie") + ", SpeechRecognition: " + (SR ? "jest" : "BRAK") + ", getUserMedia: " + (GUM ? "jest" : "BRAK") + ", AudioContext: " + (AC ? "jest" : "BRAK"));
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
      const html = result.heldMs < 400 ? "Za krótko. Przytrzymaj przycisk, poczekaj na „mów teraz”, powiedz słowo, dopiero wtedy puść."
        : "Nic nie usłyszałem. Przytrzymaj, poczekaj na „mów teraz”, powiedz i puść.";
      return { cls: "bad", html, grade: g };
    }
    if (g.level === "exact") return { cls: "ok", html: `✓ Idealnie. Usłyszałem: <b>${t}</b> (${g.targetPy})${note}`, grade: g };
    if (g.level === "tones") return { cls: "ok", html: `✓ Sylaby OK, sprawdź tony. Usłyszałem: <b>${g.best}</b> (${g.heardPy}), cel: ${g.targetPy}${note}`, grade: g };
    if (g.level === "close") return { cls: "mid", html: `~ Blisko. Usłyszałem: <b>${g.best}</b> (${g.heardPy})<br>cel: ${t} (${g.targetPy})${note}`, grade: g };
    return { cls: "bad", html: `✗ Usłyszałem: <b>${g.best}</b> (${g.heardPy})<br>cel: ${t} (${g.targetPy})${note}`, grade: g };
  }

  // ---- maszyna stanów: jedna instancja, przytrzymaj-i-mów ----
  let rec = null;           // singleton
  let state = "idle";       // idle | starting | listening | stopping
  let session = null;       // aktywny przycisk + callbacki
  let pending = null;       // start czekający na koniec poprzedniej sesji
  let micStream = null;

  function releaseMic() {
    if (micStream) { try { micStream.getTracks().forEach(t => t.stop()); } catch (e) {} micStream = null; diag("mikrofon zwolniony"); }
  }

  function getRec() {
    if (rec) return rec;
    rec = new SR();
    rec.lang = "zh-CN"; rec.interimResults = true; rec.maxAlternatives = 5; rec.continuous = true;
    rec.onstart = () => {
      state = "listening"; diag("onstart");
      if (!session) return;
      session.startedAt = Date.now();
      session.btn.textContent = "🎙 mów teraz…";
      if (session.released) { diag("puszczony przed onstart, przerywam"); state = "stopping"; try { rec.abort(); } catch (e) {} }
    };
    rec.onaudiostart = () => diag("onaudiostart");
    rec.onsoundstart = () => diag("onsoundstart");
    rec.onspeechstart = () => diag("onspeechstart");
    rec.onspeechend = () => diag("onspeechend");
    rec.onnomatch = () => diag("onnomatch");
    rec.onresult = (ev) => {
      if (!session) return;
      const last = ev.results[ev.results.length - 1];
      let prefix = "";
      for (let i = 0; i < ev.results.length - 1; i++) prefix += ev.results[i][0].transcript;
      const alts = Array.from(last).map(r => strip(prefix + r.transcript));
      diag("result final=" + last.isFinal + " " + alts[0]);
      if (last.isFinal) { session.finalAlts = alts; session.gotFinal = true; }
      else { session.interim = alts[0]; }
      if (session.opts.onInterim) session.opts.onInterim(alts[0]);
    };
    rec.onerror = (ev) => {
      diag("error " + ev.error + (ev.message ? " " + ev.message : "") + (session && session.startedAt ? " po " + (Date.now() - session.startedAt) + "ms" : " przed onstart"));
      if (!session || ev.error === "aborted") return;
      if (ev.error === "no-speech") return; // wynik z interim albo "nic nie usłyszałem" w finish
      session.error = ev.error === "not-allowed" || ev.error === "service-not-allowed" ? "Brak zgody na mikrofon. Zezwól w ustawieniach strony / przeglądarki."
        : ev.error === "network" ? "Błąd sieci przy rozpoznawaniu (sprawdź internet)."
        : ev.error === "audio-capture" ? "Mikrofon nie nagrywa (inna aplikacja go używa?)."
        : "Błąd rozpoznawania: " + ev.error;
    };
    rec.onend = () => {
      diag("onend");
      state = "idle";
      releaseMic();
      const s = session; session = null;
      if (s) finish(s);
      if (pending) { const p = pending; pending = null; setTimeout(() => startListening(p.btn, p.opts), 300); }
    };
    return rec;
  }

  function sesjaAudio(typ) {
    if (!("audioSession" in navigator)) return;
    try { navigator.audioSession.type = typ; diag("audioSession.type = " + navigator.audioSession.type); }
    catch (e) { diag("audioSession błąd: " + e.message); }
  }

  function finish(s) {
    clearTimeout(s.watchdog); clearTimeout(s.endGuard);
    s.btn.classList.remove("rec"); s.btn.textContent = LABEL_IDLE;
    if (!cfg().reload) sesjaAudio("auto"); // po przeładowaniu i tak wraca na auto
    const alts = (s.gotFinal ? s.finalAlts : (s.interim ? [s.interim] : [])).filter(a => a);
    const heldMs = s.startedAt ? Date.now() - s.startedAt : 0;
    diag("koniec: final=" + s.gotFinal + " interim=" + JSON.stringify(s.interim || "") + " trzymane " + heldMs + "ms");
    const res = { alts, gotFinal: s.gotFinal, error: s.error, heldMs };
    if (s.opts.onDone) s.opts.onDone(res);
    if (cfg().reload && s.startedAt) przeladuj(s.opts, res); // przeładowanie tylko po realnej sesji nasłuchu
  }

  // ---- tryb "system-reload": po użyciu mikrofonu strona ładuje się od nowa, wynik i pozycję odtwarzamy po starcie ----
  const KLUCZ_WYNIK = "kubus.wymowa.wynik";
  function przeladuj(opts, res) {
    const target = typeof opts.target === "function" ? opts.target() : opts.target;
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
    if (!w || w.href !== location.href || Date.now() - w.ts > 15000) return null;
    diag("wynik odtworzony po przeładowaniu: " + JSON.stringify(w.res.alts));
    return w;
  }

  // Strony zgłaszają tu każde odtworzenie / zatrzymanie audio. iOS WebKit: play/pause <audio> tuż przed
  // rozpoznawaniem systemowym zabija je bez błędu; potrzebny odstęp 3,5 s (WICG speech-api #96).
  let ostatnieAudio = 0;
  const ODSTEP_PO_AUDIO = 3500;
  function audioAktywne() { ostatnieAudio = Date.now(); }

  async function startListening(btn, opts) {
    if (!SR) { if (opts.onDone) opts.onDone({ alts: [], gotFinal: false, error: "Rozpoznawanie mowy działa tylko w Chrome, Edge lub Safari.", heldMs: 0 }); return; }
    if (state !== "idle") {
      // Poprzednia sesja jeszcze trwa albo się kończy: zapamiętaj, uruchom po onend.
      diag("stan " + state + ", kolejkuję start");
      pending = { btn, opts };
      if (state === "listening") stopListening();
      else if (state === "starting" && session) session.released = true;
      return;
    }
    state = "starting";
    if (W.beforeStart) { try { W.beforeStart(); } catch (e) {} }
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    const target = typeof opts.target === "function" ? opts.target() : opts.target;
    session = { btn, opts, startedAt: 0, interim: "", finalAlts: null, gotFinal: false, error: null, released: false };
    const s = session;
    btn.classList.add("rec"); btn.textContent = "⏳ uruchamiam…";
    const czekaj = Math.max(0, ODSTEP_PO_AUDIO - (Date.now() - ostatnieAudio));
    if (czekaj > 0) {
      diag("audio grało " + (Date.now() - ostatnieAudio) + "ms temu, czekam " + czekaj + "ms");
      const tik = setInterval(() => { btn.textContent = "⏳ po odsłuchu… " + Math.ceil((ODSTEP_PO_AUDIO - (Date.now() - ostatnieAudio)) / 1000); }, 200);
      btn.textContent = "⏳ po odsłuchu… " + Math.ceil(czekaj / 1000);
      await new Promise(r => setTimeout(r, czekaj));
      clearInterval(tik);
      if (session !== s) return;
      if (s.released) { diag("puszczony w trakcie odliczania"); state = "idle"; session = null; finish(s); return; }
      btn.textContent = "⏳ uruchamiam…";
    }
    // iOS: po odtworzeniu <audio> sesja audio zostaje w trybie "playback" i WebKit nie przełącza jej z powrotem
    // przy starcie rozpoznawania (mikrofon wyciszony). Wymuszamy tryb nagrywania na czas nasłuchu, potem wracamy na auto.
    sesjaAudio("play-and-record");
    if (opts.onStart) opts.onStart();
    diag("start cel=" + target);
    // Otwieramy mikrofon przez getUserMedia na czas nasłuchu (patrz komentarz na górze pliku).
    // W trybie system-reload nie: każda sesja jest "pierwszą po załadowaniu", a dodatkowy strumień może przeszkadzać.
    if (!cfg().reload && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try { const t0 = Date.now(); micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); diag("getUserMedia OK po " + (Date.now() - t0) + "ms"); }
      catch (e) { diag("getUserMedia błąd: " + e.name + " " + e.message); }
    }
    if (session === null || session.btn !== btn) { releaseMic(); return; } // przerwane w międzyczasie
    const r = getRec();
    try { r.start(); }
    catch (e) {
      diag("start() wyjątek: " + e.name + " " + e.message);
      state = "idle"; releaseMic();
      const s = session; session = null; s.error = "Nie mogę uruchomić: " + e.message; finish(s);
      return;
    }
    // Bezpieczniki: max 15 s nasłuchu; po stop() bez onend w 3 s -> abort.
    session.watchdog = setTimeout(() => { if (session && session.btn === btn) { diag("watchdog 15s"); stopListening(); } }, 15000);
  }

  function stopListening() {
    if (!session) return;
    session.released = true;
    if (state === "starting") { diag("puszczony w trakcie startu, czekam na onstart"); return; }
    if (state !== "listening") return;
    state = "stopping";
    session.btn.textContent = "⏳ przetwarzam…";
    diag("stop() po " + (session.startedAt ? Date.now() - session.startedAt : 0) + "ms nasłuchu");
    try { getRec().stop(); } catch (e) { diag("stop() wyjątek: " + e.message); }
    const s = session;
    s.endGuard = setTimeout(() => {
      if (session !== s) return;
      diag("brak onend po stop(), abort()");
      try { getRec().abort(); } catch (e) {}
      setTimeout(() => {
        if (session !== s) return;
        diag("brak onend po abort(), kończę na siłę");
        state = "idle"; releaseMic(); session = null; rec = null; // stara instancja do kosza
        finish(s);
      }, 3000);
    }, 3000);
  }

  // ---- silnik "chmura": nagranie WAV -> worker /wymowa (Whisper) ----
  let nagranie = null; // { btn, opts, ctx, stream, proc, chunks, rate, startedAt, released, done }

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
    if (W.beforeStart) { try { W.beforeStart(); } catch (e) {} }
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    const target = typeof opts.target === "function" ? opts.target() : opts.target;
    const n = { btn, opts, ctx: null, stream: null, proc: null, chunks: [], rate: 0, startedAt: 0, released: false, done: false };
    nagranie = n;
    btn.classList.add("rec"); btn.textContent = "⏳ uruchamiam…";
    if (opts.onStart) opts.onStart();
    diag("chmura start cel=" + target);
    try {
      // AudioContext tworzymy synchronicznie w geście użytkownika (iOS tego wymaga)
      n.ctx = new AC(); if (n.ctx.state === "suspended") n.ctx.resume().catch(() => {});
      const t0 = Date.now();
      n.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      diag("getUserMedia OK po " + (Date.now() - t0) + "ms, sampleRate=" + n.ctx.sampleRate);
      if (nagranie !== n) { n.stream.getTracks().forEach(t => t.stop()); n.ctx.close().catch(() => {}); return; }
      n.rate = n.ctx.sampleRate;
      const src = n.ctx.createMediaStreamSource(n.stream);
      n.proc = n.ctx.createScriptProcessor(4096, 1, 1);
      n.proc.onaudioprocess = (e) => { if (!n.released) n.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
      const cisza = n.ctx.createGain(); cisza.gain.value = 0; // ScriptProcessor musi być podpięty do wyjścia, ale nic nie gramy
      src.connect(n.proc); n.proc.connect(cisza); cisza.connect(n.ctx.destination);
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
      if (opts.onDone) opts.onDone({ alts: [], gotFinal: false, error: msg, heldMs: 0 });
    }
  }

  function chmuraSprzataj(n) {
    clearTimeout(n.watchdog);
    try { if (n.proc) { n.proc.disconnect(); n.proc.onaudioprocess = null; } } catch (e) {}
    try { if (n.stream) n.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    try { if (n.ctx) n.ctx.close(); } catch (e) {}
    diag("mikrofon zwolniony");
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
    if (heldMs < 400 || probek < n.rate * 0.3) { fin({ alts: [], gotFinal: false, error: null, heldMs }); return; }
    // cisza: nie wysyłamy (Whisper na ciszy zmyśla), traktujemy jak "nic nie usłyszałem"
    // szum tła w cichym pokoju: szczyt ~0.05, rms ~0.007; mowa z AGC: szczyt > 0.2, rms > 0.02
    if (szczyt < 0.08 || rms < 0.01) { diag("chmura: za cicho, nie wysyłam"); fin({ alts: [], gotFinal: false, error: null, heldMs }); return; }
    n.btn.textContent = "⏳ rozpoznaję…";
    const c = cfg();
    try {
      const wav = wav16k(n.chunks, n.rate);
      const t0 = Date.now();
      const r = await fetch(c.url + "/wymowa", { method: "POST", headers: { "Authorization": "Bearer " + c.klucz, "Content-Type": "audio/wav" }, body: wav });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      diag("whisper: " + JSON.stringify(j.text) + " po " + (Date.now() - t0) + "ms");
      fin({ alts: j.text ? [j.text] : [], gotFinal: true, error: null, heldMs });
    } catch (e) {
      diag("chmura błąd: " + e.message);
      fin({ alts: [], gotFinal: false, error: "Rozpoznawanie w chmurze nie działa: " + e.message, heldMs });
    }
  }

  function bind(btn, opts) {
    btn.textContent = LABEL_IDLE;
    const down = (e) => {
      e.preventDefault(); e.stopPropagation(); try { btn.setPointerCapture(e.pointerId); } catch (err) {}
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

  const W = { diag, supported: !!SR || GUM, beforeStart: null, zapiszStan: null, bind, grade, render, strip, toPinyin, cfg, odbierzWynik, audioAktywne, LABEL_IDLE };
  window.Wymowa = W;
})();
