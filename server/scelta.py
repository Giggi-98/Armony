"""
Armony - quale versione scaricare: un pool di candidati con un punteggio, la verifica del file arrivato e la sua origine
(capacità "scelta").

  GET  /api/scelta?id=…            i candidati per un brano della libreria (permesso "download")
  POST /api/scelta                 {id, url, source}: sostituisce il file con quella versione, nello stesso posto
                                   (permesso "delete": il file è di tutti). Playlist, preferiti e ascolti restano
  GET  /api/scelta/sospetti        i brani scaricati che non hanno convinto la verifica (durata, qualità, live…)
  DELETE /api/scelta/sospetti/<j>  «va bene così»
  POST /api/scelta/proposte        {ids}: sostituisce in blocco con la versione proposta (quella con la durata giusta,
                                   cercata in sottofondo per ogni brano da controllare)
  GET  /api/origine?id=…           da dove viene il file e che conversione ha avuto (qualsiasi utente)

─── PERCHÉ YouTube Music per primo ───
La ricerca normale di YouTube mette in cima videoclip con introduzioni, versioni live, testi, reaction e interviste: per
"Caparezza - Exuvia" dava il video, un video col testo, una reaction e un'intervista. La sezione "brani" di YouTube Music
dà l'audio ufficiale della casa discografica, con la durata del disco. Si guarda lì, poi su YouTube, poi su SoundCloud;
ogni candidato prende un punteggio (titolo, artista, durata, canale ufficiale, parole sospette) e il file arrivato si
controlla: durata molto diversa o bitrate basso → si prova il candidato dopo, e se nessuno convince il brano resta
"da controllare", con la possibilità di scegliere a mano fra i candidati.
"""
import json
import os
import re
import shutil
import threading
import time
import urllib.parse
import uuid
from concurrent.futures import ThreadPoolExecutor

import yt_dlp
from flask import Blueprint, g, jsonify, request

import diagnosi
import metadati

bp = Blueprint("scelta", __name__)
A = None
PROP, PQ = {}, []  # proposte per i brani da controllare: id → candidato (None: niente di abbastanza vicino); coda da cercare
MIN = 1.5      # sotto questo punteggio un candidato non si usa mai
SICURO = 5     # da qui in su non serve guardare oltre
NO = re.compile(r"\b(live|dal vivo|en vivo|in concerto|concert|concerto|session|sessions|unplugged|cover|karaoke|instrumental|"
                r"strumentale|8d|slowed|sped up|nightcore|reverb|remix|acoustic|acustica|reaction|intervista|interview|tutorial|"
                r"lezione|lesson|full album|disco completo|album completo|review|recensione|unboxing|loop|1 hour|10 hours)\b", re.I)
SRC = {"ytmusic": "YouTube Music", "youtube": "YouTube", "soundcloud": "SoundCloud"}


def query(m):
    return f"{(m.get('artists') or [m.get('artist') or ''])[0]} - {m.get('title') or ''}".strip(" -")


def punteggio(e, m):
    """Quanto un candidato somiglia al brano cercato; le parole sospette contano solo se il titolo cercato non le ha."""
    title, artists, dur = m.get("title") or "", m.get("artists") or ([m["artist"]] if m.get("artist") else []), m.get("duration")
    want_no = {w.lower() for w in NO.findall(title)}
    nt, na = metadati.norm(title), metadati.norm(" ".join(artists[:1]))
    t, ch = metadati.norm(e.get("title")), e.get("channel") or e.get("uploader") or ""
    who = metadati.norm(" ".join([ch] + list(e.get("artists") or [])))
    sc = (3 if nt and (nt in t or (len(t) > 3 and t in nt)) else 0) + (1.5 if na and (na in t or na in who) else 0)
    if e.get("source") == "ytmusic":
        sc += 3  # sezione "brani": audio ufficiale del disco
    if ch.endswith(" - Topic"):
        sc += 3
    low = (e.get("title") or "").lower()
    if "official audio" in low or "audio ufficiale" in low:
        sc += 1.5
    bad = {w.lower() for w in NO.findall(e.get("title") or "")} - want_no
    if bad:
        sc -= 4 + (2 if bad & {"live", "dal vivo", "en vivo", "concert", "concerto", "in concerto"} else 0)
    d = e.get("duration")
    if dur and d:
        dd = abs(d - dur)
        sc += 2 if dd <= 3 else 0.5 if dd <= 8 else -min(dd, 180) / 15
    return round(sc, 1), sorted(bad)


