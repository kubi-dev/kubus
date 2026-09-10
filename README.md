# Notatki z chińskiego

Strona: https://kubi-dev.github.io/kubus/

## Nowa lekcja
1. Zdjęcia notatek do `inbox/`.
2. W Claude Code: `/nowa-lekcja` (opcjonalnie numer: `/nowa-lekcja 3`).
3. Potwierdź tabelę, Claude robi build i deploy.

## Ręcznie
- `python3 build.py` — buduje wszystkie strony + nagrania mp3 (tylko brakujące).
- `./serwuj.sh` — podgląd lokalny na http://localhost:8765/
- `./deploy.sh "opis"` — commit + push, GitHub Pages odświeża w ~1 min.

## Powtórki
- Strona `powtorka/` (SM-2 jak w Anki). Karta A: polskie znaczenie, mówisz po chińsku (mikrofon). Karta B: audio po chińsku, wybierasz znaczenie, po dojrzeniu karty wpisujesz.
- Postęp w `localStorage` + synchronizacja przez Cloudflare Worker (`worker/`, opis w `worker/README.md`). Adres workera w pliku `sync.url`, klucz podajesz stronie linkiem `powtorka/?k=<klucz>`.

## Struktura
```
template.html            szablon strony lekcji
powtorka.html            szablon strony powtórek
wymowa.js                wspólny moduł sprawdzania wymowy (Web Speech API, iOS-friendly)
worker/                  Cloudflare Worker synchronizacji postępu
build.py                 generator
lekcje/NN-slug/
  lekcja.json            dane (źródło prawdy, edytuj tu)
  zdjecia/               zdjęcia notatek
  audio/                 mp3 generowane z Google TTS
  index.html, notatki.md wygenerowane
powtorka/                wygenerowana strona powtórek + karty.json
index.html               wygenerowany indeks lekcji
```
