"""
Armony - Jam Radio: stazioni che girano all'infinito sul server, a cui chiunque si sintonizza (docs/FEDERAZIONE.md §15).

Una stazione è un elenco di brani con le durate e un istante d'inizio: cosa è in onda e a che punto si calcola dal
tempo del server, quindi tutti gli ascoltatori sentono lo stesso punto e dopo un riavvio si riprende da lì. Finito
l'elenco lo si rimescola con un seme fisso (diverso a ogni giro, uguale per tutti) e si riparte. L'elenco lo
prepara il client con le sue radio (playlist, album, genere, artista, tutta la libreria a caso).

  /api/radio                    le stazioni di questo server (GET), creane una (POST)
  /api/radio/<id>               il brano in onda e i prossimi con gli istanti d'inizio (GET); rinomina, ferma o
                                riprendi (PUT) e togli (DELETE): solo chi l'ha creata o un amministratore
  /api/radio/<id>/ascolta       entra o esce, per chi ascolta; ripetuto ogni minuto finché si ascolta
  /api/rete/radio               le stazioni dei server collegati (e degli amici degli amici, se lo permettono)
  /api/rete/radio/<id>?r=…      come /api/radio/<id>, con gli istanti portati sull'orologio di questo server;
  /api/rete/radio/<id>/ascolta?r=…   l'audio passa da /api/rete/stream come gli altri brani della rete
  /fed/v1/radio                 (firmata) le mie stazioni in onda, più quelle inoltrate (ttl, rid, come la mappa)
  /fed/v1/radio/<id>?via=…      stato e ascoltatori; /fed/v1/radio/<id>/ascolta?via=…
  /fed/v1/ora                   l'orologio di questo nodo: i vicini stimano lo scarto (andata e ritorno)

Ascoltatori e stazioni arrivano in tempo reale agli utenti del server sul canale /api/live ({"type": "radio"}).
"""
import hashlib
import json
import random
import secrets
import threading
import time
import uuid

from flask import Blueprint, abort, g, jsonify, request

import db
import federazione as F

bp = Blueprint("radio", __name__)
A = None                   # il modulo app.py (init)
stations = {}              # id -> stazione, copia in memoria della tabella radio
listeners = {}             # id -> {chiave: {"name", "user", "server", "seen"}}
lock = threading.Lock()
clocks = {}                # nodo vicino -> (scarto in secondi, istante della stima)
LISTEN_TTL = 150           # secondi senza conferma prima di togliere un ascoltatore (il client conferma ogni minuto)
MAX_TRACKS = 1000
TRACK_KEYS = ("id", "title", "artist", "album", "albumId", "artistId", "coverArt", "genre", "year")
SOURCES = ("libreria", "playlist", "album", "genere", "artista")


# ------------------------------------------------------------------ l'orologio della stazione
def load():
    for r in db.all_("SELECT * FROM radio"):
        stations[r["id"]] = dict(r, source=json.loads(r["source"]), tracks=json.loads(r["tracks"]))


def order(st, k):
    # giro 0: l'ordine scelto da chi l'ha creata; dal giro 1 rimescolato, lo stesso per tutti
    idx = list(range(len(st["tracks"])))
    if k:
        random.Random(f"{st['seed']}:{k}").shuffle(idx)
    return idx


def window(st, t, n=4):
    """Il brano in onda all'istante t e i successivi: [(indice nell'elenco, inizio, durata)], in secondi del server.
    Una stazione ferma resta al punto in cui è stata fermata (gli inizi sono quelli che avrebbe se ripartisse ora)."""
    tr = st["tracks"]
    el = st["paused"] if st["paused"] is not None else max(0.0, t - st["start"])
    k, off = divmod(el, sum(x["duration"] for x in tr))
    o, i, acc = order(st, int(k)), 0, 0.0
    while i < len(o) - 1 and acc + tr[o[i]]["duration"] <= off:
        acc += tr[o[i]]["duration"]
        i += 1
    cur, out = t - (off - acc), []
    while len(out) < n:
        d = tr[o[i]]["duration"]
        out.append((o[i], cur, d))
        cur += d
        i += 1
        if i == len(o):
            k, i = k + 1, 0
            o = order(st, int(k))
    return out


# ------------------------------------------------------------------ ascoltatori
def heard(sid):
    """(visibili, quanti): chi ha spento "mostra agli altri cosa ascolto" conta ma non compare."""
    now = time.time()
    with lock:
        ls = [dict(v, k=k) for k, v in listeners.get(sid, {}).items() if now - v["seen"] < LISTEN_TTL]
    vis = [{"k": hashlib.sha256(x["k"].encode()).hexdigest()[:10], "name": x["name"], "user": x["user"], "server": x.get("server")}
           for x in sorted(ls, key=lambda x: x["since"]) if x["name"]]
    return vis, len(ls)