def flat(url, n):
    with yt_dlp.YoutubeDL(A.yt_opts(extract_flat="in_playlist", playlistend=n)) as y:
        return [e for e in (y.extract_info(url, download=False) or {}).get("entries") or [] if e and e.get("url")]


def dettagli(url):
    """Durata e artisti di un risultato di YouTube Music (la ricerca dà solo il titolo)."""
    with yt_dlp.YoutubeDL(A.yt_opts()) as y:
        i = y.extract_info(url, download=False, process=False) or {}
    return {"duration": i.get("duration"), "channel": i.get("channel") or i.get("uploader"), "artists": i.get("artists") or ([i["artist"]] if i.get("artist") else []),
            "url": i.get("webpage_url") or url}


def cerca(m, fonti=("ytmusic", "youtube", "soundcloud"), arricchisci=2, presto=False):
    """Il pool: [{url, title, channel, duration, source, score, flags}], dal migliore. Con presto=True ci si ferma alla prima
    fonte che dà un candidato sicuro (importazioni: meno richieste a YouTube). Restituisce (pool, bloccato, ultimo errore)."""
    q, out, bloccato, err = query(m), [], False, ""
    urls = {"ytmusic": f"https://music.youtube.com/search?q={urllib.parse.quote(q)}#songs", "youtube": f"ytsearch8:{q}", "soundcloud": f"scsearch6:{q}"}
    pre = {}
    if not presto:  # scelta a mano: chi aspetta è una persona, le tre ricerche insieme
        with ThreadPoolExecutor(max_workers=3) as ex:
            futs = {src: ex.submit(flat, urls[src], 6 if src != "youtube" else 8) for src in fonti}
            for src, f in futs.items():
                try:
                    pre[src] = f.result()
                except Exception as e:  # noqa: BLE001
                    pre[src] = e
    for src in fonti:
        try:
            found = pre[src] if src in pre else flat(urls[src], 6 if src != "youtube" else 8)
            if isinstance(found, Exception):
                raise found
        except Exception as e:  # noqa: BLE001
            err = str(e)[:300]
            if src != "soundcloud" and A.yt_bloccato(e):
                bloccato = True
                if src == "ytmusic":
                    continue
                break
            continue
        nt = metadati.norm(m.get("title"))
        cs = [{"url": e["url"], "title": e.get("title") or "", "channel": e.get("channel") or e.get("uploader") or "",
               "duration": e.get("duration"), "source": src, "artists": []} for e in found]
        # YouTube Music non dà durata e artista nella ricerca: si chiedono per i primi che hanno il titolo giusto
        rich = [c for c in cs if src == "ytmusic" and nt and nt in metadati.norm(c["title"])][:arricchisci]
        with ThreadPoolExecutor(max_workers=1 if presto else 4) as ex:
            for c, f in [(c, ex.submit(dettagli, c["url"])) for c in rich]:
                try:
                    c.update({kk: v for kk, v in f.result().items() if v})
                except Exception as e2:  # noqa: BLE001
                    if A.yt_bloccato(e2):
                        bloccato = True
        for c in cs:
            c["score"], c["flags"] = punteggio(c, m)
            out.append(c)
        if presto and any(c["score"] >= SICURO for c in out):
            break
    seen, pool = set(), []
    for c in sorted(out, key=lambda x: -x["score"]):
        key = chiave(c["url"])
        if key not in seen:
            seen.add(key)
            pool.append(c)
    return pool, bloccato, err


