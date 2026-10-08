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
_cache, _lock, _last = {}, threading.Lock(), [0.0]
COVER_NAMES = ("cover.jpg", "cover.jpeg", "cover.png", "folder.jpg", "folder.png")


def norm(s):
    """Per confrontare titoli e nomi: minuscolo, senza accenti, senza "(feat…)", "- Remastered…", punteggiatura."""
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\((feat|ft|with)[^)]*\)|\[[^\]]*\]|\s-\s.*(remaster|version|edit|mix|live).*$", " ", s)
    s = re.sub(r"\b(feat|ft)\.?\s.*$", " ", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def deezer(path):
    """GET sull'API di Deezer con cache e al massimo ~9 richieste al secondo (il limite è 50 ogni 5 s)."""
    if path in _cache:
        return _cache[path]
    with _lock:
        wait = _last[0] + 0.11 - time.time()
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
    try:
        d = http.get("https://api.deezer.com/2.0/" + path, timeout=8).json()
        d = None if not isinstance(d, dict) or "error" in d else d
    except (requests.RequestException, ValueError):
        return None  # rete o Deezer giù: si va avanti con i soli dati del CSV, senza mettere in cache
    _cache[path] = d
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


def incorpora(path, img):
    """Mette la copertina dentro il file, così resta anche se il file viene copiato altrove."""
    from mutagen.flac import FLAC, Picture
    from mutagen.id3 import APIC, ID3
    from mutagen.mp4 import MP4, MP4Cover
    import base64
    ext = path.rsplit(".", 1)[-1].lower()
    if ext in ("m4a", "mp4", "aac"):
        f = MP4(path)
        f["covr"] = [MP4Cover(img, imageformat=MP4Cover.FORMAT_JPEG)]
        f.save()
    elif ext == "mp3":
        f = ID3(path)
        f.delall("APIC")
        f.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover", data=img))
        f.save()
    elif ext in ("flac", "opus", "ogg", "oga"):
        pic = Picture()
        pic.type, pic.mime, pic.data = 3, "image/jpeg", img
        if ext == "flac":
            f = FLAC(path)
            f.clear_pictures()
            f.add_picture(pic)
        else:
            f = mutagen.File(path)
            f["metadata_block_picture"] = [base64.b64encode(pic.write()).decode()]
        f.save()


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
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.abspath(src) != os.path.abspath(dest):
        stem, ext = dest.rsplit(".", 1)
        n = 2
        while os.path.exists(dest):
            dest = "%s (%d).%s" % (stem, n, ext)
            n += 1
        shutil.move(src, dest)
    folder = os.path.dirname(dest)
    if m.get("cover"):
        img = _cover(m["cover"])
        if img:
            if not any(os.path.exists(os.path.join(folder, c)) for c in COVER_NAMES):
                with open(os.path.join(folder, "cover.jpg"), "wb") as fh:
                    fh.write(img)
            try:
                incorpora(dest, img)
            except Exception:  # noqa: BLE001 — la copertina nella cartella basta a Navidrome
                pass
    return dest


def _cover(url):
    if url in _cache:
        return _cache[url]
    try:
        r = http.get(url, timeout=15)
        img = r.content if r.ok and r.headers.get("content-type", "").startswith("image/") else None
    except requests.RequestException:
        return None
    _cache[url] = img  # un album intero usa la stessa copertina: si scarica una volta
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
