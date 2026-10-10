"""
Armony - federazione: server Armony collegati fra loro (docs/FEDERAZIONE.md).

  /fed/hello             pubblica: chi è questo nodo (impronta, nome, proprietario, chiave, proto)
  /fed/v1/*              fra nodi. Ogni richiesta è firmata Ed25519 (metodo, percorso, data, destinatario,
                         hash del corpo; al massimo 5 minuti) da un nodo collegato, tranne /fed/v1/pair che
                         porta il segreto dell'invito. Anche le risposte JSON sono firmate.
    pair, accettato, revoca          abbinamento e chiusura del collegamento
    catalogo?since=v                 la libreria: artista, album, titolo, durata, anno, id opaco; niente
                                     percorsi. Solo le righe cambiate dopo la versione v
    cerca, vicini                    ricerca e mappa inoltrate agli amici degli amici (ttl, rid contro i cicli)
    file/<id>, cover/<id>, info/<id> il brano (Range), la copertina, dimensione e sha256; ?via=a,b a catena
    radio, radio/<id>, ora           Jam Radio: le definisce radio.py su questo blueprint (stesse firme)
  /api/fed/*             gestione, solo amministratori: impostazioni, inviti, collegamenti
  /api/rete/*            per gli utenti: cerca, stream, cover, mappa; copia (permesso "download");
                         offerte (GET), offerta {pid, on} (POST): quali playlist pubbliche vanno ai server collegati

Registrato da app.py con init(): usa da lì sessione HTTP, credenziali di Navidrome e coda dei lavori.
"""
import base64
import hashlib
import ipaddress
import json
import os
import queue
import re
import secrets
import socket
import threading
import time
import unicodedata
import urllib.parse
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed, wait

import requests
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from flask import Blueprint, Response, abort, g, jsonify, request, stream_with_context

import db
import diagnosi

PROTO = 1
FED_DIR = os.environ.get("FED_DIR", "/federati")            # dove Armony scrive le copie
FED_ND_PATH = os.environ.get("FED_ND_PATH", "/federati")    # la stessa cartella come la vede Navidrome
SEARCH_MS = 3000          # tempo massimo di una ricerca nella rete, inoltri compresi
REFRESH_S = 600           # ogni quanto si riscaricano (le differenze de) i cataloghi dei vicini
RATE = 600                # richieste al minuto per nodo collegato (le copertine di una ricerca sono già 30-40)
INVITE_H = 24
NODE_RE = re.compile(r"^[0-9a-f]{32}$")
SONG_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
# gli stessi 64 simboli del codice di sicurezza della Jam (client/jam.js)
SYMBOLS = ['🍎', '🍋', '🍇', '🍉', '🍒', '🥝', '🍍', '🥕', '🌽', '🍄', '🌵', '🌻', '🌙', '⭐', '🔥', '💧', '⚡', '❄️', '🌈', '☂️',
           '🎈', '🎁', '🎸', '🎺', '🥁', '🎻', '🎹', '🎧', '📻', '🎤', '🚲', '🚀', '⛵', '🚂', '🏠', '⛺', '🗻', '🌋', '🐶', '🐱',
           '🐭', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦉', '🐢', '🐍', '🐙', '🦀',
           '🐠', '🐳', '🦋', '🐝']
STREAM_FORMATS = {"raw", "mp3", "opus"}

bp = Blueprint("federazione", __name__)
A = None       # il modulo app.py (init)
KEY = None     # chiave privata Ed25519 di questo nodo
PUB = ""       # chiave pubblica, base64url
ME = ""        # impronta: sha256 della chiave pubblica, 32 cifre esadecimali
pool = ThreadPoolExecutor(max_workers=16)
build_lock = threading.Lock()
seen_rids = {}             # id delle richieste inoltrate già viste -> istante (contro i cicli)
rate = {}                  # nodo -> [minuto, richieste]
fails = {}                 # nodo -> (aggiornamenti falliti di fila, istante dell'ultimo tentativo)
inflight, inflight_lock, store_lock = set(), threading.Lock(), threading.Lock()
pair_failed = {}           # ip -> istanti dei tentativi di abbinamento falliti
nd_tok = {"jwt": None}


class FedError(Exception):
    def __init__(self, msg, status=502):
        super().__init__(msg)
        self.status = status


# ------------------------------------------------------------------ identità e firme
def b64e(b):
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def b64d(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def node_id(pub):
    return hashlib.sha256(b64d(pub)).hexdigest()[:32]


def load_identity():
    global KEY, PUB, ME
    path = os.path.join(os.path.dirname(db.PATH), "identita.key")
    try:
        with open(path, "rb") as f:
            KEY = Ed25519PrivateKey.from_private_bytes(f.read())
    except FileNotFoundError:
        KEY = Ed25519PrivateKey.generate()
        raw = KEY.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
    PUB = b64e(KEY.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))
    ME = node_id(PUB)


def canon(method, path, date, to, body):
    return "\n".join(["armony-fed-1", method.upper(), path, str(date), to, hashlib.sha256(body or b"").hexdigest()]).encode()


def canon_resp(req_sig, body):
    return "\n".join(["armony-fed-1-risposta", req_sig, hashlib.sha256(body or b"").hexdigest()]).encode()


def verify(pub, sig, data):
    try:
        Ed25519PublicKey.from_public_bytes(b64d(pub)).verify(b64d(sig), data)
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


def safety(a, b):
    # come relayCode della Jam: SHA-256 delle due chiavi pubbliche in ordine, cinque simboli
    x, y = sorted([a, b])
    h = hashlib.sha256(f"{x}.{y}".encode()).digest()
    return " ".join(SYMBOLS[v % 64] for v in h[:5])


# ------------------------------------------------------------------ impostazioni (tabella settings)
def setting(k, default=None):
    r = db.one("SELECT value FROM settings WHERE key = ?", "fed_" + k)
    return r["value"] if r else default


def set_setting(k, v):
    db.run("INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", "fed_" + k, str(v))


def my_url():
    return setting("url", "")


def transitive():
    return setting("transitive", "1") == "1"


def hops():
    try:
        return max(1, min(int(setting("hops", "2")), 4))
    except ValueError:
        return 2


def owner():
    return setting("owner", "")


def fold(s):
    s = unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", s.lower()).strip()


# ------------------------------------------------------------------ richieste firmate verso gli altri nodi
def fed_req(node, method, path, params=None, body=None, stream=False, timeout=10, headers=None, raw=None):
    q = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v not in (None, "")})
    full = path + ("?" + q if q else "")
    data = raw if raw is not None else json.dumps(body).encode() if body is not None else b""
    date = int(time.time())
    sig = b64e(KEY.sign(canon(method, full, date, node["id"], data)))
    h = {"X-Fed-Node": ME, "X-Fed-Date": str(date), "X-Fed-To": node["id"], "X-Fed-Sig": sig, **(headers or {})}
    if body is not None:
        h["Content-Type"] = "application/json"
    nid = node["id"]
    # un nodo che tiene aperto il canale e che di recente non si è raggiunto direttamente: la richiesta va lì (vedi
    # «canale inverso»). La prova diretta la fa probe() in sottofondo: dentro una richiesta costerebbe secondi
    if chan_ok(nid) and time.time() - direct_ok.get(nid, 0) > 1800:
        return via_chan(node, method, full, h, data, timeout), sig
    try:
        r = A.http.request(method, node["url"].rstrip("/") + full, data=data or None, headers=h, timeout=timeout,
                           stream=stream, allow_redirects=False)
    except requests.RequestException:
        if chan_ok(nid):
            return via_chan(node, method, full, h, data, timeout), sig
        raise FedError(f"{node.get('name') or 'Il nodo'} non risponde")
    direct_ok[nid] = time.time()
    return r, sig


def fed_json(node, method, path, params=None, body=None, timeout=10):
    r, sig = fed_req(node, method, path, params, body, timeout=timeout)
    if not r.ok:
        try:
            msg = r.json().get("error")
        except ValueError:
            msg = None
        raise FedError(msg or f"{node.get('name') or 'Il nodo'} ha risposto con errore {r.status_code}", r.status_code)
    # la risposta deve essere firmata dalla chiave fissata all'abbinamento: nessuno in mezzo può cambiarla
    if not verify(node["pub"], r.headers.get("X-Fed-Sig", ""), canon_resp(sig, r.content)):
        raise FedError("Risposta non firmata dal nodo collegato")
    return r.json()


def nodes(state="attivo"):
    return [dict(r) for r in db.all_("SELECT * FROM fed_nodes WHERE state = ? ORDER BY name", state)]


def node(nid):
    r = db.one("SELECT * FROM fed_nodes WHERE id = ?", nid)
    return dict(r) if r else None


