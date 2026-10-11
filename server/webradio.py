"""
Armony - radio da internet (capacità "webradio"): stazioni in diretta salvate sul server, pronte per tutti.

  GET    /api/webradio               le stazioni salvate
  POST   /api/webradio               {name, url, favicon?, homepage?, tags?, country?} (permesso "radio")
  DELETE /api/webradio/<id>          chi l'ha aggiunta o un amministratore
  GET    /api/webradio/cerca?q=      ricerca nel catalogo pubblico Radio Browser (radio-browser.info, senza chiavi)
  GET    /api/webradio/<id>/ascolta  la diretta, passando dal server (anche con ?k=: la usa <audio>)

─── PERCHÉ dal server ───
Molte radio trasmettono in http: da Armony in https il browser le bloccherebbe, e senza CORS il grafico dell'audio
(equalizzatore, visualizzatore) resterebbe muto. Il server apre la diretta e la passa così com'è.

─── PERCHÉ i controlli sugli indirizzi ───
L'indirizzo lo scrive un utente: il server non deve diventare una porta verso sé stesso o la rete di casa (Navidrome su
127.0.0.1, il router, …). Si accettano solo indirizzi pubblici, controllati a ogni ascolto e a ogni redirect (seguiti
a mano, al più 4), così anche un nome che cambia indirizzo dopo il salvataggio non passa.
"""
import ipaddress
import socket
import time
import urllib.parse
import uuid

from flask import Blueprint, Response, g, jsonify, request, stream_with_context

import db

bp = Blueprint("webradio", __name__)
A = None
CATALOGO = "https://all.api.radio-browser.info/json/stations/search"


def pubblico(url):
    """L'indirizzo se è http(s) verso un indirizzo pubblico, altrimenti ValueError."""
    p = urllib.parse.urlparse(str(url or "").strip())
    if p.scheme not in ("http", "https") or not p.hostname:
        raise ValueError("Serve un indirizzo http:// o https://")
    try:
        addrs = {a[4][0] for a in socket.getaddrinfo(p.hostname, p.port or (443 if p.scheme == "https" else 80), proto=socket.IPPROTO_TCP)}
    except OSError:
        raise ValueError("Il nome della radio non si risolve") from None
    for a in addrs:
        ip = ipaddress.ip_address(a.split("%")[0])
        ip = ip.ipv4_mapped or ip if ip.version == 6 else ip
        if not ip.is_global:
            raise ValueError("Indirizzo non valido: una radio da internet deve stare su internet")
    return p.geturl()


def apri(url, stream=True, timeout=(6, 30)):
    """GET verso un indirizzo pubblico, redirect seguiti a mano e ricontrollati."""
    for _ in range(5):
        r = A.http.get(pubblico(url), stream=stream, timeout=timeout, allow_redirects=False,
                       headers={"User-Agent": "Armony", "Icy-MetaData": "0"})
        if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
            url = urllib.parse.urljoin(url, r.headers["location"])
            r.close()
            continue
        return r
    raise ValueError("Troppi rimandi")


def diretta(url):
    """Dalle playlist (.m3u, .pls) al primo flusso vero."""
    low = url.lower().split("?")[0]
    if not low.endswith((".m3u", ".pls")):
        return url
    r = apri(url, stream=False, timeout=(6, 10))
    for line in r.text.splitlines()[:200]:
        line = line.strip()
        if low.endswith(".pls") and line.lower().startswith("file") and "=" in line:
            return line.split("=", 1)[1].strip()
        if not low.endswith(".pls") and line and not line.startswith("#"):
            return urllib.parse.urljoin(url, line)
    raise ValueError("La playlist della radio è vuota")


def riga(r):
    return {k: r[k] for k in r.keys()}


@bp.get("/api/webradio")
def elenco():
    return jsonify(items=[riga(r) for r in db.all_("SELECT * FROM webradio ORDER BY name COLLATE NOCASE")])


