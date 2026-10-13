"""
Armony - bot di Telegram e Discord (capacità "bot").

  GET    /api/bot                     bot del server (nome, link, errori), le mie chat; per l'amministratore anche i token
  POST   /api/bot/codice              {rete}: un codice di 6 cifre, 10 minuti, da mandare al bot con /collega
  PUT    /api/bot/<rete>/<chat>       {notifiche}: le notifiche di Armony arrivano anche lì (sì di partenza)
  DELETE /api/bot/<rete>/<chat>       scollega quella chat
  Solo amministratori (e solo con chiave o da casa, come le altre impostazioni del server):
  PUT    /api/bot/config              {rete, token}: il token del bot, provato subito; vuoto = quello del .env, se c'è
  GET    /api/bot/canali              i canali e gli utenti fra cui scegliere
  POST   /api/bot/canali              {nome, rete, utenti, tipi}: un canale nuovo, con il codice per agganciarlo
  PUT    /api/bot/canali/<id>         {nome, utenti, tipi} · DELETE lo toglie · POST …/codice un codice nuovo · POST …/prova

Telegram: il server chiede i messaggi a Telegram (getUpdates, attesa lunga) in un thread, niente librerie e niente
porte da aprire. Il codice arriva anche col link https://t.me/<bot>?start=<codice>. Discord: discord.py in un thread col
suo loop, comandi «slash», notifiche in messaggio privato. I comandi sono gli stessi sui due (comando()).

In più: un link incollato in privato su Telegram si scarica (come /scarica); /brano manda il file audio nella chat;
/settimana e, ogni lunedì mattina, il riepilogo degli ascolti della settimana alle chat con le notifiche accese.

Un CANALE è un gruppo o un canale Telegram, o un canale testuale Discord, dove il bot racconta cosa fanno gli utenti
scelti (ascolti, rientri, playlist, download, Jam, radio: i tipi scelti), e se vuole gli album nuovi in libreria (di
tutti, non degli utenti scelti). Si aggancia scrivendo lì /canale <codice>.
Vale «Mostra agli altri cosa ascolto»: chi l'ha spento non compare.

─── PERCHÉ un codice e non la password ───
Il bot vede solo un numero di chat: niente password che passano da Telegram o Discord. Il codice lo crea chi è già
dentro Armony, vale una volta e 10 minuti; scollegare dalla pagina o col comando toglie subito l'accesso.
"""
import asyncio
import io
import json
import os
import queue
import random
import re
import secrets
import threading
import time
import urllib.parse

import requests
from flask import Blueprint, g, jsonify, request

import db

bp = Blueprint("bot", __name__)
A = None
TG_API = os.environ.get("TELEGRAM_API", "https://api.telegram.org").rstrip("/")   # diversi solo nelle prove
DC_API = os.environ.get("DISCORD_API", "https://discord.com/api/v10").rstrip("/")
ENV = {"telegram": "TELEGRAM_BOT_TOKEN", "discord": "DISCORD_BOT_TOKEN"}
RETI = tuple(ENV)
CODICE_S = 600
TIPI = {"ascolto": "🎧 Cosa ascoltano", "linea": "👋 Chi torna in linea", "playlist": "📀 Playlist create o condivise",
        "download": "⬇️ Download e caricamenti", "jam": "🎉 Jam", "radio": "📻 Radio", "novita": "🆕 Album nuovi in libreria (di tutti)"}
codici = {}               # codice -> (utente, rete, scadenza) per le chat; ("#canale", id, scadenza) per i canali
info = {"telegram": {}, "discord": {}}  # nome del bot, link, ultimo errore: dopo il primo contatto
uscita = queue.Queue(maxsize=500)       # messaggi da mandare: (rete, chat, testo); chat "c:<id>" = canale Discord
dc = {"client": None, "loop": None, "riavvia": False}

AIUTO = """🎵 Armony, comandi:
/cerca testo — brani, album e artisti
/brano testo — il file audio, da ascoltare qui
/ora — cosa stai ascoltando
/amici — chi ascolta cosa adesso
/scarica link — scarica un brano o una playlist (YouTube, SoundCloud…); su Telegram basta incollare il link
/settimana — i tuoi ascolti degli ultimi 7 giorni (arriva anche da solo il lunedì)
/mix — il tuo mix del giorno, sul dispositivo che suona
/pausa · /avanti · /indietro — comandi al dispositivo che suona
/notifiche si|no — le notifiche di Armony anche qui
/scollega — questa chat non è più collegata al tuo utente"""


def token(rete):
    """Quello scritto dall'amministratore nella pagina; se non c'è, quello del .env."""
    r = db.one("SELECT value FROM settings WHERE key = ?", "bot_token:" + rete)
    return ((r["value"] if r and r["value"] else "") or os.environ.get(ENV[rete], "")).strip()


def aspetta(secondi, rete, tk):
    """Attesa dopo un errore che finisce subito se dalla pagina arriva un token diverso."""
    fine = time.time() + secondi
    while time.time() < fine and token(rete) == tk:
        time.sleep(2)


# ------------------------------------------------------------------ collegamento con Armony (pagina Impostazioni → Bot)
def chats(user):
    return db.all_("SELECT rete, chat, nome, notifiche, created FROM bot_chat WHERE user = ? ORDER BY created", user)


@bp.get("/api/bot")
def stato():
    u, out = g.who.get("user"), {}
    for k in RETI:
        out[k] = dict(on=bool(token(k)), **info[k])
        if g.who["admin"]:
            r = db.one("SELECT value FROM settings WHERE key = ?", "bot_token:" + k)
            out[k]["config"] = {"pagina": bool(r and r["value"]), "env": bool(os.environ.get(ENV[k], "").strip()),
                                "fine": token(k)[-4:] if token(k) else ""}  # solo le ultime 4: il token non esce mai intero
    return jsonify(**out, chats=[dict(r) for r in chats(u)] if u else [], tipi=TIPI)


def nuovo(chiave):
    now = time.time()
    for k in [k for k, v in codici.items() if v[2] < now or v[:2] == chiave]:
        codici.pop(k, None)
    c = f"{secrets.randbelow(900000) + 100000}"
    codici[c] = (*chiave, now + CODICE_S)
    return c, now + CODICE_S


