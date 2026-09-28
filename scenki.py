#!/usr/bin/env python3
"""Scenki rodzajowe do lekcji (lekcje/NN/scenki.json): mini dialogi z poznanego słownictwa, uczone jak w podcaście.

Format scenki.json:
{"scenki": [{"id": "restauracja", "tytul": "W restauracji", "opis": "Kubi zamawia jedzenie.", "role": {"A": "Kelner", "B": "Kubi"}, "ty": "B",
             "kwestie": [{"kto": "A", "znaki": "你想吃什么？", "pinyin": "Nǐ xiǎng chī shénme?", "wymowa": "ni siang czhy szen-ma", "polski": "Co chcesz zjeść?"}, ...],
             "nowe": [{"znaki": "请", "pinyin": "qǐng", "polski": "ćhing", "notatki": "", "znaczenie": "please · proszę"}]}]}

Zasada: co najmniej 75% znaków w dialogu musi pochodzić ze słownictwa poznanego do tej lekcji włącznie (wszystkie lekcje o numerze
<= numer tej lekcji). Pozostałe znaki muszą być wymienione w "nowe" i trafiają do lekcja.json jako sekcja "Ze scenek".
Każda kwestia ma "wymowa": zapis wymowy po polsku, złożony wyłącznie z kart (pole "polski" w lekcja.json i w "nowe" scenek);
na stronie scenek stoi zamiast pinyin. Nie pisz go ręcznie: "wymowa" wpisuje go do scenki.json, "sprawdz" pilnuje zgodności z kartami.

Użycie:
  python3 scenki.py sprawdz lekcje/NN-slug      # raport pokrycia, błędy (znaki spoza słownictwa i spoza "nowe")
  python3 scenki.py wpisz lekcje/NN-slug        # dopisuje "nowe" do lekcja.json (sekcja "Ze scenek"), pomija już obecne
  python3 scenki.py slownictwo lekcje/NN-slug   # wypisuje znane słownictwo (do promptu generującego scenki)
  python3 scenki.py wymowa lekcje/NN-slug       # wpisuje "wymowa" każdej kwestii w scenki.json (złożone z kart)
  python3 scenki.py wymowa lekcje/NN-slug "我叫丽丽。" ["Wǒ jiào Lìlì."]   # sam zapis dla podanych znaków (do tabelki do akceptu)
"""
import json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent
HAN = re.compile(r"[一-鿿]")
MIN_POKRYCIE = 0.75
SEKCJA_NOWE = "Ze scenek"

def wczytaj(p): return json.loads(p.read_text(encoding="utf-8"))

def lekcje_do(numer):
    """Wszystkie lekcja.json o numerze <= numer, po numerze."""
    out = []
    for d in sorted((ROOT / "lekcje").iterdir()):
        f = d / "lekcja.json"
        if f.exists():
            data = wczytaj(f)
            if data.get("numer", 0) <= numer: out.append((d, data))
    return sorted(out, key=lambda x: x[1].get("numer", 0))

def pozycje(data): return [p for s in data["sekcje"] for p in s["pozycje"]]

def znane_znaki(lesson_dir):
    data = wczytaj(lesson_dir / "lekcja.json")
    znaki = set()
    for _, d in lekcje_do(data.get("numer", 0)):
        for p in pozycje(d): znaki |= set(HAN.findall(p["znaki"]))
    return znaki

# ---- wymowa kwestii z kart ----
PUNKT = re.compile(r"[。？！，…]")
JEDNOSTKA = re.compile(r"[一-鿿]|[A-Za-z']+")  # znak albo słowo łacińskie (Kubi) = jedna sylaba zapisu
SAMOGLOSKI = re.compile(r"[aeiouüāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+", re.I)
ZNAK_PL = {"。": ".", "？": "?", "！": "!", "，": ","}

def indeks_kart(lesson_dir):
    """{fragment znaków: zapis} ze wszystkich kart do tej lekcji włącznie (i z "nowe" scenek), także fragmenty kart z ich
    własnymi odstępami i myślnikami (我来自 z 我来自波兰 = "ło laj-dzy"). Ten sam fragment na kilku kartach: karta z tej lekcji,
    potem z najnowszej wcześniejszej."""
    numer = wczytaj(lesson_dir / "lekcja.json").get("numer", 0)
    karty = []
    for d, data in lekcje_do(numer):
        n = data.get("numer", 0)
        karty += [(p["znaki"], p.get("polski", ""), n) for p in pozycje(data)]
        if (d / "scenki.json").exists():
            karty += [(x["znaki"], x.get("polski", ""), n) for sc in wczytaj(d / "scenki.json")["scenki"] for x in sc.get("nowe", [])]
    idx = {}
    for znaki, pl, n in karty:
        u = JEDNOSTKA.findall(PUNKT.sub("", znaki)); cz = re.split(r"([\s\-]+)", pl.strip())
        syl, sep = cz[0::2], cz[1::2]
        if not pl.strip() or len(u) != len(syl): continue
        waga = (n == numer, n)
        for i in range(len(u)):
            for j in range(i + 1, len(u) + 1):
                klucz = "".join(u[i:j]); zapis = "".join(syl[k] + (sep[k] if k < j - 1 else "") for k in range(i, j))
                if klucz not in idx or waga > idx[klucz][1]: idx[klucz] = (zapis, waga)
    return {k: v[0] for k, v in idx.items()}

