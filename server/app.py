"""
Armony - server di supporto.

  /                     client web (cartella client)
  /rest/*, /share/*     proxy verso Navidrome: tutto su un'unica porta e un'unica origine
  /api/jam/*            segnalazione per la Jam, e nel modo "tramite il server" tutti i suoi messaggi;
                        /api/jam/ora è l'orologio comune. Il server inoltra solo messaggi cifrati
                        dai client con la chiave della stanza: non può leggerli né falsificarli
  /api/lan/*            scoperta di altri server Armony e Jam vicine via multicast UDP
  /api/info            pubblica: nome, versione, livello di API e capacità del server
  /api/login, /api/logout, /api/me   accesso con le credenziali Navidrome (token + sale
                        Subsonic); la sessione va nell'intestazione X-Token
  /api/users            permessi per utente (solo amministratori)
  /api/register         un amico si crea l'account (pubblica: info e registrazione con invito);
                        /api/register/settings e /invites solo amministratori
  /api/tracks/delete    elimina file dalla libreria (permesso "delete"); il percorso vero viene dal DB di
                        Navidrome, letto in sola lettura, mai dal client
  /api/tracks/tags, /api/tracks/cover, /api/cover/search   modifica dei tag e della copertina dei brani
                        (stesso permesso "delete": «Modifica ed eliminazione»); i file non si spostano
  /api/history, /api/prefs   storico d'ascolto e preferenze dell'utente, condivisi fra i suoi dispositivi
  /api/live             riproduzione condivisa fra i dispositivi di un utente: canale SSE, stato, comandi
  /api/download, /api/jobs, /api/search, /api/videos   download con yt-dlp (permesso "download")
  /api/discografia      tutta la discografia di un artista e un suo album, da Deezer (permesso "download")
  /api/import           brani da Spotify (Exportify): metadati completati, ricerca per durata, tag e cartelle per album
  /api/upload           caricamento di file audio dal client nella libreria (permesso "upload")
  /api/update           versione installata contro l'ultimo tag su GitHub; la richiesta di
                        aggiornamento la esegue l'host (deploy/armony-update.sh), non il container
"""
import hashlib
import ipaddress
import sqlite3
import queue
import json
import os
import re
import secrets
import shutil
import socket
import struct
import threading
import time
import urllib.parse
import uuid

import mutagen
import requests
import yt_dlp
from flask import Flask, Response, abort, g, jsonify, request, send_from_directory, stream_with_context
from yt_dlp.postprocessor.metadataparser import MetadataParserPP

import db
import metadati

MUSIC_DIR = os.environ.get("MUSIC_DIR", "/music")
VIDEO_DIR = os.environ.get("VIDEO_DIR", "/videos")
CLIENT_DIR = os.environ.get("CLIENT_DIR", "/app/client")
TOKEN = os.environ.get("ARMONY_TOKEN", "")
NAVIDROME_URL = os.environ.get("NAVIDROME_URL", "http://127.0.0.1:4533").rstrip("/")
PORT = int(os.environ.get("ARMONY_PORT", "8080"))
NAME = os.environ.get("ARMONY_NAME", socket.gethostname())
MULTICAST = os.environ.get("ARMONY_MULTICAST", "1") == "1"
REPO = os.environ.get("ARMONY_REPO", "").strip("/")
UPDATE_DIR = os.environ.get("UPDATE_DIR", "/updates")
try:
    VERSION = open(os.environ.get("VERSION_FILE", "/app/VERSION")).read().strip()
except OSError:
    VERSION = "sviluppo"
MCAST_GRP, MCAST_PORT = "239.255.77.77", 47777
INSTANCE = uuid.uuid4().hex[:12]

AUDIO_FORMATS = {"mp3", "m4a", "opus", "flac"}
AUDIO_QUALITIES = {"best": "0", "320": "320", "256": "256", "192": "192", "128": "128"}
VIDEO_QUALITIES = {"best", "2160", "1080", "720", "480", "360"}
VIDEO_EXT = (".mp4", ".webm", ".mkv", ".mov")
# livello dell'API di Armony: sale solo con modifiche che un client vecchio non regge.
# I client controllano API_LEVEL e CAPS per sapere cosa possono usare su questo server.
API_LEVEL = 1
CAPS = ["login", "upload", "download", "update", "jam", "lan", "history", "prefs", "live", "delete", "scaletta", "register", "edit", "discografia"]
# prefisso → permesso richiesto. "user" = qualsiasi sessione valida
RULES = (("/api/update", "admin"), ("/api/users", "admin"), ("/api/register/settings", "admin"), ("/api/register/invites", "admin"), ("/api/upload", "upload"), ("/api/tracks", "delete"), ("/api/cover", "delete"),
         ("/api/download", "download"), ("/api/import", "download"), ("/api/album/scaletta", "download"), ("/api/discografia", "download"), ("/api/jobs", "download"), ("/api/search", "download"),
         ("/api/videos", "download"), ("/api/health", "user"), ("/api/me", "user"), ("/api/logout", "user"),
         ("/api/history", "user"), ("/api/prefs", "user"), ("/api/live", "user"))
SESSION_DAYS = 180
ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,48}$")

app = Flask(__name__, static_folder=None)
http = requests.Session()


# ------------------------------------------------------------------ base
@app.after_request
def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Token, Range"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    resp.headers["Access-Control-Expose-Headers"] = "Content-Range, Content-Length, Accept-Ranges"
    return resp


def identity(tok=None):
    tok = tok or request.headers.get("X-Token") or request.args.get("token") or ""
    if not tok:
        return None
    # ARMONY_TOKEN resta come accesso di emergenza dell'amministratore
    if TOKEN and secrets.compare_digest(tok, TOKEN):
        return dict(user=None, admin=True, upload=True, download=True, delete=True)
    s = db.one("SELECT s.user, s.admin, s.seen, coalesce(p.upload, 1) upload, coalesce(p.download, 1) download, coalesce(p.del, 0) del "
               "FROM sessions s LEFT JOIN perms p ON p.user = s.user WHERE s.token = ?", tok)
    if not s or time.time() - s["seen"] > SESSION_DAYS * 86400:
        return None
    if time.time() - s["seen"] > 3600:
        db.run("UPDATE sessions SET seen = ? WHERE token = ?", time.time(), tok)
    admin = bool(s["admin"])
    return dict(user=s["user"], admin=admin, upload=admin or bool(s["upload"]), download=admin or bool(s["download"]),
                delete=admin or bool(s["del"]))


@app.before_request
def guard():
    if request.method == "OPTIONS":
        return ("", 204)
    need = next((r for p, r in RULES if request.path.startswith(p)), None)
    if not need:
        return None
    g.who = identity()
    if not g.who:
        return jsonify(error="Accesso richiesto: entra con il tuo utente."), 401
    if need != "user" and not g.who["admin" if need == "admin" else need]:
        return jsonify(error={"admin": "Serve un amministratore.", "upload": "Il caricamento non è abilitato per il tuo utente.",
                              "download": "I download non sono abilitati per il tuo utente.",
                              "delete": "Modifica ed eliminazione non sono abilitate per il tuo utente."}[need]), 403
    return None


# ------------------------------------------------------------------ accesso
failed = {}  # ip -> [istanti dei tentativi falliti]


@app.get("/api/info")
def info():
    return jsonify(name=NAME, version=VERSION, api=API_LEVEL, caps=CAPS, armony=True)


@app.post("/api/login")
def login():
    # il client manda token + sale Subsonic, mai la password: Armony li verifica con Navidrome
    ip = request.remote_addr or ""
    recent = [t for t in failed.get(ip, []) if time.time() - t < 600]
    if len(recent) >= 10:
        return jsonify(error="Troppi tentativi falliti: riprova fra qualche minuto."), 429
    d = request.get_json(silent=True) or {}
    u, t, s = (str(d.get(k) or "")[:100] for k in ("u", "t", "s"))
    if not (u and t and s):
        return jsonify(error="Utente e credenziali obbligatori"), 400
    try:
        r = http.get(f"{NAVIDROME_URL}/rest/getUser", timeout=10,
                     params=dict(u=u, t=t, s=s, v="1.16.1", c="armony", f="json", username=u)).json()["subsonic-response"]
    except (requests.RequestException, ValueError, KeyError):
        return jsonify(error="Il server musicale non risponde"), 502
    if r.get("status") != "ok":
        failed[ip] = recent + [time.time()]
        return jsonify(error="Utente o password errati"), 401
    admin = bool(r.get("user", {}).get("adminRole"))
    tok = secrets.token_urlsafe(32)
    db.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)", tok, u, int(admin), str(d.get("device") or "")[:40], time.time(), time.time())
    g.who = identity(tok)
    return jsonify(session=tok, **me_payload())


