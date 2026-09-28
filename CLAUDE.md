# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Strona do nauki chińskiego dla Polaka: statyczny HTML na GitHub Pages (https://kubi-dev.github.io/kubus/) plus Cloudflare Worker. Szczegóły działania stron (dźwięk i mikrofon na iOS, trener tonów, podcast, scenki, tony i dźwięki, powtórki) są w `README.md`; przeczytaj właściwy dział, zanim coś zmienisz w danym obszarze.

## Polecenia

- `python3 build.py` buduje wszystkie strony i pobiera tylko brakujące nagrania (Google TTS) i obrazki. `--no-audio` pomija nagrania i składanie podcastów, `--no-obrazki` pomija obrazki. Linie z `!` to błędy (zwykle chwilowe z TTS): uruchom ponownie.
- `./serwuj.sh` to podgląd na http://localhost:8765/ (mikrofon wymaga http, nie file://).
- `./deploy.sh "opis"` robi `git add -A`, commit i push; GitHub Pages odświeża stronę po ~1 min.
- `python3 scenki.py sprawdz lekcje/NN-slug` to jedyna automatyczna kontrola: pokrycie dialogu znanym słownictwem ≥ 75% i zgodność pola `wymowa` z kartami. Testów ani lintera nie ma.
- Worker: `cd worker && npx wrangler deploy` (endpointy i pierwsze wdrożenie w `worker/README.md`).
- Build wymaga `curl`, `ffmpeg` (podcast) i Pillow (obrazki).

## Architektura

**Źródła prawdy (edytuj tylko je):** `lekcje/NN-slug/lekcja.json`, `lekcje/NN-slug/scenki.json`, `wymowa.json`, szablony `*.html` w katalogu głównym, `wymowa.js`, `lista.js`, `lista.css`, skrypty `.py`.

**Wszystko inne generuje `build.py`** i jest commitowane, bo GitHub Pages serwuje repo wprost: każdy `index.html` (główny, `lekcje/*/`, `powtorka/`, `ulubione/`, `podcast/`, `scenki/`, `tony/`, `dzwieki/`), `notatki.md`, `powtorka/karty.json`, katalogi `audio/` i `obrazki/`, pliki `*.mp3` i ich manifesty (`podcast.json`, `scenka-*.json`, `wszystko.json`). Nie poprawiaj ich ręcznie: zmień szablon lub dane i przebuduj.

**Jak działa build:** szablony mają znaczniki `{{DATA_JSON}}`, `{{KARTY_JSON}}`, `{{SYNC_URL}}`, `{{WERSJA}}` itd., a build wstrzykuje dane jako JSON prosto w stronę (strony nie pobierają danych w runtime). `{{WERSJA}}` to hash `wymowa.js` + `lista.js` + `lista.css` do cache-bustingu, więc po zmianie tych plików zawsze przebuduj. Nazwa nagrania to md5 znaków, więc zmiana znaków w karcie oznacza nowe nagranie.

**Talia kart:** `build_powtorka` składa karty ze wszystkich lekcji po numerze lekcji; przy powtórzonych znakach wygrywa pierwsze wystąpienie. Ta sama talia zasila powtórkę, ulubione i wyszukiwarkę na stronie głównej. `id` karty to jej znaki, a postęp powtórek i ulubione są zapisane po `id`, więc zmiana znaków w `lekcja.json` gubi postęp tej karty.

**Wspólny JS:** `wymowa.js` (odtwarzanie mp3 przez jeden `AudioContext` na stronę, mikrofon: Web Speech z zapasowym Whisperem w workerze, trener tonów) ładują wszystkie strony, więc poprawki audio i mikrofonu rób tylko tam i sprawdzaj wszystkie strony. `lista.js` + `lista.css` to lista zwrotów z wyszukiwarką i karta zwrotu (strona główna, ulubione).

**Worker (`worker/`):** synchronizacja postępu w KV (`/stan`), rozpoznawanie mowy Whisper (`/wymowa`), trener tonów przez Claude (`/trener`), proxy TTS (`/tts`). Adres workera jest w `sync.url`, build wstawia go do stron.

**Skille:** `/nowa-lekcja` (zdjęcia notatek z `inbox/`, potem `lekcja.json`, build i deploy) i `/scenka` (dialogi do lekcji, akcept dialogu przed budowaniem). Kroki i zasady w `.claude/skills/*/SKILL.md`.

## Pytania o chiński: najpierw karty

Gdy user pyta o cokolwiek po chińsku (słowo, zwrot, wymowę, „jak się mówi X”), najpierw sprawdź, co jest na kartach, dopiero potem odpowiadaj albo szukaj w internecie.

- Karty z lekcji: `lekcje/*/lekcja.json` (pole `polski` to zapis wymowy, `znaczenie` to tłumaczenie, `nazwa` sekcji np. „Chcę / nie chcę”). Wszystkie karty naraz: `powtorka/karty.json` (generowany przez `build.py`).
- Szukaj po polskim znaczeniu i po nazwach sekcji, nie tylko po znakach. Jedno polskie słowo może mieć kilka chińskich odpowiedników (np. „chcę”: 想 siang w lekcji 2, 愿意 jüen-i w lekcji 3, 要 jał tylko na stronie wymowy). Gdy pasuje kilka, pokaż wszystkie albo zapytaj, o które chodzi.
- `wymowa.json` (strony tony/dźwięki) to przykłady do ćwiczeń wymowy, nie karty z lekcji. Nie traktuj ich jako pierwszego źródła.
- W odpowiedzi używaj słowa i zapisu dokładnie takiego, jak na karcie.
