"""
Armony - trasferimento di un server a un altro (docs/TRASFERIMENTO.md).

  Sul nuovo, che riceve:
  POST /api/trasferimento/ricevi      un codice ART1 usa e getta (2 ore)
  POST /api/trasferimento/conferma    l'amministratore ha confrontato il codice di sicurezza
  POST /trasf/v1/ciao                 pubblica, con il segreto del codice: il vecchio si presenta con la sua chiave usa e getta.
                                      Dalla rete di casa anche senza segreto (il codice di sicurezza va confermato comunque)
  GET  /trasf/v1/pronto               solo dalla rete di casa: se questo server aspetta di ricevere (per l'elenco del vecchio)
  GET  /trasf/v1/stato                \
  GET/POST /trasf/v1/file             |  firmate con la chiave usa e getta del vecchio: conferma, spazio libero, file a
  POST /trasf/v1/manifesto            |  pezzi (si riprende da dove si era fermato), elenco dei file, applicazione
  POST /trasf/v1/applica              |  (la fa il servizio di sistema: deploy/armony-trasferimento.sh) e, senza brani,
  POST /trasf/v1/libreria             /  un invito che aggancia il vecchio come libreria
  Sul vecchio, che invia:
  GET  /api/trasferimento/vicini      i server Armony della rete di casa (multicast) e quali aspettano di ricevere
  POST /api/trasferimento/aggancia    {code} oppure {addr}: si presenta al nuovo; risponde il codice di sicurezza
  POST /api/trasferimento/avvia       {brani, video}: fotografia, invio, congelamento, applicazione, passaggio di testimone
  POST /api/trasferimento/brani       trasferito senza brani: li manda adesso
  POST /api/trasferimento/concludi    il vecchio smette di rispondere al posto del nuovo e cancella l'identità
  Tutti e due:
  GET  /api/trasferimento             stato e avanzamento · POST /api/trasferimento/annulla

─── PERCHÉ il vecchio spinge e il nuovo riceve ───
Il nuovo è il futuro centro, quindi ha un indirizzo; il vecchio può essere dietro NAT. Le richieste sono firmate come
quelle federate (metodo, percorso, data, hash del corpo) con una chiave Ed25519 usa e getta, confrontata a voce con il
codice di sicurezza. I database li sostituisce il servizio di sistema: dentro il container il DB di Navidrome è in sola
lettura, e Navidrome va fermato.
"""
import base64
import hashlib
import json
import os
import secrets
import shutil
import socket
import sqlite3
import threading
import time
import urllib.parse

import requests
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from flask import Blueprint, g, jsonify, request

import db

bp = Blueprint("trasferimento", __name__)
A = None
F = None                 # federazione
CODE_H = 2               # ore di validità del codice
PEZZO = 4 * 1024 * 1024  # un pezzo di file per richiesta
GELO_SKIP = ("/api/trasferimento", "/api/login", "/api/live", "/api/log", "/api/me", "/api/notifiche/lette")
ND_SCRIVE = ("createPlaylist", "updatePlaylist", "deletePlaylist", "star", "unstar", "setRating", "createShare", "deleteShare",
             "updateShare", "savePlayQueue", "createUser", "updateUser", "deleteUser", "changePassword", "createInternetRadioStation")
stato_vivo = {"msg": "", "fatto": 0, "tot": 0, "file": "", "vel": 0.0}  # avanzamento dell'invio, solo in memoria
visti = {}               # (tipo, chi) -> ultima volta: chi chiama ancora il vecchio dopo il trasferimento
lock = threading.Lock()
cache = {}               # lo stato, letto una volta: la guardia lo guarda a ogni richiesta del server


def b64e(b):
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def b64d(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def st():
    if "d" not in cache:
        r = db.one("SELECT value FROM settings WHERE key = 'trasf'")
        cache["d"] = json.loads(r["value"]) if r else {}
    return dict(cache["d"])


def st_set(d):
    cache["d"] = dict(d)
    if d:
        db.run("INSERT INTO settings (key, value) VALUES ('trasf', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", json.dumps(d))
    else:
        db.run("DELETE FROM settings WHERE key = 'trasf'")


def st_up(**kw):
    with lock:
        d = st()
        d.update(kw)
        st_set(d)
        return d


def base_dir():
    return os.path.join(A.UPDATE_DIR, "trasferimento")


def chiavi():
    k = Ed25519PrivateKey.generate()
    raw = k.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())
    return b64e(raw), b64e(k.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))


def canon(method, full, date, body):
    return "\n".join(["armony-trasf-1", method.upper(), full, str(date), hashlib.sha256(body or b"").hexdigest()]).encode()


