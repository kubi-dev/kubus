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
tekst rozpoznaje Whisper (worker `/wymowa`). Domyślny silnik to tylko-Whisper (`chmura`, gdy strona ma adres workera i klucz), bo Web Speech
na iOS zgaduje krótkie słowa (nagranie 愿意 puszczone do mikrofonu: Web Speech 1 na 3, Whisper 3 na 3). Web Speech: `?silnik=auto`, powrót: `?silnik=chmura`.
Silnik chmura prosi o mikrofon (`getUserMedia`) od razu w geście, przed budzeniem kontekstu. Gdy mikrofon nie ruszy w 5 s albo start
się nie uda, strona sama wysyła dziennik mikrofonu do workera (`/dziennik`, KV „dziennik:”, 7 dni), razem z tym, czy mikrofon ruszył
później. Sprawdzanie: `npx wrangler kv key list --namespace-id 7448e16e7ce244db8bb779f8cdc58a08 --prefix dziennik: --remote` (z `worker/`).
Każda strona przy wyjściu (inna karta, inna strona, blokada telefonu) zwalnia mikrofon i granie i zamyka swój kontekst, a przy
wejściu (też z bfcache i z innej karty) zapisuje `playback` od nowa; kontekst powstaje w pierwszym geście. Sesja audio iOS jest wspólna
dla stron i kart, więc żadna strona nie polega na tym, co zostawiła poprzednia. Uśpiony kontekst w geście jest wymieniany, nie budzony
(resume() na iPhonie potrafi nie wrócić). Nagranie z samych zer (telefon nie dał dźwięku z mikrofonu) = komunikat, nowy kontekst przy
następnym naciśnięciu i dziennik do workera (KV „dziennik:”, powód `cisza`).

## Trener tonów
Po każdym wyniku mikrofonu (poza idealnym) strona rysuje wykres tonów sylaba po sylabie: kontur celu na górze, usłyszany na dole,
złe sylaby na czerwono. Liczone w przeglądarce z `pinyin-pro` (tony usłyszane wynikają ze znaków zwróconych przez rozpoznawanie:
homofon z innym tonem = zły ton), bez żadnego requestu. Przycisk „Spytaj trenera” wysyła do workera (`POST /trener`, Claude Opus 5)
mały JSON z celem, usłyszanym tekstem i sylabami; wraca diagnoza po polsku, wskazówka przez polski przykład z życia i ćwiczenie
(słowo z tym samym tonem, zapis polski w konwencji notatek, nagranie wolno przez `GET /tts`, własny mikrofon). Licznik wpadek per ton
w `localStorage kubus.tony`. Worker potrzebuje sekretu `ANTHROPIC_API_KEY` (`npx wrangler secret put ANTHROPIC_API_KEY`).

