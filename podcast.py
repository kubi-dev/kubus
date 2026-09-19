"""Mini podcast do nauki ze słuchawek: polski → chiński (wolno, normalnie) → pauza na powtórzenie,
potem przypomnienia w stylu Pimsleura (polski → pauza, w której sam mówisz → chiński jako potwierdzenie).

Odcinek lekcji (lekcje/NN/podcast.mp3):
  1. nowy zwrot: PL, ZH wolno, pauza, ZH normalnie, pauza
  2. 4 zwroty później przypomnienie: PL, pauza (mówisz sam), ZH, krótka pauza
  3. na końcu wszystkie zwroty jeszcze raz w trybie przypomnienia, w losowej kolejności
Odcinek zbiorczy (podcast/wszystko.mp3): wszystkie zwroty z dotychczasowych lekcji, tylko tryb przypomnienia, dwa przejścia.

Polski lektor: Google TTS (tl=pl), pliki lekcje/NN/audio/pl-<klucz>.mp3. Sklejanie: dekodowanie do PCM (ffmpeg), cisza jako zera,
jedno kodowanie do mp3 64 kb/s mono. Gotowy odcinek nie jest budowany ponownie, jeśli jego opis (manifest) się nie zmienił.
"""
import hashlib, json, pathlib, random, subprocess, sys, time, urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent
RATE = 24000                      # Hz, jak pliki z Google TTS
TTS_PL = "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=pl&q={q}"
PRZERWA = 0.5                     # s, odstęp między polskim a chińskim
PAUZA_POWTORZ = (1.3, 0.8)        # pauza na powtórzenie za lektorem: mnożnik długości nagrania + stała (s)
PAUZA_PRZYPOMNIJ = (1.6, 1.2)     # pauza, w której sam mówisz zanim usłyszysz odpowiedź
ODSTEP_PRZYPOMNIENIA = 4          # po ilu nowych zwrotach wraca przypomnienie
_pcm_cache = {}

def _key(text): return hashlib.md5(text.encode("utf-8")).hexdigest()[:10]

def po_polsku(p):
    """Polska część pola "znaczenie" ("noodles · makaron" -> "makaron")."""
    return p["znaczenie"].split("·")[-1].strip()

def ensure_pl(lesson_dir, text):
    dest = lesson_dir / "audio" / f"pl-{_key(text)}.mp3"
    if dest.exists(): return dest
    subprocess.run(["curl", "-sf", "-A", "Mozilla/5.0", "-o", str(dest), TTS_PL.format(q=urllib.parse.quote(text))], check=True)
    if dest.stat().st_size < 500: dest.unlink(); raise RuntimeError(f"zły plik audio PL dla {text!r}")
    print(f"  audio PL: {text} -> {dest.name}"); time.sleep(0.4)
    return dest

def pcm(path):
    """Plik mp3 -> surowe PCM s16le mono 24 kHz (cache w pamięci)."""
    path = pathlib.Path(path)
    if path not in _pcm_cache:
        _pcm_cache[path] = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le", "-ac", "1", "-ar", str(RATE), "-"],
                                          check=True, capture_output=True).stdout
    return _pcm_cache[path]

def cisza(sek): return bytes(int(sek * RATE) * 2)
def dlugosc(buf): return len(buf) / 2 / RATE

def pauza(buf, param): return cisza(param[0] * dlugosc(buf) + param[1])

# ---- składanie ----
def nowy(seg, z):
    """PL, ZH wolno, pauza, ZH normalnie, pauza."""
    seg += [z["pl"], cisza(PRZERWA), z["slow"], pauza(z["slow"], PAUZA_POWTORZ), z["zh"], pauza(z["zh"], PAUZA_POWTORZ), cisza(0.4)]

def przypomnij(seg, z, dluzej=0.0):
    """PL, pauza (mówisz sam), ZH, krótka pauza na powtórzenie."""
    seg += [z["pl"], pauza(z["zh"], (PAUZA_PRZYPOMNIJ[0], PAUZA_PRZYPOMNIJ[1] + dluzej)), z["zh"], pauza(z["zh"], (1.1, 0.5)), cisza(0.4)]

def zapisz(seg, dest):
    dane = b"".join(seg)
    dest.parent.mkdir(exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "s16le", "-ac", "1", "-ar", str(RATE), "-i", "-", "-codec:a", "libmp3lame", "-b:a", "64k", str(dest)],
                   input=dane, check=True)
    return dlugosc(dane)

