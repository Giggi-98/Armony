"""
Armony - bot di Telegram e Discord (capacità "bot").

  GET    /api/bot                 per l'utente: quali bot ha il server (nome, link) e le chat che ha collegato
  POST   /api/bot/codice          {rete}: un codice di 6 cifre, 10 minuti, da mandare al bot con /collega
  PUT    /api/bot/<rete>/<chat>   {notifiche}: le notifiche di Armony arrivano anche lì (sì di partenza)
  DELETE /api/bot/<rete>/<chat>   scollega quella chat

Telegram: TELEGRAM_BOT_TOKEN nel .env; il server chiede i messaggi a Telegram (getUpdates, attesa lunga) in un thread,
niente librerie e niente porte da aprire. Il codice arriva anche col link https://t.me/<bot>?start=<codice>.
Discord: DISCORD_BOT_TOKEN; discord.py in un thread col suo loop, comandi «slash», notifiche in messaggio privato.
I comandi sono gli stessi sui due (comando()): collega, cerca, ora, amici, scarica, pausa, avanti, indietro,
notifiche, scollega, aiuto. Ogni chat collegata agisce come il suo utente Armony, con i suoi permessi.

─── PERCHÉ un codice e non la password ───
Il bot vede solo un numero di chat: niente password che passano da Telegram o Discord. Il codice lo crea l'utente già
dentro Armony, vale una volta e 10 minuti; scollegare dalla pagina o col comando toglie subito l'accesso.
"""
import asyncio
import os
import queue
import re
import secrets
import threading
import time

import requests
from flask import Blueprint, g, jsonify, request

import db

bp = Blueprint("bot", __name__)
A = None
TG = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
TG_API = os.environ.get("TELEGRAM_API", "https://api.telegram.org").rstrip("/")  # diverso solo nelle prove
DC = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
RETI = ("telegram", "discord")
CODICE_S = 600
codici = {}               # codice -> (utente, rete, scadenza)
info = {"telegram": {}, "discord": {}}  # nome del bot e link, dopo il primo contatto riuscito
uscita = queue.Queue(maxsize=500)       # messaggi da mandare: (rete, chat, testo)
dc = {"client": None, "loop": None}

AIUTO = """🎵 Armony, comandi:
/cerca testo — brani, album e artisti
/ora — cosa stai ascoltando
/amici — chi ascolta cosa adesso
/scarica link — scarica un brano o una playlist (YouTube, SoundCloud…)
/pausa · /avanti · /indietro — comandi al dispositivo che suona
/notifiche si|no — le notifiche di Armony anche qui
/scollega — questa chat non è più collegata al tuo utente"""


# ------------------------------------------------------------------ collegamento con Armony (pagina Impostazioni → Bot)
def chats(user):
    return db.all_("SELECT rete, chat, nome, notifiche, created FROM bot_chat WHERE user = ? ORDER BY created", user)


@bp.get("/api/bot")
def stato():
    u = g.who.get("user")
    return jsonify(telegram=dict(on=bool(TG), **info["telegram"]), discord=dict(on=bool(DC), **info["discord"]),
                   chats=[dict(r) for r in chats(u)] if u else [])