@bp.post("/api/webradio")
def aggiungi():
    if not g.who["admin"] and not g.who["perm"].get("radio", True):
        return jsonify(error="Le radio non sono abilitate per il tuo utente."), 403
    d = request.get_json(silent=True) or {}
    name = str(d.get("name") or "").strip()[:80]
    if not name:
        return jsonify(error="Dai un nome alla radio"), 400
    try:
        url = pubblico(str(d.get("url") or "").strip()[:500])
    except ValueError as e:
        return jsonify(error=str(e)), 400
    if url.lower().split("?")[0].endswith(".m3u8"):  # HLS: pezzi da una playlist che cambia, il browser non la suona da solo
        return jsonify(error="Questa radio trasmette in HLS (.m3u8), che Armony non riproduce: cercane un altro indirizzo (MP3 o AAC)"), 400
    if db.one("SELECT 1 FROM webradio WHERE url = ?", url):
        return jsonify(error="Questa radio c'è già"), 409
    fav = str(d.get("favicon") or "").strip()[:500]
    st = dict(id=uuid.uuid4().hex[:10], name=name, url=url, favicon=fav if fav.startswith("https://") else "",
              homepage=str(d.get("homepage") or "")[:300], tags=str(d.get("tags") or "")[:200], country=str(d.get("country") or "")[:60],
              codec=str(d.get("codec") or "")[:20], bitrate=int(d.get("bitrate") or 0) if str(d.get("bitrate") or "0").isdigit() else 0,
              added_by=g.who.get("user") or "", created=time.time())
    db.run(f"INSERT INTO webradio ({', '.join(st)}) VALUES ({', '.join('?' * len(st))})", *st.values())
    A.attivita(g.who.get("user"), "radio", f"ha aggiunto la radio «{name}»", None)
    return jsonify(st), 201


@bp.delete("/api/webradio/<sid>")
def togli(sid):
    r = db.one("SELECT added_by FROM webradio WHERE id = ?", sid)
    if not r:
        return jsonify(error="Radio non trovata"), 404
    if not g.who["admin"] and (r["added_by"] or "").lower() != (g.who.get("user") or "").lower():
        return jsonify(error="Può toglierla solo chi l'ha aggiunta o un amministratore"), 403
    db.run("DELETE FROM webradio WHERE id = ?", sid)
    return jsonify(ok=True)


@bp.get("/api/webradio/cerca")
def cerca():
    q = (request.args.get("q") or "").strip()[:100]
    if len(q) < 2:
        return jsonify(items=[])
    try:
        r = A.http.get(CATALOGO, params={"name": q, "limit": 40, "hidebroken": "true", "order": "clickcount", "reverse": "true"},
                       headers={"User-Agent": "Armony"}, timeout=10)
        r.raise_for_status()
        out = [{"name": (x.get("name") or "").strip()[:80], "url": x.get("url_resolved") or x.get("url"), "favicon": x.get("favicon") or "",
                "homepage": x.get("homepage") or "", "tags": (x.get("tags") or "")[:200], "country": x.get("country") or "",
                "codec": x.get("codec") or "", "bitrate": x.get("bitrate") or 0} for x in r.json()
               if (x.get("url_resolved") or x.get("url")) and not x.get("hls") and ".m3u8" not in (x.get("url_resolved") or x.get("url") or "").lower()]
    except Exception as e:  # noqa: BLE001
        return jsonify(error=f"Il catalogo delle radio non risponde ({e.__class__.__name__})"), 502
    saved = {r["url"] for r in db.all_("SELECT url FROM webradio")}
    for x in out:
        x["saved"] = x["url"] in saved
    return jsonify(items=out)


@bp.get("/api/webradio/<sid>/ascolta")
def ascolta(sid):
    st = db.one("SELECT url, name FROM webradio WHERE id = ?", sid)
    if not st:
        return jsonify(error="Radio non trovata"), 404
    try:
        r = apri(diretta(st["url"]), timeout=(8, 60))
    except Exception as e:  # noqa: BLE001 — la radio è spenta, l'indirizzo è cambiato, rete
        A.diagnosi.avviso("radio", f"la radio «{st['name']}» non risponde: {e}", user=g.who.get("user"))
        return jsonify(error="La radio non risponde"), 502
    if r.status_code != 200:
        r.close()
        return jsonify(error=f"La radio ha risposto {r.status_code}"), 502
    ctype = r.headers.get("content-type") or "audio/mpeg"
    if not ctype.startswith(("audio/", "application/ogg", "application/octet-stream", "video/mp2t")):
        r.close()
        A.diagnosi.avviso("radio", f"la radio «{st['name']}» non manda audio ({ctype})", user=g.who.get("user"))
        return jsonify(error="Questo indirizzo non è una diretta audio"), 502

    def flusso():
        try:
            for chunk in r.iter_content(16 * 1024):
                yield chunk
        finally:
            r.close()
    # diretta: niente cache né lunghezza; il browser la legge finché non la si ferma
    return Response(stream_with_context(flusso()), mimetype=ctype.split(";")[0],
                    headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"}, direct_passthrough=True)


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)
