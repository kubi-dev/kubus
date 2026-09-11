# kubus-sync

Cloudflare Worker: synchronizacja postępu powtórek (KV) + rozpoznawanie mowy (Whisper, Workers AI).

- `GET/PUT /stan` — stan powtórek (jeden blob JSON, scalanie per karta po czasie zmiany).
- `POST /wymowa` — body: plik WAV (16 kHz mono) → `{"text": "..."}`. Model `@cf/openai/whisper-large-v3-turbo`, język zh.
  Silnik "chmura": strony nagrywają mikrofon przez getUserMedia na wspólnym AudioContext strony (tym samym,
  który gra mp3 — nigdy nie zamykanym) i wysyłają WAV tutaj. Zapasowy wobec silnika "system" (Web Speech), który na iOS zawodzi.

## Pierwsze wdrożenie
```sh
cd worker
npx wrangler login
npx wrangler kv namespace create STAN      # wklej "id" do wrangler.toml
npx wrangler secret put TOKEN              # długi losowy klucz, np. openssl rand -hex 24
npx wrangler deploy                        # wypisze adres https://kubus-sync.<konto>.workers.dev
```
Adres workera wpisz do pliku `sync.url` w katalogu głównym repo (build.py wstawia go do strony powtórek).
Klucz podajesz stronie raz, linkiem: `https://kubi-dev.github.io/kubus/powtorka/?k=<TOKEN>` (zapisuje się w przeglądarce).

## Aktualizacja
```sh
cd worker && npx wrangler deploy
```
