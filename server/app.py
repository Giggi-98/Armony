"""
Armony - server di supporto.

  /                     client web (cartella client)
  /rest/*, /share/*     proxy verso Navidrome: tutto su un'unica porta e un'unica origine
  /api/jam/*            segnalazione per la Jam. Il server inoltra solo messaggi cifrati
                        dai client con la chiave della stanza: non può leggerli né falsificarli
  /api/lan/*            scoperta di altri server Armony e Jam vicine via multicast UDP
  /api/info            pubblica: nome, versione, livello di API e capacità del server
  /api/login, /api/logout, /api/me   accesso con le credenziali Navidrome (token + sale
                        Subsonic); la sessione va nell'intestazione X-Token
  /api/users            permessi per utente (solo amministratori)
  /api/history, /api/prefs   storico d'ascolto e preferenze dell'utente, condivisi fra i suoi dispositivi
  /api/download, /api/jobs, /api/search, /api/videos   download con yt-dlp (permesso "download")
  /api/upload           caricamento di file audio dal client nella libreria (permesso "upload")
  /api/update           versione installata contro l'ultimo tag su GitHub; la richiesta di
                        aggiornamento la esegue l'host (deploy/armony-update.sh), non il container
"""
import hashlib
import ipaddress
import json
import os
import re
import secrets
import socket
import struct
import threading
import time
import uuid

import mutagen
import requests
import yt_dlp
from flask import Flask, Response, abort, g, jsonify, request, send_from_directory, stream_with_context
from yt_dlp.postprocessor.metadataparser import MetadataParserPP

import db

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
CAPS = ["login", "upload", "download", "update", "jam", "lan", "history", "prefs"]
# prefisso → permesso richiesto. "user" = qualsiasi sessione valida
RULES = (("/api/update", "admin"), ("/api/users", "admin"), ("/api/upload", "upload"),
         ("/api/download", "download"), ("/api/jobs", "download"), ("/api/search", "download"),
         ("/api/videos", "download"), ("/api/health", "user"), ("/api/me", "user"), ("/api/logout", "user"),
         ("/api/history", "user"), ("/api/prefs", "user"))
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
        return dict(user=None, admin=True, upload=True, download=True)
    s = db.one("SELECT s.user, s.admin, s.seen, coalesce(p.upload, 1) upload, coalesce(p.download, 1) download "
               "FROM sessions s LEFT JOIN perms p ON p.user = s.user WHERE s.token = ?", tok)
    if not s or time.time() - s["seen"] > SESSION_DAYS * 86400:
        return None
    if time.time() - s["seen"] > 3600:
        db.run("UPDATE sessions SET seen = ? WHERE token = ?", time.time(), tok)
    admin = bool(s["admin"])
    return dict(user=s["user"], admin=admin, upload=admin or bool(s["upload"]), download=admin or bool(s["download"]))


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
                              "download": "I download non sono abilitati per il tuo utente."}[need]), 403
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
    return dict(user=g.who["user"], admin=g.who["admin"], upload=g.who["upload"], download=g.who["download"],
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
                   "coalesce(p.upload, 1) upload, coalesce(p.download, 1) download "
                   "FROM (SELECT user FROM sessions UNION SELECT user FROM perms) u "
                   "LEFT JOIN sessions s ON s.user = u.user LEFT JOIN perms p ON p.user = u.user "
                   "GROUP BY u.user ORDER BY u.user")
    return jsonify([dict(r, admin=bool(r["admin"]), upload=bool(r["upload"]), download=bool(r["download"])) for r in rows])


@app.put("/api/users/<name>")
def set_user(name):
    d = request.get_json(silent=True) or {}
    db.run("INSERT INTO perms (user, upload, download) VALUES (?, ?, ?) "
           "ON CONFLICT(user) DO UPDATE SET upload = excluded.upload, download = excluded.download",
           name[:100], int(bool(d.get("upload", True))), int(bool(d.get("download", True))))
    return jsonify(ok=True)


@app.delete("/api/users/<name>/sessions")
def revoke_user(name):
    db.run("DELETE FROM sessions WHERE user = ?", name)
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


# ------------------------------------------------------------------ download
jobs = {}
jlock = threading.Lock()
SLOTS = threading.Semaphore(2)


JOB_KEYS = ("url", "mode", "format", "quality", "playlist", "folder", "sponsorblock", "meta")
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
            threading.Thread(target=run_job, args=(j["id"], {k: j[k] for k in JOB_KEYS}), daemon=True).start()


def lit(s):
    return str(s).replace("%", "%%")


def run_job(jid, j):
    with SLOTS:
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
    threading.Thread(target=run_job, args=(jid, j), daemon=True).start()
    return jsonify(jobs[jid]), 201


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
    resume_jobs()
    threading.Thread(target=gc_rooms, daemon=True).start()
    if MULTICAST:
        threading.Thread(target=mcast_sender, daemon=True).start()
        threading.Thread(target=mcast_listener, daemon=True).start()
    from waitress import serve
    print(f"Armony '{NAME}' sulla porta {PORT}, multicast {'attivo' if MULTICAST else 'spento'}")
    serve(app, host="0.0.0.0", port=PORT, threads=48, channel_timeout=600)
