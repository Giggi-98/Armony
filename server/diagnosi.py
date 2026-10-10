"""
Armony - diagnosi: registro degli eventi e stato del server (solo amministratori).

  /api/log        POST: i client mandano i loro errori e le ambiguità (qualsiasi utente, a lotti, con un limite);
                  GET: il registro, con filtri; GET /api/log/testo: lo stesso in testo semplice, da incollare;
                  DELETE: svuota (amministratore, con le regole delle impostazioni del server)
  /api/stato      risorse del server: CPU, memoria, carico, disco, rete, thread di waitress, flussi audio in corso,
                  dispositivi collegati, coda dei download. Ultima ora a 5 s, ultime 24 ore a 1 minuto

─── PERCHÉ un registro nostro e non i log del container ───
I log di Docker si leggono solo dal server, si perdono a ogni ricreazione e non vedono gli errori dei telefoni.
Qui finiscono le eccezioni non gestite del server (rotte, thread, waitress), gli errori JavaScript dei client e
le ambiguità che il codice risolve da solo ma che vale la pena guardare (un brano scelto con poca somiglianza,
un abbinamento incerto). Lo stesso messaggio ripetuto diventa una riga con il contatore: il registro resta corto.
"""
import collections
import hashlib
import json
import os
import shutil
import sys
import threading
import time
import traceback
import logging

from flask import Blueprint, Response, g, jsonify, request
from werkzeug.exceptions import HTTPException

import db

bp = Blueprint("diagnosi", __name__)
A = None  # il modulo app (init)
LEVELS = ("info", "avviso", "errore")
KEEP_ROWS, KEEP_DAYS = 5000, 30
GROUP = 3600  # lo stesso messaggio entro un'ora si somma alla riga che c'è
_last = {}    # firma → (id della riga, istante): niente letture del DB per i ripetuti
_lock = threading.Lock()
_client_rate = {}  # utente → istanti degli ultimi eventi mandati (al più 300 l'ora)


def log(level, area, msg, detail="", user=None, dev=None, src="server"):
    """Un evento nel registro. Non solleva mai: il registro non deve rompere chi lo usa."""
    try:
        level = level if level in LEVELS else "info"
        area, msg, detail = str(area or "server")[:40], str(msg or "")[:500], str(detail or "")[:8000]
        sig = hashlib.sha1(f"{src}|{level}|{area}|{msg}|{user or ''}".encode()).hexdigest()[:16]
        now = time.time()
        with _lock:
            prev = _last.get(sig)
            if prev and now - prev[1] < GROUP:
                db.run("UPDATE log SET n = n + 1, last = ?, detail = ?, dev = coalesce(?, dev) WHERE id = ?", now, detail, dev, prev[0])
                _last[sig] = (prev[0], prev[1])
                return
            c = db.conn().execute("INSERT INTO log (ts, last, n, level, area, msg, detail, user, dev, src, sig) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)",
                                  (now, now, level, area, msg, detail, user, dev, src, sig))
            _last[sig] = (c.lastrowid, now)
            if len(_last) > 4000:
                _last.clear()
        if c.lastrowid % 200 == 0:
            db.run("DELETE FROM log WHERE last < ? OR id <= ?", now - KEEP_DAYS * 86400, c.lastrowid - KEEP_ROWS)
        if level == "errore":
            print(f"[{area}] {msg}", file=sys.stderr, flush=True)
    except Exception:  # noqa: BLE001
        pass


def errore(area, msg, exc=None, **kw):
    log("errore", area, msg, "".join(traceback.format_exception(exc)) if exc else "", **kw)


def avviso(area, msg, detail="", **kw):
    log("avviso", area, msg, detail, **kw)


class _Handler(logging.Handler):
    # waitress (coda piena, thread esauriti), urllib3 e il resto del modulo logging
    def emit(self, record):
        if record.levelno < logging.WARNING:
            return
        exc = "".join(traceback.format_exception(*record.exc_info)) if record.exc_info else ""
        log("errore" if record.levelno >= logging.ERROR else "avviso", record.name.split(".")[0], record.getMessage(), exc)


