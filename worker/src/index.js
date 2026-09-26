// Synchronizacja postępu powtórek: jeden blob JSON w Workers KV.
// GET /stan  -> aktualny stan
// PUT /stan  -> scalenie przysłanego stanu z zapisanym (nowsza wersja karty wygrywa), zapis, zwrot scalonego
// POST /wymowa -> rozpoznanie mowy (Whisper, Workers AI); body = plik audio (WAV), odpowiedź {text}
// POST /trener -> trener wymowy (Claude): body = JSON z celem, tym co usłyszano i sylabami z tonami, odpowiedź JSON po polsku
// Autoryzacja: nagłówek "Authorization: Bearer <TOKEN>" (sekret workera). Klucz Anthropic: sekret ANTHROPIC_API_KEY.

import Anthropic from "@anthropic-ai/sdk";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });

const PUSTY = { karty: {}, ustawienia: { nowe: 10, z: 0 }, dzien: { data: "", nowe: 0 }, ulubione: {} };

function scal(a, b) {
  const out = { karty: { ...a.karty }, ustawienia: a.ustawienia || PUSTY.ustawienia, dzien: a.dzien || PUSTY.dzien, ulubione: { ...(a.ulubione || {}) } };
  for (const k in (b.karty || {})) {
    const x = out.karty[k], y = b.karty[k];
    if (!x || (y.z || 0) > (x.z || 0)) out.karty[k] = y;
  }
  // ulubione zwroty: {znaki: {on: bool, z: czas zmiany}}, scalanie jak karty
  for (const k in (b.ulubione || {})) {
    const x = out.ulubione[k], y = b.ulubione[k];
    if (!x || (y.z || 0) > (x.z || 0)) out.ulubione[k] = y;
  }
  if (b.ustawienia && (b.ustawienia.z || 0) > (out.ustawienia.z || 0)) out.ustawienia = b.ustawienia;
  if (b.dzien && (b.dzien.data > (out.dzien.data || "") || (b.dzien.data === out.dzien.data && (b.dzien.nowe || 0) > (out.dzien.nowe || 0)))) out.dzien = b.dzien;
  return out;
}

