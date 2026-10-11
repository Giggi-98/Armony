"""
Armony - la libreria: playlist intelligenti, salute della libreria, testi cercati dal server (piano 3, C1 C2 C5).

  POST /api/playlist/intelligente        {name, comment, rules}: una playlist che si aggiorna da sola (regole di Navidrome)
  GET  /api/playlist/intelligente/<id>   le sue regole, per modificarle (solo il proprietario)
  PUT  /api/playlist/intelligente/<id>   {name, comment, rules}
  GET  /api/salute                       solo amministratori: doppioni, brani con titolo o artista mancante, generi presi
                                         dalle categorie di YouTube, album spezzati, testi (quanti, e il giro in sottofondo)
  POST /api/salute/generi                {ids}: toglie i generi che sono categorie di YouTube, lascia gli altri
  POST /api/salute/unisci                {album: [id…]}: stesso anno e stesso artista dell'album per tutti, così Navidrome
                                         li rimette insieme
  PUT  /api/salute/testi                 {on}: il giro dei testi acceso o spento

─── PERCHÉ le regole le valuta Navidrome ───
Navidrome sa già fare le playlist intelligenti (i file .nsp, e il campo `rules` della sua API): le aggiorna da solo e le
vedono anche le app Subsonic. Armony le crea come amministratore e poi le passa all'utente (ownerId), perché «preferiti»,
«ascolti» e «valutazione» valgono per il proprietario.
─── PERCHÉ i testi come file .lrc ───
Navidrome legge un .lrc accanto al brano (sincronizzato) e lo dà a tutti: telefoni, app Subsonic, offline. Il giro chiede
a LRCLIB (gratuito, senza account) un brano ogni 2 secondi, solo per i brani senza testo, e si ricorda chi non l'ha.
"""
import json
import os
import re
import threading
import time
import unicodedata
import urllib.parse

import requests
from flask import Blueprint, g, jsonify, request

import db

bp = Blueprint("libreria", __name__)
A = None

# ------------------------------------------------------------------ playlist intelligenti
# campo → tipo; i nomi sono quelli dei criteri di Navidrome
CAMPI = {"title": "testo", "artist": "testo", "albumartist": "testo", "album": "testo", "genre": "testo", "comment": "testo",
         "filetype": "testo", "year": "numero", "playcount": "numero", "rating": "numero", "duration": "numero", "bitrate": "numero",
         "dateadded": "data", "lastplayed": "data", "dateloved": "data", "loved": "vero"}
OPERATORI = {"testo": {"contains", "notContains", "is", "isNot", "startsWith", "endsWith"},
             "numero": {"is", "isNot", "gt", "lt", "inTheRange"},
             "data": {"inTheLast", "notInTheLast", "before", "after"},
             "vero": {"is", "isNot"}}
ORDINI = {"title", "artist", "album", "year", "dateadded", "lastplayed", "playcount", "rating", "duration", "random"}


def regole_valide(r):
    """Solo campi, operatori e valori conosciuti: le regole vanno a Navidrome così come sono."""
    if not isinstance(r, dict):
        raise ValueError("Regole non valide")
    tipo = "all" if "all" in r else "any"
    conds = r.get(tipo)
    if not isinstance(conds, list) or not 1 <= len(conds) <= 20:
        raise ValueError("Serve almeno una regola (al più 20)")
    out = []
    for c in conds:
        if not isinstance(c, dict) or len(c) != 1:
            raise ValueError("Regola non valida")
        op, kv = next(iter(c.items()))
        if not isinstance(kv, dict) or len(kv) != 1:
            raise ValueError("Regola non valida")
        campo, v = next(iter(kv.items()))
        t = CAMPI.get(campo)
        if not t or op not in OPERATORI[t]:
            raise ValueError(f"Regola non valida: {campo} {op}")
        if t == "testo":
            v = str(v)[:100]
        elif t == "vero":
            v = bool(v)
        elif op == "inTheRange":
            if not isinstance(v, list) or len(v) != 2:
                raise ValueError("Un intervallo vuole due numeri")
            v = [float(v[0]), float(v[1])]
        elif t == "data" and op in ("inTheLast", "notInTheLast"):
            v = max(1, min(int(v), 3650))
        elif t == "data":
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(v)):
                raise ValueError("Data non valida (AAAA-MM-GG)")
            v = str(v)
        else:
            v = float(v)
        out.append({op: {campo: v}})
    res = {tipo: out}
    if r.get("sort") in ORDINI:
        res["sort"] = r["sort"]
        res["order"] = "desc" if r.get("order") == "desc" else "asc"
    if r.get("limit"):
        res["limit"] = max(1, min(int(r["limit"]), 5000))
    return res


