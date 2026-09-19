#!/usr/bin/env python3
"""Scenki rodzajowe do lekcji (lekcje/NN/scenki.json): mini dialogi z poznanego słownictwa, uczone jak w podcaście.

Format scenki.json:
{"scenki": [{"id": "restauracja", "tytul": "W restauracji", "opis": "Kubi zamawia jedzenie.", "role": {"A": "Kelner", "B": "Kubi"}, "ty": "B",
             "kwestie": [{"kto": "A", "znaki": "你想吃什么？", "pinyin": "Nǐ xiǎng chī shénme?", "polski": "Co chcesz zjeść?"}, ...],
             "nowe": [{"znaki": "请", "pinyin": "qǐng", "polski": "ćhing", "notatki": "", "znaczenie": "please · proszę"}]}]}

Zasada: co najmniej 75% znaków w dialogu musi pochodzić ze słownictwa poznanego do tej lekcji włącznie (wszystkie lekcje o numerze
<= numer tej lekcji). Pozostałe znaki muszą być wymienione w "nowe" i trafiają do lekcja.json jako sekcja "Ze scenek".

Użycie:
  python3 scenki.py sprawdz lekcje/NN-slug      # raport pokrycia, błędy (znaki spoza słownictwa i spoza "nowe")
  python3 scenki.py wpisz lekcje/NN-slug        # dopisuje "nowe" do lekcja.json (sekcja "Ze scenek"), pomija już obecne
  python3 scenki.py slownictwo lekcje/NN-slug   # wypisuje znane słownictwo (do promptu generującego scenki)
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

def sprawdz(lesson_dir, glosno=True):
    f = lesson_dir / "scenki.json"
    if not f.exists():
        if glosno: print("brak scenki.json")
        return True
    znane = znane_znaki(lesson_dir)
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
        stan = "OK" if pokrycie >= MIN_POKRYCIE and not spoza else "BŁĄD"
        if stan != "OK": ok = False
        if glosno:
            print(f"{sc['id']}: {stan} pokrycie {pokrycie:.0%} ({len(znane_w)}/{len(wszystkie)} znaków), {len(sc['kwestie'])} kwestii, nowe: {''.join(sorted(nowe)) or '-'}")
            if spoza: print(f"  ! znaki spoza słownictwa i spoza 'nowe': {''.join(spoza)}")
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
            sek["pozycje"].append({"znaki": n["znaki"], "pinyin": n["pinyin"], "polski": n.get("polski", ""), "notatki": n.get("notatki", ""), "znaczenie": n["znaczenie"]})
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
    else: print(__doc__); sys.exit(1)