def chiave(url):
    return re.sub(r"^https?://(www\.|music\.)?", "", url or "").split("&")[0]


def verifica(path, m):
    """Motivi per cui il file arrivato non convince (vuoto = va bene)."""
    q, why = metadati.qualita(path), []
    dur = m.get("duration")
    if dur and q.get("dur") and abs(q["dur"] - dur) > max(20, dur * 0.12):
        why.append(f"durata {round(q['dur'])} s invece di {round(dur)} s")
    if q.get("kbps") and q["kbps"] < 64:
        why.append(f"qualità bassa ({q['kbps']} kbps)")
    return why, q


def scarica(c, fmt, quality, tmp, progress=None, thumb=False):
    """Scarica un candidato in tmp, convertito in fmt. Restituisce (file, origine) o solleva l'errore di yt-dlp."""
    opts = A.yt_opts(outtmpl=os.path.join(tmp, "%(id)s.%(ext)s"), retries=3, ignoreerrors=False, progress_hooks=[progress] if progress else [],
                     # M4A e Opus arrivano già così da YouTube: si estrae senza ricodificare
                     format=f"bestaudio[ext={'webm' if fmt == 'opus' else fmt}]/bestaudio/best",
                     postprocessors=[{"key": "FFmpegExtractAudio", "preferredcodec": fmt, "preferredquality": A.AUDIO_QUALITIES.get(quality or "best", "0")}])
    if thumb:
        opts["writethumbnail"] = True
        opts["postprocessors"] += [{"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"}, {"key": "EmbedThumbnail"}]
    if c["source"] != "soundcloud":
        A.yt_turno()
    with yt_dlp.YoutubeDL(opts) as y:
        info = y.extract_info(c["url"], download=True) or {}
    files = [f for f in os.listdir(tmp) if f.rsplit(".", 1)[-1].lower() in A.UPLOAD_AUDIO]
    if not files:
        raise RuntimeError("il file non è arrivato")
    got = os.path.join(tmp, files[0])
    d = (info.get("requested_downloads") or [info])[0]
    src_codec = (d.get("acodec") or info.get("acodec") or "").split(".")[0]
    return got, {"src": c["source"], "url": info.get("webpage_url") or c["url"], "title": info.get("title") or c["title"],
                 "canale": info.get("channel") or info.get("uploader") or c.get("channel") or "", "punteggio": c.get("score"),
                 "da": {"codec": {"mp4a": "AAC", "opus": "Opus", "vorbis": "Vorbis", "mp3": "MP3", "flac": "FLAC"}.get(src_codec, src_codec or "?"),
                        "kbps": round(d.get("abr") or info.get("abr") or 0) or None, "hz": d.get("asr") or info.get("asr")},
                 "quando": round(time.time())}


def finale(path, o, why, come):
    """L'origine con il formato com'è dopo la conversione, scritta nel file."""
    o = dict(o, come=come, a=metadati.qualita(path), **({"dubbi": why} if why else {}))
    try:
        metadati.scrivi_origine(path, o)
    except Exception as e:  # noqa: BLE001 — senza il tag il brano suona lo stesso
        diagnosi.avviso("scelta", f"origine non scritta: {e}")
    return o


# ------------------------------------------------------------------ rotte
def brano(sid):
    """Percorso e metadati di un brano della libreria (dai tag del file), o (None, errore)."""
    if not A.ID_RE.match(sid or ""):
        return None, None, "Brano non valido"
    try:
        paths, errors = A.track_paths([sid])
    except Exception:  # noqa: BLE001
        return None, None, A.ND_DB_ERR
    if sid not in paths:
        return None, None, errors.get(sid, "Brano non trovato")
    # se il brano viene da un'importazione si cerca quello che si voleva (dati di Spotify), non quello che è arrivato
    import db
    L = A.importa.lib()
    for r in db.all_("SELECT items FROM imports"):
        for t in json.loads(r["items"]):
            if L.match(t) == sid:
                return paths[sid], {"title": t.get("title"), "artists": t.get("artists") or [], "album": t.get("album"),
                                    "duration": t.get("duration"), "da": "Spotify"}, None
    t = metadati.leggi_tag(paths[sid])
    return paths[sid], {"title": t["title"], "artists": t["artists"], "album": t["album"], "duration": metadati.qualita(paths[sid]).get("dur"),
                        "da": "file"}, None


