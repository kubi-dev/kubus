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

## Podcast
Strona `podcast/`: odcinek do każdej lekcji (`lekcje/NN/podcast.mp3`) i zbiorczy ze wszystkich zwrotów (`podcast/wszystko.mp3`).
Buduje `podcast.py` (wołany z `build.py`): polski lektor (Google TTS `tl=pl`, pliki `audio/pl-*.mp3`) + istniejące mp3 chińskie
(wolne i normalne) + cisza, sklejone przez ffmpeg. Schemat jak u Pimsleura: nowy zwrot = polski, chiński wolno, pauza, chiński
normalnie, pauza; 4 zwroty później i na końcu odcinka przypomnienie = polski, pauza (mówisz sam), chiński. Odcinek zbiorczy to
same przypomnienia, dwa przejścia w losowej kolejności. Manifest (`podcast.json`, `wszystko.json`) pomija przebudowę, gdy nic się
nie zmieniło. Odtwarzacz zapamiętuje miejsce i tempo (`localStorage kubus.podcast.*`).

## Scenki
`lekcje/NN/scenki.json`: 1–2 mini dialogi (dwie osoby, jedna to Kubi) z poznanego słownictwa, pisane skillem `/scenka`.
`python3 scenki.py sprawdz lekcje/NN` pilnuje, że ≥ 75% znaków dialogu jest ze słownictwa do tej lekcji włącznie, a reszta jest
w polu `nowe`; `python3 scenki.py wpisz lekcje/NN` dopisuje `nowe` do `lekcja.json` (sekcja „Ze scenek”, pole `"auto": "scenka"`,
strona lekcji pokazuje znaczek „✦ ze scenki”), więc trafiają do kart, powtórek i podcastu. `build.py` nagrywa kwestie i składa odcinek
`lekcje/NN/scenka-<id>.mp3`: tytuł i opis po polsku, cała rozmowa, po kolei (polski, chiński wolno, pauza, chiński, pauza), na końcu
user gra swoją rolę (słyszy kwestie drugiej osoby, po polskiej podpowiedzi mówi swoją, słyszy odpowiedź). Strona `scenki/` grupuje
scenki lekcjami, z dialogiem (znaki, pinyin, polski). Strona lekcji linkuje do swojego odcinka podcastu i scenek.

## Powtórki
- Strona `powtorka/` (SM-2 jak w Anki). Karta A: obrazek + polskie znaczenie, mówisz po chińsku (mikrofon). Karta B: audio po chińsku, wybierasz znaczenie, po dojrzeniu karty wpisujesz; obrazek pokazuje się po odsłonięciu.
- Gwiazdka ☆ na karcie (w powtórce i na stronie lekcji) dodaje zwrot do ulubionych. Strona `ulubione/` to ściąga na rozmowę: lista po polsku (z wyszukiwarką), dotknięcie otwiera kartę ze znakami, pinyin, zapisem polskim, nagraniem i mikrofonem. Ulubione są w tym samym stanie co postęp (pole `ulubione`), więc synchronizują się między urządzeniami.
- Postęp w `localStorage` + synchronizacja przez Cloudflare Worker (`worker/`, opis w `worker/README.md`). Adres workera w pliku `sync.url`, klucz podajesz stronie linkiem `powtorka/?k=<klucz>`.

## Struktura
```
template.html            szablon strony lekcji
obrazki.py               szukanie obrazków do kart (Openverse)
powtorka.html            szablon strony powtórek
podcast.html             szablon strony podcastu
scenki.html              szablon strony scenek
podcast.py               składanie odcinków mp3 (polski → chiński → pauza)
scenki.py                sprawdzanie i wpisywanie scenek (dialogów) do lekcji
ulubione.html            szablon strony ulubionych zwrotów
wymowa.js                wspólny moduł: odtwarzanie mp3 (Web Audio) + sprawdzanie wymowy (mikrofon)
worker/                  Cloudflare Worker synchronizacji postępu
build.py                 generator
lekcje/NN-slug/
  lekcja.json            dane (źródło prawdy, edytuj tu)
  scenki.json            dialogi do lekcji (skill /scenka)
  podcast.mp3, scenka-*.mp3  odcinki podcastu (buduje podcast.py)
  zdjecia/               zdjęcia notatek
  audio/                 mp3 generowane z Google TTS
  obrazki/               obrazki kart (pobrane wg pola "obrazek" w lekcja.json, zmniejszone do 640 px)
  index.html, notatki.md wygenerowane
powtorka/                wygenerowana strona powtórek + karty.json
podcast/                 wygenerowana strona podcastu + wszystko.mp3
scenki/                  wygenerowana strona scenek
ulubione/                wygenerowana strona ulubionych
index.html               wygenerowany indeks lekcji
```
