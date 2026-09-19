---
name: nowa-lekcja
description: Tworzy stronę nowej lekcji chińskiego ze zdjęć notatek wrzuconych do inbox/. Użyj gdy user mówi "nowa lekcja", "dodaj lekcję", "zrób lekcję ze zdjęć", "/nowa-lekcja".
---

# Nowa lekcja ze zdjęć

Repo: strony lekcji chińskiego. Każda lekcja = katalog `lekcje/NN-slug/` z `lekcja.json`, ze zdjęć generowany jest `index.html`, `notatki.md`, nagrania `audio/` i obrazki `obrazki/`. Wspólny indeks w `index.html` w katalogu głównym. Wszystko buduje `python3 build.py`.

## Kroki

1. **Zdjęcia.** Wylistuj `inbox/` (pomiń `.gitkeep`). Jeśli pusty, poproś usera o wrzucenie zdjęć do `inbox/` i zakończ. Jeśli user podał ścieżki do zdjęć w wiadomości, użyj ich.
2. **Numer i slug.** Numer = najwyższy istniejący numer w `lekcje/` + 1 (argument skilla może go nadpisać, np. `/nowa-lekcja 3`). Slug: krótki, ascii, małe litery, myślniki, z tematu lekcji (np. `02-jedzenie`). Katalog: `lekcje/NN-slug/`.
3. **Odczyt.** Obejrzyj KAŻDE zdjęcie narzędziem Read. Wypisz wszystkie znaki chińskie, pinyin i tłumaczenia z notatek. Zapis odręczny usera (fonetyka po polsku, wielkie litery, np. "PAN-JO") trafia do pola `notatki` dosłownie, nawet jeśli błędny. Nie poprawiaj go.
4. **Uzupełnienie.** Dla każdej pozycji:
   - `znaki` — poprawne znaki uproszczone, ze znakami interpunkcyjnymi chińskimi w zdaniach (。？)
   - `pinyin` — z tonami (diakrytyki), poprawny, nawet jeśli w notatkach brak
   - `polski` — zapis wymowy po polsku wg konwencji z `lekcje/01-przyjaciele/lekcja.json` (ch = polskie ch, y = polskie y, ł, ü, kh/ph/czh = z przydechem, dz/p = bez przydechu)
   - `notatki` — jak user zapisał (puste, jeśli nie zapisał)
   - `znaczenie` — format `english · polski`
5. **Sekcje.** Grupuj wg tego, co jest w notatkach (Słówka, Zdania, Gramatyka, Liczby…). Zachowaj kolejność ze zdjęć.
6. **Obrazki.** Do każdej pozycji, którą da się jednoznacznie pokazać na zdjęciu (rzeczowniki, jedzenie, przedmioty, zwierzęta, wyraziste emocje, flagi, gesty jak „kciuk w górę”), dobierz obrazek. Pomiń partykuły, spójniki, gramatykę, abstrakcje i zdania, dla których obraz byłby naciągany — brak obrazka jest lepszy niż mylący.
   - Zapytania po angielsku, konkretne (`"bowl of rice"`, nie `"rice"`; `"glass of water"`, nie `"water"`). Uruchom hurtowo: `python3 obrazki.py szukaj "q1" "q2" ...` (max ok. 15 zapytań na minutę — limit Openverse 20/min, 200/dzień). Dla każdego zapytania powstaje kolaż `.cache/obrazki/<slug>.png` z ponumerowanymi kandydatami.
   - Obejrzyj każdy kolaż narzędziem Read i wybierz numer: zdjęcie ma pokazywać znaczenie od razu, bez tekstu na obrazku, bez wieloznaczności. Jeśli nic nie pasuje, spróbuj innego zapytania lub `--wszystkie` (Flickr/Wikimedia, licencja CC BY z podpisem), a jak dalej nic — pomiń.
   - Wpisz wybory: `python3 obrazki.py wpisz lekcje/NN-slug/lekcja.json "znaki=slug:N" ...` (slug = nazwa pliku kolażu bez rozszerzenia). Ręcznie można też ustawić pole `obrazek` z własnym `url` (dozwolone licencje: CC0, domena publiczna, CC BY; przy CC BY wypełnij `autor` i `zrodlo`, strona pokaże podpis).
7. **Zapis.** Utwórz `lekcje/NN-slug/lekcja.json` w formacie jak `lekcje/01-przyjaciele/lekcja.json` (`numer`, `tytul` = "Lekcja N · Temat", `data` = data lekcji jeśli na zdjęciu, inaczej dzisiejsza, `sekcje`). Przenieś zdjęcia z `inbox/` do `lekcje/NN-slug/zdjecia/`.
8. **Build.** `python3 build.py`. Sprawdź, że nie ma linii z `!` (błąd audio lub obrazka). Jeśli są, uruchom ponownie (Google czasem odrzuca request); przy obrazku, który dalej nie schodzi, wybierz innego kandydata.
9. **Weryfikacja.** Pokaż userowi tabelę pozycji (znaki, pinyin, notatki, znaczenie, czy jest obrazek) i poproś o potwierdzenie lub poprawki. Poprawki nanieś w `lekcja.json` i przebuduj.
10. **Scenka.** Zaproponuj userowi scenkę do tej lekcji: „Zrobić scenkę? (/scenka N)”. Jeśli tak, wykonaj skill `scenka` przed deployem.
11. **Deploy.** Po potwierdzeniu: `./deploy.sh "Lekcja N: temat"`. Podaj link: `https://kubi-dev.github.io/kubus/lekcje/NN-slug/` oraz indeks `https://kubi-dev.github.io/kubus/`. Strona pojawia się po ok. 1 min.

## Zasady
- Nie zmieniaj `template.html`, `build.py` ani `obrazki.py` w ramach tego skilla. Jeśli notatki wymagają nowego typu treści, powiedz userowi.
- Nie deployuj przed potwierdzeniem usera (krok 8), chyba że user wprost każe "od razu wrzuć".
- Pisz JSON z `ensure_ascii` wyłączonym (znaki chińskie dosłownie), 2 spacje wcięcia.