def slowa_pinyin(jednostki, pinyin):
    """Numer słowa pinyin dla każdej jednostki (sylaby jednego słowa łączy myślnik), None gdy się nie da policzyć."""
    out = []
    for w, slowo in enumerate(re.findall(r"[^\s.,!?;:。？！，]+", pinyin or "")):
        if len(out) < len(jednostki) and slowo.lower() == jednostki[len(out)].lower(): out.append(w); continue
        out += [w] * len(SAMOGLOSKI.findall(slowo))
    return out if len(out) == len(jednostki) else None

def wymowa(idx, znaki, pinyin=""):
    """Zapis wymowy kwestii złożony z kart: (zapis, znaki bez karty). Między zdaniami . ! ? , jak w znakach, bez znaku na końcu.
    Podział na kawałki kart: najpierw bez cięcia słów pinyin, potem jak najmniej kawałków."""
    czesci = [c for c in re.split(r"([。？！，])", PUNKT.sub(lambda m: m.group(0) if m.group(0) in ZNAK_PL else "", znaki)) if c.strip()]
    jedn = JEDNOSTKA.findall("".join(c for c in czesci if c not in ZNAK_PL))
    slowa = slowa_pinyin(jedn, pinyin) or list(range(len(jedn)))
    out, brak, poz = "", [], 0
    for c in czesci:
        if c in ZNAK_PL: out += ZNAK_PL[c] + " "; continue
        u = JEDNOSTKA.findall(c); n = len(u)
        best = [(0, 0, None)] + [None] * n  # (cięcia słów, kawałki, poprzedni)
        for j in range(1, n + 1):
            for i in range(j):
                klucz = "".join(u[i:j])
                if best[i] is None or not (klucz in idx or (j - i == 1 and not HAN.match(klucz))): continue
                ciecie = 1 if i > 0 and slowa[poz + i - 1] == slowa[poz + i] else 0
                kand = (best[i][0] + ciecie, best[i][1] + 1, i)
                if best[j] is None or kand[:2] < best[j][:2]: best[j] = kand
        if best[n] is None:
            brak += [z for z in u if HAN.match(z) and z not in idx] or [c]; poz += n; continue
        kawalki, j = [], n
        while j > 0: i = best[j][2]; kawalki.append((i, j)); j = i
        for i, j in reversed(kawalki):
            if i > 0: out += "-" if slowa[poz + i - 1] == slowa[poz + i] else " "
            klucz = "".join(u[i:j]); out += idx.get(klucz, klucz)
        poz += n
    return out.strip().rstrip(".?!,").strip(), brak

def wpisz_wymowe(lesson_dir):
    f = lesson_dir / "scenki.json"; idx = indeks_kart(lesson_dir)
    zapisy = {sc["id"]: [wymowa(idx, k["znaki"], k.get("pinyin", "")) for k in sc["kwestie"]] for sc in wczytaj(f)["scenki"]}
    linie, cur, i, zmiany = f.read_text(encoding="utf-8").split("\n"), None, 0, 0
    for n, l in enumerate(linie):
        m = re.match(r'\s*"id": "([^"]+)"', l)
        if m: cur, i = m.group(1), 0
        if '"kto":' in l and '"znaki":' in l:
            zapis, brak = zapisy[cur][i]; i += 1
            if brak: print(f"  ! {cur}: brak karty dla {''.join(brak)}")
            nowa = re.sub(r'"wymowa": "[^"]*"', f'"wymowa": "{zapis}"', l) if '"wymowa":' in l else re.sub(r'("pinyin": "[^"]*", )', lambda mm: mm.group(1) + f'"wymowa": "{zapis}", ', l, count=1)
            zmiany += nowa != l; linie[n] = nowa
    f.write_text("\n".join(linie), encoding="utf-8")
    print(f"{f.relative_to(ROOT)}: wymowa z kart, zmienione kwestie: {zmiany}")