def me_payload():
    return dict(user=g.who["user"], admin=g.who["admin"], upload=g.who["upload"], download=g.who["download"], delete=g.who["delete"],
                name=NAME, version=VERSION, api=API_LEVEL, caps=CAPS)


@app.get("/api/me")
def me():
    return jsonify(me_payload())


@app.post("/api/logout")
def logout():
    db.run("DELETE FROM sessions WHERE token = ?", request.headers.get("X-Token") or "")
    return jsonify(ok=True)


@app.get("/api/users")
def users():
    rows = db.all_("SELECT u.user, max(s.admin) admin, max(s.seen) seen, count(s.token) sessions, "
                   "coalesce(p.upload, 1) upload, coalesce(p.download, 1) download, coalesce(p.del, 0) del "
                   "FROM (SELECT user FROM sessions UNION SELECT user FROM perms) u "
                   "LEFT JOIN sessions s ON s.user = u.user LEFT JOIN perms p ON p.user = u.user "
                   "GROUP BY u.user ORDER BY u.user")
    return jsonify([{**{k: r[k] for k in ("user", "seen", "sessions")}, "admin": bool(r["admin"]), "upload": bool(r["upload"]),
                     "download": bool(r["download"]), "delete": bool(r["del"])} for r in rows])


@app.put("/api/users/<name>")
def set_user(name):
    d = request.get_json(silent=True) or {}
    db.run("INSERT INTO perms (user, upload, download, del) VALUES (?, ?, ?, ?) "
           "ON CONFLICT(user) DO UPDATE SET upload = excluded.upload, download = excluded.download, del = excluded.del",
           name[:100], int(bool(d.get("upload", True))), int(bool(d.get("download", True))), int(bool(d.get("delete", False))))
    return jsonify(ok=True)


@app.delete("/api/users/<name>/sessions")
def revoke_user(name):
    db.run("DELETE FROM sessions WHERE user = ?", name)
    return jsonify(ok=True)


# ------------------------------------------------------------------ registrazione degli amici
# Gli account sono utenti di Navidrome, quindi per crearli serve il suo amministratore: le sue credenziali
# le inserisce una volta l'admin di Armony e restano solo qui (file 600 in /data, mai mandate al client),
# oppure arrivano da NAVIDROME_ADMIN_USER/NAVIDROME_ADMIN_PASS, che hanno la precedenza.
# Gli account creati sono sempre utenti normali: l'amministratore di un server è uno solo.
ND_ADMIN_FILE = os.path.join(os.path.dirname(db.PATH), "navidrome-admin.json")
REG_MODES = ("chiusa", "invito", "aperta")
INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # niente 0/O, 1/I/L: si detta e si copia a mano
INVITE_DAYS = 7
USER_RE = re.compile(r"^[A-Za-z0-9._-]{3,32}$")
nd_jwt = {"token": None, "at": 0}
reg_failed, reg_done = {}, {}  # ip -> istanti: tentativi falliti e account creati


def nd_admin():
    if os.environ.get("NAVIDROME_ADMIN_USER") and os.environ.get("NAVIDROME_ADMIN_PASS"):
        return {"user": os.environ["NAVIDROME_ADMIN_USER"], "pass": os.environ["NAVIDROME_ADMIN_PASS"], "source": "env"}
    c = read_json(ND_ADMIN_FILE)
    return dict(c, source="file") if c and c.get("user") and c.get("pass") else None


def nd_login(user, password):
    """JWT dell'API nativa di Navidrome, e se l'utente è amministratore."""
    r = http.post(f"{NAVIDROME_URL}/auth/login", json={"username": user, "password": password}, timeout=10)
    if r.status_code == 401:
        return None, False
    r.raise_for_status()
    d = r.json()
    return d.get("token"), bool(d.get("isAdmin"))


def nd_create_user(username, password):
    """Crea un utente normale su Navidrome. Il JWT dell'amministratore si rinnova se scaduto."""
    adm = nd_admin()
    if not adm:
        raise PermissionError("Registrazione non configurata")
    for attempt in (0, 1):
        if not nd_jwt["token"] or attempt:
            nd_jwt["token"], is_admin = nd_login(adm["user"], adm["pass"])
            if not nd_jwt["token"] or not is_admin:
                raise PermissionError("Le credenziali dell'amministratore di Navidrome non valgono più")
        r = http.post(f"{NAVIDROME_URL}/api/user", timeout=10, headers={"X-ND-Authorization": f"Bearer {nd_jwt['token']}"},
                      json={"userName": username, "name": username, "password": password, "isAdmin": False})
        if r.status_code == 401 and not attempt:
            continue
        if r.status_code == 400 and "unique" in r.text:
            raise ValueError("Questo nome utente esiste già: scegline un altro, oppure accedi.")
        r.raise_for_status()
        return
    raise PermissionError("Navidrome rifiuta le credenziali dell'amministratore")


def reg_mode():
    if not nd_admin():
        return "chiusa"
    r = db.one("SELECT value FROM settings WHERE key = 'register_mode'")
    return r["value"] if r and r["value"] in REG_MODES else "invito"


def norm_code(c):
    return re.sub(r"[^A-Z0-9]", "", str(c or "").upper())[:16]


@app.get("/api/register/info")
def register_info():
    m = reg_mode()
    return jsonify(mode=m, open=m != "chiusa", needsCode=m == "invito", name=NAME)


@app.post("/api/register")
def register():
    ip, now = request.remote_addr or "", time.time()
    recent = [t for t in reg_failed.get(ip, []) if now - t < 600]
    if len(recent) >= 10:
        return jsonify(error="Troppi tentativi: riprova fra qualche minuto."), 429
    made = [t for t in reg_done.get(ip, []) if now - t < 3600]
    if len(made) >= 20:  # gli amici sulla stessa Wi-Fi escono con lo stesso indirizzo
        return jsonify(error="Troppi account creati da qui: riprova più tardi."), 429

    def fail(msg, code=400):
        reg_failed[ip] = recent + [now]
        return jsonify(error=msg), code

    mode = reg_mode()
    if mode == "chiusa":
        return jsonify(error="La registrazione su questo server è chiusa: chiedi un account a chi lo gestisce."), 403
    d = request.get_json(silent=True) or {}
    username, password = str(d.get("username") or "").strip(), str(d.get("password") or "")
    if not USER_RE.match(username):
        return fail("Il nome utente va da 3 a 32 caratteri: lettere, cifre, punto, trattino e trattino basso.")
    if len(password) < 8 or len(password) > 200:
        return fail("La password deve avere almeno 8 caratteri.")
    code = norm_code(d.get("code"))
    if mode == "invito":
        if not code:
            return fail("Serve un codice d'invito: chiedilo a chi gestisce il server.")
        # l'invito si prenota prima di creare l'utente: due amici con lo stesso codice, ne passa uno solo
        took = db.conn().execute("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL "
                                 "AND revoked = 0 AND expires > ?", (username, now, code, now)).rowcount
        if not took:
            inv = db.one("SELECT used_by, revoked, expires FROM invites WHERE code = ?", code)
            why = ("Questo invito è già stato usato." if inv and inv["used_by"] else "Questo invito è stato revocato." if inv and inv["revoked"]
                   else "Questo invito è scaduto: chiedine uno nuovo." if inv else "Codice d'invito non valido.")
            return fail(why, 403)
    try:
        nd_create_user(username, password)
    except ValueError as e:
        if mode == "invito":
            db.run("UPDATE invites SET used_by = NULL, used_at = NULL WHERE code = ?", code)
        return fail(str(e), 409)
    except (PermissionError, requests.RequestException) as e:
        if mode == "invito":
            db.run("UPDATE invites SET used_by = NULL, used_at = NULL WHERE code = ?", code)
        msg = str(e) if isinstance(e, PermissionError) else "Il server musicale non risponde"
        return jsonify(error=msg + ": avvisa chi gestisce il server."), 502
    reg_done[ip] = made + [now]
    return jsonify(ok=True, username=username), 201


@app.get("/api/register/settings")
def register_settings():
    adm = nd_admin()
    stored = db.one("SELECT value FROM settings WHERE key = 'register_mode'")
    return jsonify(mode=reg_mode(), chosen=stored["value"] if stored else "invito", configured=bool(adm),
                   source=adm["source"] if adm else None, adminUser=adm["user"] if adm else None)


