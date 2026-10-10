"""
Armony - metadati dei brani: completare, scrivere nei file, mettere al posto giusto.

Usato dai download importati da Spotify (Exportify) e da deploy/riallinea-spotify.py.

Fonti, in ordine di fiducia:
  1. la riga del CSV di Exportify: titolo, artisti, album, data, durata, ISRC, generi, etichetta
     (è quello che l'utente aveva su Spotify, quindi vince sempre);
  2. Deezer (API pubblica, senza chiave): solo ciò che il CSV non ha — copertina, numero di traccia,
     disco, artista dell'album, tracce totali — e solo se l'album di Deezer è lo stesso del CSV.

─── PERCHÉ NON BASTA il primo risultato di Deezer per ISRC ───
Lo stesso ISRC compare su singolo, album, edizione deluxe e raccolte: per ISRC Deezer restituisce
spesso il singolo, mentre la playlist cita l'album. Se l'album non coincide si cerca l'album giusto
per nome e artista; se non lo si trova, niente numero di traccia piuttosto che uno sbagliato.
"""
import collections
import json
import os
import re
import shutil
import threading
import time
import unicodedata
import urllib.parse

import mutagen
import requests

http = requests.Session()
http.headers["User-Agent"] = "Armony (https://github.com/Giggi-98/Armony)"
_cache, _lock, _last = collections.OrderedDict(), threading.Lock(), [0.0]
# risposte di Deezer: al più CACHE_MAX, per CACHE_TTL (discografie e scalette cambiano); le copertine, che pesano centinaia
# di kB l'una, solo le ultime COVER_MAX (i brani di un album arrivano di seguito). Prima tutto restava in memoria per sempre
CACHE_MAX, CACHE_TTL, COVER_MAX = 3000, 86400, 8
_covers = collections.OrderedDict()


def _get(store, k):
    with _lock:
        e = store.get(k)
        if e is None or time.time() - e[0] > CACHE_TTL:
            store.pop(k, None)
            return False, None
        store.move_to_end(k)
        return True, e[1]


def _put(store, k, v, cap):
    with _lock:
        store[k] = (time.time(), v)
        store.move_to_end(k)
        while len(store) > cap:
            store.popitem(last=False)
COVER_NAMES = ("cover.jpg", "cover.jpeg", "cover.png", "folder.jpg", "folder.png")