// ---- trener wymowy ----
const TRENER_SYSTEM = `Jesteś trenerem wymowy chińskiego dla Polaka, który zaczyna od zera i NIE ZNA żadnych pojęć z fonetyki.
Uczeń powiedział słowo do mikrofonu, rozpoznawanie mowy zwróciło znaki, a tony "usłyszane" wynikają z rozpoznanych znaków
(homofon z innym tonem = zły ton). Dostajesz JSON: cel (znaki, pinyin), usłyszane (znaki, pinyin), poziom (tones = sylaby dobre,
tony złe; close = część sylab zła; bad = większość zła) i listę sylab z tonami (celTon/uslTon: 1-4, 5 = neutralny, null = brak).

JAK PISAĆ — to najważniejsze:
- Jak do kolegi, który nigdy nie uczył się języków. Proste słowa, krótkie zdania (max 10 słów). Zero terminów: nie pisz
  "sylaba", "ton opadający", "kontur", "przydech", "intonacja", "wysokość głosu", "modulacja", "nagłos", "spółgłoska".
- Ton tłumacz TYLKO przez polski przykład z życia: sytuacja + polskie słowo, które wtedy tak samo brzmi. Uczeń ma to
  polskie słowo powiedzieć na głos, a potem chińską sylabę DOKŁADNIE tak samo. Przykłady do użycia (wybierz jeden na ton):
  1. ton: lekarz prosi, żebyś otworzył usta i powiedział równe, długie, wysokie "Aaaa". Głos nie skacze, trzyma się na jednym, wysokim poziomie.
  2. ton: polskie zdziwienie, gdy o coś dopytujesz. Ktoś mówi ci coś szokującego, a ty z niedowierzaniem: "Cooo?". Głos wędruje z dołu do góry.
  3. ton: przeciągłe zastanowienie "Noooo…". Zaczynasz normalnie, schodzisz głosem bardzo nisko (jakbyś "dusił" dźwięk w gardle), a na sam koniec lekko odbijasz w górę.
  4. ton: stanowczy polski rozkaz "Nie!" albo "Zostaw!". Krótki, ostry, zdecydowany dźwięk spadający w dół.
  neutralny: bardzo krótko, lekko i bez nacisku, jak końcówka polskiego wyrazu (drugie "ma" w "mama").
  Słowa "wysoko", "nisko", "z dołu do góry", "w dół" wolno TYLKO razem z tym polskim słowem, nigdy same.
  Wzór wskazówki: "Powiedz po polsku 'Cooo?', jakby ktoś powiedział ci coś szokującego. Teraz 'siang' powiedz dokładnie tak samo jak to 'Cooo?'."
  Numer tonu podaj tylko w nawiasie na końcu, np. "(to 2. ton)".
- Zamiast pinyinu mów po polsku, jak to brzmi, np. zamiast "hē" pisz "chy". Możesz dać pinyin w nawiasie.
- Pokaż ruch głosu strzałką w tekście: → jak "Aaaa", ↗ jak "Cooo?", ↘↗ jak "Noooo…", ↘ jak "Nie!".
- Konkretna instrukcja "zrób tak": co ma zrobić z głosem, nie dlaczego.

Pola odpowiedzi:
- diagnoza: 1-2 krótkie zdania. Które słowo i co zrobił głos, też przez polski przykład. Wzór: "W 'siang' głos poszedł ci w dół, jak w 'Nie!'. Ma być jak 'Noooo…': bardzo nisko i na koniec lekko w górę."
- Uczeń ma pod tekstem przycisk z nagraniem złej sylaby i ćwiczenia (wolno). Zawsze zacznij wskazówkę od "Posłuchaj nagrania" i każ powtórzyć 3 razy.
- wskazowka: 2-3 krótkie zdania wg wzoru wyżej: polska sytuacja, polskie słowo, "powiedz na głos", potem chińska sylaba "tak samo". Jeśli złe są dwie sylaby, weź tylko tę ważniejszą.
  Jeśli poziom to close/bad, to zamiast tonu powiedz, jak brzmi zła głoska, np. "'czhy' mów z dmuchnięciem, jak czh w 'czhamp'".
- cwiczenie: jedno proste słowo (1-2 znaki, HSK1) do powtórzenia z DOKŁADNIE tym samym problemem, o którym mówi wskazówka:
  * gdy chodzi o ton: słowo z tym samym tonem co zła sylaba (ton = ten numer).
  * gdy chodzi o głoskę: słowo, którego pinyin zaczyna się TĄ SAMĄ literą (literami) co zła sylaba (ton = 0). Tłumaczysz "ph" -> ćwiczenie
    na p, nie na ch. Przykłady HSK1: p: 朋友, 苹果, 便宜 · t: 他, 太, 听, 天 · k: 看, 咖啡, 可以 · q: 七, 钱, 请 · ch: 吃, 茶 · c: 菜, 从 ·
    zh: 中国, 这 · j: 鸡, 几 · x: 谢谢, 小 · sh: 是, 水, 十 · r: 人, 肉 · h: 喝, 好, 很.
  * dlaczego: jedno zdanie (max 10 słów), które łączy ćwiczenie ze wskazówką, np. "To samo 'ph' co w 'phu'." albo "Ten sam ton co w 'siang'."
    Nie może być tak, że wskazówka mówi o jednej głosce, a ćwiczenie ma inną.
  Pola: znaki, pinyin, polski (znaczenie), dlaczego,
  ton (numer ćwiczonego tonu 1-4, 0 gdy chodzi o głoskę), wymowa = zapis polskimi literami, sylaby przez myślnik, w konwencji ucznia:
  喝=chy, 水=szłej, 吃=czhy, 茶=czha, 我想=ło siang, 你好=ni chał, 咖啡=kha-fej, 鸡肉=dzi-żoł, 饺子=dział-dzy, 面条=mien-thiał, 米饭=mi-fan,
  果汁=kło-czy, 啤酒=phi-dzioł, 牛奶=nioł-naj, 葡萄酒=phu-thał-dzioł, 我不知道=ło pu czy-tał, 朋友=phyng-joł.
  Zasady: p/t/k/q/ch/c z "h" (ph, th, kh, czh, ćh, cch); b/d/g/zh/j/z jako p, t, k, cz, dź/dzi, dz; x=si, sh=sz, r=ż, ü=ü,
  -ao=ał, -ou=oł, -ei=ej, -ai=aj, -uo=ło, -ui=łej, -e=y (po spółgłosce), -eng=yng, -ong=ung, -ian=ien.
Bez emoji. Bez pochwał. Bez wstępów.`;