@bp.post("/api/bot/codice")
def nuovo_codice():
    u, rete = g.who.get("user"), str((request.get_json(silent=True) or {}).get("rete") or "")
    if not u:
        return jsonify(error="Serve un utente: l'accesso di emergenza non ha chat da collegare"), 400
    if rete not in RETI or not token(rete):
        return jsonify(error="Questo bot non è attivo sul server"), 400
    c, scade = nuovo((u, rete))
    return jsonify(codice=c, scade=scade, link=f"https://t.me/{info['telegram']['nome']}?start={c}"
                   if rete == "telegram" and info["telegram"].get("nome") else None)


@bp.put("/api/bot/<rete>/<chat>")
def notifiche_onoff(rete, chat):
    on = 1 if (request.get_json(silent=True) or {}).get("notifiche") else 0
    db.run("UPDATE bot_chat SET notifiche = ? WHERE rete = ? AND chat = ? AND user = ?", on, rete, chat, g.who.get("user"))
    return jsonify(ok=True, notifiche=bool(on))


@bp.delete("/api/bot/<rete>/<chat>")
def scollega(rete, chat):
    db.run("DELETE FROM bot_chat WHERE rete = ? AND chat = ? AND user = ?", rete, chat, g.who.get("user"))
    return jsonify(ok=True)


def chi(rete, chat):
    r = db.one("SELECT user FROM bot_chat WHERE rete = ? AND chat = ?", rete, str(chat))
    return r["user"] if r else None


# ------------------------------------------------------------------ amministratore: token e canali
def admin_ok():
    if not g.who["admin"]:
        return jsonify(error="Serve un amministratore."), 403
    if not A.dispositivi.can_change(g.who):
        return A.dispositivi.refuse_change()
    return None


def prova_token(rete, tk):
    """Il token risponde? (il nome del bot, oppure un errore leggibile)"""
    try:
        if rete == "telegram":
            r = requests.get(f"{TG_API}/bot{tk}/getMe", timeout=15).json()
            if not r.get("ok"):
                raise ValueError("Telegram non riconosce questo token")
            return "@" + r["result"]["username"]
        r = requests.get(f"{DC_API}/users/@me", headers={"Authorization": f"Bot {tk}"}, timeout=15)
        if r.status_code != 200:
            raise ValueError("Discord non riconosce questo token")
        return r.json().get("username")
    except requests.RequestException:
        raise ValueError(f"{rete.capitalize()} non risponde: riprova fra poco")


@bp.put("/api/bot/config")
def config():
    no = admin_ok()
    if no:
        return no
    d = request.get_json(silent=True) or {}
    rete, tk = str(d.get("rete") or ""), str(d.get("token") or "").strip()
    if rete not in RETI:
        return jsonify(error="Rete sconosciuta"), 400
    nome = None
    if tk:
        try:
            nome = prova_token(rete, tk)
        except ValueError as e:
            return jsonify(error=str(e)), 400
    db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", "bot_token:" + rete, tk)
    riavvia(rete)
    A.diagnosi.log("info", "bot", f"token di {rete} {'cambiato' if tk else 'tolto'} da {g.who.get('user') or 'emergenza'}")
    return jsonify(ok=True, nome=nome, on=bool(token(rete)))


def riavvia(rete):
    info[rete] = {}
    if rete == "discord" and dc["client"] and dc["loop"]:
        dc["riavvia"] = True
        asyncio.run_coroutine_threadsafe(dc["client"].close(), dc["loop"])


def canale_out(r):
    return {"id": r["id"], "nome": r["nome"], "rete": r["rete"], "agganciato": bool(r["chat"]), "dove": r["chat_nome"] or "",
            "utenti": json.loads(r["utenti"] or "[]"), "tipi": json.loads(r["tipi"] or "[]"), "created": r["created"]}


@bp.get("/api/bot/canali")
def canali():
    no = admin_ok()
    if no:
        return no
    utenti = sorted({r["user"] for r in db.all_("SELECT DISTINCT user FROM devices WHERE state != 'revocato'")}, key=str.lower)
    return jsonify(canali=[canale_out(r) for r in db.all_("SELECT * FROM bot_canali ORDER BY created")], utenti=utenti, tipi=TIPI)


def pulisci(d):
    return (str(d.get("nome") or "").strip()[:60] or "Canale", json.dumps([str(u)[:60] for u in (d.get("utenti") or [])][:200]),
            json.dumps([t for t in (d.get("tipi") or []) if t in TIPI]))


@bp.post("/api/bot/canali")
def canale_nuovo():
    no = admin_ok()
    if no:
        return no
    d = request.get_json(silent=True) or {}
    if d.get("rete") not in RETI or not token(d.get("rete")):
        return jsonify(error="Prima attiva il bot di questa rete"), 400
    nome, utenti, tipi = pulisci(d)
    cid = secrets.token_hex(6)
    db.run("INSERT INTO bot_canali (id, nome, rete, utenti, tipi, created) VALUES (?, ?, ?, ?, ?, ?)", cid, nome, d["rete"], utenti, tipi, time.time())
    c, scade = nuovo(("#canale", cid))
    return jsonify(**canale_out(db.one("SELECT * FROM bot_canali WHERE id = ?", cid)), codice=c, scade=scade, bot=info[d["rete"]].get("nome")), 201


@bp.put("/api/bot/canali/<cid>")
def canale_cambia(cid):
    no = admin_ok()
    if no:
        return no
    nome, utenti, tipi = pulisci(request.get_json(silent=True) or {})
    db.run("UPDATE bot_canali SET nome = ?, utenti = ?, tipi = ? WHERE id = ?", nome, utenti, tipi, cid)
    r = db.one("SELECT * FROM bot_canali WHERE id = ?", cid)
    return jsonify(canale_out(r)) if r else (jsonify(error="Canale non trovato"), 404)


@bp.delete("/api/bot/canali/<cid>")
def canale_via(cid):
    no = admin_ok()
    if no:
        return no
    db.run("DELETE FROM bot_canali WHERE id = ?", cid)
    return jsonify(ok=True)


@bp.post("/api/bot/canali/<cid>/codice")
def canale_codice(cid):
    no = admin_ok()
    if no:
        return no
    r = db.one("SELECT rete FROM bot_canali WHERE id = ?", cid)
    if not r:
        return jsonify(error="Canale non trovato"), 404
    c, scade = nuovo(("#canale", cid))
    return jsonify(codice=c, scade=scade, bot=info[r["rete"]].get("nome"))


