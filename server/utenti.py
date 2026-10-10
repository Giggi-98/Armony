"""
Armony - utenti e permessi (solo amministratori, salvo perms() che usano tutti).

  GET    /api/users                   tutti gli utenti di Navidrome con i loro permessi e i dispositivi
  POST   /api/users                   crea un utente (nome e permessi, password provvisoria casuale) e un codice di benvenuto:
                                      un QR per l'app, un link per il browser
  PUT    /api/users/<nome>            permessi
  POST   /api/users/<nome>/accesso    codice di benvenuto nuovo (telefono perso, password dimenticata)
  GET    /api/benvenuto/<codice>      pubblica: per chi è il codice e se vale ancora
  POST   /api/benvenuto               pubblica: {code, password}. Al primo ingresso l'amico sceglie la sua password, che
                                      prende il posto di quella provvisoria su Navidrome; riceve un "grant" con cui il
                                      suo primo accesso entra fidato, senza aspettare l'approvazione
  DELETE /api/users/<nome>            elimina l'utente da Navidrome e da Armony (le sue playlist con lui)
  DELETE /api/users/<nome>/sessions   revoca tutti i suoi dispositivi

─── PERCHÉ i permessi valgono sul server e non solo nell'interfaccia ───
Un amico può usare Armony ma anche un'app Subsonic (Symfonium, Tempo…) collegata ad Armony: nascondere un tasto non
basta. Il proxy toglie dalle risposte di getPlaylists le playlist degli altri e rifiuta createPlaylist, updatePlaylist,
createShare… a chi non ha il permesso. L'amministratore (di Navidrome) ha sempre tutto.
"""
import hashlib
import json
import re
import secrets
import time

import requests
from flask import Blueprint, g, jsonify, request

import db
import dispositivi

bp = Blueprint("utenti", __name__)
A = None
# chiave → (etichetta, spiegazione, valore per chi non ha ancora scelte). upload/download/delete hanno colonne loro (perms)
PERMS = {
    "playlist": ("Crea e modifica playlist", "Le sue playlist: creare, aggiungere brani, importare da Spotify, abbonarsi.", True),
    "vedipl": ("Vede le playlist degli altri", "Anche quelle pubbliche degli altri utenti. Spento vede solo le sue.", False),
    "condividi": ("Crea link di condivisione", "Link pubblici di 30 giorni per album, playlist e brani.", True),
    "download": ("Scarica musica", "Da YouTube e dagli altri siti, album completi, importazioni con download, copie dalla rete.", True),
    "upload": ("Carica musica", "Dal telefono o dal computer nella libreria del server.", True),
    "delete": ("Modifica ed elimina brani", "Titoli, copertine, eliminazione dei file: vale per tutti.", False),
    "radio": ("Crea stazioni radio", "Ascoltare le radio degli altri si può sempre.", True),
    "rete": ("Usa le librerie collegate", "Pagina Rete, risultati «Nella rete», abbonamenti.", True),
    "stats": ("Vede le statistiche del server", "Statistiche → Sul server: ascolti di tutti.", True),
}
COLS = {"upload": "upload", "download": "download", "delete": "del"}
PASS_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_H = 24


def perms(user, admin=None):
    """Tutti i permessi di un utente; l'amministratore li ha tutti."""
    if admin is None:
        # nomi senza maiuscole: Navidrome accetta "GG" per "gg", e un'app Subsonic con le maiuscole cambiate tornava
        # ai permessi predefiniti
        r = db.one("SELECT max(admin) a FROM devices WHERE lower(user) = lower(?) AND state != 'revocato'", user)
        admin = bool(r and r["a"])
    if admin or not user:
        return {k: True for k in PERMS}
    p = db.one("SELECT * FROM perms WHERE lower(user) = lower(?)", user)
    more = {}
    if p and p["more"]:
        try:
            more = json.loads(p["more"])
        except ValueError:
            pass
    out = {}
    for k, (_, _, dflt) in PERMS.items():
        if k in COLS:
            out[k] = bool(p[COLS[k]]) if p else dflt
        else:
            out[k] = bool(more.get(k, dflt))
    return out