def libero():
    try:
        return shutil.disk_usage(A.MUSIC_DIR).free
    except OSError:
        return 0


def ip_casa():
    """L'indirizzo di questo server nella rete di casa (con la rete host è quello del computer): si mostra sul nuovo, per
    scriverlo sul vecchio quando l'elenco non lo trova (multicast spento o reti diverse)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as so:
            so.connect(("10.255.255.255", 1))  # nessun pacchetto parte: serve solo a scegliere la scheda di rete
            return f"http://{so.getsockname()[0]}:{A.PORT}"
    except OSError:
        return None


def visto(tipo, chi):
    if chi:
        visti[(tipo, chi)] = time.time()


# ------------------------------------------------------------------ congelamento: per un minuto niente modifiche
def gelato():
    d = st()
    return d.get("ruolo") == "invia" and d.get("stage") in ("congelato", "applicazione", "trasferito", "concluso")


def guardia():
    """before_request dell'app: nel congelamento e dopo il trasferimento il vecchio non accetta modifiche (andrebbero
    perse). Ascoltare continua a funzionare."""
    p = request.path
    if request.method in ("GET", "HEAD", "OPTIONS") and not p.startswith("/rest/"):
        if p.startswith("/api/") and st().get("stage") in ("trasferito", "concluso"):
            visto("dispositivo", request.headers.get("X-Token", "")[:12] or request.remote_addr)
        return None
    if not gelato():
        return None
    if p.startswith("/rest/"):
        m = p.rsplit("/", 1)[-1].removesuffix(".view")
        if m not in ND_SCRIVE:
            return None
    elif not p.startswith("/api/") or p.startswith(GELO_SKIP):
        return None
    d = st()
    msg = (f"Questo server si è spostato su {d.get('url')}: le modifiche si fanno lì" if d.get("stage") in ("trasferito", "concluso")
           else "Trasferimento del server in corso: per un minuto le modifiche sono ferme")
    return jsonify(error=msg), 503


# ------------------------------------------------------------------ sul nuovo: riceve
@bp.post("/api/trasferimento/ricevi")
def ricevi():
    d = st()
    if d.get("ruolo") == "invia" and d.get("stage") not in ("annullato", None):
        return jsonify(error="Questo server sta già trasferendo sé stesso"), 409
    url = A.public_url() or F.my_url()
    if not url:
        return jsonify(error="Serve l'indirizzo con cui il vecchio server raggiunge questo: impostalo in Impostazioni → Indirizzo pubblico"), 400
    pieno = db.one("SELECT (SELECT count(*) FROM fed_nodes) + (SELECT count(*) FROM collab) AS n")["n"]
    secret, (priv, pub) = secrets.token_urlsafe(24), chiavi()
    exp = time.time() + CODE_H * 3600
    st_set({"ruolo": "ricevi", "stage": "aperto", "hash": hashlib.sha256(secret.encode()).hexdigest(), "priv": priv, "pub": pub,
            "expires": exp, "url": url, "confermato": False})
    shutil.rmtree(base_dir(), ignore_errors=True)
    code = "ART1" + b64e(json.dumps({"u": url, "k": pub, "s": secret, "n": A.NAME}, separators=(",", ":")).encode())
    return jsonify(code=code, expires=exp, avviso="Questo server ha già collegamenti o collaboratori: verranno sostituiti da quelli del vecchio" if pieno else None)


@bp.post("/api/trasferimento/conferma")
def conferma():
    d = st()
    if d.get("ruolo") != "ricevi" or d.get("stage") != "agganciato":
        return jsonify(error="Nessun server agganciato da confermare"), 409
    st_up(confermato=True)
    return jsonify(ok=True)


@bp.post("/trasf/v1/ciao")
def ciao():
    d, j = st(), request.get_json(silent=True) or {}
    if d.get("ruolo") != "ricevi" or d.get("stage") != "aperto" or time.time() > d.get("expires", 0):
        return jsonify(error="Codice scaduto o già usato: creane uno nuovo sul server che riceve"), 403
    if j.get("s") is None and not A.dispositivi.is_local():
        return jsonify(error="Senza codice solo dalla rete di casa: usa il codice ART1"), 403
    if j.get("s") is not None and not secrets.compare_digest(hashlib.sha256(str(j.get("s")).encode()).hexdigest(), d["hash"]):
        return jsonify(error="Codice non valido"), 403
    pub = str(j.get("pub") or "")
    try:
        Ed25519PublicKey.from_public_bytes(b64d(pub))
    except (ValueError, TypeError):
        return jsonify(error="Chiave non valida"), 400
    safety = F.safety(d["pub"], pub)
    st_up(stage="agganciato", peer_pub=pub, peer_name=str(j.get("name") or "Server")[:60], peer_app=str(j.get("app") or "")[:20], safety=safety)
    return jsonify(safety=safety, name=A.NAME, app=A.VERSION, libero=libero(), k=d["pub"], u=d["url"])


@bp.get("/trasf/v1/pronto")
def pronto():
    if not A.dispositivi.is_local():
        return jsonify(error="Solo dalla rete di casa"), 403
    d = st()
    return jsonify(aperto=d.get("ruolo") == "ricevi" and d.get("stage") == "aperto" and time.time() < d.get("expires", 0), name=A.NAME, app=A.VERSION)


def firmata(stages):
    """La richiesta deve venire dal vecchio agganciato: firma della sua chiave usa e getta, al più 5 minuti."""
    d = st()
    if d.get("ruolo") != "ricevi" or d.get("stage") not in stages or not d.get("peer_pub"):
        return None, (jsonify(error="Nessun trasferimento in corso"), 409)
    try:
        date = int(request.headers.get("X-Trasf-Date", "0"))
        full = request.path + ("?" + request.query_string.decode() if request.query_string else "")
        if abs(time.time() - date) > 300:
            raise ValueError("data")
        Ed25519PublicKey.from_public_bytes(b64d(d["peer_pub"])).verify(b64d(request.headers.get("X-Trasf-Sig", "")),
                                                                       canon(request.method, full, date, request.get_data(cache=True)))
    except (ValueError, InvalidSignature, TypeError):
        return None, (jsonify(error="Firma non valida"), 401)
    return d, None


@bp.get("/trasf/v1/stato")
def t_stato():
    d, err = firmata(("agganciato", "ricezione", "applicazione", "applicato"))
    if err:
        return err
    return jsonify(confermato=bool(d.get("confermato")), stage=d["stage"], libero=libero(), nome=A.NAME, app=A.VERSION,
                   servizio=servizio(), ora=time.time())


def servizio():
    """Chi applicherà i dati: il servizio di systemd (install-updater.sh) o il guardiano (container, senza systemd)."""
    g_ = os.path.join(A.UPDATE_DIR, "guardiano.json")
    if os.path.exists(g_) and time.time() - os.path.getmtime(g_) < 60:
        return "guardiano"
    return "systemd" if os.path.exists(os.path.join(A.UPDATE_DIR, "installed")) else None


def dest_path(dest, nome):
    roots = {"base": base_dir(), "musica": A.MUSIC_DIR, "federati": F.FED_DIR, "video": A.VIDEO_DIR}
    root = roots.get(dest)
    nome = str(nome or "").replace("\\", "/")
    if not root or not nome or nome.startswith("/") or any(p in ("", ".", "..") for p in nome.split("/")):
        return None
    return os.path.join(root, nome)


def tmp_of(path):
    head, tail = os.path.split(path)
    return os.path.join(head, "." + tail + ".trasf")


@bp.get("/trasf/v1/file")
def t_file_get():
    d, err = firmata(("ricezione", "applicato"))
    if err:
        return err
    p = dest_path(request.args.get("dest"), request.args.get("nome"))
    if not p:
        return jsonify(error="Nome non valido"), 400
    if os.path.exists(p):
        return jsonify(size=os.path.getsize(p), fatto=True)
    t = tmp_of(p)
    return jsonify(size=os.path.getsize(t) if os.path.exists(t) else 0, fatto=False)


@bp.post("/trasf/v1/file")
def t_file_post():
    d, err = firmata(("ricezione", "applicato"))
    if err:
        return err
    p = dest_path(request.args.get("dest"), request.args.get("nome"))
    try:
        da, tot = int(request.args.get("da", "0")), int(request.args.get("tot", "0"))
    except ValueError:
        return jsonify(error="Posizione non valida"), 400
    if not p:
        return jsonify(error="Nome non valido"), 400
    t = tmp_of(p)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    if da == 0 and os.path.exists(t):
        os.remove(t)  # si ricomincia da capo (file cambiato sul vecchio)
    cur = os.path.getsize(t) if os.path.exists(t) else 0
    if da != cur:
        return jsonify(error="Posizione sbagliata", size=cur), 409
    body = request.get_data(cache=False)
    with open(t, "ab") as f:
        f.write(body)
    cur += len(body)
    if cur >= tot:
        os.replace(t, p)  # il nome vero solo a file completo: Navidrome non legge file a metà
    return jsonify(size=cur, fatto=cur >= tot)


@bp.post("/trasf/v1/manifesto")
def t_manifesto():
    d, err = firmata(("agganciato", "ricezione"))
    if err:
        return err
    if not d.get("confermato"):
        return jsonify(error="Sul server che riceve non hanno ancora confermato il codice di sicurezza"), 409
    m = request.get_json(silent=True) or {}
    os.makedirs(base_dir(), exist_ok=True)
    with open(os.path.join(base_dir(), "manifesto.json"), "w") as f:
        json.dump(m, f)
    st_up(stage="ricezione")
    return jsonify(ok=True)


def sha_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


@bp.post("/trasf/v1/applica")
def t_applica():
    d, err = firmata(("ricezione",))
    if err:
        return err
    try:
        with open(os.path.join(base_dir(), "manifesto.json")) as f:
            m = json.load(f)
    except (OSError, ValueError):
        return jsonify(error="Manca l'elenco dei file"), 409
    for x in m.get("base") or []:
        p = os.path.join(base_dir(), x["nome"])
        if not os.path.exists(p) or sha_file(p) != x["sha"]:
            return jsonify(error=f"{x['nome']} non è arrivato intero: rimandalo"), 409
    # le righe del .env che il servizio di sistema scrive al posto di quelle del nuovo
    env = {"ARMONY_NAME": m.get("nome") or A.NAME}
    if (m.get("admin") or {}).get("user"):
        env.update(NAVIDROME_ADMIN_USER=m["admin"]["user"], NAVIDROME_ADMIN_PASS=m["admin"]["pass"])
    with open(os.path.join(base_dir(), "env.json"), "w") as f:
        json.dump(env, f)
    os.chmod(os.path.join(base_dir(), "env.json"), 0o600)
    st_up(stage="applicazione")
    with open(os.path.join(base_dir(), "applica"), "w") as f:
        f.write(str(time.time()))
    with open(os.path.join(A.UPDATE_DIR, "request"), "w") as f:
        f.write("trasferimento")
    return jsonify(ok=True)


@bp.post("/trasf/v1/libreria")
def t_libreria():
    """Dopo l'applicazione (il DB è quello del vecchio, con la sua chiave usa e getta): un invito che si accetta da solo
    per agganciare il vecchio come libreria. Lui offre, il nuovo prende: dal nuovo il verso è «ricevo»."""
    d, err = firmata(("applicato",))
    if err:
        return err
    return jsonify(code=F.invito_auto("ricevo"))


def dopo_applicazione():
    """All'avvio, se il servizio di sistema ha appena messo qui i dati del vecchio: questo server ora è lui, all'indirizzo
    nuovo. Si cambiano gli indirizzi, si annuncia ai collegati e si tiene la chiave del vecchio per i brani dopo."""
    fatto = os.path.join(base_dir(), "applicato.json")
    if not os.path.exists(fatto):
        return
    try:
        with open(os.path.join(base_dir(), "manifesto.json")) as f:
            m = json.load(f)
        url = m["url_nuovo"]
        db.run("INSERT INTO settings (key, value) VALUES ('public_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", url)
        F.set_setting("url", url)
        db.run("DELETE FROM settings WHERE key = 'fed_spostato'")
        old = st()  # è lo stato del vecchio (chi inviava): la sua chiave usa e getta resta valida per mandare i brani dopo
        st_set({"ruolo": "ricevi", "stage": "applicato", "peer_pub": old.get("my_pub"), "peer_name": m.get("nome"), "confermato": True,
                "url": url, "brani": bool(m.get("brani")), "at": time.time()})
        os.replace(fatto, os.path.join(base_dir(), "applicato-visto.json"))
    except (OSError, ValueError, KeyError) as e:
        A.diagnosi.log("errore", "trasferimento", f"dopo l'applicazione: {e}")
        return

    def annuncia():
        time.sleep(10)
        for n in F.nodes():
            try:
                F.fed_json(n, "POST", "/fed/v1/indirizzo", body={"url": url}, timeout=(5, 20))
            except F.FedError:
                pass  # una foglia non si raggiunge: lo saprà dal vecchio («spostato»)
    threading.Thread(target=annuncia, daemon=True).start()
    A.diagnosi.log("info", "trasferimento", f"questo server è ora {m.get('nome')}, all'indirizzo {url}")


# ------------------------------------------------------------------ sul vecchio: invia
def treq(method, path, params=None, body=None, raw=None, timeout=(10, 120)):
    d = st()
    q = ("?" + urllib.parse.urlencode(params)) if params else ""
    data = raw if raw is not None else json.dumps(body).encode() if body is not None else b""
    date = int(time.time())
    key = Ed25519PrivateKey.from_private_bytes(b64d(d["my_priv"]))
    sig = b64e(key.sign(canon(method, path + q, date, data)))
    h = {"X-Trasf-Date": str(date), "X-Trasf-Sig": sig}
    if body is not None:
        h["Content-Type"] = "application/json"
    return A.http.request(method, (d.get("via") or d["url"]) + path + q, data=data or None, headers=h, timeout=timeout)


def tjson(method, path, **kw):
    r = treq(method, path, **kw)
    try:
        j = r.json()
    except ValueError:
        j = {}
    if not r.ok:
        raise RuntimeError(j.get("error") or f"il server nuovo ha risposto {r.status_code}")
    return j


@bp.post("/api/trasferimento/aggancia")
def aggancia():
    """Con il codice ART1, oppure con l'indirizzo del nuovo nella rete di casa (scelto dall'elenco o scritto a mano):
    allora niente segreto, la chiave del nuovo arriva nella risposta e a garantire che sia lui resta il codice di
    sicurezza, che il nuovo deve confermare prima dell'avvio. La copia passa dall'indirizzo usato qui (via); agli altri
    server si annuncia quello pubblico del nuovo (url)."""
    j0 = request.get_json(silent=True) or {}
    code, addr = str(j0.get("code") or "").strip(), str(j0.get("addr") or "").strip()
    inv = None
    if code:
        try:
            if not code.startswith("ART1"):
                raise ValueError
            inv = json.loads(b64d(code[4:]))
            via = F.clean_url(inv["u"])
        except (ValueError, KeyError, TypeError):
            return jsonify(error="Codice non valido: è quello che mostra «Ricevi un server» sul nuovo (inizia con ART1)"), 400
    else:
        if "://" not in addr:
            addr = "http://" + addr
        u = urllib.parse.urlsplit(addr)
        if not u.hostname:
            return jsonify(error="Scrivi l'indirizzo del server nuovo, per esempio 192.168.1.50:8080"), 400
        via = f"{u.scheme}://{u.hostname}:{u.port or (8080 if u.scheme == 'http' else 443)}"
    priv, pub = chiavi()
    try:
        r = A.http.post(via + "/trasf/v1/ciao", json={"s": inv["s"] if inv else None, "pub": pub, "name": A.NAME, "app": A.VERSION}, timeout=15)
        j = r.json()
    except (requests.RequestException, ValueError):
        return jsonify(error=f"Non riesco a raggiungere {via}: il nuovo server deve essere acceso e raggiungibile da qui"), 502
    if not r.ok:
        return jsonify(error=j.get("error") or "Il nuovo server ha rifiutato"), r.status_code
    peer = inv["k"] if inv else str(j.get("k") or "")
    if F.safety(peer, pub) != j.get("safety"):
        return jsonify(error="Il codice di sicurezza non torna: qualcuno si è messo in mezzo"), 409
    url = via if inv else F.clean_url(j.get("u") or via)
    st_set({"ruolo": "invia", "stage": "agganciato", "url": url, "via": via, "peer_pub": peer, "my_priv": priv, "my_pub": pub,
            "safety": j["safety"], "nome_nuovo": j.get("name"), "app_nuovo": j.get("app"), "libero": j.get("libero"), "at": time.time()})
    return jsonify(stato())


@bp.get("/api/trasferimento/vicini")
def vicini():
    peers = [dict(name=p["name"], url=p["url"]) for p in list(A.lan_peers.values()) if time.time() - p["seen"] < 20]

    def chiedi(p):
        try:
            j = A.http.get(p["url"] + "/trasf/v1/pronto", timeout=3).json()
            p.update(aperto=bool(j.get("aperto")), app=j.get("app"))
        except (requests.RequestException, ValueError):
            p.update(aperto=False, app=None)
    th = [threading.Thread(target=chiedi, args=(p,)) for p in peers]
    [t.start() for t in th]
    [t.join() for t in th]
    return jsonify(multicast=A.MULTICAST, peers=sorted(peers, key=lambda p: (not p["aperto"], p["name"])))


def elenco(dest, root):
    out = []
    for cur, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if not x.startswith(".")]
        for fn in files:
            if fn.startswith(".") or fn.endswith((".part", ".ytdl", ".trasf")):
                continue
            p = os.path.join(cur, fn)
            try:
                s = os.stat(p)
            except OSError:
                continue
            out.append({"dest": dest, "nome": os.path.relpath(p, root), "size": s.st_size, "mtime": int(s.st_mtime), "path": p})
    return out


def misura(brani, video):
    fl = (elenco("musica", A.MUSIC_DIR) + elenco("federati", F.FED_DIR) if brani else []) + (elenco("video", A.VIDEO_DIR) if video else [])
    return fl, sum(x["size"] for x in fl)


def fotografia():
    """Copie coerenti dei database e dei file piccoli, in una cartella d'appoggio del vecchio."""
    snap = os.path.join(os.path.dirname(db.PATH), "trasf-snap")
    shutil.rmtree(snap, ignore_errors=True)
    os.makedirs(os.path.join(snap, "avatar"))
    for src, name in ((db.PATH, "armony.db"), (A.NAVIDROME_DB, "navidrome.db")):
        s = sqlite3.connect(f"file:{src}?mode=ro", uri=True, timeout=30)
        d = sqlite3.connect(os.path.join(snap, name))
        s.backup(d)
        d.close()
        s.close()
    data = os.path.dirname(db.PATH)
    shutil.copy2(os.path.join(data, "identita.key"), os.path.join(snap, "identita.key"))
    av = os.path.join(data, "avatar")
    if os.path.isdir(av):
        for fn in os.listdir(av):
            if os.path.isfile(os.path.join(av, fn)):
                shutil.copy2(os.path.join(av, fn), os.path.join(snap, "avatar", fn))
    out = []
    for cur, _, files in os.walk(snap):
        for fn in files:
            p = os.path.join(cur, fn)
            out.append({"dest": "base", "nome": os.path.relpath(p, snap), "size": os.path.getsize(p), "path": p, "sha": sha_file(p)})
    return out