## Linia głosu (wysokość dźwięku)
Przy każdym mikrofonie, od naciśnięcia do puszczenia, działa ekran mówienia: strona znika pod warstwą w kolorze tła
z „dziurą” na guzik (guzik się nie rusza), a tuż nad guzikiem (pod nim, gdy nad nim brak miejsca) jest blok: polska wymowa,
melodia sylab słowami z notatek („Cooo? · końcówka”, tony z pinyinu karty, dwa 3. tony pod rząd jak 你好), znaczenie,
szara linia lektora i twoja niebieska rysowana na żywo. Strony podają treść w `Wymowa.bind(..., { ekran })`; powtórka,
karta „powiedz po chińsku”: tylko znaczenie i wykres (`bezWymowy`), bo wymowa zdradziłaby odpowiedź. Po puszczeniu
wraca zwykły ekran, a pod wynikiem jest ten sam wykres (obie linie rozciągnięte na całą szerokość, liczy się kształt). Wysokość liczy `wymowa.js` w przeglądarce (YIN na 16 kHz, ramka 25 ms co 10 ms),
z tego samego nagrania getUserMedia co Whisper; linię lektora z mp3 karty (strony podają `audio` w `Wymowa.bind`).
Każda ramka daje kilku kandydatów (dołki YIN), a `linia()` wybiera z nich ciągłą ścieżkę (Viterbi: głębokie dołki, bez skoków).
Pojedyncza ramka, zwłaszcza pierwsza po wejściu głosu, często myli się o oktawę. Stary pomiar poprawiał każdą ramkę względem
poprzedniej, więc zły początek przesuwał całą linię o oktawę: na próbach usera z 19.10.2026 było to 20% ramek i 7 z 51 startów.
Nowy pomiar porównany z Praatem: 0,1% ramek z błędem ponad 2 półtony, 0 złych startów, u lektora 0,0%. Ocena tonów na nagraniach lektora
bez zmian (zero fałszywych „źle”, ok. 64% podmienionych tonów wyłapane). Całych kawałków nie przesuwamy o oktawę, bo 4. ton lektorki naprawdę tyle spada.
Półtony względem środka głosu mówiącego, więc niski męski głos i wysoki lektorki dają porównywalne kształty.
Twój zwykły głos: `localStorage kubus.wymowa.glosy`, mediana z ostatnich 9 prób (stała linia od pierwszej chwili mówienia). Uczy się z mowy
(lekcje, powtórka) i z „Aaaa” zwykle (`zwykly` w `Wymowa.bind`); inne ćwiczenia melodii (`tylkoGlos`) nie, bo są celowo wysoko albo nisko.
Stary klucz `kubus.wymowa.glos` (wysokie ćwiczenia i linie o oktawę obok wywindowały go ze 100 do ok. 230 Hz) jest kasowany.

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
Strona: każde słowo ▶ i 🎤, siatka par tonów, pary słów obok siebie, ćwiczenia „Który ton?” (pojedyncze słowa, ton z pinyinu
w danych; po odpowiedzi to słowo z mikrofonem), „Które słowo?” (pary tonów i dźwięków), „Powiedz to”.
Na `dzwieki/` mikrofon rozpoznaje słowa jak w lekcjach (rozpoznanie drugiego słowa z pary = osobny komunikat, „Powiedz to” tylko
słowa z ≥ 2 znaków, bo pojedyncze telefon rozpoznaje losowo).