@bp.get("/api/scelta")
def pool():
    path, m, err = brano(request.args.get("id"))
    if err:
        return jsonify(error=err), 404
    if time.time() < A.yt["pausa"]:
        fonti = ("soundcloud",)  # YouTube in pausa dopo un blocco: si guarda solo SoundCloud
    else:
        fonti = ("ytmusic", "youtube", "soundcloud")
    cands, bloccato, e = cerca(m, fonti, arricchisci=4)
    return jsonify(track=m, origine=metadati.leggi_origine(path), file=metadati.qualita(path), candidates=cands[:20],
                   avviso=A.YT_BLOCCO if bloccato or time.time() < A.yt["pausa"] else None)


@bp.post("/api/scelta")
def replace():
    if not (g.who["admin"] or g.who["delete"]):
        return jsonify(error="Sostituire un brano cambia il file per tutti: serve «Modifica ed elimina brani»."), 403
    d = request.get_json(silent=True) or {}
    sid, url, src = str(d.get("id") or ""), str(d.get("url") or ""), d.get("source") if d.get("source") in SRC else "youtube"
    if not re.match(r"^https://(www\.|music\.|m\.)?(youtube\.com|youtu\.be|soundcloud\.com)/", url):
        return jsonify(error="Si può scegliere solo un risultato di YouTube, YouTube Music o SoundCloud"), 400
    path, m, err = brano(sid)
    if err:
        return jsonify(error=err), 404
    return jsonify(accoda_sost(sid, m, {"url": url, "source": src, "title": str(d.get("title") or "")[:200], "score": d.get("score")})), 201


def accoda_sost(sid, m, c):
    jid = uuid.uuid4().hex[:10]
    j = dict(url="", mode="audio", format="", quality="best", playlist=False, folder="", sponsorblock=False, meta={},
             sost={"id": sid, "url": c["url"], "source": c["source"], "title": c.get("title") or "", "score": c.get("score")})
    with A.jlock:
        A.jobs[jid] = dict(j, id=jid, status="in coda", progress=0, title=f"Nuova versione: {', '.join(m['artists'])} - {m['title']}",
                           created=time.time(), updated=time.time(), by=g.who["user"])
        A.jsave(jid)
        out = dict(A.jobs[jid])
    A.jq.put((jid, j))
    return out


@bp.post("/api/scelta/proposte")
def in_blocco():
    """Le proposte già trovate, tutte insieme: un lavoro di sostituzione per ogni brano."""
    if not (g.who["admin"] or g.who["delete"]):
        return jsonify(error="Sostituire un brano cambia il file per tutti: serve «Modifica ed elimina brani»."), 403
    out = {}
    for sid in [str(i) for i in (request.get_json(silent=True) or {}).get("ids") or []][:300]:
        c = PROP.get(sid)
        if not c:
            continue
        _, m, err = brano(sid)
        if not err:
            out[sid] = accoda_sost(sid, m, c)
    return jsonify(jobs=out)


def proponi(sid):
    """La versione da proporre: sicura, senza parole sospette, diversa dal file di adesso e, se si sa (Spotify), della
    durata giusta. Altrimenti None: si sceglie a mano."""
    path, m, err = brano(sid)
    if err:
        return None
    cands, bloccato, _ = cerca(m, presto=True)
    if bloccato:
        raise RuntimeError("YouTube bloccato")
    cur = chiave((metadati.leggi_origine(path) or {}).get("url"))
    want = m.get("duration") if m.get("da") == "Spotify" else None
    for c in cands:
        if c["flags"] or c["score"] < SICURO or (cur and chiave(c["url"]) == cur):
            continue
        if want and (not c.get("duration") or abs(c["duration"] - want) > max(4, want * 0.03)):
            continue
        return {k: c.get(k) for k in ("url", "title", "channel", "duration", "source", "score")}
    return None