def sprawdz(lesson_dir, glosno=True):
    f = lesson_dir / "scenki.json"
    if not f.exists():
        if glosno: print("brak scenki.json")
        return True
    znane = znane_znaki(lesson_dir); idx = indeks_kart(lesson_dir)
    ok = True
    for sc in wczytaj(f)["scenki"]:
        nowe = set(); [nowe.update(HAN.findall(n["znaki"])) for n in sc.get("nowe", [])]
        tekst = "".join(k["znaki"] for k in sc["kwestie"])
        wszystkie = HAN.findall(tekst)
        if not wszystkie: continue
        znane_w = [z for z in wszystkie if z in znane]
        spoza = sorted(set(z for z in wszystkie if z not in znane and z not in nowe))
        pokrycie = len(znane_w) / len(wszystkie)
        zbedne = sorted(nowe - set(wszystkie) - znane)
        bez_wymowy = [k["znaki"] for k in sc["kwestie"] if k.get("wymowa", "") != wymowa(idx, k["znaki"], k.get("pinyin", ""))[0]]
        stan = "OK" if pokrycie >= MIN_POKRYCIE and not spoza and not bez_wymowy else "BŁĄD"
        if stan != "OK": ok = False
        if glosno:
            print(f"{sc['id']}: {stan} pokrycie {pokrycie:.0%} ({len(znane_w)}/{len(wszystkie)} znaków), {len(sc['kwestie'])} kwestii, nowe: {''.join(sorted(nowe)) or '-'}")
            if spoza: print(f"  ! znaki spoza słownictwa i spoza 'nowe': {''.join(spoza)}")
            if bez_wymowy: print(f"  ! 'wymowa' niezgodna z kartami (python3 scenki.py wymowa {lesson_dir.relative_to(ROOT)}): {' '.join(bez_wymowy)}")
            if pokrycie < MIN_POKRYCIE: print(f"  ! za dużo nowego: pokrycie {pokrycie:.0%} < {MIN_POKRYCIE:.0%}")
            if zbedne: print(f"  ~ w 'nowe', ale nie ma ich w dialogu: {''.join(zbedne)}")
    return ok

def wpisz(lesson_dir):
    f = lesson_dir / "scenki.json"; lf = lesson_dir / "lekcja.json"
    data = wczytaj(lf)
    juz = set(p["znaki"] for p in pozycje(data))
    sek = next((s for s in data["sekcje"] if s["nazwa"] == SEKCJA_NOWE), None)
    dodane = []
    for sc in wczytaj(f)["scenki"]:
        for n in sc.get("nowe", []):
            if n["znaki"] in juz: continue
            if sek is None: sek = {"nazwa": SEKCJA_NOWE, "pozycje": []}; data["sekcje"].append(sek)
            sek["pozycje"].append({"znaki": n["znaki"], "pinyin": n["pinyin"], "polski": n.get("polski", ""), "notatki": n.get("notatki", ""), "znaczenie": n["znaczenie"], "auto": "scenka"})
            juz.add(n["znaki"]); dodane.append(n["znaki"])
    if dodane:
        # zapis w stylu pliku: jedna pozycja na linię
        txt = json.dumps(data, ensure_ascii=False, indent=2)
        txt = re.sub(r"\{\n\s+(\"znaki\".*?)\n\s+\}", lambda m: "{" + re.sub(r",\n\s+", ", ", m.group(1)) + "}", txt, flags=re.S)
        lf.write_text(txt + "\n", encoding="utf-8")
    print(f"dopisane do {lf.relative_to(ROOT)}: {', '.join(dodane) or 'nic nowego'}")

def slownictwo(lesson_dir):
    data = wczytaj(lesson_dir / "lekcja.json")
    for d, l in lekcje_do(data.get("numer", 0)):
        print(f"# {l['tytul']}")
        for p in pozycje(l): print(f"{p['znaki']} · {p['pinyin']} · {p['znaczenie'].split('·')[-1].strip()}")

if __name__ == "__main__":
    if len(sys.argv) < 3: print(__doc__); sys.exit(1)
    cmd, d = sys.argv[1], ROOT / sys.argv[2]
    if cmd == "sprawdz": sys.exit(0 if sprawdz(d) else 1)
    elif cmd == "wpisz": wpisz(d)
    elif cmd == "slownictwo": slownictwo(d)
    elif cmd == "wymowa" and len(sys.argv) > 3:
        zapis, brak = wymowa(indeks_kart(d), sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else "")
        print(zapis + (f"   ! brak karty dla: {''.join(brak)}" if brak else ""))
    elif cmd == "wymowa": wpisz_wymowe(d)
    else: print(__doc__); sys.exit(1)
