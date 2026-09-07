---
name: nowa-lekcja
description: Tworzy stronę nowej lekcji chińskiego ze zdjęć notatek wrzuconych do inbox/. Użyj gdy user mówi "nowa lekcja", "dodaj lekcję", "zrób lekcję ze zdjęć", "/nowa-lekcja".
---

# Nowa lekcja ze zdjęć

Repo: strony lekcji chińskiego. Każda lekcja = katalog `lekcje/NN-slug/` z `lekcja.json`, ze zdjęć generowany jest `index.html`, `notatki.md` i nagrania `audio/`. Wspólny indeks w `index.html` w katalogu głównym. Wszystko buduje `python3 build.py`.

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
6. **Zapis.** Utwórz `lekcje/NN-slug/lekcja.json` w formacie jak `lekcje/01-przyjaciele/lekcja.json` (`numer`, `tytul` = "Lekcja N · Temat", `data` = data lekcji jeśli na zdjęciu, inaczej dzisiejsza, `sekcje`). Przenieś zdjęcia z `inbox/` do `lekcje/NN-slug/zdjecia/`.
7. **Build.** `python3 build.py`. Sprawdź, że nie ma linii z `!` (błąd audio). Jeśli są, uruchom ponownie (Google czasem odrzuca request).
8. **Weryfikacja.** Pokaż userowi tabelę pozycji (znaki, pinyin, notatki, znaczenie) i poproś o potwierdzenie lub poprawki. Poprawki nanieś w `lekcja.json` i przebuduj.
9. **Deploy.** Po potwierdzeniu: `./deploy.sh "Lekcja N: temat"`. Podaj link: `https://kubi-dev.github.io/kubus/lekcje/NN-slug/` oraz indeks `https://kubi-dev.github.io/kubus/`. Strona pojawia się po ok. 1 min.

## Zasady
- Nie zmieniaj `template.html` ani `build.py` w ramach tego skilla. Jeśli notatki wymagają nowego typu treści, powiedz userowi.
- Nie deployuj przed potwierdzeniem usera (krok 8), chyba że user wprost każe "od razu wrzuć".
- Pisz JSON z `ensure_ascii` wyłączonym (znaki chińskie dosłownie), 2 spacje wcięcia.
