"""
Armony - ascolti contati dal server (capacità "ascolti").

  GET /api/ascolti/brano?id=…[&dz=1]   ascolti di un brano: in tutto, tuoi, per utente; con dz=1 anche l'indice di
                                       popolarità di Deezer (un punteggio, non il numero di stream: quello non è pubblico)
  GET /api/ascolti/brani?ids=a,b,…     solo i totali, per mostrarli accanto ai brani di un album o di un artista
  GET /api/ascolti/server?days=30      il riepilogo del server: ascolti per utente, brani e artisti più ascoltati, minuti, gli ultimi ascolti

─── PERCHÉ dal DB di Navidrome ───
Ogni client (Armony, Symfonium, Tempo…) segnala gli ascolti a Navidrome con scrobble: la tabella scrobbles ha brano,
utente e istante di ognuno, annotation il totale per utente. Lo storico di Armony vede solo i client di Armony con la
sincronizzazione accesa. Chi ha spento «Mostra agli altri cosa ascolto» conta nei totali ma non compare per nome
(salvo a sé stesso e all'amministratore).
"""
import sqlite3
import time
import urllib.parse

from flask import Blueprint, g, jsonify, request

import metadati

bp = Blueprint("ascolti", __name__)
A = None


def nd():
    return sqlite3.connect(f"file:{A.NAVIDROME_DB}?mode=ro", uri=True, timeout=10)


def shown(user):
    me = g.who.get("user") or ""
    return g.who["admin"] or user.lower() == me.lower() or A.pres_who(user)[0]


@bp.get("/api/ascolti/brano")
def brano():
    sid = request.args.get("id") or ""
    if not A.ID_RE.match(sid):
        return jsonify(error="Brano non valido"), 400
    c = nd()
    try:
        rows = c.execute("SELECT u.user_name, a.play_count, a.play_date FROM annotation a JOIN user u ON u.id = a.user_id "
                         "WHERE a.item_type = 'media_file' AND a.item_id = ? AND a.play_count > 0 ORDER BY a.play_count DESC", (sid,)).fetchall()
        song = c.execute("SELECT title, artist FROM media_file WHERE id = ?", (sid,)).fetchone()
    finally:
        c.close()
    me = (g.who.get("user") or "").lower()
    out = dict(total=sum(r[1] for r in rows), you=next((r[1] for r in rows if r[0].lower() == me), 0),
               users=[{"user": r[0], "name": A.pres_who(r[0])[1], "plays": r[1], "last": r[2]} for r in rows if shown(r[0])],
               hidden=sum(r[1] for r in rows if not shown(r[0])))
    if request.args.get("dz") == "1" and song:
        q = urllib.parse.quote(f'artist:"{song[1]}" track:"{song[0]}"')
        hit = next(iter((metadati.deezer("search/track?limit=3&q=" + q) or {}).get("data") or []), None)
        if hit and metadati.norm(hit.get("title")) == metadati.norm(song[0]):
            out["deezer"] = {"rank": hit.get("rank"), "link": hit.get("link")}
    return jsonify(out)


@bp.get("/api/ascolti/brani")
def brani():
    ids = [i for i in (request.args.get("ids") or "").split(",") if A.ID_RE.match(i)][:500]
    if not ids:
        return jsonify({})
    c = nd()
    try:
        rows = c.execute("SELECT item_id, sum(play_count) FROM annotation WHERE item_type = 'media_file' AND item_id IN "
                         f"({','.join('?' * len(ids))}) GROUP BY item_id", ids).fetchall()
    finally:
        c.close()
    return jsonify({r[0]: r[1] for r in rows if r[1]})


@bp.get("/api/ascolti/server")
def server():
    days = max(1, min(int(request.args.get("days", 30) or 30), 3650))
    since = time.time() - days * 86400
    c = nd()
    try:
        # submission_time: secondi (Navidrome recente) o una data testuale: si confronta come numero se lo è
        sc = c.execute("SELECT typeof(submission_time) FROM scrobbles LIMIT 1").fetchone()
        cond, arg = ("s.submission_time >= ?", since) if not sc or sc[0] in ("integer", "real") else ("s.submission_time >= ?", time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(since)))
        per = c.execute(f"SELECT u.user_name, count(*), max(s.submission_time) FROM scrobbles s JOIN user u ON u.id = s.user_id WHERE {cond} "
                        "GROUP BY u.user_name ORDER BY count(*) DESC", (arg,)).fetchall()
        top = c.execute(f"SELECT m.id, m.title, m.artist, m.album, m.album_id, count(*) n, count(DISTINCT s.user_id) FROM scrobbles s JOIN media_file m ON m.id = s.media_file_id "
                        f"WHERE {cond} GROUP BY m.id ORDER BY n DESC LIMIT 20", (arg,)).fetchall()
        recent = c.execute("SELECT u.user_name, m.id, m.title, m.artist, m.album_id, s.submission_time FROM scrobbles s JOIN user u ON u.id = s.user_id "
                           "JOIN media_file m ON m.id = s.media_file_id ORDER BY s.submission_time DESC LIMIT 200").fetchall()
        allt = c.execute("SELECT count(*) FROM scrobbles").fetchone()[0]
        # per l'immagine «Il nostro mese»: minuti e artisti di tutti
        mins = c.execute(f"SELECT coalesce(sum(m.duration), 0) / 60 FROM scrobbles s JOIN media_file m ON m.id = s.media_file_id WHERE {cond}", (arg,)).fetchone()[0]
        arts = c.execute(f"SELECT m.artist, count(*) n FROM scrobbles s JOIN media_file m ON m.id = s.media_file_id WHERE {cond} "
                         "GROUP BY m.artist ORDER BY n DESC LIMIT 10", (arg,)).fetchall()
    finally:
        c.close()
    ts = lambda v: v if isinstance(v, (int, float)) else time.mktime(time.strptime(str(v)[:19], "%Y-%m-%d %H:%M:%S")) if v else None
    users = [{"user": u, "name": A.pres_who(u)[1], "plays": n, "last": ts(last)} for u, n, last in per if shown(u)]
    return jsonify(days=days, total=sum(r[1] for r in per), ever=allt, minutes=round(mins), artists=[{"artist": a, "plays": n} for a, n in arts if a], users=users, others=sum(r[1] for r in per if not shown(r[0])),
                   top=[{"id": r[0], "title": r[1], "artist": r[2], "album": r[3], "albumId": r[4], "plays": r[5], "listeners": r[6]} for r in top],
                   recent=[{"user": r[0], "name": A.pres_who(r[0])[1], "id": r[1], "title": r[2], "artist": r[3], "albumId": r[4], "at": ts(r[5])}
                           for r in recent if shown(r[0])][:60])


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)