def set_listener(sid, k, info, on):
    """True se l'elenco degli ascoltatori di qualche stazione è cambiato (non per una semplice conferma).
    Chi entra in una stazione esce dalle altre: si ascolta una radio alla volta."""
    now, changed = time.time(), set()
    with lock:
        for s, ls in listeners.items():
            if k in ls and (s != sid or not on):
                del ls[k]
                changed.add(s)
        if on:
            ls = listeners.setdefault(sid, {})
            if k not in ls:
                changed.add(sid)
            ls[k] = dict(info, seen=now, since=ls.get(k, {}).get("since", now))
    for s in changed:
        notify(s)
    return bool(changed)


def device_gone(user, dev):
    # chiamata da app.py quando un dispositivo chiude il canale dal vivo: non sta più ascoltando
    set_listener(None, f"u:{user}|{dev}", None, False)


def gc():
    while True:
        time.sleep(20)
        now, gone = time.time(), set()
        with lock:
            for s, ls in listeners.items():
                for k in [k for k, v in ls.items() if now - v["seen"] >= LISTEN_TTL]:
                    del ls[k]
                    gone.add(s)
        for s in gone:
            notify(s)


# ------------------------------------------------------------------ come la vedono gli altri
def pub_track(t, start, dur):
    return {"track": {k: t.get(k) for k in TRACK_KEYS if t.get(k) not in (None, "")} | {"duration": dur}, "start": round(start, 3), "duration": dur}


def summary(st, t=None):
    t = t or time.time()
    i, start, dur = window(st, t, 1)[0]
    vis, n = heard(st["id"])
    return {"id": st["id"], "name": st["name"], "owner": st["owner"], "ownerName": A.pres_who(st["owner"])[1], "source": st["source"],
            "created": st["created"], "on": st["paused"] is None, "count": len(st["tracks"]),
            "total": round(sum(x["duration"] for x in st["tracks"])), "now": pub_track(st["tracks"][i], start, dur),
            "listeners": vis, "n": n}


def state(st, n=4):
    t = time.time()
    return {"now": t, "station": summary(st, t), "items": [pub_track(st["tracks"][i], s, d) for i, s, d in window(st, t, n)]}


def all_summaries():
    t = time.time()
    return [summary(st, t) for st in sorted(stations.values(), key=lambda x: x["created"])]


def notify(sid):
    st = stations.get(sid)
    A.pres_put({"type": "radio", "station": summary(st)} if st else {"type": "radio", "gone": sid})


# ------------------------------------------------------------------ per gli utenti di questo server
def mine_or_404(sid):
    st = stations.get(sid)
    if not st:
        abort(A.app.make_response((jsonify(error="Questa radio non c'è più"), 404)))
    return st


def clean_tracks(items):
    out = []
    for x in items if isinstance(items, list) else []:
        if not isinstance(x, dict) or not F.SONG_RE.match(str(x.get("id") or "")):
            continue
        try:
            d = float(x.get("duration") or 0)
        except (TypeError, ValueError):
            continue
        if not 1 <= d <= 3 * 3600:
            continue  # senza durata il brano non si può mettere in orario
        t = {k: str(x[k])[:200] for k in TRACK_KEYS if isinstance(x.get(k), (str, int)) and k != "year"}
        if isinstance(x.get("year"), int):
            t["year"] = x["year"]
        out.append(dict(t, duration=round(d, 3)))
        if len(out) == MAX_TRACKS:
            break
    return out


@bp.get("/api/radio")
def radio_list():
    return jsonify(now=time.time(), stations=all_summaries())


@bp.post("/api/radio")
def radio_create():
    u, d = A.user_or_400(), request.get_json(silent=True) or {}
    if not g.who["admin"] and not g.who["perm"].get("radio", True):
        return jsonify(error="Creare stazioni non è abilitato per il tuo utente: chiedilo a chi gestisce il server."), 403
    tracks = clean_tracks(d.get("tracks"))
    if not tracks:
        return jsonify(error="Nessun brano da mettere in onda"), 400
    src = d.get("source") if isinstance(d.get("source"), dict) else {}
    source = {"kind": src.get("kind") if src.get("kind") in SOURCES else "libreria", "label": str(src.get("label") or "")[:100]}
    name = str(d.get("name") or "").strip()[:60] or "Radio di " + A.pres_who(u)[1]
    now, sid = time.time(), uuid.uuid4().hex[:12]
    st = {"id": sid, "name": name, "owner": u, "source": source, "created": now, "start": now, "seed": secrets.randbits(31), "paused": None, "tracks": tracks}
    db.run("INSERT INTO radio VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", sid, name, u, json.dumps(source), now, now, st["seed"], None, json.dumps(tracks))
    stations[sid] = st
    notify(sid)
    A.attivita(u, "radio", f"ha acceso la radio «{name}»", {"radio": sid})
    return jsonify(state(st)), 201