@bp.post("/api/bot/canali/<cid>/prova")
def canale_prova(cid):
    no = admin_ok()
    if no:
        return no
    r = db.one("SELECT * FROM bot_canali WHERE id = ?", cid)
    if not r or not r["chat"]:
        return jsonify(error="Il canale non è ancora agganciato"), 409
    manda(r["rete"], r["chat"], f"🎵 Prova da Armony: qui arriva «{r['nome']}».")
    return jsonify(ok=True)


def aggancia(rete, chat, nome, codice):
    c = codici.get(re.sub(r"\D", "", codice or ""))
    if not c or c[0] != "#canale" or c[2] < time.time():
        return "❌ Codice non valido o scaduto: creane uno nuovo in Armony, Impostazioni → Bot → Canali."
    r = db.one("SELECT * FROM bot_canali WHERE id = ?", c[1])
    if not r or r["rete"] != rete:
        return "❌ Questo codice è di un canale dell'altra rete."
    codici.pop(re.sub(r"\D", "", codice), None)
    db.run("UPDATE bot_canali SET chat = ?, chat_nome = ? WHERE id = ?", str(chat), str(nome or "")[:80], r["id"])
    return f"✅ Agganciato: qui arriva «{r['nome']}» di {A.NAME}."


# ------------------------------------------------------------------ i comandi, uguali su Telegram e Discord
def url(link=""):
    base = A.public_url() or A.federazione.my_url()
    return (base + "/" + link) if base else ""


def comando(rete, chat, nome, testo):
    """Un messaggio arrivato al bot; risponde con il testo da mandare indietro (o None)."""
    testo = (testo or "").strip()
    if re.match(r"^https?://\S+$", testo):
        testo = "/scarica " + testo  # un link incollato e basta
    if not testo.startswith("/"):
        return None
    cmd, _, arg = testo[1:].partition(" ")
    cmd, arg = cmd.split("@")[0].lower(), arg.strip()
    if cmd == "start" and arg:
        cmd = "collega"
    if cmd in ("start", "aiuto", "help"):
        return ("👋 Ciao! Per cominciare collega il tuo utente: in Armony vai in Impostazioni → Bot, crea un codice e "
                "mandalo qui con /collega 123456.\n\n" + AIUTO) if not chi(rete, chat) else AIUTO
    if cmd == "collega":
        c = codici.get(re.sub(r"\D", "", arg))
        if not c or c[0] == "#canale" or c[1] != rete or c[2] < time.time():
            return "❌ Codice non valido o scaduto: creane uno nuovo in Armony, Impostazioni → Bot."
        codici.pop(re.sub(r"\D", "", arg), None)
        db.run("INSERT INTO bot_chat (rete, chat, user, nome, notifiche, created) VALUES (?, ?, ?, ?, 1, ?) "
               "ON CONFLICT(rete, chat) DO UPDATE SET user = excluded.user, nome = excluded.nome", rete, str(chat), c[0], str(nome or "")[:80], time.time())
        A.notifiche.notifica(c[0], "dispositivi", f"🤖 {rete.capitalize()} collegato", f"{nome or 'Una chat'} ora agisce come te", "#/impostazioni/bot")
        return f"✅ Collegato: qui sei {c[0]} su {A.NAME}. Le notifiche di Armony arriveranno anche qui (/notifiche no per spegnerle).\n\n{AIUTO}"
    if cmd == "canale":
        return "Il comando /canale si usa nel gruppo o nel canale da agganciare, non in privato."
    u = chi(rete, chat)
    if not u:
        return "🔒 Prima collega il tuo utente: in Armony vai in Impostazioni → Bot e manda qui /collega con il codice."
    try:
        return COMANDI[cmd](u, arg) if cmd in COMANDI else f"🤔 Non conosco /{cmd}.\n\n{AIUTO}"
    except Exception as e:  # noqa: BLE001 - un comando che va storto non deve fermare il bot
        A.diagnosi.log("errore", "bot", f"/{cmd}: {e}"[:300])
        return f"⚠️ Non è andata: {e}"[:300]


def c_cerca(u, q):
    if not q:
        return "Scrivi cosa cercare: /cerca bohemian rhapsody"
    r = A.federazione.nd_get("search3", query=q, songCount=6, albumCount=3, artistCount=2).get("searchResult3") or {}
    righe = [f"🎵 {s.get('title')} — {s.get('artist')}  {url('#/album/' + s['albumId']) if s.get('albumId') else ''}" for s in r.get("song") or []]
    righe += [f"💿 {a.get('name')} — {a.get('artist')}  {url('#/album/' + a['id'])}" for a in r.get("album") or []]
    righe += [f"🎤 {a.get('name')}  {url('#/artista/' + a['id'])}" for a in r.get("artist") or []]
    return "\n".join(righe) if righe else f"Niente per «{q}». Con /scarica e un link lo prendi da YouTube."


def suona(u):
    """Il dispositivo dell'utente che sta suonando (o l'ultimo che ha suonato) e il suo stato."""
    with A.llock:
        st = sorted(A.lstates.get(u, {}).values(), key=lambda s: (bool(s.get("playing")), s.get("at", 0)), reverse=True)
    return st[0] if st else None


def c_ora(u, _):
    st = suona(u)
    t = (st or {}).get("track") if isinstance((st or {}).get("track"), dict) else None
    if not t:
        return "🔇 Niente in riproduzione sui tuoi dispositivi."
    return f"{'▶️' if st.get('playing') else '⏸️'} «{t.get('title')}» · {t.get('artist') or ''}\nsu {st.get('name') or 'un dispositivo'}"


def c_amici(u, _):
    righe = [f"🎧 {e['name']}: «{e['track'].get('title')}» · {e['track'].get('artist') or ''}" for e in A.pres_all()
             if e["user"] != u and e["playing"] and e.get("track")]
    return "\n".join(righe) if righe else "😴 Nessun amico sta ascoltando adesso."