def norm(s):
    """Per confrontare titoli e nomi: minuscolo, senza accenti, senza "(feat…)", "- Remastered…", punteggiatura."""
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\((feat|ft|with)[^)]*\)|\[[^\]]*\]|\s-\s.*(remaster|version|edit|mix|live).*$", " ", s)
    s = re.sub(r"\b(feat|ft)\.?\s.*$", " ", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def deezer(path):
    """GET sull'API di Deezer con cache e al massimo ~9 richieste al secondo (il limite è 50 ogni 5 s)."""
    hit, v = _get(_cache, path)
    if hit:
        return v
    with _lock:
        wait = _last[0] + 0.11 - time.time()
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
    try:
        d = http.get("https://api.deezer.com/2.0/" + path, timeout=8).json()
    except (requests.RequestException, ValueError):
        return None  # rete o Deezer giù: si va avanti con i soli dati del CSV, senza mettere in cache
    if not isinstance(d, dict):
        return None
    if "error" in d:
        # solo "non esiste" (800) si ricorda; quota superata (4) e simili sono passeggeri e restavano "non trovato" fino al riavvio
        if (d.get("error") or {}).get("code") != 800:
            return None
        d = None
    _put(_cache, path, d, CACHE_MAX)
    return d


def _album_tracks(album):
    tracks = (album.get("tracks") or {}).get("data") or []
    return tracks, album.get("nb_tracks") or len(tracks)


def arricchisci(m):
    """m: title, artists[list], album, date, duration (s), isrc, genres[list], label.
    Restituisce una copia con in più, se trovati: albumartist, track, tracktotal, disc, cover, e i
    generi/l'etichetta dell'album quando il CSV non li ha."""
    out = dict(m)
    artists = [a for a in m.get("artists") or [] if a]
    if not out.get("albumartist"):
        out["albumartist"] = artists[0] if artists else ""
    want_album, want_title = norm(m.get("album")), norm(m.get("title"))
    album = None
    t = deezer("track/isrc:" + urllib.parse.quote(m["isrc"])) if m.get("isrc") else None
    if t and norm((t.get("album") or {}).get("title")) == want_album:
        album = deezer("album/%s" % t["album"]["id"])
        if album:
            out["track"], out["disc"] = t.get("track_position"), t.get("disk_number")
    if not album and want_album and artists:
        q = urllib.parse.quote('artist:"%s" album:"%s"' % (artists[0], m.get("album")))
        for a in ((deezer("search/album?q=" + q) or {}).get("data") or [])[:5]:
            if norm(a.get("title")) == want_album:
                album = deezer("album/%s" % a["id"])
                break
        if album:  # posizione per titolo (o durata quasi uguale) nell'elenco delle tracce dell'album
            tracks, _ = _album_tracks(album)
            for i, x in enumerate(tracks):
                if norm(x.get("title")) == want_title or (m.get("duration") and abs((x.get("duration") or 0) - m["duration"]) <= 2
                                                       and want_title and want_title in norm(x.get("title"))):
                    out["track"], out["disc"] = i + 1, x.get("disk_number") or 1
                    break
    if album:
        out["albumartist"] = (album.get("artist") or {}).get("name") or out["albumartist"]
        out["tracktotal"] = album.get("nb_tracks")
        out["cover"] = album.get("cover_xl") or album.get("cover_big")
        if not m.get("genres"):
            out["genres"] = [g["name"] for g in ((album.get("genres") or {}).get("data") or [])]
        if not m.get("label") and album.get("label"):
            out["label"] = album["label"]
        if not m.get("date") and album.get("release_date"):
            out["date"] = album["release_date"]
    return out


def _senza_edizione(s):
    """"Aventine (Deluxe Version)" e "Aventine" sono lo stesso album per chi lo cerca in libreria."""
    return norm(re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", str(s or "")))


def scaletta(artista, album, anno=None):
    """La scaletta completa di un album secondo Deezer, per mostrare in libreria le tracce che mancano.
    Prima il titolo identico, poi lo stesso titolo senza edizione ("Deluxe", "Bonus Track"…); fra i
    candidati vince l'anno uguale, poi il numero di tracce più alto. None se non lo trova."""
    want, art = norm(album), norm(artista)
    if not want:
        return None
    trovati = {}
    for q in ('artist:"%s" album:"%s"' % (artista, album), "%s %s" % (artista, album)):
        for a in ((deezer("search/album?q=" + urllib.parse.quote(q)) or {}).get("data") or [])[:25]:
            nome = norm((a.get("artist") or {}).get("name"))
            if art and nome and art not in nome and nome not in art:
                continue
            trovati.setdefault(a["id"], a)
        if trovati:
            break
    esatti = [a for a in trovati.values() if norm(a.get("title")) == want]
    cand = esatti or [a for a in trovati.values() if _senza_edizione(a.get("title")) == _senza_edizione(album)]
    best, chiave = None, None
    for a in cand[:4]:
        d = deezer("album/%s" % a["id"])
        if not d:
            continue
        k = (1 if anno and (d.get("release_date") or "")[:4] == str(anno) else 0, d.get("nb_tracks") or 0)
        if chiave is None or k > chiave:
            best, chiave = d, k
    if not best:
        return None
    return _scaletta(best, artista, album)


def _scaletta(best, artista="", album=""):
    tracce = (deezer("album/%s/tracks?limit=300" % best["id"]) or {}).get("data") or []
    albumartist = (best.get("artist") or {}).get("name") or artista
    return {
        "album": best.get("title") or album, "albumartist": albumartist, "date": best.get("release_date") or "",
        "cover": best.get("cover_xl") or best.get("cover_big") or "",
        "tracks": [{"title": t.get("title") or "", "artists": [(t.get("artist") or {}).get("name") or albumartist],
                    "duration": t.get("duration"), "track": t.get("track_position") or i + 1,
                    "disc": t.get("disk_number") or 1, "isrc": (t.get("isrc") or "").upper()}
                   for i, t in enumerate(tracce)],
    }


def _artista(a):
    return {"id": a["id"], "name": a.get("name") or "", "picture": a.get("picture_big") or a.get("picture_medium") or ""}


def discografia(nome=None, dzid=None):
    """Tutta la discografia di un artista secondo Deezer: album, EP, singoli e raccolte, più gli artisti
    simili. L'artista si cerca per nome e si prende solo se il nome normalizzato coincide (fra gli
    omonimi quello con più fan); con dzid si va diretti. None se non lo trova."""
    if dzid:
        a = deezer("artist/%d" % int(dzid))
    else:
        want = norm(nome)
        cand = [x for x in ((deezer("search/artist?limit=25&q=" + urllib.parse.quote(nome or "")) or {}).get("data") or [])
                if want and norm(x.get("name")) == want]
        a = max(cand, key=lambda x: x.get("nb_fan") or 0) if cand else None
    if not a:
        return None
    # le edizioni ripetute (esplicita e no, ristampe con lo stesso titolo) diventano una sola: la più ascoltata
    uno = {}
    for x in (deezer("artist/%s/albums?limit=300" % a["id"]) or {}).get("data") or []:
        k = (x.get("record_type") or "album", norm(x.get("title")))
        if k not in uno or (x.get("fans") or 0) > (uno[k].get("fans") or 0):
            uno[k] = x
    albums = [{"id": x["id"], "title": x.get("title") or "", "type": x.get("record_type") or "album",
               "date": x.get("release_date") or "", "year": int((x.get("release_date") or "0")[:4] or 0) or None,
               "cover": x.get("cover_big") or x.get("cover_medium") or ""}
              for x in uno.values()]
    albums.sort(key=lambda x: x["date"], reverse=True)
    simili = (deezer("artist/%s/related?limit=12" % a["id"]) or {}).get("data") or []
    return {"artist": _artista(a), "albums": albums, "similar": [_artista(x) for x in simili]}


def album_deezer(dzid):
    """Un album di Deezer per id, con la sua scaletta (stessa forma di scaletta()) e il suo tipo."""
    d = deezer("album/%d" % int(dzid))
    if not d:
        return None
    s = _scaletta(d)
    s.update(id=d["id"], type=d.get("record_type") or "album", artist=_artista(d.get("artist") or {"id": 0}))
    return s


def tagga(path, m, pulisci=False):
    """Scrive i tag con mutagen in forma "facile" (uguale per MP3, M4A, FLAC, Opus, OGG).
    pulisci=True toglie prima tutti i tag (anche descrizione, link e copertina del video): si usa
    quando c'è una copertina vera da mettere accanto al file."""
    f = mutagen.File(path, easy=True)
    if f is None:
        raise ValueError("non è un file audio riconosciuto")
    if pulisci and f.tags is not None:
        f.delete()
        f = mutagen.File(path, easy=True)
    if f.tags is None:
        f.add_tags()
    vals = {
        "title": m.get("title"),
        "artist": [a for a in m.get("artists") or [] if a],  # più valori: Navidrome li separa in artisti distinti
        "album": m.get("album"),
        "albumartist": m.get("albumartist"),
        "date": m.get("date"),
        "genre": [g for g in m.get("genres") or [] if g],
        "tracknumber": ("%s/%s" % (m["track"], m["tracktotal"]) if m.get("tracktotal") else str(m["track"])) if m.get("track") else None,
        "discnumber": str(m["disc"]) if m.get("disc") else None,
        "isrc": m.get("isrc"),
        "organization": m.get("label"),
    }
    valid = getattr(f.tags, "valid_keys", None)  # EasyID3/EasyMP4 accettano solo alcune chiavi; Vorbis qualsiasi
    for k, v in vals.items():
        if not v or (valid is not None and k not in valid):
            continue
        try:
            f[k] = v if isinstance(v, list) else str(v)
        except (KeyError, ValueError):
            pass
    f.save()


# ─── origine del file: da dove viene e che conversione ha avuto ───
# Un tag nel file stesso (JSON), così resta anche se la coda dei download si svuota o il file si sposta:
# MP4 "----:com.apple.iTunes:ARMONY_ORIGIN", MP3 "TXXX:ARMONY_ORIGIN", Vorbis/FLAC/Opus "ARMONY_ORIGIN"
ORIGIN = "ARMONY_ORIGIN"


def scrivi_origine(path, d):
    f = mutagen.File(path)
    if f is None:
        return
    data = json.dumps(d, ensure_ascii=False, separators=(",", ":"))
    if f.tags is None:
        f.add_tags()
    kind = type(f).__name__
    if kind == "MP4":
        from mutagen.mp4 import MP4FreeForm
        f.tags["----:com.apple.iTunes:" + ORIGIN] = [MP4FreeForm(data.encode())]
    elif kind == "MP3":
        from mutagen.id3 import TXXX
        f.tags.add(TXXX(encoding=3, desc=ORIGIN, text=[data]))
    else:
        f.tags[ORIGIN] = [data]
    f.save()


# ─── PERCHÉ ReplayGain scritto da Armony ───
# I brani da YouTube e dalle importazioni (gran parte della libreria) arrivano senza ReplayGain: la normalizzazione del
# client non aveva niente da usare e il volume saltava da un brano all'altro. Dopo ogni download si misura il volume
# percepito (EBU R128, ffmpeg) e si scrivono i tag che Navidrome legge e passa ai client. Riferimento -18 LUFS (RG 2.0)
RG_REF = -18.0


def loudness(path):
    """(LUFS integrati, picco reale lineare) del file, o None. Circa un secondo per un brano di quattro minuti."""
    import subprocess
    try:
        r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"],
                           capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired):
        return None
    tail = r.stderr[r.stderr.rfind("Summary:"):] if "Summary:" in r.stderr else ""
    mi = re.search(r"I:\s*(-?[\d.]+) LUFS", tail)
    mp = re.search(r"Peak:\s*(-?[\d.]+|-inf) dBFS", tail)
    if not mi:
        return None
    peak = 10 ** (float(mp.group(1)) / 20) if mp and mp.group(1) != "-inf" else 1.0
    return float(mi.group(1)), peak


def scrivi_replaygain(path, force=False):
    """Scrive REPLAYGAIN_TRACK_GAIN/PEAK nel file (MP4, MP3, Vorbis/Opus/FLAC). False se c'era già o non si misura."""
    f = mutagen.File(path)
    if f is None:
        return False
    if f.tags is None:
        f.add_tags()
    kind = type(f).__name__
    keys = {"MP4": "----:com.apple.iTunes:REPLAYGAIN_TRACK_GAIN", "MP3": "TXXX:REPLAYGAIN_TRACK_GAIN"}
    if not force and any(k in f.tags for k in (keys.get(kind, ""), "REPLAYGAIN_TRACK_GAIN", "replaygain_track_gain")):
        return False
    lp = loudness(path)
    if not lp:
        return False
    gain, peak = f"{RG_REF - lp[0]:+.2f} dB", f"{lp[1]:.6f}"
    if kind == "MP4":
        from mutagen.mp4 import MP4FreeForm
        f.tags["----:com.apple.iTunes:REPLAYGAIN_TRACK_GAIN"] = [MP4FreeForm(gain.encode())]
        f.tags["----:com.apple.iTunes:REPLAYGAIN_TRACK_PEAK"] = [MP4FreeForm(peak.encode())]
    elif kind == "MP3":
        from mutagen.id3 import TXXX
        f.tags.add(TXXX(encoding=3, desc="REPLAYGAIN_TRACK_GAIN", text=[gain]))
        f.tags.add(TXXX(encoding=3, desc="REPLAYGAIN_TRACK_PEAK", text=[peak]))
    else:
        f.tags["REPLAYGAIN_TRACK_GAIN"] = [gain]
        f.tags["REPLAYGAIN_TRACK_PEAK"] = [peak]
    f.save()
    return True


def leggi_origine(path):
    try:
        f = mutagen.File(path)
    except Exception:  # noqa: BLE001
        return None
    if f is None or f.tags is None:
        return None
    raw = None
    for k in ("----:com.apple.iTunes:" + ORIGIN, "TXXX:" + ORIGIN, ORIGIN, ORIGIN.lower()):
        try:
            v = f.tags[k]
        except (KeyError, ValueError, TypeError):
            continue
        v = v[0] if isinstance(v, list) else getattr(v, "text", [v])[0]
        raw = bytes(v).decode() if isinstance(v, (bytes, bytearray)) else str(v)
        break
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return None


CODEC = {"MP4": "AAC", "MP3": "MP3", "FLAC": "FLAC", "OggOpus": "Opus", "OggVorbis": "Vorbis", "WAVE": "WAV", "AIFF": "AIFF"}


def qualita(path):
    """Codec, bitrate (kbps), frequenza (Hz) e durata (s) del file com'è adesso."""
    f = mutagen.File(path)
    if f is None or not getattr(f, "info", None):
        return {}
    i = f.info
    codec = CODEC.get(type(f).__name__, type(f).__name__)
    if codec == "AAC" and "alac" in str(getattr(i, "codec", "")).lower():
        codec = "ALAC"
    return {"codec": codec, "kbps": round((getattr(i, "bitrate", 0) or 0) / 1000), "hz": getattr(i, "sample_rate", None),
            "dur": round(getattr(i, "length", 0) or 0, 1)}


def copia_tag(old, new):
    """Tag e copertina dal file vecchio a quello che lo sostituisce (stesso formato: si copiano così come sono)."""
    a, b = mutagen.File(old), mutagen.File(new)
    if a is None or b is None or a.tags is None:
        return
    if type(a) is not type(b):
        m = leggi_tag(old)
        tagga(new, {"title": m["title"], "artists": m["artists"], "album": m["album"], "albumartist": m["albumartist"],
                    "date": m["date"], "genres": m["genres"], "track": m["track"], "disc": m["disc"]}, pulisci=True)
        return
    if b.tags is None:
        b.add_tags()
    b.tags.clear()
    if type(a).__name__ == "MP3":
        for frame in a.tags.values():
            b.tags.add(frame)
    else:
        for k, v in a.tags.items():
            b.tags[k] = v
    if type(a).__name__ == "FLAC":
        for pic in a.pictures:
            b.add_picture(pic)
    b.save()


# chiavi "facili" di mutagen per la modifica a mano: campo dell'interfaccia → chiave nel file
CAMPI = {"title": "title", "artists": "artist", "album": "album", "albumartist": "albumartist",
         "date": "date", "track": "tracknumber", "disc": "discnumber", "genres": "genre"}


def leggi_tag(path):
    """I tag che l'interfaccia permette di modificare, più se il file ha una copertina incorporata."""
    f = mutagen.File(path, easy=True)
    if f is None:
        raise ValueError("non è un file audio riconosciuto")
    t = f.tags or {}
    one = lambda k: (t.get(k) or [""])[0] if k in t else ""
    num = lambda k: (one(k).split("/")[0].strip() or None)
    raw = mutagen.File(path)
    keys = [str(k) for k in (raw.tags.keys() if getattr(raw, "tags", None) else [])]
    cover = any(k.startswith("APIC") or k == "covr" or k.lower() == "metadata_block_picture" for k in keys) \
        or bool(getattr(raw, "pictures", None))
    return {"title": one("title"), "artists": list(t.get("artist") or []), "album": one("album"),
            "albumartist": one("albumartist"), "date": one("date"), "track": num("tracknumber"),
            "disc": num("discnumber"), "genres": list(t.get("genre") or []), "cover": cover}


def modifica(path, fields):
    """Scrive solo i campi passati; un campo vuoto viene tolto dal file. Il file non si sposta:
    per Navidrome l'id del brano dipende dal percorso, e così playlist e preferiti restano."""
    f = mutagen.File(path, easy=True)
    if f is None:
        raise ValueError("non è un file audio riconosciuto")
    if f.tags is None:
        f.add_tags()
    for campo, k in CAMPI.items():
        if campo not in fields:
            continue
        v = fields[campo]
        if isinstance(v, list):
            v = [str(x).strip() for x in v if str(x).strip()]
        else:
            v = str(v).strip() if v is not None else ""
        if not v:
            if k in f.tags:
                del f[k]
        else:
            f[k] = v
    f.save()


def incorpora(path, img):
    """Mette la copertina dentro il file, così resta anche se il file viene copiato altrove."""
    from mutagen.flac import FLAC, Picture
    from mutagen.id3 import APIC, ID3
    from mutagen.mp4 import MP4, MP4Cover
    from mutagen.id3 import ID3NoHeaderError
    import base64
    ext = path.rsplit(".", 1)[-1].lower()
    png = img.startswith(b"\x89PNG")
    mime = "image/png" if png else "image/jpeg"
    if ext in ("m4a", "mp4", "aac"):
        f = MP4(path)
        f["covr"] = [MP4Cover(img, imageformat=MP4Cover.FORMAT_PNG if png else MP4Cover.FORMAT_JPEG)]
        f.save()
    elif ext == "mp3":
        try:
            f = ID3(path)
        except ID3NoHeaderError:
            f = ID3()
        f.delall("APIC")
        f.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=img))
        f.save(path)
    elif ext in ("flac", "opus", "ogg", "oga"):
        pic = Picture()
        pic.type, pic.mime, pic.data = 3, mime, img
        if ext == "flac":
            f = FLAC(path)
            f.clear_pictures()
            f.add_picture(pic)
        else:
            f = mutagen.File(path)
            f["metadata_block_picture"] = [base64.b64encode(pic.write()).decode()]
        f.save()
    else:
        raise ValueError("questo formato non tiene la copertina dentro il file")


