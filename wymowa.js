// Wspólny moduł sprawdzania wymowy (Web Speech API) dla stron lekcji i powtórek.
// iOS WebKit (Safari i Chrome na iPhonie): nowa instancja przy każdym użyciu i automatyczne
// kończenie po ciszy są zawodne (druga sesja dostaje ciszę, stop() nie daje wyniku "final").
// Wzorzec, który działa: 1. jedna instancja SpeechRecognition, 2. otwarty strumień getUserMedia
// na czas nasłuchu (wymusza kategorię sesji audio play-and-record, po zwolnieniu wraca playback
// dla mp3), 3. użytkownik sam kończy nasłuch puszczając przycisk.
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
  function diag(msg) {
    if (!diagEl) diagEl = document.getElementById("diag-log");
    const line = new Date().toISOString().slice(11, 23) + " " + msg;
    console.log("[wymowa] " + msg);
    if (diagEl) { diagEl.textContent += line + "\n"; diagEl.scrollTop = diagEl.scrollHeight; }
  }
  const IOS_VER = (navigator.userAgent.match(/OS (\d+)_(\d+)/) || [])[1];
  diag("UA: " + navigator.userAgent);
  diag("iOS: " + (IOS_VER || "nie") + ", SpeechRecognition: " + (SR ? "jest" : "BRAK") + ", getUserMedia: " + (navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? "jest" : "BRAK"));

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

  function finish(s) {
    clearTimeout(s.watchdog); clearTimeout(s.endGuard);
    s.btn.classList.remove("rec"); s.btn.textContent = LABEL_IDLE;
    const alts = (s.gotFinal ? s.finalAlts : (s.interim ? [s.interim] : [])).filter(a => a);
    const heldMs = s.startedAt ? Date.now() - s.startedAt : 0;
    diag("koniec: final=" + s.gotFinal + " interim=" + JSON.stringify(s.interim || "") + " trzymane " + heldMs + "ms");
    if (s.opts.onDone) s.opts.onDone({ alts, gotFinal: s.gotFinal, error: s.error, heldMs });
  }

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
    btn.classList.add("rec"); btn.textContent = "⏳ uruchamiam…";
    if (opts.onStart) opts.onStart();
    diag("start cel=" + target);
    // Otwieramy mikrofon przez getUserMedia na czas nasłuchu (patrz komentarz na górze pliku).
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
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
    s.endGuard = setTimeout(() => { if (session === s) { diag("brak onend po stop(), abort()"); try { getRec().abort(); } catch (e) {} } }, 3000);
  }

  function bind(btn, opts) {
    btn.textContent = LABEL_IDLE;
    const down = (e) => { e.preventDefault(); e.stopPropagation(); try { btn.setPointerCapture(e.pointerId); } catch (err) {} startListening(btn, opts); };
    const up = (e) => { e.preventDefault(); e.stopPropagation(); if (session && session.btn === btn) stopListening(); };
    btn.addEventListener("pointerdown", down);
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointercancel", up);
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  const W = { diag, supported: !!SR, beforeStart: null, bind, grade, render, strip, toPinyin, LABEL_IDLE };
  window.Wymowa = W;
})();