def c_scarica(u, link):
    if not A.utenti.perms(u).get("download"):
        return "🔒 Il tuo utente non può scaricare: chiedilo all'amministratore."
    if not re.match(r"^https?://", link or ""):
        return "Manda il link: /scarica https://music.youtube.com/watch?v=…"
    j = A.nuovo_download({"url": link, "playlist": "list=" in link}, u)
    return f"⬇️ In coda: ti avviso quando è pronto. ({j['id']})"


def c_brano(u, q):
    """Il file audio del primo brano trovato: torna un dizionario, che il postino manda come file e non come testo."""
    if not q:
        return "Scrivi quale brano: /brano bohemian rhapsody"
    s_ = (A.federazione.nd_get("search3", query=q, songCount=1, albumCount=0, artistCount=0).get("searchResult3") or {}).get("song") or []
    return {"audio": s_[0]} if s_ else f"Niente per «{q}». Con /scarica e un link lo prendi da YouTube."


def audio(t, kbps):
    """mp3 del brano da Navidrome: i bot accettano file fino a 50 MB (Telegram) e 10 MB (Discord)."""
    r = A.http.get(f"{A.NAVIDROME_URL}/rest/stream", params={**A.federazione.nd_params(), "id": t["id"], "format": "mp3", "maxBitRate": kbps}, timeout=120)
    r.raise_for_status()
    return r.content


def nome_file(t):
    return re.sub(r'[\\/:*?"<>|]+', " ", f"{t.get('artist') or ''} - {t.get('title') or 'brano'}").strip(" -")[:120] + ".mp3"


def settimana(u):
    """Gli ascolti di un utente negli ultimi 7 giorni, dal DB di Navidrome (come le statistiche)."""
    da = time.time() - 7 * 86400
    c = A.ascolti.nd()
    try:
        sc = c.execute("SELECT typeof(submission_time) FROM scrobbles LIMIT 1").fetchone()
        arg = da if not sc or sc[0] in ("integer", "real") else time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(da))
        base = "FROM scrobbles s JOIN user us ON us.id = s.user_id JOIN media_file m ON m.id = s.media_file_id WHERE us.user_name = ? AND s.submission_time >= ?"
        n, mins = c.execute(f"SELECT count(*), coalesce(sum(m.duration), 0) / 60 {base}", (u, arg)).fetchone()
        brani = c.execute(f"SELECT m.title, m.artist, count(*) k {base} GROUP BY m.id ORDER BY k DESC LIMIT 3", (u, arg)).fetchall()
        artisti = c.execute(f"SELECT m.artist, count(*) k {base} GROUP BY m.artist ORDER BY k DESC LIMIT 3", (u, arg)).fetchall()
    finally:
        c.close()
    if not n:
        return "📊 Questa settimana niente ascolti. La musica ti aspetta! 🎶"
    medaglie = ("🥇", "🥈", "🥉")
    return "\n".join([f"📊 La tua settimana: {n} ascolti, {round(mins)} minuti di musica", "", "🎵 Brani:"]
                     + [f"{medaglie[i]} «{t}» · {a or ''} ({k}×)" for i, (t, a, k) in enumerate(brani)]
                     + ["", "🎤 Artisti:"] + [f"{medaglie[i]} {a} ({k}×)" for i, (a, k) in enumerate(artisti) if a])


def c_settimana(u, _):
    return settimana(u)


def brano_wire(x):
    """Un brano di Navidrome nella forma che i client si passano nel canale dal vivo (jam.js, wire)."""
    base = A.public_url() or A.federazione.my_url() or "locale"
    return {"id": x["id"], "title": x.get("title") or "Senza titolo", "artist": x.get("displayArtist") or x.get("artist") or "", "album": x.get("album") or "",
            "albumId": x.get("albumId"), "artistId": x.get("artistId"), "duration": x.get("duration") or 0, "coverArt": x.get("coverArt"),
            "genre": x.get("genre"), "serverUrl": base, "pub": A.public_url() or None}


def mix_del_giorno(u):
    """Come il mix del giorno dell'app: l'artista più ascoltato del mese, i simili (Navidrome) e i suoi brani,
    mescolati con un seme del giorno (oggi lo stesso mix, domani un altro). Torna (nome, brani)."""
    da = time.time() - 30 * 86400
    c = A.ascolti.nd()
    try:
        sc = c.execute("SELECT typeof(submission_time) FROM scrobbles LIMIT 1").fetchone()
        arg = da if not sc or sc[0] in ("integer", "real") else time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(da))
        top = c.execute("SELECT m.artist_id, m.artist, count(*) k FROM scrobbles s JOIN user us ON us.id = s.user_id JOIN media_file m ON m.id = s.media_file_id "
                        "WHERE us.user_name = ? AND s.submission_time >= ? AND m.artist_id != '' GROUP BY m.artist_id ORDER BY k DESC LIMIT 1", (u, arg)).fetchone()
    finally:
        c.close()
    caso = random.Random(time.strftime("%Y-%m-%d") + (top[0] if top else u))
    if not top:
        return "a sorpresa", [brano_wire(x) for x in A.federazione.nd_get("getRandomSongs", size=40).get("randomSongs", {}).get("song") or []]
    visti, out = set(), []

    def metti(lista, quanti):
        lista = list(lista)
        caso.shuffle(lista)
        for x in lista:
            if quanti <= 0:
                break
            if x.get("id") and x["id"] not in visti:
                visti.add(x["id"])
                out.append(brano_wire(x))
                quanti -= 1
    metti(A.federazione.nd_get("getSimilarSongs2", id=top[0], count=60).get("similarSongs2", {}).get("song") or [], 40)
    albi = A.federazione.nd_get("getArtist", id=top[0]).get("artist", {}).get("album") or []
    caso.shuffle(albi)
    metti([x for a in albi[:8] for x in A.federazione.nd_get("getAlbum", id=a["id"]).get("album", {}).get("song") or []], 14)
    # senza Last.fm i simili non ci sono: come nell'app, lo stesso genere, poi brani a caso
    generi = [b["genre"] for b in out if b.get("genre")]
    if len(out) < 30 and generi:
        metti(A.federazione.nd_get("getSongsByGenre", genre=max(set(generi), key=generi.count), count=100).get("songsByGenre", {}).get("song") or [], 30 - len(out))
    if len(out) < 30:
        metti(A.federazione.nd_get("getRandomSongs", size=60).get("randomSongs", {}).get("song") or [], 30 - len(out))
    caso.shuffle(out)
    return top[1], out


