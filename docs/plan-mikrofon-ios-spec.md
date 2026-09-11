# Spec wdrożenia: mikrofon systemowy na iOS (wynik workflow, pewność: medium)

Uzupełnienie do `plan-mikrofon-ios.md`. Wygenerowane automatycznie 2026-09-11 (18 agentów, źródła WebKit + prior art). Do przejrzenia przed kodowaniem; założenia A1–A5 wymagają testu na telefonie.

## Przyczyna

Two WebKit facts combine on iOS 26 (WebKit without 315887@main, per bug 321436 on iOS 26.6):

(1) The Web Speech microphone is captured in the GPU process on the shared VoiceProcessingIO unit (CoreAudioCaptureUnit::defaultSingleton). Its start is self-sufficient: UserMediaCaptureManagerProxy::SourceProxy::audioUnitWillStart writes PlayAndRecord/VideoChat + setActive:YES directly to the real AVAudioSession, then BaseAudioCaptureUnit::startUnit checks the LIVE category. Nothing in WebContent knows this capture exists (SpeechRecognitionRealtimeMediaSourceManager::Source is not an AudioCaptureSource on iOS 26), and a GPU-side failure (suspend() on '!pri'/'!int', a category flipped underneath a running unit, or attaching to a stale still-running unit left by the previous session's leaked RemoteRealtimeAudioSource, which makes BaseAudioCaptureUnit::continueStartProducingData return at `if (isProducingData()) return;` before startUnit) is never forwarded to the UI-process SFSpeechRecognizer: Source::sourceMutedChanged only updates media-session bookkeeping. JS therefore sees onstart/onaudiostart (both dispatched unconditionally from SpeechRecognizer::start / RealtimeMediaSource::start before any capture) followed by silence and 'aborted'/'No speech detected'.

(2) The <audio> element used for the mp3 is what writes to that same session at exactly the wrong moments: at 'ended' MediaSessionManagerCocoa::sessionWillEndPlayback (presentationType==Audio, isEnded, duration>0.95 s) → maybeDeactivateAudioSession → async [AVAudioSession setActive:NO] on the GPU work queue; releaseAudio()/GC of the throw-away `new Audio()` makes the element non-audible → updateSessionState computes None → 2 s m_delayCategoryChangeTimer → SetCategory(None) → AudioSessionIOS maps None to AVAudioSessionCategoryAmbient; the next play() sends MediaPlayback again. Every one of these is a WebContent→GPU write that lands on the live session either during the next capture or shortly before it (killing a stale unit's input, which is reaped by CoreAudioCaptureUnit::verifyIsCapturing only after a 2–4 s tick). That is why the first session works, a session started shortly after playback is deaf, and one started several seconds later sometimes works. The getUserMedia stream that wymowa.js currently holds BEFORE rec.start() adds its own writes (MediaStreamTrack → audioCaptureSourceStateChanged → SetCategory/TryToSetActive → setPreferredInput:nil right after AudioOutputUnitStart) and is the configuration aide-bot PR #211 logged as deaf 5/5.

Why previous experiments failed: 'play-and-record' permanently pinned the session (mic OK, mp3 rendered in VideoChat mode = quiet); 'auto' afterwards recomputed None → Ambient (silent switch honoured = mp3 silent); delays were confounded with the held gUM stream; new-vs-singleton SpeechRecognition is neutral (WebKit creates fresh SFSpeechRecognizer objects per start()); reload does not restart the GPU process.

Fix principle: (a) no WebContent-originated AVAudioSession write may happen between stopping the mp3 and the end of a recognition; (b) exactly one deliberate write must happen AFTER each recognition to bring the live session back from PlayAndRecord/VideoChat to Playback so mp3s stay loud; (c) no gUM before start().

## Spec

## 0. Design in one paragraph

mp3 playback moves from `<audio>` to Web Audio (one AudioContext per page, never closed) — this removes every playback-driven session write (no 'ended' deactivation: AudioContext is MediaType::WebAudio; no GC/None flips: the context lives for the page; updateSessionState becomes constant so RemoteAudioSession::setCategory dedupes). Loudness is kept by a permanent DOM override `navigator.audioSession.type = 'playback'` (WebContent requests AVAudioSessionCategoryPlayback: media volume, speaker, ignores the ring/silent switch) plus, after EVERY recognition end, a two-step flip `'ambient'` → `'playback'` (two different values → two SetCategory IPCs → RemoteAudioSessionProxyManager::updateCategory → AudioSessionIOS::setCategory rewrites the live session from the GPU's PlayAndRecord/VideoChat back to Playback). The flip is never issued while a session is live and is followed by a configurable gap (default 4500 ms, `kubus.wymowa.odstep`) before the next rec.start(), long enough for a stale VPIO unit to lose input under Playback and be reaped by verifyIsCapturing (2 s interval, worst case ~4 s). No getUserMedia in the system engine. rec.start() is issued from the pointerdown task with no async prefix except the (usually zero) gap. Hold-to-talk + live interim results unchanged. All app-audit HIGH/MEDIUM findings fixed.

Stated assumptions (not verifiable from WebKit source alone):
- A1 `navigator.audioSession.type` works in Chrome iOS on this device (evidence: the user's earlier 'play-and-record'/'auto' experiments changed playback behaviour, so DOMAudioSession is active; top-level document has the 'microphone' permissions-policy by default).
- A2 Web Audio output under the 'playback' override plays at normal media volume through the speaker (AVAudioSessionCategoryPlayback is the same category today's `<audio>` uses; the output unit differs: RemoteIO instead of AVPlayer). Verified by device test step 2.
- A3 The 'ambient'→'playback' flip really re-applies Playback on the live session after the GPU's direct PlayAndRecord write (from source: RemoteAudioSession dedups only against its own last-requested value; AudioSessionIOS compares against live state). Verified by device test step 5.
- A4 A stale VPIO unit stops receiving input under Playback and is reaped within ≤4 s (consistent with today's 'works after several seconds'). The gap default covers it; test step 6 decides whether the gap can be 0.
- A5 Chrome's UI process does not touch AVAudioSession around SFSpeechRecognizer (unverifiable; if all else is confirmed and the mic still fails only in Chrome, test Safari).

## 1. Event ordering (what happens, in order)

Page load: wymowa.js runs → `navigator.audioSession.type = 'playback'` (one SetCategory(MediaPlayback) IPC; WebContent cache was None) → diag logs the read-back value. No AudioContext yet.

First user gesture anywhere (document-level capture listeners on pointerup/touchend/click/keydown): `kontekst()` creates the AudioContext and resume()s it → WebContent PlatformMediaSession WebAudio goes Playing → tryToSetActive(true) + SetPreferredBufferSize(128) IPCs. From now on the session is active and no deactivation path can run (all maybeDeactivateAudioSession callers are guarded by anyOfSessions(Playing)/hasNoSession on the iOS-26 code).

Card tap → `Wymowa.graj(url)`: stopAudio(); fetch → decodeAudioData (cached per URL) → AudioBufferSourceNode → destination. Category: Playback (override). Loud. No session write.

Mic pointerdown (system engine), synchronous part: guard duplicate press → create session object `s` + 30 s hardLimit → `kontekst()` → `stopAudio()` (AudioBufferSourceNode.stop(): no PlatformMediaSession side effect, no promise rejection) → page `beforeStart` (UI only) → speechSynthesis.cancel() → opts.onStart(). Async part: wait only if needed: `max(odstep - sinceLastFlip, 3500 - sinceLastTTS, 700 - sinceContextCreationIfJustCreated)`; label '⏳ chwila… N'; the loop re-checks `session === s` and `s.released` every 200 ms. Then if the context is not 'running', wait ≤500 ms for statechange. Then speechSynthesis.cancel() again, `new SpeechRecognition()` (fresh per session, handlers close over `s` and are guarded by `session === s`), `rec.start()`. Arm noStart (5 s, forceFinish) and watchdog (15 s, stopNow).

GPU side, in IPC order: nothing pending from WebContent (last writes were the flip ≥ odstep ago, or the context activation ≥700 ms ago) → CreateMediaSource → StartProducingData → audioUnitWillStart writes PlayAndRecord/VideoChat + active → startUnit live-category check passes → AudioOutputUnitStart. This is the same path as the working first session.

onstart → faza 'listening', label '🎙 mów teraz…', startedAt; if already released → stopNow. onresult → interim/final alts → onInterim (live). Pointerup → stopListening → stopNow: rec.stop(), label '⏳ przetwarzam…', endGuard 2.5 s → abort() → +1.5 s forceFinish. onend → finish(s): clear timers, compute result, **przywrocPlayback('koniec nasłuchu')** = `type='ambient'; type='playback'` + `ostatniKoniecSR = now`, then onDone. Live session: Playback again → the next mp3 is loud. Every termination path (onend, exception in start(), released before start, forceFinish, visibility hidden) goes through finish() so the flip always happens.

Cloud engine: same shared AudioContext (never closed), stopAudio() before start, flip after cleanup. No gap enforced (its gUM source end()s cleanly).

Visibility: hidden → forceFinish/stop recording/stopAudio; visible again → kontekst() + flip (re-asserts Playback after whatever the system did; also starts the gap). pageshow(persisted) → reset module state + flip.

## 2. wymowa.js — full replacement of the audio/session/state-machine parts

Keep unchanged: strip/toPinyin/similarity/grade/render (with the LOW-14 tweak), diag(), przeladuj/odbierzWynik (raise 15000→60000), wav16k, LABEL_IDLE. Replace the header comment, cfg(), the whole state machine (lines 97–262), the chmura AudioContext handling, bind() and the export.

```js
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
//
// Użycie:
//   Wymowa.beforeStart = () => { /* tylko UI, audio zatrzymuje moduł */ };
//   Wymowa.bind(btn, { target: () => "朋友", onStart(), onInterim(text), onDone(result) });
//   Wymowa.graj(url, { onEnd(przerwane) }) -> Promise<bool>;  Wymowa.stopAudio();  Wymowa.preload(url)
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  // ... strip, toPinyin, toPinyinNoTone, diag(), IOS_VER, GUM, AC — bez zmian ...
  const AS = ("audioSession" in navigator) ? navigator.audioSession : null;
  const ODSTEP_PO_SR = 4500;     // domyślny odstęp po końcu nasłuchu (patrz A4)
  const ODSTEP_PO_TTS = 3500;    // tylko po speechSynthesis (głos systemowy)
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // parametry testowe z URL -> localStorage
  (function () { try { const q = new URLSearchParams(location.search); for (const [p, k] of [["odstep", "kubus.wymowa.odstep"], ["sesja", "kubus.wymowa.sesja"], ["silnik", "kubus.wymowa.silnik"]]) if (q.has(p)) localStorage.setItem(k, q.get(p)); } catch (e) {} })();

  function cfg() {
    const ls = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    let sync = {}; try { sync = JSON.parse(ls("kubus.powtorka.sync") || "{}"); } catch (e) {}
    const silnik = ls("kubus.wymowa.silnik") || "auto";
    const url = (sync.url || window.SYNC_URL || "").replace(/\/$/, ""), klucz = sync.klucz || "";
    const chmuraOk = !!(url && klucz && GUM && AC);
    const uzyj = silnik === "system" ? "system" : silnik === "system-reload" ? "system-reload" : silnik === "chmura" ? (chmuraOk ? "chmura" : "system") : (chmuraOk ? "chmura" : "system");
    const o = ls("kubus.wymowa.odstep");
    const odstep = (o === null || o === "" || isNaN(Number(o))) ? ODSTEP_PO_SR : Math.max(0, Number(o));
    return { url, klucz, silnik, uzyj, chmuraOk, reload: uzyj === "system-reload", odstep, sesjaAudio: ls("kubus.wymowa.sesja") !== "0" };
  }
  diag("UA: " + navigator.userAgent);
  diag("iOS: " + (IOS_VER || "nie") + ", SpeechRecognition: " + (SR ? "jest" : "BRAK") + ", getUserMedia: " + (GUM ? "jest" : "BRAK") + ", AudioContext: " + (AC ? "jest" : "BRAK") + ", audioSession: " + (AS ? "jest (" + AS.type + ")" : "BRAK"));
  diag("silnik: " + cfg().uzyj + ", odstęp po nasłuchu " + cfg().odstep + " ms, sterowanie sesją audio: " + (cfg().sesjaAudio ? "tak" : "NIE"));

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
    diag("kategoria audio przywrócona: playback (" + powod + ")");
  }
  ustawSesje("playback");

  // ---- Web Audio: odtwarzanie mp3 ----
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
    if (cfg().reload && s.startedAt) przeladuj(s.opts, res);
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
    if (czekaj > 0) diag("czekam " + czekaj + " ms (po nasłuchu " + (Date.now() - ostatniKoniecSR) + " ms, po TTS " + (Date.now() - ostatnieAudio) + " ms)");
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
    r.onsoundstart = () => diag("onsoundstart"); r.onspeechstart = () => diag("onspeechstart"); r.onspeechend = () => diag("onspeechend"); r.onnomatch = () => diag("onnomatch");
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

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (session) forceFinish(session, "strona ukryta"); if (nagranie) chmuraStop(nagranie, true); stopAudio(); }
    else { kontekst(); przywrocPlayback("powrót na stronę"); }
  });
  window.addEventListener("pageshow", (e) => { if (e.persisted) { session = null; nagranie = null; zrodlo = null; kontekst(); przywrocPlayback("bfcache"); } });

  // ---- silnik "chmura": zmiany ----
  // chmuraStart: przed W.beforeStart dodać stopAudio(); zamiast `n.ctx = new AC(); ...resume` -> `n.ctx = kontekst(); if (!n.ctx) throw new Error("brak AudioContext");`
  //   po getUserMedia, gdy nagranie !== n: tylko `n.stream.getTracks().forEach(t => t.stop())` (BEZ ctx.close()); zapamiętać `n.src = src` po createMediaStreamSource.
  // chmuraSprzataj(n): clearTimeout; try { if (n.proc) { n.proc.disconnect(); n.proc.onaudioprocess = null; } } catch; try { if (n.src) n.src.disconnect(); } catch;
  //   try { if (n.stream) n.stream.getTracks().forEach(t => t.stop()); } catch;  // USUNĄĆ n.ctx.close()
  //   diag("mikrofon zwolniony"); przywrocPlayback("koniec nagrania (chmura)");
  // reszta chmuraStart/chmuraStop bez zmian.

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
    btn.addEventListener("pointerdown", down); btn.addEventListener("pointerup", up); btn.addEventListener("pointercancel", up);
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  const W = { diag, supported: !!SR || GUM, iOS: !!IOS_VER, beforeStart: null, zapiszStan: null, bind, grade, render, strip, toPinyin, cfg, odbierzWynik,
              audioAktywne, graj, stopAudio, preload: dekoduj, kontekst, przywrocPlayback, LABEL_IDLE };
  window.Wymowa = W;
})();
```

render(): in the `g.level === "none"` branch add first: `if (result.started === false) html = "Puściłeś przycisk, zanim nasłuch się uruchomił. Przytrzymaj, poczekaj na „mów teraz”, powiedz słowo, dopiero wtedy puść."` (LOW-14). odbierzWynik(): `Date.now() - w.ts > 60000` (LOW-15).

## 3. template.html (lesson page)

Replace lines 90–97 and 119–141, and line 171:
```js
let current = null;                       // (usunięte: audio, lastAudioPlay, releaseAudio — mp3 gra wymowa.js przez Web Audio)
function setPlaying(card) { if (current) current.classList.remove("playing"); current = card; if (card) card.classList.add("playing"); }
function speakSystem(text) { /* bez zmian: cancel(); Wymowa.audioAktywne(); ... u.onend = () => { setPlaying(null); Wymowa.audioAktywne(); }; speak(u) */ }
const AUDIO = {};
let nrOdtworzenia = 0;
function speakGoogle(text, card) {
  const f = AUDIO[text];
  if (!f) { status.textContent = "Brak nagrania dla tej pozycji — głos systemowy."; speakSystem(text); return; } // translate_tts jest cross-origin, fetch nie przejdzie
  const moje = ++nrOdtworzenia;
  Wymowa.graj("audio/" + f + (slowCb.checked ? "-slow" : "") + ".mp3", { onEnd: () => { if (moje === nrOdtworzenia) setPlaying(null); } })
    .then(ok => { if (!ok && moje === nrOdtworzenia) setPlaying(null); })
    .catch(e => { if (moje !== nrOdtworzenia) return; Wymowa.diag("mp3 błąd: " + e.message); status.textContent = "Nagranie niedostępne — używam głosu systemowego."; speakSystem(text); });
}
function play(text, card) { status.textContent = ""; setPlaying(card); if (engineSel.value === "google") speakGoogle(text, card); else speakSystem(text); }
// ...
Wymowa.beforeStart = () => setPlaying(null);   // audio zatrzymuje sam moduł (stopAudio) przed start()
```
render(), bindMic, reload-restore block: unchanged. Hint text at line 74: replace "poczekaj na „mów teraz”" wording is still valid; optionally add "po odsłuchu możesz nagrywać od razu".

## 4. powtorka.html

Replace lines 245–256:
```js
// ---------- audio (Web Audio przez wymowa.js; bez <audio>) ----------
function graj(k, wolno) {
  if (!k.audio) return;
  Wymowa.graj("../" + k.audio + (wolno ? "-slow" : "") + ".mp3").catch(e => Wymowa.diag("mp3 błąd: " + e.message));
}
```
Delete `let audio`, `releaseAudio`, `Wymowa.beforeStart = releaseAudio`. In nastepna(): `releaseAudio()` → `Wymowa.stopAudio()`; at the end of nastepna add `if (kolejka[0] && kolejka[0].k.audio) Wymowa.preload("../" + kolejka[0].k.audio + ".mp3").catch(() => {});`. LOW-12 in odtworzPoPrzeladowaniu: resolve `biezaca = zId(st.biezaca)` and `return false` BEFORE assigning `wSesji = true`/kolejka/zrobione/razem. All graj() calls stay inside click handlers (gestures); kartaB auto-play after the rating click is inside that gesture, so the context is running.

## 5. build.py / deploy
No change. Run `python3 build.py --no-audio` (WERSJA = md5 of wymowa.js changes → cache-bust), commit, push; GitHub Pages serves index.html with max-age=600, so wait or hard-reload before testing. Ship the audit state-machine fixes in the same commit (they are inseparable from the new startListening), but keep the speechSynthesis/reload code intact so `?silnik=system-reload` and the cloud engine remain as fallbacks.

## 6. UX consequences (state them to the user)
- No more 3.5 s "po odsłuchu" countdown after an mp3; the mic starts immediately after playback. A "⏳ chwila… N" countdown appears only when the mic is pressed within `odstep` (4.5 s) of the previous recognition end, or within 3.5 s of the system voice.
- mp3 ignores the ring/silent switch (Playback), as today.
- Background audio from other apps stays interrupted while a lesson page is open (persistent active session); today it resumed after each mp3.
- First play of each word pays fetch+decode (~100–300 ms); cached afterwards (≤30 buffers, ~10 MB).

## Do usunięcia

- wymowa.js: getUserMedia in the system engine (lines 222-228), `micStream`, `releaseMic()` and all its calls — a stream held before rec.start() is the deaf configuration (aide-bot #211) and MediaStreamTrack start/stop writes to the AVAudioSession
- wymowa.js: the `pending` queue (lines 101, 150, 194-201) and the `state` module variable/singleton `getRec()` (lines 97-153) — replaced by a per-session object with a fresh SpeechRecognition instance and `session === s` guards
- wymowa.js: the post-mp3 3.5 s countdown as a general rule (ODSTEP_PO_AUDIO applied to mp3); keep it only for speechSynthesis (renamed ODSTEP_PO_TTS)
- wymowa.js: `n.ctx = new AC()` and `n.ctx.close()` in the cloud engine — use the shared never-closed AudioContext
- wymowa.js: header comment claiming a held getUserMedia stream 'wymusza kategorię play-and-record' — it is the opposite of what is needed
- wymowa.js: the 3 s + 3 s endGuard (use 2.5 s + 1.5 s) and the watchdog that called stopListening() in state 'starting' (no-op dead end)
- template.html: `let audio`, `lastAudioPlay`, `releaseAudio()`, `new Audio(url)`, `audio.onended/onerror`, `audio.play().catch(...)` fallback (AbortError → speechSynthesis during the mic session), `Wymowa.beforeStart = releaseAudio`
- template.html: fetching the cross-origin translate_tts URL as an mp3 (cannot be read by fetch/Web Audio; go straight to speakSystem when no local file exists)
- powtorka.html: `let audio`, `releaseAudio()`, `new Audio(...)`, `Wymowa.beforeStart = releaseAudio`; `releaseAudio()` in nastepna() → `Wymowa.stopAudio()`
- Any write of `navigator.audioSession.type` other than the load-time 'playback' and the post-session 'ambient'→'playback' flip; in particular never 'play-and-record' (VideoChat mode = quiet mp3) and never a write between stopAudio() and the end of a recognition
- Any page reload as a mic workaround by default (keep 'system-reload' only as an opt-in fallback)
- Any delay/retry keyed on mp3 playback end (the countdown after mp3) — the design removes the cause instead

## Plan testu na telefonie

1. Build (`python3 build.py --no-audio`), push, open a lesson page in Chrome iOS after the Pages cache expires (or append ?v=… to bypass). Open 'diagnostyka mikrofonu'. Expect at load: `audioSession: jest (…)` and `audioSession := playback` WITHOUT an '(odczyt: …)' suffix. If the suffix shows a different value or 'BRAK', assumption A1 fails → report and stop (see fallback).
2. Ringer ON. Tap a card. Expect diag `AudioContext utworzony: running` then `gram <file> … sesja playback`, and the mp3 as loud through the speaker as on the old build. Then flip the ring/silent switch to SILENT and tap another card: still audible (Playback ignores the switch). If quiet/silent here → A2 fails.
3. Core case, 5 repetitions: tap a card, wait for the mp3 to finish, hold the mic within 1 s. Expect `onstart`, `onspeechstart`, live 'słyszę: …' interim text while holding, a final result on release, `onend`, then `audioSession := ambient`, `audioSession := playback`, `kategoria audio przywrócona`. A failure looks like: onstart/onaudiostart, no onspeechstart, 'error aborted … No speech detected' or 'Nic nie usłyszałem'.
4. Tap a card and hold the mic DURING playback (mp3 still sounding). Expect `audio zatrzymane` immediately, then the same success pattern as step 3.
5. Loudness after mic use (the regression the earlier experiments hit): right after step 3's result, tap a card. Expect the mp3 at the SAME loudness as step 2, from the speaker, normal pitch/speed. Repeat after 3 recognitions. If it is quiet, earpiece-routed, or pitched → A3 fails (see fallback). Also press volume-up during that mp3 and note whether the slider is the media slider (normal) or a call/ringer slider (means VideoChat mode persisted).
6. Gap calibration: hold the mic again ~1 s after a result. With the default 4500 ms expect '⏳ chwila… N' countdown then a normal session. Then open the page with `?odstep=0` (stores kubus.wymowa.odstep=0) and repeat mic→mic within ~1 s five times. If all five work → set the code default ODSTEP_PO_SR to 0 (A4's teardown is not needed). If any fails with the step-3 failure pattern → keep 4500 (try `?odstep=2500` to find the minimum).
7. powtorka: Start → card B auto-plays (loud), answer, reveal → hold mic → results; rate → next card auto-plays loud and immediately (preload). Card A: hint → mp3 → mic within 1 s → results.
8. Interruptions: lock the screen for 10 s, unlock, return to the page. Expect `AudioContext: …` state lines and `kategoria audio przywrócona (powrót na stronę)`. Tap a card (loud), hold the mic (countdown may appear, then results). Repeat with an incoming call/Siri if possible.
9. A/B without session control: open the page with `?sesja=0`. Expect: with the switch on silent the mp3 is inaudible before the first mic use, and quieter after it — this demonstrates that the override/flip is the loudness lever. Restore with `?sesja=1`.
10. If any mic failure remains: connect the iPhone by USB, Console.app on the Mac, filter process com.apple.WebKit.GPU (and com.apple.WebKit.WebContent), reproduce, and capture lines containing: 'BaseAudioCaptureUnit::startProducingData failed due to not high enough priority', 'startUnit cannot call startInternal if category is not set to PlayAndRecord', 'BaseAudioCaptureUnit::suspend', 'AudioOutputUnitStart failed', 'Audio session should be active', 'setting category =', 'verifyIsCapturing', 'captureFailed', 'failed to activate audio session'. Paste them with the page's diag log.
11. Sanity on desktop Chrome/Safari (no audioSession API): mp3 plays, mic works, no '(odczyt)' lines, no exceptions.

## Jeśli test padnie

Branch by which test step fails.

Step 1 fails (navigator.audioSession absent/no-op in this Chrome build): loudness cannot be controlled from JS. Keep Web Audio + gap for the mic and switch the player to a single persistent `<audio>` element that is never unloaded (keep the JS reference, no removeAttribute/load) — it holds MediaPlayback while alive — and pause() it ~100 ms before its natural end so isEnded() is false and the 'ended' deactivation never fires; the persistent running AudioContext (silent) stays as the Playing pin. Expect the post-mic quietness to persist until the element's category is re-sent (toggle `el.muted = true` then `false` across two run-loop turns after each recognition → two updateSessionState results → two IPCs), never during a session.

Step 2 fails (Web Audio under 'playback' is not loud): same persistent-`<audio>` variant as above but keeping the 'playback' override; the override blocks the None flips, the AudioContext pin blocks the 'ended' deactivation.

Step 3 fails (mic still deaf after mp3 with no WebContent writes in the diag log): the remaining candidates are GPU-internal (stale unit not reaped, '!pri' at AudioOutputUnitStart) or host-app (Chrome UI process). Do step 10 (GPU logs). Try `?odstep=8000` (if it works, verifyIsCapturing reaping is slower than assumed; keep the larger gap). Try the same build in Safari on the phone: if Safari works, the cause is Chrome's own AVAudioSession use (A5) and only Safari/home-screen PWA can be supported with the system recognizer. If neither works, the system recognizer is not reliably usable on iOS 26 and the shipped fallbacks remain: `?silnik=system-reload` (first-session-after-load path, now with Web Audio) or the cloud engine.

Step 5 fails (mp3 quiet after mic use): the flip did not reach the live session. Variant 1: `type='auto'`, then after `setTimeout(300)` `type='playback'` ('auto' triggers a scheduled recompute → AmbientSound IPC; the later 'playback' → MediaPlayback IPC), still only in finish(). Variant 2: insert a 50 ms setTimeout between 'ambient' and 'playback'. Variant 3: additionally flip right before each graj() (safe: no session is live then; it only extends the gap start). If none restores loudness, the session is receiver-routed rather than VideoChat-attenuated; last resort is accepting the reduced level with a GainNode (limiter at −3 dB) — the user rejected this before, so report instead.

Step 6 fails at every gap (mic→mic never works twice in a row): the GPU stale-unit early return dominates and cannot be forced from JS; report with GPU logs, keep cloud/system-reload.

Independent of the above, the app-audit fixes (no dead 'starting' state, per-session guards, no pending queue, no AbortError→TTS fallback) stand on their own and should be kept.

## Audyt naszego kodu (pełny)

Audit of wymowa.js, template.html, powtorka.html, build.py (all read fully; built pages verified to reference the current wymowa.js hash b2672653 and SYNC_URL). Four HIGH findings in our own code can make the hold-to-talk button look dead or a session never end, independent of any WebKit behaviour: (1) the 15 s watchdog is a no-op while state==="starting" (rec.start() called, onstart never arrives) -> permanent non-idle state, every later press only queues `pending` and never changes the label; (2) the onstart-with-released path (wymowa.js:117) sets state="stopping" and calls abort() with NO endGuard -> permanent "stopping" if onend does not follow; (3) after the 3s+3s force-finish sets `rec = null`, the old instance's handlers stay bound to module globals and a late onend from it sets state idle, kills the new getUserMedia stream, finishes the NEW session prematurely and leaves an orphan recognizer whose next start() throws InvalidStateError ("Nie mogę uruchomić"); (4) template.html:134 `audio.play().catch(() => speakSystem(text))` fires whenever Wymowa.beforeStart -> releaseAudio() pauses an mp3 whose play() promise is still pending (user taps card then holds mic before playback actually started), so Apple speechSynthesis starts speaking the Chinese word during the countdown/mic session, the status line shows "Nagranie niedostępne — używam głosu systemowego", and ostatnieAudio is reset without extending the already-computed 3.5 s wait. MEDIUM: the `pending` queue is never cancelled on pointerup, not drained on the release-during-countdown path, and any second pointerdown (multi-touch, other mic button, press-after-pointercancel) stops the live session and later spawns a ghost session with no finger down (15 s of "mów teraz…", then "Nic nie usłyszałem"); the 3.5 s wait is computed once and the countdown label reads live `ostatnieAudio` so label and real wait diverge; no timeout around getUserMedia in "starting"; rec.start() is called even when already released; weak identity check at :228 (`session.btn !== btn` vs `session !== s`); speakGoogle:121 bypasses releaseAudio leaving old onerror/onended attached; speechSynthesis.cancel() happens before the wait, not at rec.start(); no visibilitychange/pagehide/bfcache reset. Concrete fixes given per finding (forceFinish helper used by watchdog/endGuard/onstart-abort, per-instance guard in handlers, drop `pending`, isPrimary/duplicate-press guard, loop-recompute wait, detach media handlers + AbortError-aware play().catch, race getUserMedia with a timeout). Cloud path (chmuraStart/chmuraStop) reviewed: state machine is self-healing (porzuc on re-press), no dead-button holes found there.

INVENTORY (file:line — trigger — effect)

wymowa.js
- :53-56 module init — diag lines only; :55 reads navigator.audioSession.type (read only, never written).
- :104-106 releaseMic() — called from onend(:147), start() exception(:233), :228 abort path, force-finish(:258) — stops getUserMedia tracks, micStream=null.
- :108-153 getRec() — lazily creates the singleton SpeechRecognition (lang zh-CN, interimResults, maxAlternatives 5, continuous=true) and binds handlers that close over MODULE globals (state/session/pending), not the instance:
  - :112-118 onstart -> state="listening", session.startedAt=now, label "🎙 mów teraz…"; if session.released -> state="stopping", rec.abort()  [no endGuard armed here].
  - :124-134 onresult -> collects alts, onInterim.
  - :135-143 onerror -> ignores "aborted"/"no-speech"; else sets session.error text.
  - :144-151 onend -> state="idle", releaseMic(), finish(session), and if pending -> setTimeout(startListening(p.btn,p.opts),300).
- :155-164 finish(s) — clears watchdog/endGuard, removes .rec, label=LABEL_IDLE, onDone(res); if cfg().reload && s.startedAt -> przeladuj().
- :168-176 przeladuj() — sessionStorage save (+zapiszStan, +last 40 diag lines), location.reload() after 150 ms.
- :178-184 odbierzWynik() — restore only if same href and < 15 s old.
- :188-190 audioAktywne() — ostatnieAudio=Date.now(); ODSTEP_PO_AUDIO=3500.
- :192-239 startListening(btn,opts) [async, promise ignored by caller]:
  :194-201 if state!=="idle" -> pending={btn,opts}; if listening -> stopListening(); if starting -> session.released=true; return (label NOT touched).
  :202 state="starting"; :203 W.beforeStart() (= page releaseAudio); :204 speechSynthesis.cancel(); :206 session created; :208 label "⏳ uruchamiam…";
  :209-219 czekaj = 3500-(now-ostatnieAudio) computed ONCE; tik interval rewrites label from live ostatnieAudio; await czekaj; if session!==s return; if s.released -> state idle, session=null, finish(s) (pending NOT drained); label "⏳ uruchamiam…".
  :220 opts.onStart() (not try/caught); :224-227 if !cfg().reload -> await getUserMedia({audio:true}) (no timeout); :228 if session===null||session.btn!==btn -> releaseMic(); return (state left as-is);
  :229-236 r.start(); on exception -> state idle, finish with error; :238 watchdog 15 s -> stopListening() (only armed after start()).
- :241-262 stopListening() — session.released=true; if state==="starting" return; if state!=="listening" return; state="stopping"; label "⏳ przetwarzam…"; rec.stop(); endGuard 3 s -> abort(); +3 s -> force-finish: state idle, releaseMic, session=null, rec=null, finish(s).
- :288-323 chmuraStart / :333-365 chmuraStop — cloud path; re-press aborts previous recording (porzuc), self-healing.
- :367-383 bind(btn) — pointerdown: preventDefault, setPointerCapture, cfg().uzyj==="chmura" ? chmuraStart : startListening (no isPrimary/button/duplicate-press guard); pointerup & pointercancel: chmuraStop or (session.btn===btn) stopListening (pending never cleared); click/contextmenu preventDefault. CSS on .mic (template:43-45, powtorka:42-44): touch-action:none, user-select:none, touch-callout:none.

template.html (lesson page)
- :93-97 releaseAudio() — if playing -> Wymowa.audioAktywne(); audio.pause(); removeAttribute("src"); load(); audio=null (onended/onerror handlers left attached; .playing class not cleared).
- :105-117 speakSystem(text) — speechSynthesis.cancel(); audioAktywne(); speak(u); u.onend -> setPlaying(null), audioAktywne().
- :120-135 speakGoogle(text) — :121 if(audio){pause(); audio=null} (bypasses releaseAudio); new Audio(url); :127 lastAudioPlay (dead var); :128 audioAktywne(); :129 onended -> setPlaying(null), audioAktywne(), releaseAudio(); :130-133 onerror -> status + speakSystem(text); :134 play().catch(() -> status + speakSystem(text)).
- :137-141 play() <- :160 card click (ignores .mic/.result targets).
- :168 speechSynthesis.getVoices() warm-up.
- :171 Wymowa.beforeStart = releaseAudio.
- :173-183 reload-mode restore (result into matching card, scrollTo).
- :184-192 bindMic -> Wymowa.bind (onStart hides .result, onInterim, onDone render).

powtorka.html
- :246-247 releaseAudio() — same as template (same handler-left-attached issue). :248 Wymowa.beforeStart = releaseAudio.
- :249-256 graj(k,wolno) — releaseAudio(); new Audio("../"+k.audio[-slow].mp3); audioAktywne(); onended -> audioAktywne(), releaseAudio(); play().catch -> diag only.
- :263 nastepna() — releaseAudio() and card.innerHTML="" (detaches any active mic button).
- :297-298 odslon() "🔊 posłuchaj"/"🐢 wolniej" -> graj. :303-308 odslon() mic -> Wymowa.bind.
- :341 kartaA hint level 2 -> graj(k); :361-366 kartaA mic -> Wymowa.bind; :368 pokaz(true) -> graj(k).
- :387 kartaB 🔊 -> graj(k); :448 kartaB auto-play graj(k) on a fresh card (not on reload restore).
- :272-274 Wymowa.zapiszStan; :275-287 odtworzPoPrzeladowaniu (sets wSesji=true at :281 before it can still return false at :282).
- :505-506 startup: odtworzPoPrzeladowaniu() || ekranStartowy(); syncTeraz(true).then(...).

build.py — :13 WERSJA=md5(wymowa.js)[:8] for cache-busting; :15 SYNC_URL from sync.url; :44/:69 substitutes {{TYTUL}},{{DATA_JSON}},{{WERSJA}},{{SYNC_URL}},{{KARTY_JSON}}. Built pages currently match (v=b2672653). No audio/mic logic. Only caveat: GitHub Pages serves index.html with max-age=600, so a freshly deployed page pair can be served stale for up to 10 min (old html + old js, consistent).

FINDINGS (severity, causal chain, fix)

[HIGH-1] Watchdog is a no-op in state "starting" — wymowa.js:238 + :244.
Chain: r.start() succeeds (:230) -> state stays "starting" until onstart. If onstart never fires (and no onerror/onend), the only safety net is watchdog -> stopListening() -> `if (state === "starting") return` (:244). Nothing else ever changes state. Every later pointerdown hits :194 (state!=="idle") -> sets pending, session.released=true, returns WITHOUT touching the label. Result: label frozen on "⏳ uruchamiam…", button dead until reload. Same hole if user releases early (:244 returns) and onstart never comes.
Fix: add `function forceFinish(s, why){ if (session!==s) return; diag("kończę na siłę: "+why); try{ rec && rec.abort(); }catch(e){} state="idle"; releaseMic(); session=null; rec=null; finish(s); }` and arm a hard limit at session creation (:206) `s.hardLimit=setTimeout(()=>forceFinish(s,"limit"),20000)` that covers wait+getUserMedia+start+listen; make the watchdog call `state==="listening" ? stopListening() : forceFinish(s,"watchdog w stanie "+state)`; clear hardLimit in finish().

[HIGH-2] onstart-with-released abort has no endGuard — wymowa.js:117.
Chain: user releases during the countdown/getUserMedia (:244 "czekam na onstart") -> onstart -> state="stopping"; rec.abort(). No endGuard is armed (only stopListening arms one, :251). If onend does not follow, state is "stopping" forever; watchdog (:238) -> stopListening -> `state !== "listening"` return (:245). Label frozen on "🎙 mów teraz…" (set at :116 just before). All later presses -> :194 -> pending only.
Fix: factor the guard out of stopListening into `armEndGuard(s)` and call it at :117; better, do not start at all when already released: before :230 add `if (s.released) { diag("puszczony przed start(), nie uruchamiam"); state="idle"; session=null; releaseMic(); finish(s); return; }`.

[HIGH-3] Stale singleton handlers after force-finish clobber the next session — wymowa.js:144-151, :258.
Chain: endGuard force path sets `rec = null` (:258) but the old instance keeps onend/onerror/onstart/onresult bound to module globals. Next press -> getRec() creates rec2, session2. When rec1 finally emits onend: state="idle" (while session2 is starting/listening), releaseMic() stops session2's getUserMedia stream, `finish(session2)` fires onDone with alts [] ("Nic nie usłyszałem"/"Za krótko") while the finger is still down, session=null. rec2 keeps running with no owner and no watchdog; the user's pointerup finds `session===null` and does nothing; the next start() on rec2 throws InvalidStateError -> "Nie mogę uruchomić: …" until rec2 ends by itself. Also old onstart would overwrite label/startedAt of session2.
Fix: in getRec() capture `const r = rec` and guard every handler with `if (r !== rec) { diag("zdarzenie starej instancji, ignoruję"); return; }`; additionally tie the session to the instance (`session.rec = r`) and check `session && session.rec === r`.

[HIGH-4] play()-promise rejection fallback starts speechSynthesis during the mic session — template.html:134 (and :130-133), triggered by :93-97 via wymowa.js:203.
Chain: card tap -> speakGoogle -> `audio.play()` (paused=false immediately, promise pending until playback starts: mp3 fetch on cellular 0.3–2 s). User holds mic inside that window -> startListening -> :203 beforeStart=releaseAudio -> audio.pause() (+ load()) -> per HTML media element spec the pending play promise is rejected with AbortError -> microtask runs after startListening's sync part (i.e. after :204 speechSynthesis.cancel() and after czekaj was computed at :209) -> `.catch` sets status "Nagranie niedostępne — używam głosu systemowego." and calls speakSystem(text) -> speechSynthesis.cancel(); Wymowa.audioAktywne(); speechSynthesis.speak(u) -> Apple TTS speaks the target word during the countdown; u.onend -> audioAktywne() again. The countdown label (:212) now shows a larger number but the real wait (:214) is not extended, so rec.start() runs ~2 s after the TTS ended, possibly while it is still speaking for longer utterances, and no speechSynthesis.cancel() is issued after the wait. The same fallback runs in chmura mode (beforeStart is shared). speakGoogle:121 has the same class of problem: the old element is paused without detaching onerror, so a late network error on an abandoned element also calls speakSystem(oldText).
Fix (template.html): `function releaseAudio(){ const a=audio; if(!a) return; audio=null; a.onended=a.onerror=null; try{ if(!a.paused&&!a.ended) Wymowa.audioAktywne(); a.pause(); a.removeAttribute("src"); a.load(); }catch(e){} }`; in speakGoogle replace :121 with `releaseAudio();`, keep `const a = audio = new Audio(url)` and `a.play().catch(e => { if (audio !== a || e.name === "AbortError") return; status.textContent=…; speakSystem(text); })`; same guard in onerror (`if (audio !== a) return`). In wymowa.js move/duplicate `speechSynthesis.cancel()` to right before r.start() (:229) and mark `if (speechSynthesis.speaking) audioAktywne()` before cancel.

[MEDIUM-5] `pending` queue creates ghost sessions and eats presses — wymowa.js:194-200, :150, :217, :373-377.
Chain A: press mic while previous session is "stopping" (label "⏳ przetwarzam…" for up to 6 s) -> pending set; user releases before onend -> up(): `session.btn===btn` -> stopListening (no-op, state stopping) — pending NOT cleared; onend -> +300 ms -> startListening(pending) with nobody holding -> "⏳ uruchamiam…" -> "🎙 mów teraz…" for 15 s -> watchdog -> "Nic nie usłyszałem". Any press during that ghost's stop phase spawns the next ghost. Chain B: press during countdown (state starting, e.g. after iOS pointercancel) -> :199 released=true + pending; countdown ends -> :217 finish (pending NOT drained) -> stale pending survives until some later session's onend and then spawns a ghost. Chain C: pressing mic B while mic A is live stops A and queues B; B's own pointerup is ignored (session.btn is A).
Fix: delete `pending` altogether: in :194 branch just `diag(...); return;` (optionally if state==="listening" && session.btn===btn ignore). If a queue is kept: clear it in up() (`if (pending && pending.btn===btn) pending=null`), drain it at :217, and mark the drained session `released` immediately unless a pointer is still down (track `pointerDown` flag per button).

[MEDIUM-6] No guard for non-primary pointers / duplicate pointerdown — wymowa.js:369.
Chain: second finger or second pointer on the same button -> startListening -> :194 -> stops the live session and queues a ghost (see 5).
Fix: `if (!e.isPrimary || e.button > 0) return; if ((session && session.btn===btn) || (nagranie && nagranie.btn===btn)) return;` at the top of down().

[MEDIUM-7] 3.5 s wait computed once, label reads live value — wymowa.js:209-219.
Chain: any audioAktywne() during the wait (fallback TTS from HIGH-4, u.onend, another card tap, kartaB auto-play in powtorka after nastepna) is reflected in the label but not in the actual wait; user sees "po odsłuchu… 3" while the mic starts.
Fix: `let czekaj; while ((czekaj = ODSTEP_PO_AUDIO - (Date.now()-ostatnieAudio)) > 0) { btn.textContent = "⏳ po odsłuchu… " + Math.ceil(czekaj/1000); await new Promise(r=>setTimeout(r, Math.min(czekaj,200))); if (session!==s) return; if (s.released) {...} }` (drop the tik interval).

[MEDIUM-8] getUserMedia awaited without timeout while state==="starting" — wymowa.js:225.
Chain: prompt dismissed/never answered or a hung promise -> state "starting" forever, label "⏳ uruchamiam…", button dead (same dead-state as HIGH-1, no watchdog armed yet).
Fix: `await Promise.race([getUserMedia(...), new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),4000))])` and rely on the hardLimit from HIGH-1.

[MEDIUM-9] Weak identity check — wymowa.js:228 (`session.btn !== btn`) vs :216 (`session !== s`).
Chain: combined with HIGH-3 (stale onend sets state idle) a second startListening on the same button can pass :228 in both calls and both call r.start(); the second throws InvalidStateError and finishes the live session with an error.
Fix: `if (session !== s) { releaseMic(); return; }` and set `micStream` on `s` (s.micStream) instead of the module var so releaseMic(s) cannot kill another session's stream.

[MEDIUM-10] speechSynthesis path timing — wymowa.js:204, template.html:105-117.
Chain: cancel() at :204 is before the wait; ostatnieAudio for utterances is set at speak() time (start), so a long utterance cancelled mid-way yields czekaj≈0; TTS started later (HIGH-4) is never cancelled before rec.start().
Fix: before cancel: `if (speechSynthesis.speaking||speechSynthesis.pending) audioAktywne();` and call cancel() again immediately before r.start().

[MEDIUM-11] No visibilitychange/pagehide/pageshow handling — wymowa.js (absent).
Chain: app backgrounded (call, control centre, switching apps) or bfcache navigation "← lekcje" and back while a session is non-idle -> module state persists (bfcache keeps JS heap), recognizer events never arrive -> label frozen until a guard fires (or forever in HIGH-1/2 states).
Fix: `document.addEventListener("visibilitychange", ()=>{ if (document.hidden && session) forceFinish(session,"strona ukryta"); })` and `window.addEventListener("pageshow", e=>{ if (e.persisted) { state="idle"; session=null; rec=null; releaseMic(); } })`.

[LOW-12] powtorka.html:281-282 sets wSesji=true then may return false -> ekranStartowy() shown with wSesji true; the filter change handler (:200) then calls nastepna() from the start screen. Fix: set wSesji only after biezaca resolves.
[LOW-13] template.html:90/:127 `lastAudioPlay` dead; :93-97 does not clear `.playing` (card stays highlighted after mic interrupt) — call setPlaying(null) in releaseAudio.
[LOW-14] wymowa.js:217 + :87: released during countdown yields heldMs=0 -> "Za krótko" although the user held ~3 s; return a dedicated message ("Puściłeś przed startem nasłuchu…") when startedAt===0.
[LOW-15] wymowa.js:181 reload restore discarded if reload takes > 15 s (slow GitHub Pages on cellular); raise to 60 s. powtorka sync PUT timer (3 s) can be lost by the reload — localStorage keeps the data, next PUT happens after the next rating.
[LOW-16] wymowa.js:251-261 endGuard 3 s + 3 s = 6 s of "⏳ przetwarzam…"; 1.5 s + 1.5 s is enough for a stop that WebKit will honour.
[LOW-17] wymowa.js:205/:220 opts.target()/opts.onStart() not try/caught inside the async function; a throw leaves state="starting" forever. Wrap in try/catch like beforeStart.
[LOW-18] template.html:95 / powtorka.html:247 load() on a src-less element: per HTML spec resource-selection (and WebKit HTMLMediaElement::selectMediaResource "no src, no source children") this sets NETWORK_EMPTY and fires emptied/abort, not error, so it will not trigger onerror by itself — but detaching onended/onerror before pause()/load() (fix in HIGH-4) removes the dependency on that.
[INFO] Cloud path (chmuraStart/chmuraStop): re-press aborts the previous recording (porzuc), released-before-start is completed by :314, errors clean up; no dead-button holes. Its only exposure is HIGH-4 (fallback TTS can play into the recording).

- [high] wymowa.js:238 watchdog calls stopListening(), which returns early when state==="starting" (:244) or state!=="listening" (:245); no other code path leaves those states, so a session whose onstart/onend never arrives is permanent and every later pointerdown only sets `pending` (:194-201) without changing the label. (/Users/piotrmisiurek/kubus/wymowa.js:194-201, 238, 241-246)
- [high] wymowa.js:117 (onstart when session.released) sets state="stopping" and calls rec.abort() without arming any endGuard; the endGuard exists only inside stopListening (:251). (/Users/piotrmisiurek/kubus/wymowa.js:112-118, 250-261)
- [high] The force-finish path sets rec=null (:258) but the discarded instance's handlers (:112-151) close over module-level state/session/pending, so a late onend from it sets state idle, stops micStream, and finishes whatever session is current at that moment. (/Users/piotrmisiurek/kubus/wymowa.js:108-153, 258)
- [high] template.html speakGoogle attaches `audio.play().catch(() => { status...; speakSystem(text); })` (:134) and `audio.onerror -> speakSystem(text)` (:130-133); releaseAudio (:93-97), invoked as Wymowa.beforeStart on every mic press (wymowa.js:203), calls pause()/removeAttribute("src")/load() without detaching those handlers. (/Users/piotrmisiurek/kubus/template.html:93-97, 120-135, 171)
- [high] HTML spec: HTMLMediaElement.pause() and the media element load algorithm both 'take pending play promises' and reject them with AbortError; `paused` becomes false synchronously in play(), so releaseAudio's `!audio.paused` check is true and audioAktywne() runs even before playback started. WebKit implements this in HTMLMediaElement::pauseInternal/prepareForLoad via rejectPendingPlayPromises(AbortError). (HTML Living Standard, media elements: play()/pause() steps and 'media element load algorithm'; WebKit Source/WebCore/html/HTMLMediaElement.cpp (pauseInternal, prepareForLoad, rejectPendingPlayPromises))
- [high] The microtask for the rejected play promise runs after startListening's synchronous prefix (i.e. after speechSynthesis.cancel() at :204 and after czekaj is computed at :209), so the fallback speechSynthesis.speak() starts during the countdown and is not cancelled before rec.start(). (/Users/piotrmisiurek/kubus/wymowa.js:202-219 vs template.html:134 (JS job/microtask ordering))
- [medium] load() on a media element with no src attribute, no srcObject and no <source> children ends resource selection with networkState=NETWORK_EMPTY and does not fire `error` (WebKit HTMLMediaElement::selectMediaResource 'nothing to load' branch); an `abort` event fires if it was loading/idle. So template/powtorka releaseAudio() does not itself trigger onerror. (HTML Living Standard resource selection algorithm; WebKit Source/WebCore/html/HTMLMediaElement.cpp selectMediaResource())
- [high] pointerup/pointercancel (wymowa.js:373-377) never clear `pending`; the release-during-countdown path (:217) finishes without draining `pending`; onend drains it with a 300 ms setTimeout (:150) creating a session that is not marked released even if no pointer is down; down() (:369) has no isPrimary/button/duplicate-session guard. (/Users/piotrmisiurek/kubus/wymowa.js:150, 194-201, 217, 367-383)
- [high] The 3.5 s wait is computed once (:209) while the countdown label (:212) recomputes from live ostatnieAudio; audioAktywne() is called by template.html:108/115/128/129 and powtorka.html:247/253/254, some of which can run during the wait. (/Users/piotrmisiurek/kubus/wymowa.js:209-219; template.html:105-135; powtorka.html:246-256)
- [high] getUserMedia at wymowa.js:225 is awaited with no timeout and no watchdog is armed until after r.start() (:238), so the 'starting' state has no time bound before start(). (/Users/piotrmisiurek/kubus/wymowa.js:220-238)
- [high] wymowa.js:228 checks `session.btn !== btn` while :216 checks `session !== s`; :230 calls r.start() even if s.released is already true (relying on onstart to abort). (/Users/piotrmisiurek/kubus/wymowa.js:216, 228-230)
- [high] template.html:121 pauses the previous Audio without releaseAudio (handlers stay attached, element not unloaded); `lastAudioPlay` (:90,:127) is written and never read; releaseAudio never calls setPlaying(null). (/Users/piotrmisiurek/kubus/template.html:90, 93-97, 121, 127)
- [high] powtorka.html:281 sets wSesji=true before :282 can return false (unknown biezaca id), after which ekranStartowy() is rendered while wSesji remains true; the filtr change handler (:200) then calls nastepna() directly. (/Users/piotrmisiurek/kubus/powtorka.html:200, 275-287, 505)
- [high] Event handlers are bound after the elements exist on both pages: template render() creates cards then bindMic (:143-166), Wymowa.beforeStart is assigned at :171 but is only read at press time; powtorka assigns beforeStart (:248) and zapiszStan (:272) before any card is built (:505). `widok`/`aktualna` (let, :326) are only accessed after declaration. No TDZ/ordering bug found. (/Users/piotrmisiurek/kubus/template.html:143-192; powtorka.html:246-287, 326, 505-506)
- [high] Reload mode: finish() (wymowa.js:163) reloads only after a real session (s.startedAt); restore is dropped if href differs or reload took >15 s (:181); powtorka's kartaA/kartaB apply the stored result twice (once from widok.wynik at :376/:447, once from aktualna.zastosujWynik at :284) — idempotent, no visible bug. (/Users/piotrmisiurek/kubus/wymowa.js:155-184; powtorka.html:275-287, 373-377, 447)
- [high] build.py substitutes {{WERSJA}} (md5 of wymowa.js) and {{SYNC_URL}} into both templates; the built lekcje/*/index.html and powtorka/index.html reference wymowa.js?v=b2672653, which equals the md5 of the current wymowa.js, and SYNC_URL https://kubus-sync.dark-mud-b74c.workers.dev. No stale-build mismatch on disk. (/Users/piotrmisiurek/kubus/build.py:13-15, 44, 69; shell check of built files)
- [high] Cloud path: chmuraStart aborts a previous recording with porzuc (:289), completes a release that happened before startedAt (:314/:336), cleans up on getUserMedia failure (:315-322); no path leaves `nagranie` permanently set except a hung getUserMedia, which the next press clears via porzuc. (/Users/piotrmisiurek/kubus/wymowa.js:288-365)
- [medium] .mic buttons use touch-action:none, -webkit-user-select:none, -webkit-touch-callout:none, plus contextmenu/click preventDefault and setPointerCapture; touch pointers are implicitly captured anyway, so pointerup reaches the button even if the finger slides off. pointercancel is handled like pointerup. Native permission sheets (mic / speech recognition) can still cancel the touch, which is handled as an early release (leads to 'Za krótko'). (/Users/piotrmisiurek/kubus/wymowa.js:367-383; template.html:43-45; powtorka.html:42-44; Pointer Events spec (implicit capture for touch))