def nd_id(user):
    return next((u["id"] for u in A.federazione.nd_native("GET", "/api/user") or [] if u.get("userName", "").lower() == user.lower()), None)


def mia(pid):
    own = A.importa.owner_of(pid) if A.ID_RE.match(pid) else None
    return own is not None and (g.who["admin"] or own.lower() == (g.who.get("user") or "").lower())


def puo_fare():
    if not g.who.get("user"):
        return "L'accesso d'emergenza non è un utente: entra con il tuo"
    if not g.who["admin"] and not g.who["perm"].get("playlist", True):
        return "«Crea e modifica playlist» non è abilitato per il tuo utente."
    return None


@bp.post("/api/playlist/intelligente")
def crea():
    no = puo_fare()
    if no:
        return jsonify(error=no), 403
    d = request.get_json(silent=True) or {}
    name = str(d.get("name") or "").strip()[:120]
    if not name:
        return jsonify(error="Serve un nome"), 400
    try:
        rules = regole_valide(d.get("rules"))
        uid = nd_id(g.who["user"])
        if not uid:
            return jsonify(error="Utente non trovato in Navidrome"), 404
        body = {"name": name, "comment": str(d.get("comment") or "")[:300], "rules": rules}
        pid = A.federazione.nd_native("POST", "/api/playlist", json=body)["id"]
        A.federazione.nd_native("PUT", f"/api/playlist/{pid}", json=dict(body, id=pid, ownerId=uid))  # sua: preferiti e ascolti sono i suoi
    except ValueError as e:
        return jsonify(error=str(e)), 400
    except (requests.RequestException, A.federazione.FedError) as e:
        return jsonify(error=f"Navidrome non ha accettato la playlist: {e}"[:200]), 502
    return jsonify(ok=True, id=pid), 201


@bp.get("/api/playlist/intelligente/<pid>")
def leggi(pid):
    if not mia(pid):
        return jsonify(error="Non è una tua playlist"), 403
    c = A.importa.nd()
    try:
        r = c.execute("SELECT name, comment, rules FROM playlist WHERE id = ?", (pid,)).fetchone()
    finally:
        c.close()
    if not r or not r[2]:
        return jsonify(error="Non è una playlist intelligente"), 404
    return jsonify(id=pid, name=r[0], comment=r[1] or "", rules=json.loads(r[2]))


@bp.put("/api/playlist/intelligente/<pid>")
def modifica(pid):
    no = puo_fare()
    if no:
        return jsonify(error=no), 403
    if not mia(pid):
        return jsonify(error="Non è una tua playlist"), 403
    d = request.get_json(silent=True) or {}
    try:
        rules = regole_valide(d.get("rules"))
        uid = nd_id(A.importa.owner_of(pid))
        A.federazione.nd_native("PUT", f"/api/playlist/{pid}", json={"id": pid, "name": str(d.get("name") or "Playlist").strip()[:120],
                                "comment": str(d.get("comment") or "")[:300], "rules": rules, "ownerId": uid})
    except ValueError as e:
        return jsonify(error=str(e)), 400
    except (requests.RequestException, A.federazione.FedError) as e:
        return jsonify(error=f"Navidrome non ha accettato le regole: {e}"[:200]), 502
    return jsonify(ok=True)