def proposte():
    """In sottofondo, un brano alla volta: le ricerche non si accavallano ai download e YouTube non vede raffiche."""
    while True:
        sid = PQ.pop(0) if PQ else None
        if not sid:
            time.sleep(3)
            continue
        if time.time() < A.yt["pausa"]:
            PQ.insert(0, sid)
            time.sleep(60)
            continue
        try:
            PROP[sid] = proponi(sid)
        except Exception as e:  # noqa: BLE001
            if A.yt_bloccato(e) or "bloccato" in str(e):
                PQ.append(sid)
                time.sleep(300)
                continue
            PROP[sid] = None
            diagnosi.log("avviso", "scelta", f"proposta non trovata per {sid}: {str(e)[:200]}")
        time.sleep(2)


def run_sost(jid, j):
    """Sostituzione scelta a mano: stesso percorso (per Navidrome è lo stesso brano), stessi tag, formato del file di prima."""
    s = j["sost"]
    A.jupdate(jid, status="in corso")
    try:
        paths, _ = A.track_paths([s["id"]])
        old = paths.get(s["id"])
        if not old:
            raise RuntimeError("il brano non c'è più in libreria")
        ext = old.rsplit(".", 1)[-1].lower()
        fmt = {"m4a": "m4a", "mp4": "m4a", "aac": "m4a", "mp3": "mp3", "opus": "opus", "ogg": "opus", "flac": "flac"}.get(ext, "mp3")
        tmp = os.path.join("/tmp/armony-dl", jid)
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp)
        try:
            def progress(d):
                if d["status"] == "downloading":
                    tot = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                    A.jupdate(jid, progress=round(d.get("downloaded_bytes", 0) * 100 / tot, 1) if tot else None)
            got, o = scarica({"url": s["url"], "source": s["source"], "title": s.get("title"), "score": s.get("score")}, fmt, "best", tmp, progress)
            metadati.copia_tag(old, got)
            o = finale(got, o, [], "scelta a mano")
            final = old.rsplit(".", 1)[0] + "." + got.rsplit(".", 1)[-1]
            shutil.move(got, final + ".armony-part")
            os.replace(final + ".armony-part", final)
            if final != old:
                os.remove(old)  # altro formato: il percorso cambia solo nell'estensione
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        try:
            A.federazione.nd_get("startScan")
        except Exception:  # noqa: BLE001 — la prossima scansione lo vedrà
            pass
        segna_ok(s["id"])  # la versione l'ha scelta una persona: esce da "Da controllare"
        A.jupdate(jid, status="completato", progress=100, finished=time.time(), path=os.path.relpath(final, A.MUSIC_DIR))
        A.pres_put({"type": "libreria", "n": 1})  # pagine aperte e copertine si aggiornano
    except Exception as e:  # noqa: BLE001
        A.jupdate(jid, status="errore", error=(A.YT_BLOCCO if A.yt_bloccato(e) else str(e))[:300], finished=time.time())


def gia_ok():
    import db
    r = db.one("SELECT value FROM settings WHERE key = 'scelta_ok'")
    return set(json.loads(r["value"])) if r else set()


def segna_ok(sid):
    import db
    PROP.pop(sid, None)
    db.run("INSERT INTO settings VALUES ('scelta_ok', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", json.dumps(sorted(gia_ok() | {sid})))