def manda(x):
    """Un file al nuovo, a pezzi, ripartendo da quello che ha già."""
    have = tjson("GET", "/trasf/v1/file", params={"dest": x["dest"], "nome": x["nome"]})
    if have.get("fatto") and have.get("size") == x["size"]:
        stato_vivo["fatto"] += x["size"]
        return
    pos = have.get("size", 0) if not have.get("fatto") and have.get("size", 0) <= x["size"] else 0
    stato_vivo["fatto"] += pos
    with open(x["path"], "rb") as f:
        f.seek(pos)
        while True:
            chunk = f.read(PEZZO)
            if not chunk and pos:
                break
            t0 = time.time()
            r = treq("POST", "/trasf/v1/file", params={"dest": x["dest"], "nome": x["nome"], "da": pos, "tot": x["size"]}, raw=chunk,
                     timeout=(10, 300))
            if r.status_code == 409:  # il nuovo ha un'altra posizione: si riparte da lì
                pos = r.json().get("size", 0)
                f.seek(pos)
                continue
            if not r.ok:
                raise RuntimeError(r.json().get("error") or f"invio di {x['nome']} non riuscito")
            pos += len(chunk)
            stato_vivo["fatto"] += len(chunk)
            stato_vivo["vel"] = len(chunk) / max(.001, time.time() - t0)
            if r.json().get("fatto") or not chunk:
                break