# ------------------------------------------------------------------ salute della libreria
GENERI_YT = {"people & blogs", "gaming", "entertainment", "music", "film & animation", "comedy", "education", "howto & style",
             "news & politics", "science & technology", "sports", "travel & events", "autos & vehicles", "pets & animals",
             "nonprofits & activism"}
VUOTI = {"", "na", "n/a", "unknown", "unknown artist", "[unknown]", "sconosciuto", "artista sconosciuto"}
# fra parentesi conta ciò che cambia il brano (Slowed, Remix, Live…); si toglie solo ciò che non lo cambia
RUMORE = re.compile(r"\s*[\(\[](?:official[^\)\]]*|lyrics?[^\)\]]*|audio|video|hq|hd|remaster(?:ed)?[^\)\]]*|\d{4} remaster[^\)\]]*)[\)\]]|\s+feat\..*$|\s+ft\..*$", re.I)


def chiave(s):
    s = RUMORE.sub("", str(s or ""))
    s = unicodedata.normalize("NFKD", s.replace("+", " plus ")).encode("ascii", "ignore").decode().lower()  # «Slowed++» non è «Slowed»
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


@bp.get("/api/salute")
def salute():
    c = A.importa.nd()
    try:
        songs = c.execute("SELECT id, title, artist, album, album_id, duration, bit_rate, suffix, path, lyrics FROM media_file WHERE missing = 0").fetchall()
        gen = c.execute("SELECT m.id, t.tag_value FROM media_file_tags mt JOIN tag t ON t.id = mt.tag_id JOIN media_file m ON m.id = mt.media_file_id "
                        "WHERE t.tag_name = 'genre' AND m.missing = 0").fetchall()
        split = c.execute("SELECT lower(name), lower(album_artist), group_concat(id), group_concat(coalesce(min_year, 0)), count(*), max(name), max(album_artist) "
                          "FROM album WHERE missing = 0 GROUP BY 1, 2 HAVING count(*) > 1 ORDER BY 6 LIMIT 300").fetchall()
    finally:
        c.close()
    by_id = {s[0]: s for s in songs}
    gruppi = {}
    for s in songs:
        if s[1] and s[2]:
            gruppi.setdefault((chiave(s[1]), chiave(s[2].split(",")[0])), []).append(s)
    doppi = []
    for v in gruppi.values():
        if len(v) > 1 and max(x[5] or 0 for x in v) - min(x[5] or 0 for x in v) <= 3:
            v = sorted(v, key=lambda x: (-(x[6] or 0), x[8]))  # il primo: la qualità migliore, che si tiene
            doppi.append([{"id": x[0], "title": x[1], "artist": x[2], "album": x[3], "duration": x[5], "bitrate": x[6], "suffix": x[7], "path": x[8]} for x in v])
    vuoti = [{"id": s[0], "title": s[1], "artist": s[2], "album": s[3], "path": s[8]} for s in songs
             if (s[1] or "").strip().lower() in VUOTI or (s[2] or "").strip().lower() in VUOTI]
    yt = {}
    for mid, gv in gen:
        if gv.lower() in GENERI_YT and mid in by_id:
            yt.setdefault(mid, []).append(gv)
    con_testo = sum(1 for s in songs if s[9] not in (None, "", "[]")) + testi_fatti()
    return jsonify(
        brani=len(songs),
        doppioni=doppi[:200], doppioni_tot=len(doppi),
        vuoti=vuoti[:200], vuoti_tot=len(vuoti),
        generi_yt=[{"id": k, "title": by_id[k][1], "artist": by_id[k][2], "generi": v} for k, v in yt.items()][:200], generi_yt_tot=len(yt),
        spezzati=[{"name": r[5], "artist": r[6], "ids": r[2].split(","), "anni": sorted({int(y) for y in r[3].split(",")}), "parti": r[4]} for r in split],
        testi={"con": min(con_testo, len(songs)), "on": setting("testi_auto", "1") == "1", **giro},
        controlli={"elenco": [{"c": k, "nome": v[0], "desc": v[1]} for k, v in CONTROLLI.items()], "auto": setting("controlli_auto", "1") == "1",
                   "scan": dict(scan), **json.loads(setting("scan", "{}") or "{}")})


