#!/usr/bin/env python3
"""Szukanie obrazków do kart (Openverse, licencje CC0 / domena publiczna / CC BY).

Użycie:
  python3 obrazki.py szukaj "friend" "rice" ...     # dla każdego zapytania: kolaż kandydatów + lista
  python3 obrazki.py szukaj --n 9 "cute"
  python3 obrazki.py szukaj --wszystkie "cute"    # bez ograniczenia do źródeł stockowych (StockSnap, Rawpixel)
  python3 obrazki.py wpisz lekcje/01-x/lekcja.json "朋友=friends:5" "可爱=cute:3" ...   # wybór z kolażu do lekcja.json

Dla każdego zapytania powstaje .cache/obrazki/<slug>.png (ponumerowane miniatury) i na stdout
lista kandydatów z gotowym JSON-em do wklejenia w pole "obrazek" w lekcja.json.
Openverse bez klucza: 200 zapytań/dzień, 20/min; miniatury 1000/dzień.
"""
import io, json, pathlib, re, sys, time, urllib.parse, urllib.request
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent
CACHE = ROOT / ".cache" / "obrazki"
API = "https://api.openverse.org/v1/images/"
UA = "kubus-lekcje/1.0 (https://github.com/kubi-dev/kubus)"
LICENCJE = "cc0,pdm,by"
# najpierw zdjęcia stockowe CC0 (bez obowiązku podpisu), potem wszystko (Flickr, Wikimedia... — CC BY z podpisem)
ZRODLA = "stocksnap,rawpixel"

def get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def autor(s):
    # Openverse zwraca czasem nazwiska zakodowane jak w URL, także w starym stylu %uXXXX
    s = re.sub(r"%u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), s or "")
    return urllib.parse.unquote(s).strip()

def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "x"

def szukaj(q, n, zrodla=ZRODLA):
    par = {"q": q, "license": LICENCJE, "page_size": n, "mature": "false"}
    if zrodla: par["source"] = zrodla
    d = json.loads(get(API + "?" + urllib.parse.urlencode(par)))
    wyniki = d.get("results", [])
    if zrodla and len(wyniki) < 3:
        time.sleep(0.5); return szukaj(q, n, "")
    out = []
    for r in wyniki:
        out.append({"id": r["id"], "url": r.get("url", ""), "autor": autor(r.get("creator")), "licencja": r.get("license", ""),
                    "zrodlo": r.get("foreign_landing_url", ""), "tytul": r.get("title") or "", "thumb": r.get("thumbnail", "")})
    return out

def kolaz(kandydaci, dest, kol=3, w=300, h=220):
    n = len(kandydaci); rows = (n + kol - 1) // kol
    img = Image.new("RGB", (kol * w, max(1, rows) * h), (240, 240, 240))
    try: font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 34)
    except Exception: font = ImageFont.load_default()
    d = ImageDraw.Draw(img)
    for i, k in enumerate(kandydaci):
        x, y = (i % kol) * w, (i // kol) * h
        try:
            t = Image.open(io.BytesIO(get(k["thumb"]))).convert("RGB")
            s = max(w / t.width, h / t.height)
            t = t.resize((max(1, round(t.width * s)), max(1, round(t.height * s))))
            l, u = (t.width - w) // 2, (t.height - h) // 2
            img.paste(t.crop((l, u, l + w, u + h)), (x, y))
        except Exception as e:
            d.text((x + 10, y + 60), "błąd: " + str(e)[:40], fill=(120, 0, 0), font=font)
        d.rectangle((x, y, x + 56, y + 44), fill=(184, 54, 45))
        d.text((x + 10, y + 3), str(i + 1), fill="white", font=font)
        time.sleep(0.15)
    img.save(dest)

def wpisz(plik, wybory):
    """wybory: "znaki=slug:N" — N-ty kandydat z .cache/obrazki/<slug>.json trafia do pola obrazek pozycji o tych znakach."""
    plik = pathlib.Path(plik); data = json.loads(plik.read_text(encoding="utf-8"))
    poz = {p["znaki"]: p for s in data["sekcje"] for p in s["pozycje"]}
    for w in wybory:
        znaki, reszta = w.split("=", 1); sl, n = reszta.rsplit(":", 1)
        if znaki not in poz: print(f"! brak pozycji {znaki}"); continue
        kand = json.loads((CACHE / f"{sl}.json").read_text(encoding="utf-8"))
        k = kand[int(n) - 1]
        poz[znaki]["obrazek"] = {"id": k["id"], "url": k["url"], "autor": k["autor"], "licencja": k["licencja"], "zrodlo": k["zrodlo"]}
        print(f"{znaki}: {sl} #{n} ({k['licencja']}, {k['autor']})")
    plik.write_text(zapis_lekcji(data), encoding="utf-8")

def zapis_lekcji(data):
    """Układ jak w lekcja.json pisanych ręcznie: każda pozycja w jednej linii."""
    j = lambda x: json.dumps(x, ensure_ascii=False)
    out = ["{"]
    for k, v in data.items():
        if k != "sekcje": out.append(f"  {j(k)}: {j(v)},")
    out.append('  "sekcje": [')
    for i, sek in enumerate(data["sekcje"]):
        out.append("    {")
        for k, v in sek.items():
            if k != "pozycje": out.append(f"      {j(k)}: {j(v)},")
        out.append('      "pozycje": [')
        out.append(",\n".join("        " + j(p) for p in sek["pozycje"]))
        out.append("      ]")
        out.append("    }" + ("," if i < len(data["sekcje"]) - 1 else ""))
    out.append("  ]"); out.append("}")
    return "\n".join(out) + "\n"

def main():
    args = sys.argv[1:]
    if len(args) >= 2 and args[0] == "wpisz":
        wpisz(args[1], args[2:]); return
    if not args or args[0] != "szukaj":
        print(__doc__); sys.exit(1)
    args = args[1:]; n = 6; zrodla = ZRODLA
    while args and args[0].startswith("--"):
        if args[0] == "--n": n = int(args[1]); args = args[2:]
        elif args[0] == "--wszystkie": zrodla = ""; args = args[1:]
        else: print("nieznana opcja", args[0]); sys.exit(1)
    CACHE.mkdir(parents=True, exist_ok=True)
    for q in args:
        try: kand = szukaj(q, n, zrodla)
        except Exception as e: print(f"\n=== {q}: błąd wyszukiwania: {e}"); continue
        dest = CACHE / f"{slug(q)}.png"
        print(f"\n=== {q}  ({len(kand)} kandydatów)  kolaż: {dest}")
        (CACHE / f"{slug(q)}.json").write_text(json.dumps(kand, ensure_ascii=False, indent=1), encoding="utf-8")
        if kand: kolaz(kand, dest)
        for i, k in enumerate(kand):
            obr = {"id": k["id"], "url": k["url"], "autor": k["autor"], "licencja": k["licencja"], "zrodlo": k["zrodlo"]}
            print(f"{i + 1}. {k['tytul'][:50]!r}  {json.dumps(obr, ensure_ascii=False)}")
        time.sleep(0.5)

if __name__ == "__main__":
    main()