# ------------------------------------------------------------------ verifica delle richieste in arrivo
@bp.before_request
def fed_guard():
    if not request.path.startswith("/fed/v1/"):
        return None
    if (request.content_length or 0) > (CHUNK + 4096 if request.path.startswith("/fed/v1/canale/") else 256 * 1024):
        return jsonify(error="Richiesta troppo grande"), 413
    nid, sig = request.headers.get("X-Fed-Node", ""), request.headers.get("X-Fed-Sig", "")
    try:
        date = int(request.headers.get("X-Fed-Date", "0"))
    except ValueError:
        date = 0
    if request.headers.get("X-Fed-To") != ME:
        return jsonify(error="Richiesta destinata a un altro nodo"), 401
    if abs(time.time() - date) > 300:
        return jsonify(error="Firma scaduta: controlla l'ora dei due server"), 401
    body = request.get_data(cache=True)
    full = request.path + ("?" + request.query_string.decode() if request.query_string else "")
    if request.path == "/fed/v1/pair":
        # il nodo non è ancora noto: la firma si verifica con la chiave che porta, che deve dare la sua impronta
        pub = str((request.get_json(silent=True) or {}).get("pub") or "")
        n = {"id": nid, "pub": pub, "state": "nuovo"}
        if not pub or node_id(pub) != nid:
            return jsonify(error="Chiave e impronta non coincidono"), 401
    else:
        n = node(nid) if NODE_RE.match(nid) else None
        if not n:
            return jsonify(error="Nodo non collegato"), 403
    if not verify(n["pub"], sig, canon(request.method, full, date, ME, body)):
        return jsonify(error="Firma non valida"), 401
    allowed = {"/fed/v1/pair": ("nuovo",), "/fed/v1/accettato": ("attesa", "attivo"), "/fed/v1/revoca": ("attesa", "richiesta", "attivo")}
    if n["state"] not in allowed.get(request.path, ("attivo",)):
        return jsonify(error="Collegamento non attivo" if n["state"] != "richiesta" else "Collegamento in attesa di conferma"), 403
    # verso "ricevo": prendo dalla sua libreria ma la mia non la mostro a lui (né catalogo, né ricerca, né audio)
    if n.get("dir") == "ricevo" and request.path not in allowed and request.path not in ("/fed/v1/ora", "/fed/v1/raggiungo") \
            and not request.path.startswith("/fed/v1/canale"):
        return jsonify(error=f"{A.NAME} non condivide la sua libreria con questo server", code="verso"), 403
    w = int(time.time() // 60)
    rl = rate.setdefault(nid, [w, 0])
    if rl[0] != w:
        rl[:] = [w, 0]
    rl[1] += not request.path.startswith("/fed/v1/canale/")  # i pezzi di un brano nel canale non sono richieste nuove
    if rl[1] > RATE:
        return jsonify(error="Troppe richieste da questo nodo"), 429
    g.fed_node, g.fed_sig = n, sig
    if n["state"] != "nuovo":
        db.run("UPDATE fed_nodes SET seen = ? WHERE id = ?", time.time(), nid)
    return None


@bp.after_request
def fed_sign(resp):
    if getattr(g, "fed_sig", None) and resp.mimetype == "application/json" and not resp.direct_passthrough:
        resp.headers["X-Fed-Sig"] = b64e(KEY.sign(canon_resp(g.fed_sig, resp.get_data())))
    return resp


def hello_payload():
    # caps: funzioni in più senza alzare PROTO (un PROTO diverso chiude il collegamento)
    return dict(nodo=ME, nome=A.NAME, proprietario=owner(), proto=PROTO, app=A.VERSION, pub=PUB, caps=["epoca", "verso", "canale"])


@bp.get("/fed/hello")
def hello():
    return jsonify(hello_payload())


# ------------------------------------------------------------------ abbinamento
def invite_code(secret):
    j = json.dumps({"u": my_url(), "k": PUB, "s": secret, "n": A.NAME}, separators=(",", ":"))
    return "ARF1" + b64e(j.encode())


def parse_code(code):
    m = re.search(r"ARF1[A-Za-z0-9_-]+", str(code or ""))
    if not m:
        raise ValueError("Codice di collegamento non valido")
    try:
        j = json.loads(b64d(m.group(0)[4:]))
        assert all(isinstance(j.get(k), str) and j[k] for k in ("u", "k", "s"))
    except Exception:  # noqa: BLE001
        raise ValueError("Codice di collegamento non valido")
    return j


def clean_url(u):
    u = str(u or "").strip().rstrip("/")
    p = urllib.parse.urlparse(u)
    if p.scheme not in ("http", "https") or not p.hostname or p.query or p.fragment:
        raise ValueError("Indirizzo non valido: serve http(s)://nome-o-ip[:porta]")
    # un altro server non può farsi chiamare su un servizio interno di questa macchina (SSRF): LAN e Tailscale sì.
    # Si guardano tutti gli indirizzi a cui il nome porta (anche 127.1, ::ffff:127.0.0.1, nomi DNS verso 127.0.0.1)
    try:
        addrs = {a[4][0] for a in socket.getaddrinfo(p.hostname, p.port or (443 if p.scheme == "https" else 80), proto=socket.IPPROTO_TCP)}
    except OSError:
        addrs = set()  # il nome non si risolve da qui: lo dirà il primo collegamento
    for a in addrs:
        ip = ipaddress.ip_address(a.split("%")[0])
        ip = ip.ipv4_mapped or ip if ip.version == 6 else ip
        if ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast:
            raise ValueError("Indirizzo non valido: non può essere un indirizzo interno di questo server")
    return u


@bp.post("/fed/v1/pair")
def pair():
    ip, now = A.client_ip(), time.time()  # dal Funnel conta l'indirizzo vero, non 127.0.0.1
    recent = [t for t in pair_failed.get(ip, []) if now - t < 600]
    if len(recent) >= 10:
        return jsonify(error="Troppi tentativi: riprova più tardi"), 429
    d = request.get_json(silent=True) or {}
    h = hashlib.sha256(str(d.get("secret") or "").encode()).hexdigest()
    took = db.conn().execute("UPDATE fed_invites SET used_by = ? WHERE hash = ? AND used_by IS NULL AND expires > ?",
                             (g.fed_node["id"], h, now)).rowcount
    if not took:
        pair_failed[ip] = recent + [now]
        return jsonify(error="Invito scaduto, già usato o non valido: chiedine uno nuovo"), 403
    nid = g.fed_node["id"]
    try:
        url = clean_url(d.get("url"))
        if nid == ME:
            raise ValueError("Non puoi collegare un server a sé stesso")
    except ValueError as e:
        db.run("UPDATE fed_invites SET used_by = NULL WHERE hash = ?", h)
        return jsonify(error=str(e)), 400
    db.run("INSERT INTO fed_nodes (id, pub, name, owner, url, state, created, seen, app, proto) VALUES (?, ?, ?, ?, ?, 'richiesta', ?, ?, ?, ?) "
           "ON CONFLICT(id) DO UPDATE SET url = excluded.url, name = excluded.name, owner = excluded.owner, "
           "state = CASE WHEN fed_nodes.state = 'attivo' THEN 'attivo' ELSE 'richiesta' END",
           nid, d["pub"], str(d.get("name") or "Server")[:60], str(d.get("owner") or "")[:60], url, now, now,
           str(d.get("app") or "")[:20], int(d.get("proto") or 0))
    return jsonify(**hello_payload(), state=node(nid)["state"])


@bp.post("/fed/v1/accettato")
def accepted():
    db.run("UPDATE fed_nodes SET state = 'attivo', error = NULL WHERE id = ?", g.fed_node["id"])
    pool.submit(refresh, g.fed_node["id"])
    return jsonify(ok=True)


@bp.post("/fed/v1/revoca")
def revoked():
    db.run("UPDATE fed_nodes SET state = 'chiuso', error = 'Collegamento chiuso dall''altro server' WHERE id = ?", g.fed_node["id"])
    db.run("DELETE FROM fed_catalog WHERE node = ?", g.fed_node["id"])
    return jsonify(ok=True)


# ------------------------------------------------------------------ la mia libreria: catalogo da Navidrome
def nd_params():
    adm = A.nd_admin()
    if not adm:
        raise FedError("Navidrome non è configurato per la rete: l'amministratore deve inserirne le credenziali (Impostazioni → Utenti → Registrazione)", 503)
    salt = secrets.token_hex(6)
    return dict(u=adm["user"], t=hashlib.md5((adm["pass"] + salt).encode()).hexdigest(), s=salt, v="1.16.1", c="armony-fed", f="json")


def nd_get(method, **params):
    for attempt in (0, 1):
        try:
            r = A.http.get(f"{A.NAVIDROME_URL}/rest/{method}", params={**nd_params(), **params}, timeout=30).json()["subsonic-response"]
        except (requests.RequestException, ValueError, KeyError):
            raise FedError("Il server musicale non risponde", 502)
        # Navidrome occupato risponde per un attimo "credenziali errate" (codice 40) anche a quelle giuste: si riprova una volta
        if attempt or (r.get("error") or {}).get("code") != 40:
            break
        time.sleep(0.8)
    if r.get("status") != "ok":
        raise FedError((r.get("error") or {}).get("message") or "Navidrome ha rifiutato la richiesta", 502)
    return r


def nd_native(method, path, **kw):
    """API nativa di Navidrome con l'amministratore (librerie e utenti)."""
    adm = A.nd_admin()
    if not adm:
        raise FedError("Credenziali di Navidrome mancanti", 503)
    for attempt in (0, 1):
        if not nd_tok["jwt"] or attempt:
            nd_tok["jwt"], _ = A.nd_login(adm["user"], adm["pass"])
            if not nd_tok["jwt"]:
                raise FedError("Le credenziali dell'amministratore di Navidrome non valgono più", 503)
        r = A.http.request(method, f"{A.NAVIDROME_URL}{path}", headers={"X-ND-Authorization": f"Bearer {nd_tok['jwt']}"}, timeout=15, **kw)
        if r.status_code == 401 and not attempt:
            continue
        r.raise_for_status()
        return r.json() if r.content else None


def main_library():
    # solo la libreria di musica/: le copie ricevute (federati/) non si rioffrono, niente condivisione a catena dei file
    for lib in nd_native("GET", "/api/library") or []:
        if str(lib.get("path", "")).rstrip("/") == A.NAVIDROME_MUSIC:
            return lib["id"]
    return None


def song_row(s):
    return {"id": s["id"], "title": s.get("title") or "", "artist": s.get("displayArtist") or s.get("artist") or "",
            "album": s.get("album") or "", "albumArtist": s.get("displayAlbumArtist") or s.get("artist") or "",
            "duration": s.get("duration") or 0, "year": s.get("year") or None, "track": s.get("track") or None,
            "disc": s.get("discNumber") or None, "genre": s.get("genre") or "", "cover": s.get("coverArt") or "",
            "suffix": s.get("suffix") or "", "size": s.get("size") or 0, "bitRate": s.get("bitRate") or 0}


def build_catalog(force=False):
    """Rilegge la libreria da Navidrome se ha scansionato da allora. Le righe cambiate prendono una versione
    nuova; quelle sparite restano come "gone": così un vicino chiede solo le differenze (?since=)."""
    if not build_lock.acquire(blocking=False):
        return
    try:
        if not A.nd_admin():
            return
        last = nd_get("getScanStatus").get("scanStatus", {}).get("lastScan", "")
        if not force and last == setting("scan") and time.time() - float(setting("built", "0")) < 6 * 3600:
            return
        lib, songs, off = main_library(), {}, 0
        while True:
            params = dict(query="", songCount=500, songOffset=off, artistCount=0, albumCount=0)
            if lib is not None:
                params["musicFolderId"] = lib
            so = nd_get("search3", **params).get("searchResult3", {}).get("song", [])
            for s in so:
                songs[s["id"]] = song_row(s)
            if len(so) < 500:
                break
            off += 500
        old = {r["id"]: (r["data"], r["gone"]) for r in db.all_("SELECT id, data, gone FROM fed_mine")}
        ver = int(setting("ver", "0")) + 1
        up = [(i, ver, s["cover"], json.dumps(s, sort_keys=True)) for i, s in songs.items()
              if old.get(i) != (json.dumps(s, sort_keys=True), 0)]
        gone = [(ver, i) for i, (_, x) in old.items() if i not in songs and not x]
        if up or gone:
            c = db.conn()
            c.execute("BEGIN")
            c.executemany("INSERT INTO fed_mine (id, ver, gone, cover, data) VALUES (?, ?, 0, ?, ?) ON CONFLICT(id) DO UPDATE SET "
                          "ver = excluded.ver, gone = 0, cover = excluded.cover, data = excluded.data", up)
            c.executemany("UPDATE fed_mine SET gone = 1, ver = ? WHERE id = ?", gone)
            c.execute("INSERT INTO settings VALUES ('fed_ver', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (str(ver),))
            c.execute("COMMIT")
        set_setting("scan", last)
        set_setting("built", time.time())
    except (FedError, requests.RequestException, ValueError) as e:
        diagnosi.avviso("federazione", f"catalogo non aggiornato: {e}")
    finally:
        build_lock.release()


def my_counts():
    r = db.one("SELECT count(*) n, count(DISTINCT json_extract(data, '$.album') || '|' || json_extract(data, '$.albumArtist')) a "
               "FROM fed_mine WHERE gone = 0")
    return r["n"], r["a"]


@bp.get("/fed/v1/catalogo")
def catalog():
    build_catalog()
    ver = int(setting("ver", "0"))
    try:
        since = int(request.args.get("since", 0))
    except ValueError:
        since = 0
    # versione sconosciuta, o epoca diversa (il nodo ha perso il suo DB e le versioni sono ripartite): tutto da capo
    reset = since <= 0 or since > ver or (request.args.get("epoca") or epoca()) != epoca()
    if reset:
        rows = db.all_("SELECT data FROM fed_mine WHERE gone = 0")
        songs, gone = [json.loads(r["data"]) for r in rows], []
    else:
        rows = db.all_("SELECT id, gone, data FROM fed_mine WHERE ver > ?", since)
        songs = [json.loads(r["data"]) for r in rows if not r["gone"]]
        gone = [r["id"] for r in rows if r["gone"]]
    n, a = my_counts()
    # ti_raggiungo: se no, chi chiede apre il canale inverso verso di me (è dietro NAT o un indirizzo solo interno)
    return jsonify(**hello_payload(), ver=ver, reset=reset, songs=songs, gone=gone, transitive=transitive(), total=n, albums=a, epoca=epoca(),
                   verso=g.fed_node.get("dir") or "entrambi", ti_raggiungo=time.time() - direct_ok.get(g.fed_node["id"], 0) < 1800)


def epoca():
    # nasce con il catalogo: se il DB si perde ne nasce una nuova e i vicini ripartono da zero invece di fidarsi delle versioni
    e = setting("epoca")
    if not e:
        e = secrets.token_hex(6)
        set_setting("epoca", e)
    return e


def refresh(nid):
    """Scarica dal vicino le righe del catalogo cambiate dall'ultima volta e aggiorna il suo stato."""
    with inflight_lock:
        if nid in inflight:
            return  # già in corso (un giro lento e un "Aggiorna ora" insieme)
        inflight.add(nid)
    try:
        _refresh(nid)
    finally:
        with inflight_lock:
            inflight.discard(nid)


def _refresh(nid):
    n = node(nid)
    if not n or n["state"] not in ("attivo", "attesa"):
        return
    try:
        j = fed_json(n, "GET", "/fed/v1/catalogo", params={"since": n["ver"] if n["state"] == "attivo" else 0, "epoca": setting("epoca:" + nid)},
                     timeout=(5, 60))
    except FedError as e:
        # chi aspetta la conferma riceve "in attesa": non è un errore da mostrare; "verso": non condivide con noi
        msg = None if "attesa di conferma" in str(e) or "non condivide" in str(e) else str(e)[:200]
        if "non condivide" in str(e):
            db.run("DELETE FROM fed_catalog WHERE node = ?", nid)  # ha scelto di non mostrarci più la sua libreria
        db.run("UPDATE fed_nodes SET error = ? WHERE id = ?", msg, nid)
        k = fails.get(nid, (0, 0))[0]
        fails[nid] = (k + 1 if msg else k, time.time())
        return
    fails.pop(nid, None)
    if int(j.get("proto") or 0) != PROTO:
        db.run("UPDATE fed_nodes SET error = ? WHERE id = ?", f"Versione incompatibile: aggiorna Armony su {n['name']} o qui", nid)
        return
    with store_lock:  # le richieste ai vicini in parallelo, le scritture nel DB una alla volta (niente "database is locked")
        c = db.conn()
        c.execute("BEGIN")
        try:
            _store(c, nid, n, j)
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")  # niente transazioni lasciate aperte sulla connessione del thread
            raise
    if j.get("epoca"):
        set_setting("epoca:" + nid, j["epoca"])
    if "ti_raggiungo" in j:
        chan_want[nid] = not j["ti_raggiungo"]
        set_setting("canale:" + nid, int(chan_want[nid]))  # ricordato: dopo un riavvio il canale si riapre subito
        if chan_want[nid]:
            chan_start(nid)


def _store(c, nid, n, j):
    if j.get("reset"):
        c.execute("DELETE FROM fed_catalog WHERE node = ?", (nid,))
    rows = []
    for s in j.get("songs") or []:
        if not isinstance(s, dict) or not SONG_RE.match(str(s.get("id", ""))):
            continue
        s = {k: s.get(k) for k in ("id", "title", "artist", "album", "albumArtist", "duration", "year", "track", "disc", "genre",
                                   "cover", "suffix", "size", "bitRate")}
        rows.append((nid, s["id"], fold(f"{s['title']} {s['artist']} {s['album']}"), fold(f"{s['album']} {s['albumArtist']}"),
                     f"{s['album']}|{s['albumArtist']}", json.dumps(s)))
    c.executemany("INSERT OR REPLACE INTO fed_catalog (node, id, q, qa, alb, data) VALUES (?, ?, ?, ?, ?, ?)", rows)
    c.executemany("DELETE FROM fed_catalog WHERE node = ? AND id = ?", [(nid, str(i)) for i in j.get("gone") or []])
    cnt = c.execute("SELECT count(*), count(DISTINCT alb) FROM fed_catalog WHERE node = ?", (nid,)).fetchone()
    # la prima risposta firmata di chi mi aveva dato l'invito vuol dire che ha accettato
    c.execute("UPDATE fed_nodes SET state = 'attivo', name = ?, owner = ?, app = ?, proto = ?, ver = ?, songs = ?, albums = ?, "
              "transitive = ?, error = NULL, seen = ?, synced = ? WHERE id = ?",
              (str(j.get("nome") or n["name"])[:60], str(j.get("proprietario") or "")[:60], str(j.get("app") or "")[:20],
               PROTO, int(j.get("ver") or 0), cnt[0], cnt[1], int(bool(j.get("transitive"))), time.time(), time.time(), nid))


def loop():
    time.sleep(5)
    while True:
        try:
            build_catalog()
            # in parallelo: un nodo spento non deve fermare gli altri per un minuto ciascuno. Chi non risponde si
            # riprova sempre più piano (10 min, 20, 40… fino a 6 ore); "offro" = non prendo niente da lui
            due = [n for n in nodes("attivo") + nodes("attesa") if n.get("dir") != "offro"
                   and time.time() - max(n["synced"] or 0, fails.get(n["id"], (0, 0))[1]) > min(6 * 3600, REFRESH_S * 2 ** fails.get(n["id"], (0, 0))[0])]
            for f in [pool.submit(refresh, n["id"]) for n in due]:
                try:
                    f.result(timeout=90)
                except Exception:  # noqa: BLE001
                    pass
            now = time.time()
            for k in [k for k, t in seen_rids.items() if now - t > 120]:
                seen_rids.pop(k, None)
            # strutture in memoria che crescevano senza limite: nodi sconosciuti su /pair, tentativi vecchi, inviti scaduti
            w = int(now // 60)
            for k in [k for k, r in rate.items() if r[0] < w - 1]:
                rate.pop(k, None)
            for k in [k for k, ts in pair_failed.items() if all(now - t > 600 for t in ts)]:
                pair_failed.pop(k, None)
            db.run("DELETE FROM fed_invites WHERE expires < ?", now - 86400)
            if now - last_probe[0] > 600:
                last_probe[0] = now
                probe()
                # chi ha scelto "offro" non scarica il catalogo e non legge ti_raggiungo: glielo si chiede a parte
                for n in nodes():
                    if n.get("dir") == "offro":
                        try:
                            want = not fed_json(n, "GET", "/fed/v1/raggiungo", timeout=(5, 20)).get("ti_raggiungo", True)
                        except FedError:
                            continue
                        chan_want[n["id"]] = want
                        set_setting("canale:" + n["id"], int(want))
                        if want:
                            chan_start(n["id"])
            for k in [k for k, p in list(pend.items()) if now - p.get("at", now) > 900]:
                pend.pop(k, None)  # richieste del canale mai lette fino in fondo (chi ascoltava ha chiuso prima del primo byte)
            for sub in db.all_("SELECT * FROM fed_subs WHERE coalesce(last, 0) < ?", now - SUB_S):
                db.run("UPDATE fed_subs SET last = ? WHERE pid = ?", now, sub["pid"])  # niente doppioni col giro dopo
                pool.submit(sub_sync, dict(sub))
        except Exception as e:  # noqa: BLE001 — il giro dopo riprova
            diagnosi.avviso("federazione", str(e))
        time.sleep(60)


# ------------------------------------------------------------------ canale inverso: server che non si raggiungono da fuori
# ─── PERCHÉ ───
# Un server dietro NAT o CGNAT (niente porte aperte, niente Tailscale) può chiamare gli altri ma nessuno può chiamare
# lui: la sua libreria restava invisibile. La foglia tiene aperta verso un vicino raggiungibile una richiesta in attesa
# (/fed/v1/canale, 25 s alla volta); il vicino ci mette le richieste firmate destinate a lei, la foglia le esegue sul suo
# server come se arrivassero da fuori (la firma è quella del vicino: niente di nuovo da fidarsi) e rimanda la risposta a
# pezzi da 512 kB (/fed/v1/canale/<rq>), così passano anche i brani interi, transcodificati o no. fed_req sceglie da
# sola: diretto se il nodo risponde, il canale se non risponde e il canale è aperto. Si forma una stella attorno ai
# server pubblici; catalogo, ricerca, audio a catena e radio non cambiano. Costa un thread del vicino per ogni foglia.
CHAN_POLL = 25
CHUNK = 512 * 1024
chan = {}        # (vicino) foglia -> {"q": richieste per lei, "at": ultimo collegamento}
pend = {}        # (vicino) richiesta nel canale -> {"nid", "meta": Event, "info": stato e intestazioni, "chunks": pezzi}
direct_ok = {}   # nodo -> ultima richiesta diretta riuscita
chan_want = {}   # (foglia) vicino -> mi ha detto che non mi raggiunge: tengo il canale
chan_threads = {}
last_probe = [0.0]
chan_lock = threading.Lock()


def probe():
    """Ogni 10 minuti, chi non ha avuto traffico diretto di recente si riprova direttamente: se risponde (porta aperta,
    Tailscale) si torna al collegamento diretto, e lui chiude il canale quando legge ti_raggiungo."""
    for n in nodes():
        if time.time() - direct_ok.get(n["id"], 0) > 900:
            probe_one(n["id"])


def probe_one(nid):
    n = node(nid)
    try:
        if n and A.http.get(n["url"].rstrip("/") + "/fed/hello", timeout=5).json().get("nodo") == nid:
            direct_ok[nid] = time.time()
    except (requests.RequestException, ValueError):
        pass


@bp.get("/fed/v1/raggiungo")
def reach_me():
    # per chi non scarica il mio catalogo ("offro"): gli dice se lo raggiungo, così sa se tenere il canale
    return jsonify(ti_raggiungo=time.time() - direct_ok.get(g.fed_node["id"], 0) < 1800)


def chan_ok(nid):
    c = chan.get(nid)
    return bool(c) and time.time() - c["at"] < CHAN_POLL + 20


class ChanResp:
    """Come una risposta di requests, ma arriva dal canale: quanto basta a fed_json e a passthrough."""
    def __init__(self, rq, p, read_to):
        self.rq, self.p, self.read_to, self._content = rq, p, read_to, None
        info = p.get("info") if isinstance(p.get("info"), dict) else {}
        self.status_code = int(info.get("status") or 502)
        self.ok = 200 <= self.status_code < 400
        self.headers = requests.structures.CaseInsensitiveDict(info.get("headers") or {})

    def iter_content(self, _size=None):
        try:
            while True:
                c = self.p["chunks"].get(timeout=self.read_to)
                if c is None:
                    break
                yield c
        except queue.Empty:
            pass
        finally:
            self.close()

    @property
    def content(self):
        if self._content is None:
            self._content = b"".join(self.iter_content())
        return self._content

    def json(self):
        return json.loads(self.content)

    def close(self):
        pend.pop(self.rq, None)  # la foglia riceve 410 al pezzo dopo e smette di mandare
        self.p["closed"] = True
        try:
            while True:
                self.p["chunks"].get_nowait()  # libera la memoria e sblocca chi sta mettendo un pezzo
        except queue.Empty:
            pass


def via_chan(node, method, full, h, data, timeout):
    rq = uuid.uuid4().hex
    p = {"nid": node["id"], "meta": threading.Event(), "chunks": queue.Queue(maxsize=16), "at": time.time()}
    pend[rq] = p
    chan[node["id"]]["q"].put({"rq": rq, "method": method, "path": full, "headers": h, "body": b64e(data) if data else ""})
    first, read = timeout if isinstance(timeout, tuple) else (timeout, timeout)
    if not p["meta"].wait(max(first, 5) + 15):
        pend.pop(rq, None)
        raise FedError(f"{node.get('name') or 'Il nodo'} non risponde dal canale")
    return ChanResp(rq, p, max(read, 30))


@bp.post("/fed/v1/canale")
def chan_poll():
    nid = g.fed_node["id"]
    with chan_lock:
        c = chan.setdefault(nid, {"q": queue.Queue(), "at": 0, "gen": 0})
        c["gen"] += 1
        gen = c["gen"]
        if gen > 1:
            c["q"].put(None)  # sveglia l'attesa di prima: al più una per nodo tiene un thread
    c["at"] = time.time()
    if nid not in direct_ok:
        pool.submit(probe_one, nid)  # canale appena aperto: si prova subito se in realtà si raggiunge
    out, end = [], time.time() + CHAN_POLL
    while time.time() < end and gen == c["gen"]:
        try:
            x = c["q"].get(timeout=max(0.1, end - time.time()))
        except queue.Empty:
            break
        if x is None:
            continue  # la sveglia: se l'attesa è ancora quella giusta si ricontrolla gen e si continua
        out.append(x)
        while len(out) < 20:
            try:
                x = c["q"].get_nowait()
            except queue.Empty:
                break
            if x is not None:
                out.append(x)
        break
    if gen != c["gen"]:
        # nel frattempo la foglia ha riaperto il canale (riavvio, rete cambiata): questa attesa è di una connessione morta,
        # quello che ha preso torna in coda per quella nuova
        for x in out:
            c["q"].put(x)
        return jsonify(reqs=[])
    c["at"] = time.time()
    return jsonify(reqs=out)


@bp.post("/fed/v1/canale/<rq>")
def chan_reply(rq):
    p = pend.get(rq)
    if not p or p["nid"] != g.fed_node["id"]:
        return jsonify(error="Richiesta scaduta"), 410
    if "info" not in p:
        try:
            p["info"] = json.loads(request.headers.get("X-Canale-Meta") or "{}")
        except ValueError:
            p["info"] = {"status": 502, "headers": {}}
        p["meta"].set()
    # chi ascolta va piano: la foglia aspetta (al più 8 MB in memoria), a passi brevi per accorgersi se ha smesso
    for item in [request.get_data()] + ([None] if request.args.get("fine") else []):
        for _ in range(240):
            if p.get("closed") or rq not in pend:
                return jsonify(error="Richiesta scaduta"), 410
            try:
                p["chunks"].put(item, timeout=0.5)
                break
            except queue.Full:
                continue
        else:
            pend.pop(rq, None)
            return jsonify(error="Richiesta scaduta"), 410
    return jsonify(ok=True)


def chan_start(nid):
    with chan_lock:
        t = chan_threads.get(nid)
        if t and t.is_alive():
            return
        chan_threads[nid] = threading.Thread(target=chan_run, args=(nid,), daemon=True, name="canale-" + nid[:6])
        chan_threads[nid].start()


def chan_run(nid):
    while chan_want.get(nid):
        n = node(nid)
        if not n or n["state"] != "attivo" or n.get("dir") == "ricevo":
            break  # "ricevo": la mia libreria a lui non la do, il canale non serve
        try:
            j = fed_json(n, "POST", "/fed/v1/canale", body={}, timeout=(5, CHAN_POLL + 15))
        except FedError:
            time.sleep(10)
            continue
        for rq in j.get("reqs") or []:
            if isinstance(rq, dict) and rq.get("rq"):
                threading.Thread(target=chan_exec, args=(n, rq), daemon=True).start()


def chan_exec(n, rq):
    """Una richiesta arrivata dal canale: eseguita qui come se fosse arrivata da fuori, la risposta torna a pezzi."""
    path = str(rq.get("path") or "")
    if not path.startswith("/fed/v1/") or path.startswith("/fed/v1/canale") or ".." in path or "%2e" in path.lower():
        return
    hdr = {k: str(v) for k, v in (rq.get("headers") or {}).items() if k.lower().startswith("x-fed-") or k.lower() in ("range", "content-type")}
    try:
        body = b64d(rq["body"]) if rq.get("body") else None
        resp = A.app.test_client().open(path, method=str(rq.get("method") or "GET"), headers=hdr, data=body, buffered=False)
    except Exception as e:  # noqa: BLE001
        diagnosi.avviso("federazione", f"canale: richiesta non eseguita: {e}")
        return
    keep = {h.lower() for h in A.PASS_RESP} | {"x-fed-sig"}
    meta = json.dumps({"status": resp.status_code, "headers": {k: v for k, v in resp.headers.items() if k.lower() in keep}})
    seq = 0

    def send(chunk, fine):
        nonlocal seq
        r, _ = fed_req(n, "POST", f"/fed/v1/canale/{rq['rq']}", params={"seq": seq, "fine": 1 if fine else None}, raw=chunk,
                       headers={"X-Canale-Meta": meta} if seq == 0 else None, timeout=(5, 130))
        seq += 1
        return r.status_code == 200

    try:
        buf = b""
        for part in resp.iter_encoded():
            buf += part
            while len(buf) >= CHUNK:
                if not send(buf[:CHUNK], False):
                    return
                buf = buf[CHUNK:]
        send(buf, True)
    except FedError:
        pass
    finally:
        resp.close()


# ------------------------------------------------------------------ ricerca e mappa: cache dei vicini, poi inoltro
def like_words(q):
    return [w.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") for w in fold(q).split()[:6] if w]


def search_cache(nids, q, max_songs=40, max_albums=8):
    words = like_words(q)
    if not nids or not words:
        return [], []
    marks = ",".join("?" * len(nids))
    cond = lambda col: " AND ".join(f"{col} LIKE ? ESCAPE '\\'" for _ in words)
    args = [f"%{w}%" for w in words]
    songs = [dict(json.loads(r["data"]), node=r["node"]) for r in db.all_(
        f"SELECT node, data FROM fed_catalog WHERE node IN ({marks}) AND {cond('q')} LIMIT ?", *nids, *args, max_songs)]
    albums = []
    for r in db.all_(f"SELECT DISTINCT node, alb FROM fed_catalog WHERE node IN ({marks}) AND {cond('qa')} LIMIT ?", *nids, *args, max_albums):
        tr = sorted((json.loads(x["data"]) for x in db.all_("SELECT data FROM fed_catalog WHERE node = ? AND alb = ? LIMIT 60", r["node"], r["alb"])),
                    key=lambda s: (s.get("disc") or 1, s.get("track") or 0, s.get("title") or ""))
        if tr:
            albums.append({"node": r["node"], "album": tr[0]["album"], "albumArtist": tr[0]["albumArtist"], "year": tr[0].get("year"),
                           "cover": tr[0].get("cover"), "tracks": tr})
    return songs, albums


def node_info(n):
    return {"name": n["name"], "owner": n["owner"] or "", "songs": n["songs"], "albums": n["albums"]}


def forward(path, body, targets, deadline, skip):
    """Inoltra a più vicini in parallelo, entro deadline (istante). Le risposte arrivano col percorso dal vicino in poi."""
    out = []
    left = deadline - time.time()
    if not targets or left < 0.3:
        return out
    futs = {pool.submit(fed_json, n, "POST", path, None, dict(body, ms=int((left - 0.2) * 1000), skip=sorted(skip)), left): n for n in targets}
    done, _ = wait(futs, timeout=left)
    for f in done:
        try:
            out.append((futs[f], f.result()))
        except FedError:
            pass
    return out


def visible_to(requester):
    # i vicini che posso mostrare a chi non li ha collegati: solo quelli che lo permettono
    return [n for n in pullable() if n["id"] != requester and n["transitive"]]


def pullable():
    # i vicini a cui chiedo (ricerca, audio, mappa): non quelli con cui ho scelto "offro", cioè solo dare
    return [n for n in nodes() if n.get("dir") != "offro"]


def net_search(q, ttl, skip, requester, rid, deadline):
    """Risultati dalla cache dei vicini (escluso chi chiede e chi è in skip), più quelli inoltrati se restano salti."""
    seen_rids[rid] = time.time()
    near = [n for n in (pullable() if requester is None else visible_to(requester)) if n["id"] not in skip]
    songs, albums = search_cache([n["id"] for n in near], q)
    for x in songs + albums:
        x["path"] = [x.pop("node")]
    names = {n["id"]: node_info(n) for n in near}
    if ttl > 1 and near:
        # chi riceve non deve rimandarmi ciò che vedo già io: me e tutti i miei vicini
        nskip = set(skip) | {ME} | {n["id"] for n in nodes()}
        answers = forward("/fed/v1/cerca", {"rid": rid, "q": q, "ttl": ttl - 1}, near, deadline, nskip)
        # un vicino che non ha risposto ha i brani nella mia cache, ma adesso non li può far ascoltare
        up = {n["id"] for n, _ in answers}
        for x in songs + albums:
            if x["path"][0] not in up:
                x["offline"] = True
        for n, j in answers:
            for k, out in (("songs", songs), ("albums", albums)):
                for x in j.get(k) or []:
                    if isinstance(x, dict) and isinstance(x.get("path"), list) and all(isinstance(p, str) and NODE_RE.match(p) for p in x["path"]):
                        x["path"] = [n["id"]] + x["path"]
                        out.append(x)
            for k, v in (j.get("nodes") or {}).items():
                if NODE_RE.match(k) and isinstance(v, dict) and k not in names:
                    names[k] = {f: v.get(f) for f in ("name", "owner", "songs", "albums")}
    return songs, albums, names


def take_body():
    d = request.get_json(silent=True) or {}
    rid = str(d.get("rid") or "")[:40]
    skip = {s for s in (d.get("skip") or []) if isinstance(s, str) and NODE_RE.match(s)}
    try:
        # anche chi inoltra ha il suo limite di salti
        ttl = max(0, min(int(d.get("ttl") or 0), hops()))
        ms = max(0, min(int(d.get("ms") or 0), SEARCH_MS))
    except (TypeError, ValueError):
        ttl, ms = 0, 0
    return d, rid, skip, ttl, time.time() + ms / 1000


@bp.post("/fed/v1/cerca")
def fed_search():
    d, rid, skip, ttl, deadline = take_body()
    if not rid or rid in seen_rids:
        return jsonify(songs=[], albums=[], nodes={}, dup=True)
    songs, albums, names = net_search(str(d.get("q") or "")[:100], ttl, skip, g.fed_node["id"], rid, deadline)
    return jsonify(songs=songs, albums=albums, nodes=names)


def net_map(ttl, skip, requester, rid, deadline):
    seen_rids[rid] = time.time()
    near = [n for n in (pullable() if requester is None else visible_to(requester)) if n["id"] not in skip]
    out = [{"id": n["id"], **node_info(n), "online": not n["error"], "seen": n["seen"], "path": [n["id"]]} for n in near]
    if ttl > 1 and near:
        nskip = set(skip) | {ME} | {n["id"] for n in nodes()}
        answers = forward("/fed/v1/vicini", {"rid": rid, "ttl": ttl - 1}, near, deadline, nskip)
        up = {n["id"] for n, _ in answers}
        for x in out:
            x["online"] = x["online"] and x["id"] in up  # la mappa è dal vivo: chi non risponde adesso è spento
        for n, j in answers:
            for x in j.get("nodes") or []:
                if isinstance(x, dict) and NODE_RE.match(str(x.get("id"))) and isinstance(x.get("path"), list):
                    out.append({"id": x["id"], "name": str(x.get("name") or "")[:60], "owner": str(x.get("owner") or "")[:60],
                                "songs": x.get("songs") or 0, "albums": x.get("albums") or 0, "online": bool(x.get("online")),
                                "seen": x.get("seen"), "path": [n["id"]] + [p for p in x["path"] if isinstance(p, str)]})
    return out


@bp.post("/fed/v1/vicini")
def fed_neighbors():
    d, rid, skip, ttl, deadline = take_body()
    if not rid or rid in seen_rids:
        return jsonify(nodes=[], dup=True)
    return jsonify(nodes=net_map(ttl, skip, g.fed_node["id"], rid, deadline))


# ------------------------------------------------------------------ file, copertine, impronte: serviti qui o passati al prossimo nodo
def next_hop(via):
    """via = percorso che resta fino al nodo che ha il file. Il primo deve essere un mio vicino attivo e,
    se la richiesta arriva da un altro nodo, deve permettere di essere visto dagli amici degli amici."""
    if not via:
        return None, ""
    n = node(via[0])
    requester = getattr(g, "fed_node", None)
    if not n or n["state"] != "attivo" or (requester and (not n["transitive"] or n["id"] == requester["id"])):
        abort(Response(json.dumps({"error": "Percorso non valido"}), 403, mimetype="application/json"))
    return n, ",".join(via[1:])


def parse_via(s):
    via = [x for x in str(s or "").split(",") if x]
    if len(via) > 4 or not all(NODE_RE.match(x) for x in via):
        abort(400)
    return via


def passthrough(r):
    out = {k: v for k, v in r.headers.items() if k.lower() in A.PASS_RESP}
    return Response(stream_with_context(r.iter_content(64 * 1024)), status=r.status_code, headers=out, direct_passthrough=True)


def stream_params():
    fmt = request.args.get("format") or "raw"
    if fmt not in STREAM_FORMATS:
        abort(400)
    try:
        br = max(0, min(int(request.args.get("maxBitRate") or 0), 320))
    except ValueError:
        abort(400)
    return {"format": fmt, "maxBitRate": br or None}


def serve(kind, sid, via, params):
    """Il brano o la copertina: dal mio Navidrome se l'ho io, altrimenti dal prossimo nodo del percorso."""
    hop, rest = next_hop(via)
    rng = {"Range": request.headers["Range"]} if request.headers.get("Range") else {}
    if hop:
        r, _ = fed_req(hop, "GET", f"/fed/v1/{kind}/{sid}", params={"via": rest, **params}, stream=True, timeout=(5, 600), headers=rng)
        return passthrough(r)
    # la copertina si chiede per id del brano: quella di Navidrome cambia nome a ogni scansione
    row = db.one("SELECT cover FROM fed_mine WHERE id = ? AND gone = 0", sid)
    if not row or (kind == "cover" and not row["cover"]):
        return jsonify(error="Brano non offerto"), 404
    method, nid = ("stream", sid) if kind == "file" else ("getCoverArt", row["cover"])
    try:
        r = A.http.get(f"{A.NAVIDROME_URL}/rest/{method}", params={**nd_params(), "id": nid, **{k: v for k, v in params.items() if v}},
                       headers={**rng, "Accept-Encoding": "identity"}, stream=True, timeout=(5, 600))
    except requests.RequestException:
        return jsonify(error="Il server musicale non risponde"), 502
    return passthrough(r)


@bp.get("/fed/v1/file/<sid>")
def fed_file(sid):
    if not SONG_RE.match(sid):
        abort(400)
    return serve("file", sid, parse_via(request.args.get("via")), stream_params())


@bp.get("/fed/v1/cover/<sid>")
def fed_cover(sid):
    if not SONG_RE.match(sid):
        abort(400)
    try:
        size = max(0, min(int(request.args.get("size") or 0), 1000))
    except ValueError:
        abort(400)
    return serve("cover", sid, parse_via(request.args.get("via")), {"size": size or None})


def sha_of(path):
    st = os.stat(path)
    r = db.one("SELECT size, mtime, sha FROM fed_hash WHERE path = ?", path)
    if r and r["size"] == st.st_size and r["mtime"] == st.st_mtime:
        return r["sha"]
    sha = A.file_hash(path)
    db.run("INSERT OR REPLACE INTO fed_hash VALUES (?, ?, ?, ?)", path, st.st_size, st.st_mtime, sha)
    return sha


def song_info(sid, via):
    hop, rest = next_hop(via)
    if hop:
        return fed_json(hop, "GET", f"/fed/v1/info/{sid}", params={"via": rest}, timeout=60)
    r = db.one("SELECT data FROM fed_mine WHERE id = ? AND gone = 0", sid)
    if not r:
        raise FedError("Brano non offerto", 404)
    info = json.loads(r["data"])
    try:
        paths, _ = A.track_paths([sid])
        if sid in paths:
            info.update(size=os.path.getsize(paths[sid]), sha256=sha_of(paths[sid]))
    except Exception:  # noqa: BLE001 — senza il DB di Navidrome si verifica solo la dimensione
        pass
    return dict(info, nodo=ME, nome=A.NAME, proprietario=owner())


@bp.get("/fed/v1/info/<sid>")
def fed_info(sid):
    if not SONG_RE.match(sid):
        abort(400)
    try:
        return jsonify(song_info(sid, parse_via(request.args.get("via"))))
    except FedError as e:
        return jsonify(error=str(e)), e.status


# ------------------------------------------------------------------ gestione (solo amministratori)
def node_out(n):
    online = n["state"] == "attivo" and not n["error"] and n["seen"] and time.time() - n["seen"] < 3 * REFRESH_S
    return {k: n[k] for k in ("id", "name", "owner", "url", "state", "created", "seen", "app", "songs", "albums", "error", "synced", "dir")} | {
        "transitive": bool(n["transitive"]), "online": bool(online or chan_ok(n["id"])), "safety": safety(PUB, n["pub"]),
        # canale: lui non è raggiungibile e mi parla dal canale inverso; uscita: io non sono raggiungibile e tengo il canale verso di lui
        "reach": "canale" if chan_ok(n["id"]) and time.time() - direct_ok.get(n["id"], 0) > 1800 else "uscita" if chan_want.get(n["id"]) else "diretto"}


@bp.get("/api/fed")
def fed_status():
    n, a = my_counts()
    return jsonify(me=dict(hello_payload(), url=my_url(), songs=n, albums=a, short=ME[:8]),
                   settings=dict(url=my_url(), owner=owner(), transitive=transitive(), hops=hops()),
                   ready=bool(A.nd_admin()), nodes=[node_out(dict(r)) for r in db.all_("SELECT * FROM fed_nodes ORDER BY state != 'richiesta', name")])


@bp.put("/api/fed/settings")
def fed_settings():
    d = request.get_json(silent=True) or {}
    try:
        if "url" in d:
            set_setting("url", clean_url(d["url"]) if d["url"] else "")
    except ValueError as e:
        return jsonify(error=str(e)), 400
    if "owner" in d:
        set_setting("owner", str(d["owner"] or "").strip()[:60])
    if "transitive" in d:
        set_setting("transitive", "1" if d["transitive"] else "0")
    if "hops" in d:
        try:
            set_setting("hops", max(1, min(int(d["hops"]), 4)))
        except (TypeError, ValueError):
            return jsonify(error="Numero di salti non valido"), 400
    return fed_status()


def ensure_me(d):
    # indirizzo e proprietario: se mancano li porta il client dell'amministratore (l'indirizzo con cui lui raggiunge il server)
    if not my_url() and d.get("url"):
        set_setting("url", clean_url(d["url"]))
    if not owner() and g.who.get("user"):
        set_setting("owner", g.who["user"])
    if not my_url():
        raise ValueError("Imposta prima l'indirizzo con cui gli altri server raggiungono questo")


@bp.post("/api/fed/invites")
def fed_invite():
    d = request.get_json(silent=True) or {}
    try:
        ensure_me(d)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    secret, now = secrets.token_urlsafe(18), time.time()
    db.run("INSERT INTO fed_invites (hash, created, expires) VALUES (?, ?, ?)", hashlib.sha256(secret.encode()).hexdigest(), now, now + INVITE_H * 3600)
    return jsonify(code=invite_code(secret), expires=now + INVITE_H * 3600), 201


@bp.post("/api/fed/join")
def fed_join():
    d = request.get_json(silent=True) or {}
    try:
        ensure_me(d)
        inv = parse_code(d.get("code"))
        url = clean_url(inv["u"])
    except ValueError as e:
        return jsonify(error=str(e)), 400
    try:
        h = A.http.get(url + "/fed/hello", timeout=10).json()
    except (requests.RequestException, ValueError):
        return jsonify(error=f"Non riesco a raggiungere {url}: controlla che sia acceso e raggiungibile da questo server"), 502
    if h.get("pub") != inv["k"]:
        return jsonify(error="La chiave del server non è quella dell'invito: qualcuno si è messo in mezzo, o l'indirizzo è sbagliato"), 409
    if int(h.get("proto") or 0) != PROTO:
        return jsonify(error=f"Versione incompatibile: aggiorna Armony su {h.get('nome') or url} o qui"), 409
    nid = node_id(inv["k"])
    if nid == ME:
        return jsonify(error="Questo è il codice di questo stesso server"), 400
    peer = {"id": nid, "pub": inv["k"], "name": h.get("nome") or inv.get("n") or "Server", "url": url}
    try:
        j = fed_json(peer, "POST", "/fed/v1/pair", body={"secret": inv["s"], "url": my_url(), "name": A.NAME, "owner": owner(),
                                                          "pub": PUB, "app": A.VERSION, "proto": PROTO})
    except FedError as e:
        return jsonify(error=str(e)), 502
    now = time.time()
    db.run("INSERT INTO fed_nodes (id, pub, name, owner, url, state, created, seen, app, proto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
           "ON CONFLICT(id) DO UPDATE SET url = excluded.url, name = excluded.name, owner = excluded.owner, state = excluded.state, error = NULL",
           nid, inv["k"], str(j.get("nome") or peer["name"])[:60], str(j.get("proprietario") or "")[:60], url,
           "attivo" if j.get("state") == "attivo" else "attesa", now, now, str(j.get("app") or "")[:20], PROTO)
    if j.get("state") == "attivo":
        pool.submit(refresh, nid)
    return jsonify(node_out(node(nid)))


@bp.post("/api/fed/nodes/<nid>/accept")
def fed_accept(nid):
    n = node(nid)
    if not n or n["state"] != "richiesta":
        return jsonify(error="Nessuna richiesta da questo server"), 404
    db.run("UPDATE fed_nodes SET state = 'attivo', error = NULL WHERE id = ?", nid)
    try:
        fed_json(dict(n, state="attivo"), "POST", "/fed/v1/accettato", body={})
    except FedError:
        pass  # lo saprà alla prossima richiesta firmata che riceve risposta
    pool.submit(refresh, nid)
    return jsonify(node_out(node(nid)))


@bp.put("/api/fed/nodes/<nid>/verso")
def fed_dir(nid):
    """entrambi: ci vediamo a vicenda; offro: lui vede me, io non chiedo niente a lui; ricevo: io vedo lui, lui non vede me."""
    d = str((request.get_json(silent=True) or {}).get("dir") or "")
    if d not in ("entrambi", "offro", "ricevo") or not node(nid):
        return jsonify(error="Verso non valido"), 400
    db.run("UPDATE fed_nodes SET dir = ? WHERE id = ?", d, nid)
    if d == "offro":
        db.run("DELETE FROM fed_catalog WHERE node = ?", nid)  # i suoi brani non compaiono più nelle mie ricerche
    else:
        db.run("UPDATE fed_nodes SET synced = 0 WHERE id = ?", nid)
        pool.submit(refresh, nid)
    return jsonify(ok=True, dir=d)


@bp.post("/api/fed/nodes/<nid>/refresh")
def fed_refresh(nid):
    if not node(nid):
        abort(404)
    refresh(nid)
    return jsonify(node_out(node(nid)))


@bp.delete("/api/fed/nodes/<nid>")
def fed_remove(nid):
    n = node(nid)
    if not n:
        abort(404)
    if n["state"] != "chiuso":
        try:
            fed_json(n, "POST", "/fed/v1/revoca", body={}, timeout=5)
        except FedError:
            pass  # spento o irraggiungibile: le sue richieste saranno comunque rifiutate
    db.run("DELETE FROM fed_catalog WHERE node = ?", nid)
    db.run("DELETE FROM fed_nodes WHERE id = ?", nid)
    return jsonify(ok=True)


# ------------------------------------------------------------------ per gli utenti: cerca, ascolta, mappa, copia
@bp.get("/api/rete/cerca")
def rete_search():
    q = (request.args.get("q") or "").strip()[:100]
    if len(q) < 2:
        return jsonify(songs=[], albums=[], nodes={}, ms=0)
    t0 = time.time()
    songs, albums, names = net_search(q, hops(), set(), None, uuid.uuid4().hex, t0 + SEARCH_MS / 1000)
    # lo stesso brano arrivato da due strade: vale il percorso più corto
    best = {}
    for s in sorted(songs, key=lambda x: len(x["path"])):
        best.setdefault((s["path"][-1], s.get("id")), s)
    alb = {}
    for a in sorted(albums, key=lambda x: len(x["path"])):
        alb.setdefault((a["path"][-1], a.get("album"), a.get("albumArtist")), a)
    return jsonify(songs=list(best.values())[:60], albums=list(alb.values())[:12], nodes=names, ms=round((time.time() - t0) * 1000))


@bp.get("/api/rete/mappa")
def rete_map():
    n, a = my_counts()
    direct = [node_out(dict(r)) for r in db.all_("SELECT * FROM fed_nodes WHERE state = 'attivo' ORDER BY name")]
    far = net_map(hops(), set(), None, uuid.uuid4().hex, time.time() + SEARCH_MS / 1000)
    live = {x["id"]: x["online"] for x in far if len(x["path"]) == 1}
    for x in direct:
        x["online"] = x["online"] and live.get(x["id"], True)
    ids = {x["id"] for x in direct} | {ME}
    seen, more = set(), []
    for x in sorted(far, key=lambda x: len(x["path"])):
        if len(x["path"]) > 1 and x["id"] not in ids and x["id"] not in seen:
            seen.add(x["id"])
            more.append(x)
    return jsonify(me={"id": ME, "name": A.NAME, "owner": owner(), "songs": n, "albums": a}, hops=hops(),
                   nodes=[{k: x[k] for k in ("id", "name", "owner", "songs", "albums", "online", "seen", "app", "error", "state", "reach", "dir")} for x in direct],
                   far=more)


def route_arg():
    r = parse_via(request.args.get("r"))
    if not r:
        abort(400)
    return r


@bp.get("/api/rete/stream")
def rete_stream():
    sid = request.args.get("id") or ""
    if not SONG_RE.match(sid):
        abort(400)
    try:
        return serve("file", sid, route_arg(), stream_params())
    except FedError as e:
        return jsonify(error=str(e)), 502


@bp.get("/api/rete/cover")
def rete_cover():
    sid = request.args.get("id") or ""
    if not SONG_RE.match(sid):
        abort(400)
    try:
        size = max(0, min(int(request.args.get("size") or 0), 1000))
    except ValueError:
        abort(400)
    try:
        resp = serve("cover", sid, route_arg(), {"size": size or None})
    except FedError as e:
        return jsonify(error=str(e)), 502
    resp.headers["Cache-Control"] = "private, max-age=86400"
    return resp


@bp.post("/api/rete/copia")
def rete_copy():
    d = request.get_json(silent=True) or {}
    sid, r = str(d.get("id") or ""), str(d.get("r") or "")
    if not SONG_RE.match(sid):
        return jsonify(error="Brano non valido"), 400
    path = parse_via(r)
    if not path or not node(path[0]) or node(path[0])["state"] != "attivo":
        return jsonify(error="Percorso non valido"), 400
    title = str(d.get("title") or "Brano dalla rete")[:200]
    jid = uuid.uuid4().hex[:10]
    j = dict(url="", mode="audio", format="", quality="", playlist=False, folder="", sponsorblock=False, meta={}, fed={"id": sid, "r": r})
    with A.jlock:
        A.jobs[jid] = dict(j, id=jid, status="in coda", progress=0, title=title, created=time.time(), updated=time.time(), by=g.who["user"])
        A.jsave(jid)
    A.jq.put((jid, j))
    return jsonify(A.jobs[jid]), 201


# ------------------------------------------------------------------ abbonamenti: playlist pubbliche dei server collegati
# Chi è collegato vede le playlist *pubbliche* di questo server (le private restano private) con i soli brani offerti
# nel catalogo. Abbonandosi, l'utente ha una sua playlist locale: i brani che mancano si copiano (run_copy) e la
# riconciliazione delle importazioni (importa.py) la tiene uguale a quella remota, ricontrollata ogni 10 minuti.
SUB_S = 600


# ─── PERCHÉ un consenso a parte ───
# «Pubblica» in Navidrome vuol dire visibile agli utenti di questo server; fino alla 0.32 bastava anche per finire su
# tutti i server collegati. Ora va ai server collegati solo una playlist pubblica che il proprietario ha offerto. Le
# pubbliche che c'erano restano offerte (altrimenti gli abbonamenti già fatti dagli altri server si rompevano) e i
# proprietari ricevono un avviso che dice come toglierle.
def offerte():
    v = setting("offerte")
    if v is not None:
        return set(json.loads(v))
    pls = (nd_get("getPlaylists").get("playlists") or {}).get("playlist") or []
    ids = [p["id"] for p in pls if p.get("public")]
    set_setting("offerte", json.dumps(ids))
    for p in pls:
        if p.get("public") and p.get("owner"):
            A.notifiche.notifica(p["owner"], "sistema", f"«{p.get('name') or 'Playlist'}» resta offerta ai server collegati",
                                 "Le playlist pubbliche ora vanno agli altri server solo se lo scegli: puoi toglierla dal menu ⋯ della playlist",
                                 "#/playlist/" + p["id"], only_once="offerta:" + p["id"])
    return set(ids)


@bp.get("/fed/v1/playlist")
def fed_playlists():
    pls = (nd_get("getPlaylists").get("playlists") or {}).get("playlist") or []
    ok = offerte()
    # pubblica in Navidrome vuol dire per gli utenti di questo server: agli altri server niente nome utente del proprietario
    return jsonify(playlists=[{"id": p["id"], "name": p.get("name") or "Playlist", "songs": p.get("songCount") or 0,
                               "comment": (p.get("comment") or "")[:300]} for p in pls if p.get("public") and p["id"] in ok])


@bp.get("/api/rete/offerte")
def rete_offerte():
    return jsonify(sorted(offerte()))


@bp.post("/api/rete/offerta")
def rete_offerta():
    d = request.get_json(silent=True) or {}
    pid = str(d.get("pid") or "")
    if not A.ID_RE.match(pid):
        return jsonify(error="Playlist non valida"), 400
    try:
        pl = nd_get("getPlaylist", id=pid)["playlist"]
    except FedError:
        return jsonify(error="Playlist non trovata"), 404
    if not g.who["admin"] and (pl.get("owner") or "").lower() != (g.who.get("user") or "").lower():
        return jsonify(error="Solo chi ha creato la playlist può offrirla ai server collegati"), 403
    if d.get("on") and not pl.get("public"):
        return jsonify(error="Prima rendi pubblica la playlist"), 400
    ok = offerte()
    (ok.add if d.get("on") else ok.discard)(pid)
    set_setting("offerte", json.dumps(sorted(ok)))
    return jsonify(ok=True, on=pid in ok)


@bp.get("/fed/v1/playlist/<pid>")
def fed_playlist(pid):
    if not A.ID_RE.match(pid):
        abort(400)
    try:
        pl = nd_get("getPlaylist", id=pid)["playlist"]
    except FedError:
        return jsonify(error="Playlist non trovata"), 404
    if not pl.get("public") or pid not in offerte():
        return jsonify(error="Playlist non trovata"), 404
    entries = pl.get("entry") or []
    ids = [e["id"] for e in entries]
    offered = {r["id"] for i in range(0, len(ids), 400)
               for r in db.all_(f"SELECT id FROM fed_mine WHERE gone = 0 AND id IN ({','.join('?' * len(ids[i:i + 400]))})", *ids[i:i + 400])}
    return jsonify(id=pid, name=pl.get("name"), songs=[song_row(e) for e in entries if e["id"] in offered])


def sub_sync(sub):
    """Un abbonamento: elenco della playlist remota → elenco dell'importazione locale, copia dei brani che mancano."""
    n = node(sub["node"])
    try:
        if not n or n["state"] != "attivo" or n.get("dir") == "offro":
            raise FedError("Il server collegato non è attivo")
        j = fed_json(n, "GET", f"/fed/v1/playlist/{sub['rid']}", timeout=(5, 60))
        songs = [s for s in j.get("songs") or [] if isinstance(s, dict) and SONG_RE.match(str(s.get("id", "")))]
        items = [{"title": s.get("title") or "", "artists": [s.get("artist") or ""], "album": s.get("album") or "", "duration": s.get("duration"),
                  "isrc": "", "track": s.get("track"), "fed": s["id"]} for s in songs]
        now = time.time()
        db.run("INSERT INTO imports (pid, owner, name, items, created, updated) VALUES (?, ?, ?, ?, ?, ?) "
               "ON CONFLICT(pid) DO UPDATE SET items = excluded.items, updated = excluded.updated", sub["pid"], sub["owner"], sub["name"], json.dumps(items), now, now)
        L = A.importa.lib()
        with A.jlock:
            queued = {(x["fed"]["r"], x["fed"]["id"]) for x in A.jobs.values() if x.get("fed")
                      and (x["status"] != "errore" or now - (x.get("finished") or now) < 86400)}  # un errore si riprova dopo un giorno
        todo = [it for it in items if not L.match(it) and (n["id"], it["fed"]) not in queued][:300]
        for it in todo:
            jid = uuid.uuid4().hex[:10]
            jj = dict(url="", mode="audio", format="", quality="", playlist=False, folder="", sponsorblock=False, meta={}, fed={"id": it["fed"], "r": n["id"]})
            with A.jlock:
                A.jobs[jid] = dict(jj, id=jid, status="in coda", progress=0, title=f"{it['artists'][0]} - {it['title']}", created=now, updated=now,
                                   by=sub["owner"], batch=f"sub:{sub['pid']}:{int(now)}", label=f"Abbonamento: {sub['name']}")
                A.jsave(jid)
            A.jq.put((jid, jj))
        db.run("UPDATE fed_subs SET last = ?, error = NULL WHERE pid = ?", now, sub["pid"])
        A.importa.stato_di(db.one("SELECT * FROM imports WHERE pid = ?", sub["pid"]), L)  # la playlist si riempie subito con ciò che c'è già
        return len(todo)
    except FedError as e:
        db.run("UPDATE fed_subs SET last = ?, error = ? WHERE pid = ?", time.time(), str(e)[:200], sub["pid"])
        return 0


@bp.get("/api/rete/playlist")
def rete_playlists():
    n = node(request.args.get("node") or "")
    if not n or n["state"] != "attivo":
        return jsonify(error="Server non collegato"), 404
    try:
        j = fed_json(n, "GET", "/fed/v1/playlist", timeout=(5, 30))
    except FedError as e:
        return jsonify(error=str(e)), e.status if 400 <= e.status < 600 else 502
    subs = {r["rid"]: r["pid"] for r in db.all_("SELECT rid, pid FROM fed_subs WHERE node = ? AND owner = ?", n["id"], g.who.get("user") or "")}
    return jsonify(node=node_info(n), playlists=[dict(p, sub=subs.get(p.get("id"))) for p in j.get("playlists") or [] if isinstance(p, dict)])


@bp.post("/api/rete/abbonati")
def rete_subscribe():
    d, u = request.get_json(silent=True) or {}, g.who.get("user")
    if not u or not g.who["download"]:
        return jsonify(error="Gli abbonamenti copiano i brani qui: serve il permesso di download."), 403
    if not g.who["admin"] and not g.who["perm"].get("playlist", True):
        return jsonify(error="Creare e modificare playlist non è abilitato per il tuo utente."), 403
    n, rid, pid = node(str(d.get("node") or "")), str(d.get("id") or ""), str(d.get("pid") or "")
    if not n or n["state"] != "attivo" or not A.ID_RE.match(rid) or not A.ID_RE.match(pid):
        return jsonify(error="Richiesta non valida"), 400
    if A.importa.owner_of(pid) != u:
        return jsonify(error="La playlist locale non è tua"), 403
    db.run("INSERT OR REPLACE INTO fed_subs (pid, node, rid, owner, name, created) VALUES (?, ?, ?, ?, ?, ?)",
           pid, n["id"], rid, u, str(d.get("name") or "Playlist")[:120], time.time())
    pool.submit(sub_sync, dict(db.one("SELECT * FROM fed_subs WHERE pid = ?", pid)))
    return jsonify(ok=True, pid=pid), 201


@bp.delete("/api/rete/abbonati/<pid>")
def rete_unsubscribe(pid):
    # la playlist locale e i brani copiati restano: smette solo di seguire quella remota
    gone = db.conn().execute("DELETE FROM fed_subs WHERE pid = ? AND (owner = ? OR ?)", (pid, g.who.get("user") or "", int(g.who["admin"]))).rowcount
    if gone:  # solo l'elenco dell'abbonamento appena tolto, mai un'importazione da file
        db.run("DELETE FROM imports WHERE pid = ?", pid)
    return jsonify(ok=True) if gone else (jsonify(error="Abbonamento non trovato"), 404)


def ensure_library():
    """La libreria Navidrome delle copie (federati/), creata la prima volta e data a tutti gli utenti."""
    libs = nd_native("GET", "/api/library") or []
    lib = next((x for x in libs if str(x.get("path", "")).rstrip("/") == FED_ND_PATH.rstrip("/")), None)
    if lib:
        return lib["id"]
    lib = nd_native("POST", "/api/library", json={"name": "Dalla rete", "path": FED_ND_PATH, "defaultNewUsers": True})
    for u in nd_native("GET", "/api/user") or []:
        if u.get("isAdmin"):
            continue  # gli amministratori vedono tutte le librerie
        have = [int(x["id"]) for x in u.get("libraries") or []]
        nd_native("PUT", f"/api/user/{u['id']}/library", json={"libraryIds": sorted(set(have + [int(lib["id"])]))})
    return lib["id"]


def run_copy(jid, j):
    """Copia nella mia libreria un brano di un nodo collegato (anche a catena): prima .part, poi verifica e rinomina."""
    sid, path = j["fed"]["id"], parse_via(j["fed"]["r"])
    first = node(path[0])
    if not first:
        return A.jupdate(jid, status="errore", error="Il server collegato non c'è più", finished=time.time())
    A.jupdate(jid, status="in corso")
    try:
        info = fed_json(first, "GET", f"/fed/v1/info/{sid}", params={"via": ",".join(path[1:])}, timeout=60)
        seg = A.clean_segment
        n = int(info.get("track") or 0)
        name = f"{n:02d} - {info.get('title')}" if n else str(info.get("title") or sid)
        folder = os.path.join(FED_DIR, seg(info.get("nome"), "Server"), seg(info.get("albumArtist") or info.get("artist"), "Artista sconosciuto"),
                              seg(info.get("album"), "Senza album"))
        dest = os.path.join(folder, seg(name, sid) + "." + re.sub(r"[^a-z0-9]", "", str(info.get("suffix") or "mp3").lower())[:5])
        os.makedirs(folder, exist_ok=True)
        size, sha = int(info.get("size") or 0), info.get("sha256")
        if os.path.exists(dest) and os.path.getsize(dest) == size and (not sha or A.file_hash(dest) == sha):
            return A.jupdate(jid, status="completato", progress=100, finished=time.time(), path=os.path.relpath(dest, FED_DIR), note="già presente")
        r, _ = fed_req(first, "GET", f"/fed/v1/file/{sid}", params={"via": ",".join(path[1:]), "format": "raw"}, stream=True, timeout=(10, 600))
        if r.status_code != 200:
            raise FedError(f"Il file non arriva (errore {r.status_code})")
        tmp, h, got = dest + ".armony-part", hashlib.sha256(), 0
        with open(tmp, "wb") as f:
            for b in r.iter_content(256 * 1024):
                f.write(b)
                h.update(b)
                got += len(b)
                if size:
                    A.jupdate(jid, progress=round(got * 100 / size, 1))
        if (size and got != size) or (sha and h.hexdigest() != sha):
            os.remove(tmp)
            raise FedError("Il file arrivato non corrisponde (dimensione o impronta diverse): riprova")
        os.replace(tmp, dest)
        try:
            ensure_library()
            nd_get("startScan")
        except Exception as e:  # noqa: BLE001 — il file c'è; Navidrome lo troverà alla prossima scansione
            diagnosi.avviso("federazione", f"libreria Navidrome: {e}")
        A.jupdate(jid, status="completato", progress=100, finished=time.time(), path=os.path.relpath(dest, FED_DIR),
                  note=("verificato sha256" if sha else "verificata la dimensione"))
    except (FedError, OSError, requests.RequestException) as e:
        A.jupdate(jid, status="errore", error=str(e)[:300], finished=time.time())


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)


def start():
    load_identity()  # dopo db.migrate(): la cartella dei dati esiste
    for n in nodes():
        if setting("canale:" + n["id"]) == "1":
            chan_want[n["id"]] = True
            chan_start(n["id"])
    threading.Thread(target=loop, daemon=True).start()
