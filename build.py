#!/usr/bin/env python3
"""Buduje strony lekcji z lekcje/*/lekcja.json + wspólny index.html.
Generuje brakujące nagrania mp3 (Google TTS) do lekcje/<lekcja>/audio/.
Użycie: python3 build.py            # wszystkie lekcje
        python3 build.py --no-audio # bez pobierania audio
"""
import hashlib, json, pathlib, subprocess, sys, time, urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent
TEMPLATE = (ROOT / "template.html").read_text(encoding="utf-8")
POWTORKA = (ROOT / "powtorka.html").read_text(encoding="utf-8")
# Wersja do cache-bustingu wymowa.js (hash pliku)
WERSJA = hashlib.md5((ROOT / "wymowa.js").read_bytes()).hexdigest()[:8]
# Adres workera synchronizacji (plik sync.url, jedna linia); pusty = tylko localStorage
SYNC_URL = (ROOT / "sync.url").read_text().strip() if (ROOT / "sync.url").exists() else ""
TTS = "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=zh-CN&q={q}{slow}"
NO_AUDIO = "--no-audio" in sys.argv

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

def build_lesson(lesson_dir):
    data = json.loads((lesson_dir / "lekcja.json").read_text(encoding="utf-8"))
    for sek in data["sekcje"]:
        for p in sek["pozycje"]:
            try: p["audio"] = ensure_audio(lesson_dir, p["znaki"])
            except Exception as e: print(f"  ! {e}", file=sys.stderr); p.pop("audio", None)
    html = TEMPLATE.replace("{{TYTUL}}", data["tytul"]).replace("{{DATA_JSON}}", json.dumps(data, ensure_ascii=False)).replace("{{WERSJA}}", WERSJA).replace("{{SYNC_URL}}", SYNC_URL)
    (lesson_dir / "index.html").write_text(html, encoding="utf-8")
    md = [f"# {data['tytul']}", "", f"Data: {data.get('data','')}", ""]
    for sek in data["sekcje"]:
        md += [f"## {sek['nazwa']}", "", "| Znaki | Pinyin | Zapis polski | Zapis z notatek | Znaczenie |", "|---|---|---|---|---|"]
        md += [f"| {p['znaki']} | {p['pinyin']} | {p.get('polski','')} | {p.get('notatki','')} | {p['znaczenie']} |" for p in sek["pozycje"]]
        md.append("")
    (lesson_dir / "notatki.md").write_text("\n".join(md), encoding="utf-8")
    n = sum(len(s["pozycje"]) for s in data["sekcje"])
    print(f"{lesson_dir.name}: {n} pozycji")
    karty = [{"id": p["znaki"], "znaki": p["znaki"], "pinyin": p["pinyin"], "polski": p.get("polski", ""), "znaczenie": p["znaczenie"],
              "lekcja": data.get("numer", 0), "lekcjaTytul": data["tytul"],
              "audio": f"lekcje/{lesson_dir.name}/audio/{p['audio']}" if p.get("audio") else ""}
             for sek in data["sekcje"] for p in sek["pozycje"]]
    return {"dir": lesson_dir.name, "tytul": data["tytul"], "data": data.get("data", ""), "n": n, "numer": data.get("numer", 0), "karty": karty}

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
    print("index.html OK")