def save(user, want):
    cur = perms(user, admin=False)
    cur.update({k: bool(v) for k, v in want.items() if k in PERMS})
    db.run("INSERT INTO perms (user, upload, download, del, more) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user) DO UPDATE SET "
           "upload = excluded.upload, download = excluded.download, del = excluded.del, more = excluded.more",
           user, int(cur["upload"]), int(cur["download"]), int(cur["delete"]),
           json.dumps({k: v for k, v in cur.items() if k not in COLS}))
    dispositivi.notify(user)  # i suoi dispositivi rileggono /api/me
    return cur


def nd_users():
    return A.federazione.nd_native("GET", "/api/user") or []


def nd_user(name):
    return next((u for u in nd_users() if u.get("userName", "").lower() == name.lower()), None)


def ingresso(user, by_dev):
    """Codice di benvenuto monouso (24 ore): niente credenziali dentro, chi lo usa sceglie la sua password."""
    code, now = "".join(secrets.choice(dispositivi.CODE_ALPHABET) for _ in range(8)), time.time()
    db.run("UPDATE pairings SET expires = 0 WHERE user = ? AND welcome = 1 AND used_by IS NULL", user)  # vale solo l'ultimo
    db.run("INSERT INTO pairings (hash, user, by_dev, t, s, created, expires, welcome) VALUES (?, ?, ?, '', '', ?, ?, 1)",
           hashlib.sha256(code.encode()).hexdigest(), user, by_dev or "", now, now + CODE_H * 3600)
    dispositivi.event("codice", user, by_dev, "codice di benvenuto creato dall'amministratore")
    pretty = f"{code[:4]}-{code[4:]}"
    return {"code": pretty, "expires": now + CODE_H * 3600, "link": f"{(A.public_url() or request.host_url).rstrip('/')}/#/benvenuto/{pretty}"}


def welcome_row(code):
    c = re.sub(r"[^A-Z0-9]", "", str(code or "").upper())[:16]
    return db.one("SELECT * FROM pairings WHERE hash = ? AND welcome = 1 AND used_by IS NULL AND expires > ?",
                  hashlib.sha256(c.encode()).hexdigest(), time.time())


@bp.get("/api/benvenuto/<code>")
def welcome_info(code):
    ip = A.client_ip()
    wait = dispositivi.wait_for("ip:" + ip)
    if wait:
        return dispositivi.too_many(wait)
    p = welcome_row(code)
    if not p:
        dispositivi.note_fail("ip:" + ip)
        return jsonify(error="Questo link non vale più: è già stato usato o è scaduto. Chiedine uno nuovo a chi gestisce il server."), 404
    return jsonify(user=p["user"], name=A.NAME, expires=p["expires"])


@bp.post("/api/benvenuto")
def welcome_use():
    ip = A.client_ip()
    wait = dispositivi.wait_for("ip:" + ip)
    if wait:
        return dispositivi.too_many(wait)
    d = request.get_json(silent=True) or {}
    p, password = welcome_row(d.get("code")), str(d.get("password") or "")
    if not p:
        dispositivi.note_fail("ip:" + ip)
        return jsonify(error="Questo link non vale più: è già stato usato o è scaduto. Chiedine uno nuovo a chi gestisce il server."), 404
    if len(password) < 8 or len(password) > 200:
        return jsonify(error="La password deve avere almeno 8 caratteri."), 400
    # prenotato prima di cambiare la password: due aperture dello stesso link, ne passa una
    if not db.conn().execute("UPDATE pairings SET used_by = 'benvenuto' WHERE hash = ? AND used_by IS NULL", (p["hash"],)).rowcount:
        return jsonify(error="Questo link è appena stato usato."), 409
    try:
        u = nd_user(p["user"])
        if not u:
            raise ValueError("utente sparito")
        A.federazione.nd_native("PUT", f"/api/user/{u['id']}", json={**u, "password": password})
    except (A.federazione.FedError, requests.RequestException, ValueError) as e:
        db.run("UPDATE pairings SET used_by = NULL WHERE hash = ?", p["hash"])
        return jsonify(error="Il server musicale non ha accettato la password: riprova fra poco. (" + str(e)[:80] + ")"), 502
    dispositivi.clear_fails("ip:" + ip)
    dispositivi.event("benvenuto", p["user"], None, "password scelta al primo ingresso")
    return jsonify(ok=True, user=u["userName"], name=A.NAME, grant=dispositivi.registered(u["userName"]))


