---
name: scenka
description: Tworzy scenki rodzajowe (mini dialogi) do lekcji chińskiego z poznanego słownictwa i buduje z nich odcinki podcastu. Użyj gdy user mówi "scenka", "dialog do lekcji", "zrób scenkę", "/scenka" (opcjonalnie numer lekcji: "/scenka 3").
---

# Scenka do lekcji

Scenka = krótki dialog (6–10 kwestii, dwie osoby) w sytuacji z życia, zbudowany z tego, co user już zna. Zapis w `lekcje/NN-slug/scenki.json`
(format w nagłówku `scenki.py`). `build.py` robi z niej odcinek podcastu (`lekcje/NN-slug/scenka-<id>.mp3`) i pokazuje na stronie `podcast/`
z transkrypcją. Jedna z osób to zawsze **Kubi** (user); pole `ty` wskazuje jego rolę, w odcinku user odpowiada za tę osobę.

## Kroki

1. **Lekcja.** Argument skilla = numer lekcji; bez argumentu weź najwyższy numer w `lekcje/`. Katalog `lekcje/NN-slug/`.
2. **Słownictwo.** `python3 scenki.py slownictwo lekcje/NN-slug` — lista wszystkiego, co user zna do tej lekcji włącznie. Tylko z tego budujesz dialog.
3. **Scenki.** Napisz 1–2 scenki (2, gdy lekcja ma > 20 pozycji). Każda w innej sytuacji, pasującej do tematu lekcji (lekcja o jedzeniu → restauracja, kawa z kolegą).
   - Co najmniej 75% znaków w dialogu ze znanego słownictwa. Nowe słowa (max 25% znaków, zwykle 3–6 słów) tylko wtedy, gdy bez nich dialog byłby sztuczny (谢谢, 请, 你呢, 多少钱). Wypisz je w `nowe` z `pinyin`, `polski` (zapis wymowy wg konwencji z `lekcje/01-przyjaciele/lekcja.json`), `znaczenie` (`english · polski`).
   - Zdania krótkie, naturalne, ze znaną gramatyką. Powtarzaj zwroty z lekcji dosłownie (jeśli lekcja ma 我想吃饺子, użyj tego, nie wariantu).
   - Każda kwestia: `kto` (A/B), `znaki` (interpunkcja chińska 。？！，), `pinyin` z tonami, `polski` (naturalne tłumaczenie, nie dosłowne).
   - `opis`: 1–2 zdania po polsku, o czym jest scenka; lektor czyta to na początku odcinka.
4. **Sprawdzenie.** `python3 scenki.py sprawdz lekcje/NN-slug`. Musi być `OK` dla każdej scenki. Jeśli `BŁĄD`: znaki spoza słownictwa dopisz do `nowe` albo przeredaguj dialog, aż pokrycie ≥ 75%.
5. **Nowe słowa do lekcji.** `python3 scenki.py wpisz lekcje/NN-slug` — dopisuje `nowe` do `lekcja.json` (sekcja „Ze scenek”), dzięki czemu trafiają do kart, powtórek i następnych scenek.
6. **Build.** `python3 build.py` (nagrania kwestii i nowych słów, odcinki mp3, strona podcastu). Linie z `!` = błąd, uruchom ponownie.
7. **Weryfikacja.** Pokaż userowi dialog (kto, znaki, pinyin, polski) i listę nowych słów. Popraw wg uwag, przebuduj.
8. **Deploy.** Po potwierdzeniu `./deploy.sh "Scenka: tytuł (lekcja N)"`. Link: `https://kubi-dev.github.io/kubus/podcast/`.

## Zasady
- Sceny towarzyskie (impreza, kawa, poznawanie kogoś) zawsze z **koleżanką / dziewczyną** (np. 李美 Lǐ Měi), nie z kolegą. Kubi jest uprzejmy i lekko flirtuje (你很美丽, 你很可爱, 我们明天见？). Role usługowe (kelnerka, sprzedawczyni) też kobiece.
- Nie zmieniaj `build.py`, `podcast.py`, `scenki.py`. Jeśli scenka wymaga innej struktury, powiedz userowi.
- Nie deployuj przed potwierdzeniem, chyba że user każe „od razu wrzuć”.
- JSON z `ensure_ascii` wyłączonym, 2 spacje wcięcia, jedna kwestia na linię.
