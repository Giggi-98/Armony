"""
Armony - sveglia (capacità "sveglia").

  GET  /api/sveglia                 le mie sveglie
  PUT  /api/sveglia                 {sveglie: [...]}: le mie sveglie, tutte insieme (al più 10)
  POST /api/sveglia/<id>/prova      fa partire subito quella sveglia

Una sveglia: {id, attiva, ora "07:30", giorni [0-6, lunedì = 0], fuso "Europe/Rome", dispositivo, nome_dispositivo,
cosa "mix" | "playlist", playlist, nome_playlist, volume 0…1}. All'ora giusta (nel fuso di chi l'ha creata) il server manda
la coda al dispositivo scelto (una TV, una cassa Bluetooth, un telefono o un computer collegato) con «transfer», come
farebbe un telecomando, e alza il volume piano: dal 15% a quello scelto in 5 minuti. La sveglia la fa partire il
server: funziona anche col telefono spento, se suona su una TV o una cassa.
"""
import datetime
import json
import re
import secrets
import threading
import time
import zoneinfo

from flask import Blueprint, g, jsonify, request

import db

bp = Blueprint("sveglia", __name__)
A = None
SALITA_S, PASSI = 300, 15     # il volume sale in 5 minuti, a 15 scalini


def mie(u):
    r = db.one("SELECT value FROM settings WHERE key = ?", "sveglia:" + u)
    return json.loads(r["value"]) if r else []


def pulita(x):
    ora = str(x.get("ora") or "")
    if not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", ora):
        raise ValueError("Ora non valida")
    fuso = str(x.get("fuso") or "Europe/Rome")
    try:
        zoneinfo.ZoneInfo(fuso)
    except (zoneinfo.ZoneInfoNotFoundError, ValueError):
        fuso = "Europe/Rome"
    return {"id": str(x.get("id") or secrets.token_hex(4))[:12], "attiva": bool(x.get("attiva", True)), "ora": ora,
            "giorni": sorted({int(d) for d in x.get("giorni") or [] if str(d).isdigit() and 0 <= int(d) <= 6}), "fuso": fuso,
            "dispositivo": str(x.get("dispositivo") or "")[:80], "nome_dispositivo": str(x.get("nome_dispositivo") or "")[:80],
            "cosa": "playlist" if x.get("cosa") == "playlist" else "mix", "playlist": str(x.get("playlist") or "")[:80],
            "nome_playlist": str(x.get("nome_playlist") or "")[:120], "volume": max(0.05, min(1.0, float(x.get("volume") or 0.5))),
            "ultima": x.get("ultima")}


@bp.get("/api/sveglia")
def elenco():
    return jsonify(sveglie=mie(g.who.get("user") or ""))


@bp.put("/api/sveglia")
def salva():
    u = g.who.get("user")
    if not u:
        return jsonify(error="Serve un utente"), 400
    prima = {x["id"]: x for x in mie(u)}
    try:
        nuove = [pulita({**x, "ultima": prima.get(x.get("id"), {}).get("ultima")}) for x in (request.get_json(silent=True) or {}).get("sveglie") or []][:10]
    except (ValueError, TypeError) as e:
        return jsonify(error=str(e)), 400
    if any(not x["dispositivo"] for x in nuove):
        return jsonify(error="Scegli dove suonare"), 400
    db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", "sveglia:" + u, json.dumps(nuove))
    return jsonify(sveglie=nuove)


@bp.post("/api/sveglia/<sid>/prova")
def prova(sid):
    u = g.who.get("user") or ""
    x = next((x for x in mie(u) if x["id"] == sid), None)
    if not x:
        return jsonify(error="Sveglia non trovata"), 404
    try:
        suona(u, x)
    except (ValueError, RuntimeError) as e:
        return jsonify(error=str(e)), 409
    return jsonify(ok=True)


# ------------------------------------------------------------------ all'ora giusta
def coda(u, x):
    if x["cosa"] == "playlist" and x["playlist"]:
        brani = A.federazione.nd_get("getPlaylist", id=x["playlist"]).get("playlist", {}).get("entry") or []
        if brani:
            return [A.bot.brano_wire(t) for t in brani[:1000]]
    return A.bot.mix_del_giorno(u)[1]  # anche se la playlist non c'è più: meglio un mix che il silenzio


def collegato(u, dev):
    if A.casa.esiste(dev):
        return True
    with A.llock:
        return any(c["device"] == dev for c in A.lconns.get(u, {}).values())


def suona(u, x):
    dev = x["dispositivo"]
    if not collegato(u, dev):
        raise ValueError(f"{x['nome_dispositivo'] or 'Il dispositivo'} non è collegato adesso")
    brani = coda(u, x)
    if not brani:
        raise ValueError("Niente da suonare: la libreria è vuota")
    alto = x["volume"]
    try:
        A.manda_cmd(u, dev, "volume", 0.15, "sveglia")
    except (ValueError, RuntimeError):
        pass  # una TV senza volume dalla rete suona com'è
    A.manda_cmd(u, dev, "transfer", {"queue": brani, "index": 0, "position": 0, "shuffle": False, "repeat": "all"}, "sveglia")
    threading.Thread(target=sali, args=(u, dev, alto), daemon=True).start()


def sali(u, dev, alto):
    for i in range(1, PASSI + 1):
        time.sleep(SALITA_S / PASSI)
        try:
            A.manda_cmd(u, dev, "volume", round(0.15 + (alto - 0.15) * i / PASSI, 2), "sveglia")
        except (ValueError, RuntimeError):
            return


def giro():
    while True:
        time.sleep(20)
        for r in db.all_("SELECT key, value FROM settings WHERE key LIKE 'sveglia:%'"):
            u, sveglie, cambiate = r["key"].split(":", 1)[1], json.loads(r["value"]), False
            for x in sveglie:
                adesso = datetime.datetime.now(zoneinfo.ZoneInfo(x["fuso"]))
                oggi = adesso.strftime("%Y-%m-%d")
                if not x["attiva"] or adesso.strftime("%H:%M") != x["ora"] or x.get("ultima") == oggi or (x["giorni"] and adesso.weekday() not in x["giorni"]):
                    continue
                x["ultima"], cambiate = oggi, True
                if not x["giorni"]:
                    x["attiva"] = False  # senza giorni suona una volta sola
                try:
                    suona(u, x)
                    A.diagnosi.log("info", "sveglia", f"sveglia di {u} alle {x['ora']} su {x['nome_dispositivo']}")
                except Exception as e:  # noqa: BLE001 - una sveglia che non parte va detta, non deve fermare le altre
                    A.notifiche.notifica(u, "sistema", "⏰ La sveglia non è partita", str(e)[:200], "#/impostazioni/sveglia")
            if cambiate:
                db.run("UPDATE settings SET value = ? WHERE key = ?", json.dumps(sveglie), r["key"])


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)


def start():
    threading.Thread(target=giro, daemon=True).start()