Na `tony/` mikrofon słucha tylko melodii (`Wymowa.bind(..., { tylkoGlos, tony })`): nagranie bez Whispera, ocena w przeglądarce
z linii głosu (`ocenTony` w `wymowa.js`), więc działa też na pojedynczych sylabach i bez klucza workera. Linia dzielona na sylaby
(cięcie w przerwie w głosie, bez przerwy w szczycie po 2. tonie albo w dołku po 3. i 4., inaczej po czasie; lekka końcówka liczy się
za pół), z każdej sylaby środek w półtonach i kształt: równo, w górę, dołek / nisko, w dół. Ocena łagodna: „źle” tylko przy wyraźnie
innym kształcie, z polskim słowem z notatek („ma być „Cooo?”, wyszło jak „Aaaa” u lekarza”); lekkiej końcówki nie ocenia. Tony do
powiedzenia z pinyinu słowa ze zmianami (`Wymowa.tonyMowione`: dwa 3. pod rząd = 2. i 3.; z trzech pierwsze może być 2. albo 3.).
Sprawdzone na nagraniach lektora ze strony (213 sylab, zero „źle”) i na tych samych nagraniach z podmienionym celem (wykrywa ok. 60%
złych tonów; prawie nigdy: 3. powiedziany zamiast 4. i, w słowach, 4. zamiast 3.). Karty tonów: najpierw polskie słowo z notatek do mikrofonu
na wzorze melodii (`po_polsku` w `wymowa.json`, `Wymowa.wzorTonu`), potem chińskie słowa tak samo; pod znakami melodia każdej sylaby.
Wynik: wykres (skala z linii na wykresie, źle powiedziana sylaba na pomarańczowo) i sylaby ze znaczkiem. Próba z oceną idzie do
workera (`/wymowa?zapis=1&ocena=`, KV „nagranie:”, 7 dni) do sprawdzania oceny na prawdziwym głosie.
Sekcja „Wysoko i nisko” na początku (`wysoko_nisko` w `wymowa.json`): czym jest wysoko i nisko (tylko na polskich słowach z notatek: koniec „Cooo?” = wysoko, koniec „Noooo…” = nisko, „poproszę bułkę” = zwykle),
„Aaaa” na trzech wysokościach (zwykle / wysoko ≥ 3,5 półtona / nisko ≤ −2 półtony względem zwykłego głosu) i „Start od razu na górze”
(„Hej!”, „Heeej!”, „Nie!”: wydech „hhh” przed słowem, usłyszeć koniec „Cooo?” w głowie; mikrofon łapie podjeżdżanie od dołu, `startGlosu`).
Na końcu sekcji gierka „wyżej / niżej” (`gierka` w `wymowa.json`, `gierka()` w `wymowa.html`): tylko duży napis „↑ wyżej” / „↓ niżej”,
bez wyznaczonych wysokości; w tle napisu przygaszona linia głosu z ostatnich 3 s i kropka tam, gdzie głos jest teraz (środek = głos na starcie, ±12 półtonów). Liczy się ruch głosu od miejsca, w którym był przy poleceniu: o 2,5 półtona w tę stronę
(mediana z ostatnich 250 ms) = „✓”, potem następne polecenie losowo (dalej niż 9 półtonów od startu = w drugą stronę). Ten sam mikrofon
co reszta (`Wymowa.bind` z `naZywo`: bez ekranu mówienia, co klatkę głos na żywo, `maxMs: 30000`), próba idzie do KV jak inne ćwiczenia melodii. Bez zapamiętanego zwykłego głosu „wysoko”, „nisko” i „Start od razu na górze” nie oceniają, tylko odsyłają do „Aaaa” zwykle.
Sekcja „Nie!” z góry, „Noooo…” z dołu (`trudne_tony` w `wymowa.json`): kroki po polsku („Cooo? Nie!”, „Nie!”, „Nie! Noooo…”,
„Noooo…”, wzór z punktów `wzor`/`ramki` przez `Wymowa.wzorLinii`), potem chińskie pary 2-4 / 4-3 i pojedyncze słowa. Mikrofon z opcją
`wysokosc` ocenia oprócz kształtu wysokość względem twojego zwykłego głosu (`Wymowa.wysokoscTonow`): 4. ton ma zacząć ≥ 4 półtony
nad zwykłym głosem (po 2. tonie: nie niżej niż 3 półtony pod końcem „Cooo?”), spaść ≥ 5 półtonów i nie iść najpierw w górę; 3. ton
zaczyna zwykłym głosem albo niżej (po 4.: na dole), bez podskoku przed zejściem. Wykres: środkowa kreska = twój zwykły głos.
Sprawdzone na nagraniach lektora (52 słowa, 1 fałszywe „źle”) i na próbach usera z 19.10.2026 (płaskie „Nie!” i „Noooo…” z podskokiem wyłapane).
Licznik wpadek per ton/grupa w `localStorage kubus.wymowa.stat.<strona>`, lista „co ci najczęściej ucieka” linkuje do sekcji.
Treść powstała z badania (tony i dźwięki trudne dla Polaków, metody ćwiczeń) i została sprawdzona pod kątem chińskiego i prostego polskiego.

## Materiały dodatkowe (HSK)
Druga ścieżka słówek obok lekcji: `materialy/<slug>/lekcja.json` w tym samym formacie co lekcja, plus `"sciezka": "hsk"`, `"opis"`
i `"zrodlo"` (link do oryginału na stronie). Build robi z niej stronę jak lekcję (bez podcastu i scenek) i dokłada karty do talii
po lekcjach; zwrot, który jest już na karcie z lekcji, zostaje tylko na stronie materiału. Nagrania i obrazki pochodzą z oryginału
i leżą w repo (`audio/`, `obrazki/`, pole `obrazek.plik`), build niczego nie pobiera z Google TTS: brak pliku = błąd `!`.
`materialy/hsk1/`: 64 zwroty HSK 1 z filmu https://www.youtube.com/watch?v=6ozVFwyxvio (Andy and Sarah Mandarin). Na każdy zwrot
w filmie jest kobieta mówiąca normalnie i mężczyzna mówiący wolno: `<klucz>.mp3` = kobieta, `<klucz>-slow.mp3` („wolniej”) = mężczyzna.
Obrazki to kadry z filmu z rozmytym miejscem na napisy (chiński na obrazku zdradzałby odpowiedź na karcie).
Wyjątek: sekcja „Ty jesteś…” (你很漂亮。, 你很苗条。, 你很性感。) była w filmie o „niej” (她很…); nagrania tych trzech kart
są z Google TTS (pobrane raz ręcznie przez `ensure_audio`, leżą w repo), obrazki zostały z filmu.

