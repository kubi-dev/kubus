// lista.js: wspólna lista zwrotów z wyszukiwarką po polsku i karta zwrotu (obrazek, znaki, pinyin, zapis polski, nagranie, mikrofon, gwiazdka).
// Używa jej strona główna (wszystkie zwroty) i ulubione/ (tylko z gwiazdką). Gwiazdki to pole "ulubione" w tym samym stanie co powtórka
// (localStorage "kubus.powtorka" + worker), więc synchronizują się między urządzeniami.
// Strona daje elementy #szukaj #lista #sync #overlay #wroc #o-ttl #card (i opcjonalnie #diag-log) oraz woła Lista.start(opcje):
//   karty        talia (jak powtorka/karty.json)
//   baza         przedrostek ścieżek do mp3 i obrazków ("" na stronie głównej, "../" w podkatalogu)
//   syncUrl      adres workera (gdy w localStorage nie ma własnego)
//   filtr(k)     które karty w ogóle pokazywać (domyślnie wszystkie)
//   bezZapytania czy przy pustym polu pokazać całą listę (ulubione: tak, główna: nie)
//   pusto        HTML, gdy filtr nic nie zostawia
//   naZmiane(q)  wołane przy każdym rysowaniu listy z tekstem z pola
window.Lista = (function () {
  const $ = id => document.getElementById(id);
  const opcje = { karty: [], baza: "", syncUrl: "", filtr: () => true, bezZapytania: true, pusto: "Nic tu nie ma.", naZmiane: null };
  const KARTY_MAP = {};

  // ---------- stan: ten sam blob co powtórka, tu używamy tylko pola "ulubione" ----------
  const KLUCZ_LS = "kubus.powtorka";
  let stan = { karty: {}, ustawienia: { nowe: 10, z: 0 }, dzien: { data: "", nowe: 0 }, ulubione: {} };
  try { const s = JSON.parse(localStorage.getItem(KLUCZ_LS) || "null"); if (s && s.karty) stan = scal(stan, s); } catch (e) {}
  const cfg = { url: "", klucz: "" };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(KLUCZ_LS + ".sync") || "{}")); } catch (e) {}

  function scal(a, b) {
    // nowsza wersja wygrywa (pole z = czas zmiany); to samo w powtórce i w workerze
    const out = { karty: Object.assign({}, a.karty), ustawienia: a.ustawienia, dzien: a.dzien, ulubione: Object.assign({}, a.ulubione || {}) };
    for (const k in (b.karty || {})) { const x = out.karty[k], y = b.karty[k]; if (!x || (y.z || 0) > (x.z || 0)) out.karty[k] = y; }
    for (const k in (b.ulubione || {})) { const x = out.ulubione[k], y = b.ulubione[k]; if (!x || (y.z || 0) > (x.z || 0)) out.ulubione[k] = y; }
    if (b.ustawienia && (b.ustawienia.z || 0) > (a.ustawienia.z || 0)) out.ustawienia = b.ustawienia;
    if (b.dzien && (b.dzien.data > (a.dzien.data || "") || (b.dzien.data === a.dzien.data && (b.dzien.nowe || 0) > (a.dzien.nowe || 0)))) out.dzien = b.dzien;
    return out;
  }
  function zapiszLokalnie() { try { localStorage.setItem(KLUCZ_LS, JSON.stringify(stan)); } catch (e) {} }

  let syncTimer = null, syncBusy = false, syncDirty = false;
  function pokazSync(msg, err) { const e = $("sync"); if (!e) return; e.textContent = msg; e.className = "sync" + (err ? " err" : ""); }
  async function syncTeraz(pobierzTylko) {
    if (!cfg.url || !cfg.klucz) { pokazSync("bez synchronizacji (klucz ustawisz w powtórce, ⚙)"); return; }
    if (syncBusy) { syncDirty = true; return; }
    syncBusy = true;
    try {
      const r = await fetch(cfg.url.replace(/\/$/, "") + "/stan", {
        method: pobierzTylko ? "GET" : "PUT",
        headers: { "Authorization": "Bearer " + cfg.klucz, "Content-Type": "application/json" },
        body: pobierzTylko ? undefined : JSON.stringify(stan)
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      stan = scal(stan, await r.json()); zapiszLokalnie();
      pokazSync("zsynchronizowano " + new Date().toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }));
      if ($("overlay").hidden) rysujListe();
    } catch (e) { pokazSync("synchronizacja nie działa: " + e.message, true); }
    finally { syncBusy = false; if (syncDirty) { syncDirty = false; zaplanujSync(); } }
  }
  function zaplanujSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncTeraz(false), 3000); }
  document.addEventListener("visibilitychange", () => { if (document.hidden && syncTimer) { clearTimeout(syncTimer); syncTeraz(false); } });

  function ulubiona(znaki) { const u = stan.ulubione[znaki]; return !!(u && u.on); }
  function przelaczUlubiona(znaki) { stan.ulubione[znaki] = { on: !ulubiona(znaki), z: Date.now() }; zapiszLokalnie(); zaplanujSync(); }

  // ---------- pomocnicze ----------
  function polskie(k) { const m = k.znaczenie.split("·"); return (m.length > 1 ? m.slice(1).join("·") : m[0]).trim(); }
  // polski zapis wymowy (jak w powtórce): z karty albo z pinyin-pro przez Wymowa.pinyinPl
  function polskiZapis(k) { return k.polski || (window.pinyinPro ? pinyinPro.pinyin(k.znaki, { toneType: "none", type: "array" }).map(Wymowa.pinyinPl).join("-") : k.pinyin); }
  function angielskie(k) { const m = k.znaczenie.split("·"); return m.length > 1 ? m[0].trim() : ""; }
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function graj(k, wolno) { if (!k.audio) return; Wymowa.graj(opcje.baza + k.audio + (wolno ? "-slow" : "") + ".mp3").catch(e => Wymowa.diag("mp3 błąd: " + e.message)); }
  function kredyt(k) {
    const o = k.obrazek; if (!o || o.licencja !== "by") return null;
    const a = o.autor || "autor nieznany";
    return el("div", "kred", "fot. " + (o.zrodlo ? `<a href="${o.zrodlo}" target="_blank" rel="noopener">${a}</a>` : a) + " · CC BY");
  }
  function norm(s) { return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l"); }

  // ---------- lista ----------
  function rysujListe() {
    const lista = $("lista"); lista.innerHTML = "";
    const surowe = $("szukaj").value.trim(), q = norm(surowe);
    if (opcje.naZmiane) opcje.naZmiane(surowe);
    if (!q && !opcje.bezZapytania) return;
    const wszystkie = opcje.karty.filter(opcje.filtr).sort((a, b) => polskie(a).localeCompare(polskie(b), "pl"));
    const karty = q ? wszystkie.filter(k => norm(polskie(k) + " " + angielskie(k) + " " + k.pinyin + " " + k.polski + " " + k.znaki).includes(q)) : wszystkie;
    if (!wszystkie.length) { lista.appendChild(el("div", "pusto", opcje.pusto)); return; }
    if (!karty.length) { lista.appendChild(el("div", "pusto", "Nic nie pasuje do „" + surowe + "”.")); return; }
    for (const k of karty) {
      const b = el("button", "item"); b.type = "button";
      const txt = el("div", "txt");
      txt.appendChild(el("b", "", polskie(k)));
      txt.appendChild(el("small", "", polskiZapis(k) + " · " + k.pinyin + (angielskie(k) ? " · " + angielskie(k) : "")));
      b.appendChild(txt);
      b.appendChild(el("span", "hz", k.znaki));
      b.addEventListener("click", () => otworz(k));
      lista.appendChild(b);
    }
  }

  // ---------- karta ----------
  let otwarta = null;
  function otworz(k) {
    otwarta = k;
    const card = $("card"); card.innerHTML = "";
    $("o-ttl").textContent = k.lekcjaTytul || "";
    const star = el("button", "star"); star.type = "button";
    const odswiez = () => { const on = ulubiona(k.id); star.textContent = on ? "★" : "☆"; star.classList.toggle("on", on); star.title = on ? "usuń z ulubionych" : "dodaj do ulubionych"; };
    odswiez(); star.addEventListener("click", () => { przelaczUlubiona(k.id); odswiez(); });
    card.appendChild(star);
    if (k.img) { const i = el("img", "obr"); i.src = opcje.baza + k.img; i.alt = ""; card.appendChild(i); }
    card.appendChild(el("div", "znacz", polskie(k) + (angielskie(k) ? `<small>${angielskie(k)}</small>` : "")));
    card.appendChild(el("div", "hanzi", k.znaki));
    card.appendChild(el("div", "pinyin", k.pinyin));
    if (k.polski) card.appendChild(el("div", "pl", "po polsku: " + k.polski));
    const kr = kredyt(k); if (kr) card.appendChild(kr);
    const row = el("div", "row");
    const b1 = el("button", "big", "🔊 posłuchaj"); b1.type = "button"; b1.addEventListener("click", () => graj(k)); row.appendChild(b1);
    const b2 = el("button", "big", "🐢 wolniej"); b2.type = "button"; b2.addEventListener("click", () => graj(k, true)); row.appendChild(b2);
    card.appendChild(row);
    const mic = el("button", "mic"); mic.type = "button";
    const out = el("div", "result");
    Wymowa.bind(mic, {
      target: k.znaki,
      onStart: () => {},
      onDone: (res) => { const x = Wymowa.render(res, k.znaki); out.hidden = false; out.className = "result " + x.cls; out.innerHTML = x.html; }
    });
    card.appendChild(mic); card.appendChild(out);
    $("overlay").hidden = false;
    window.scrollTo(0, 0);
    graj(k);
  }
  function zamknij() { Wymowa.stopAudio(); otwarta = null; $("overlay").hidden = true; rysujListe(); }

  function start(o) {
    Object.assign(opcje, o);
    for (const k of opcje.karty) KARTY_MAP[k.id] = k;
    if (!cfg.url && opcje.syncUrl) cfg.url = opcje.syncUrl;
    $("szukaj").addEventListener("input", rysujListe);
    $("wroc").addEventListener("click", (e) => { e.preventDefault(); zamknij(); });
    // tryb "system-reload": po przeładowaniu wróć do otwartej karty i pokaż wynik
    Wymowa.zapiszStan = () => ({ otwarta: otwarta ? otwarta.id : null, szukaj: $("szukaj").value });
    const w = Wymowa.odbierzWynik();
    if (w && w.strona) {
      $("szukaj").value = w.strona.szukaj || "";
      const k = w.strona.otwarta && KARTY_MAP[w.strona.otwarta];
      if (k) {
        otworz(k); Wymowa.stopAudio();
        if (w.res) { const out = $("card").querySelector(".result"), x = Wymowa.render(w.res, k.znaki); out.hidden = false; out.className = "result " + x.cls; out.innerHTML = x.html; }
      }
    }
    rysujListe();
    syncTeraz(true);
  }

  return { start, ulubiona, rysuj: rysujListe, otworz, zamknij };
})();
