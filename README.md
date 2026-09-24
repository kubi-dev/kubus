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
`Wymowa.preload(url)`); martwy kontekst po uśpieniu karty (zegar stoi) jest wymieniany przy następnym dotknięciu.
Sesja audio (`navigator.audioSession.type`): `playback` bezczynnie, `play-and-record` od naciśnięcia mikrofonu do końca
nasłuchu (ustawiane przed `recognition.start()`, inaczej na iOS mikrofon Web Speech nagrywa ciszę). Po `onstart`
`getUserMedia` nagrywa równolegle: w dzienniku widać poziom nagrania, a gdy Web Speech nic nie zwróci mimo głosu,
tekst rozpoznaje Whisper (worker `/wymowa`). Silnik tylko-Whisper: `?silnik=chmura`, powrót: `?silnik=auto`.

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

## Tony i dźwięki
Dwie osobne strony z jednego szablonu `wymowa.html`: `tony/` (tylko melodia słowa; WSZYSTKIE słowa mają dźwięki, które Polak ma
z polskiego: m n l f s sz dz dź ś ł j oraz b d g = polskie p t k, bez wydechu/ü/e/-ng/twardego y/er, żeby uczyć jednej rzeczy naraz)
i `dzwieki/` (dźwięki, których polski nie ma, jedna grupa naraz, na końcu liczby 1–10 jako „wszystko razem”).
Dane w `wymowa.json` (źródło prawdy, edytuj tu):
`wstep` (zasada, znaczki nad literami), `tony` (5 kart: co robi głos, polska sytuacja, ćwiczenie „powiedz po polsku… teraz tak samo…”,
błąd Polaków, słowa), `zmiany_tonow` (dwa/trzy niskie, 不, 一, lekkie końcówki), `zdania` (polski nacisk, pytanie bez podnoszenia
głosu, ręka), `koniec` (liczby 1–10, strona dźwięków), `pary_tonow` (20 par 1–4 × 1–4 plus 4 z lekkim tonem, kolejność od najtrudniejszych dla Polaka),
`minimalne_pary_tonow` (te same litery, inny ton), `dzwieki` (grupy od najtrudniejszej: wydech p/b t/d k/g i c/z ch/zh q/j, ü/u,
twarde „y” po z c s zh ch sh r, e, -n/-ng, r, ukryte litery -ian -iu -ui -un -ong, er, „masz za darmo”: trzy szeregi, h, ł, aj/ej/ał/oł).
Każdy wpis: `znaki`, `pinyin`, `polski` (zapis wg konwencji notatek), `znaczenie`; build dopisuje `lekcja`, gdy słowo jest w lekcjach
(znaczek L1/L2/L3). `build.py` (`build_wymowa`, tabela `STRONY_WYMOWY`) nagrywa mp3 (wolno i normalnie) do `tony/audio/` i `dzwieki/audio/` i składa obie strony.
Strona: każde słowo ▶ i 🎤 (ten sam `wymowa.js`, trener tonów działa jak w lekcjach), siatka par tonów, pary słów obok siebie
(rozpoznanie drugiego słowa z pary = osobny komunikat), ćwiczenia „Który ton?” (pojedyncze słowa, ton z pinyinu w danych),
„Które słowo?” (pary tonów i dźwięków), „Powiedz to” (tylko słowa z ≥ 2 znaków, bo pojedyncze telefon rozpoznaje losowo).
Licznik wpadek per ton/grupa w `localStorage kubus.wymowa.stat.<strona>`, lista „co ci najczęściej ucieka” linkuje do sekcji.
Treść powstała z badania (tony i dźwięki trudne dla Polaków, metody ćwiczeń) i została sprawdzona pod kątem chińskiego i prostego polskiego.

## Powtórki
- Strona `powtorka/` (SM-2 jak w Anki). Karta A: obrazek + polskie znaczenie, mówisz po chińsku (mikrofon). Karta B: audio po chińsku, wybierasz znaczenie, po dojrzeniu karty wpisujesz; obrazek pokazuje się po odsłonięciu.
- Gwiazdka ☆ na karcie (w powtórce, na stronie lekcji, na karcie z wyszukiwarki) dodaje zwrot do ulubionych. Strona `ulubione/` to ściąga na rozmowę: lista po polsku (z wyszukiwarką), dotknięcie otwiera kartę ze znakami, pinyin, zapisem polskim, nagraniem i mikrofonem. Ulubione są w tym samym stanie co postęp (pole `ulubione`), więc synchronizują się między urządzeniami.
- Strona główna ma tę samą wyszukiwarkę po wszystkich zwrotach z lekcji (ta sama talia co powtórka): wpisanie tekstu chowa linki i pokazuje pasujące zwroty, dotknięcie otwiera tę samą kartę co w ulubionych. Lista i karta to wspólny moduł `lista.js` + `lista.css` (`Lista.start({karty, baza, filtr, bezZapytania, …})`), używany przez `glowna.html` i `ulubione.html`.
- Postęp w `localStorage` + synchronizacja przez Cloudflare Worker (`worker/`, opis w `worker/README.md`). Adres workera w pliku `sync.url`, klucz podajesz stronie linkiem `powtorka/?k=<klucz>`.

## Struktura
```
template.html            szablon strony lekcji
obrazki.py               szukanie obrazków do kart (Openverse)
powtorka.html            szablon strony powtórek
podcast.html             szablon strony podcastu
scenki.html              szablon strony scenek
wymowa.html              szablon stron tony/ i dzwieki/
wymowa.json              treść obu stron (źródło prawdy)
podcast.py               składanie odcinków mp3 (polski → chiński → pauza)
scenki.py                sprawdzanie i wpisywanie scenek (dialogów) do lekcji
ulubione.html            szablon strony ulubionych zwrotów
glowna.html              szablon strony głównej (linki + wyszukiwarka po wszystkich zwrotach)
lista.js, lista.css      wspólny moduł listy zwrotów z wyszukiwarką i karty zwrotu (strona główna, ulubione)
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
tony/, dzwieki/          wygenerowane strony tonów i dźwięków + audio/
ulubione/                wygenerowana strona ulubionych
index.html               wygenerowana strona główna
```
