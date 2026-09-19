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
- Zamiast numeru tonu ZAWSZE mów, co robi głos, jednym z czterech opisów:
  1. ton = "równo, wysoko, jak dzwonek" · 2. ton = "w górę, jak pytanie: co?" · 3. ton = "w dół i z powrotem, jak zawiedzione: no-o…"
  · 4. ton = "krótko w dół, jak rozkaz: nie!". Możesz dodać numer w nawiasie, np. "w górę (2)".
- Zamiast pinyinu mów po polsku, jak to brzmi, np. zamiast "hē" pisz "chy". Możesz dać pinyin w nawiasie.
- Pokaż ruch głosu strzałką w tekście: → równo, ↗ w górę, ↘↗ w dół i w górę, ↘ w dół.
- Konkretna instrukcja "zrób tak": co ma zrobić z głosem, nie dlaczego.

Pola odpowiedzi:
- diagnoza: 1-2 krótkie zdania. Które słowo i co zrobił głos. Wzór: "W 'siang' głos poszedł ci w dół (↘). Ma iść w dół i wrócić (↘↗)."
- wskazowka: 1-2 krótkie zdania, jak to zrobić. Wzór: "Powiedz 'siang' jak zawiedzione no-o…: zejdź nisko i podnieś na końcu."
  Jeśli poziom to close/bad, to zamiast tonu powiedz, jak brzmi zła głoska, np. "'czhy' mów z dmuchnięciem, jak czh w 'czhamp'".
- cwiczenie: jedno proste słowo (1-2 znaki, HSK1) z tym samym problemem do powtórzenia. Pola: znaki, pinyin, polski (znaczenie),
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
    cwiczenie: { type: "object", additionalProperties: false, required: ["znaki", "pinyin", "polski", "wymowa", "ton"],
      properties: { znaki: { type: "string" }, pinyin: { type: "string" }, polski: { type: "string" }, wymowa: { type: "string" }, ton: { type: "integer" } } },
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
    return json({ ...out, ms: Date.now() - t0 });
  } catch (e) { return json({ error: "trener: " + (e.message || e) }, 502); }
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (url.pathname !== "/stan" && url.pathname !== "/wymowa" && url.pathname !== "/trener") return json({ error: "not found" }, 404);
    const auth = req.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("k");
    if (!env.TOKEN || token !== env.TOKEN) return json({ error: "unauthorized" }, 401);

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