@bp.post("/api/salute/unisci")
def unisci():
    """Album spezzati: Navidrome li separa se anno o artista dell'album cambiano fra i brani. Si mette a tutti il valore più
    comune (dai tag), poi la scansione li rimette insieme."""
    ids = [str(x) for x in ((request.get_json(silent=True) or {}).get("album") or [])[:20] if A.ID_RE.match(str(x))]
    if len(ids) < 2:
        return jsonify(error="Servono almeno due album"), 400
    c = A.importa.nd()
    try:
        rows = c.execute(f"SELECT id, album_artist, year FROM media_file WHERE missing = 0 AND album_id IN ({','.join('?' * len(ids))})", ids).fetchall()
    finally:
        c.close()
    if not rows:
        return jsonify(error="Album non trovati"), 404
    comune = lambda xs: max(set(xs), key=xs.count)  # noqa: E731
    artista, anno = comune([r[1] or "" for r in rows]), comune([r[2] or 0 for r in rows])
    paths, _ = A.track_paths([r[0] for r in rows])
    fatti = 0
    for sid, p in paths.items():
        try:
            A.metadati.modifica(p, {"albumartist": artista, **({"date": str(anno)} if anno else {})})
            fatti += 1
        except Exception:  # noqa: BLE001 — un file non scrivibile non ferma gli altri
            pass
    A.federazione.nd_get("startScan")
    return jsonify(ok=True, brani=fatti, artista=artista, anno=anno)


@bp.post("/api/salute/generi")
def generi():
    """Toglie dai brani i generi che sono categorie di YouTube («People & Blogs», «Gaming»…), lasciando gli altri."""
    ids = [str(x) for x in ((request.get_json(silent=True) or {}).get("ids") or [])[:500] if A.ID_RE.match(str(x))]
    paths, _ = A.track_paths(ids)
    fatti = 0
    for p in paths.values():
        try:
            old = A.metadati.leggi_tag(p).get("genres") or []
            new = [x for x in old if x.lower() not in GENERI_YT]
            if new != old:
                A.metadati.modifica(p, {"genres": new})
                fatti += 1
        except Exception:  # noqa: BLE001
            pass
    if fatti:
        A.federazione.nd_get("startScan")
    return jsonify(ok=True, brani=fatti)


# ------------------------------------------------------------------ testi cercati dal server
giro = {"fatti": 0, "trovati": 0, "corrente": "", "fermo": ""}
sveglia = threading.Event()  # un brano nuovo in libreria, o il giro riacceso: si riparte senza aspettare le 6 ore


def setting(k, default=None):
    r = db.one("SELECT value FROM settings WHERE key = ?", "lib_" + k)
    return r["value"] if r else default


def set_setting(k, v):
    db.run("INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", "lib_" + k, str(v))


def testi_fatti():
    # .lrc scritti e non ancora visti da Navidrome (fino alla scansione dopo)
    return int(setting("testi_nuovi", "0") or 0)


@bp.put("/api/salute/testi")
def testi_onoff():
    on = bool((request.get_json(silent=True) or {}).get("on"))
    set_setting("testi_auto", "1" if on else "0")
    if on:
        sveglia.set()
    return jsonify(ok=True, on=on)


def lrclib(artist, title, album, dur):
    a1 = re.split(r"\s*[,•&]\s*|\s+feat\.?\s+", artist or "", flags=re.I)[0]
    r = A.http.get("https://lrclib.net/api/get", params={"artist_name": a1, "track_name": title, "album_name": album or "", "duration": int(dur or 0)},
                   headers={"User-Agent": "Armony (https://github.com/Giggi-98/Armony)"}, timeout=15)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    j = r.json()
    if j.get("instrumental"):
        return ""
    return j.get("syncedLyrics") or j.get("plainLyrics") or None


