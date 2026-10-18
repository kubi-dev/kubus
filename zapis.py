#!/usr/bin/env python3
"""Słownik zapisu polskiego: każda chińska sylaba -> zapis wymowy po polsku (konwencja notatek).

Źródło prawdy: zapis.json. "sylaby": sylaba pinyin bez tonu -> zapis (obiekt {"ton", "lekki"}, gdy z lekkim tonem brzmi
inaczej: 了 la, 们 men). "wyjatki": znaki -> zapis według ucha usera (wygrywają ze słownikiem, najdłuższe dopasowanie).
Ton i podział na sylaby bierze z pola pinyin karty, więc zmiany tonów (不 bú, 一 yí) i lekkie końcówki są takie jak na karcie.
Podział na słowa (spacje i myślniki) zostaje taki, jak w obecnym polu polski karty.

Użycie: python3 zapis.py sprawdz                 # karty, których pole polski różni się od słownika (lekcje i materiały)
        python3 zapis.py wpisz                   # poprawia pole polski w lekcja.json; potem scenki.py wymowa i build
        python3 zapis.py zapisz "我想吃。" "Wǒ xiǎng chī."   # zapis ze słownika dla nowej karty (sylaby myślnikami)
"""
import json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent
SLOWNIK = json.loads((ROOT / "zapis.json").read_text(encoding="utf-8"))
SYLABY, WYJATKI = SLOWNIK["sylaby"], SLOWNIK["wyjatki"]
HAN = re.compile(r"[一-鿿]")
LACINA = re.compile(r"[A-Za-z]+")
TON = {}
for ton, litery in enumerate(("āēīōūǖ", "áéíóúǘ", "ǎěǐǒǔǚ", "àèìòùǜ"), 1):
    for z, baza in zip(litery, "aeiouü"): TON[z] = (baza, ton)

def sylaby(pinyin, n):
    """Pinyin karty -> n sylab [(sylaba bez tonu, ton 0-4)]; zapis łączny (péngyou) dzielony tak, żeby wyszło n sylab."""
    slowa = re.findall(r"[a-zü" + "".join(TON) + "]+", pinyin.lower())
    def podziel(s):
        if not s: return [[]]
        out = []
        for j in range(min(len(s), 6), 0, -1):
            baza = "".join(TON.get(c, (c,))[0] for c in s[:j])
            if baza in SYLABY:
                ton = next((TON[c][1] for c in s[:j] if c in TON), 0)
                out += [[(baza, ton)] + r for r in podziel(s[j:])]
        return out
    def zle(podzial):  # sylaba w środku słowa nie zaczyna się od a/e/o (pinyin dałby apostrof: xī'ān), więc dàngāo = dàn-gāo
        return sum(s[0] in "aeo" for s, _ in podzial[1:])
    wynik = [[]]
    for s in slowa:
        czesci = sorted(podziel(s), key=zle)
        wynik = [w + r for w in wynik for r in czesci]
    wynik = [w for w in wynik if len(w) == n]
    return wynik[0] if wynik else None

def zapis_sylab(znaki, pinyin):
    """Lista zapisów sylab (po jednej na znak chiński) albo None, gdy pinyin nie pasuje do znaków."""
    han = HAN.findall(znaki)
    if "".join(han) in WYJATKI: return re.split(r"[- ]", WYJATKI["".join(han)])  # całe słowo, np. z -r (哪儿 nar)
    for slowo in LACINA.findall(znaki): pinyin = re.sub(slowo, " ", pinyin, flags=re.I)
    syl = sylaby(pinyin, len(han))
    if syl is None and "儿" in han:  # -r doklejone do sylaby (哪儿 nǎr): 儿 nie ma własnej sylaby
        han = [h for h in han if h != "儿"]; syl = sylaby(pinyin, len(han))
    if syl is None: return None
    out = [SYLABY[s] if isinstance(SYLABY[s], str) else SYLABY[s]["lekki" if t == 0 else "ton"] for s, t in syl]
    tekst, i = "".join(han), 0
    while i < len(tekst):
        for j in range(len(tekst), i, -1):
            w = WYJATKI.get(tekst[i:j])
            if w and len(re.split(r"[- ]", w)) == j - i:
                out[i:j] = re.split(r"[- ]", w); i = j; break
        else: i += 1
    return out

def nowy_polski(znaki, pinyin, stary):
    """Zapis karty ze słownika z podziałem na słowa jak w starym polu polski; None, gdy się nie da dopasować."""
    syl = zapis_sylab(znaki, pinyin)
    if syl is None: return None
    czesci = re.split(r"([- ]+)", stary.strip())
    lacina = {w.lower() for w in LACINA.findall(znaki)}
    tokeny = [i for i, c in enumerate(czesci) if c and not re.fullmatch(r"[- ]+", c) and c.lower() not in lacina]
    if len(tokeny) != len(syl): return None
    for i, z in zip(tokeny, syl): czesci[i] = z
    return "".join(czesci)

def pliki():
    return sorted((ROOT / "lekcje").glob("*/lekcja.json")) + sorted((ROOT / "materialy").glob("*/lekcja.json"))

def roznice():
    for f in pliki():
        data = json.loads(f.read_text(encoding="utf-8"))
        for sek in data["sekcje"]:
            for p in sek["pozycje"]:
                nowy = nowy_polski(p["znaki"], p["pinyin"], p.get("polski", ""))
                yield f, p, nowy

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "zapisz" and len(sys.argv) > 3:
        # słowa jak w pinyin (spacje), sylaby słowa myślnikami
        s = zapis_sylab(sys.argv[2], sys.argv[3])
        if not s: print("! pinyin nie pasuje do znaków"); sys.exit(1)
        out = []
        for slowo in re.findall(r"[a-zA-Zü" + "".join(TON) + "]+", sys.argv[3].replace("'", "")):
            n = next(k for k in range(1, 9) if sylaby(slowo, k))
            out.append("-".join(s[:n])); s = s[n:]
        print(" ".join(out))
    elif cmd in ("sprawdz", "wpisz"):
        zmiany = {}
        for f, p, nowy in roznice():
            if nowy is None: print(f"  ! {f.parent.name}: {p['znaki']} ({p['pinyin']}): nie umiem dopasować do „{p.get('polski', '')}”"); continue
            if nowy != p.get("polski", ""):
                print(f"{f.parent.name}: {p['znaki']}  {p.get('polski', '')}  ->  {nowy}")
                zmiany.setdefault(f, {})[p["znaki"]] = nowy
        if cmd == "wpisz":
            for f, z in zmiany.items():
                linie = f.read_text(encoding="utf-8").split("\n")
                for n, l in enumerate(linie):
                    m = re.search(r'"znaki": "([^"]+)"', l)
                    if m and m.group(1) in z: linie[n] = re.sub(r'"polski": "[^"]*"', f'"polski": "{z[m.group(1)]}"', l, count=1)
                f.write_text("\n".join(linie), encoding="utf-8")
            print(f"poprawione karty: {sum(len(z) for z in zmiany.values())}" + (" (teraz scenki.py wymowa dla każdej lekcji i build)" if zmiany else ""))
        else: print(f"różnic: {sum(len(z) for z in zmiany.values())}")
    else: print(__doc__); sys.exit(1)
