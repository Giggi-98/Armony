"""
Armony - fra amici dello stesso server (capacità "amici").

  GET  /api/amici/utenti           gli altri utenti del server (collaboratori, destinatari di «Manda a un amico»)
  GET  /api/collab?pid=…           collaboratori di una playlist (proprietario, collaboratori, amministratore)
  PUT  /api/collab                 {pid, users}: il proprietario sceglie i collaboratori. Con almeno uno la playlist
                                   diventa pubblica su Navidrome, così i collaboratori la leggono con le app Subsonic
  GET  /api/collab/mie             le playlist degli altri in cui collaboro
  POST /api/collab/aggiungi        {pid, ids}: aggiunge brani (proprietario o collaboratore)
  POST /api/manda                  {to, kind, id, title, sub, msg}: un brano, un album o una playlist a un amico
                                   (arriva come notifica e nella pagina Amici → Ricevuti)
  GET  /api/manda                  ricevuti e mandati
  GET  /api/blend?con=…            il mix di due amici dai loro ascolti (scrobble di Navidrome), con l'affinità
  POST /api/password               {old, new}: cambio della propria password (verificata su Navidrome)
  PUT  /api/profilo/avatar         {data}: la propria foto (JPEG quadrato, già ridotto dal client); DELETE la toglie
  GET  /api/avatar/<utente>        la foto di un utente, solo a chi è collegato (404 se non ce l'ha)

─── PERCHÉ le modifiche dei collaboratori passano dal server ───
Navidrome lascia modificare una playlist solo al proprietario. Armony controlla che chi chiede sia collaboratore e
fa la modifica come amministratore di Navidrome (come la riconciliazione delle importazioni), sotto lo stesso blocco
per playlist (importa.plock).
"""
import base64
import hashlib
import os
import secrets
import time

import requests
from flask import Blueprint, g, jsonify, request, send_file

import db

bp = Blueprint("amici", __name__)
A = None


def utenti_server():
    """Nomi degli utenti del server: da Navidrome se c'è il suo amministratore, altrimenti chi ha un dispositivo."""
    try:
        names = [u["userName"] for u in A.utenti.nd_users()]
    except Exception:  # noqa: BLE001
        names = [r["user"] for r in db.all_("SELECT DISTINCT user FROM devices WHERE state = 'fidato'")]
    return sorted({n for n in names if n}, key=str.lower)


def canon(name):
    """Il nome come lo scrive Navidrome (o None se non esiste)."""
    return next((n for n in utenti_server() if n.lower() == str(name or "").lower()), None)


def collab_di(user):
    return {r["pid"] for r in db.all_("SELECT pid FROM collab WHERE lower(user) = lower(?)", user or "")}


def e_collab(pid, user):
    return bool(user and db.one("SELECT 1 FROM collab WHERE pid = ? AND lower(user) = lower(?)", pid, user))


def nome_pl(pid):
    c = A.importa.nd()
    try:
        r = c.execute("SELECT name FROM playlist WHERE id = ?", (pid,)).fetchone()
    finally:
        c.close()
    return r[0] if r else "playlist"


@bp.get("/api/amici/utenti")
def amici_utenti():
    me = (g.who.get("user") or "").lower()
    return jsonify(users=[n for n in utenti_server() if n.lower() != me])


@bp.get("/api/collab")
def collab_get():
    pid, u = request.args.get("pid") or "", g.who.get("user") or ""
    own = A.importa.owner_of(pid) if A.ID_RE.match(pid) else None
    if own is None:
        return jsonify(error="Playlist non trovata"), 404
    if not (g.who["admin"] or own.lower() == u.lower() or e_collab(pid, u)):
        return jsonify(error="Non è una tua playlist."), 403
    return jsonify(owner=own, users=[r["user"] for r in db.all_("SELECT user FROM collab WHERE pid = ? ORDER BY added", pid)])


