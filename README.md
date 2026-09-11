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

## Dźwięk i mikrofon
Strony nie używają elementu `<audio>`: mp3 gra `wymowa.js` przez jeden `AudioContext` na stronę (`Wymowa.graj(url)`,
bufory cache'owane per plik, `Wymowa.preload(url)`), bo na iOS `<audio>` zapisuje do wspólnej sesji AVAudioSession
i zabija rozpoznawanie mowy. Moduł ustawia `navigator.audioSession.type = "playback"` przy starcie i po każdym
nasłuchu robi `ambient` → `playback`, żeby cofnąć kategorię ustawioną przez proces GPU (inaczej mp3 gra cicho).
Między końcem nasłuchu a następnym startem jest odstęp (domyślnie 4,5 s; `localStorage kubus.wymowa.odstep`).
Parametry testowe w URL: `?odstep=0`, `?sesja=0`, `?silnik=system|chmura|system-reload`.
Szczegóły i plan testu na telefonie: `docs/plan-mikrofon-ios-spec.md`.

## Powtórki
- Strona `powtorka/` (SM-2 jak w Anki). Karta A: polskie znaczenie, mówisz po chińsku (mikrofon). Karta B: audio po chińsku, wybierasz znaczenie, po dojrzeniu karty wpisujesz.
- Postęp w `localStorage` + synchronizacja przez Cloudflare Worker (`worker/`, opis w `worker/README.md`). Adres workera w pliku `sync.url`, klucz podajesz stronie linkiem `powtorka/?k=<klucz>`.

## Struktura
```
template.html            szablon strony lekcji
powtorka.html            szablon strony powtórek
wymowa.js                wspólny moduł: odtwarzanie mp3 (Web Audio) + sprawdzanie wymowy (mikrofon)
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
