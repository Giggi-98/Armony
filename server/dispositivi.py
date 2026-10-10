"""
Armony - dispositivi e sicurezza dell'accesso.

Ogni dispositivo si crea da solo una coppia di chiavi ECDSA P-256 (WebCrypto, privata non esportabile, in
IndexedDB): il server conosce solo la pubblica. Le sessioni nascono da una firma su una sfida del server e
valgono 24 ore; poi il dispositivo ne firma una nuova senza chiedere niente all'utente. Un dispositivo è in
attesa, fidato o revocato: si entra solo da fidati. Revocare cancella le sessioni, chiude il canale dal vivo e
interrompe i flussi audio subito.

  /api/chiave/sfida      pubblica: un numero monouso da firmare (2 minuti)
  /api/login             pubblica: utente + token/sale Subsonic, con la chiave pubblica e la firma se il client
                         ne ha una. Un dispositivo nuovo resta in attesa (403, pending) salvo: primo dispositivo
                         dell'utente da casa/Tailscale, oppure account appena creato con un invito
  /api/chiave/accedi     pubblica: sessione nuova con la sola firma (rinnovo silenzioso; newPub = chiave nuova)
  /api/chiave/abbina     pubblica: entra fidato con un codice monouso creato da un dispositivo fidato
  /api/dispositivi       i miei dispositivi (l'amministratore anche quelli di tutti): approva, rinomina,
                         revoca, rigenera; /chiave registra o cambia la chiave di questo; /abbina crea un codice
  /api/sicurezza         solo amministratori: registro degli eventi e client senza chiave (sempre/locale/mai)

Impostazioni del server (rotte "admin" di RULES che cambiano qualcosa, e le azioni dell'amministratore sui dispositivi
degli altri): le cambia solo un amministratore che entra con un dispositivo con chiave, oppure da casa o da Tailscale
(can_change). Senza chiave da internet le legge ma riceve 403 con code "impserver", e il rifiuto va nel registro.

Audio e copertine non possono mandare intestazioni: il proxy /rest vuole k=<gettone>, firmato dal server con
HMAC per dispositivo e finestra di 12 ore (vale la finestra corrente e la precedente), ricontrollato a ogni
richiesta contro lo stato del dispositivo.

Rete: una richiesta è "da internet" se arriva dal Funnel di Tailscale (tailscaled aggiunge
Tailscale-Funnel-Request e mette in X-Forwarded-For l'indirizzo vero, togliendo quelli mandati dal client)
o da un indirizzo pubblico. Casa e Tailscale = indirizzi privati, loopback, 100.64.0.0/10, fd7a:115c:a1e0::/48.
"""
import base64
import hashlib
import hmac
import ipaddress
import re
import secrets
import threading
import time

import requests
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils
from flask import Blueprint, g, jsonify, request

import db

bp = Blueprint("dispositivi", __name__)
A = None  # il modulo app (init)

SESSION_H = 24      # ore di vita di una sessione con chiave
TICKET_H = 12       # finestra dei gettoni per /rest
PAIR_MIN = 10       # durata di un codice di abbinamento
NONCE_S = 120
GRACE_DAYS = 14
LEGACY = ("sempre", "locale", "mai")
KINDS = ("app", "telefono", "computer", "")
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
TS4, TS6 = ipaddress.ip_network("100.64.0.0/10"), ipaddress.ip_network("fd7a:115c:a1e0::/48")
MSG = {
    "revocato": "Questo dispositivo è stato revocato.",
    "chiave": "Da internet entrano solo i dispositivi con chiave: aggiorna Armony (app o pagina con HTTPS), o collegati da casa o da Tailscale.",
    "mai": "Questo server accetta solo dispositivi con chiave: aggiorna Armony e aprila con HTTPS o dall'app.",
    "emergenza": "Il codice di emergenza vale solo da casa o da Tailscale.",
    "impserver": "Da internet le impostazioni del server si cambiano solo da un dispositivo con chiave (l'app, o Armony "
                 "aperta con HTTPS) oppure da casa o da Tailscale. Da qui puoi guardarle ma non cambiarle.",
}