def c_mix(u, _):
    nome, brani = mix_del_giorno(u)
    if not brani:
        return "🎂 Ancora niente da mescolare: la libreria è vuota."
    st = suona(u)
    if st:
        A.manda_cmd(u, st["device"], "transfer", {"queue": brani, "index": 0, "position": 0, "shuffle": False, "repeat": "off"})
        return f"🎂 Mix di {nome}: {len(brani)} brani, partono su {st.get('name') or 'il tuo dispositivo'}. Il primo: «{brani[0]['title']}»."
    return f"🎂 Mix di {nome}, {len(brani)} brani (apri Armony e rimanda /mix per farlo partire):\n" + "\n".join(
        f"{i}. «{b['title']}» · {b['artist']}" for i, b in enumerate(brani[:10], 1)) + (f"\n…e altri {len(brani) - 10}" if len(brani) > 10 else "")


def c_cmd(nome, verbo):
    def f(u, _):
        st = suona(u)
        if not st:
            return "🔇 Nessun tuo dispositivo collegato."
        A.manda_cmd(u, st["device"], nome)
        return f"{verbo} su {st.get('name') or 'il tuo dispositivo'}"
    return f


COMANDI = {"cerca": c_cerca, "ora": c_ora, "amici": c_amici, "scarica": c_scarica, "brano": c_brano, "settimana": c_settimana, "mix": c_mix,
           "pausa": c_cmd("pause", "⏸️ In pausa"), "avanti": c_cmd("next", "⏭️ Avanti"), "indietro": c_cmd("prev", "⏮️ Indietro"),
           "play": c_cmd("play", "▶️ Riparte")}


def rispondi(rete, chat, nome, testo):
    """comando() più i due che toccano la chat stessa."""
    cmd, _, arg = (testo or "").strip().lstrip("/").partition(" ")
    cmd = cmd.split("@")[0].lower()
    if cmd in ("notifiche", "scollega") and chi(rete, chat):
        if cmd == "scollega":
            db.run("DELETE FROM bot_chat WHERE rete = ? AND chat = ?", rete, str(chat))
            return "👋 Scollegato. Per ricollegarti crea un codice nuovo in Armony."
        on = arg.strip().lower() in ("si", "sì", "on", "1")
        if arg.strip().lower() not in ("si", "sì", "on", "1", "no", "off", "0"):
            return "Usa /notifiche si oppure /notifiche no"
        db.run("UPDATE bot_chat SET notifiche = ? WHERE rete = ? AND chat = ?", int(on), rete, str(chat))
        return "🔔 Notifiche accese qui." if on else "🔕 Notifiche spente qui."
    return comando(rete, chat, nome, testo)


# ------------------------------------------------------------------ in uscita: notifiche alle chat, attività ai canali
def manda(rete, chat, testo):
    try:
        uscita.put_nowait((rete, chat, testo))
    except queue.Full:
        pass


def inoltra(user, titolo, corpo="", link=None):
    for r in db.all_("SELECT rete, chat FROM bot_chat WHERE user = ? AND notifiche = 1", user):
        manda(r["rete"], r["chat"], titolo + (f"\n{corpo}" if corpo else "") + (f"\n{url(link)}" if link and url() else ""))


def feed(attore, tipo, testo, link=None):
    """Un'attività di un utente ai canali che lo seguono per quel tipo (una volta per canale)."""
    for r in db.all_("SELECT rete, chat, utenti, tipi FROM bot_canali WHERE chat IS NOT NULL"):
        if tipo in json.loads(r["tipi"] or "[]") and (tipo == "novita" or attore in json.loads(r["utenti"] or "[]")):
            manda(r["rete"], r["chat"], testo + (f"\n{url(link)}" if link and url() else ""))


def postino():
    while True:
        rete, chat, testo = uscita.get()
        try:
            if rete == "telegram" and token("telegram") and isinstance(testo, dict):
                t = testo["audio"]
                tg_file("sendAudio", {"chat_id": chat, "title": t.get("title") or "", "performer": t.get("artist") or "", "duration": int(t.get("duration") or 0)},
                        {"audio": (nome_file(t), audio(t, 192), "audio/mpeg")})
            elif rete == "telegram" and token("telegram"):
                tg("sendMessage", chat_id=chat, text=testo[:4000], disable_web_page_preview=True)
            elif rete == "discord" and dc["loop"]:
                asyncio.run_coroutine_threadsafe(dc_manda(chat, testo), dc["loop"]).result(20)
        except Exception as e:  # noqa: BLE001
            A.diagnosi.log("avviso", "bot", f"messaggio a {rete} non mandato: {e}"[:300])