def new_password():
    return "".join(secrets.choice(PASS_ALPHABET) for _ in range(12))


def nd_err(e):
    if isinstance(e, A.federazione.FedError):
        return jsonify(error=str(e)), 503
    return jsonify(error="Navidrome ha rifiutato la richiesta: " + str(e)[:150]), 502


@bp.get("/api/users")
def users():
    try:
        nd = nd_users()
    except (A.federazione.FedError, requests.RequestException) as e:
        # senza l'amministratore di Navidrome si vedono solo gli utenti che sono già entrati da Armony
        nd, err = [], str(e)
    else:
        err = None
    now = time.time()
    devs = {r["user"].lower(): r for r in db.all_("SELECT user, count(*) n, max(seen) seen, max(admin) admin FROM devices "
                                                     "WHERE state = 'fidato' GROUP BY lower(user)")}
    names = {u["userName"]: bool(u.get("isAdmin")) for u in nd}
    # anche chi è entrato da Armony ma Navidrome non lo elenca (amministratore di Navidrome non configurato); non i
    # dispositivi revocati: un utente eliminato ricompariva per quelli
    for r in db.all_("SELECT DISTINCT user FROM devices WHERE state != 'revocato' UNION SELECT user FROM perms"):
        if r["user"] and not any(r["user"].lower() == n.lower() for n in names):
            names[r["user"]] = bool((devs.get(r["user"].lower()) or {"admin": 0})["admin"])
    out = []
    for name, admin in sorted(names.items(), key=lambda x: (not x[1], x[0].lower())):
        d = devs.get(name.lower())
        out.append({"user": name, "admin": admin, "devices": d["n"] if d else 0, "seen": d["seen"] if d else None,
                    "perms": perms(name, admin), "me": name.lower() == (g.who.get("user") or "").lower()})
    return jsonify(users=out, perms=[{"k": k, "label": v[0], "hint": v[1]} for k, v in PERMS.items()], error=err, now=now)


@bp.post("/api/users")
def create():
    d = request.get_json(silent=True) or {}
    name, password = str(d.get("username") or "").strip(), new_password()
    if not A.USER_RE.match(name):
        return jsonify(error="Il nome utente va da 3 a 32 caratteri: lettere, cifre, punto, trattino e trattino basso."), 400
    if len(password) < 8:
        return jsonify(error="La password deve avere almeno 8 caratteri."), 400
    try:
        A.nd_create_user(name, password)
    except ValueError as e:
        return jsonify(error=str(e)), 409
    except (PermissionError, requests.RequestException) as e:
        return jsonify(error=(str(e) if isinstance(e, PermissionError) else "Navidrome non risponde") + ". Controlla Utenti → Registrazione."), 502
    p = save(name, d.get("perms") or {})
    dispositivi.event("utente", name, g.who.get("dev"), f"creato da {g.who.get('user') or 'emergenza'}")
    # la password provvisoria non la vede nessuno: al primo ingresso l'amico sceglie la sua (POST /api/benvenuto)
    return jsonify(user=name, perms=p, **ingresso(name, g.who.get("dev"))), 201


@bp.put("/api/users/<name>")
def set_perms(name):
    d = request.get_json(silent=True) or {}
    want = d.get("perms") if isinstance(d.get("perms"), dict) else {k: v for k, v in d.items() if k in PERMS}  # forma vecchia
    return jsonify(perms=save(name[:100], want))


@bp.post("/api/users/<name>/accesso")
def reset_access(name):
    # un link di benvenuto nuovo: la password la cambia lui quando lo apre, fino ad allora vale quella di prima
    try:
        u = nd_user(name)
        if not u:
            return jsonify(error="Utente non trovato su Navidrome"), 404
        if u.get("isAdmin"):
            return jsonify(error="L'accesso di un amministratore si gestisce da Navidrome."), 403
    except (A.federazione.FedError, requests.RequestException) as e:
        return nd_err(e)
    dispositivi.event("utente", name, g.who.get("dev"), "nuovo link di benvenuto dall'amministratore")
    # "telefono perso": i dispositivi di prima smettono subito di funzionare (con la chiave firmerebbero ancora da soli)
    if (request.get_json(silent=True) or {}).get("revoca"):
        revoke(u["userName"], "nuovo link di benvenuto (dispositivi di prima revocati)")
    return jsonify(user=u["userName"], **ingresso(u["userName"], g.who.get("dev")))