def giro_testi():
    """In sottofondo, un brano ogni 2 secondi: i brani senza testo e senza .lrc accanto. Chi non ce l'ha si riprova
    dopo 30 giorni. Si ferma se LRCLIB non risponde (riprova fra un'ora)."""
    time.sleep(60)
    while True:
        try:
            if setting("testi_auto", "1") != "1":
                time.sleep(300)
                continue
            no = json.loads(setting("testi_no", "{}") or "{}")
            c = A.importa.nd()
            try:
                todo = c.execute("SELECT id, title, artist, album, duration, path FROM media_file WHERE missing = 0 AND (lyrics IS NULL OR lyrics IN ('', '[]')) "
                                 "AND library_id = (SELECT id FROM library WHERE rtrim(path, '/') = ?)", (A.NAVIDROME_MUSIC,)).fetchall()
            finally:
                c.close()
            now, scritti = time.time(), 0
            for sid, title, artist, album, dur, rel in todo:
                if setting("testi_auto", "1") != "1":
                    break
                p = os.path.join(A.MUSIC_DIR, rel)
                lrc = os.path.splitext(p)[0] + ".lrc"
                if os.path.exists(lrc) or now - no.get(sid, 0) < 30 * 86400 or not title:
                    continue
                giro["corrente"] = f"{artist} - {title}"
                t, err = None, None
                for prova in range(3):  # un errore passeggero (LRCLIB lento, un 502) non ferma il giro per un'ora
                    try:
                        t, err = lrclib(artist, title, album, dur), None
                        break
                    except (requests.RequestException, ValueError) as e:
                        err = getattr(getattr(e, "response", None), "status_code", None) or e.__class__.__name__
                        time.sleep(30)
                if err:
                    giro["fermo"] = f"LRCLIB non risponde (errore {err}, tre volte di fila): riprovo fra un'ora"
                    time.sleep(3600)
                    giro["fermo"] = ""
                    break
                giro["fatti"] += 1
                if t:
                    try:
                        with open(lrc, "w", encoding="utf-8") as f:
                            f.write(t if t.endswith("\n") else t + "\n")
                        giro["trovati"] += 1
                        scritti += 1
                        set_setting("testi_nuovi", testi_fatti() + 1)
                    except OSError:
                        pass
                else:
                    no[sid] = now  # niente testo (o strumentale): non si richiede per un mese
                    if giro["fatti"] % 20 == 0:
                        set_setting("testi_no", json.dumps(no))
                if scritti and scritti % 50 == 0:
                    A.federazione.nd_get("startScan")
                time.sleep(2)
            set_setting("testi_no", json.dumps(no))
            if scritti:
                A.federazione.nd_get("startScan")
                time.sleep(120)  # la scansione li legge: il conto «con testo» torna quello di Navidrome
            set_setting("testi_nuovi", 0)
            giro["corrente"] = ""
            if sveglia.wait(6 * 3600):  # brani nuovi: prima Navidrome li deve vedere
                sveglia.clear()
                time.sleep(120)
        except Exception as e:  # noqa: BLE001 — il giro non deve morire
            A.diagnosi.log("avviso", "testi", f"giro dei testi: {e}")
            time.sleep(600)


