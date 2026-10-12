"""
Armony - notifiche per utente (capacità "notifiche").

  GET  /api/notifiche          le ultime 60 dell'utente e quante non lette
  POST /api/notifiche/lette    {ids} o niente (= tutte): segnate come lette
  POST /api/notifiche/gettone  un gettone per questo dispositivo (capacità "notifondo"), da dare all'app Android
  GET  /api/notifiche/nuove?dopo=ID   con X-Notifiche: <gettone>; le non lette con id > ID (pubblica di proposito: il
                               gettone vale solo qui e muore con la revoca del dispositivo)
  PUT  /api/notifiche/attivita {on}: le notifiche sugli amici (in linea, cosa ascoltano, playlist condivise) per il
                               proprio utente, su tutti i suoi dispositivi (capacità "notattivita")

Ogni notifica nasce sul server (importazione completata, download finiti o non riusciti, un amico apre una Jam, un
dispositivo aspetta l'approvazione, un amico è in linea o ascolta qualcosa), si salva (restano le ultime 200 per utente) e arriva subito ai dispositivi
dell'utente sul canale dal vivo ({"type": "notifica"}). Il client la mostra nella campanella; con la pagina nascosta
il browser la mostra come notifica di sistema, l'app Android come notifica del canale «Avvisi» (ArmonyFiles).

─── PERCHÉ niente push ───
Le notifiche push (Firebase per Android, Web Push per il browser) passano da servizi esterni e chiedono chiavi e un
account: scartate (DECISIONS). Nel browser arrivano solo mentre il canale dal vivo è aperto; quelle perse restano nella
campanella. L'app Android in più le chiede da sola ogni 15 minuti anche chiusa (WorkManager, ArmonyNotificheWorker)
con un gettone suo: la sessione del dispositivo si rinnova solo con la chiave chiusa nella WebView.
"""
import hashlib
import secrets
import threading
import time

from flask import Blueprint, g, jsonify, request

import db

bp = Blueprint("notifiche", __name__)
A = None
KINDS = ("import", "download", "jam", "dispositivi", "amici", "sistema", "attivita")
KEEP = 200
# un'emoji per tipo davanti al titolo, se chi la crea non ne ha già messa una sua
EMOJI = {"import": "📥", "download": "⬇️", "jam": "🎉", "dispositivi": "🔐", "amici": "🤝", "sistema": "⚙️", "attivita": "✨"}


def notifica(user, kind, title, body="", link=None, only_once=None):
    """Nuova notifica per un utente. only_once: chiave per non ripeterla (es. la stessa importazione completata)."""
    if not user or kind not in KINDS:
        return
    now = time.time()
    if only_once and db.one("SELECT 1 FROM notifiche WHERE user = ? AND once = ?", user, only_once):
        return
    title = str(title)
    if title and ord(title[0]) < 0x2190:  # comincia con una lettera: ci va l'emoji del tipo
        title = f"{EMOJI[kind]} {title}"
    cur = db.conn().execute("INSERT INTO notifiche (user, ts, kind, title, body, link, once) VALUES (?, ?, ?, ?, ?, ?, ?)",
                            (user, now, kind, str(title)[:120], str(body or "")[:300], link if link and str(link).startswith("#/") else None, only_once))
    nid = cur.lastrowid
    A.bot.inoltra(user, title[:120], str(body or "")[:300], link if link and str(link).startswith("#/") else None)
    db.run("DELETE FROM notifiche WHERE user = ? AND id NOT IN (SELECT id FROM notifiche WHERE user = ? ORDER BY id DESC LIMIT ?)", user, user, KEEP)
    A.live_put(user, {"type": "notifica", "item": {"id": nid, "ts": now, "kind": kind, "title": str(title)[:120],
                                                   "body": str(body or "")[:300], "link": link, "letta": 0}})


@bp.get("/api/notifiche")
def elenco():
    u = g.who.get("user")
    rows = db.all_("SELECT id, ts, kind, title, body, link, letta FROM notifiche WHERE user = ? ORDER BY id DESC LIMIT 60", u)
    n = db.one("SELECT count(*) n FROM notifiche WHERE user = ? AND letta = 0", u)["n"]
    return jsonify(items=[dict(r) for r in rows], unread=n, attivita=vuole(u))