const TRENER_SCHEMA = {
  type: "object", additionalProperties: false, required: ["diagnoza", "wskazowka", "cwiczenie"],
  properties: {
    diagnoza: { type: "string" },
    wskazowka: { type: "string" },
    cwiczenie: { type: "object", additionalProperties: false, required: ["znaki", "pinyin", "polski", "dlaczego", "wymowa", "ton"],
      properties: { znaki: { type: "string" }, pinyin: { type: "string" }, polski: { type: "string" }, dlaczego: { type: "string" }, wymowa: { type: "string" }, ton: { type: "integer" } } },
  },
};

async function trener(body, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "brak klucza ANTHROPIC_API_KEY w workerze" }, 500);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const t0 = Date.now();
  try {
    const r = await client.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 1024,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: TRENER_SCHEMA } },
      system: [{ type: "text", text: TRENER_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: JSON.stringify(body) }],
    });
    if (r.stop_reason === "refusal") return json({ error: "trener odmówił" }, 502);
    const text = r.content.filter(b => b.type === "text").map(b => b.text).join("");
    const out = JSON.parse(text);
    const u = r.usage || {};
    return json({ ...out, ms: Date.now() - t0, tokeny: { wejscie: u.input_tokens, cache_zapis: u.cache_creation_input_tokens, cache_odczyt: u.cache_read_input_tokens, wyjscie: u.output_tokens } });
  } catch (e) { return json({ error: "trener: " + (e.message || e) }, 502); }
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (!["/stan", "/wymowa", "/trener", "/tts"].includes(url.pathname)) return json({ error: "not found" }, 404);
    const auth = req.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("k");
    if (!env.TOKEN || token !== env.TOKEN) return json({ error: "unauthorized" }, 401);

    // GET /tts?q=<znaki>&slow=1 -> mp3 z Google TTS (zh-CN); dla ćwiczeń trenera, których nie ma w audio/ lekcji
    if (url.pathname === "/tts") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q || q.length > 20) return json({ error: "bad q" }, 400);
      const slow = url.searchParams.get("slow") ? "&ttsspeed=0.24" : "";
      const r = await fetch("https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=zh-CN&q=" + encodeURIComponent(q) + slow,
        { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://translate.google.com/" } });
      if (!r.ok) return json({ error: "tts " + r.status }, 502);
      return new Response(r.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=2592000", ...CORS } });
    }

    if (url.pathname === "/trener") {
      if (req.method !== "POST") return json({ error: "method" }, 405);
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
      if (!body || !body.cel || !body.uslyszane) return json({ error: "bad body" }, 400);
      return trener(body, env);
    }

    if (url.pathname === "/wymowa") {
      if (req.method !== "POST") return json({ error: "method" }, 405);
      const buf = await req.arrayBuffer();
      if (buf.byteLength < 1000) return json({ error: "za krótkie nagranie" }, 400);
      if (buf.byteLength > 4 * 1024 * 1024) return json({ error: "za duże nagranie" }, 413);
      const bytes = new Uint8Array(buf);
      let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      const t0 = Date.now();
      try {
        const out = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
          audio: btoa(bin), task: "transcribe", language: "zh",
          initial_prompt: "以下是普通话的句子。", // podpowiedź: uproszczone znaki
        });
        return json({ text: (out && out.text || "").trim(), ms: Date.now() - t0 });
      } catch (e) { return json({ error: "whisper: " + (e.message || e) }, 502); }
    }

    const zapisany = JSON.parse((await env.STAN.get("stan")) || "null") || PUSTY;
    if (req.method === "GET") return json(zapisany);
    if (req.method === "PUT") {
      let przyslany;
      try { przyslany = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
      if (!przyslany || typeof przyslany !== "object") return json({ error: "bad body" }, 400);
      const scalony = scal(zapisany, przyslany);
      await env.STAN.put("stan", JSON.stringify(scalony));
      return json(scalony);
    }
    return json({ error: "method" }, 405);
  },
};