@bp.delete("/api/users/<name>")
def delete(name):
    if name.lower() == (g.who.get("user") or "").lower():
        return jsonify(error="Non puoi eliminare il tuo stesso account."), 400
    try:
        u = nd_user(name)
        if u and u.get("isAdmin"):
            return jsonify(error="Un amministratore si elimina da Navidrome."), 403
        if u:
            A.federazione.nd_native("DELETE", f"/api/user/{u['id']}")
    except (A.federazione.FedError, requests.RequestException) as e:
        return nd_err(e)
    revoke(name, "account eliminato")
    for t in ("perms", "history", "prefs", "fed_subs", "imports"):
        db.run(f"DELETE FROM {t} WHERE lower({'owner' if t in ('fed_subs', 'imports') else 'user'}) = lower(?)", name)
    db.run("DELETE FROM pairings WHERE lower(user) = lower(?)", name)
    db.run("DELETE FROM devices WHERE lower(user) = lower(?)", name)  # già revocati e tagliati qui sopra
    dispositivi.event("utente", name, g.who.get("dev"), f"eliminato da {g.who.get('user') or 'emergenza'}")
    return jsonify(ok=True)


def revoke(name, why=None):
    # un dispositivo con chiave rifarebbe la sessione da solo: si revocano i dispositivi, non solo le sessioni
    for d in db.all_("SELECT * FROM devices WHERE lower(user) = lower(?) AND state != 'revocato'", name):
        db.run("UPDATE devices SET state = 'revocato', revoked = ? WHERE id = ?", time.time(), d["id"])
        dispositivi.cut(d)
        dispositivi.event("revocato", name, d["id"], f"{d['name']}, {why or 'tutti i dispositivi'}, da {g.who.get('user') or 'emergenza'}")
    db.run("DELETE FROM sessions WHERE lower(user) = lower(?)", name)
    dispositivi.notify(name)


@bp.delete("/api/users/<name>/sessions")
def revoke_user(name):
    revoke(name)
    return jsonify(ok=True)


# ------------------------------------------------------------------ nel proxy /rest: cosa si può fare e cosa si vede
WRITE = {"createPlaylist": "playlist", "updatePlaylist": "playlist", "deletePlaylist": "playlist",
         "createShare": "condividi", "updateShare": "condividi", "deleteShare": "condividi"}


def subsonic_error(fmt_json, code, msg):
    if fmt_json:
        return json.dumps({"subsonic-response": {"status": "failed", "version": "1.16.1", "error": {"code": code, "message": msg}}}).encode(), "application/json"
    return (f'<?xml version="1.0" encoding="UTF-8"?><subsonic-response xmlns="http://subsonic.org/restapi" status="failed" version="1.16.1">'
            f'<error code="{code}" message="{msg}"/></subsonic-response>').encode(), "text/xml"


def filter_playlists(method, body, is_json, user):
    """Toglie le playlist degli altri (getPlaylists) o nasconde quella chiesta (getPlaylist) a chi non può vederle.
    Restano quelle in cui collabora (amici.py)."""
    me, mie = user.lower(), A.amici.collab_di(user)
    ok = lambda owner, pid: str(owner or "").lower() == me or str(pid or "") in mie
    if is_json:
        try:
            j = json.loads(body)
            sr = j["subsonic-response"]
        except (ValueError, KeyError):
            return body
        if method == "getPlaylists" and isinstance(sr.get("playlists"), dict):
            sr["playlists"]["playlist"] = [p for p in sr["playlists"].get("playlist") or [] if ok(p.get("owner"), p.get("id"))]
        elif method == "getPlaylist" and isinstance(sr.get("playlist"), dict) and not ok(sr["playlist"].get("owner"), sr["playlist"].get("id")):
            return subsonic_error(True, 70, "Playlist non trovata")[0]
        return json.dumps(j).encode()
    text = body.decode("utf-8", "replace")
    if method == "getPlaylists":
        return re.sub(r'<playlist\b[^>]*?\bowner="([^"]*)"[^>]*?(/>|>.*?</playlist>)',
                      lambda m: m.group(0) if ok(m.group(1), (re.search(r'\bid="([^"]*)"', m.group(0)) or [None, None])[1]) else "", text, flags=re.S).encode()
    m = re.search(r'<playlist\b[^>]*?\bowner="([^"]*)"', text)
    pid = re.search(r'<playlist\b[^>]*?\bid="([^"]*)"', text)
    if m and not ok(m.group(1), pid.group(1) if pid else None):
        return subsonic_error(False, 70, "Playlist non trovata")[0]
    return body