def _seg(s, fallback):
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", str(s or "").strip()).strip(". ")
    return s[:120] or fallback


def destinazione(base, m, ext):
    """<base>/<artista dell'album>/<album>/<[disco-]NN - titolo>.<ext>"""
    name = _seg(m.get("title"), "Senza titolo")
    if m.get("track"):
        n = "%02d" % int(m["track"])
        name = ("%s-%s" % (m["disc"], n) if m.get("disc") and int(m["disc"]) > 1 else n) + " - " + name
    return os.path.join(base, _seg(m.get("albumartist"), "Artista sconosciuto"), _seg(m.get("album"), "Singoli"), name + "." + ext)


def sistema(src, base, m):
    """Sposta il file al suo posto (senza sovrascrivere un file diverso) e scarica la copertina
    accanto, se la cartella non ne ha già una. Restituisce il percorso finale."""
    dest = destinazione(base, m, src.rsplit(".", 1)[-1].lower())
    folder = os.path.dirname(dest)
    os.makedirs(folder, exist_ok=True)
    img = _cover(m["cover"]) if m.get("cover") else None
    if img:
        try:
            incorpora(src, img)  # prima di spostarlo: nella cartella della musica il file arriva finito
        except Exception:  # noqa: BLE001 — la copertina nella cartella basta a Navidrome
            pass
        if not any(os.path.exists(os.path.join(folder, c)) for c in COVER_NAMES):
            with open(os.path.join(folder, "cover.jpg"), "wb") as fh:
                fh.write(img)
    if os.path.abspath(src) != os.path.abspath(dest):
        stem, ext = dest.rsplit(".", 1)
        n = 2
        while os.path.exists(dest):
            dest = "%s (%d).%s" % (stem, n, ext)
            n += 1
        # ─── PERCHÉ in due passi ───
        # Da /tmp alla cartella della musica è una copia, non uno spostamento: Navidrome vedeva il file a metà e gli
        # dava durata 0 fino alla scansione dopo. Si copia con un nome che Navidrome ignora, poi un rename atomico
        shutil.move(src, dest + ".armony-part")
        os.replace(dest + ".armony-part", dest)
    return dest


