# kubus-sync

Cloudflare Worker: synchronizacja postępu powtórek (KV) + rozpoznawanie mowy (Whisper, Workers AI).

- `GET/PUT /stan` — stan powtórek (jeden blob JSON, scalanie per karta po czasie zmiany). W blobie też `ulubione` (gwiazdki z powtórki), scalane tak samo.
- `POST /wymowa` — body: plik WAV (16 kHz mono) → `{"text": "..."}`. Model `@cf/openai/whisper-large-v3-turbo`, język zh.
  Silnik "chmura": strony nagrywają mikrofon przez getUserMedia na wspólnym AudioContext strony (tym samym,
  który gra mp3 — nigdy nie zamykanym) i wysyłają WAV tutaj. Zapasowy wobec silnika "system" (Web Speech), który na iOS zawodzi.

- `POST /trener` — body: JSON `{cel:{znaki,pinyin}, uslyszane:{znaki,pinyin}, poziom, sylaby:[{znak,cel,celTon,usl,uslTon}]}` → `{diagnoza, wskazowka, cwiczenie:{znaki,pinyin,polski,wymowa,ton}}`.
  Claude Opus 5 przez `@anthropic-ai/sdk` (structured output, fallbacki `default`). Sekret `ANTHROPIC_API_KEY`.
- `GET /tts?q=<znaki>&slow=1` — mp3 z Google TTS (zh-CN), proxy z CORS i cache 30 dni; nagrania ćwiczeń trenera.

## Pierwsze wdrożenie
```sh
cd worker
npx wrangler login
npx wrangler kv namespace create STAN      # wklej "id" do wrangler.toml
npx wrangler secret put TOKEN              # długi losowy klucz, np. openssl rand -hex 24
npx wrangler secret put ANTHROPIC_API_KEY  # klucz Anthropic (trener wymowy)
npx wrangler deploy                        # wypisze adres https://kubus-sync.<konto>.workers.dev
```
Adres workera wpisz do pliku `sync.url` w katalogu głównym repo (build.py wstawia go do strony powtórek).
Klucz podajesz stronie raz, linkiem: `https://kubi-dev.github.io/kubus/powtorka/?k=<TOKEN>` (zapisuje się w przeglądarce).

## Aktualizacja
```sh
cd worker && npx wrangler deploy
```