def unisci_nomi():
    """Dati divisi per maiuscole ("Gg" e "gg", "Brollo" e "brollo"): tutto sotto il nome vero di Navidrome. Una volta
    all'avvio; per le tabelle con un utente per riga (prefs, perms) vince la riga più recente, o quella col nome vero."""
    import sqlite3
    try:
        nd = sqlite3.connect(f"file:{A.NAVIDROME_DB}?mode=ro", uri=True, timeout=10)
        names = {r[0].lower(): r[0] for r in nd.execute("SELECT user_name FROM user")}
        nd.close()
    except sqlite3.Error:
        return
    c, moved = db.conn(), 0
    plain = [("devices", "user"), ("sessions", "user"), ("events", "user"), ("pairings", "user"), ("log", "user"),
             ("fed_subs", "owner"), ("imports", "owner")]
    for low, real in names.items():
        for t, col in plain:
            moved += c.execute(f"UPDATE {t} SET {col} = ? WHERE lower({col}) = ? AND {col} != ?", (real, low, real)).rowcount
        # storico: lo stesso ascolto (hid) può esserci già sotto il nome vero
        moved += c.execute("UPDATE OR IGNORE history SET user = ? WHERE lower(user) = ? AND user != ?", (real, low, real)).rowcount
        c.execute("DELETE FROM history WHERE lower(user) = ? AND user != ?", (low, real))
        for t, order in (("prefs", "updated"), ("perms", None)):
            rows = c.execute(f"SELECT rowid, user{', ' + order if order else ''} FROM {t} WHERE lower(user) = ?", (low,)).fetchall()
            if len(rows) > 1 or (rows and rows[0][1] != real):
                keep = max(rows, key=lambda r: (r[2] if order else 0, r[1] == real))
                c.execute(f"DELETE FROM {t} WHERE lower(user) = ? AND rowid != ?", (low, keep[0]))
                c.execute(f"UPDATE {t} SET user = ? WHERE rowid = ?", (real, keep[0]))
                moved += 1
    if moved:
        A.diagnosi.log("info", "utenti", f"nomi utente uniti per maiuscole: {moved} righe sotto il nome vero di Navidrome")


def ripara_storico():
    """Ascolti registrati con durata 0 (client 0.19–0.21: la durata non arrivava ai brani): durata dal DB di Navidrome."""
    import sqlite3
    rows = db.all_("SELECT seq, data FROM history WHERE json_extract(data, '$.duration') IN (0, '0') OR json_extract(data, '$.duration') IS NULL")
    if not rows:
        return
    try:
        nd = sqlite3.connect(f"file:{A.NAVIDROME_DB}?mode=ro", uri=True, timeout=10)
        ids = {json.loads(r["data"]).get("id") for r in rows} - {None}
        dur = {}
        for chunk in [list(ids)[i:i + 400] for i in range(0, len(ids), 400)]:
            dur.update({k: v for k, v in nd.execute(f"SELECT id, duration FROM media_file WHERE id IN ({','.join('?' * len(chunk))})", chunk)})
        nd.close()
    except sqlite3.Error:
        return
    n = 0
    for r in rows:
        d = json.loads(r["data"])
        if dur.get(d.get("id")):
            d["duration"] = round(dur[d["id"]])
            db.run("UPDATE history SET data = ? WHERE seq = ?", json.dumps(d), r["seq"])
            n += 1
    if n:
        A.diagnosi.log("info", "utenti", f"{n} ascolti senza durata completati dal database di Navidrome")


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)