def novita():
    """Ogni 10 minuti gli album arrivati in libreria (getAlbumList2 «newest», per data di aggiunta) ai canali «novita».
    Il segno è la data dell'ultimo album visto: al primo giro si segna e basta, per non annunciare tutta la libreria."""
    while True:
        time.sleep(600)
        try:
            albi = A.federazione.nd_get("getAlbumList2", type="newest", size=50).get("albumList2", {}).get("album") or []
            visto = (db.one("SELECT value FROM settings WHERE key = 'bot_novita'") or {"value": ""})["value"]
            nuovi = sorted((a for a in albi if (a.get("created") or "") > visto), key=lambda a: a.get("created") or "")
            if albi and visto:
                for a in nuovi[:5]:
                    feed(None, "novita", f"🆕 Nuovo in libreria: «{a.get('name')}» · {a.get('artist') or ''}", "#/album/" + a["id"])
                if len(nuovi) > 5:
                    feed(None, "novita", f"🆕 …e altri {len(nuovi) - 5} album nuovi in libreria")
            if albi:
                db.run("INSERT INTO settings (key, value) VALUES ('bot_novita', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                       max([visto] + [a.get("created") or "" for a in albi]))
        except Exception as e:  # noqa: BLE001 - Navidrome che non risponde: si riprova al giro dopo
            A.diagnosi.log("avviso", "bot", f"album nuovi: {e}"[:300])


def riepilogo():
    """Il lunedì dalle 9 il riepilogo della settimana a ogni chat con le notifiche accese, una volta per settimana."""
    while True:
        time.sleep(300)
        ora = time.localtime()
        sett = time.strftime("%G-%V", ora)
        if ora.tm_wday != 0 or ora.tm_hour < 9 or (db.one("SELECT value FROM settings WHERE key = 'bot_riepilogo'") or {"value": ""})["value"] == sett:
            continue
        db.run("INSERT INTO settings (key, value) VALUES ('bot_riepilogo', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", sett)
        for r in db.all_("SELECT rete, chat, user FROM bot_chat WHERE notifiche = 1"):
            try:
                manda(r["rete"], r["chat"], settimana(r["user"]))
            except Exception as e:  # noqa: BLE001
                A.diagnosi.log("avviso", "bot", f"riepilogo di {r['user']}: {e}"[:300])


# ------------------------------------------------------------------ Telegram: getUpdates con attesa lunga, niente librerie
def tg(method, timeout=40, **params):
    r = requests.post(f"{TG_API}/bot{token('telegram')}/{method}", json=params, timeout=timeout).json()
    if not r.get("ok"):
        raise RuntimeError(r.get("description") or "Telegram ha rifiutato")
    return r["result"]


def tg_file(method, dati, files):
    r = requests.post(f"{TG_API}/bot{token('telegram')}/{method}", data=dati, files=files, timeout=120).json()
    if not r.get("ok"):
        raise RuntimeError(r.get("description") or "Telegram ha rifiutato")
    return r["result"]


def tg_giro():
    """Gira sempre: senza token aspetta; con un token nuovo (dalla pagina) riparte da capo."""
    pausa, offset, prima = 5, None, None
    while True:
        tk = token("telegram")
        if tk != prima:
            info["telegram"], offset, prima, pausa = {}, None, tk, 5
        if not tk:
            time.sleep(5)
            continue
        try:
            if not info["telegram"].get("nome"):
                info["telegram"]["nome"] = tg("getMe")["username"]
                tg("setMyCommands", commands=[{"command": c, "description": d} for c, d in (
                    ("cerca", "Cerca brani, album e artisti"), ("brano", "Il file audio di un brano"), ("ora", "Cosa stai ascoltando"),
                    ("amici", "Chi ascolta cosa"), ("settimana", "I tuoi ascolti della settimana"), ("mix", "Il tuo mix del giorno, sul dispositivo che suona"),
                    ("scarica", "Scarica da un link"), ("pausa", "Pausa"), ("avanti", "Brano successivo"), ("indietro", "Brano precedente"),
                    ("notifiche", "si/no: le notifiche anche qui"), ("collega", "Collega il tuo utente con il codice"),
                    ("scollega", "Scollega questa chat"), ("aiuto", "Tutti i comandi"))])
                A.diagnosi.log("info", "bot", f"Telegram attivo: @{info['telegram']['nome']}")
            for up in tg("getUpdates", timeout=40, offset=offset, allowed_updates=["message", "channel_post"]):
                offset = up["update_id"] + 1
                m = up.get("message") or up.get("channel_post") or {}
                ch, testo = m.get("chat") or {}, m.get("text") or ""
                if not testo:
                    continue
                if ch.get("type") != "private":
                    # gruppi e canali: solo l'aggancio di un canale (in un gruppo chiunque scriverebbe come te)
                    cmd, _, arg = testo.strip().lstrip("/").partition(" ")
                    if cmd.split("@")[0].lower() == "canale":
                        manda("telegram", ch["id"], aggancia("telegram", ch["id"], ch.get("title"), arg))
                    continue
                fr = m.get("from") or {}
                out = rispondi("telegram", ch["id"], fr.get("username") or fr.get("first_name"), testo)
                if out:
                    manda("telegram", ch["id"], out)
            info["telegram"].pop("errore", None)
            pausa = 5
        except Exception as e:  # noqa: BLE001 - rete caduta, token sbagliato: si riprova con calma
            info["telegram"]["errore"] = str(e)[:200]
            A.diagnosi.log("avviso", "bot", f"Telegram: {e}"[:300])
            aspetta(pausa, "telegram", tk)
            pausa = min(pausa * 2, 300)


# ------------------------------------------------------------------ Discord: discord.py, comandi slash
async def dc_manda(chat, testo):
    c = dc["client"]
    dest = (c.get_channel(int(chat[2:])) or await c.fetch_channel(int(chat[2:]))) if chat.startswith("c:") else await c.fetch_user(int(chat))
    await dest.send(testo[:1900])


def dc_client():
    """Client e comandi, nuovi a ogni tentativo: un client resta legato al loop in cui è nato."""
    import discord
    from discord import app_commands

    client = discord.Client(intents=discord.Intents.default())
    tree = app_commands.CommandTree(client)
    dc["client"] = client

    async def esegui(inter, testo):
        loop = asyncio.get_running_loop()
        if testo.startswith("/brano"):
            await inter.response.defer(thinking=True)  # scaricare il brano può superare i 3 secondi di Discord
        out = await loop.run_in_executor(None, rispondi, "discord", str(inter.user.id), inter.user.name, testo)
        if isinstance(out, dict):
            t = out["audio"]
            dati = await loop.run_in_executor(None, audio, t, 128)
            if len(dati) > 10 * 1024 * 1024:
                return await inter.followup.send(f"📦 «{t.get('title')}» è troppo lungo per Discord (più di 10 MB).")
            return await inter.followup.send(f"🎵 «{t.get('title')}» · {t.get('artist') or ''}", file=discord.File(io.BytesIO(dati), filename=nome_file(t)))
        if inter.response.is_done():
            return await inter.followup.send(out or "…")
        await inter.response.send_message(out or "…", ephemeral=True)

    def semplice(nome, descr):
        @tree.command(name=nome, description=descr)
        async def f(inter):
            await esegui(inter, "/" + nome)

    def con_testo(nome, descr, campo):
        @tree.command(name=nome, description=descr)
        @app_commands.describe(testo=campo)
        async def f(inter, testo: str):
            await esegui(inter, f"/{nome} {testo}")

    for n, d in (("ora", "Cosa stai ascoltando"), ("amici", "Chi ascolta cosa"), ("settimana", "I tuoi ascolti della settimana"),
                 ("mix", "Il tuo mix del giorno, sul dispositivo che suona"), ("pausa", "Pausa"), ("avanti", "Brano successivo"),
                 ("indietro", "Brano precedente"), ("scollega", "Scollega il tuo account Discord da Armony"), ("aiuto", "Tutti i comandi")):
        semplice(n, d)
    for n, d, c in (("cerca", "Cerca brani, album e artisti", "cosa cercare"), ("brano", "Il file audio di un brano", "quale brano"), ("scarica", "Scarica da un link", "il link"),
                    ("collega", "Collega il tuo utente Armony", "il codice di Impostazioni → Bot"), ("notifiche", "Le notifiche di Armony in privato", "si oppure no")):
        con_testo(n, d, c)

    @tree.command(name="canale", description="Aggancia questo canale ad Armony (codice da Impostazioni → Bot → Canali)")
    @app_commands.describe(codice="il codice del canale")
    async def canale(inter, codice: str):
        if inter.guild is None:
            return await inter.response.send_message("Usalo in un canale di un server Discord, non in privato.", ephemeral=True)
        nome = f"#{getattr(inter.channel, 'name', '')} · {inter.guild.name}"
        out = await asyncio.get_running_loop().run_in_executor(None, aggancia, "discord", f"c:{inter.channel_id}", nome, codice)
        await inter.response.send_message(out, ephemeral=True)

    voce(tree, client, discord, app_commands)

    @client.event
    async def on_ready():
        await tree.sync()
        info["discord"].update(nome=str(client.user), invito=f"https://discord.com/oauth2/authorize?client_id={client.application_id}&scope=bot%20applications.commands&permissions=3072")
        info["discord"].pop("errore", None)
        A.diagnosi.log("info", "bot", f"Discord attivo: {client.user}")

    return client


# ------------------------------------------------------------------ Discord: musica nel canale vocale
# Il bot entra nel canale vocale di chi lo chiama e suona dalla libreria (Navidrome, letto in locale dal server, Opus a
# 128 kbps con ffmpeg). Una coda per server Discord. Serve aver collegato il proprio utente (/collega): si cerca e si
# suona con i suoi permessi di ascolto, come dall'app. Con /segui il bot non ha una coda sua: ogni 2 secondi guarda lo
# stato del dispositivo che suona per quell'utente (canale dal vivo) e suona lo stesso brano dallo stesso punto, come un
# ospite della Jam ma senza la Jam (che è cifrata: il server non ne vede i brani).
def flusso_nd(sid):
    return f"{A.NAVIDROME_URL}/rest/stream?" + urllib.parse.urlencode({**A.federazione.nd_params(), "id": sid, "format": "raw"})


def sorgente(discord, t, da=0):
    return discord.FFmpegOpusAudio(flusso_nd(t["id"]), bitrate=128, options="-vn",
                                   before_options=(f"-ss {da:.1f} " if da > 1 else "") + "-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5")


def cerca_brani(cosa, testo):
    """brano: i primi 5 brani; album: tutto il primo album; playlist: la prima playlist con quel nome."""
    if cosa == "playlist":
        pls = A.federazione.nd_get("getPlaylists").get("playlists", {}).get("playlist") or []
        pl = next((p for p in pls if testo.lower() in (p.get("name") or "").lower()), None)
        return (A.federazione.nd_get("getPlaylist", id=pl["id"]).get("playlist", {}).get("entry") or []) if pl else []
    r = A.federazione.nd_get("search3", query=testo, songCount=5 if cosa == "brano" else 0, albumCount=1 if cosa == "album" else 0,
                             artistCount=0).get("searchResult3") or {}
    if cosa == "album":
        al = (r.get("album") or [None])[0]
        return (A.federazione.nd_get("getAlbum", id=al["id"]).get("album", {}).get("song") or []) if al else []
    return (r.get("song") or [])[:1]


def voce(tree, client, discord, app_commands):
    gilde = {}  # id del server Discord -> {"coda": [brani], "ora": brano, "testo": canale dove scrivere}

    async def collegato(inter):
        u = await asyncio.get_running_loop().run_in_executor(None, chi, "discord", str(inter.user.id))
        if not u:
            await inter.response.send_message("🔒 Prima collega il tuo utente: /collega con il codice di Armony.", ephemeral=True)
        return u

    async def prossimo(gid):
        g_, vc = gilde.get(gid), discord.utils.get(client.voice_clients, guild=client.get_guild(gid))
        if not g_ or not vc or not vc.is_connected():
            return
        if not g_["coda"]:
            g_["ora"] = None
            return
        t = g_["ora"] = g_["coda"].pop(0)
        g_["voti"] = set()
        loop = asyncio.get_running_loop()
        vc.play(sorgente(discord, t), after=lambda e: asyncio.run_coroutine_threadsafe(prossimo(gid), loop))
        if g_.get("testo"):
            await g_["testo"].send(f"🎶 Ora: «{t.get('title')}» · {t.get('artist') or ''}")

    def suona_cmd(nome, descr, cosa):
        @tree.command(name=nome, description=descr)
        @app_commands.describe(testo="cosa cercare")
        async def f(inter, testo: str):
            if not await collegato(inter):
                return
            if inter.guild is None or not getattr(inter.user, "voice", None) or not inter.user.voice.channel:
                return await inter.response.send_message("🎧 Entra prima in un canale vocale di questo server.", ephemeral=True)
            await inter.response.defer(thinking=True)
            brani = await asyncio.get_running_loop().run_in_executor(None, cerca_brani, cosa, testo)
            if not brani:
                return await inter.followup.send(f"Niente per «{testo}».")
            vc = inter.guild.voice_client
            if not vc:
                vc = await inter.user.voice.channel.connect()
            elif vc.channel != inter.user.voice.channel:
                await vc.move_to(inter.user.voice.channel)
            g_ = gilde.setdefault(inter.guild.id, {"coda": [], "ora": None})
            if g_.pop("segue", None):  # si smette di seguire: da qui suona la coda del canale
                vc.stop()
            g_["coda"] += brani
            g_["testo"] = inter.channel
            if not vc.is_playing() and not vc.is_paused():
                await prossimo(inter.guild.id)
            primo = brani[0]
            await inter.followup.send(f"➕ In coda: «{primo.get('title')}»" + (f" e altri {len(brani) - 1}" if len(brani) > 1 else ""))

    async def segui_giro(gid, u, testo):
        """Ogni 2 secondi: stesso brano e stesso punto dell'utente (scarto oltre 6 secondi = si riparte da lì)."""
        loop, ora = asyncio.get_running_loop(), {"id": None, "p0": 0.0, "t0": 0.0, "ferma": None}
        while (gilde.get(gid) or {}).get("segue") == u:
            vc = discord.utils.get(client.voice_clients, guild=client.get_guild(gid))
            if not vc or not vc.is_connected():
                break
            st = await loop.run_in_executor(None, suona, u) or {}
            t = st.get("track") if isinstance(st.get("track"), dict) else None
            if not t or not st.get("playing") or t.get("fed") or t.get("web"):
                if vc.is_playing():
                    vc.pause()
                    ora["ferma"] = time.time()
            else:
                pos = float(st.get("position") or 0) + max(0.0, time.time() - float(st.get("at") or time.time()))
                mio = ora["p0"] + ((ora["ferma"] or time.time()) - ora["t0"])
                if t["id"] != ora["id"] or abs(mio - pos) > 6:
                    if vc.is_playing() or vc.is_paused():
                        vc.stop()
                    vc.play(sorgente(discord, t, pos))
                    if t["id"] != ora["id"] and testo:
                        await testo.send(f"🎧 Con {u}: «{t.get('title')}» · {t.get('artist') or ''}")
                    ora.update(id=t["id"], p0=pos, t0=time.time(), ferma=None)
                elif vc.is_paused():
                    ora["t0"] += time.time() - ora["ferma"]
                    ora["ferma"] = None
                    vc.resume()
            await asyncio.sleep(2)

    @tree.command(name="segui", description="Il bot suona nel canale vocale quello che stai ascoltando tu, dallo stesso punto")
    async def segui(inter):
        u = await collegato(inter)
        if not u:
            return
        if inter.guild is None or not getattr(inter.user, "voice", None) or not inter.user.voice.channel:
            return await inter.response.send_message("🎧 Entra prima in un canale vocale di questo server.", ephemeral=True)
        vc = inter.guild.voice_client
        if not vc:
            vc = await inter.user.voice.channel.connect()
        elif vc.channel != inter.user.voice.channel:
            await vc.move_to(inter.user.voice.channel)
        if vc.is_playing() or vc.is_paused():
            vc.stop()
        gilde[inter.guild.id] = {"coda": [], "ora": None, "segue": u}  # la coda del canale lascia il posto
        asyncio.get_running_loop().create_task(segui_giro(inter.guild.id, u, inter.channel))
        await inter.response.send_message(f"🎧 Ascoltate con {u}: quello che suona sui suoi dispositivi suona qui. /esci per smettere.")

    suona_cmd("suona", "Suona un brano nel tuo canale vocale", "brano")
    suona_cmd("album", "Suona un album intero nel tuo canale vocale", "album")
    suona_cmd("playlist", "Suona una playlist nel tuo canale vocale", "playlist")

    @tree.command(name="coda", description="Cosa suona nel canale vocale")
    async def coda(inter):
        g_ = gilde.get(inter.guild_id) if inter.guild_id else None
        if not g_ or not g_["ora"]:
            return await inter.response.send_message("🔇 Niente in riproduzione.", ephemeral=True)
        righe = [f"▶️ «{g_['ora'].get('title')}» · {g_['ora'].get('artist') or ''}"] + [f"{i}. «{t.get('title')}»" for i, t in enumerate(g_["coda"][:10], 1)]
        await inter.response.send_message("\n".join(righe) + (f"\n…e altri {len(g_['coda']) - 10}" if len(g_["coda"]) > 10 else ""), ephemeral=True)

    @tree.command(name="salta", description="Il brano successivo nel canale vocale (con più persone, a voti)")
    async def salta(inter):
        vc = inter.guild.voice_client if inter.guild else None
        if (gilde.get(inter.guild_id) or {}).get("segue"):
            return await inter.response.send_message("🎧 Qui si segue un utente: il brano lo cambia lui dal suo dispositivo.", ephemeral=True)
        if not vc or not vc.is_playing():
            return await inter.response.send_message("🔇 Niente da saltare.", ephemeral=True)
        # con più di due persone nel canale si salta a maggioranza: uno solo non cambia la musica a tutti
        persone = {m.id for m in vc.channel.members if not m.bot} | {inter.user.id}
        voti = gilde.setdefault(inter.guild_id, {"coda": [], "ora": None}).setdefault("voti", set())
        voti.add(inter.user.id)
        voti &= persone
        serve = len(persone) // 2 + 1 if len(persone) > 2 else 1
        if len(voti) < serve:
            return await inter.response.send_message(f"🗳️ Voto per saltare: {len(voti)} su {serve}.")
        vc.stop()  # «after» fa partire il successivo
        await inter.response.send_message("⏭️ Saltato.")

    @tree.command(name="esci", description="Il bot esce dal canale vocale")
    async def esci(inter):
        vc = inter.guild.voice_client if inter.guild else None
        gilde.pop(inter.guild_id, None)
        if vc:
            await vc.disconnect()
        await inter.response.send_message("👋 Uscito." if vc else "Non ero in un canale vocale.", ephemeral=True)


def dc_avvia():
    """Gira sempre: senza token aspetta; un token nuovo chiude il client (riavvia()) e si riparte subito."""
    pausa = 60

    async def principale(tk):
        dc["loop"] = asyncio.get_running_loop()
        async with dc_client() as client:
            await client.start(tk)

    while True:
        tk = token("discord")
        if not tk:
            time.sleep(5)
            continue
        t0 = time.time()
        try:
            asyncio.run(principale(tk))
        except Exception as e:  # noqa: BLE001 - token sbagliato, rete caduta: si riprova con calma
            info["discord"]["errore"] = "Token non valido: rigeneralo nel Developer Portal" if "Improper token" in str(e) else str(e)[:200]
            A.diagnosi.log("avviso", "bot", f"Discord: {e}"[:300])
        dc["loop"] = dc["client"] = None
        if dc["riavvia"]:
            dc["riavvia"], pausa = False, 60
            continue
        pausa = 60 if time.time() - t0 > 600 else min(pausa * 2, 1800)
        aspetta(pausa, "discord", tk)


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)


def start():
    for f in (postino, tg_giro, dc_avvia, novita, riepilogo):
        threading.Thread(target=f, daemon=True).start()