@bp.get("/api/scelta/sospetti")
def sospetti():
    """Da controllare: i download che la verifica non ha convinto, più i brani delle playlist importate la cui durata è
    molto diversa da quella di Spotify (live, videoclip con introduzione, un'altra versione). "Va bene" li toglie."""
    import db
    ok = gia_ok()
    with A.jlock:
        js = [dict(x) for x in A.jobs.values() if x.get("sospetto") and x["status"] in A.DONE and x.get("path")]
        # sostituzioni scelte e non ancora finite (o finite male): la riga mostra l'avanzamento o l'errore
        sost = {}
        for x in sorted((x for x in A.jobs.values() if x.get("sost")), key=lambda x: x.get("created") or 0):
            sost[x["sost"]["id"]] = {k: x.get(k) for k in ("id", "status", "progress", "error")}
    found = A.nd_files({x["path"] for x in js}) if js else {}
    out, seen = [], set()
    for x in sorted(js, key=lambda x: -(x.get("finished") or 0)):
        sid = (found.get(x["path"]) or {}).get("id")
        if sid and sid not in ok and sid not in seen:
            seen.add(sid)
            out.append({"key": "job:" + x["id"], "id": sid, "title": x.get("title"), "motivi": x["sospetto"], "scelto": x.get("scelto")})
    L = A.importa.lib()
    for r in db.all_("SELECT items FROM imports"):
        for t in json.loads(r["items"]):
            mid, want = L.match(t), t.get("duration")
            d = L.dur.get(mid) if mid else None
            if not mid or mid in seen or mid in ok or not want or not d or abs(d - want) <= max(20, want * 0.12):
                continue
            seen.add(mid)
            out.append({"key": "id:" + mid, "id": mid, "title": f"{', '.join(t.get('artists') or [])} - {t.get('title')}",
                        "motivi": [f"dura {round(d)} s, su Spotify {round(want)} s"]})
    out = out[:300]
    for x in out:
        j = sost.get(x["id"])
        if j and not j["status"].startswith("completato"):
            x["sost"] = j
        if x["id"] in PROP:
            x["prop"] = PROP[x["id"]]
        else:
            x["cerco"] = True
            if x["id"] not in PQ:
                PQ.append(x["id"])
    return jsonify(out)


@bp.delete("/api/scelta/sospetti/<key>")
def sospetto_ok(key):
    kind, _, val = key.partition(":")
    if kind == "job":
        with A.jlock:
            if val in A.jobs:
                A.jobs[val].pop("sospetto", None)
                A.jsave(val)
    elif kind == "id" and A.ID_RE.match(val):
        segna_ok(val)
    return jsonify(ok=True)


@bp.get("/api/origine")
def origine():
    sid = request.args.get("id") or ""
    try:
        paths, errors = A.track_paths([sid]) if A.ID_RE.match(sid) else ({}, {})
    except Exception:  # noqa: BLE001
        return jsonify(error=A.ND_DB_ERR), 503
    if sid not in paths:
        return jsonify(kind="rete" if "libreria" in str(errors.get(sid, "")) else "sconosciuta")
    path = paths[sid]
    rel = os.path.relpath(path, A.MUSIC_DIR)
    o = metadati.leggi_origine(path)
    if not o:  # file di prima del tag: dal lavoro che l'ha scaricato, se c'è ancora, o dalla cartella
        with A.jlock:
            j = next((x for x in A.jobs.values() if x.get("path") == rel), None)
        top = rel.split(os.sep, 1)[0]
        if j:
            o = {"src": "youtube" if j.get("source") == "YouTube" else "soundcloud" if j.get("source") == "SoundCloud" else "scaricato",
                 "title": j.get("scelto") or "", "come": "importazione" if j.get("track") else "link", "vecchio": True}
        else:
            o = {"src": "caricato" if top in ("Caricati", "Dal telefono") else "scaricato" if top in ("Scaricati", "Spotify") else "libreria",
                 "vecchio": True}
    return jsonify(kind="file", origine=o, file=metadati.qualita(path), formato=rel.rsplit(".", 1)[-1].upper())


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)
    threading.Thread(target=proposte, daemon=True, name="proposte").start()