# ------------------------------------------------------------------ controllo dei brani (a mano e su ogni brano nuovo)
# Discrepanze logiche sulle tracce, dal DB di Navidrome (veloce) e, a scelta, dalla durata attesa su Deezer (lento:
# una richiesta per brano, al ritmo di metadati.deezer). I risultati restano sul server; «Ignora» li toglie per sempre.
CONTROLLI = {
    "durata": ("Durata strana", "Sotto i 30 secondi o sopra i 15 minuti (intro, interludi, mix e live esclusi)"),
    "troncato": ("File troncato", "Più piccolo di quanto dovrebbe essere per la sua durata: probabilmente scaricato a metà"),
    "qualita": ("Qualità bassa", "Bitrate sotto i 128 kbps"),
    "tag": ("Tag mancanti", "Album, anno, numero di traccia o copertina"),
    "titolo": ("Titolo sporco", "«Official Video», «Lyrics», «HD» o l'artista ripetuto nel titolo: si sistema da solo"),
    "traccia": ("Numero di traccia doppio", "Due brani dello stesso album con lo stesso numero"),
    "attesa": ("Durata diversa dall'originale", "Più di 15 secondi di differenza dalla versione su Deezer: una live, un edit, un'altra versione"),
}
CORTI_OK = re.compile(r"\b(intro|outro|interlude|interludio|skit|prelude|preludio|reprise|jingle)\b", re.I)
LUNGHI_OK = re.compile(r"\b(mix|mixed|live|set|full album|continuous|dj|megamix|medley|suite|ambient)\b", re.I)
SPORCO = re.compile(r"\s*[\(\[]\s*(?:official\s*(?:music\s*|lyrics?\s*)?(?:video|audio|visualizer|videoclip)|(?:lyrics?|testo)(?:\s*video)?|audio|hd|hq|4k|videoclip|video ufficiale|visualizer)\s*[\)\]]", re.I)
LOSSY = {"mp3", "m4a", "aac", "ogg", "opus", "wma"}
scan = {"on": False, "fatti": 0, "tot": 0, "ferma": False}


def titolo_pulito(title, artist):
    t = re.sub(r"_\d{2,3}k$", "", SPORCO.sub("", title or "")).strip()  # «_256k»: il bitrate rimasto dal nome del file
    a = (artist or "").split(",")[0].strip()
    if a and t.lower().startswith(a.lower() + " - "):
        t = t[len(a) + 3:].strip()
    return t


def durata_attesa(title, artist):
    a = (artist or "").split(",")[0].strip()
    q = urllib.parse.quote(f'artist:"{a}" track:"{titolo_pulito(title, artist)}"')
    d = A.metadati.deezer(f"search/track?q={q}&limit=5") or {}
    want = chiave(titolo_pulito(title, artist))
    for x in d.get("data") or []:
        if chiave(x.get("title_short") or x.get("title")) == want:
            return x.get("duration")
    return None


def righe(where="", args=()):
    c = A.importa.nd()
    try:
        return c.execute(
            "SELECT m.id, m.title, m.artist, m.album, m.album_id, m.duration, m.bit_rate, m.size, m.suffix, m.has_cover_art, m.year, "
            "m.track_number, m.disc_number, m.path, coalesce(f.image_files, ''), m.created_at, "
            "(SELECT count(*) FROM media_file x WHERE x.album_id = m.album_id AND x.missing = 0) "
            "FROM media_file m LEFT JOIN folder f ON f.id = m.folder_id WHERE m.missing = 0 AND m.library_id = "
            "(SELECT id FROM library WHERE rtrim(path, '/') = ?)" + where, (A.NAVIDROME_MUSIC, *args)).fetchall()
    finally:
        c.close()