def _cover(url):
    hit, img = _get(_covers, url)
    if hit:
        return img
    try:
        r = http.get(url, timeout=15)
        img = r.content if r.ok and r.headers.get("content-type", "").startswith("image/") else None
    except requests.RequestException:
        return None
    _put(_covers, url, img, COVER_MAX)  # un album intero usa la stessa copertina: si scarica una volta
    return img


def da_exportify(row):
    """Una riga di CSV di Exportify (formato vecchio e nuovo) → dizionario di metadati."""
    g = lambda *ks: next((row[k].strip() for k in ks if row.get(k) and row[k].strip()), "")
    dur = g("Duration (ms)", "Track Duration (ms)")
    return {
        "title": g("Track Name"),
        # Exportify separa gli artisti con ";": la virgola può far parte del nome ("Tyler, The Creator")
        "artists": [a.strip() for a in g("Artist Name(s)").split(";") if a.strip()],
        "album": g("Album Name"),
        "albumartist": g("Album Artist Name(s)").split(";")[0].strip(),
        "date": g("Release Date", "Album Release Date"),
        "duration": round(int(dur) / 1000) if dur.isdigit() else None,
        "isrc": g("ISRC").upper(),
        "genres": [x.strip() for x in g("Genres").split(",") if x.strip()],
        "label": g("Record Label", "Label"),
        "track": int(g("Track Number")) if g("Track Number").isdigit() else None,
        "disc": int(g("Disc Number")) if g("Disc Number").isdigit() else None,
        "cover": g("Album Image URL"),
        "spotify": g("Track URI"),
    }


if __name__ == "__main__":  # prova veloce: python metadati.py ISRC "Album"
    import sys
    print(json.dumps(arricchisci({"isrc": sys.argv[1], "album": sys.argv[2], "title": sys.argv[3] if len(sys.argv) > 3 else "",
                                  "artists": sys.argv[4:]}), indent=1, ensure_ascii=False))