nonces, nlock = {}, threading.Lock()
fails, flock = {}, threading.Lock()   # "ip:…"/"u:…" -> istanti dei tentativi falliti nell'ultima ora
grants = {}                          # utente appena registrato -> (gettone, scadenza): il primo accesso entra fidato
logged = {}                          # chiave -> ultimo evento registrato (event once=)
CUT = set()                          # dispositivi revocati: i flussi audio in corso si interrompono
_key = []


# ------------------------------------------------------------------ rete
def client_ip():
    # waitress si fida di X-Forwarded-For solo da 127.0.0.1 (tailscaled, o un proxy sulla stessa macchina) e prende
    # l'ultimo indirizzo aggiunto; da chiunque altro lo toglie (app.py, serve). Qui c'è già l'indirizzo vero
    return request.remote_addr or ""


def from_funnel():
    return bool(request.headers.get("Tailscale-Funnel-Request"))


def is_local():
    if from_funnel():
        return False
    try:
        a = ipaddress.ip_address(client_ip())
    except ValueError:
        return False
    if a.version == 6 and a.ipv4_mapped:
        a = a.ipv4_mapped
    return a.is_private or a.is_loopback or a.is_link_local or a in (TS4 if a.version == 4 else TS6)


def net():
    return "locale" if is_local() else "internet"


# ------------------------------------------------------------------ impostazioni, eventi, tentativi
def setting(k):
    r = db.one("SELECT value FROM settings WHERE key = ?", k)
    return r["value"] if r else None


def legacy_mode():
    """Client senza chiave: 'sempre', 'locale' (solo casa/Tailscale) o 'mai'. Senza scelta dell'amministratore
    vale 'sempre' durante il periodo di transizione dopo l'aggiornamento, poi 'locale'."""
    m = setting("legacy")
    if m in LEGACY:
        return m
    gr = setting("legacy_grace")
    return "sempre" if gr and time.time() < float(gr) else "locale"


def legacy_ok():
    m = legacy_mode()
    return m == "sempre" or (m == "locale" and is_local())


def legacy_why():
    return "mai" if legacy_mode() == "mai" else "chiave"


def event(kind, user=None, dev=None, detail="", once=None):
    # once: chiave per non riempire il registro con lo stesso evento ripetuto (al più uno al minuto)
    if once:
        now = time.time()
        if now - logged.get(once, 0) < 60:
            return
        logged[once] = now
        if len(logged) > 5000:
            logged.clear()
    db.run("INSERT INTO events (ts, kind, user, dev, ip, net, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
           time.time(), kind, user, dev, client_ip(), net(), str(detail)[:200])
    if secrets.randbelow(200) == 0:
        db.run("DELETE FROM events WHERE ts < ?", time.time() - 90 * 86400)


def wait_for(*keys):
    """Attesa crescente: dal quarto errore in un'ora 30 s, poi il doppio a ogni errore, fino a un'ora. Quattro e non
    cinque: al quinto errore in 20 secondi Navidrome blocca l'utente per tutti, anche per i suoi dispositivi fidati."""
    now, worst = time.time(), 0
    with flock:
        for k in keys:
            ts = [t for t in fails.get(k, []) if now - t < 3600]
            fails[k] = ts
            if len(ts) >= 4:
                worst = max(worst, ts[-1] + min(3600, 30 * 2 ** (len(ts) - 4)) - now)
    return int(worst) + 1 if worst > 0 else 0


def note_fail(*keys):
    now = time.time()
    with flock:
        if len(fails) > 20000:
            for k in [k for k, v in fails.items() if not v or now - v[-1] > 3600]:
                del fails[k]
        for k in keys:
            fails[k] = (fails.get(k, []) + [now])[-50:]


def clear_fails(*keys):
    with flock:
        for k in keys:
            fails.pop(k, None)


def too_many(wait):
    r = jsonify(error=f"Troppi tentativi falliti: riprova fra {wait // 60 + 1} minuti." if wait > 90
                else f"Troppi tentativi falliti: riprova fra {wait} secondi.", wait=wait)
    r.status_code, r.headers["Retry-After"] = 429, str(wait)
    return r