def _zwroty(lesson_dir, pozycje):
    out = []
    for p in pozycje:
        if not p.get("audio"): continue
        k = p["audio"]
        out.append({"znaki": p["znaki"], "polski": po_polsku(p), "pl": pcm(ensure_pl(lesson_dir, po_polsku(p))),
                    "zh": pcm(lesson_dir / "audio" / f"{k}.mp3"), "slow": pcm(lesson_dir / "audio" / f"{k}-slow.mp3")})
    return out

def _manifest_ok(dest, manifest_path, opis):
    if dest.exists() and manifest_path.exists():
        try: return json.loads(manifest_path.read_text(encoding="utf-8")).get("opis") == opis
        except Exception: return False
    return False

def tytul_do_tts(tytul):
    """"Lekcja 2 · Jedzenie i napoje" -> "Lekcja druga. Jedzenie i napoje." (Google TTS czyta "2" jako "dwa")."""
    return tytul.replace("·", ".").strip() + "."

def build_lesson_podcast(lesson_dir, data):
    """Odcinek lekcji. Zwraca {plik, sekund, n} albo None."""
    pozycje = [p for s in data["sekcje"] for p in s["pozycje"]]
    dest = lesson_dir / "podcast.mp3"; man = lesson_dir / "podcast.json"
    opis = {"wersja": 3, "zwroty": [(p["znaki"], po_polsku(p)) for p in pozycje if p.get("audio")], "pauzy": [PRZERWA, PAUZA_POWTORZ, PAUZA_PRZYPOMNIJ, ODSTEP_PRZYPOMNIENIA]}
    if _manifest_ok(dest, man, opis):
        return json.loads(man.read_text(encoding="utf-8"))["wynik"]
    zw = _zwroty(lesson_dir, pozycje)
    if not zw: return None
    seg = [pcm(ensure_pl(lesson_dir, tytul_do_tts(data["tytul"]))), cisza(0.6),
           pcm(ensure_pl(lesson_dir, "Posłuchaj i powtórz. Gdy usłyszysz tylko polski, powiedz sam po chińsku.")), cisza(1.2)]
    for i, z in enumerate(zw):
        nowy(seg, z)
        if i >= ODSTEP_PRZYPOMNIENIA: przypomnij(seg, zw[i - ODSTEP_PRZYPOMNIENIA])
    for z in zw[-ODSTEP_PRZYPOMNIENIA:]: przypomnij(seg, z)
    seg += [cisza(0.8), pcm(ensure_pl(lesson_dir, "Teraz wszystko jeszcze raz. Mów sam.")), cisza(1.2)]
    kolej = zw[:]; random.Random(len(zw)).shuffle(kolej)
    for z in kolej: przypomnij(seg, z, dluzej=0.3)
    seg += [cisza(0.6), pcm(ensure_pl(lesson_dir, "Koniec lekcji."))]
    sek = zapisz(seg, dest)
    wynik = {"plik": "podcast.mp3", "sekund": round(sek), "n": len(zw)}
    man.write_text(json.dumps({"opis": opis, "wynik": wynik}, ensure_ascii=False), encoding="utf-8")
    print(f"  podcast: {dest.relative_to(ROOT)} {sek/60:.1f} min, {len(zw)} zwrotów")
    return wynik

def build_all_podcast(lessons):
    """Odcinek zbiorczy z całej talii (lessons: wynik build_lesson z build.py, z listą "karty")."""
    out = ROOT / "podcast"; out.mkdir(exist_ok=True)
    dest = out / "wszystko.mp3"; man = out / "wszystko.json"
    seen, zw_meta = set(), []
    for l in sorted(lessons, key=lambda l: l["numer"]):
        for k in l["karty"]:
            if k["id"] in seen or not k["audio"]: continue
            seen.add(k["id"]); zw_meta.append((l["dir"], k))
    opis = {"wersja": 3, "zwroty": [(k["znaki"], k["znaczenie"].split("·")[-1].strip()) for _, k in zw_meta], "pauzy": [PAUZA_PRZYPOMNIJ]}
    if _manifest_ok(dest, man, opis):
        return json.loads(man.read_text(encoding="utf-8"))["wynik"]
    zw = []
    for d, k in zw_meta:
        ld = ROOT / "lekcje" / d; base = pathlib.Path(k["audio"]).name
        pl = k["znaczenie"].split("·")[-1].strip()
        zw.append({"znaki": k["znaki"], "polski": pl, "pl": pcm(ensure_pl(ld, pl)), "zh": pcm(ld / "audio" / f"{base}.mp3"), "slow": None})
    if not zw: return None
    ld0 = ROOT / "lekcje" / zw_meta[0][0]
    seg = [pcm(ensure_pl(ld0, f"Wszystko do tej pory. {len(zw)} zwrotów. Usłyszysz polski, powiedz sam po chińsku, potem posłuchaj odpowiedzi.")), cisza(1.2)]
    for przejscie in range(2):
        kolej = zw[:]; random.Random(len(zw) * 7 + przejscie).shuffle(kolej)
        for z in kolej: przypomnij(seg, z, dluzej=0.5)
        if przejscie == 0: seg += [cisza(0.8), pcm(ensure_pl(ld0, "Drugie przejście.")), cisza(1.0)]
    seg += [cisza(0.6), pcm(ensure_pl(ld0, "Koniec."))]
    sek = zapisz(seg, dest)
    wynik = {"plik": "wszystko.mp3", "sekund": round(sek), "n": len(zw)}
    man.write_text(json.dumps({"opis": opis, "wynik": wynik}, ensure_ascii=False), encoding="utf-8")
    print(f"  podcast: podcast/wszystko.mp3 {sek/60:.1f} min, {len(zw)} zwrotów")
    return wynik

