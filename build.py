#!/usr/bin/env python3
"""Buduje strony lekcji z lekcje/*/lekcja.json + wspólny index.html.
Generuje brakujące nagrania mp3 (Google TTS) do lekcje/<lekcja>/audio/
i brakujące obrazki (pole "obrazek" w lekcja.json, patrz obrazki.py) do lekcje/<lekcja>/obrazki/.
Użycie: python3 build.py              # wszystkie lekcje
        python3 build.py --no-audio   # bez pobierania audio
        python3 build.py --no-obrazki # bez pobierania obrazków
"""
import hashlib, json, pathlib, subprocess, sys, time, urllib.parse
import podcast

ROOT = pathlib.Path(__file__).resolve().parent
TEMPLATE = (ROOT / "template.html").read_text(encoding="utf-8")
POWTORKA = (ROOT / "powtorka.html").read_text(encoding="utf-8")
ULUBIONE = (ROOT / "ulubione.html").read_text(encoding="utf-8")
PODCAST = (ROOT / "podcast.html").read_text(encoding="utf-8")
SCENKI = (ROOT / "scenki.html").read_text(encoding="utf-8")
WYMOWA = (ROOT / "wymowa.html").read_text(encoding="utf-8")
# Wersja do cache-bustingu wymowa.js (hash pliku)
WERSJA = hashlib.md5((ROOT / "wymowa.js").read_bytes()).hexdigest()[:8]
# Adres workera synchronizacji (plik sync.url, jedna linia); pusty = tylko localStorage
SYNC_URL = (ROOT / "sync.url").read_text().strip() if (ROOT / "sync.url").exists() else ""
TTS = "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=zh-CN&q={q}{slow}"
NO_AUDIO = "--no-audio" in sys.argv
NO_OBRAZKI = "--no-obrazki" in sys.argv
OBRAZEK_SZER = 640  # px; karta pokazuje max ~320 px, 2x na retinie
UA = "kubus-lekcje/1.0 (https://github.com/kubi-dev/kubus)"

def audio_key(text):
    return hashlib.md5(text.encode("utf-8")).hexdigest()[:10]

def fetch(url, dest):
    subprocess.run(["curl", "-sf", "-A", "Mozilla/5.0", "-o", str(dest), url], check=True)
    if dest.stat().st_size < 500 or dest.read_bytes()[:2] not in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"ID"):
        dest.unlink(); raise RuntimeError(f"zły plik audio dla {url}")

def ensure_audio(lesson_dir, text):
    key = audio_key(text)
    adir = lesson_dir / "audio"; adir.mkdir(exist_ok=True)
    q = urllib.parse.quote(text)
    for suffix, slow in (("", ""), ("-slow", "&ttsspeed=0.24")):
        dest = adir / f"{key}{suffix}.mp3"
        if dest.exists() or NO_AUDIO: continue
        fetch(TTS.format(q=q, slow=slow), dest); time.sleep(0.4)
        print(f"  audio: {text} -> {dest.name}")
    return key

def ensure_image(lesson_dir, p):
    """Pobiera obrazek z pola "obrazek" ({id: openverse, url: oryginał, autor, licencja, zrodlo}) i zmniejsza do JPEG.
    Zwraca ścieżkę względną w katalogu lekcji albo None."""
    o = p.get("obrazek")
    if not o or not (o.get("id") or o.get("url")): return None
    key = audio_key(p["znaki"])
    odir = lesson_dir / "obrazki"; odir.mkdir(exist_ok=True)
    dest = odir / f"{key}.jpg"
    if dest.exists(): return f"obrazki/{dest.name}"
    if NO_OBRAZKI: return None
    zrodla = ([f"https://api.openverse.org/v1/images/{o['id']}/thumb/"] if o.get("id") else []) + ([o["url"]] if o.get("url") else [])
    tmp = odir / f"{key}.tmp"
    for url in zrodla:
        try:
            subprocess.run(["curl", "-sfL", "-A", UA, "-o", str(tmp), url], check=True, timeout=60)
            from PIL import Image
            im = Image.open(tmp); im.load()
            if im.mode != "RGB": im = im.convert("RGB")
            if im.width > OBRAZEK_SZER: im = im.resize((OBRAZEK_SZER, round(im.height * OBRAZEK_SZER / im.width)))
            im.save(dest, "JPEG", quality=82, optimize=True)
            tmp.unlink(missing_ok=True)
            print(f"  obrazek: {p['znaki']} -> {dest.name} ({dest.stat().st_size // 1024} KB)")
            time.sleep(0.3)
            return f"obrazki/{dest.name}"
        except Exception as e:
            tmp.unlink(missing_ok=True)
            print(f"  ! obrazek {p['znaki']} z {url}: {e}", file=sys.stderr)
    return None