@bp.put("/api/collab")
def collab_put():
    d = request.get_json(silent=True) or {}
    pid, u = str(d.get("pid") or ""), g.who.get("user") or ""
    own = A.importa.owner_of(pid) if A.ID_RE.match(pid) else None
    if own is None:
        return jsonify(error="Playlist non trovata"), 404
    if not (g.who["admin"] or own.lower() == u.lower()):
        return jsonify(error="Solo chi ha creato la playlist sceglie i collaboratori."), 403
    if not A.nd_admin():
        return jsonify(error="Serve l'amministratore di Navidrome (Impostazioni → Utenti → Registrazione).", code="nd"), 409
    want = [c for c in (canon(x) for x in (d.get("users") or [])[:50]) if c and c.lower() != own.lower()]
    prima = {r["user"].lower() for r in db.all_("SELECT user FROM collab WHERE pid = ?", pid)}
    db.run("DELETE FROM collab WHERE pid = ?", pid)
    for x in want:
        db.run("INSERT INTO collab (pid, user, added) VALUES (?, ?, ?)", pid, x, time.time())
    if want:
        A.federazione.nd_get("updatePlaylist", playlistId=pid, public="true")  # i collaboratori la leggono anche da Subsonic
    nome = nome_pl(pid)
    for x in want:
        if x.lower() not in prima:
            A.notifiche.notifica(x, "amici", f"{own} ti ha invitato a collaborare", f"«{nome}»: puoi aggiungere, togliere e riordinare i brani",
                                 f"#/playlist/{pid}", only_once=f"collab:{pid}:{x.lower()}:{int(time.time() // 3600)}")
        A.live_put(x, {"type": "libreria", "playlists": [{"id": pid, "added": 0}]})
    return jsonify(owner=own, users=want)


@bp.get("/api/collab/mie")
def collab_mie():
    pids = collab_di(g.who.get("user"))
    if not pids:
        return jsonify(items=[])
    c = A.importa.nd()
    try:
        q = ",".join("?" * len(pids))
        rows = c.execute(f"SELECT p.id, p.name, u.user_name, p.song_count FROM playlist p JOIN user u ON u.id = p.owner_id WHERE p.id IN ({q})", tuple(pids)).fetchall()
    finally:
        c.close()
    return jsonify(items=[{"id": r[0], "name": r[1], "owner": r[2], "songCount": r[3]} for r in rows])


@bp.post("/api/collab/aggiungi")
def collab_aggiungi():
    d = request.get_json(silent=True) or {}
    pid, u = str(d.get("pid") or ""), g.who.get("user") or ""
    ids = [str(x) for x in (d.get("ids") or [])[:500] if A.ID_RE.match(str(x))]
    own = A.importa.owner_of(pid) if A.ID_RE.match(pid) else None
    if own is None or not ids:
        return jsonify(error="Richiesta non valida"), 400
    if not (g.who["admin"] or own.lower() == u.lower() or e_collab(pid, u)):
        return jsonify(error="Non collabori a questa playlist."), 403
    if not g.who["admin"] and not g.who["perm"].get("playlist", True):
        return jsonify(error="«Crea e modifica playlist» non è abilitato per il tuo utente."), 403
    with A.importa.plock(pid):
        for i in range(0, len(ids), 200):
            A.federazione.nd_get("updatePlaylist", playlistId=pid, songIdToAdd=ids[i:i + 200])
    nome = nome_pl(pid)
    tutti = {own, *(r["user"] for r in db.all_("SELECT user FROM collab WHERE pid = ?", pid))}
    for x in tutti:
        A.live_put(x, {"type": "libreria", "playlists": [{"id": pid, "added": len(ids)}]})
        if x.lower() != u.lower():
            # una notifica ogni 10 minuti per playlist e persona, non una per brano
            A.notifiche.notifica(x, "amici", f"{u} ha aggiunto {len(ids)} {'brano' if len(ids) == 1 else 'brani'}", f"a «{nome}»",
                                 f"#/playlist/{pid}", only_once=f"collabadd:{pid}:{x.lower()}:{u.lower()}:{int(time.time() // 600)}")
    return jsonify(ok=True, added=len(ids))


# ------------------------------------------------------------------ «Manda a un amico»
COSE = {"brano": "un brano", "album": "un album", "playlist": "una playlist", "artista": "un artista"}


