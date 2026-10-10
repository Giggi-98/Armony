"""
Armony - importazioni di playlist ricordate dal server (capacità "importsrv").

  POST /api/import/playlist   {pid, name, items, download, folder, format}: il client manda il CSV già letto (Exportify,
                              M3U, JSON) e la playlist di Navidrome dove vanno i brani (creata da lui, così è sua). Il
                              server riconosce i brani sul DB di Navidrome, ricorda l'elenco, mette in coda i mancanti
                              e scrive la playlist nell'ordine del file
  GET  /api/import/stato      ?pid=…: quanti brani sono in libreria, in download, non trovati (pagina della playlist);
                              senza pid, tutte le importazioni dell'utente

─── PERCHÉ sul server e non sul telefono ───
Prima il telefono cercava un brano alla volta con search3 (900 richieste in 5G) e ricordava nel suo localStorage
cosa aggiungere quando i download finivano: a app chiusa, o importando da un dispositivo e ascoltando da un altro,
le playlist restavano a 10 brani su 940 anche con 700 brani già in libreria. Qui il riconoscimento è una lettura
del DB di Navidrome (un attimo anche con migliaia di brani) e un thread riconcilia le playlist a ogni giro: un
brano che entra in libreria da qualunque parte (download, caricamento, copia dalla rete) va al suo posto.
I brani aggiunti a mano a una playlist importata restano, in fondo.
"""
import collections
import json
import re
import sqlite3
import threading
import time
import unicodedata

from flask import Blueprint, g, jsonify, request

import db
import diagnosi
import metadati

bp = Blueprint("importa", __name__)
A = None
GIRO = 60          # secondi fra due riconciliazioni complete (prima, se la libreria cambia)
_lock = threading.Lock()
_idx = {"at": 0, "scan": None, "lib": None}
_dirty = {"at": 0}


def nd():
    return sqlite3.connect(f"file:{A.NAVIDROME_DB}?mode=ro", uri=True, timeout=10)


def nt(s, bare=False):
    """Titolo o nome per il confronto: come metadati.norm ma Unicode (un titolo in cirillico non diventa vuoto);
    bare: anche senza tutto ciò che sta fra parentesi ("Get Down On It (Single Version)" = "Get Down On It - Single Version")."""
    s = "".join(c for c in unicodedata.normalize("NFKD", str(s or "")).casefold() if not unicodedata.combining(c))
    if bare:
        s = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", s)
    s = re.sub(r"\((feat|ft|with)[^)]*\)|\[[^\]]*\]|\s-\s.*(remaster|version|edit|mix|live|demo|remix|radio).*$", " ", s)
    s = re.sub(r"\b(feat|ft)\.?\s.*$", " ", s)
    return re.sub(r"[\W_]+", " ", s).strip()


def key(t):
    return t.get("isrc") or metadati.norm(" ".join((t.get("artists") or [])[:1]) + " " + (t.get("title") or ""))


class Lib:
    """Indice della libreria per riconoscere i brani: ISRC, titolo normalizzato, percorso."""
    def __init__(self):
        self.isrc, self.title, self.path = {}, collections.defaultdict(list), {}
        c = nd()
        try:
            rows = c.execute("SELECT m.id, m.title, m.artist, m.album_artist, m.duration, m.tags, m.path FROM media_file m "
                             "JOIN library l ON l.id = m.library_id WHERE m.missing = 0 AND rtrim(l.path, '/') = ?", (A.NAVIDROME_MUSIC,)).fetchall()
        finally:
            c.close()
        for mid, title, artist, aa, dur, tags, path in rows:
            try:
                for i in (json.loads(tags or "{}").get("isrc") or []):
                    v = i.get("value") if isinstance(i, dict) else i
                    if v:
                        self.isrc[str(v).upper()] = mid
            except (ValueError, AttributeError):
                pass
            row = (mid, nt(f"{artist} {aa}"), dur or 0)
            for k in {nt(title), nt(title, True)}:
                if k:
                    self.title[k].append(row)
            self.path[path] = mid

    def match(self, t):
        """id del brano in libreria, o None. Con più candidati vince artista + durata; sotto la soglia nessuno."""
        if t.get("isrc") and t["isrc"].upper() in self.isrc:
            return self.isrc[t["isrc"].upper()]
        ks = {nt(t.get("title")), nt(t.get("title"), True)} - {""}
        if not ks:
            return None
        arts = [nt(a) for a in (t.get("artists") or []) if a] or ([nt(t["artist"])] if t.get("artist") else [])
        best, bs = None, -99
        for mid, xa, d in {r for k in ks for r in self.title.get(k, [])}:
            # titolo e artista uguali bastano (un'altra versione del brano resta il brano); la durata sceglie fra più candidati
            sc = 3 + ((2 if any(a and a in xa for a in arts) else -2) if arts else 0)
            if t.get("duration") and d:
                dd = abs(d - t["duration"])
                sc += 1 if dd <= 3 else 0 if dd <= 8 else -.5
            if sc > bs:
                best, bs = mid, sc
        return best if best and bs >= (4.5 if arts else 3) else None