def build_lesson(lesson_dir):
    data = json.loads((lesson_dir / "lekcja.json").read_text(encoding="utf-8"))
    for sek in data["sekcje"]:
        for p in sek["pozycje"]:
            try: p["audio"] = ensure_audio(lesson_dir, p["znaki"])
            except Exception as e: print(f"  ! {e}", file=sys.stderr); p.pop("audio", None)
            img = ensure_image(lesson_dir, p)
            if img: p["img"] = img
            else: p.pop("img", None)
    md = [f"# {data['tytul']}", "", f"Data: {data.get('data','')}", ""]
    for sek in data["sekcje"]:
        md += [f"## {sek['nazwa']}", "", "| Znaki | Pinyin | Zapis polski | Zapis z notatek | Znaczenie |", "|---|---|---|---|---|"]
        md += [f"| {p['znaki']} | {p['pinyin']} | {p.get('polski','')} | {p.get('notatki','')} | {p['znaczenie']} |" for p in sek["pozycje"]]
        md.append("")
    (lesson_dir / "notatki.md").write_text("\n".join(md), encoding="utf-8")
    n = sum(len(s["pozycje"]) for s in data["sekcje"])
    print(f"{lesson_dir.name}: {n} pozycji")
    pod = None
    if not NO_AUDIO:
        try: pod = podcast.build_lesson_podcast(lesson_dir, data)
        except Exception as e: print(f"  ! podcast: {e}", file=sys.stderr)
    scenki = build_scenki(lesson_dir, data)
    data["podcast"] = pod; data["scenki"] = len([sc for sc in scenki if sc.get("podcast")])
    html = TEMPLATE.replace("{{TYTUL}}", data["tytul"]).replace("{{DATA_JSON}}", json.dumps(data, ensure_ascii=False)).replace("{{WERSJA}}", WERSJA).replace("{{SYNC_URL}}", SYNC_URL)
    (lesson_dir / "index.html").write_text(html, encoding="utf-8")
    karty = [{"id": p["znaki"], "znaki": p["znaki"], "pinyin": p["pinyin"], "polski": p.get("polski", ""), "znaczenie": p["znaczenie"],
              "lekcja": data.get("numer", 0), "lekcjaTytul": data["tytul"],
              "audio": f"lekcje/{lesson_dir.name}/audio/{p['audio']}" if p.get("audio") else "",
              "img": f"lekcje/{lesson_dir.name}/{p['img']}" if p.get("img") else "",
              "obrazek": {k: p["obrazek"].get(k, "") for k in ("autor", "licencja", "zrodlo")} if p.get("img") else None}
             for sek in data["sekcje"] for p in sek["pozycje"]]
    return {"dir": lesson_dir.name, "tytul": data["tytul"], "data": data.get("data", ""), "n": n, "numer": data.get("numer", 0), "karty": karty, "podcast": pod, "scenki": scenki}

def build_scenki(lesson_dir, data):
    """Scenki z lekcje/NN/scenki.json: nagrania kwestii + odcinek mp3 każdej scenki. Zwraca listę do strony podcastu."""
    f = lesson_dir / "scenki.json"
    if not f.exists(): return []
    out = []
    pozycje = {p["znaki"]: p for s in data["sekcje"] for p in s["pozycje"]}
    for sc in json.loads(f.read_text(encoding="utf-8"))["scenki"]:
        for k in sc["kwestie"]:
            try: k["audio"] = ensure_audio(lesson_dir, k["znaki"])
            except Exception as e: print(f"  ! {e}", file=sys.stderr); k.pop("audio", None)
        nowe = [pozycje[n["znaki"]] for n in sc.get("nowe", []) if n["znaki"] in pozycje and pozycje[n["znaki"]].get("audio")]
        pod = None
        if not NO_AUDIO:
            try: pod = podcast.build_scene_podcast(lesson_dir, sc, nowe)
            except Exception as e: print(f"  ! scenka {sc['id']}: {e}", file=sys.stderr)
        out.append({"id": sc["id"], "tytul": sc["tytul"], "opis": sc["opis"], "role": sc.get("role", {}), "ty": sc.get("ty", "B"),
                    "kwestie": [{"kto": k["kto"], "znaki": k["znaki"], "pinyin": k["pinyin"], "polski": k["polski"]} for k in sc["kwestie"]],
                    "nowe": [{"znaki": n["znaki"], "pinyin": n["pinyin"], "polski": n.get("polski", ""), "znaczenie": n["znaczenie"]} for n in sc.get("nowe", [])],
                    "podcast": pod})
    return out