@app.put("/api/register/settings")
def register_settings_put():
    d = request.get_json(silent=True) or {}
    if d.get("user") or d.get("password"):
        if nd_admin() and nd_admin()["source"] == "env":
            return jsonify(error="Le credenziali arrivano dalle variabili d'ambiente del server: cambiale lì."), 409
        user, password = str(d.get("user") or "").strip(), str(d.get("password") or "")
        try:
            tok, is_admin = nd_login(user, password)
        except (requests.RequestException, ValueError):
            return jsonify(error="Il server musicale non risponde"), 502
        if not tok:
            return jsonify(error="Utente o password di Navidrome errati."), 400
        if not is_admin:
            return jsonify(error="Questo utente non è amministratore di Navidrome."), 400
        fd = os.open(ND_ADMIN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({"user": user, "pass": password}, f)
        os.chmod(ND_ADMIN_FILE, 0o600)
        nd_jwt.update(token=tok, at=time.time())
    if d.get("clear") and os.path.exists(ND_ADMIN_FILE):
        os.remove(ND_ADMIN_FILE)
        nd_jwt.update(token=None)
    if d.get("mode") in REG_MODES:
        db.run("INSERT INTO settings VALUES ('register_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", d["mode"])
    return register_settings()


@app.get("/api/register/invites")
def invites_list():
    now = time.time()
    rows = db.all_("SELECT * FROM invites ORDER BY created DESC LIMIT 50")
    out = []
    for r in rows:
        state = ("usato" if r["used_by"] else "revocato" if r["revoked"] else "scaduto" if r["expires"] <= now else "attivo")
        out.append(dict(code=r["code"], created=r["created"], expires=r["expires"], usedBy=r["used_by"], usedAt=r["used_at"], state=state))
    return jsonify(out)


@app.post("/api/register/invites")
def invites_create():
    code = "".join(secrets.choice(INVITE_ALPHABET) for _ in range(8))
    now = time.time()
    db.run("INSERT INTO invites (code, created, expires, by) VALUES (?, ?, ?, ?)", code, now, now + INVITE_DAYS * 86400, g.who["user"])
    return jsonify(code=code, expires=now + INVITE_DAYS * 86400, state="attivo"), 201


@app.delete("/api/register/invites/<code>")
def invites_revoke(code):
    db.run("UPDATE invites SET revoked = 1 WHERE code = ? AND used_by IS NULL", norm_code(code))
    return jsonify(ok=True)


def clean_segment(s, fallback):
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", (s or "").strip()).strip(". ")
    return s[:80] or fallback


# ------------------------------------------------------------------ proxy Navidrome
PASS_REQ = ("range", "if-range", "if-none-match", "if-modified-since", "user-agent", "accept", "content-type")
PASS_RESP = ("content-type", "content-length", "content-range", "accept-ranges", "cache-control",
             "etag", "last-modified", "content-disposition", "x-content-duration")


@app.route("/rest/<path:p>", methods=["GET", "POST"])
@app.route("/share/<path:p>", methods=["GET"])
def proxy(p):
    prefix = request.path.split("/")[1]
    headers = {k: v for k, v in request.headers.items() if k.lower() in PASS_REQ}
    headers["Accept-Encoding"] = "identity"
    headers["X-Forwarded-For"] = request.remote_addr or ""
    headers["X-Forwarded-Host"] = request.host
    headers["X-Forwarded-Proto"] = request.scheme
    try:
        r = http.request(request.method, f"{NAVIDROME_URL}/{prefix}/{p}", params=request.args,
                         data=request.get_data() if request.method == "POST" else None,
                         headers=headers, stream=True, timeout=(5, 600))
    except requests.RequestException:
        return jsonify(error="Il server musicale non risponde"), 502
    out = {k: v for k, v in r.headers.items() if k.lower() in PASS_RESP}
    return Response(stream_with_context(r.iter_content(64 * 1024)), status=r.status_code,
                    headers=out, direct_passthrough=True)


# ------------------------------------------------------------------ Jam: segnalazione
rooms = {}
cond = threading.Condition()


def same_net(a, b):
    try:
        x, y = ipaddress.ip_address(a), ipaddress.ip_address(b)
    except ValueError:
        return False
    if x == y:
        return True
    if x.version != y.version:
        return False
    if (x.is_private or x.is_loopback) and (y.is_private or y.is_loopback):
        bits = 24 if x.version == 4 else 64
        return ipaddress.ip_network(f"{x}/{bits}", strict=False) == ipaddress.ip_network(f"{y}/{bits}", strict=False)
    return False


def room_or_404(rid):
    if not ID_RE.match(rid):
        abort(400)
    r = rooms.get(rid)
    if not r:
        abort(410)
    return r


@app.post("/api/jam/<rid>/open")
def jam_open(rid):
    if not ID_RE.match(rid):
        abort(400)
    d = request.get_json(silent=True) or {}
    host = d.get("host", "")
    if not ID_RE.match(host):
        abort(400)
    with cond:
        if rid in rooms and rooms[rid]["host"] != host:
            abort(409)
        rooms[rid] = dict(id=rid, host=host, name=str(d.get("name", "Jam"))[:60],
                          hostName=str(d.get("hostName", ""))[:40], visible=bool(d.get("visible")),
                          ip=request.remote_addr, created=time.time(), seen=time.time(),
                          queues=rooms.get(rid, {}).get("queues", {}))
    return jsonify(ok=True)


@app.post("/api/jam/<rid>/close")
def jam_close(rid):
    d = request.get_json(silent=True) or {}
    with cond:
        r = rooms.get(rid)
        if r and r["host"] == d.get("host"):
            del rooms[rid]
        cond.notify_all()
    return jsonify(ok=True)


@app.post("/api/jam/<rid>/send")
def jam_send(rid):
    d = request.get_json(silent=True) or {}
    frm, to, data = d.get("from", ""), d.get("to", ""), d.get("data")
    if not ID_RE.match(frm) or not isinstance(data, str) or len(data) > 200_000:
        abort(400)
    with cond:
        r = room_or_404(rid)
        to = r["host"] if to == "host" else to
        if not ID_RE.match(to):
            abort(400)
        q = r["queues"].setdefault(to, [])
        if len(q) < 400:
            q.append({"from": frm, "data": data})
        cond.notify_all()
    return jsonify(ok=True)


@app.get("/api/jam/<rid>/recv")
def jam_recv(rid):
    peer = request.args.get("peer", "")
    if not ID_RE.match(peer):
        abort(400)
    timeout = min(float(request.args.get("timeout", 25)), 25)
    end = time.time() + timeout
    with cond:
        while True:
            r = room_or_404(rid)
            if peer == r["host"]:
                r["seen"] = time.time()
            q = r["queues"].get(peer)
            if q:
                r["queues"][peer] = []
                return jsonify(messages=q)
            left = end - time.time()
            if left <= 0:
                return jsonify(messages=[])
            cond.wait(left)


@app.get("/api/jam/ora")
def jam_ora():
    # orologio comune per la Jam "tramite il server": ogni partecipante stima lo scarto col server (stile NTP)
    resp = jsonify(t=time.time() * 1000)
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/api/jam/nearby")
def jam_nearby():
    me = request.remote_addr
    with cond:
        local = [dict(id=r["id"], name=r["name"], hostName=r["hostName"], base="")
                 for r in rooms.values() if r["visible"] and same_net(me, r["ip"])]
    remote = []
    for s in lan_peers.values():
        if time.time() - s["seen"] < 20:
            remote += [dict(r, base=s["url"], server=s["name"]) for r in s.get("rooms", [])]
    return jsonify(local + remote)


def gc_rooms():
    while True:
        time.sleep(30)
        with cond:
            for rid in [k for k, r in rooms.items() if time.time() - r["seen"] > 90]:
                del rooms[rid]
            cond.notify_all()


# ------------------------------------------------------------------ multicast LAN
lan_peers = {}


def mcast_sender():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
    while True:
        with cond:
            vis = [dict(id=r["id"], name=r["name"], hostName=r["hostName"]) for r in rooms.values() if r["visible"]]
        msg = json.dumps(dict(armony=1, id=INSTANCE, name=NAME, port=PORT, rooms=vis[:20])).encode()
        try:
            sock.sendto(msg, (MCAST_GRP, MCAST_PORT))
        except OSError:
            pass
        time.sleep(5)


def mcast_listener():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("", MCAST_PORT))
    mreq = struct.pack("4sl", socket.inet_aton(MCAST_GRP), socket.INADDR_ANY)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
    while True:
        try:
            data, addr = sock.recvfrom(16384)
            m = json.loads(data)
            if m.get("armony") == 1 and m.get("id") != INSTANCE:
                lan_peers[m["id"]] = dict(name=str(m.get("name"))[:60], url=f"http://{addr[0]}:{int(m.get('port', 8080))}",
                                          rooms=m.get("rooms", [])[:20], seen=time.time())
        except (OSError, ValueError, KeyError):
            continue


