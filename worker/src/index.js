// Synchronizacja postępu powtórek: jeden blob JSON w Workers KV.
// GET /stan  -> aktualny stan
// PUT /stan  -> scalenie przysłanego stanu z zapisanym (nowsza wersja karty wygrywa), zapis, zwrot scalonego
// Autoryzacja: nagłówek "Authorization: Bearer <TOKEN>" (sekret workera).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });

const PUSTY = { karty: {}, ustawienia: { nowe: 10, z: 0 }, dzien: { data: "", nowe: 0 } };

function scal(a, b) {
  const out = { karty: { ...a.karty }, ustawienia: a.ustawienia || PUSTY.ustawienia, dzien: a.dzien || PUSTY.dzien };
  for (const k in (b.karty || {})) {
    const x = out.karty[k], y = b.karty[k];
    if (!x || (y.z || 0) > (x.z || 0)) out.karty[k] = y;
  }
  if (b.ustawienia && (b.ustawienia.z || 0) > (out.ustawienia.z || 0)) out.ustawienia = b.ustawienia;
  if (b.dzien && (b.dzien.data > (out.dzien.data || "") || (b.dzien.data === out.dzien.data && (b.dzien.nowe || 0) > (out.dzien.nowe || 0)))) out.dzien = b.dzien;
  return out;
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (url.pathname !== "/stan") return json({ error: "not found" }, 404);
    const auth = req.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("k");
    if (!env.TOKEN || token !== env.TOKEN) return json({ error: "unauthorized" }, 401);

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
