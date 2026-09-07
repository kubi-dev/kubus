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

## Struktura
```
template.html            szablon strony lekcji
build.py                 generator
lekcje/NN-slug/
  lekcja.json            dane (źródło prawdy, edytuj tu)
  zdjecia/               zdjęcia notatek
  audio/                 mp3 generowane z Google TTS
  index.html, notatki.md wygenerowane
index.html               wygenerowany indeks lekcji
```