@bp.get("/api/radio/<sid>")
def radio_get(sid):
    return jsonify(state(mine_or_404(sid)))


@bp.put("/api/radio/<sid>")
def radio_edit(sid):
    st, d = mine_or_404(sid), request.get_json(silent=True) or {}
    if st["owner"] != g.who["user"] and not g.who["admin"]:
        return jsonify(error="Solo chi l'ha creata può cambiarla"), 403
    now = time.time()
    if "name" in d:
        st["name"] = str(d["name"] or "").strip()[:60] or st["name"]
    if d.get("on") is False and st["paused"] is None:
        st["paused"] = now - st["start"]
        with lock:
            listeners.pop(sid, None)  # ferma: nessuno la sta più ascoltando
    elif d.get("on") is True and st["paused"] is not None:
        st["start"], st["paused"] = now - st["paused"], None
    db.run("UPDATE radio SET name = ?, start = ?, paused = ? WHERE id = ?", st["name"], st["start"], st["paused"], sid)
    notify(sid)
    return jsonify(state(st))


@bp.delete("/api/radio/<sid>")
def radio_delete(sid):
    st = mine_or_404(sid)
    if st["owner"] != g.who["user"] and not g.who["admin"]:
        return jsonify(error="Solo chi l'ha creata può toglierla"), 403
    db.run("DELETE FROM radio WHERE id = ?", sid)
    stations.pop(sid, None)
    with lock:
        listeners.pop(sid, None)
    notify(sid)
    return jsonify(ok=True)


def listen_body():
    d = request.get_json(silent=True) or {}
    dev = str(d.get("device") or "")
    if not A.ID_RE.match(dev):
        abort(400)
    u = A.user_or_400()
    share, name = A.pres_who(u)
    return u, dev, d.get("on") is not False, (name if share else None)


@bp.post("/api/radio/<sid>/ascolta")
def radio_listen(sid):
    st = mine_or_404(sid)
    u, dev, on, name = listen_body()
    if on and st["paused"] is not None:
        return jsonify(error="La radio è ferma"), 409
    set_listener(sid, f"u:{u}|{dev}", {"name": name, "user": u, "server": None}, on)
    return jsonify(state(st))


# ------------------------------------------------------------------ fra server collegati
def node_off(n):
    """Scarto fra l'orologio del vicino e il mio (secondi, suo meno mio): tre campioni stile NTP, vale quello con
    l'andata e ritorno più breve; si rifà ogni due minuti."""
    c = clocks.get(n["id"])
    if c and time.time() - c[1] < 120:
        return c[0]
    best = None
    for _ in range(3):
        t0 = time.time()
        j = F.fed_json(n, "GET", "/fed/v1/ora", timeout=5)
        t1 = time.time()
        if best is None or t1 - t0 < best[0]:
            best = (t1 - t0, float(j.get("t") or 0) - (t0 + t1) / 2)
    clocks[n["id"]] = (best[1], time.time())
    return best[1]


def shift(j, off):
    # istanti del vicino portati sul mio orologio
    for x in [j.get("station", {}).get("now")] + list(j.get("items") or []):
        if isinstance(x, dict) and isinstance(x.get("start"), (int, float)):
            x["start"] = round(x["start"] - off, 3)
    j["now"] = time.time()
    return j


def own_net():
    # le mie stazioni come le vede un altro server: solo quelle in onda, con chi le ha create e dove stanno
    t = time.time()
    return [dict(summary(st, t), path=[]) for st in stations.values() if st["paused"] is None]