## Zapis polski (słownik sylab)
`zapis.json`: każda sylaba pinyin -> zapis po polsku (z lekkim tonem osobno: 了 la, 们 men) i kilka wyjątków według ucha (什么 szen-ma,
的/得 da, 哪儿 nar). Odtwarza zapis wszystkich kart z lekcji i słów ze stron tonów i dźwięków. `python3 zapis.py sprawdz` pokazuje karty
niezgodne ze słownikiem, `wpisz` je poprawia, `zapisz "znaki" "pinyin"` daje zapis nowej karty. Sprawdzone na nagraniach HSK (pomiar
samogłosek obu lektorów i ucho usera, 2026-10-18): lekkie e = „a”, -en = „en” (很 chen, 人 żen, 吻 łen, 春 czhłen; wcześniej „yn”), -eng = „ang” (朋友 phang-joł, 生 szang, 冷 lang; wcześniej „yng”), 而/二 = „ar”.

## Powtórki
- Nowe karty dziennie: najpierw z lekcji, po kolei (ustawienie „Nowych kart dziennie”, domyślnie 10), do tego 5 z materiałów dodatkowych (`HSK_DZIENNIE` w `powtorka.html`). Gdy nowych z lekcji brakuje, materiały dopełniają do limitu. Materiały idą w losowej kolejności (ziarno = data, więc w ciągu dnia ta sama), bo kolejne zwroty często powtarzają ten sam schemat. Licznik dnia: `dzien.nowe` (lekcje) i `dzien.hsk` (materiały).
- Odstępy (funkcja `ocen` w `powtorka.html`): nowa karta i karta po „nie wiem”: trudno i dobrze 1 dzień, łatwo 3 dni. Karta po przerwie: trudno zawsze przynajmniej dzień dłużej niż dotąd, dobrze dłużej niż trudno, łatwo dłużej niż dobrze. Mnożnik karty (`ef`, start 2,5, dno 1,3) karany najwyżej raz dziennie (`kara` = data kary): „nie wiem” −0,2, „trudno” −0,15, kolejne pomyłki tego dnia nic nie odejmują; „łatwo” +0,15. Przycisk „jeszcze raz dziś” odsyła kartę na koniec sesji bez zmiany jej stanu. Do 2026-10-26 „dobrze” przy 1 dniu i mnożniku 1,3 dawało znowu 1 dzień (zaokrąglenie), a „trudno” przy 1 dniu zawsze 1 dzień, więc karty utykały na „jutro”; jednorazowa naprawa (`naprawZablokowane`, znacznik `kubus.powtorka.naprawa-1` w localStorage, po pierwszej synchronizacji) dała kartom z co najmniej 3 udanymi odpowiedziami z rzędu i mnożnikiem na dnie mnożnik 2,0.
- Strona `powtorka/` (SM-2 jak w Anki). Karta A: obrazek + polskie znaczenie, mówisz po chińsku (mikrofon). Karta B: audio po chińsku, wybierasz znaczenie, po dojrzeniu karty wpisujesz; obrazek pokazuje się po odsłonięciu.
- Znaczenie słowo po słowie (pole `doslownie` w `lekcja.json`, tylko pozycje dłuższe niż jedno słowo) stoi małymi literami pod zapisem polskim na każdej karcie: w powtórce razem z wymową (karta A: po podpowiedzi albo odsłonięciu, miejsce zarezerwowane, żeby guzik nie skakał), na karcie z wyszukiwarki i ulubionych, na stronie lekcji. Jedno polskie słowo na każde słowo z zapisu polskiego, nawias to słówko gramatyczne: `móc · całować · ty · (pytanie)`.
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
zapis.json, zapis.py     słownik zapisu polskiego (sylaba -> zapis) i sprawdzanie/poprawianie kart
materialy/<slug>/        materiały dodatkowe (druga ścieżka, np. HSK): lekcja.json + gotowe audio/ i obrazki/ z oryginału
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