def esegui(brani, video, solo_brani=False):
    try:
        if not solo_brani:
            st_up(stage="invio", brani=brani, video=video)
        stato_vivo.update(msg="Preparo l'elenco dei file", fatto=0, tot=0)
        fl, tot = misura(brani, video)
        base = [] if solo_brani else fotografia()
        stato_vivo["tot"] = tot  # la prima copia dei database non si manda: la vera parte nel congelamento
        man = lambda b: {"nome": A.NAME, "url_nuovo": st()["url"], "url_vecchio": A.public_url(), "pub": F.PUB, "brani": brani,  # noqa: E731
                         "admin": {k: v for k, v in (A.nd_admin() or {}).items() if k in ("user", "pass")},
                         "base": [{"nome": x["nome"], "sha": x["sha"], "size": x["size"]} for x in b], "file": len(fl), "tot": tot}
        if not solo_brani:
            tjson("POST", "/trasf/v1/manifesto", body=man(base))
        for i, x in enumerate(fl):
            stato_vivo.update(msg=f"Brani: {i + 1} di {len(fl)}", file=x["nome"])
            manda(x)
        if solo_brani:
            st_up(stage="trasferito", brani=True)
            stato_vivo.update(msg="Brani spostati")
            return
        # congelamento: da qui niente modifiche; database rifatti e brani cambiati nel frattempo
        st_up(stage="congelato")
        stato_vivo.update(msg="Ultimo giro: le modifiche sono ferme per un minuto")
        time.sleep(2)  # le richieste già partite finiscono
        base = fotografia()
        prima = {(x["dest"], x["nome"]): (x["size"], x["mtime"]) for x in fl}
        nuovi = [x for x in misura(brani, video)[0] if prima.get((x["dest"], x["nome"])) != (x["size"], x["mtime"])]
        stato_vivo["tot"] += sum(x["size"] for x in base + nuovi)
        tjson("POST", "/trasf/v1/manifesto", body=man(base))
        for x in base + nuovi:
            stato_vivo.update(file=x["nome"])
            manda(x)
        stato_vivo.update(msg="Il nuovo server applica i dati e si riavvia")
        st_up(stage="applicazione")
        tjson("POST", "/trasf/v1/applica", body={})
        # il nuovo è pronto quando risponde con l'identità di questo server
        url = st().get("via") or st()["url"]
        for _ in range(60):
            time.sleep(5)
            try:
                if A.http.get(url + "/fed/hello", timeout=5).json().get("pub") == F.PUB:
                    break
            except (requests.RequestException, ValueError):
                pass
        else:
            raise RuntimeError("il nuovo server non è ripartito con i dati di questo: controlla lì (Stato del server, registro eventi)")
        passaggio(brani)
    except Exception as e:  # noqa: BLE001
        d = st()
        st_up(stage="errore" if d.get("stage") not in ("trasferito",) else d["stage"], errore=str(e)[:300])
        stato_vivo.update(msg=f"Interrotto: {e}"[:300])
        A.diagnosi.log("errore", "trasferimento", str(e)[:300])