@bp.post("/api/bot/codice")
def nuovo_codice():
    u, rete = g.who.get("user"), str((request.get_json(silent=True) or {}).get("rete") or "")
    if not u:
        return jsonify(error="Serve un utente: l'accesso di emergenza non ha chat da collegare"), 400
    if rete not in RETI or not (TG if rete == "telegram" else DC):
        return jsonify(error="Questo bot non è attivo sul server"), 400
    now = time.time()
    for k in [k for k, v in codici.items() if v[2] < now or v[0] == u and v[1] == rete]:
        codici.pop(k, None)
    c = f"{secrets.randbelow(900000) + 100000}"
    codici[c] = (u, rete, now + CODICE_S)
    return jsonify(codice=c, scade=now + CODICE_S, link=f"https://t.me/{info['telegram']['nome']}?start={c}"
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
        c = codici.pop(re.sub(r"\D", "", arg), None)
        if not c or c[1] != rete or c[2] < time.time():
            return "❌ Codice non valido o scaduto: creane uno nuovo in Armony, Impostazioni → Bot."
        db.run("INSERT INTO bot_chat (rete, chat, user, nome, notifiche, created) VALUES (?, ?, ?, ?, 1, ?) "
               "ON CONFLICT(rete, chat) DO UPDATE SET user = excluded.user, nome = excluded.nome", rete, str(chat), c[0], str(nome or "")[:80], time.time())
        A.notifiche.notifica(c[0], "dispositivi", f"🤖 {rete.capitalize()} collegato", f"{nome or 'Una chat'} ora agisce come te", "#/impostazioni/bot")
        return f"✅ Collegato: qui sei {c[0]} su {A.NAME}. Le notifiche di Armony arriveranno anche qui (/notifiche no per spegnerle).\n\n{AIUTO}"
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


# ------------------------------------------------------------------ notifiche di Armony verso le chat collegate
def inoltra(user, titolo, corpo="", link=None):
    for r in db.all_("SELECT rete, chat FROM bot_chat WHERE user = ? AND notifiche = 1", user):
        testo = titolo + (f"\n{corpo}" if corpo else "") + (f"\n{url(link)}" if link and url() else "")
        try:
            uscita.put_nowait((r["rete"], r["chat"], testo))
        except queue.Full:
            pass


def postino():
    while True:
        rete, chat, testo = uscita.get()
        try:
            if rete == "telegram" and TG:
                tg("sendMessage", chat_id=chat, text=testo[:4000], disable_web_page_preview=True)
            elif rete == "discord" and dc["loop"]:
                asyncio.run_coroutine_threadsafe(dc_manda(chat, testo), dc["loop"]).result(20)
        except Exception as e:  # noqa: BLE001
            A.diagnosi.log("avviso", "bot", f"messaggio a {rete} non mandato: {e}"[:300])


# ------------------------------------------------------------------ Telegram: getUpdates con attesa lunga, niente librerie
def tg(method, timeout=40, **params):
    r = requests.post(f"{TG_API}/bot{TG}/{method}", json=params, timeout=timeout).json()
    if not r.get("ok"):
        raise RuntimeError(r.get("description") or "Telegram ha rifiutato")
    return r["result"]


def tg_giro():
    pausa, offset = 5, None
    while True:
        try:
            if not info["telegram"].get("nome"):
                info["telegram"]["nome"] = tg("getMe")["username"]
                tg("setMyCommands", commands=[{"command": c, "description": d} for c, d in (
                    ("cerca", "Cerca brani, album e artisti"), ("ora", "Cosa stai ascoltando"), ("amici", "Chi ascolta cosa"),
                    ("scarica", "Scarica da un link"), ("pausa", "Pausa"), ("avanti", "Brano successivo"), ("indietro", "Brano precedente"),
                    ("notifiche", "si/no: le notifiche anche qui"), ("collega", "Collega il tuo utente con il codice"),
                    ("scollega", "Scollega questa chat"), ("aiuto", "Tutti i comandi"))])
                A.diagnosi.log("info", "bot", f"Telegram attivo: @{info['telegram']['nome']}")
            for up in tg("getUpdates", timeout=40, offset=offset, allowed_updates=["message"]):
                offset = up["update_id"] + 1
                m = up.get("message") or {}
                if not m.get("text") or (m.get("chat") or {}).get("type") != "private":
                    continue  # solo chat private: in un gruppo chiunque scriverebbe come te
                fr = m.get("from") or {}
                out = rispondi("telegram", m["chat"]["id"], fr.get("username") or fr.get("first_name"), m["text"])
                if out:
                    uscita.put(("telegram", m["chat"]["id"], out))
            pausa = 5
        except Exception as e:  # noqa: BLE001 - rete caduta, token sbagliato: si riprova con calma
            A.diagnosi.log("avviso", "bot", f"Telegram: {e}"[:300])
            time.sleep(pausa)
            pausa = min(pausa * 2, 300)


# ------------------------------------------------------------------ Discord: discord.py, comandi slash
async def dc_manda(chat, testo):
    u = await dc["client"].fetch_user(int(chat))
    await u.send(testo[:1900])


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

    @client.event
    async def on_ready():
        await tree.sync()
        info["discord"].update(nome=str(client.user), invito=f"https://discord.com/oauth2/authorize?client_id={client.application_id}&scope=bot%20applications.commands")
        A.diagnosi.log("info", "bot", f"Discord attivo: {client.user}")

    return client


def dc_avvia():
    pausa = 60

    async def principale():
        dc["loop"] = asyncio.get_running_loop()
        async with dc_client() as client:
            await client.start(DC)

    while True:
        t0 = time.time()
        try:
            asyncio.run(principale())
        except Exception as e:  # noqa: BLE001 - token sbagliato, rete caduta: si riprova con calma
            A.diagnosi.log("avviso", "bot", f"Discord: {e}"[:300])
        dc["loop"] = dc["client"] = None
        pausa = 60 if time.time() - t0 > 600 else min(pausa * 2, 1800)
        time.sleep(pausa)


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)


def start():
    if not (TG or DC):
        return
    threading.Thread(target=postino, daemon=True).start()
    if TG:
        threading.Thread(target=tg_giro, daemon=True).start()
    if DC:
        threading.Thread(target=dc_avvia, daemon=True).start()