def lib():
    # l'indice si rifà quando Navidrome finisce una scansione, o al più ogni 5 minuti
    scan = A.nd_last_scan()
    with _lock:
        if not _idx["lib"] or scan != _idx["scan"] or time.time() - _idx["at"] > 300:
            _idx.update(lib=Lib(), scan=scan, at=time.time())
        return _idx["lib"]


_plocks = collections.defaultdict(threading.Lock)


def plock(pid):
    # una riconciliazione alla volta per playlist: la richiesta d'importazione e il giro non si intrecciano
    with _lock:
        return _plocks[pid]


def owner_of(pid):
    c = nd()
    try:
        r = c.execute("SELECT u.user_name FROM playlist p JOIN user u ON u.id = p.owner_id WHERE p.id = ?", (pid,)).fetchone()
    finally:
        c.close()
    return r[0] if r else None


def entries(pid):
    c = nd()
    try:
        return [r[0] for r in c.execute("SELECT media_file_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY id", (pid,))]
    finally:
        c.close()


def stato_di(imp, L=None, write=True):
    """Riconcilia una playlist importata con la libreria e restituisce il suo stato."""
    L = L or lib()
    items = json.loads(imp["items"])
    with A.jlock:
        by_key = {key(j["track"]): j for j in A.jobs.values() if j.get("track")}
    want, seen, inlib, dl, err, miss = [], set(), 0, 0, [], []
    for t in items:
        mid = L.match(t)
        j = by_key.get(key(t))
        if not mid and j and j.get("path"):
            mid = L.path.get(j["path"])  # scaricato con un titolo diverso da quello del CSV
        if mid:
            inlib += 1
            if mid not in seen:
                seen.add(mid)
                want.append(mid)
        elif j and j["status"] not in A.DONE:
            dl += 1
        elif j and j["status"] == "errore":
            err.append({"title": f"{', '.join(t.get('artists') or [])} - {t.get('title')}", "error": j.get("error")})
        else:
            miss.append(t)
    old = json.loads(imp["state"] or "{}") if imp["state"] else {}
    put = set(old.get("put") or [])  # brani che la riconciliazione ha già messo nella playlist
    if write:
        with plock(imp["pid"]):
            cur = entries(imp["pid"])
            # tolto a mano dall'utente dopo che l'avevamo messo: non si rimette (resta tolto anche ai giri dopo)
            gone = put - set(cur)
            want = [x for x in want if x not in gone]
            new = [x for x in want if x not in set(cur)]
            # si riscrive al primo giro dopo l'importazione (ordine del file), se c'è qualcosa da aggiungere o se ci sono
            # doppioni; altrimenti un riordino fatto a mano resta finché non arriva un brano nuovo
            if new or not old.get("put") or len(cur) != len(set(cur)):
                extra = [x for x in dict.fromkeys(cur) if x not in set(want)]
                scrivi(imp["pid"], want + extra, cur)
            put = (put - gone) | set(want)
    st = {"total": len(items), "inlib": inlib, "dl": dl, "err": len(err), "miss": len(miss), "failed": err[:50], "at": time.time(), "put": sorted(put)}
    db.run("UPDATE imports SET state = ? WHERE pid = ?", json.dumps(st), imp["pid"])
    return st, miss, want