def net_radio(ttl, skip, requester, rid, deadline):
    """Le stazioni dei vicini (e dei loro vicini finché restano salti), con gli istanti sul mio orologio."""
    F.seen_rids[rid] = time.time()
    near = [n for n in (F.pullable() if requester is None else F.visible_to(requester)) if n["id"] not in skip]
    out = own_net() if requester is not None else []
    if ttl < 1 or not near:
        return out
    nskip = set(skip) | {F.ME} | {n["id"] for n in F.nodes()}
    for n, j in F.forward("/fed/v1/radio", {"rid": rid, "ttl": ttl - 1}, near, deadline, nskip):
        try:
            off = node_off(n)
        except F.FedError:
            off = 0.0
        info = {"id": n["id"], "name": n["name"], "owner": n["owner"] or ""}
        for x in j.get("stations") or []:
            if not (isinstance(x, dict) and isinstance(x.get("path"), list) and all(isinstance(p, str) and F.NODE_RE.match(p) for p in x["path"])):
                continue
            x["path"] = [n["id"]] + x["path"]
            if isinstance(x.get("now"), dict) and isinstance(x["now"].get("start"), (int, float)):
                x["now"]["start"] = round(x["now"]["start"] - off, 3)
            x.setdefault("node", info)
            out.append(x)
    return out


@F.bp.post("/fed/v1/radio")
def fed_radio_list():
    d, rid, skip, ttl, deadline = F.take_body()
    if not rid or rid in F.seen_rids:
        return jsonify(stations=[], dup=True)
    me = {"id": F.ME, "name": A.NAME, "owner": F.owner()}
    sts = net_radio(ttl, skip, g.fed_node["id"], rid, deadline)
    for x in sts:
        x.setdefault("node", me)
    return jsonify(stations=sts)


def remote_state(sid, via, listen=None):
    """Stato della stazione sid: mia se via è vuoto, altrimenti chiesto al prossimo nodo e portato sul mio orologio."""
    hop, rest = F.next_hop(via)
    if hop:
        path = f"/fed/v1/radio/{sid}" + ("/ascolta" if listen is not None else "")
        j = F.fed_json(hop, "GET" if listen is None else "POST", path, params={"via": rest}, body=listen, timeout=10)
        return shift(j, node_off(hop))
    st = stations.get(sid)
    if not st or st["paused"] is not None:
        raise F.FedError("Questa radio non è in onda", 404)
    if listen is not None:
        k = "n:" + str(listen.get("key") or "")[:120]
        set_listener(sid, k, {"name": (str(listen["name"])[:30] if listen.get("name") else None), "user": str(listen.get("user") or "")[:80],
                              "server": str(listen.get("server") or "")[:60]}, listen.get("on") is not False)
    return state(st)


def sid_ok(sid):
    if not F.SONG_RE.match(sid):
        abort(400)


@F.bp.get("/fed/v1/radio/<sid>")
def fed_radio_get(sid):
    sid_ok(sid)
    try:
        return jsonify(remote_state(sid, F.parse_via(request.args.get("via"))))
    except F.FedError as e:
        return jsonify(error=str(e)), e.status


@F.bp.post("/fed/v1/radio/<sid>/ascolta")
def fed_radio_listen(sid):
    sid_ok(sid)
    d = request.get_json(silent=True) or {}
    # chiave, nome e server li mette il server di chi ascolta; chi sta in mezzo li passa così come sono
    body = {k: d.get(k) for k in ("key", "name", "user", "server", "on")}
    try:
        return jsonify(remote_state(sid, F.parse_via(request.args.get("via")), listen=body))
    except F.FedError as e:
        return jsonify(error=str(e)), e.status


@F.bp.get("/fed/v1/ora")
def fed_clock():
    return jsonify(t=time.time())


@bp.get("/api/rete/radio")
def rete_radio():
    t0 = time.time()
    sts = net_radio(F.hops(), set(), None, uuid.uuid4().hex, t0 + F.SEARCH_MS / 1000)
    best = {}
    for x in sorted(sts, key=lambda x: len(x["path"])):
        best.setdefault((x["path"][-1], x.get("id")), x)  # la stessa stazione da due strade: la più corta
    return jsonify(now=time.time(), stations=list(best.values()), ms=round((time.time() - t0) * 1000))


@bp.get("/api/rete/radio/<sid>")
def rete_radio_get(sid):
    sid_ok(sid)
    try:
        return jsonify(remote_state(sid, F.route_arg()))
    except F.FedError as e:
        return jsonify(error=str(e)), e.status


@bp.post("/api/rete/radio/<sid>/ascolta")
def rete_radio_listen(sid):
    sid_ok(sid)
    u, dev, on, name = listen_body()
    body = {"key": f"{F.ME}:{u}|{dev}", "name": name, "user": f"{u}@{A.NAME}", "server": A.NAME, "on": on}
    try:
        return jsonify(remote_state(sid, F.route_arg(), listen=body))
    except F.FedError as e:
        return jsonify(error=str(e)), e.status


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)


def start():
    load()
    threading.Thread(target=gc, daemon=True).start()
