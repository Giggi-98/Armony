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

Un CANALE è un gruppo o un canale Telegram, o un canale testuale Discord, dove il bot racconta cosa fanno gli utenti
scelti (ascolti, rientri, playlist, download, Jam, radio: i tipi scelti). Si aggancia scrivendo lì /canale <codice>.
Vale «Mostra agli altri cosa ascolto»: chi l'ha spento non compare.

─── PERCHÉ un codice e non la password ───
Il bot vede solo un numero di chat: niente password che passano da Telegram o Discord. Il codice lo crea chi è già
dentro Armony, vale una volta e 10 minuti; scollegare dalla pagina o col comando toglie subito l'accesso.
"""
import asyncio
import json
import os
import queue
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
        "download": "⬇️ Download e caricamenti", "jam": "🎉 Jam", "radio": "📻 Radio"}
codici = {}               # codice -> (utente, rete, scadenza) per le chat; ("#canale", id, scadenza) per i canali
info = {"telegram": {}, "discord": {}}  # nome del bot, link, ultimo errore: dopo il primo contatto
uscita = queue.Queue(maxsize=500)       # messaggi da mandare: (rete, chat, testo); chat "c:<id>" = canale Discord
dc = {"client": None, "loop": None, "riavvia": False}

AIUTO = """🎵 Armony, comandi:
/cerca testo — brani, album e artisti
/ora — cosa stai ascoltando
/amici — chi ascolta cosa adesso
/scarica link — scarica un brano o una playlist (YouTube, SoundCloud…)
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


def c_cmd(nome, verbo):
    def f(u, _):
        st = suona(u)
        if not st:
            return "🔇 Nessun tuo dispositivo collegato."
        A.manda_cmd(u, st["device"], nome)
        return f"{verbo} su {st.get('name') or 'il tuo dispositivo'}"
    return f


COMANDI = {"cerca": c_cerca, "ora": c_ora, "amici": c_amici, "scarica": c_scarica,
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
        if attore in json.loads(r["utenti"] or "[]") and tipo in json.loads(r["tipi"] or "[]"):
            manda(r["rete"], r["chat"], testo + (f"\n{url(link)}" if link and url() else ""))


def postino():
    while True:
        rete, chat, testo = uscita.get()
        try:
            if rete == "telegram" and token("telegram"):
                tg("sendMessage", chat_id=chat, text=testo[:4000], disable_web_page_preview=True)
            elif rete == "discord" and dc["loop"]:
                asyncio.run_coroutine_threadsafe(dc_manda(chat, testo), dc["loop"]).result(20)
        except Exception as e:  # noqa: BLE001
            A.diagnosi.log("avviso", "bot", f"messaggio a {rete} non mandato: {e}"[:300])


# ------------------------------------------------------------------ Telegram: getUpdates con attesa lunga, niente librerie
def tg(method, timeout=40, **params):
    r = requests.post(f"{TG_API}/bot{token('telegram')}/{method}", json=params, timeout=timeout).json()
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
                    ("cerca", "Cerca brani, album e artisti"), ("ora", "Cosa stai ascoltando"), ("amici", "Chi ascolta cosa"),
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
        out = await asyncio.get_running_loop().run_in_executor(None, rispondi, "discord", str(inter.user.id), inter.user.name, testo)
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

    for n, d in (("ora", "Cosa stai ascoltando"), ("amici", "Chi ascolta cosa"), ("pausa", "Pausa"), ("avanti", "Brano successivo"),
                 ("indietro", "Brano precedente"), ("scollega", "Scollega il tuo account Discord da Armony"), ("aiuto", "Tutti i comandi")):
        semplice(n, d)
    for n, d, c in (("cerca", "Cerca brani, album e artisti", "cosa cercare"), ("scarica", "Scarica da un link", "il link"),
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
# suona con i suoi permessi di ascolto, come dall'app.
def flusso_nd(sid):
    return f"{A.NAVIDROME_URL}/rest/stream?" + urllib.parse.urlencode({**A.federazione.nd_params(), "id": sid, "format": "raw"})


def sorgente(discord, t):
    return discord.FFmpegOpusAudio(flusso_nd(t["id"]), bitrate=128, before_options="-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5",
                                   options="-vn")


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
            g_["coda"] += brani
            g_["testo"] = inter.channel
            if not vc.is_playing() and not vc.is_paused():
                await prossimo(inter.guild.id)
            primo = brani[0]
            await inter.followup.send(f"➕ In coda: «{primo.get('title')}»" + (f" e altri {len(brani) - 1}" if len(brani) > 1 else ""))

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

    @tree.command(name="salta", description="Il brano successivo nel canale vocale")
    async def salta(inter):
        vc = inter.guild.voice_client if inter.guild else None
        if not vc or not vc.is_playing():
            return await inter.response.send_message("🔇 Niente da saltare.", ephemeral=True)
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
    for f in (postino, tg_giro, dc_avvia):
        threading.Thread(target=f, daemon=True).start()