@bp.post("/api/manda")
def manda():
    d = request.get_json(silent=True) or {}
    me, to = g.who.get("user") or "", canon(d.get("to"))
    kind, ref = str(d.get("kind") or ""), str(d.get("id") or "")
    if not me or not to or to.lower() == me.lower() or kind not in COSE or not A.ID_RE.match(ref):
        return jsonify(error="Richiesta non valida"), 400
    if A.dispositivi.ip_limit("manda", 60, 3600):
        return A.dispositivi.too_many(600)
    title, sub, msg = str(d.get("title") or "")[:120], str(d.get("sub") or "")[:120], str(d.get("msg") or "").strip()[:280]
    cur = db.conn().execute("INSERT INTO mandati (da, a, ts, kind, ref, title, sub, msg) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                            (me, to, time.time(), kind, ref, title, sub, msg))
    link = {"album": f"#/album/{ref}", "playlist": f"#/playlist/{ref}", "artista": f"#/artista/{ref}"}.get(kind, "#/amici")
    A.notifiche.notifica(to, "amici", f"{A.pres_who(me)[1]} ti ha mandato {COSE[kind]}", f"«{title}»{' di ' + sub if sub else ''}{' — ' + msg if msg else ''}", link,
                         only_once=f"manda:{cur.lastrowid}")
    return jsonify(ok=True)


@bp.get("/api/manda")
def manda_get():
    me = g.who.get("user") or ""
    rec = db.all_("SELECT id, da, ts, kind, ref, title, sub, msg FROM mandati WHERE lower(a) = lower(?) ORDER BY id DESC LIMIT 50", me)
    sent = db.all_("SELECT id, a, ts, kind, ref, title, sub, msg FROM mandati WHERE lower(da) = lower(?) ORDER BY id DESC LIMIT 20", me)
    return jsonify(ricevuti=[{**dict(r), "nome": A.pres_who(r["da"])[1]} for r in rec], mandati=[dict(r) for r in sent])


# ------------------------------------------------------------------ Blend: il mix di due amici
@bp.get("/api/blend")
def blend():
    """Dai loro ascolti degli ultimi 6 mesi (scrobble di Navidrome): i brani che piacciono a entrambi, poi alternati quelli
    di ciascuno; affinità = somiglianza fra gli artisti ascoltati (coseno). Solo con chi mostra i suoi ascolti agli amici."""
    me, con = g.who.get("user") or "", canon(request.args.get("con"))
    if not con or con.lower() == me.lower():
        return jsonify(error="Scegli un amico."), 400
    if not A.pres_who(con)[0]:
        return jsonify(error=f"{con} non mostra i suoi ascolti agli amici."), 403
    since = time.time() - 180 * 86400
    c = A.importa.nd()
    try:
        sc = c.execute("SELECT typeof(submission_time) FROM scrobbles LIMIT 1").fetchone()
        arg = since if not sc or sc[0] in ("integer", "real") else time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(since))
        def di(u):
            return c.execute("SELECT m.id, m.artist, count(*) n FROM scrobbles s JOIN user x ON x.id = s.user_id JOIN media_file m ON m.id = s.media_file_id "
                             "WHERE lower(x.user_name) = lower(?) AND s.submission_time >= ? AND m.missing = 0 GROUP BY m.id ORDER BY n DESC LIMIT 400", (u, arg)).fetchall()
        a, b = di(me), di(con)
    finally:
        c.close()
    if not a or not b:
        return jsonify(error=f"{'Tu non hai' if not a else con + ' non ha'} ancora abbastanza ascolti su questo server."), 404
    ca, cb = {r[0]: r[2] for r in a}, {r[0]: r[2] for r in b}
    comuni = sorted(set(ca) & set(cb), key=lambda x: -min(ca[x], cb[x]))
    solo_a = [r[0] for r in a if r[0] not in cb]
    solo_b = [r[0] for r in b if r[0] not in ca]
    mix, i = comuni[:20], 0
    while len(mix) < 50 and (i < len(solo_a) or i < len(solo_b)):
        mix += [x for x in (solo_a[i:i + 1] + solo_b[i:i + 1])]
        i += 1
    arts_a, arts_b = {}, {}
    for r in a:
        arts_a[r[1]] = arts_a.get(r[1], 0) + r[2]
    for r in b:
        arts_b[r[1]] = arts_b.get(r[1], 0) + r[2]
    dot = sum(v * arts_b.get(k, 0) for k, v in arts_a.items())
    na, nb = sum(v * v for v in arts_a.values()) ** .5, sum(v * v for v in arts_b.values()) ** .5
    aff = round(100 * dot / (na * nb)) if na and nb else 0
    insieme = sorted(set(arts_a) & set(arts_b), key=lambda k: -min(arts_a[k], arts_b[k]))[:5]
    return jsonify(con=con, nome=A.pres_who(con)[1], ids=mix[:50], affinita=aff, artisti=insieme, comuni=len(comuni))