def passaggio(brani):
    """Il nuovo ha l'identità: il vecchio gli passa il testimone. Indirizzo pubblico verso il nuovo (i dispositivi lo
    seguono con il Trasloco), «spostato» a chi cerca la vecchia identità, e senza brani diventa una libreria collegata."""
    d = st()
    url, old_id = d["url"], F.ME
    db.run("INSERT INTO settings (key, value) VALUES ('public_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", url)
    if brani:
        F.set_setting("spostato", json.dumps({"url": url, "id": old_id, "tutto": True}))
    else:
        # libreria collegata: identità nuova, collegamenti azzerati (erano della vecchia, ora li ha il nuovo), invito automatico
        code = tjson("POST", "/trasf/v1/libreria", body={})["code"]
        data = os.path.dirname(db.PATH)
        os.replace(os.path.join(data, "identita.key"), os.path.join(data, f"identita-trasferita-{int(time.time())}.key"))
        for t in ("fed_nodes", "fed_catalog", "fed_collab", "fed_subs", "fed_invites"):
            db.run(f"DELETE FROM {t}")
        db.run("DELETE FROM settings WHERE key LIKE 'fed_canale:%' OR key LIKE 'fed_sync:%' OR key LIKE 'fed_grant:%' OR key LIKE 'fed_epoca:%'")
        F.load_identity()
        F.set_setting("spostato", json.dumps({"url": url, "id": old_id, "tutto": False}))
        out, status = F.join_code(code)
        if status >= 400:
            A.diagnosi.log("errore", "trasferimento", f"aggancio come libreria: {out.get('error')}")
    st_up(stage="trasferito", brani=brani, at=time.time())
    stato_vivo.update(msg="Trasferito")
    A.diagnosi.log("info", "trasferimento", f"trasferito su {url}" + ("" if brani else ": questo server resta come libreria collegata"))


