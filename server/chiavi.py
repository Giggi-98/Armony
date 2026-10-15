"""
Armony - chiavi API per i programmi di casa (homelab): capacità "chiaviapi".

  GET    /api/chiavi              (utente) le mie chiavi: nome, accesso, creata, ultimo uso
  POST   /api/chiavi              (utente) {nome, scrive}: una chiave nuova, che si vede una volta sola
  DELETE /api/chiavi/<id>         (utente) revoca una mia chiave

Una chiave vale come una sessione del suo utente su tutte le rotte /api/* (stessi permessi, amministratore compreso),
mandata come «Authorization: Bearer arm_…» o «X-Token: arm_…». Vale solo dalla rete di casa o da Tailscale, mai su
/rest (Navidrome); le rotte che creano accessi (ACCESSI) le legge soltanto. Di sola lettura, accetta solo GET.
In diretta: GET /api/live?device=<id>&name=<nome> è il canale degli eventi; con una chiave il programma osserva e
basta (non compare fra i dispositivi, non annuncia niente agli altri).

─── PERCHÉ chiavi accanto al gettone di Home Assistant ───
Il gettone di Home Assistant (homeassistant.py) fa solo stato e comandi della musica dell'utente; un homelab (plance,
script, monitoraggio) vuole vedere tutto quello che vede l'utente, anche il server se è amministratore. Nel database
c'è solo l'impronta sha256 della chiave.
"""
import hashlib
import json
import secrets
import time

from flask import Blueprint, g, jsonify, request

import db

bp = Blueprint("chiavi", __name__)
A = None
PREFISSO = "arm_"
MAX = 20  # chiavi per utente
# rotte che creano altri accessi (chiavi, dispositivi, password, utenti, gettoni, chat del bot): con una chiave si leggono
# e basta, così una chiave rubata in casa non diventa un dispositivo che entra da internet
ACCESSI = ("/api/chiavi", "/api/dispositivi", "/api/password", "/api/users", "/api/register", "/api/homeassistant", "/api/bot", "/api/sicurezza")


def impronta(t):
    return hashlib.sha256(t.encode()).hexdigest()


def mie(u):
    out = []
    for r in db.all_("SELECT key, value FROM settings WHERE key LIKE 'apikey:%'"):
        k = json.loads(r["value"])
        if k["user"] == u:
            out.append(k)
    return sorted(out, key=lambda k: -k["creata"])


def identity(tok):
    """La sessione di una chiave (dispositivi.identity), o None con g.why."""
    k = db.one("SELECT value FROM settings WHERE key = ?", "apikey:" + impronta(tok))
    if not k:
        return None
    k = json.loads(k["value"])
    if not request.path.startswith("/api/") or (request.method not in ("GET", "HEAD") and request.path.startswith(ACCESSI)):
        g.why = "chiaveapi_rotta"
        return None
    if not A.dispositivi.is_local():
        g.why = "chiaveapi_casa"
        A.dispositivi.event("chiaveapi", k["user"], None, f"chiave «{k['nome']}» rifiutata: richiesta da internet", once="ak:" + k["id"])
        return None
    if not k["scrive"] and request.method not in ("GET", "HEAD"):
        g.why = "chiaveapi_lettura"
        return None
    now = time.time()
    if now - (k.get("vista") or 0) > 300:
        k["vista"] = now
        db.run("UPDATE settings SET value = ? WHERE key = ?", json.dumps(k), "apikey:" + impronta(tok))
    # amministratore solo finché l'utente lo è ancora su un suo dispositivo fidato
    admin = bool(k["admin"] and db.one("SELECT 1 FROM devices WHERE user = ? AND admin = 1 AND state = 'fidato'", k["user"]))
    p = A.utenti.perms(k["user"], admin)
    return dict(user=k["user"], admin=admin, upload=p["upload"], download=p["download"], delete=p["delete"], perm=p,
                dev=None, keyed=False, gen=0, chiave=k["id"])


@bp.get("/api/chiavi")
def elenco():
    return jsonify(chiavi=[{x: k.get(x) for x in ("id", "nome", "scrive", "admin", "creata", "vista")} for k in mie(g.who["user"])],
                   base=A.trasferimento.ip_casa())


@bp.post("/api/chiavi")
def nuova():
    u, d = g.who.get("user"), request.get_json(silent=True) or {}
    if not u:
        return jsonify(error="Serve un utente"), 400
    if len(mie(u)) >= MAX:
        return jsonify(error=f"Al massimo {MAX} chiavi: revocane una"), 409
    nome = " ".join(str(d.get("nome") or "").split())[:40] or "Homelab"
    t = PREFISSO + secrets.token_urlsafe(32)
    k = {"id": secrets.token_hex(6), "user": u, "nome": nome, "scrive": bool(d.get("scrive")), "admin": bool(g.who["admin"]),
         "creata": time.time(), "vista": None}
    db.run("INSERT INTO settings (key, value) VALUES (?, ?)", "apikey:" + impronta(t), json.dumps(k))
    A.dispositivi.event("chiaveapi", u, g.who.get("dev"), f"chiave API «{nome}» creata ({'lettura e comandi' if k['scrive'] else 'sola lettura'})")
    return jsonify(chiave=t, id=k["id"], base=A.trasferimento.ip_casa()), 201


@bp.delete("/api/chiavi/<i>")
def revoca(i):
    u = g.who["user"]
    for r in db.all_("SELECT key, value FROM settings WHERE key LIKE 'apikey:%'"):
        k = json.loads(r["value"])
        if k["id"] == i and (k["user"] == u or g.who["admin"]):
            db.run("DELETE FROM settings WHERE key = ?", r["key"])
            A.dispositivi.event("chiaveapi", u, g.who.get("dev"), f"chiave API «{k['nome']}» revocata")
            # i canali dal vivo aperti con questa chiave si chiudono subito
            A.live_kick(lambda c: c.get("chiave") == i, {"type": "kicked"})
            return jsonify(ok=True)
    return jsonify(error="Chiave non trovata"), 404


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)
