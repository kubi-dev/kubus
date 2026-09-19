# Notatki z chińskiego

Strona: https://kubi-dev.github.io/kubus/

## Nowa lekcja
1. Zdjęcia notatek do `inbox/`.
2. W Claude Code: `/nowa-lekcja` (opcjonalnie numer: `/nowa-lekcja 3`).
3. Potwierdź tabelę, Claude robi build i deploy.

## Ręcznie
- `python3 build.py` — buduje wszystkie strony + nagrania mp3 + obrazki (tylko brakujące).
- `python3 obrazki.py szukaj "bowl of rice" ...` — kolaż kandydatów z Openverse (CC0 / CC BY) do `.cache/obrazki/`; `python3 obrazki.py wpisz lekcje/NN/lekcja.json "米饭=bowl-of-rice:3"` wpisuje wybór do pola `obrazek`. Build pobiera i zmniejsza obrazek do `obrazki/`. Robi to skill `/nowa-lekcja`.
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

## Trener tonów
Po każdym wyniku mikrofonu (poza idealnym) strona rysuje wykres tonów sylaba po sylabie: kontur celu na górze, usłyszany na dole,
złe sylaby na czerwono. Liczone w przeglądarce z `pinyin-pro` (tony usłyszane wynikają ze znaków zwróconych przez rozpoznawanie:
homofon z innym tonem = zły ton), bez żadnego requestu. Przycisk „Spytaj trenera” wysyła do workera (`POST /trener`, Claude Opus 5)
mały JSON z celem, usłyszanym tekstem i sylabami; wraca diagnoza po polsku, wskazówka przez polski przykład z życia i ćwiczenie
(słowo z tym samym tonem, zapis polski w konwencji notatek, nagranie wolno przez `GET /tts`, własny mikrofon). Licznik wpadek per ton
w `localStorage kubus.tony`. Worker potrzebuje sekretu `ANTHROPIC_API_KEY` (`npx wrangler secret put ANTHROPIC_API_KEY`).

## Powtórki
- Strona `powtorka/` (SM-2 jak w Anki). Karta A: obrazek + polskie znaczenie, mówisz po chińsku (mikrofon). Karta B: audio po chińsku, wybierasz znaczenie, po dojrzeniu karty wpisujesz; obrazek pokazuje się po odsłonięciu.
- Gwiazdka ☆ na karcie (w powtórce i na stronie lekcji) dodaje zwrot do ulubionych. Strona `ulubione/` to ściąga na rozmowę: lista po polsku (z wyszukiwarką), dotknięcie otwiera kartę ze znakami, pinyin, zapisem polskim, nagraniem i mikrofonem. Ulubione są w tym samym stanie co postęp (pole `ulubione`), więc synchronizują się między urządzeniami.
- Postęp w `localStorage` + synchronizacja przez Cloudflare Worker (`worker/`, opis w `worker/README.md`). Adres workera w pliku `sync.url`, klucz podajesz stronie linkiem `powtorka/?k=<klucz>`.

## Struktura
```
template.html            szablon strony lekcji
obrazki.py               szukanie obrazków do kart (Openverse)
powtorka.html            szablon strony powtórek
ulubione.html            szablon strony ulubionych zwrotów
wymowa.js                wspólny moduł: odtwarzanie mp3 (Web Audio) + sprawdzanie wymowy (mikrofon)
worker/                  Cloudflare Worker synchronizacji postępu
build.py                 generator
lekcje/NN-slug/
  lekcja.json            dane (źródło prawdy, edytuj tu)
  zdjecia/               zdjęcia notatek
  audio/                 mp3 generowane z Google TTS
  obrazki/               obrazki kart (pobrane wg pola "obrazek" w lekcja.json, zmniejszone do 640 px)
  index.html, notatki.md wygenerowane
powtorka/                wygenerowana strona powtórek + karty.json
ulubione/                wygenerowana strona ulubionych
index.html               wygenerowany indeks lekcji
```