def verifica():
    """Prima di «Avvia»: tutto quello che farebbe fallire il trasferimento a metà, detto prima. L'ultima voce porta lo
    stato del nuovo (chi chiama lo toglie)."""
    d, out = st(), []
    t0 = time.time()
    try:
        s = tjson("GET", "/trasf/v1/stato", timeout=(5, 10))
    except (RuntimeError, requests.RequestException) as e:
        return [{"nome": "Il server nuovo risponde", "ok": False, "blocca": True, "msg": str(e)[:200], "stato": None}]
    rtt = time.time() - t0
    out.append({"nome": "Il server nuovo risponde", "ok": True, "msg": d.get("via") or d.get("url")})
    out.append({"nome": "Codice di sicurezza confermato sul nuovo", "ok": bool(s.get("confermato")), "blocca": True,
                "msg": "" if s.get("confermato") else "Sul nuovo premete «È uguale, conferma»"})
    same = s.get("app") == A.VERSION
    out.append({"nome": "Stessa versione di Armony", "ok": same, "blocca": True,
                "msg": f"{A.VERSION} su tutti e due" if same else f"questo {A.VERSION}, il nuovo {s.get('app')}: aggiorna quello più vecchio"})
    sv = s.get("servizio")
    out.append({"nome": "Sul nuovo c'è chi applica i dati", "ok": bool(sv), "blocca": True,
                "msg": {"systemd": "servizio di sistema", "guardiano": "guardiano (senza systemd)"}.get(sv,
                       "manca: sul nuovo lancia «sudo deploy/install-updater.sh» o attiva il guardiano (LEGGIMI, Manutenzione)")})
    skew = abs((s.get("ora") or 0) + rtt / 2 - time.time())
    out.append({"nome": "Stessa ora sui due server", "ok": skew < 120, "blocca": True,
                "msg": f"scarto di {int(skew)} s" + ("" if skew < 120 else ": le firme scadono dopo 5 minuti, sistema l'ora (NTP)")})
    https = str(d.get("via") or d.get("url") or "").startswith("https://")
    out.append({"nome": "Collegamento cifrato (HTTPS)", "ok": https, "blocca": False,
                "msg": "" if https else "senza HTTPS fallo solo dentro la rete di casa: passano anche le impronte delle password", "stato": s})
    return out