# ------------------------------------------------------------------ cambio password
@bp.post("/api/password")
def password():
    """Verifica la vecchia su Navidrome, scrive la nuova (come amministratore di Navidrome) e manda a tutti i dispositivi
    dell'utente le credenziali Subsonic nuove sul canale dal vivo: restano collegati senza reinserirla."""
    d = request.get_json(silent=True) or {}
    u, old, new = g.who.get("user") or "", str(d.get("old") or ""), str(d.get("new") or "")
    if not u:
        return jsonify(error="Serve l'accesso di un utente."), 400
    if len(new) < 8:
        return jsonify(error="La password nuova deve avere almeno 8 caratteri."), 400
    if A.dispositivi.ip_limit("password", 5, 600):
        return A.dispositivi.too_many(600)
    salt = secrets.token_hex(6)
    r, err = A.dispositivi.nd_user(u, hashlib.md5((old + salt).encode()).hexdigest(), salt)
    if err:
        return err
    if r.get("status") != "ok":
        return jsonify(error="La password attuale non è giusta."), 403
    try:
        x = A.utenti.nd_user(u)
        if not x:
            raise ValueError("utente non trovato")
        A.federazione.nd_native("PUT", f"/api/user/{x['id']}", json={**x, "password": new, "currentPassword": old})
    except (A.federazione.FedError, requests.RequestException, ValueError) as e:
        return jsonify(error="Navidrome non ha accettato la password nuova: " + str(e)[:100]), 502
    s2 = secrets.token_hex(6)
    t2 = hashlib.md5((new + s2).encode()).hexdigest()
    A.live_put(u, {"type": "credenziali", "t": t2, "s": s2})
    A.dispositivi.event("password", u, g.who.get("dev"), "password cambiata da Armony")
    return jsonify(ok=True, t=t2, s=s2)


# ------------------------------------------------------------------ foto profilo
def av_path(user):
    # nome del file dall'impronta del nome utente: niente percorsi costruiti con quello che scrive il client
    return os.path.join(os.path.dirname(db.PATH), "avatar", hashlib.sha1(str(user).lower().encode()).hexdigest()[:20] + ".jpg")


@bp.put("/api/profilo/avatar")
def avatar_put():
    u = g.who.get("user")
    if not u:
        return jsonify(error="Serve l'accesso di un utente."), 400
    raw = str((request.get_json(silent=True) or {}).get("data") or "")
    try:
        img = base64.b64decode(raw.split(",", 1)[1] if raw.startswith("data:") else raw, validate=False)
    except (ValueError, IndexError):
        return jsonify(error="Immagine non valida"), 400
    if not img.startswith(b"\xff\xd8\xff") or len(img) > 400_000:
        return jsonify(error="Serve una foto JPEG sotto i 400 kB (l'app la riduce da sola)."), 400
    p = av_path(u)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p + ".part", "wb") as f:
        f.write(img)
    os.replace(p + ".part", p)
    A.pres_put({"type": "avatar", "user": u, "v": int(time.time())})  # gli altri aggiornano la foto senza ricaricare
    return jsonify(ok=True, v=int(time.time()))


@bp.delete("/api/profilo/avatar")
def avatar_del():
    u = g.who.get("user")
    try:
        os.remove(av_path(u))
    except OSError:
        pass
    A.pres_put({"type": "avatar", "user": u, "v": 0})
    return jsonify(ok=True)


@bp.get("/api/avatar/<name>")
def avatar_get(name):
    p = av_path(name)
    if not os.path.isfile(p):
        return jsonify(error="Nessuna foto"), 404
    r = send_file(p, mimetype="image/jpeg", max_age=3600)
    r.headers["Cache-Control"] = "private, max-age=3600"
    return r


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)