def controlla(rows, sel, deezer=False, progress=None):
    ign = json.loads(setting("ignora", "{}") or "{}")
    doppi = {}
    if "traccia" in sel:
        for r in rows:
            if r[11]:
                doppi.setdefault((r[4], r[12] or 1, r[11]), []).append(r[0])
    out = []
    for i, r in enumerate(rows):
        if progress and not progress(i):
            break
        sid, title, artist, album, alb, dur, br, size, suf, cover, year, tn, dn, path, imgs, _, n_alb = r
        dur, br, suf = dur or 0, br or 0, (suf or "").lower()
        prob = []
        if "durata" in sel and dur:
            if dur < 30 and not CORTI_OK.search(title or ""):
                prob.append(("durata", f"dura solo {int(dur)} secondi"))
            elif dur > 900 and not LUNGHI_OK.search(f"{title} {album}"):
                prob.append(("durata", f"dura {int(dur // 60)} minuti"))
        if "troncato" in sel and suf in LOSSY and br and dur > 20 and size and size < br * 125 * dur * 0.55:
            prob.append(("troncato", f"{size // 1024} KB invece di circa {int(br * 125 * dur) // 1024} KB"))
        if "qualita" in sel and suf in LOSSY and 0 < br < 128:
            prob.append(("qualita", f"{br} kbps"))
        if "tag" in sel:
            manca = [n for n, v in (("album", album), ("anno", year), ("numero di traccia", tn or n_alb <= 1),
                                    ("copertina", cover or imgs not in ("", "[]"))) if not v]
            if manca:
                prob.append(("tag", "manca " + ", ".join(manca)))
        if "titolo" in sel and title and titolo_pulito(title, artist) != title.strip():
            prob.append(("titolo", f"«{titolo_pulito(title, artist)}»"))
        if "traccia" in sel and tn and len(doppi.get((alb, dn or 1, tn), [])) > 1:
            prob.append(("traccia", f"numero {tn} usato {len(doppi[(alb, dn or 1, tn)])} volte in «{album}»"))
        if deezer and "attesa" in sel and dur and title:
            want = durata_attesa(title, artist)
            if want and abs(want - dur) > 15:
                prob.append(("attesa", f"{int(dur // 60)}:{int(dur % 60):02d} invece di {want // 60}:{want % 60:02d}"))
        prob = [p for p in prob if not ign.get(f"{sid}:{p[0]}")]
        if prob:
            out.append({"id": sid, "title": title, "artist": artist, "album": album, "path": path, "duration": dur, "bitrate": br,
                        "problemi": [{"c": c, "msg": m} for c, m in prob]})
    return out


def salva_scan(items, sel, merge=False):
    old = json.loads(setting("scan", "{}") or "{}")
    if merge:  # brani nuovi: in cima, senza toccare gli altri risultati
        ids = {x["id"] for x in items}
        items = items + [x for x in old.get("items", []) if x["id"] not in ids]
        sel = old.get("sel") or sel
    set_setting("scan", json.dumps({"at": time.time() if not merge else old.get("at", 0), "sel": sel, "items": items[:3000],
                                    "auto_at": time.time() if merge else old.get("auto_at", 0)}))


def scansiona(sel, deezer, solo_nuovi):
    try:
        since = json.loads(setting("scan", "{}") or "{}").get("at", 0) if solo_nuovi else 0
        rows = righe(" AND m.created_at > ?", (time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(since)),)) if since else righe()
        scan.update(on=True, fatti=0, tot=len(rows), ferma=False)

        def prog(i):
            scan["fatti"] = i
            return not scan["ferma"]
        items = controlla(rows, sel, deezer, prog)
        salva_scan(items, sel, merge=bool(since))
    except Exception as e:  # noqa: BLE001
        A.diagnosi.log("errore", "salute", f"controllo della libreria: {e}")
    finally:
        scan["on"] = False


@bp.post("/api/salute/scansiona")
def scansiona_api():
    if scan["on"]:
        return jsonify(error="Un controllo è già in corso"), 409
    d = request.get_json(silent=True) or {}
    sel = [c for c in d.get("controlli") or [] if c in CONTROLLI] or [c for c in CONTROLLI if c != "attesa"]
    threading.Thread(target=scansiona, args=(sel, "attesa" in sel, bool(d.get("solo_nuovi"))), daemon=True).start()
    return jsonify(ok=True)


@bp.post("/api/salute/ferma")
def ferma_api():
    scan["ferma"] = True
    return jsonify(ok=True)