@bp.post("/api/trasferimento/avvia")
def avvia():
    d, j = st(), request.get_json(silent=True) or {}
    if d.get("ruolo") != "invia" or d.get("stage") not in ("agganciato", "errore"):
        return jsonify(error="Prima aggancia il server nuovo con il suo codice"), 409
    v = verifica()
    s = v[-1].pop("stato", None) or {}
    bad = [c for c in v if not c["ok"] and c.get("blocca")]
    if bad:
        return jsonify(error=f"{bad[0]['nome']}: {bad[0]['msg']}"), 409
    brani, video = bool(j.get("brani")), bool(j.get("video"))
    tot = misura(brani, video)[1]
    if tot > s.get("libero", 0):
        return jsonify(error=f"Sul server nuovo non c'è abbastanza spazio: servono {tot // 2**30 + 1} GB, ce ne sono {s.get('libero', 0) // 2**30}"), 409
    st_up(errore=None)
    threading.Thread(target=esegui, args=(brani, video), daemon=True).start()
    return jsonify(ok=True)


@bp.post("/api/trasferimento/brani")
def brani_dopo():
    d = st()
    if d.get("ruolo") != "invia" or d.get("stage") != "trasferito" or d.get("brani"):
        return jsonify(error="I brani si spostano dopo solo se il trasferimento è stato fatto senza"), 409
    st_up(stage="trasferito")
    threading.Thread(target=esegui, args=(True, bool(d.get("video")), True), daemon=True).start()
    return jsonify(ok=True)