# ------------------------------------------------------------------ crittografia
def b64d(s):
    s = str(s or "")
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def b64e(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def pub_ok(pub):
    try:
        raw = b64d(pub)
        if len(raw) != 65:
            return False
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
        return True
    except (ValueError, TypeError):
        return False


def verify(pub, msg, sig):
    """Firma ECDSA P-256 con SHA-256 nel formato di WebCrypto (r||s, 64 byte)."""
    try:
        raw, s = b64d(pub), b64d(sig)
        if len(s) != 64:
            return False
        key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
        der = utils.encode_dss_signature(int.from_bytes(s[:32], "big"), int.from_bytes(s[32:], "big"))
        key.verify(der, msg.encode(), ec.ECDSA(hashes.SHA256()))
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


def fingerprint(pub):
    h = hashlib.sha256(b64d(pub)).hexdigest()[:8].upper() if pub else ""
    return f"{h[:4]}-{h[4:]}" if h else ""


def take_nonce(n):
    with nlock:
        exp = nonces.pop(str(n or ""), 0)
    return exp > time.time()


def ticket_key():
    if not _key:
        k = setting("ticket_key")
        if not k:
            db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('ticket_key', ?)", secrets.token_hex(32))
            k = setting("ticket_key")
        _key.append(bytes.fromhex(k))
    return _key[0]


def ticket(dev, gen, win=None):
    win = int(time.time() // (TICKET_H * 3600)) if win is None else win
    mac = hmac.new(ticket_key(), f"{dev}|{gen}|{win}".encode(), hashlib.sha256).digest()[:16]
    return f"{dev}.{win}.{b64e(mac)}"


def ticket_dev(t):
    try:
        dev, win, _ = str(t).split(".")
        win = int(win)
    except ValueError:
        return None
    if win not in (int(time.time() // (TICKET_H * 3600)) - k for k in (0, 1)):
        return None
    r = db.one("SELECT gen FROM devices WHERE id = ?", dev)
    return dev if r and hmac.compare_digest(ticket(dev, r["gen"], win), str(t)) else None


# ------------------------------------------------------------------ identità di una richiesta
def identity(tok=None, k=None):
    """Chi fa la richiesta: sessione (X-Token o ?token=) oppure gettone (?k=). Se non vale, g.why dice perché."""
    g.why = None
    tok = tok or request.headers.get("X-Token") or request.args.get("token") or ""
    k = "" if tok else (k or request.args.get("k") or "")
    if not tok and not k:
        return None
    if tok and A.TOKEN and secrets.compare_digest(tok, A.TOKEN):
        # l'accesso di emergenza non passa dal Funnel né da indirizzi pubblici
        if not is_local():
            g.why = "emergenza"
            note_fail("ip:" + client_ip())
            event("emergenza", detail="rifiutato: richiesta da internet", once="em:" + client_ip())
            return None
        return dict(user=None, admin=True, upload=True, download=True, delete=True, dev=None, keyed=True, gen=0)
    now = time.time()
    if tok:
        s = db.one("SELECT user, seen, exp, dev FROM sessions WHERE token = ?", tok)
        if not s or (s["exp"] or s["seen"] + A.SESSION_DAYS * 86400) < now:
            return None
        if now - s["seen"] > 3600:
            db.run("UPDATE sessions SET seen = ? WHERE token = ?", now, tok)
        dev_id = s["dev"]
    else:
        dev_id = ticket_dev(k)
    d = db.one("SELECT * FROM devices WHERE id = ?", dev_id) if dev_id else None
    if not d or d["state"] != "fidato":
        g.why = "revocato" if d and d["state"] == "revocato" else None
        return None
    # il gettone vale finché il dispositivo ha una sessione viva: uscire o rigenerare lo spegne
    if not tok and not db.one("SELECT 1 FROM sessions WHERE dev = ? AND coalesce(exp, seen + ?) > ?", dev_id, A.SESSION_DAYS * 86400, now):
        return None
    if not d["pub"] and not legacy_ok():
        g.why = legacy_why()
        return None
    ip = client_ip()
    if not d["seen"] or now - d["seen"] > 300 or d["ip"] != ip:
        db.run("UPDATE devices SET seen = ?, ip = ?, net = ? WHERE id = ?", now, ip, net(), d["id"])
    p = db.one("SELECT upload, download, del FROM perms WHERE user = ?", d["user"])
    admin = bool(d["admin"])
    return dict(user=d["user"], admin=admin, upload=admin or not p or bool(p["upload"]), download=admin or not p or bool(p["download"]),
                delete=admin or bool(p and p["del"]), dev=d["id"], keyed=bool(d["pub"]), gen=d["gen"])


def can_change(who):
    """Un amministratore può cambiare le impostazioni del server: con un dispositivo con chiave o da casa/Tailscale.
    Il codice di emergenza vale già solo da casa (keyed=True)."""
    return bool(who.get("keyed")) or is_local()


def refuse_change():
    event("impserver", g.who.get("user"), g.who.get("dev"), f"rifiutato {request.method} {request.path}: senza chiave da internet",
          once="imp:" + (g.who.get("dev") or client_ip()))
    return jsonify(error=MSG["impserver"], code="impserver"), 403


def deny():
    """La risposta 401 con il motivo: il client mostra "Questo dispositivo è stato revocato" senza riprovare."""
    why = getattr(g, "why", None)
    return jsonify(error=MSG.get(why, "Accesso richiesto: entra con il tuo utente."), code=why), 401


def me_extra(who):
    out = dict(dev=who.get("dev"), keyed=who.get("keyed", True), pending=pending_count(who))
    if who.get("admin"):
        # srvedit: le impostazioni del server si possono cambiare da qui (can_change); pending_mine: i miei in attesa
        out.update(srvedit=can_change(who), pending_mine=db.one("SELECT count(*) n FROM devices WHERE state = 'attesa' AND user = ?", who.get("user"))["n"])
    if who.get("dev"):
        out["ticket"] = ticket(who["dev"], who["gen"])
    return out


def pending_count(who):
    if who.get("admin"):
        return db.one("SELECT count(*) n FROM devices WHERE state = 'attesa'")["n"]
    return db.one("SELECT count(*) n FROM devices WHERE state = 'attesa' AND user = ?", who.get("user"))["n"]


def rest_salt_blocked(salt):
    """Credenziali Subsonic "nude" (senza gettone): rifiutate se il sale è di un dispositivo revocato o con chiave."""
    return bool(salt) and bool(db.one("SELECT 1 FROM devices WHERE salt = ? AND (state = 'revocato' OR pub IS NOT NULL)", salt))


# ------------------------------------------------------------------ sessioni e dispositivi
def clean_name(v, fallback="Dispositivo"):
    v = re.sub(r"[\x00-\x1f]", "", str(v or "")).strip()[:40]
    return v or fallback


def new_session(d):
    tok, now = secrets.token_urlsafe(32), time.time()
    db.run("DELETE FROM sessions WHERE dev = ? AND exp < ?", d["id"], now)  # i rinnovi non accumulano sessioni scadute
    db.run("INSERT INTO sessions (token, user, admin, device, created, seen, dev, exp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
           tok, d["user"], d["admin"], d["cid"], now, now, d["id"], now + SESSION_H * 3600 if d["pub"] else None)
    return tok


def session_reply(d, extra=None):
    tok = new_session(d)
    g.who = identity(tok)
    if not g.who:
        return deny()
    return jsonify({**A.me_payload(), **(extra or {}), "session": tok})


def new_device(user, admin, name, kind, pub, cid, salt, state, by=None):
    now, did = time.time(), secrets.token_hex(12)
    db.run("INSERT INTO devices (id, user, name, kind, pub, cid, salt, admin, state, created, approved, by, seen, ip, net) "
           "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", did, user, name, kind, pub, cid, salt, int(admin), state, now,
           now if state == "fidato" else None, by, now, client_ip(), net())
    return db.one("SELECT * FROM devices WHERE id = ?", did)


def cut(d, why="revocato"):
    """Sessioni cancellate, canale dal vivo chiuso, audio in corso interrotto: subito."""
    db.run("DELETE FROM sessions WHERE dev = ?", d["id"])
    if why == "revocato":
        CUT.add(d["id"])
    A.live_kick(lambda c: c.get("dev") == d["id"], {"type": why})


def notify(user):
    """Ai dispositivi dell'utente e agli amministratori: l'elenco è cambiato (es. un dispositivo in attesa)."""
    A.live_notify(user, {"type": "dispositivi"})


def nd_user(u, t, s):
    """getUser di Navidrome con token + sale: (risposta, None) o (None, risposta di errore)."""
    try:
        r = A.http.get(f"{A.NAVIDROME_URL}/rest/getUser", timeout=10,
                       params=dict(u=u, t=t, s=s, v="1.16.1", c="armony", f="json", username=u)).json()["subsonic-response"]
    except (requests.RequestException, ValueError, KeyError):
        return None, (jsonify(error="Il server musicale non risponde"), 502)
    return r, None


def owned(did):
    d = db.one("SELECT * FROM devices WHERE id = ?", did)
    return d if d and (g.who["admin"] or d["user"] == g.who["user"]) else None


# ------------------------------------------------------------------ rotte pubbliche
@bp.post("/api/chiave/sfida")
def sfida():
    n, now = secrets.token_urlsafe(24), time.time()
    with nlock:
        if len(nonces) > 5000:
            for k in [k for k, e in nonces.items() if e < now]:
                del nonces[k]
        if len(nonces) > 20000:
            return jsonify(error="Troppe richieste: riprova fra poco."), 429
        nonces[n] = now + NONCE_S
    return jsonify(nonce=n, ttl=NONCE_S)


@bp.post("/api/login")
def login():
    # il client manda token + sale Subsonic, mai la password: Armony li verifica con Navidrome
    ip = client_ip()
    d = request.get_json(silent=True) or {}
    u, t, s = (str(d.get(k) or "")[:100] for k in ("u", "t", "s"))
    if not (u and t and s):
        return jsonify(error="Utente e credenziali obbligatori"), 400
    keys = ("ip:" + ip, "u:" + u.lower())
    wait = wait_for(*keys)
    if wait:
        event("bloccato", u, detail=f"accesso, attesa {wait} s", once=f"bl:{ip}:{u}")
        return too_many(wait)
    pub = str(d.get("pub") or "")
    if pub and not (pub_ok(pub) and take_nonce(d.get("nonce")) and verify(pub, f"armony1|login|{d.get('nonce')}|{u}", d.get("sig"))):
        return jsonify(error="Firma del dispositivo non valida: riprova."), 400
    r, err = nd_user(u, t, s)
    if err:
        return err
    if r.get("status") != "ok":
        note_fail(*keys)
        event("accesso_fallito", u)
        return jsonify(error="Utente o password errati"), 401
    clear_fails(*keys)
    admin = bool(r.get("user", {}).get("adminRole"))
    cid, name, kind = str(d.get("device") or "")[:40], clean_name(d.get("name")), str(d.get("kind") or "")
    kind = kind if kind in KINDS else ""
    if pub:
        dev = db.one("SELECT * FROM devices WHERE pub = ?", pub)
        if dev and dev["user"] != u:
            return jsonify(error="Questa chiave è di un altro utente: il dispositivo ne crea una nuova.", code="chiave_altrui"), 409
    else:
        if not legacy_ok():
            event("senza_chiave", u, detail="accesso senza chiave rifiutato", once=f"sk:{ip}:{u}")
            return jsonify(error=MSG[legacy_why()], code=legacy_why()), 401
        dev = db.one("SELECT * FROM devices WHERE user = ? AND pub IS NULL AND cid = ? AND state != 'revocato' "
                     "ORDER BY state = 'fidato' DESC LIMIT 1", u, cid) if cid else None
    if dev and dev["state"] == "revocato":
        return jsonify(error=MSG["revocato"], code="revocato"), 401
    if not dev:
        gr = grants.pop(u, None)
        granted = bool(gr and gr[1] > time.time() and secrets.compare_digest(gr[0], str(d.get("grant") or "")))
        first = is_local() and not db.one("SELECT 1 FROM devices WHERE user = ? AND state = 'fidato'", u)
        state = "fidato" if granted or first else "attesa"
        dev = new_device(u, admin, name, kind, pub or None, cid, s, state,
                         by="invito" if granted else "primo dispositivo, da casa" if first else None)
        event("nuovo" if state == "fidato" else "attesa", u, dev["id"], name)
        if state == "attesa":
            notify(u)
    db.run("UPDATE devices SET admin = ?, salt = ?, cid = ? WHERE id = ?", int(admin), s, cid, dev["id"])
    dev = db.one("SELECT * FROM devices WHERE id = ?", dev["id"])
    if dev["state"] == "attesa":
        return jsonify(error="Questo dispositivo aspetta l'approvazione: chiedila da un tuo dispositivo fidato o all'amministratore.",
                       code="attesa", pending=True, dev=dev["id"], fp=fingerprint(dev["pub"])), 403
    event("accesso", u, dev["id"], dev["name"])
    return session_reply(dev, {"dev": dev["id"]})


@bp.post("/api/chiave/accedi")
def accedi():
    ip = client_ip()
    wait = wait_for("ip:" + ip)
    if wait:
        return too_many(wait)
    d = request.get_json(silent=True) or {}
    did, nonce = str(d.get("dev") or "")[:40], str(d.get("nonce") or "")
    dev = db.one("SELECT * FROM devices WHERE id = ?", did)
    if not dev or not dev["pub"]:
        return jsonify(error="Dispositivo sconosciuto: entra con utente e password.", code="sconosciuto"), 404
    if not take_nonce(nonce):
        return jsonify(error="Sfida scaduta: riprova."), 400
    if not verify(dev["pub"], f"armony1|accedi|{nonce}|{did}", d.get("sig")):
        note_fail("ip:" + ip)
        return jsonify(error="Firma non valida.", code="firma"), 401
    if dev["state"] == "revocato":
        return jsonify(error=MSG["revocato"], code="revocato"), 401
    if dev["state"] == "attesa":
        return jsonify(error="Questo dispositivo aspetta ancora l'approvazione.", code="attesa", pending=True, dev=did,
                       fp=fingerprint(dev["pub"])), 403
    newpub = str(d.get("newPub") or "")
    if newpub:
        if not (pub_ok(newpub) and verify(newpub, f"armony1|chiave|{nonce}|{did}", d.get("newSig"))):
            return jsonify(error="Firma della chiave nuova non valida."), 400
        if db.one("SELECT 1 FROM devices WHERE pub = ?", newpub):
            return jsonify(error="Chiave già in uso."), 409
        db.run("UPDATE devices SET pub = ?, gen = gen + 1, rekey = 0 WHERE id = ?", newpub, did)
        db.run("DELETE FROM sessions WHERE dev = ?", did)
        event("rigenerato", dev["user"], did, "chiave nuova (richiesta)")
        dev = db.one("SELECT * FROM devices WHERE id = ?", did)
    elif dev["rekey"]:
        return jsonify(error="Serve una chiave nuova.", code="rekey"), 409
    return session_reply(dev, {"dev": did})


@bp.post("/api/chiave/abbina")
def abbina_usa():
    ip = client_ip()
    wait = wait_for("ip:" + ip)
    if wait:
        return too_many(wait)
    d = request.get_json(silent=True) or {}
    code, pub, nonce = re.sub(r"[^A-Z0-9]", "", str(d.get("code") or "").upper())[:16], str(d.get("pub") or ""), str(d.get("nonce") or "")
    if not (pub_ok(pub) and take_nonce(nonce) and verify(pub, f"armony1|abbina|{nonce}|{code}", d.get("sig"))):
        return jsonify(error="Firma del dispositivo non valida: riprova."), 400
    if db.one("SELECT 1 FROM devices WHERE pub = ?", pub):
        return jsonify(error="Chiave già in uso."), 409
    h, now = hashlib.sha256(code.encode()).hexdigest(), time.time()
    took = db.conn().execute("UPDATE pairings SET used_by = ? WHERE hash = ? AND used_by IS NULL AND expires > ?",
                             (pub[:16], h, now)).rowcount
    if not took:
        note_fail("ip:" + ip)
        event("abbinamento_fallito")
        return jsonify(error="Codice non valido, già usato o scaduto: creane uno nuovo dal dispositivo fidato."), 403
    p = db.one("SELECT * FROM pairings WHERE hash = ?", h)
    db.run("UPDATE pairings SET t = '', s = '' WHERE hash = ?", h)  # le credenziali restano qui solo fino all'uso
    by = db.one("SELECT name, admin FROM devices WHERE id = ?", p["by_dev"])
    kind = str(d.get("kind") or "")
    dev = new_device(p["user"], by["admin"] if by else 0, clean_name(d.get("name")), kind if kind in KINDS else "", pub,
                     str(d.get("device") or "")[:40], p["s"], "fidato", by="abbinato da " + (by["name"] if by else "?"))
    clear_fails("ip:" + ip)
    event("abbinato", p["user"], dev["id"], dev["name"])
    notify(p["user"])
    # il dispositivo nuovo riceve le credenziali Subsonic di chi lo ha abbinato: le stesse che darebbe la password
    return session_reply(dev, {"dev": dev["id"], "user": p["user"], "t": p["t"], "s": p["s"]})


# ------------------------------------------------------------------ i miei dispositivi (RULES: user)
def dev_json(d, now):
    return dict(id=d["id"], user=d["user"], name=d["name"], kind=d["kind"], state=d["state"], keyed=bool(d["pub"]),
                fp=fingerprint(d["pub"]), created=d["created"], approved=d["approved"], by=d["by"], seen=d["seen"],
                ip=d["ip"], net=d["net"], rekey=bool(d["rekey"]), revoked=d["revoked"], me=d["id"] == g.who.get("dev"))


@bp.get("/api/dispositivi")
def dispositivi():
    now = time.time()
    if g.who["admin"] and request.args.get("tutti") == "1":
        rows = db.all_("SELECT * FROM devices ORDER BY state = 'attesa' DESC, user, coalesce(seen, created) DESC")
    else:
        rows = db.all_("SELECT * FROM devices WHERE user = ? ORDER BY state = 'attesa' DESC, coalesce(seen, created) DESC", g.who["user"])
    out = dict(me=g.who.get("dev"), devices=[dev_json(d, now) for d in rows], net=net())
    if g.who["admin"]:
        gr = setting("legacy_grace")
        out["legacy"] = dict(mode=legacy_mode(), chosen=setting("legacy"), grace=float(gr) if gr else None)
    return jsonify(out)


@bp.put("/api/dispositivi/<did>")
def rinomina(did):
    d = owned(did)
    if not d:
        return jsonify(error="Dispositivo non trovato"), 404
    if d["user"] != g.who["user"] and not can_change(g.who):
        return refuse_change()
    name = clean_name((request.get_json(silent=True) or {}).get("name"), d["name"])
    db.run("UPDATE devices SET name = ? WHERE id = ?", name, did)
    notify(d["user"])
    return jsonify(ok=True, name=name)


@bp.post("/api/dispositivi/<did>/<azione>")
def azione(did, azione):
    d = owned(did)
    if not d:
        return jsonify(error="Dispositivo non trovato"), 404
    if d["user"] != g.who["user"] and not can_change(g.who):
        return refuse_change()
    who = g.who["user"] or "emergenza"
    if azione == "approva":
        if d["state"] != "attesa":
            return jsonify(error="Questo dispositivo non è in attesa."), 409
        db.run("UPDATE devices SET state = 'fidato', approved = ?, by = ? WHERE id = ?", time.time(), "approvato da " + who, did)
        event("approvato", d["user"], did, f"{d['name']}, da {who}")
    elif azione == "revoca":
        db.run("UPDATE devices SET state = 'revocato', revoked = ? WHERE id = ?", time.time(), did)
        cut(d)
        event("revocato", d["user"], did, f"{d['name']}, da {who}")
    elif azione == "rigenera":
        # al prossimo accesso il dispositivo deve presentare una chiave nuova; le sue sessioni finiscono ora
        if not d["pub"] or d["state"] != "fidato":
            return jsonify(error="Solo un dispositivo fidato con chiave può rigenerarla."), 409
        db.run("UPDATE devices SET rekey = 1 WHERE id = ?", did)
        cut(d, "rekey")
        event("rigenera", d["user"], did, f"{d['name']}, chiesto da {who}")
    else:
        return jsonify(error="Azione sconosciuta"), 404
    notify(d["user"])
    return jsonify(ok=True)


@bp.post("/api/dispositivi/chiave")
def chiave():
    """Questo dispositivo registra la sua prima chiave (client vecchio aggiornato) o ne mette una nuova."""
    did = g.who.get("dev")
    if not did:
        return jsonify(error="Serve la sessione di un dispositivo"), 400
    d = request.get_json(silent=True) or {}
    pub, nonce = str(d.get("pub") or ""), str(d.get("nonce") or "")
    if not (pub_ok(pub) and take_nonce(nonce) and verify(pub, f"armony1|chiave|{nonce}|{did}", d.get("sig"))):
        return jsonify(error="Firma della chiave non valida."), 400
    if db.one("SELECT 1 FROM devices WHERE pub = ? AND id != ?", pub, did):
        return jsonify(error="Chiave già in uso."), 409
    dev = db.one("SELECT * FROM devices WHERE id = ?", did)
    kind = str(d.get("kind") or "")
    db.run("UPDATE devices SET pub = ?, gen = gen + 1, rekey = 0, name = ?, kind = ? WHERE id = ?", pub,
           clean_name(d.get("name"), dev["name"]) if not dev["pub"] else dev["name"], kind if kind in KINDS else dev["kind"], did)
    db.run("DELETE FROM sessions WHERE dev = ?", did)
    event("chiave" if not dev["pub"] else "rigenerato", dev["user"], did, "prima chiave" if not dev["pub"] else "dal dispositivo")
    notify(dev["user"])
    return session_reply(db.one("SELECT * FROM devices WHERE id = ?", did), {"dev": did})


@bp.post("/api/dispositivi/abbina")
def abbina_crea():
    """Codice monouso (10 minuti) per far entrare fidato un dispositivo nuovo dello stesso utente."""
    u = g.who["user"]
    if not u or not g.who.get("dev"):
        return jsonify(error="Serve l'accesso di un utente da un dispositivo"), 400
    d = request.get_json(silent=True) or {}
    t, s = str(d.get("t") or "")[:100], str(d.get("s") or "")[:100]
    r, err = nd_user(u, t, s)
    if err:
        return err
    if r.get("status") != "ok":
        return jsonify(error="Le credenziali di questo dispositivo non valgono più: reinserisci la password del server."), 400
    code, now = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8)), time.time()
    db.run("DELETE FROM pairings WHERE expires < ?", now - 86400)
    db.run("INSERT INTO pairings (hash, user, by_dev, t, s, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?)",
           hashlib.sha256(code.encode()).hexdigest(), u, g.who["dev"], t, s, now, now + PAIR_MIN * 60)
    event("codice", u, g.who["dev"], "codice di abbinamento creato")
    return jsonify(code=code, expires=now + PAIR_MIN * 60), 201


# ------------------------------------------------------------------ amministratore (RULES: admin)
@bp.get("/api/sicurezza")
def sicurezza():
    rows = db.all_("SELECT e.*, d.name dname FROM events e LEFT JOIN devices d ON d.id = e.dev ORDER BY e.id DESC LIMIT 200")
    gr = setting("legacy_grace")
    return jsonify(events=[dict(ts=r["ts"], kind=r["kind"], user=r["user"], dev=r["dname"], ip=r["ip"], net=r["net"], detail=r["detail"])
                           for r in rows],
                   legacy=dict(mode=legacy_mode(), chosen=setting("legacy"), grace=float(gr) if gr else None))


@bp.put("/api/sicurezza")
def sicurezza_put():
    m = (request.get_json(silent=True) or {}).get("legacy")
    if m not in LEGACY:
        return jsonify(error="Valore non valido"), 400
    db.run("INSERT INTO settings (key, value) VALUES ('legacy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", m)
    event("impostazione", g.who["user"], g.who.get("dev"), f"client senza chiave: {m}")
    # chi non ha più diritto di restare collegato viene staccato adesso
    if m != "sempre":
        A.live_kick(lambda c: not c.get("keyed", True) and (m == "mai" or c.get("net") != "locale"), {"type": legacy_why()})
    return sicurezza()


def registered(user):
    """Account appena creato con /api/register: il suo primo accesso (entro 10 minuti) entra fidato."""
    tok = secrets.token_urlsafe(18)
    grants[user] = (tok, time.time() + 600)
    return tok


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)
