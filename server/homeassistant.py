"""
Armony - Home Assistant (capacità "homeassistant").

  GET    /api/homeassistant                 (utente) se ho un gettone e la configurazione da incollare in Home Assistant
  POST   /api/homeassistant                 (utente) un gettone nuovo (il vecchio smette di valere): si vede una volta sola
  DELETE /api/homeassistant                 (utente) toglie il gettone
  GET    /api/ha/<gettone>/stato            (Home Assistant) cosa suona, dove, il volume, i dispositivi
  POST   /api/ha/<gettone>/<azione>         (Home Assistant) play, pause, toggle, next, prev, volume, mix, playlist, stop
                                            {dispositivo?, volume?, playlist?}

Home Assistant non ha un account Armony: ha un gettone dell'utente, che vale solo per la sua musica e solo dalla rete
di casa (Home Assistant sta lì). Le azioni sono quelle del telecomando (manda_cmd): valgono per i dispositivi
dell'utente, le TV e le casse. Senza «dispositivo» si comanda quello che suona (o ha suonato per ultimo).

─── PERCHÉ un gettone e REST, non un'integrazione di Home Assistant ───
Con rest_command e un sensore REST bastano due blocchi di YAML, senza installare niente in Home Assistant e senza
seguirne le versioni. Il gettone sta nel database solo come impronta (sha256): chi legge il database non lo ricava.
"""
import hashlib
import secrets

from flask import Blueprint, g, jsonify, request

import db

bp = Blueprint("homeassistant", __name__)
A = None
AZIONI = ("play", "pause", "toggle", "next", "prev", "volume", "mix", "playlist", "stop")


def impronta(t):
    return hashlib.sha256(t.encode()).hexdigest()


def di_chi(gettone):
    r = db.one("SELECT key FROM settings WHERE key LIKE 'ha_token:%' AND value = ?", impronta(gettone))
    return r["key"].split(":", 1)[1] if r else None


def yaml(base, gettone):
    u = f"{base}/api/ha/{gettone}"
    return f"""# Armony in Home Assistant: incolla in configuration.yaml e riavvia Home Assistant
rest_command:
  armony:
    url: "{u}/{{{{ azione }}}}"
    method: POST
    content_type: "application/json"
    payload: '{{"dispositivo": {{{{ dispositivo | default("") | tojson }}}}, "volume": {{{{ volume | default(0) }}}}, "playlist": {{{{ playlist | default("") | tojson }}}}}}'

sensor:
  - platform: rest
    name: Armony
    resource: "{u}/stato"
    scan_interval: 10
    value_template: "{{{{ value_json.titolo if value_json.suona else 'in pausa' if value_json.titolo else 'spento' }}}}"
    json_attributes: [suona, titolo, artista, album, dispositivo, nome_dispositivo, volume, dispositivi]

# Esempio di automazione: quando arrivi a casa, il tuo mix del giorno sulla TV
# automation:
#   - alias: "Musica al rientro"
#     trigger: {{platform: state, entity_id: person.tu, to: home}}
#     action:
#       - service: rest_command.armony
#         data: {{azione: mix, dispositivo: "<id dal sensore, attributo dispositivi>"}}
# Azioni: play, pause, toggle, next, prev, stop, volume (con volume: 0.4), mix, playlist (con playlist: <id>)
"""


@bp.get("/api/homeassistant")
def mio():
    u = g.who.get("user") or ""
    return jsonify(attivo=bool(db.one("SELECT 1 FROM settings WHERE key = ?", "ha_token:" + u)), base=A.trasferimento.ip_casa())


@bp.post("/api/homeassistant")
def nuovo():
    u = g.who.get("user")
    if not u:
        return jsonify(error="Serve un utente"), 400
    t = secrets.token_urlsafe(32)
    db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", "ha_token:" + u, impronta(t))
    base = A.trasferimento.ip_casa() or "http://INDIRIZZO-DI-ARMONY:8080"
    return jsonify(attivo=True, gettone=t, yaml=yaml(base, t))


@bp.delete("/api/homeassistant")
def via():
    db.run("DELETE FROM settings WHERE key = ?", "ha_token:" + (g.who.get("user") or ""))
    return jsonify(attivo=False)


def utente(gettone):
    if not A.dispositivi.is_local():
        return None, (jsonify(error="Home Assistant comanda Armony solo dalla rete di casa"), 403)
    u = di_chi(gettone)
    return (u, None) if u else (None, (jsonify(error="Gettone non valido"), 401))


def dispositivi(u):
    with A.llock:
        out = {c["device"]: c.get("name") or c["device"] for c in A.lconns.get(u, {}).values()}
    out.update({d["device"]: d["name"] for d in A.casa.per({"net": "locale"})})
    return out


@bp.get("/api/ha/<gettone>/stato")
def stato(gettone):
    u, no = utente(gettone)
    if no:
        return no
    st = A.bot.suona(u) or {}
    t = st.get("track") if isinstance(st.get("track"), dict) else {}
    return jsonify(suona=bool(st.get("playing")), titolo=t.get("title"), artista=t.get("artist"), album=t.get("album"),
                   dispositivo=st.get("device"), nome_dispositivo=st.get("name"), volume=st.get("volume"),
                   dispositivi=[{"id": k, "nome": v} for k, v in dispositivi(u).items()])


@bp.post("/api/ha/<gettone>/<azione>")
def comanda(gettone, azione):
    u, no = utente(gettone)
    if no:
        return no
    if azione not in AZIONI:
        return jsonify(error=f"Azione sconosciuta: {', '.join(AZIONI)}"), 400
    d = request.get_json(silent=True) or {}
    dev = str(d.get("dispositivo") or "") or (A.bot.suona(u) or {}).get("device")
    if not dev or dev not in dispositivi(u):
        return jsonify(error="Nessun dispositivo: scrivilo in «dispositivo» (gli id sono nel sensore, attributo dispositivi)"), 409
    try:
        if azione in ("mix", "playlist"):
            brani = []
            if azione == "playlist" and d.get("playlist"):
                brani = [A.bot.brano_wire(t) for t in (A.federazione.nd_get("getPlaylist", id=str(d["playlist"])).get("playlist", {}).get("entry") or [])[:1000]]
            brani = brani or A.bot.mix_del_giorno(u)[1]
            A.manda_cmd(u, dev, "transfer", {"queue": brani, "index": 0, "position": 0, "shuffle": False, "repeat": "off"}, "homeassistant")
        elif azione == "volume":
            A.manda_cmd(u, dev, "volume", max(0.0, min(1.0, float(d.get("volume") or 0))), "homeassistant")
        else:
            A.manda_cmd(u, dev, "pause" if azione == "stop" else azione, None, "homeassistant")
    except (ValueError, RuntimeError, TypeError) as e:
        return jsonify(error=str(e)[:200]), 409
    return jsonify(ok=True, dispositivo=dev)


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)