@bp.post("/api/salute/ignora")
def ignora_api():
    """{voci: [{id, c}]}: quei problemi non si segnalano più (una live che dura 20 minuti va bene così)."""
    voci = [(str(v.get("id")), str(v.get("c"))) for v in (request.get_json(silent=True) or {}).get("voci") or [] if isinstance(v, dict)]
    ign = json.loads(setting("ignora", "{}") or "{}")
    ign.update({f"{i}:{c}": 1 for i, c in voci})
    set_setting("ignora", json.dumps(ign))
    togli(voci)
    return jsonify(ok=True)


def togli(voci):
    old = json.loads(setting("scan", "{}") or "{}")
    via = set(voci)
    for x in old.get("items", []):
        x["problemi"] = [p for p in x["problemi"] if (x["id"], p["c"]) not in via]
    old["items"] = [x for x in old.get("items", []) if x["problemi"]]
    set_setting("scan", json.dumps(old))


@bp.post("/api/salute/sistema")
def sistema_api():
    """{ids}: sistema da solo quello che si può (il titolo sporco). Il resto si sistema a mano (Modifica, Scegli un'altra
    versione)."""
    ids = [str(x) for x in ((request.get_json(silent=True) or {}).get("ids") or [])[:500] if A.ID_RE.match(str(x))]
    c = A.importa.nd()
    try:
        info = {r[0]: r[1:] for r in c.execute(f"SELECT id, title, artist FROM media_file WHERE id IN ({','.join('?' * len(ids))})", ids)} if ids else {}
    finally:
        c.close()
    paths, _ = A.track_paths(ids)
    fatti = []
    for sid, p in paths.items():
        t, a = info.get(sid, ("", ""))
        nuovo = titolo_pulito(t, a)
        if nuovo and nuovo != (t or "").strip():
            try:
                A.metadati.modifica(p, {"title": nuovo})
                fatti.append((sid, "titolo"))
            except Exception:  # noqa: BLE001
                pass
    togli(fatti)
    if fatti:
        A.federazione.nd_get("startScan")
    return jsonify(ok=True, sistemati=len(fatti))


@bp.put("/api/salute/auto")
def auto_api():
    on = bool((request.get_json(silent=True) or {}).get("on"))
    set_setting("controlli_auto", "1" if on else "0")
    return jsonify(ok=True, on=on)


sveglia_c = threading.Event()


def giro_controlli():
    """Ogni brano nuovo (download, caricamento, copia dalla rete) si controlla appena Navidrome lo vede, con tutti i
    controlli e anche la durata attesa (sono pochi). Se c'è qualcosa, un avviso agli amministratori."""
    time.sleep(90)
    if not setting("visto_al"):  # la prima volta si parte da adesso: la libreria vecchia la controlla l'utente a mano
        set_setting("visto_al", time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()))
    while True:
        sveglia_c.wait(3600)
        sveglia_c.clear()
        time.sleep(180)  # la scansione di Navidrome deve averli visti
        try:
            if setting("controlli_auto", "1") != "1":
                continue
            since = setting("visto_al")
            rows = righe(" AND m.created_at > ?", (since,))
            set_setting("visto_al", max([r[15] for r in rows] + [since]))
            if not rows:
                continue
            items = controlla(rows, list(CONTROLLI), deezer=True)
            if items:
                salva_scan(items, list(CONTROLLI), merge=True)
                n = len(items)
                for u in db.all_("SELECT DISTINCT user FROM devices WHERE admin = 1 AND state = 'fidato'"):
                    A.notifiche.notifica(u["user"], "sistema", f"{n} {'brano nuovo' if n == 1 else 'brani nuovi'} da controllare",
                                         ", ".join(f"{x['title']}: {CONTROLLI[x['problemi'][0]['c']][0].lower()}" for x in items[:3]),
                                         "#/impostazioni/salute", only_once=f"controlli:{int(time.time() // 600)}")
        except Exception as e:  # noqa: BLE001
            A.diagnosi.log("avviso", "salute", f"controllo dei brani nuovi: {e}")


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)


def start():
    threading.Thread(target=giro_testi, daemon=True, name="testi").start()
    threading.Thread(target=giro_controlli, daemon=True, name="controlli").start()