# ------------------------------------------------------------------ attività degli amici (tipo "attivita")
# Tre avvisi: un amico torna in linea dopo un po', comincia ad ascoltare, crea o condivide una playlist pubblica. Chi ha
# spento «Mostra agli altri cosa ascolto» non compare. Arrivano a chi usa Armony su questo server (ha un dispositivo
# fidato) e non li ha spenti. Pochi di proposito: «in linea» solo dopo ASSENZA senza dispositivi collegati e non se
# intanto ascolta già (basta quell'avviso), «sta ascoltando» al più una volta ogni ASCOLTO per amico.
ASSENZA, ASCOLTO, ATTESA = 2 * 3600, 3 * 3600, 90
fuori = {}  # utente -> da quando non ha più dispositivi collegati (solo da quando il server è acceso: niente valanga al riavvio)
gia = {}    # chiave dell'avviso -> istante dell'ultima volta


def vuole(u):
    r = db.one("SELECT value FROM settings WHERE key = ?", "notattivita:" + str(u))
    return not r or r["value"] != "0"


@bp.put("/api/notifiche/attivita")
def attivita_onoff():
    u, on = g.who.get("user"), bool((request.get_json(silent=True) or {}).get("on"))
    if not u:
        return jsonify(error="Serve un utente"), 400
    db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", "notattivita:" + u, "1" if on else "0")
    return jsonify(ok=True, attivita=on)


def agli_amici(u, chiave, ogni, titolo, corpo="", link="#/amici"):
    share, nome = A.pres_who(u)
    now = time.time()
    if not u or not share or now - gia.get(chiave, 0) < ogni:
        return
    gia[chiave] = now
    A.bot.feed(u, {"linea": "linea", "ascolto": "ascolto", "pl": "playlist"}.get(chiave.split(":")[0], ""), titolo.replace("{nome}", nome) + (f"\n{corpo}" if corpo else ""), link)
    for r in db.all_("SELECT DISTINCT user FROM devices WHERE state = 'fidato' AND user != ?", u):
        if vuole(r["user"]):
            notifica(r["user"], "attivita", titolo.replace("{nome}", nome), corpo, link)


def collegato(u, dispositivo):
    """Il primo dispositivo dell'utente si collega al canale dal vivo."""
    t = fuori.pop(u, None)
    if t is None or time.time() - t < ASSENZA:
        return

    def dopo():
        time.sleep(ATTESA)
        if A.live_connesso(u) and not A.live_suona(u):
            agli_amici(u, "linea:" + u, ASSENZA, "👋 {nome} è in linea", f"Su {dispositivo}")
    threading.Thread(target=dopo, daemon=True).start()


def scollegato(u):
    fuori[u] = time.time()


def ascolta(u, t, radio=None):
    cosa = f"la radio «{radio}»" if radio else f"«{t.get('title') or 'un brano'}»" + (f" · {t['artist']}" if t.get("artist") else "")
    agli_amici(u, "ascolto:" + u, ASCOLTO, "📻 {nome} sta ascoltando" if radio else "🎧 {nome} sta ascoltando", cosa[:300])


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


@bp.post("/api/notifiche/gettone")
def gettone():
    dev, u = g.who.get("dev"), g.who.get("user")
    if not dev or not u:
        return jsonify(error="Serve un dispositivo abbinato"), 400
    tok = secrets.token_urlsafe(32)
    db.run("DELETE FROM notif_gettoni WHERE dev = ?", dev)  # uno per dispositivo: quello nuovo prende il posto
    db.run("INSERT INTO notif_gettoni (token, dev, user, created) VALUES (?, ?, ?, ?)", hashlib.sha256(tok.encode()).hexdigest(), dev, u, time.time())
    last = db.one("SELECT max(id) m FROM notifiche WHERE user = ?", u)["m"] or 0
    return jsonify(token=tok, last=last)


@bp.get("/api/notifiche/nuove")
def nuove():
    if A.dispositivi.ip_limit("notif-nuove", 240, 3600):
        return jsonify(error="Troppe richieste"), 429
    tok = request.headers.get("X-Notifiche") or ""
    r = db.one("SELECT n.user, d.state FROM notif_gettoni n JOIN devices d ON d.id = n.dev WHERE n.token = ?",
               hashlib.sha256(tok.encode()).hexdigest()) if tok else None
    if not r or r["state"] != "fidato":
        return jsonify(error="Gettone non valido"), 401
    try:
        dopo = int(request.args.get("dopo") or 0)
    except ValueError:
        dopo = 0
    rows = db.all_("SELECT id, kind, title, body, link FROM notifiche WHERE user = ? AND id > ? AND letta = 0 ORDER BY id LIMIT 20", r["user"], dopo)
    return jsonify(items=[dict(x) for x in rows])


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)
