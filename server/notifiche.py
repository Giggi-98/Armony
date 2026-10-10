"""
Armony - notifiche per utente (capacità "notifiche").

  GET  /api/notifiche          le ultime 60 dell'utente e quante non lette
  POST /api/notifiche/lette    {ids} o niente (= tutte): segnate come lette

Ogni notifica nasce sul server (importazione completata, download finiti o non riusciti, un amico apre una Jam, un
dispositivo aspetta l'approvazione), si salva (restano le ultime 200 per utente) e arriva subito ai dispositivi
dell'utente sul canale dal vivo ({"type": "notifica"}). Il client la mostra nella campanella; con la pagina nascosta
il browser la mostra come notifica di sistema, l'app Android come notifica del canale «Avvisi» (ArmonyFiles).

─── PERCHÉ niente push ───
Le notifiche push (Firebase per Android, Web Push per il browser) passano da servizi esterni e chiedono chiavi e un
account: scartate (DECISIONS). Arrivano quindi solo mentre il dispositivo tiene aperto il canale dal vivo; quelle perse
restano nella campanella.
"""
import time

from flask import Blueprint, g, jsonify, request

import db

bp = Blueprint("notifiche", __name__)
A = None
KINDS = ("import", "download", "jam", "dispositivi", "sistema")
KEEP = 200


def notifica(user, kind, title, body="", link=None, only_once=None):
    """Nuova notifica per un utente. only_once: chiave per non ripeterla (es. la stessa importazione completata)."""
    if not user or kind not in KINDS:
        return
    now = time.time()
    if only_once and db.one("SELECT 1 FROM notifiche WHERE user = ? AND once = ?", user, only_once):
        return
    cur = db.conn().execute("INSERT INTO notifiche (user, ts, kind, title, body, link, once) VALUES (?, ?, ?, ?, ?, ?, ?)",
                            (user, now, kind, str(title)[:120], str(body or "")[:300], link if link and str(link).startswith("#/") else None, only_once))
    nid = cur.lastrowid
    db.run("DELETE FROM notifiche WHERE user = ? AND id NOT IN (SELECT id FROM notifiche WHERE user = ? ORDER BY id DESC LIMIT ?)", user, user, KEEP)
    A.live_put(user, {"type": "notifica", "item": {"id": nid, "ts": now, "kind": kind, "title": str(title)[:120],
                                                   "body": str(body or "")[:300], "link": link, "letta": 0}})


@bp.get("/api/notifiche")
def elenco():
    u = g.who.get("user")
    rows = db.all_("SELECT id, ts, kind, title, body, link, letta FROM notifiche WHERE user = ? ORDER BY id DESC LIMIT 60", u)
    n = db.one("SELECT count(*) n FROM notifiche WHERE user = ? AND letta = 0", u)["n"]
    return jsonify(items=[dict(r) for r in rows], unread=n)


@bp.post("/api/notifiche/lette")
def lette():
    u, ids = g.who.get("user"), (request.get_json(silent=True) or {}).get("ids")
    if isinstance(ids, list) and ids:
        for i in ids[:200]:
            db.run("UPDATE notifiche SET letta = 1 WHERE user = ? AND id = ?", u, int(i))
    else:
        db.run("UPDATE notifiche SET letta = 1 WHERE user = ?", u)
    A.live_put(u, {"type": "notifica", "lette": ids if isinstance(ids, list) and ids else "tutte"})
    return jsonify(ok=True)


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)