def _hooks():
    logging.getLogger().addHandler(_Handler())
    logging.getLogger().setLevel(logging.WARNING)
    old = sys.excepthook

    def exc_hook(t, v, tb):
        log("errore", "server", f"{t.__name__}: {v}", "".join(traceback.format_exception(t, v, tb)))
        old(t, v, tb)
    sys.excepthook = exc_hook
    threading.excepthook = lambda a: log("errore", "thread", f"{a.exc_type.__name__} in {getattr(a.thread, 'name', '?')}: {a.exc_value}",
                                         "".join(traceback.format_exception(a.exc_type, a.exc_value, a.exc_traceback)))


def _route_error(e):
    if isinstance(e, HTTPException):
        return e
    who = getattr(g, "who", None) or {}
    log("errore", "rotta", f"{request.method} {request.path}: {type(e).__name__}: {e}", "".join(traceback.format_exception(e)),
        user=who.get("user"), dev=who.get("dev"))
    return jsonify(error="Errore interno del server: è stato annotato nel registro eventi."), 500


# ------------------------------------------------------------------ rotte del registro
@bp.post("/api/log")
def log_post():
    d = request.get_json(silent=True) or {}
    items = d.get("events") if isinstance(d.get("events"), list) else []
    u, now = g.who.get("user"), time.time()
    recent = [t for t in _client_rate.get(u, []) if now - t < 3600]
    taken = 0
    for x in items[:50]:
        if len(recent) >= 300 or not isinstance(x, dict):
            break
        detail = {k: str(x[k])[:3000] for k in ("detail", "url", "ua", "app", "stack") if x.get(k)}
        log(x.get("level") if x.get("level") in LEVELS else "errore", "client:" + str(x.get("area") or "app")[:30], x.get("msg"),
            json.dumps(detail, ensure_ascii=False), user=u, dev=g.who.get("dev") or str(x.get("device") or "")[:40] or None, src="client")
        recent.append(now)
        taken += 1
    _client_rate[u] = recent
    return jsonify(ok=True, taken=taken)


def _rows(args, limit):
    where, par = [], []
    if args.get("level") in LEVELS:
        where.append("level = ?"); par.append(args["level"])
    if args.get("src") in ("server", "client"):
        where.append("src = ?"); par.append(args["src"])
    if args.get("area"):
        where.append("area LIKE ?"); par.append(args["area"][:40] + "%")
    if args.get("q"):
        where.append("(msg LIKE ? OR detail LIKE ?)"); par += ["%" + args["q"][:100] + "%"] * 2
    if str(args.get("since") or "").replace(".", "").isdigit():
        where.append("last >= ?"); par.append(float(args["since"]))
    sql = "SELECT * FROM log" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY last DESC LIMIT ?"
    return [dict(r) for r in db.all_(sql, *par, limit)]


@bp.get("/api/log")
def log_get():
    if not g.who["admin"]:
        return jsonify(error="Serve un amministratore."), 403
    rows = _rows(request.args, max(1, min(int(request.args.get("limit", 200) or 200), 1000)))
    for r in rows:
        r.pop("sig", None)
    day = time.time() - 86400
    counts = {r["level"]: r["c"] for r in db.all_("SELECT level, sum(n) c FROM log WHERE last >= ? GROUP BY level", day)}
    areas = [r["area"] for r in db.all_("SELECT area FROM log GROUP BY area ORDER BY max(last) DESC LIMIT 40")]
    return jsonify(items=rows, day=counts, areas=areas)


@bp.get("/api/log/testo")
def log_text():
    if not g.who["admin"]:
        return jsonify(error="Serve un amministratore."), 403
    rows = _rows(request.args, 500)
    t = lambda x: time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(x))
    out = [f"Armony {A.VERSION} · registro eventi · {t(time.time())}", ""]
    for r in rows:
        out.append(f"[{t(r['last'])}] {r['level'].upper()} {r['area']} ×{r['n']}{' (dal ' + t(r['ts']) + ')' if r['n'] > 1 else ''}"
                   f"{' · ' + r['user'] if r['user'] else ''}{' · ' + r['dev'] if r['dev'] else ''}\n  {r['msg']}")
        if r["detail"]:
            out.append("  " + r["detail"].strip().replace("\n", "\n  "))
    return Response("\n".join(out) + "\n", mimetype="text/plain; charset=utf-8")


@bp.delete("/api/log")
def log_clear():
    if not g.who["admin"]:
        return jsonify(error="Serve un amministratore."), 403
    if not A.dispositivi.can_change(g.who):
        return A.dispositivi.refuse_change()
    db.run("DELETE FROM log")
    with _lock:
        _last.clear()
    return jsonify(ok=True)