def scrivi(pid, ids, cur):
    # updatePlaylist e non createPlaylist con playlistId: come amministratore di Navidrome vale anche sulle playlist degli
    # altri utenti. Si tolgono le voci a pezzi partendo dal fondo (gli indici prima non si spostano), poi si aggiungono
    before = len(cur)
    for end in range(before, 0, -200):
        A.federazione.nd_get("updatePlaylist", playlistId=pid, songIndexToRemove=list(range(max(0, end - 200), end)))
    for i in range(0, len(ids), 200):
        A.federazione.nd_get("updatePlaylist", playlistId=pid, songIdToAdd=ids[i:i + 200])
    if len(ids) != before:
        u = owner_of(pid)
        if u:
            A.live_put(u, {"type": "libreria", "playlists": [{"id": pid, "added": max(0, len(ids) - before)}]})


def giro(force=False):
    """Tutte le playlist importate: completate e in ordine. Ogni GIRO secondi, o subito se la libreria è cambiata."""
    if not A.nd_admin():
        return
    now = time.time()
    if not force and now - _dirty["at"] < GIRO and _idx["scan"] == A.nd_last_scan():
        return
    _dirty["at"] = now
    L = lib()
    for imp in db.all_("SELECT * FROM imports"):
        try:
            if owner_of(imp["pid"]) is None:
                db.run("DELETE FROM imports WHERE pid = ?", imp["pid"])  # la playlist non c'è più
                continue
            stato_di(imp, L)
        except Exception as e:  # noqa: BLE001
            diagnosi.errore("import", f"riconciliazione di «{imp['name']}» non riuscita: {e}", e, user=imp["owner"])


@bp.post("/api/import/playlist")
def importa():
    d = request.get_json(silent=True) or {}
    u, pid = g.who.get("user"), str(d.get("pid") or "")
    if not u:
        return jsonify(error="Serve l'accesso di un utente."), 400
    if not A.nd_admin():
        return jsonify(error="Serve l'amministratore di Navidrome in Impostazioni → Utenti → Registrazione."), 503
    if not A.ID_RE.match(pid) or owner_of(pid) != u:
        return jsonify(error="Playlist non trovata, o non è tua."), 404
    items = [t for t in (A.clean_track(x) for x in (d.get("items") or [])[:10000] if isinstance(x, dict)) if t]
    if not items:
        return jsonify(error="Nessun brano nel file."), 400
    name = str(d.get("name") or "Playlist")[:120]
    now = time.time()
    db.run("INSERT INTO imports (pid, owner, name, items, created, updated) VALUES (?, ?, ?, ?, ?, ?) "
           "ON CONFLICT(pid) DO UPDATE SET items = excluded.items, name = excluded.name, updated = excluded.updated, state = NULL",
           pid, u, name, json.dumps(items), now, now)
    imp = db.one("SELECT * FROM imports WHERE pid = ?", pid)
    st, miss, ids = stato_di(imp)
    queued = 0
    if miss and d.get("download") and g.who["download"]:
        fmt = d.get("format") if d.get("format") in A.AUDIO_FORMATS else "m4a"
        r = A.accoda(miss, fmt, d.get("folder") or "Spotify", "Spotify: " + name, u)
        queued = r["added"]
        st, _, _ = stato_di(imp, write=False)
    # reimportare il file vuol dire rifarla com'è nel file: anche i brani tolti a mano (state = NULL) tornano
    return jsonify(pid=pid, queued=queued, **{k: v for k, v in st.items() if k not in ("failed", "put")}, **({"ids": ids} if d.get("ids") else {}),
                   missing=[f"{', '.join(t.get('artists') or [])} - {t['title']}" for t in miss[:40]] if not queued else [])


@bp.get("/api/import/stato")
def stato():
    u, pid = g.who.get("user"), request.args.get("pid")
    rows = db.all_("SELECT pid, name, state, updated FROM imports WHERE " + ("pid = ? AND (owner = ? OR ?)" if pid else "owner = ?"),
                   *((pid, u, int(g.who["admin"])) if pid else (u,)))
    out = [{"pid": r["pid"], "name": r["name"], "updated": r["updated"], **{k: v for k, v in json.loads(r["state"] or "{}").items() if k != "put"}} for r in rows]
    return jsonify(out[0] if pid and out else None if pid else out)


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)