@app.get("/api/lan/servers")
def lan_servers():
    return jsonify({"self": dict(name=NAME, multicast=MULTICAST),
                    "peers": [dict(name=s["name"], url=s["url"]) for s in lan_peers.values() if time.time() - s["seen"] < 20]})


# ------------------------------------------------------------------ storico e preferenze per utente
HIST_FIELDS = ("id", "title", "artist", "artistId", "album", "albumId", "coverArt", "duration", "genre")


def user_or_400():
    # l'accesso di emergenza (ARMONY_TOKEN) non è un utente: non ha storico né preferenze
    if not g.who["user"]:
        abort(app.make_response((jsonify(error="Serve l'accesso di un utente, non il codice di emergenza"), 400)))
    return g.who["user"]


@app.post("/api/history")
def history_add():
    # idempotente: lo stesso ascolto (hid = dispositivo:istante) mandato due volte resta uno
    u, items = user_or_400(), request.get_json(silent=True) or []
    if not isinstance(items, list) or len(items) > 1000:
        return jsonify(error="Al massimo 1000 ascolti per richiesta"), 400
    rows = []
    for x in items:
        if not isinstance(x, dict) or not isinstance(x.get("hid"), str) or not isinstance(x.get("ts"), (int, float)):
            continue
        data = {k: x[k] for k in HIST_FIELDS if isinstance(x.get(k), (str, int, float))}
        rows.append((u, x["hid"][:80], float(x["ts"]), json.dumps(data)[:4000]))
    db.conn().executemany("INSERT OR IGNORE INTO history (user, hid, ts, data) VALUES (?, ?, ?, ?)", rows)
    return jsonify(ok=True, received=len(rows))


@app.get("/api/history")
def history_list():
    # a pagine per numero progressivo: il client chiede solo ciò che non ha ancora visto
    u, since = user_or_400(), int(request.args.get("since", 0) or 0)
    rows = db.all_("SELECT seq, hid, ts, data FROM history WHERE user = ? AND seq > ? ORDER BY seq LIMIT 2000", u, since)
    items = [dict(json.loads(r["data"]), hid=r["hid"], ts=r["ts"]) for r in rows]
    return jsonify(items=items, next=rows[-1]["seq"] if rows else since, more=len(rows) == 2000)


@app.delete("/api/history")
def history_clear():
    db.run("DELETE FROM history WHERE user = ?", user_or_400())
    return jsonify(ok=True)


@app.get("/api/prefs")
def prefs_get():
    r = db.one("SELECT data, updated FROM prefs WHERE user = ?", user_or_400())
    return jsonify(data=json.loads(r["data"]) if r else None, updated=r["updated"] if r else 0)


@app.put("/api/prefs")
def prefs_put():
    # vince la modifica più recente: il client manda l'istante in cui ha cambiato le preferenze
    u, d = user_or_400(), request.get_json(silent=True) or {}
    if not isinstance(d.get("data"), dict) or not isinstance(d.get("updated"), (int, float)):
        return jsonify(error="Preferenze non valide"), 400
    data = json.dumps(d["data"])
    if len(data) > 20000:
        return jsonify(error="Preferenze troppo grandi"), 400
    db.run("INSERT INTO prefs VALUES (?, ?, ?) ON CONFLICT(user) DO UPDATE SET data = excluded.data, "
           "updated = excluded.updated WHERE excluded.updated > prefs.updated", u, data, float(d["updated"]))
    return prefs_get()


# ------------------------------------------------------------------ dal vivo: un solo dispositivo suona, gli altri sono telecomandi
# Ogni dispositivo di un utente tiene aperto un canale SSE. Lo stato (brano, play/pausa, posizione)
# va a tutti gli altri suoi dispositivi; un comando va solo al dispositivo indicato.
# Tutto in memoria: dopo un riavvio i dispositivi si ricollegano da soli (EventSource) e ripubblicano.
lconns = {}    # utente -> {id connessione: {"device", "name", "q"}}
lstates = {}   # utente -> {dispositivo: ultimo stato}
llock = threading.Lock()
LIVE_FIELDS = ("playing", "position", "duration", "rate", "track", "solo", "shuffle", "repeat")


def live_put(user, msg, only=None, skip=None):
    data = json.dumps(msg)
    with llock:
        for c in lconns.get(user, {}).values():
            if (only and c["device"] != only) or (skip and c["device"] == skip):
                continue
            try:
                c["q"].put_nowait(data)
            except queue.Full:
                pass  # un dispositivo che non legge non deve bloccare gli altri