@bp.post("/api/trasferimento/concludi")
def concludi():
    d = st()
    if d.get("ruolo") != "invia" or d.get("stage") != "trasferito":
        return jsonify(error="Niente da concludere"), 409
    data = os.path.dirname(db.PATH)
    for fn in os.listdir(data):
        if fn.startswith("identita-trasferita-"):
            os.remove(os.path.join(data, fn))
    if d.get("brani"):
        os.remove(os.path.join(data, "identita.key"))  # tutto è sul nuovo: questa identità non deve più esistere qui
        db.run("DELETE FROM sessions")
    shutil.rmtree(os.path.join(data, "trasf-snap"), ignore_errors=True)
    st_up(stage="concluso", at=time.time())
    return jsonify(ok=True)


@bp.post("/api/trasferimento/annulla")
def annulla():
    d = st()
    if d.get("stage") in ("congelato", "applicazione", "trasferito", "concluso", "applicato"):
        return jsonify(error="A questo punto non si annulla più: vedi docs/TRASFERIMENTO.md, «Annullare»"), 409
    st_set({})
    shutil.rmtree(base_dir(), ignore_errors=True)
    return jsonify(ok=True)


def stato():
    d = st()
    out = {k: d.get(k) for k in ("ruolo", "stage", "url", "via", "safety", "confermato", "nome_nuovo", "peer_name", "brani", "video", "errore",
                                 "libero", "expires", "at")}
    if d.get("ruolo") == "ricevi" and d.get("stage") == "aperto":
        out["casa"] = ip_casa()
    if d.get("ruolo") == "invia" and d.get("stage") in ("invio", "congelato", "applicazione") or stato_vivo["msg"].startswith("Brani"):
        out["vivo"] = dict(stato_vivo)
    if d.get("ruolo") == "invia" and d.get("stage") in ("agganciato", "errore"):
        out["verifica"] = verifica()
        s = out["verifica"][-1].pop("stato", None) or {}
        out["confermato"], out["libero"] = s.get("confermato"), s.get("libero")
        out["raggiungibile"] = bool(s)
        out["blocco"] = any(not c["ok"] and c.get("blocca") for c in out["verifica"])
        out["misure"] = {"brani": misura(True, False)[1], "video": sum(x["size"] for x in elenco("video", A.VIDEO_DIR))}
    if d.get("stage") in ("trasferito", "concluso"):
        now = time.time()
        out["ancora"] = {t: len({c for (k, c), at in visti.items() if k == t and now - at < 86400}) for t in ("dispositivo", "server")}
    return out


@bp.get("/api/trasferimento")
def get_stato():
    return jsonify(stato())


def init(flask_app, host):
    global A, F
    A, F = host, host.federazione
    flask_app.register_blueprint(bp)
    flask_app.before_request(guardia)


def start():
    dopo_applicazione()