def build_podcast(lessons):
    """Strona podcast/index.html: odcinek zbiorczy + odcinki lekcji (mp3 buduje podcast.py)."""
    odcinki = []
    wsz = None
    if not NO_AUDIO:
        try: wsz = podcast.build_all_podcast(lessons)
        except Exception as e: print(f"  ! podcast wszystko: {e}", file=sys.stderr)
    if wsz: odcinki.append({"id": "wszystko", "tytul": "Wszystko do tej pory", "src": f"{wsz['plik']}?v={wsz['sekund']}", "sekund": wsz["sekund"], "n": wsz["n"], "data": ""})
    for l in sorted(lessons, key=lambda l: -l["numer"]):
        if l.get("podcast"):
            odcinki.append({"id": l["dir"], "tytul": l["tytul"], "src": f"../lekcje/{l['dir']}/{l['podcast']['plik']}?v={l['podcast']['sekund']}", "sekund": l["podcast"]["sekund"], "n": l["podcast"]["n"], "data": l["data"]})
    out = ROOT / "podcast"; out.mkdir(exist_ok=True)
    (out / "index.html").write_text(PODCAST.replace("{{ODCINKI_JSON}}", json.dumps(odcinki, ensure_ascii=False)), encoding="utf-8")
    print(f"podcast: {len(odcinki)} odcinków")
    # strona scenek: pogrupowane lekcjami, od najnowszej
    lek = [{"dir": l["dir"], "tytul": l["tytul"], "scenki": l["scenki"]} for l in sorted(lessons, key=lambda l: -l["numer"]) if l.get("scenki")]
    out = ROOT / "scenki"; out.mkdir(exist_ok=True)
    (out / "index.html").write_text(SCENKI.replace("{{SCENKI_JSON}}", json.dumps(lek, ensure_ascii=False)), encoding="utf-8")
    print(f"scenki: {sum(len(l['scenki']) for l in lek)} scenek")

def build_powtorka(lessons):
    """Talia do powtórek ze wszystkich lekcji (pierwsze wystąpienie znaków wygrywa) + strona powtorka/index.html."""
    seen, karty = set(), []
    for l in sorted(lessons, key=lambda l: l["numer"]):
        for k in l["karty"]:
            if k["id"] in seen: continue
            seen.add(k["id"]); karty.append(k)
    out = ROOT / "powtorka"; out.mkdir(exist_ok=True)
    (out / "karty.json").write_text(json.dumps(karty, ensure_ascii=False, indent=1), encoding="utf-8")
    html = POWTORKA.replace("{{KARTY_JSON}}", json.dumps(karty, ensure_ascii=False)).replace("{{WERSJA}}", WERSJA).replace("{{SYNC_URL}}", SYNC_URL)
    (out / "index.html").write_text(html, encoding="utf-8")
    print(f"powtorka: {len(karty)} kart")
    # strona ulubionych: lista zwrotów oznaczonych gwiazdką w powtórce (ta sama talia, ten sam stan)
    out = ROOT / "ulubione"; out.mkdir(exist_ok=True)
    html = ULUBIONE.replace("{{KARTY_JSON}}", json.dumps(karty, ensure_ascii=False)).replace("{{WERSJA}}", WERSJA).replace("{{SYNC_URL}}", SYNC_URL)
    (out / "index.html").write_text(html, encoding="utf-8")

STRONY_WYMOWY = {
    # katalog: (klucze z wymowa.json, tytuł, nagłówek, wstęp, link w nagłówku)
    "tony": (("wstep", "tony", "zmiany_tonow", "zdania", "pary_tonow", "minimalne_pary_tonow"), "Tony", "Tony dla Polaka",
             "Tu ćwiczysz tylko melodię słowa. Wszystkie słowa na tej stronie mają dźwięki, które masz z polskiego, więc jak coś nie wychodzi, to ton, nie dźwięk. Dotknij słowa, żeby je usłyszeć. Przytrzymaj 🎤, powiedz, puść.",
             '<a href="../dzwieki/">dźwięki →</a>'),
    "dzwieki": (("dzwieki", "koniec"), "Dźwięki", "Dźwięki trudne dla Polaka",
                "Najpierw tony (osobna strona), teraz dźwięki, których polski nie ma. Jedna grupa naraz: jak to zrobić po polsku, para słów różniących się tylko tym dźwiękiem, mikrofon.",
                '<a href="../tony/">← tony</a>'),
}