# ------------------------------------------------------------------ stato del server
STEP = 5
fast = collections.deque(maxlen=3600 // STEP)   # ultima ora
slow = collections.deque(maxlen=1440)           # ultime 24 ore, un punto al minuto
active = {}                                      # richiesta in corso → {kind, t0}
flussi = {}                                      # flusso audio in corso → {user, id, fmt, t0, bytes}
_alock = threading.Lock()
_prev = {}
_alerts = {}  # tipo → istante dell'ultimo avviso nel registro


def kind_of(path):
    if path.startswith("/api/live") and not path.startswith(("/api/live/state", "/api/live/beat", "/api/live/cmd", "/api/live/privacy")):
        return "live"
    if path.startswith(("/rest/stream", "/rest/download", "/api/rete/stream")):
        return "audio"
    if "/recv" in path and path.startswith("/api/jam/"):
        return "jam"
    return "altro"


def req_start():
    g._diag = id(request._get_current_object())
    with _alock:
        active[g._diag] = {"kind": kind_of(request.path), "t0": time.time(), "path": request.path}


def req_end(_exc=None):
    k = getattr(g, "_diag", None)
    if k is not None:
        with _alock:
            active.pop(k, None)


_seq = iter(range(1, 1 << 62))


def flusso_apri(user, tid, fmt):
    with _alock:
        k = next(_seq)
        flussi[k] = {"user": user, "id": tid, "fmt": fmt, "t0": time.time(), "bytes": 0}
    return k


def flusso_byte(k, n):
    f = flussi.get(k)
    if f:
        f["bytes"] += n


def flusso_chiudi(k):
    with _alock:
        flussi.pop(k, None)


def _read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


def _iface():
    # l'interfaccia della rotta predefinita: con la rete "host" è quella vera del server (le altre sono docker e lo)
    for line in _read("/proc/net/route").splitlines()[1:]:
        p = line.split()
        if len(p) > 2 and p[1] == "00000000":
            return p[0]
    return None


def _sample():
    now = time.time()
    cpu = [int(x) for x in (_read("/proc/stat").splitlines() or ["cpu 0"])[0].split()[1:]]
    idle, total = (cpu[3] + (cpu[4] if len(cpu) > 4 else 0)) if len(cpu) > 3 else 0, sum(cpu)
    mi = {l.split(":")[0]: int(l.split()[1]) * 1024 for l in _read("/proc/meminfo").splitlines() if l.split()[1:2] and l.split()[1].isdigit()}
    st = _read("/proc/self/stat").rsplit(")", 1)[-1].split()
    me = int(st[11]) + int(st[12]) if len(st) > 12 else 0
    status = {l.split(":")[0]: l.split(":", 1)[1].strip() for l in _read("/proc/self/status").splitlines() if ":" in l}
    ifc, rx, tx = _iface(), 0, 0
    for line in _read("/proc/net/dev").splitlines()[2:]:
        name, _, rest = line.partition(":")
        if name.strip() == ifc:
            v = rest.split()
            rx, tx = int(v[0]), int(v[8])
    p = _prev
    dt = now - p.get("t", now) or STEP
    hz = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
    s = {"t": round(now),
         "cpu": round(100 * (1 - (idle - p["idle"]) / max(1, total - p["total"])), 1) if "total" in p else 0,
         "app": round(100 * (me - p["me"]) / hz / dt / (os.cpu_count() or 1), 1) if "me" in p else 0,
         "mem": round(100 * (1 - mi.get("MemAvailable", 0) / max(1, mi.get("MemTotal", 1))), 1),
         "rss": int(status.get("VmRSS", "0 kB").split()[0]) * 1024,
         "load": float((_read("/proc/loadavg").split() or ["0"])[0]),
         "rx": max(0, round((rx - p["rx"]) / dt)) if "rx" in p else 0,
         "tx": max(0, round((tx - p["tx"]) / dt)) if "tx" in p else 0}
    _prev.update(t=now, idle=idle, total=total, me=me, rx=rx, tx=tx)
    with _alock:
        kinds = collections.Counter(a["kind"] for a in active.values())
        s.update(req=len(active), audio=len(flussi), live=kinds["live"], jam=kinds["jam"])
    s["jobs"] = A.jq.qsize()
    return s


def _alert(kind, cond, msg):
    if cond and time.time() - _alerts.get(kind, 0) > 600:
        _alerts[kind] = time.time()
        avviso("stato", msg)


def _loop():
    minute = []
    while True:
        time.sleep(STEP)
        try:
            s = _sample()
            fast.append(s)
            minute.append(s)
            if len(minute) * STEP >= 60:
                avg = {k: round(sum(x[k] for x in minute) / len(minute), 1) for k in s if k != "t"}
                slow.append({"t": s["t"], **avg, "req": max(x["req"] for x in minute), "audio": max(x["audio"] for x in minute)})
                minute = []
                last = list(fast)[-12:]
                _alert("cpu", len(last) == 12 and min(x["cpu"] for x in last) > 90, f"CPU sopra il 90% da un minuto ({s['cpu']}%)")
                _alert("mem", s["mem"] > 92, f"Memoria quasi finita: {s['mem']}% usata")
                _alert("thread", s["req"] > A.THREADS * 0.8, f"{s['req']} richieste aperte su {A.THREADS} thread di waitress: il server è vicino al limite")
                d = shutil.disk_usage(A.MUSIC_DIR)
                _alert("disco", d.free < d.total * 0.04, f"Disco quasi pieno: liberi {d.free // 2**30} GB")
        except Exception as e:  # noqa: BLE001
            errore("stato", f"campionamento non riuscito: {e}", e)


def _titles(ids):
    try:
        import sqlite3
        nd = sqlite3.connect(f"file:{A.NAVIDROME_DB}?mode=ro", uri=True, timeout=5)
        try:
            return {r[0]: (r[1], r[2]) for r in nd.execute(f"SELECT id, title, artist FROM media_file WHERE id IN ({','.join('?' * len(ids))})", list(ids))}
        finally:
            nd.close()
    except Exception:  # noqa: BLE001
        return {}


@bp.get("/api/stato")
def stato():
    now = time.time()
    with _alock:
        fl = [dict(f) for f in flussi.values()]
        reqs = collections.Counter(a["kind"] for a in active.values())
    names = _titles({f["id"] for f in fl if f.get("id")}) if fl else {}
    with A.llock:
        devs = [{"user": u, "name": c["name"], "net": c.get("net"), "since": round(now - c.get("t0", now))}
                for u, conns in A.lconns.items() for c in conns.values()]
    with A.jlock:
        st = collections.Counter(j["status"] for j in A.jobs.values())
    d = shutil.disk_usage(A.MUSIC_DIR)
    mi = {l.split(":")[0]: int(l.split()[1]) * 1024 for l in _read("/proc/meminfo").splitlines() if l.split()[1:2] and l.split()[1].isdigit()}
    up = float((_read("/proc/uptime").split() or ["0"])[0])
    nd_ms = None
    try:
        t0 = time.time()
        A.http.get(f"{A.NAVIDROME_URL}/rest/ping", timeout=3)
        nd_ms = round((time.time() - t0) * 1000)
    except Exception:  # noqa: BLE001
        pass
    return jsonify(
        now=now, version=A.VERSION, cores=os.cpu_count(), threads=A.THREADS, started=A.STARTED, uptime=up, navidrome_ms=nd_ms,
        mem={"total": mi.get("MemTotal"), "available": mi.get("MemAvailable")},
        disk={"total": d.total, "used": d.used, "free": d.free},
        requests=dict(reqs), live=devs,
        streams=[{"user": f["user"], "title": (names.get(f["id"]) or (None,))[0], "artist": (names.get(f["id"]) or (None, None))[1], "fmt": f["fmt"],
                  "since": round(now - f["t0"]), "bytes": f["bytes"], "kbps": round(f["bytes"] * 8 / 1000 / max(1, now - f["t0"]))} for f in fl],
        jobs={"queue": A.jq.qsize(), "byStatus": dict(st), "ytPause": max(0, round(A.yt["pausa"] - now))},
        fast=list(fast), slow=list(slow))


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)
    flask_app.register_error_handler(Exception, _route_error)
    flask_app.before_request(req_start)
    flask_app.teardown_request(req_end)
    _hooks()


def start():
    threading.Thread(target=_loop, daemon=True, name="stato").start()