def build_scene_podcast(lesson_dir, sc, nowe_pozycje):
    """Odcinek scenki (lekcje/NN/scenka-<id>.mp3). sc = scenka z scenki.json z polem "audio" (klucz mp3) w każdej kwestii;
    nowe_pozycje = pozycje z lekcja.json odpowiadające "nowe" (z audio). Struktura: opis po polsku, nowe słowa, cała rozmowa,
    po kolei (PL, ZH wolno, pauza, ZH, pauza), cała rozmowa z pauzami, na końcu user gra swoją rolę (słyszy A, mówi B, słyszy B)."""
    dest = lesson_dir / f"scenka-{sc['id']}.mp3"; man = lesson_dir / f"scenka-{sc['id']}.json"
    opis = {"wersja": 1, "opis": sc["opis"], "kwestie": [(k["kto"], k["znaki"], k["polski"]) for k in sc["kwestie"]], "nowe": [p["znaki"] for p in nowe_pozycje], "ty": sc.get("ty", "B"), "pauzy": [PAUZA_POWTORZ, PAUZA_PRZYPOMNIJ]}
    if _manifest_ok(dest, man, opis):
        return json.loads(man.read_text(encoding="utf-8"))["wynik"]
    kw = []
    for k in sc["kwestie"]:
        if not k.get("audio"): continue
        kw.append({"kto": k["kto"], "pl": pcm(ensure_pl(lesson_dir, k["polski"])), "zh": pcm(lesson_dir / "audio" / f"{k['audio']}.mp3"), "slow": pcm(lesson_dir / "audio" / f"{k['audio']}-slow.mp3")})
    if not kw: return None
    ty = sc.get("ty", "B"); role = sc.get("role", {})
    mow = lambda t: [pcm(ensure_pl(lesson_dir, t)), cisza(1.0)]
    seg = mow(f"Scenka: {sc['tytul']}. {sc['opis']}")
    if nowe_pozycje:
        seg += mow("Najpierw nowe słowa.")
        for z in _zwroty(lesson_dir, nowe_pozycje): nowy(seg, z)
    seg += mow("Posłuchaj całej rozmowy.")
    for k in kw: seg += [k["zh"], cisza(0.7)]
    seg += [cisza(0.5)] + mow("Teraz po kolei. Powtarzaj.")
    for k in kw: nowy(seg, k)
    seg += [cisza(0.5)] + mow("Jeszcze raz cała rozmowa. Powtarzaj każde zdanie.")
    for k in kw: seg += [k["zh"], pauza(k["zh"], PAUZA_POWTORZ)]
    seg += [cisza(0.5)] + mow(f"Teraz ty jesteś {role.get(ty, ty)}. Gdy usłyszysz polski, powiedz to po chińsku.")
    for k in kw:
        if k["kto"] == ty: seg += [k["pl"], pauza(k["zh"], PAUZA_PRZYPOMNIJ), k["zh"], cisza(0.6)]
        else: seg += [k["zh"], cisza(0.8)]
    seg += [cisza(0.5)] + mow("Koniec scenki.")
    sek = zapisz(seg, dest)
    wynik = {"plik": dest.name, "sekund": round(sek), "n": len(kw)}
    man.write_text(json.dumps({"opis": opis, "wynik": wynik}, ensure_ascii=False), encoding="utf-8")
    print(f"  podcast: {dest.relative_to(ROOT)} {sek/60:.1f} min, {len(kw)} kwestii")
    return wynik