def build_wymowa(lessons):
    """Strony tony/ i dzwieki/ z jednego szablonu wymowa.html. Dane w wymowa.json (źródło prawdy); każda strona dostaje tylko swoje
    klucze i własne nagrania mp3 (wolno i normalnie) w <strona>/audio/. Słowa znane z lekcji dostają numer lekcji (znaczek L1, L2…)."""
    f = ROOT / "wymowa.json"
    if not f.exists(): return
    dane = json.loads(f.read_text(encoding="utf-8"))
    lekcja = {}
    for l in sorted(lessons, key=lambda l: l["numer"]):
        for k in l["karty"]: lekcja.setdefault(k["id"], l["numer"])
    def slowa(data):
        for k in ("wstep", "tony", "zmiany_tonow", "zdania", "pary_tonow", "koniec"):
            for t in data.get(k, []): yield from t["slowa"]
        for p in data.get("minimalne_pary_tonow", []): yield p["a"]; yield p["b"]
        for g in data.get("dzwieki", []):
            for p in g.get("pary", []): yield p["a"]; yield p["b"]
            yield from g.get("slowa", [])
    for tryb, (klucze, tytul, naglowek, wstep, link) in STRONY_WYMOWY.items():
        data = {k: dane.get(k, []) for k in klucze}
        out = ROOT / tryb; out.mkdir(exist_ok=True)
        audio, n = {}, 0
        for s in slowa(data):
            n += 1
            if s["znaki"] in lekcja: s["lekcja"] = lekcja[s["znaki"]]
            else: s.pop("lekcja", None)
            if s["znaki"] in audio: continue
            try: audio[s["znaki"]] = ensure_audio(out, s["znaki"])
            except Exception as e: print(f"  ! {e}", file=sys.stderr)
        data["audio"] = audio; data["tryb"] = tryb
        html = (WYMOWA.replace("{{DATA_JSON}}", json.dumps(data, ensure_ascii=False)).replace("{{WERSJA}}", WERSJA).replace("{{SYNC_URL}}", SYNC_URL)
                .replace("{{TYTUL}}", tytul).replace("{{NAGLOWEK}}", naglowek).replace("{{WSTEP}}", wstep).replace("{{LINK}}", link))
        (out / "index.html").write_text(html, encoding="utf-8")
        print(f"{tryb}: {n} słów, {len(audio)} nagrań")

def build_index(lessons):
    items = "\n".join(
        f'    <a class="card" href="lekcje/{l["dir"]}/"><div class="t">{l["tytul"]}</div><div class="m">{l["data"]} · {l["n"]} pozycji</div></a>'
        for l in sorted(lessons, key=lambda l: l["numer"]))
    (ROOT / "index.html").write_text(INDEX.replace("{{LEKCJE}}", items), encoding="utf-8")

INDEX = """<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notatki z chińskiego</title>
<style>
  :root { --bg: #f6f1e8; --card: #fffdf8; --ink: #1f1a14; --muted: #7a6f62; --accent: #b8362d; --line: #e6dccd; }
  @media (prefers-color-scheme: dark) { :root { --bg: #171412; --card: #221e1a; --ink: #f1e9dd; --muted: #a2968a; --accent: #e0574c; --line: #332c26; } }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  main { max-width: 700px; margin: 0 auto; padding: 32px 20px 60px; }
  h1 { margin: 0 0 20px; font-size: 28px; }
  .card { display: block; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; margin-bottom: 12px; text-decoration: none; color: inherit; }
  .card:hover { border-color: var(--accent); }
  .t { font-size: 18px; font-weight: 600; }
  .m { color: var(--muted); font-size: 13px; margin-top: 4px; }
</style>
</head>
<body>
<main>
  <h1>Notatki z chińskiego</h1>
    <a class="card" href="powtorka/"><div class="t">🔁 Powtórka</div><div class="m">codzienne powtórki: wymowa i rozumienie ze słuchu</div></a>
    <a class="card" href="ulubione/"><div class="t">★ Ulubione</div><div class="m">zwroty oznaczone gwiazdką w powtórce · ściąga na rozmowę</div></a>
    <a class="card" href="podcast/"><div class="t">🎧 Podcast</div><div class="m">polski → chiński → pauza na powtórzenie · odcinek do każdej lekcji i do wszystkiego</div></a>
    <a class="card" href="scenki/"><div class="t">🎭 Scenki</div><div class="m">krótkie rozmowy z poznanych słów · słuchasz, powtarzasz, grasz swoją rolę</div></a>
    <a class="card" href="tony/"><div class="t">🎵 Tony</div><div class="m">melodia słowa · na słowach z dźwiękami, które Polak ma z natury · ucho i mikrofon</div></a>
    <a class="card" href="dzwieki/"><div class="t">🗣 Dźwięki</div><div class="m">dźwięki, których polski nie ma · jedna grupa naraz, pary słów, mikrofon</div></a>
{{LEKCJE}}
</main>
</body>
</html>
"""

if __name__ == "__main__":
    dirs = sorted(p for p in (ROOT / "lekcje").iterdir() if (p / "lekcja.json").exists())
    lessons = [build_lesson(d) for d in dirs]
    build_index(lessons)
    build_powtorka(lessons)
    build_podcast(lessons)
    build_wymowa(lessons)
    print("index.html OK")