@app.get("/api/live")
def live_stream():
    u = user_or_400()
    dev = (request.args.get("device") or "")[:40]
    if not ID_RE.match(dev):
        return jsonify(error="Dispositivo non valido"), 400
    name = (request.args.get("name") or "Dispositivo")[:40]
    cid, q = uuid.uuid4().hex, queue.Queue(maxsize=200)
    with llock:
        new = not any(c["device"] == dev for c in lconns.get(u, {}).values())
        lconns.setdefault(u, {})[cid] = {"device": dev, "name": name, "q": q}
        others = {c["device"]: c["name"] for c in lconns[u].values() if c["device"] != dev}
        hello = json.dumps({"type": "hello", "devices": [{"device": d, "name": n} for d, n in others.items()],
                            "states": [s for d, s in lstates.get(u, {}).items() if d != dev]})
    if new:
        live_put(u, {"type": "join", "device": dev, "name": name}, skip=dev)

    def gen():
        try:
            yield f"retry: 3000\ndata: {hello}\n\n"
            while True:
                try:
                    yield f"data: {q.get(timeout=15)}\n\n"
                except queue.Empty:
                    yield ": ancora qui\n\n"  # tiene viva la connessione attraverso proxy e NAT
        finally:
            with llock:
                lconns.get(u, {}).pop(cid, None)
                gone = not any(c["device"] == dev for c in lconns.get(u, {}).values())
                if gone:
                    lstates.get(u, {}).pop(dev, None)
            if gone:
                live_put(u, {"type": "gone", "device": dev})

    return Response(stream_with_context(gen()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/live/state")
def live_state():
    u, d = user_or_400(), request.get_json(silent=True) or {}
    dev = str(d.get("device") or "")
    if not ID_RE.match(dev):
        return jsonify(error="Dispositivo non valido"), 400
    st = {k: d[k] for k in LIVE_FIELDS if k in d}
    st.update(device=dev, name=str(d.get("name") or "Dispositivo")[:40], at=time.time())
    if len(json.dumps(st)) > 8000:
        return jsonify(error="Stato troppo grande"), 400
    with llock:
        lstates.setdefault(u, {})[dev] = st
    live_put(u, {"type": "state", "state": st}, skip=dev)
    return jsonify(ok=True)


@app.post("/api/live/cmd")
def live_cmd():
    u, d = user_or_400(), request.get_json(silent=True) or {}
    to, cmd = str(d.get("to") or ""), str(d.get("cmd") or "")
    # transfer: "suona questa coda da qui"; handoff: "passa la tua coda a quel dispositivo"
    if cmd not in ("play", "pause", "toggle", "next", "prev", "seek", "shuffle", "repeat", "transfer", "handoff"):
        return jsonify(error="Comando non valido"), 400
    with llock:
        present = any(c["device"] == to for c in lconns.get(u, {}).values())
    if not present:
        return jsonify(error="Quel dispositivo non è più collegato."), 404
    value = d.get("value")
    if not isinstance(value, (int, float, dict)) or len(json.dumps(value)) > 300_000:
        value = None
    live_put(u, {"type": "cmd", "cmd": cmd, "value": value, "from": str(d.get("from") or "")[:40]}, only=to)
    return jsonify(ok=True)


# ------------------------------------------------------------------ download
jobs = {}
jlock = threading.Lock()
# una coda e due esecutori fissi: con un'importazione da migliaia di brani un thread per lavoro non regge
jq = queue.Queue()
COOKIES = os.path.join(os.path.dirname(db.PATH), "youtube-cookies.txt")


JOB_KEYS = ("url", "mode", "format", "quality", "playlist", "folder", "sponsorblock", "meta", "track")
DONE = ("completato", "completato con errori", "errore")


def jsave(jid):
    # su disco solo i cambi di stato, non ogni percentuale di avanzamento
    db.run("INSERT OR REPLACE INTO jobs VALUES (?, ?, ?)", jid, json.dumps(jobs[jid]), jobs[jid]["created"])


def jupdate(jid, **kw):
    with jlock:
        jobs[jid].update(kw, updated=time.time())
        if kw.keys() & {"status", "title", "error"}:
            jsave(jid)


def resume_jobs():
    # dopo un riavvio (anche un aggiornamento dal tasto) i download a metà ripartono:
    # yt-dlp riprende i file .part già scritti
    for r in db.all_("SELECT data FROM jobs ORDER BY created DESC LIMIT 200"):
        j = json.loads(r["data"])
        jobs[j["id"]] = j
        if j["status"] not in DONE:
            j.update(status="in coda", progress=0)
            jq.put((j["id"], {k: j.get(k) for k in JOB_KEYS}))


def worker():
    while True:
        jid, j = jq.get()
        try:
            (run_brano if j.get("track") else run_job)(jid, j)
        except Exception as e:  # noqa: BLE001 — un lavoro rotto non deve fermare la coda
            jupdate(jid, status="errore", error=str(e)[:400], finished=time.time())


def lit(s):
    return str(s).replace("%", "%%")


def run_job(jid, j):
    jupdate(jid, status="in corso")

    def progress(d):
        info = d.get("info_dict") or {}
        title = info.get("title") or jobs[jid].get("title")
        if d["status"] == "downloading":
            tot = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            jupdate(jid, title=title, progress=round(d.get("downloaded_bytes", 0) * 100 / tot, 1) if tot else None,
                    item=info.get("playlist_index"), items=info.get("n_entries"))
        elif d["status"] == "finished":
            jupdate(jid, title=title, progress=100, status="conversione")

    meta = j.get("meta") or {}
    audio = j["mode"] == "audio"
    folder = clean_segment(j.get("folder"), "Scaricati") if audio else ""
    base = os.path.join(MUSIC_DIR, folder) if audio else VIDEO_DIR
    name_tpl = "%(artist)s - %(title)s.%(ext)s" if meta.get("artist") else "%(title)s.%(ext)s"
    dir_tpl = "%(artist)s" if meta.get("artist") else "%(uploader,channel|Sconosciuto)s"

    # FFmpegMetadata, senza un genere vero, scrive come genere le categorie o i tag del video
    # ("People & Blogs", "Gaming"…). meta_genre vince su tutto: genere vero se c'è, altrimenti vuoto.
    # Regex e non modello: un modello vuole almeno un carattere e con genere vuoto non scatterebbe
    pre = [{"key": "MetadataParser", "when": "pre_process",
            "actions": [(MetadataParserPP.Actions.INTERPRET, "%(genre,genres|)l", "(?P<meta_genre>.*)")]}]
    if meta:
        actions = [(MetadataParserPP.Actions.INTERPRET, lit(v), f"%({k})s")
                   for k, v in meta.items() if k in ("artist", "title", "album") and v]
        if actions:
            pre.append({"key": "MetadataParser", "actions": actions, "when": "pre_process"})
    sponsor = []
    if j.get("sponsorblock"):
        sponsor = [{"key": "SponsorBlock", "categories": ["music_offtopic", "intro", "outro", "selfpromo", "sponsor"], "when": "after_filter"},
                   {"key": "ModifyChapters", "remove_sponsor_segments": ["music_offtopic", "intro", "outro", "selfpromo", "sponsor"]}]

    opts = {
        "cookiefile": COOKIES if os.path.exists(COOKIES) else None,
        "outtmpl": os.path.join(base, dir_tpl, name_tpl),
        "noplaylist": not j["playlist"], "ignoreerrors": j["playlist"],
        "windowsfilenames": True, "quiet": True, "no_warnings": True, "retries": 5,
        "progress_hooks": [progress], "writethumbnail": True,
    }
    if audio:
        opts["format"] = "bestaudio/best"
        opts["postprocessors"] = pre + sponsor + [
            {"key": "FFmpegExtractAudio", "preferredcodec": j["format"], "preferredquality": AUDIO_QUALITIES[j["quality"]]},
            {"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"},
            {"key": "FFmpegMetadata", "add_metadata": True},
            {"key": "EmbedThumbnail"}]
    else:
        h = "" if j["quality"] == "best" else f"[height<={j['quality']}]"
        opts["format"] = f"bestvideo{h}+bestaudio/best{h}"
        opts["merge_output_format"] = "mp4"
        opts["postprocessors"] = pre + sponsor + [
            {"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"},
            {"key": "FFmpegMetadata", "add_metadata": True}, {"key": "EmbedThumbnail"}]
    try:
        with yt_dlp.YoutubeDL(opts) as y:
            code = y.download([j["url"]])
        jupdate(jid, status="completato" if code == 0 else "completato con errori", progress=100, finished=time.time())
    except Exception as e:  # noqa: BLE001
        jupdate(jid, status="errore", error=str(e)[:400], finished=time.time())


# brani importati: da evitare se il titolo originale non li nomina
BRANO_NO = re.compile(r"\b(live|cover|karaoke|instrumental|8d|slowed|sped up|nightcore|reverb|remix|acoustic)\b", re.I)


def run_brano(jid, j):
    """Un brano da Spotify: metadati dal CSV completati da Deezer, ricerca con la durata come filtro
    (prima YouTube, poi SoundCloud), tag scritti con mutagen, file nella cartella dell'album."""
    jupdate(jid, status="metadati")
    m = j["track"]
    try:
        m = metadati.arricchisci(m)
    except Exception:  # noqa: BLE001 — senza Deezer bastano i dati del CSV
        pass
    artists, title, dur = m.get("artists") or [], m.get("title") or "", m.get("duration")
    tmp = os.path.join("/tmp/armony-dl", jid)
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    want_no = {w.lower() for w in BRANO_NO.findall(title)}
    nt, na = metadati.norm(title), metadati.norm(" ".join(artists[:1]))

    # ─── PERCHÉ NON BASTA filtrare per durata ───
    # Un filtro rigido scartava brani buoni (video con qualche secondo di silenzio, edizioni diverse) e
    # il download falliva. Qui la durata è una preferenza: si guardano i primi risultati senza scaricarli,
    # si dà un punteggio e si prende il migliore, anche se la durata non coincide.
    def punteggio(e):
        t, ch, d = metadati.norm(e.get("title")), (e.get("channel") or e.get("uploader") or ""), e.get("duration")
        sc = (3 if nt and nt in t else 0) + (1.5 if na and (na in t or na in metadati.norm(ch)) else 0)
        if ch.endswith(" - Topic"):  # YouTube Music: audio ufficiale, durata esatta, niente intro
            sc += 3
        if "official audio" in (e.get("title") or "").lower():
            sc += 1.5
        if {w.lower() for w in BRANO_NO.findall(e.get("title") or "")} - want_no:
            sc -= 4  # live, cover, remix… che il titolo originale non nomina
        if dur and d:
            dd = abs(d - dur)
            sc += 2 if dd <= 3 else -min(dd, 180) / 15
        return sc

    def progress(d):
        if d["status"] == "downloading":
            tot = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            jupdate(jid, progress=round(d.get("downloaded_bytes", 0) * 100 / tot, 1) if tot else None)
        elif d["status"] == "finished":
            jupdate(jid, progress=100, status="conversione")

    q = f"{(artists or [''])[0]} - {title}"
    fmt = j.get("format") or "m4a"
    got, last_err = None, ""
    cookies = COOKIES if os.path.exists(COOKIES) else None
    for src in (f"ytsearch8:{q}", f"scsearch8:{q}"):
        try:
            with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "extract_flat": "in_playlist", "cookiefile": cookies}) as y:
                found = [e for e in (y.extract_info(src, download=False) or {}).get("entries") or [] if e and e.get("url")]
        except Exception as e:  # noqa: BLE001
            last_err, found = str(e)[:300], []
        if not found:
            continue
        found.sort(key=punteggio, reverse=True)
        opts = {"outtmpl": os.path.join(tmp, "%(id)s.%(ext)s"), "quiet": True, "no_warnings": True, "retries": 3,
                "ignoreerrors": False, "progress_hooks": [progress], "cookiefile": cookies,
                # M4A e Opus arrivano già così da YouTube: si estrae senza ricodificare
                "format": f"bestaudio[ext={'webm' if fmt == 'opus' else fmt}]/bestaudio/best",
                "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": fmt, "preferredquality": AUDIO_QUALITIES.get(j.get("quality") or "best", "0")}]}
        if not m.get("cover"):  # senza copertina vera si tiene almeno quella del video
            opts["writethumbnail"] = True
            opts["postprocessors"] += [{"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"}, {"key": "EmbedThumbnail"}]
        # il migliore; se il download fallisce (video bloccato, rimosso) si prova il successivo
        for e in found[:3]:
            jupdate(jid, status="in corso", source="YouTube" if src.startswith("yt") else "SoundCloud",
                    scelto=f"{e.get('title')} ({e.get('channel') or e.get('uploader') or '?'}, {round(e['duration']) if e.get('duration') else '?'} s)")
            try:
                with yt_dlp.YoutubeDL(opts) as y:
                    y.download([e["url"]])
            except Exception as ex:  # noqa: BLE001
                last_err = str(ex)[:300]
            files = [f for f in os.listdir(tmp) if f.rsplit(".", 1)[-1].lower() in UPLOAD_AUDIO]
            if files:
                got = os.path.join(tmp, files[0])
                break
        if got:
            break
    if not got:
        shutil.rmtree(tmp, ignore_errors=True)
        return jupdate(jid, status="errore", finished=time.time(),
                       error="Non trovato né su YouTube né su SoundCloud" + (f" ({last_err})" if last_err else ""))
    try:
        metadati.tagga(got, m, pulisci=bool(m.get("cover")))
        base = os.path.join(MUSIC_DIR, clean_segment(j.get("folder"), "Scaricati"))
        dest = metadati.sistema(got, base, m)
        jupdate(jid, status="completato", progress=100, finished=time.time(), path=os.path.relpath(dest, MUSIC_DIR),
                album=m.get("album"), track_no=m.get("track"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@app.get("/api/album/scaletta")
def album_scaletta():
    """Tutte le tracce di un album secondo Deezer: la pagina album mostra quelle che mancano in libreria."""
    artist, album = (request.args.get("artist") or "").strip()[:200], (request.args.get("album") or "").strip()[:300]
    if not album:
        return jsonify(error="Manca il titolo dell'album"), 400
    try:
        s = metadati.scaletta(artist, album, (request.args.get("year") or "")[:4] or None)
    except Exception:  # noqa: BLE001 — Deezer irraggiungibile: per la pagina è come "non trovato"
        s = None
    if not s or not s["tracks"]:
        return jsonify(error="Scaletta dell'album non trovata"), 404
    return jsonify(s)


@app.get("/api/discografia")
def discografia():
    """Album, EP, singoli e raccolte di un artista secondo Deezer (?artist=nome oppure ?id=id Deezer),
    più gli artisti simili: la pagina artista mostra anche ciò che non è in libreria."""
    nome, dzid = (request.args.get("artist") or "").strip()[:200], request.args.get("id") or ""
    if not nome and not dzid.isdigit():
        return jsonify(error="Manca l'artista"), 400
    try:
        d = metadati.discografia(nome, int(dzid) if dzid.isdigit() else None)
    except Exception:  # noqa: BLE001 — Deezer irraggiungibile: per la pagina è come "non trovato"
        d = None
    if not d:
        return jsonify(error="Artista non trovato su Deezer"), 404
    return jsonify(d)


@app.get("/api/discografia/album/<int:dzid>")
def discografia_album(dzid):
    """Un album di Deezer con la sua scaletta, per la pagina di un album che non è in libreria."""
    try:
        s = metadati.album_deezer(dzid)
    except Exception:  # noqa: BLE001
        s = None
    if not s or not s["tracks"]:
        return jsonify(error="Album non trovato su Deezer"), 404
    return jsonify(s)


@app.get("/api/health")
def health():
    return jsonify(ok=True, name=NAME, ytdlp=yt_dlp.version.__version__, version=VERSION, api=API_LEVEL)


# ------------------------------------------------------------------ caricamento dal client
UPLOAD_AUDIO = {"mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "aif", "aiff", "wma", "wv", "ape"}
UPLOAD_COVER = {"cover.jpg", "cover.jpeg", "cover.png", "folder.jpg", "folder.jpeg", "folder.png"}


def file_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


@app.put("/api/upload")
def upload():
    # un file per richiesta, corpo grezzo: niente multipart da tenere in memoria,
    # e il client può mostrare l'avanzamento e riprovare file per file
    parts = [p for p in (request.args.get("path") or "").replace("\\", "/").split("/") if p.strip(" .")]
    if not parts or len(parts) > 8:
        return jsonify(error="Percorso del file non valido"), 400
    name = parts[-1]
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in UPLOAD_AUDIO and name.lower() not in UPLOAD_COVER:
        return jsonify(error="Formato non supportato"), 415
    rel = [clean_segment(request.args.get("folder"), "Caricati")] + [clean_segment(p, "_") for p in parts]
    dest = os.path.join(MUSIC_DIR, *rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".armony-part"  # estensione che Navidrome non indicizza
    h, size = hashlib.sha256(), 0
    try:
        with open(tmp, "wb") as f:
            for b in iter(lambda: request.stream.read(1 << 20), b""):
                f.write(b); h.update(b); size += len(b)
        if not size:
            raise ValueError("File vuoto")
        if ext in UPLOAD_AUDIO and mutagen.File(tmp) is None:
            raise ValueError("Non è un file audio riconosciuto")
    except Exception as e:  # noqa: BLE001
        if os.path.exists(tmp):
            os.remove(tmp)
        return jsonify(error=str(e)[:200]), 415 if isinstance(e, (ValueError, mutagen.MutagenError)) else 500
    digest, stem, n = h.hexdigest(), dest, 2
    while os.path.exists(dest):
        if os.path.getsize(dest) == size and file_hash(dest) == digest:
            os.remove(tmp)
            return jsonify(status="già presente", path=os.path.relpath(dest, MUSIC_DIR))
        base, dot, e = stem.rpartition(".")
        dest, n = f"{base} ({n}).{e}", n + 1
    os.replace(tmp, dest)
    return jsonify(status="caricato", path=os.path.relpath(dest, MUSIC_DIR), size=size), 201


# ------------------------------------------------------------------ eliminazione dalla libreria
# ─── PERCHÉ NON BASTA il percorso di getSong (Subsonic) ───
# Navidrome ai client Subsonic dà un percorso inventato ("Artista/Album/03 - Titolo.mp3"), salvo che il
# singolo client abbia attivato "report real path". Il percorso vero sta solo nel suo DB (media_file.path,
# relativo alla libreria): lo leggiamo in sola lettura. Un percorso mandato dal client non è mai accettato.
NAVIDROME_DB = os.environ.get("NAVIDROME_DB", "/navidrome/navidrome.db")
NAVIDROME_MUSIC = os.environ.get("NAVIDROME_MUSIC", "/music").rstrip("/")  # la libreria come la vede Navidrome


def prune(d, root):
    # risalendo verso la radice: via le cartelle rimaste senza audio (al più con le copertine), mai la radice
    while d != root and d.startswith(root + os.sep):
        try:
            names = os.listdir(d)
        except OSError:
            return
        if any(n.lower() not in UPLOAD_COVER for n in names):
            return
        try:
            for n in names:
                os.remove(os.path.join(d, n))
            os.rmdir(d)
        except OSError:
            return
        d = os.path.dirname(d)


def valid_ids(ids):
    return isinstance(ids, list) and ids and len(ids) <= 500 and all(isinstance(i, str) and ID_RE.match(i) for i in ids)


def track_paths(ids):
    """id Navidrome → percorso del file dentro MUSIC_DIR, letto dal DB di Navidrome in sola lettura.
    Restituisce ({id: percorso}, {id: errore}); solleva sqlite3.Error se il DB non si legge."""
    nd = sqlite3.connect(f"file:{NAVIDROME_DB}?mode=ro", uri=True, timeout=10)
    try:
        rows = nd.execute("SELECT m.id, l.path, m.path FROM media_file m JOIN library l ON l.id = m.library_id "
                          f"WHERE m.id IN ({','.join('?' * len(ids))})", ids).fetchall()
    finally:
        nd.close()
    found = {r[0]: (r[1], r[2]) for r in rows}
    root = os.path.realpath(MUSIC_DIR)
    paths, errors = {}, {}
    for i in ids:
        if i not in found:
            errors[i] = "Brano non trovato"
            continue
        lib, rel = found[i]
        if lib.rstrip("/") != NAVIDROME_MUSIC:
            errors[i] = "Il brano sta in un'altra libreria"
            continue
        f = os.path.realpath(os.path.join(root, rel))  # risolve anche i collegamenti: niente uscite dalla cartella
        if not f.startswith(root + os.sep):
            errors[i] = "Percorso fuori dalla cartella della musica"
            continue
        paths[i] = f
    return paths, errors


ND_DB_ERR = "Non riesco a leggere il database di Navidrome: controlla il montaggio in docker-compose.yml"


@app.post("/api/tracks/delete")
def tracks_delete():
    ids = (request.get_json(silent=True) or {}).get("ids")
    if not valid_ids(ids):
        return jsonify(error="Elenco di brani non valido (al massimo 500)"), 400
    try:
        paths, errors = track_paths(ids)
    except sqlite3.Error:
        return jsonify(error=ND_DB_ERR), 503
    root = os.path.realpath(MUSIC_DIR)
    done, dirs = [], set()
    for i, f in paths.items():
        try:
            os.remove(f)
        except FileNotFoundError:
            pass  # già sparito: Navidrome lo toglie alla prossima scansione
        except OSError as e:
            errors[i] = str(e)[:200]
            continue
        done.append(i)
        dirs.add(os.path.dirname(f))
    for d in sorted(dirs, key=len, reverse=True):
        prune(d, root)
    return jsonify(deleted=len(done), ids=done, errors=errors)


# ------------------------------------------------------------------ modifica dei brani e copertine
# Stesso permesso dell'eliminazione ("delete" = «Modifica ed eliminazione»). I file non si spostano mai:
# per Navidrome l'id di un brano dipende dal percorso, e così playlist, preferiti e ascolti restano.
COVER_HOSTS = ("cdn-images.dzcdn.net", "e-cdns-images.dzcdn.net", "cdns-images.dzcdn.net")
IMG_MAGIC = ((b"\xff\xd8\xff", "jpg"), (b"\x89PNG\r\n\x1a\n", "png"))


@app.get("/api/tracks/<tid>/tags")
def track_tags(tid):
    if not ID_RE.match(tid):
        abort(400)
    try:
        paths, errors = track_paths([tid])
    except sqlite3.Error:
        return jsonify(error=ND_DB_ERR), 503
    if tid not in paths:
        return jsonify(error=errors.get(tid, "Brano non trovato")), 404
    try:
        return jsonify(metadati.leggi_tag(paths[tid]))
    except (ValueError, mutagen.MutagenError, OSError) as e:
        return jsonify(error=str(e)[:200]), 422


@app.put("/api/tracks/tags")
def tracks_tags_put():
    d = request.get_json(silent=True) or {}
    ids, fields = d.get("ids"), d.get("fields")
    if not valid_ids(ids) or not isinstance(fields, dict):
        return jsonify(error="Richiesta non valida"), 400
    fields = {k: v for k, v in fields.items() if k in metadati.CAMPI}
    if not fields:
        return jsonify(error="Nessun campo da modificare"), 400
    if len(ids) > 1 and fields.keys() & {"title", "track"}:
        return jsonify(error="Titolo e numero di traccia si cambiano un brano alla volta"), 400
    for k in ("artists", "genres"):
        if k in fields and not isinstance(fields[k], list):
            return jsonify(error=f"{k}: serve un elenco"), 400
    for k in ("track", "disc"):
        if fields.get(k) not in (None, "") and not str(fields[k]).isdigit():
            return jsonify(error="Numero di traccia o disco non valido"), 400
    if any(len(str(v)) > 500 for v in fields.values()):
        return jsonify(error="Valore troppo lungo"), 400
    try:
        paths, errors = track_paths(ids)
    except sqlite3.Error:
        return jsonify(error=ND_DB_ERR), 503
    done = []
    for i, f in paths.items():
        try:
            metadati.modifica(f, fields)
            done.append(i)
        except (ValueError, mutagen.MutagenError, OSError) as e:
            errors[i] = str(e)[:200]
    return jsonify(saved=len(done), ids=done, errors=errors)


def cover_image():
    """L'immagine della copertina: corpo grezzo (jpeg/png, max 10 MB) oppure {url} di Deezer.
    Mai un indirizzo qualsiasi: il server lo scaricherebbe dalla sua rete (SSRF)."""
    if request.mimetype == "application/json":
        url = str((request.get_json(silent=True) or {}).get("url") or "")
        p = urllib.parse.urlparse(url)
        if p.scheme != "https" or p.hostname not in COVER_HOSTS:
            return None, "Sono ammesse solo copertine di Deezer"
        try:
            r = http.get(url, timeout=15, allow_redirects=False)
            data = r.content if r.ok else b""
        except requests.RequestException:
            return None, "Copertina non raggiungibile"
    else:
        data = request.get_data(cache=False)[: 10 * 1024 * 1024 + 1]
    if len(data) > 10 * 1024 * 1024:
        return None, "Immagine troppo grande (massimo 10 MB)"
    if not any(data.startswith(m) for m, _ in IMG_MAGIC):
        return None, "Non è un'immagine JPEG o PNG"
    return data, None


@app.put("/api/tracks/cover")
def tracks_cover():
    ids = [i for i in (request.args.get("ids") or "").split(",") if i]
    if not valid_ids(ids):
        return jsonify(error="Elenco di brani non valido (al massimo 500)"), 400
    img, err = cover_image()
    if err:
        return jsonify(error=err), 400
    try:
        paths, errors = track_paths(ids)
    except sqlite3.Error:
        return jsonify(error=ND_DB_ERR), 503
    done = []
    if request.args.get("album") == "1":
        # copertina dell'album: cover.jpg nelle cartelle dei brani (Navidrome la preferisce a quella incorporata)
        for folder in {os.path.dirname(f) for f in paths.values()}:
            for n in metadati.COVER_NAMES:
                if n != "cover.jpg" and os.path.exists(os.path.join(folder, n)):
                    os.remove(os.path.join(folder, n))
            ext = "png" if img.startswith(IMG_MAGIC[1][0]) else "jpg"
            with open(os.path.join(folder, "cover." + ext), "wb") as fh:
                fh.write(img)
            if ext == "png" and os.path.exists(os.path.join(folder, "cover.jpg")):
                os.remove(os.path.join(folder, "cover.jpg"))
    for i, f in paths.items():
        try:
            metadati.incorpora(f, img)
            done.append(i)
        except Exception as e:  # noqa: BLE001
            errors[i] = str(e)[:200]
    return jsonify(saved=len(done), ids=done, errors=errors)


@app.get("/api/cover/search")
def cover_search():
    q = (request.args.get("q") or "").strip()[:200]
    if not q:
        return jsonify([])
    res = (metadati.deezer("search/album?limit=24&q=" + urllib.parse.quote(q)) or {}).get("data") or []
    return jsonify([{"title": a.get("title"), "artist": (a.get("artist") or {}).get("name"),
                     "preview": a.get("cover_medium"), "cover": a.get("cover_xl") or a.get("cover_big")}
                    for a in res[:24] if a.get("cover_medium")])


# ------------------------------------------------------------------ aggiornamenti
TAG_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
latest = {"tag": None, "checked": 0, "error": None}


def semver(v):
    m = TAG_RE.match("v" + v.lstrip("v"))
    return tuple(map(int, m.groups())) if m else None


def check_latest(force=False):
    # 6 ore: l'API GitHub senza token concede 60 richieste l'ora per IP
    if not REPO or (not force and time.time() - latest["checked"] < 6 * 3600):
        return
    try:
        r = http.get(f"https://api.github.com/repos/{REPO}/tags?per_page=100", timeout=10)
        r.raise_for_status()
        tags = [t["name"] for t in r.json() if TAG_RE.match(t["name"])]
        latest.update(tag=max(tags, key=semver) if tags else None, error=None)
    except Exception as e:  # noqa: BLE001
        latest["error"] = str(e)[:200]
    latest["checked"] = time.time()


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


@app.get("/api/update")
def update_status():
    check_latest(force=request.args.get("refresh") == "1")
    cur, new = semver(VERSION), latest["tag"] and semver(latest["tag"])
    return jsonify(current=VERSION, latest=latest["tag"], repo=REPO or None,
                   available=bool(cur and new and new > cur), error=latest["error"],
                   requested=os.path.exists(os.path.join(UPDATE_DIR, "request")),
                   updater=read_json(os.path.join(UPDATE_DIR, "status.json")))


@app.post("/api/update")
def update_request():
    if not os.path.exists(os.path.join(UPDATE_DIR, "installed")):
        return jsonify(error="Aggiornamento dal tasto non installato su questo server (vedi LEGGIMI)."), 503
    with open(os.path.join(UPDATE_DIR, "request"), "w") as f:
        json.dump({"ts": time.time(), "from": VERSION}, f)
    return jsonify(ok=True)


@app.post("/api/download")
def download():
    d = request.get_json(silent=True) or {}
    url = (d.get("url") or "").strip()
    j = dict(url=url, mode=d.get("mode", "audio"), format=d.get("format", "mp3"), quality=str(d.get("quality", "best")),
             playlist=bool(d.get("playlist")), folder=d.get("folder") or "Scaricati", sponsorblock=bool(d.get("sponsorblock")),
             meta={k: str(v)[:200] for k, v in (d.get("meta") or {}).items() if k in ("artist", "title", "album")})
    if not re.match(r"^(https?://|ytsearch1:|scsearch1:)", url):
        return jsonify(error="Inserisci un link che inizi con http:// o https://"), 400
    if j["mode"] == "audio" and (j["format"] not in AUDIO_FORMATS or j["quality"] not in AUDIO_QUALITIES):
        return jsonify(error="Formato o qualità audio non validi"), 400
    if j["mode"] == "video" and j["quality"] not in VIDEO_QUALITIES:
        return jsonify(error="Qualità video non valida"), 400
    if j["mode"] not in ("audio", "video"):
        return jsonify(error="Modalità non valida"), 400
    jid = uuid.uuid4().hex[:10]
    with jlock:
        jobs[jid] = dict(j, id=jid, status="in coda", progress=0, title=(f"{j['meta'].get('artist', '')} - {j['meta'].get('title', '')}" if j["meta"] else None),
                         created=time.time(), updated=time.time(), by=g.who["user"])
        jsave(jid)
    jq.put((jid, j))
    return jsonify(jobs[jid]), 201


TRACK_STR = ("title", "album", "albumartist", "date", "isrc", "label", "cover", "spotify")


def clean_track(t):
    if not isinstance(t, dict) or not str(t.get("title") or "").strip():
        return None
    out = {k: str(t.get(k) or "").strip()[:300] for k in TRACK_STR}
    out["artists"] = [str(a).strip()[:200] for a in (t.get("artists") or [])[:20] if str(a).strip()]
    out["genres"] = [str(x).strip()[:60] for x in (t.get("genres") or [])[:10] if str(x).strip()]
    for k in ("duration", "track", "disc"):
        out[k] = int(t[k]) if isinstance(t.get(k), (int, float)) and 0 < t[k] < 100000 else None
    if out["cover"] and not out["cover"].startswith("https://"):
        out["cover"] = ""  # una copertina la scarica il server: solo https, niente indirizzi interni
    return out


@app.post("/api/import")
def import_tracks():
    """I brani mancanti di un'importazione, tutti insieme. Un brano già in coda o già scaricato
    (stesso ISRC, o stessi titolo e artista) non viene ripreso."""
    d = request.get_json(silent=True) or {}
    fmt = d.get("format") if d.get("format") in AUDIO_FORMATS else "m4a"
    tracks = [t for t in map(clean_track, (d.get("tracks") or [])[:5000]) if t]
    key = lambda t: t["isrc"] or metadati.norm(" ".join(t["artists"][:1]) + " " + t["title"])
    with jlock:
        seen = {key(x["track"]) for x in jobs.values() if x.get("track") and x["status"] != "errore"}
    added = []
    for t in tracks:
        k = key(t)
        if k in seen:
            continue
        seen.add(k)
        jid = uuid.uuid4().hex[:10]
        j = dict(url="", mode="audio", format=fmt, quality="best", playlist=False, folder=d.get("folder") or "Scaricati",
                 sponsorblock=False, meta={}, track=t)
        with jlock:
            jobs[jid] = dict(j, id=jid, status="in coda", progress=0, title=f"{', '.join(t['artists'])} - {t['title']}",
                             created=time.time(), updated=time.time(), by=g.who["user"])
            jsave(jid)
        jq.put((jid, j))
        added.append(jid)
    return jsonify(added=len(added), skipped=len(tracks) - len(added)), 201


@app.get("/api/jobs")
def list_jobs():
    with jlock:
        return jsonify(sorted(jobs.values(), key=lambda x: x["created"], reverse=True)[:200])


@app.delete("/api/jobs")
def clear_jobs():
    with jlock:
        for k in [k for k, x in jobs.items() if x["status"] in DONE]:
            del jobs[k]
            db.run("DELETE FROM jobs WHERE id = ?", k)
    return jsonify(ok=True)


@app.get("/api/search")
def search():
    q = (request.args.get("q") or "").strip()[:200]
    n = max(1, min(int(request.args.get("n", 10)), 20))
    src = "scsearch" if request.args.get("source") == "sc" else "ytsearch"
    if not q:
        return jsonify([])
    try:
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "extract_flat": "in_playlist", "skip_download": True}) as y:
            info = y.extract_info(f"{src}{n}:{q}", download=False)
    except Exception as e:  # noqa: BLE001
        return jsonify(error=str(e)[:300]), 502
    out = []
    for e in info.get("entries") or []:
        if not e:
            continue
        url = e.get("url") or e.get("webpage_url") or ""
        if src == "ytsearch" and e.get("id") and not url.startswith("http"):
            url = f"https://www.youtube.com/watch?v={e['id']}"
        thumbs = e.get("thumbnails") or []
        out.append(dict(title=e.get("title"), channel=e.get("channel") or e.get("uploader"), duration=e.get("duration"),
                        url=url, thumb=(thumbs[-1].get("url") if thumbs else None), views=e.get("view_count")))
    return jsonify(out)


@app.get("/api/videos")
def list_videos():
    out = []
    for root, _, files in os.walk(VIDEO_DIR):
        for f in files:
            if f.lower().endswith(VIDEO_EXT):
                p = os.path.join(root, f)
                st = os.stat(p)
                out.append(dict(path=os.path.relpath(p, VIDEO_DIR), name=os.path.splitext(f)[0],
                                folder=os.path.relpath(root, VIDEO_DIR), size=st.st_size, mtime=st.st_mtime))
    return jsonify(sorted(out, key=lambda v: v["mtime"], reverse=True))


@app.get("/api/videos/<path:p>")
def get_video(p):
    return send_from_directory(VIDEO_DIR, p, conditional=True, as_attachment=request.args.get("dl") == "1")


@app.delete("/api/videos/<path:p>")
def delete_video(p):
    full = os.path.realpath(os.path.join(VIDEO_DIR, p))
    if not full.startswith(os.path.realpath(VIDEO_DIR) + os.sep) or not os.path.isfile(full):
        abort(404)
    os.remove(full)
    return jsonify(ok=True)


# ------------------------------------------------------------------ client
@app.get("/")
def index():
    return send_from_directory(CLIENT_DIR, "index.html", max_age=0)


@app.get("/<path:p>")
def static_files(p):
    resp = send_from_directory(CLIENT_DIR, p, max_age=0)
    if p == "sw.js":
        resp.headers["Service-Worker-Allowed"] = "/"
    return resp


if __name__ == "__main__":
    os.makedirs(os.path.join(MUSIC_DIR, "Scaricati"), exist_ok=True)
    os.makedirs(VIDEO_DIR, exist_ok=True)
    db.migrate()
    for _ in range(2):
        threading.Thread(target=worker, daemon=True).start()
    resume_jobs()
    threading.Thread(target=gc_rooms, daemon=True).start()
    if MULTICAST:
        threading.Thread(target=mcast_sender, daemon=True).start()
        threading.Thread(target=mcast_listener, daemon=True).start()
    from waitress import serve
    print(f"Armony '{NAME}' sulla porta {PORT}, multicast {'attivo' if MULTICAST else 'spento'}")
    # ogni dispositivo collegato tiene un thread per il canale dal vivo (/api/live), oltre a flussi audio e Jam
    serve(app, host="0.0.0.0", port=PORT, threads=96, channel_timeout=600)
