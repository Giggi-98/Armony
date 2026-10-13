"""
Armony - TV e casse di casa come dispositivi di «Dove suona» (capacità "casa").

  GET  /api/casa                          TV e casse trovate in rete (DLNA/UPnP), con chi le sta usando
  POST /api/casa/cerca                    cerca adesso (di solito si cerca da soli ogni minuto)
  GET  /api/casa/flusso/<gettone>/<id>    il brano per la TV: pubblica ma solo dalla rete di casa e col gettone
  GET  /api/casa/copertina/<gettone>/<id> la copertina, idem
  GET  /api/casa/bluetooth                (admin) le casse Bluetooth del server: abbinate, collegate, trovate
  POST /api/casa/bluetooth/cerca          (admin) cerca casse vicine per una dozzina di secondi
  POST /api/casa/bluetooth/<mac>          (admin) {azione: abbina | collega | scollega | dimentica | tuttacasa_si | tuttacasa_no}
  GET  /api/casa/stanze                   le stanze di «Tutta la casa» (Snapcast): nome, collegata, volume, muto
  PUT  /api/casa/stanze/<id>              {volume?, muto?, nome?}

Il server sta in casa (rete host): manda un messaggio multicast SSDP e le smart TV (Samsung, LG, Sony…), le casse di
rete (Sonos, amplificatori) e i programmi «renderer» rispondono; con pychromecast cerca anche i Chromecast e le Android/
Google TV (mDNS). Due «driver» con gli stessi comandi: DLNA (SOAP di UPnP AVTransport) e Cast. Ognuna diventa un dispositivo virtuale «casa…» nel
canale dal vivo: compare in «Dove suona» di chi è collegato da casa (o è amministratore), si sceglie come un telefono
e si comanda da telecomando con gli stessi comandi (transfer, play, pause, next, prev, seek, skipto, enqueue, handoff, volume).
Il server tiene la coda e dice alla TV cosa suonare; ogni 2 secondi le chiede a che punto è
e, quando un brano finisce, passa al successivo. La TV scarica il brano dal server (mp3 a 320, il formato che leggono
tutte) con un gettone usa e getta della sessione.

Bluetooth (capacità "bluetooth", dopo deploy/bluetooth.sh sull'host): le casse abbinate al server (anche le Alexa, che
fanno da cassa Bluetooth) sono un terzo driver. BlueZ e PipeWire girano sull'host; qui bluetoothctl parla con BlueZ dal
bus di sistema montato, con un utente che può parlare solo con BlueZ, e ffmpeg suona il brano sull'uscita PipeWire
della cassa.

Tutta la casa (profilo "snapcast" del compose): un dispositivo che manda l'audio a Snapcast, che lo suona in sincrono
in ogni stanza (snapclient). Le casse Bluetooth del server entrano in «Tutta la casa» con uno snapclient lanciato da qui.

─── PERCHÉ dispositivi virtuali e non una funzione a parte ───
Il client sa già passare la coda a un altro dispositivo e fare da telecomando: la TV che si comporta come un
dispositivo collegato non chiede di cambiare la riproduzione nel client (Live, CLAUDE.md), e i comandi dal bot
(/pausa, /avanti) valgono anche per lei.
"""
import hashlib
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
import urllib.parse
import xml.etree.ElementTree as ET
from html import escape

import requests
from flask import Blueprint, Response, g, jsonify, request, stream_with_context

import db

bp = Blueprint("casa", __name__)
A = None
SSDP = ("239.255.255.250", 1900)
RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:1"
AVT = "urn:schemas-upnp-org:service:AVTransport:1"
RC = "urn:schemas-upnp-org:service:RenderingControl:1"
DIMENTICA = 300          # secondi senza risposte prima di togliere un dispositivo dall'elenco
lock = threading.RLock()
trovati = {}             # id -> {id, nome, ip, loc, avt, rc, modello, visto}
sessioni = {}            # id -> sessione attiva su quel dispositivo (vedi Sessione)
sveglia = threading.Event()
ultima = {"ts": None, "errori": {}, "ssdp": 0}  # l'ultima ricerca: quando, quante risposte SSDP, cosa è andato storto


# ------------------------------------------------------------------ ricerca in rete (SSDP) e descrizione dei dispositivi
def ssdp(attesa):
    """Indirizzo della descrizione -> IP, per ogni renderer che risponde al messaggio multicast."""
    msg = (f"M-SEARCH * HTTP/1.1\r\nHOST: {SSDP[0]}:{SSDP[1]}\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {RENDERER}\r\n\r\n").encode()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    s.settimeout(0.5)
    risposte = {}
    try:
        s.sendto(msg, SSDP)
        s.sendto(msg, SSDP)  # UDP si perde: due volte
        fine = time.time() + attesa
        while time.time() < fine:
            try:
                data, addr = s.recvfrom(8192)
            except socket.timeout:
                continue
            m = re.search(r"(?im)^location:\s*(\S+)", data.decode(errors="replace"))
            if m:
                risposte[m.group(1)] = addr[0]
    except OSError:
        pass
    finally:
        s.close()
    return risposte


def cerca(attesa=3):
    nuovi, via, errori = [], [], {}
    trovate = []
    risposte = ssdp(attesa) if A.MULTICAST else {}
    for loc, ip in risposte.items():
        try:
            trovate.append(descrivi(loc, ip))
        except (requests.RequestException, ET.ParseError, ValueError) as e:
            errori["dlna"] = f"{ip}: {e}"[:200]
    for nome_, f in (("cast", (lambda: cerca_cast(attesa)) if A.MULTICAST else list), ("bluetooth", cerca_bt), ("snapcast", cerca_snap)):
        try:  # una fonte che va storta (Bluetooth, Snapcast) non deve far sparire le altre
            trovate += f()
        except Exception as e:  # noqa: BLE001
            errori[nome_] = str(e)[:200]
            A.diagnosi.log("avviso", "casa", f"ricerca {nome_}: {e}"[:300])
    ultima.update(ts=time.time(), errori=errori, ssdp=len(risposte))
    for d in trovate:
        with lock:
            if d["id"] in trovati:
                trovati[d["id"]].update({k: v for k, v in d.items() if k != "info"})  # il Chromecast già creato resta
            else:
                trovati[d["id"]] = d
                nuovi.append(d)
    now = time.time()
    with lock:
        for k in [k for k, d in trovati.items() if now - d["visto"] > DIMENTICA and k not in sessioni]:
            via.append(trovati.pop(k))
    # fuori dal lucchetto di casa: a_chi prende quello del canale dal vivo, che live_stream tiene mentre chiama per()
    for d in nuovi:
        arrivato(d)
    for d in via:
        sparito(d)


def descrivi(loc, ip):
    """Nome, modello e indirizzi dei servizi dalla descrizione XML del dispositivo."""
    r = A.http.get(loc, timeout=5)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    ns = {"d": "urn:schemas-upnp-org:device-1-0"}
    dev = root.find("d:device", ns)
    if dev is None:
        raise ValueError("descrizione senza device")
    testo = lambda k: (dev.findtext(f"d:{k}", default="", namespaces=ns) or "").strip()  # noqa: E731
    base = root.findtext("d:URLBase", default="", namespaces=ns) or loc
    srv = {}
    for s in root.iter("{urn:schemas-upnp-org:device-1-0}service"):
        t = s.findtext("d:serviceType", default="", namespaces=ns)
        srv[t.rsplit(":", 1)[0]] = urllib.parse.urljoin(base, s.findtext("d:controlURL", default="", namespaces=ns))
    avt = srv.get(AVT.rsplit(":", 1)[0])
    if not avt:
        raise ValueError("niente AVTransport")
    udn = testo("UDN") or loc
    return {"id": "casa" + hashlib.sha1(udn.encode()).hexdigest()[:12], "tipo": "dlna", "nome": testo("friendlyName") or ip, "ip": ip, "loc": loc,
            "avt": avt, "rc": srv.get(RC.rsplit(":", 1)[0]), "modello": " ".join(x for x in (testo("manufacturer"), testo("modelName")) if x)[:80],
            "visto": time.time()}


def cerca_cast(attesa):
    """Chromecast e Android/Google TV (mDNS), se c'è pychromecast. Il Chromecast vero si crea al primo uso."""
    try:
        import pychromecast.discovery as pcd
    except ImportError:
        return []
    try:
        infos, browser = pcd.discover_chromecasts(timeout=attesa)
        pcd.stop_discovery(browser)
    except Exception as e:  # noqa: BLE001 - zeroconf che non parte non deve fermare la ricerca DLNA
        A.diagnosi.log("avviso", "casa", f"ricerca Chromecast: {e}"[:300])
        return []
    return [{"id": "casa" + hashlib.sha1(str(i.uuid).encode()).hexdigest()[:12], "tipo": "cast", "nome": i.friendly_name or i.host,
             "ip": i.host, "modello": " ".join(x for x in (i.manufacturer, i.model_name) if x)[:80], "info": i, "visto": time.time()}
            for i in infos if i.host and i.cast_type in (None, "cast", "audio", "group")]


def giro():
    time.sleep(5)
    while True:
        try:
            cerca()
        except Exception as e:  # noqa: BLE001 - la ricerca non deve mai fermarsi
            A.diagnosi.log("avviso", "casa", f"ricerca in rete: {e}"[:300])
        sveglia.wait(60)
        sveglia.clear()


# ------------------------------------------------------------------ chi li vede: dispositivi virtuali nel canale dal vivo
def nome(d):
    return f"{ {'bt': '🔊', 'snap': '🔗'}.get(d.get('tipo'), '📺')} {d['nome']}"[:40]


def visibile(c):
    """Una connessione dal vivo vede le TV di casa se è nella rete di casa o è di un amministratore."""
    return c.get("net") == "locale" or c.get("admin")


def per(conn):
    """I dispositivi virtuali da mettere nel «hello» di una connessione."""
    if not visibile(conn):
        return []
    with lock:
        return [{"device": d["id"], "name": nome(d)} for d in trovati.values()]


def esiste(dev):
    with lock:
        return dev in trovati


def a_chi(msg, filtro=None):
    """A tutte le connessioni dal vivo che vedono le TV (e, se c'è, che passano il filtro)."""
    data = json.dumps(msg)
    with A.llock:
        for u, conns in A.lconns.items():
            for c in conns.values():
                if visibile(c) and (not filtro or filtro(u, c)):
                    try:
                        c["q"].put_nowait(data)
                    except Exception:  # noqa: BLE001 - coda piena: come live_put
                        pass


def arrivato(d):
    a_chi({"type": "join", "device": d["id"], "name": nome(d)})
    A.diagnosi.log("info", "casa", f"trovato in rete: {d['nome']} ({d['modello'] or d['ip']})")


def sparito(d):
    a_chi({"type": "gone", "device": d["id"]})


# ------------------------------------------------------------------ UPnP: comandi alla TV
def soap(url, servizio, azione, *args):
    corpo = "".join(f"<{k}>{escape(str(v))}</{k}>" for k, v in args)
    xml = ('<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
           f's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:{azione} xmlns:u="{servizio}">{corpo}</u:{azione}>'
           '</s:Body></s:Envelope>')
    r = A.http.post(url, data=xml.encode(), timeout=6, headers={"Content-Type": 'text/xml; charset="utf-8"', "SOAPAction": f'"{servizio}#{azione}"'})
    if r.status_code >= 400:
        err = re.search(r"<errorDescription>([^<]*)", r.text)
        raise RuntimeError(f"{azione}: {err.group(1) if err else r.status_code}")
    out = {}
    for el in ET.fromstring(r.content).iter():
        if el.tag.endswith("Response"):
            out = {c.tag.split("}")[-1]: (c.text or "") for c in el}
    return out


def hms(s):
    s = max(0, int(s or 0))
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}"


def secondi(t):
    try:
        h, m, s = (t or "0:0:0").split(":")
        return int(h) * 3600 + int(m) * 60 + float(s)
    except ValueError:
        return 0


def didl(t, url, copertina):
    dur = f' duration="{hms(t.get("duration"))}.000"' if t.get("duration") else ""
    return ('<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" '
            'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="1" parentID="0" restricted="1">'
            f"<dc:title>{escape(t.get('title') or '')}</dc:title><dc:creator>{escape(t.get('artist') or '')}</dc:creator>"
            f"<upnp:artist>{escape(t.get('artist') or '')}</upnp:artist><upnp:album>{escape(t.get('album') or '')}</upnp:album>"
            + (f"<upnp:albumArtURI>{escape(copertina)}</upnp:albumArtURI>" if copertina else "")
            + "<upnp:class>object.item.audioItem.musicTrack</upnp:class>"
            f'<res protocolInfo="http-get:*:audio/mpeg:DLNA.ORG_PN=MP3;DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000"{dur}>'
            f"{escape(url)}</res></item></DIDL-Lite>")


# ------------------------------------------------------------------ driver: gli stessi comandi per DLNA e Chromecast
ERRORI = (RuntimeError, requests.RequestException, ET.ParseError)


class DLNA:
    def __init__(self, d):
        self.avt, self.rc = d["avt"], d.get("rc")

    def carica(self, t, url, cop, da):
        try:
            soap(self.avt, AVT, "Stop", ("InstanceID", 0))
        except ERRORI:
            pass  # già ferma: alcune TV rispondono con un errore
        soap(self.avt, AVT, "SetAVTransportURI", ("InstanceID", 0), ("CurrentURI", url), ("CurrentURIMetaData", didl(t, url, cop)))
        soap(self.avt, AVT, "Play", ("InstanceID", 0), ("Speed", 1))
        if da > 3:
            for _ in range(10):  # molte TV accettano il salto solo quando suonano già
                time.sleep(0.5)
                try:
                    if self.leggi()[0] == "PLAYING":
                        self.salta(da)
                        return da
                except ERRORI:
                    break
        return 0

    def pausa(self):
        soap(self.avt, AVT, "Pause", ("InstanceID", 0))

    def riprendi(self):
        soap(self.avt, AVT, "Play", ("InstanceID", 0), ("Speed", 1))

    def ferma(self):
        soap(self.avt, AVT, "Stop", ("InstanceID", 0))

    def salta(self, s):
        soap(self.avt, AVT, "Seek", ("InstanceID", 0), ("Unit", "REL_TIME"), ("Target", hms(s)))

    def volume(self, v=None):
        """Con v lo imposta (0…1), senza lo legge. RenderingControl: non tutte le TV lo hanno."""
        if not self.rc:
            raise RuntimeError("Questa TV non accetta il volume dalla rete")
        if v is None:
            return int(soap(self.rc, RC, "GetVolume", ("InstanceID", 0), ("Channel", "Master")).get("CurrentVolume") or 0) / 100
        soap(self.rc, RC, "SetVolume", ("InstanceID", 0), ("Channel", "Master"), ("DesiredVolume", round(v * 100)))

    def leggi(self):
        """(PLAYING | PAUSED | STOPPED | altro, posizione, durata)"""
        st = soap(self.avt, AVT, "GetTransportInfo", ("InstanceID", 0)).get("CurrentTransportState", "")
        pi = soap(self.avt, AVT, "GetPositionInfo", ("InstanceID", 0))
        st = {"PAUSED_PLAYBACK": "PAUSED", "NO_MEDIA_PRESENT": "STOPPED"}.get(st, st)
        return st, secondi(pi.get("RelTime")), secondi(pi.get("TrackDuration"))


class Cast:
    """Chromecast e Android/Google TV con pychromecast. Gli errori della libreria diventano RuntimeError."""
    def __init__(self, d):
        self.d = d

    def mc(self):
        import pychromecast
        if not self.d.get("cc"):
            self.d["cc"] = pychromecast.get_chromecast_from_cast_info(self.d["info"], None)
        self.d["cc"].wait(timeout=10)
        return self.d["cc"].media_controller

    def fai(self, f):
        try:
            return f(self.mc())
        except ERRORI:
            raise
        except Exception as e:  # noqa: BLE001 - pychromecast ha le sue eccezioni (non connesso, tempo scaduto…)
            raise RuntimeError(f"Chromecast: {e}") from e

    def carica(self, t, url, cop, da):
        meta = {"metadataType": 3, "title": t.get("title") or "", "artist": t.get("artist") or "", "albumName": t.get("album") or "",
                "images": [{"url": cop}] if cop else []}

        def f(mc):
            mc.play_media(url, "audio/mpeg", title=t.get("title"), thumb=cop or None, current_time=da or None, stream_type="BUFFERED", metadata=meta)
            mc.block_until_active(timeout=10)
        self.fai(f)
        return da

    def pausa(self):
        self.fai(lambda mc: mc.pause())

    def riprendi(self):
        self.fai(lambda mc: mc.play())

    def ferma(self):
        self.fai(lambda mc: mc.stop())

    def salta(self, s):
        self.fai(lambda mc: mc.seek(s))

    def volume(self, v=None):
        self.fai(lambda mc: None)  # collega, se non lo è
        if v is None:
            return self.d["cc"].status.volume_level if self.d["cc"].status else None
        self.d["cc"].set_volume(v)

    def leggi(self):
        def f(mc):
            st = mc.status
            mc.update_status()  # la risposta arriva dopo: vale per la lettura successiva
            stato = {"PLAYING": "PLAYING", "BUFFERING": "PLAYING", "PAUSED": "PAUSED"}.get(st.player_state, "STOPPED")
            return stato, st.adjusted_current_time or st.current_time or 0, st.duration or 0
        return self.fai(f)


# ------------------------------------------------------------------ Bluetooth del server (deploy/bluetooth.sh)
BT_UID = int(os.environ.get("ARMONY_BT_UID") or 0)   # l'utente dell'host che può parlare solo con BlueZ
BT_BUS = "/run/armony-dbus/system_bus_socket"      # il bus di sistema dell'host, montato
BT_PULSE = "/run/armony-pulse/native"              # PipeWire (protocollo PulseAudio) dell'utente dell'host
MAC = re.compile(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$")
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]|\x01|\x02")


def bt_ok():
    return BT_UID > 0 and os.path.exists(BT_BUS) and bool(shutil.which("bluetoothctl"))


def btctl(*args, attesa=20):
    """bluetoothctl con l'utente di BlueZ, mai da root: root sul bus di sistema dell'host potrebbe comandare tutto l'host."""
    try:
        r = subprocess.run(["bluetoothctl", *args], capture_output=True, text=True, timeout=attesa, user=BT_UID, group=BT_UID, extra_groups=[],
                           env={"PATH": os.environ.get("PATH", ""), "HOME": "/tmp", "DBUS_SYSTEM_BUS_ADDRESS": f"unix:path={BT_BUS}"})
    except subprocess.TimeoutExpired as e:
        return ANSI.sub("", (e.stdout or b"").decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or ""))
    return ANSI.sub("", r.stdout + r.stderr)


def bt_problema():
    """Perché il Bluetooth non risponde, in parole, o None se va."""
    t = btctl("list", attesa=10)
    if "connection != NULL" in t or "Failed to connect" in t or "Access denied" in t:
        return ("Armony non riesce a parlare con il Bluetooth del server (con AppArmor il bus di sistema rifiuta i container): "
                "aggiorna Armony e rilancia sudo sh deploy/bluetooth.sh, che mette il ponte D-Bus")
    if not re.search(r"^Controller ", t, re.M):
        return "Il server non vede un adattatore Bluetooth acceso (spento con rfkill? chiavetta staccata? sudo systemctl status bluetooth)"
    return None


def bt_elenco(quali=None):
    """[{mac, nome}] dei dispositivi che BlueZ conosce (quali = "Paired" per i soli abbinati)."""
    out = []
    for riga in btctl("devices", *([quali] if quali else [])).splitlines():
        m = re.match(r"^Device ([0-9A-F:]{17}) (.*)$", riga.strip())
        if m and m.group(2).replace("-", ":") != m.group(1):  # senza nome BlueZ ripete l'indirizzo
            out.append({"mac": m.group(1), "nome": m.group(2).strip()})
    return out


def bt_info(mac):
    t = btctl("info", mac)
    v = lambda k: (re.search(rf"^\s*{k}: (.*)$", t, re.M) or [None, ""])[1].strip()  # noqa: E731
    return {"abbinato": v("Paired") == "yes", "collegato": v("Connected") == "yes", "icona": v("Icon"),
            "cassa": "Audio Sink" in t or v("Icon").startswith("audio")}


def cerca_bt():
    """Le casse abbinate al server diventano dispositivi di «Dove suona», anche spente: sceglierle le collega."""
    if not bt_ok():
        return []
    problema = bt_problema()
    if problema:
        raise RuntimeError(problema)  # lo mostra «TV e casse in rete»
    out = []
    for x in bt_elenco("Paired"):
        i = bt_info(x["mac"])
        if i["cassa"]:
            out.append({"id": "casa" + hashlib.sha1(("bt" + x["mac"]).encode()).hexdigest()[:12], "tipo": "bt", "nome": x["nome"], "ip": "",
                        "mac": x["mac"], "modello": "Bluetooth" + (", collegata" if i["collegato"] else ""), "visto": time.time()})
    return out


def pactl_uscite():
    try:
        r = subprocess.run(["pactl", "list", "short", "sinks"], capture_output=True, text=True, timeout=5, env={**os.environ, "PULSE_SERVER": f"unix:{BT_PULSE}"})
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [c.split("\t")[1] for c in r.stdout.splitlines() if "\t" in c]


class Flusso:
    """ffmpeg legge il brano dal server e lo manda a un'uscita (destinazione(): gli argomenti di uscita e l'ambiente).
    Pausa e salto fermano ffmpeg e lo rifanno partire dal punto giusto (un ffmpeg fermo a metà perderebbe il
    collegamento al brano). Base della cassa Bluetooth e di «Tutta la casa» (Snapcast)."""
    ingresso = []  # opzioni prima di -i

    def __init__(self, d):
        self.d, self.p, self.url, self.da, self.t0, self.stato = d, None, None, 0.0, 0.0, "STOPPED"
        self.lk = threading.Lock()

    def avvia(self, da):
        self.chiudi()
        uscita, env = self.destinazione()
        self.p = subprocess.Popen(["ffmpeg", "-nostdin", "-loglevel", "error", *self.ingresso, "-ss", f"{max(0, da):.1f}", "-i", self.url, "-vn", *uscita],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env={**os.environ, **env})
        self.da, self.t0, self.stato = max(0, da), time.time(), "PLAYING"

    def chiudi(self):
        if self.p:
            self.p.terminate()
            try:
                self.p.wait(3)
            except subprocess.TimeoutExpired:
                self.p.kill()
            self.p = None

    def pos(self):
        return self.da + (time.time() - self.t0 if self.stato == "PLAYING" else 0)

    def carica(self, t, url, cop, da):
        with self.lk:
            self.url = url
            self.avvia(da)
        return da

    def pausa(self):
        with self.lk:
            self.da, self.stato = self.pos(), "PAUSED"
            self.chiudi()

    def riprendi(self):
        with self.lk:
            self.avvia(self.da)

    def ferma(self):
        with self.lk:
            self.chiudi()
            self.stato = "STOPPED"

    def salta(self, s):
        with self.lk:
            if self.stato == "PLAYING":
                self.avvia(s)
            else:
                self.da = s

    def leggi(self):
        with self.lk:
            if self.stato == "PLAYING" and self.p and self.p.poll() is not None:
                rc, err = self.p.returncode, (self.p.stderr.read() or b"").decode(errors="replace").strip()
                self.p, self.stato = None, "STOPPED" if rc == 0 else "ERRORE"
                self.err = err.splitlines()[-1][:200] if err else f"ffmpeg è uscito con {rc}"
            if self.stato == "ERRORE":
                raise RuntimeError(f"{self.d['nome']}: {self.err}")
            return self.stato, self.pos(), 0


class BT(Flusso):
    """Una cassa Bluetooth: il brano va sull'uscita PipeWire della cassa (protocollo PulseAudio)."""
    def destinazione(self):
        # buffer_duration: con quello di Pulse (2 s) ffmpeg finirebbe prima del suono, e la coda di ogni brano si perde
        return ["-f", "pulse", "-buffer_duration", "300", "-device", self.uscita(), "Armony"], {"PULSE_SERVER": f"unix:{BT_PULSE}"}

    def uscita(self):
        mac = self.d["mac"].replace(":", "_")
        for giro in range(2):
            fine = time.time() + (2 if giro == 0 else 12)
            while time.time() < fine:
                u = next((x for x in pactl_uscite() if mac in x), None)
                if u:
                    return u
                time.sleep(0.5)
            if giro == 0:
                btctl("connect", self.d["mac"], attesa=25)
        raise RuntimeError(f"{self.d['nome']} non si collega: è accesa? È collegata a un telefono?")

    def volume(self, v=None):
        u = next((x for x in pactl_uscite() if self.d["mac"].replace(":", "_") in x), None)
        if not u:
            return None
        env = {**os.environ, "PULSE_SERVER": f"unix:{BT_PULSE}"}
        if v is None:
            m = re.search(r"(\d+)%", subprocess.run(["pactl", "get-sink-volume", u], capture_output=True, text=True, timeout=5, env=env).stdout)
            return int(m.group(1)) / 100 if m else None
        subprocess.run(["pactl", "set-sink-volume", u, f"{round(v * 100)}%"], timeout=5, env=env)


# ------------------------------------------------------------------ Tutta la casa (Snapcast, profilo "snapcast")
# Snapcast suona la stessa musica in sincrono su tutti i suoi client (le stanze). Armony gli manda l'audio sulla
# sorgente TCP locale e diventa un solo dispositivo, «Tutta la casa»; le stanze si comandano col suo JSON-RPC.
SNAP_RPC = "http://127.0.0.1:1780/jsonrpc"
SNAP_TCP = "tcp://127.0.0.1:4953"
SNAP_ID = "casa" + hashlib.sha1(b"snapcast").hexdigest()[:12]
SNAP = {"ok": False}
clienti = {}  # mac -> snapclient che porta «Tutta la casa» su quella cassa Bluetooth


def snap(metodo, **params):
    j = A.http.post(SNAP_RPC, json={"id": 1, "jsonrpc": "2.0", "method": metodo, "params": params}, timeout=4).json()
    if "error" in j:
        raise RuntimeError(f"Snapcast: {j['error'].get('message')}")
    return j["result"]


def stanze():
    """Gli snapclient conosciuti: [{id, nome, collegata, volume, muto}]."""
    out = []
    for gr in snap("Server.GetStatus")["server"]["groups"]:
        for c in gr["clients"]:
            out.append({"id": c["id"], "nome": c["config"]["name"] or c["host"]["name"], "collegata": c["connected"],
                        "volume": c["config"]["volume"]["percent"] / 100, "muto": c["config"]["volume"]["muted"]})
    return out


def cerca_snap():
    try:
        n = sum(1 for x in stanze() if x["collegata"])
    except (requests.RequestException, ValueError, RuntimeError, KeyError):
        SNAP["ok"] = False
        return []
    SNAP["ok"] = True
    return [{"id": SNAP_ID, "tipo": "snap", "nome": "Tutta la casa", "ip": "", "modello": f"Snapcast, {n} stanze collegate", "visto": time.time()}]


class Snap(Flusso):
    """«Tutta la casa»: PCM a Snapcast, al ritmo vero (-re): lui lo distribuisce alle stanze in sincrono."""
    ingresso = ["-re"]

    def destinazione(self):
        return ["-f", "s16le", "-ar", "48000", "-ac", "2", SNAP_TCP], {}

    def volume(self, v=None):
        su = [x for x in stanze() if x["collegata"]]
        if v is None:
            return round(sum(x["volume"] for x in su) / len(su), 2) if su else None
        for x in su:
            snap("Client.SetVolume", id=x["id"], volume={"percent": round(v * 100), "muted": False})


def snap_bt():
    """Tiene acceso uno snapclient per ogni cassa Bluetooth messa in «Tutta la casa» (se è collegata)."""
    while True:
        try:
            voluti = set(json.loads((db.one("SELECT value FROM settings WHERE key = 'snap_bt'") or {"value": "[]"})["value"])) if SNAP["ok"] else set()
            for mac in [m for m in clienti if m not in voluti or clienti[m].poll() is not None]:
                if clienti[mac].poll() is None:
                    clienti[mac].terminate()
                clienti.pop(mac)
            for mac in voluti - set(clienti):
                u = next((x for x in pactl_uscite() if mac.replace(":", "_") in x), None)
                if u:  # spenta o non collegata: si riprova al giro dopo
                    clienti[mac] = subprocess.Popen(["snapclient", "--host", "127.0.0.1", "--hostID", "armony-" + mac.replace(":", ""), "--player", "pulse",
                                                     "--soundcard", u, "--logsink", "null"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                                    env={**os.environ, "PULSE_SERVER": f"unix:{BT_PULSE}"})
        except Exception as e:  # noqa: BLE001 - il guardiano delle casse non deve fermarsi
            A.diagnosi.log("avviso", "casa", f"Tutta la casa sulle casse Bluetooth: {e}"[:300])
        time.sleep(15)


def driver(d):
    return Cast(d) if d.get("tipo") == "cast" else BT(d) if d.get("tipo") == "bt" else Snap(d) if d.get("tipo") == "snap" else DLNA(d)


# ------------------------------------------------------------------ la coda su una TV
class Sessione:
    def __init__(self, d, utente):
        self.d, self.r, self.utente, self.gettone = d, driver(d), utente, secrets.token_urlsafe(18)
        self.coda, self.i, self.shuffle, self.repeat = [], 0, False, "off"
        self.suona, self.pos, self.dur, self.at, self.since = False, 0.0, 0, time.time(), None
        self.fermato_da_noi, self.fermi, self.vivo, self.inviato = False, 0, True, None
        self.err, self.vol = 0, None
        threading.Thread(target=self.segui, daemon=True).start()

    # --- cosa la TV deve suonare
    def base(self):
        return A.trasferimento.ip_casa()

    def suona_i(self, i, da=0):
        self.i = max(0, min(i, len(self.coda) - 1))
        t = self.coda[self.i]
        url = f"{self.base()}/api/casa/flusso/{self.gettone}/{urllib.parse.quote(t['id'])}.mp3"
        cop = f"{self.base()}/api/casa/copertina/{self.gettone}/{urllib.parse.quote(t['coverArt'])}" if t.get("coverArt") else ""
        self.fermato_da_noi = True
        self.suona, self.pos, self.dur, self.at = True, 0.0, t.get("duration") or 0, time.time()
        self.pos = float(self.r.carica(t, url, cop, da) or 0)
        self.at, self.fermato_da_noi, self.fermi = time.time(), False, 0
        self.since = self.since or int(time.time() * 1000)  # come i client: millisecondi
        if self.vol is None:  # al primo brano: il volume com'è adesso, per il cursore del telecomando
            try:
                self.vol = self.r.volume()
            except (*ERRORI, OSError, subprocess.TimeoutExpired):
                pass
        self.pubblica(True)

    def avanti(self, auto=False):
        if self.repeat == "one" and auto:
            return self.suona_i(self.i)
        if self.i + 1 < len(self.coda):
            return self.suona_i(self.i + 1)
        if self.repeat == "all" and self.coda:
            return self.suona_i(0)
        self.ferma()

    def ferma(self):
        self.fermato_da_noi, self.suona = True, False
        try:
            self.r.ferma()
        except ERRORI:
            pass
        self.pubblica(True)

    # --- comandi dal telecomando (stessi nomi del canale dal vivo)
    def comando(self, cmd, v):
        if cmd == "transfer" and isinstance(v, dict) and isinstance(v.get("queue"), list):
            self.coda = [t for t in v["queue"] if isinstance(t, dict) and t.get("id") and not t.get("fed") and not t.get("web")][:1000]
            if not self.coda:
                raise ValueError("Niente da suonare sulla TV: i brani degli altri server e le radio restano sul telefono")
            self.shuffle = bool(v.get("shuffle"))
            self.repeat = v.get("repeat") if v.get("repeat") in ("off", "all", "one") else "off"
            return self.suona_i(int(v.get("index") or 0), float(v.get("position") or 0))
        if not self.coda:
            return None
        if cmd in ("pause", "toggle") and self.suona:
            self.r.pausa()
            self.pos, self.suona, self.at = self.posizione(), False, time.time()
        elif cmd in ("play", "toggle") and not self.suona:
            self.r.riprendi()
            self.suona, self.at = True, time.time()
        elif cmd == "next":
            return self.avanti()
        elif cmd == "prev":
            return self.suona_i(self.i - 1 if self.posizione() < 4 else self.i)
        elif cmd == "skipto" and isinstance(v, int):
            return self.suona_i(self.i + 1 + v)
        elif cmd == "seek" and isinstance(v, (int, float)):
            self.r.salta(v)
            self.pos, self.at = float(v), time.time()
        elif cmd == "volume" and isinstance(v, (int, float)):
            self.vol = max(0.0, min(1.0, float(v)))
            self.r.volume(self.vol)
        elif cmd == "repeat":
            self.repeat = {"off": "all", "all": "one", "one": "off"}[self.repeat]
        elif cmd == "shuffle":
            self.shuffle = not self.shuffle
        elif cmd in ("enqueue", "playnext") and isinstance(v, dict) and isinstance(v.get("tracks"), list):
            nuovi = [t for t in v["tracks"] if isinstance(t, dict) and t.get("id") and not t.get("fed") and not t.get("web")]
            if cmd == "playnext":
                self.coda[self.i + 1:self.i + 1] = nuovi
            else:
                self.coda += nuovi
        elif cmd == "handoff" and isinstance(v, dict) and v.get("to"):
            # la coda passa a un dispositivo vero: lui riparte da qui, la TV si ferma
            A.manda_cmd(self.utente, str(v["to"]), "transfer", self.pacco(), self.d["id"])
            self.ferma()
            return None
        self.pubblica(True)

    def pacco(self):
        da = max(0, self.i - 50)
        return {"queue": self.coda[da:da + 1000], "index": self.i - da, "position": self.posizione(), "shuffle": self.shuffle, "repeat": self.repeat}

    # --- la TV a che punto è (ogni 2 secondi) e cosa sanno gli altri dispositivi
    def posizione(self):
        return self.pos + (time.time() - self.at if self.suona else 0)

    def segui(self):
        while self.vivo:
            time.sleep(2)
            if not self.coda:
                continue
            try:
                stato, pos, dur = self.r.leggi()
                self.err = 0
            except ERRORI:
                self.err += 1
                if self.err == 15:  # 30 secondi senza risposta: spenta o fuori rete
                    self.suona = False
                    self.pubblica(True)
                continue
            prima = (self.suona, int(self.posizione()))
            if stato == "PLAYING":
                self.suona, self.pos, self.at, self.fermi = True, pos, time.time(), 0
                self.dur = dur or self.dur
            elif stato == "PAUSED":
                self.suona, self.pos, self.at = False, pos, time.time()
            elif stato == "STOPPED" and self.suona and not self.fermato_da_noi:
                self.fermi += 1
                if self.fermi >= 2:  # due letture di fila: alcune TV passano un attimo da STOPPED fra un brano e l'altro
                    try:
                        self.avanti(auto=True)
                    except ERRORI as e:
                        A.diagnosi.log("avviso", "casa", f"{self.d['nome']}: brano successivo non partito: {e}"[:300])
                        self.suona = False
                    continue
            ora = (self.suona, int(self.posizione()))
            self.pubblica(prima[0] != ora[0] or abs(prima[1] - ora[1]) > 8)

    def stato(self):
        t = self.coda[self.i] if self.coda else None
        return {"device": self.d["id"], "name": nome(self.d), "solo": False, "playing": self.suona, "position": round(self.posizione(), 1),
                "duration": self.dur or (t or {}).get("duration") or 0, "rate": 1, **({"volume": round(self.vol, 2)} if self.vol is not None else {}), "shuffle": self.shuffle, "repeat": self.repeat,
                "track": t, "next": self.coda[self.i + 1:self.i + 51], "left": max(0, len(self.coda) - self.i - 1),
                "since": self.since if self.suona else None, "at": time.time()}

    def pubblica(self, subito=False):
        """Lo stato al proprietario della sessione (come se lo mandasse un dispositivo); al più ogni 15 s se non cambia."""
        if not subito and self.inviato and time.time() - self.inviato < 15:
            return
        self.inviato = time.time()
        st = self.stato()
        with A.llock:
            A.lstates.setdefault(self.utente, {})[self.d["id"]] = st
        A.live_put(self.utente, {"type": "state", "state": st})
        A.pres_update(self.utente, st)


def comando(u, dev, cmd, v):
    """Un comando del canale dal vivo per una TV. La sessione nasce col primo «transfer»; un altro utente che la sceglie
    la prende (al vecchio proprietario la TV sparisce e ricompare, senza stato)."""
    vecchia = None
    with lock:
        d = trovati.get(dev)
        if not d:
            raise ValueError("La TV non risponde più in rete")
        s = sessioni.get(dev)
        if cmd == "transfer" and (not s or s.utente != u):
            vecchia, s = s, Sessione(d, u)
            sessioni[dev] = s
    if vecchia:  # fuori dal lucchetto di casa (vedi cerca)
        vecchia.vivo = False
        try:
            vecchia.r.ferma()  # la cassa Bluetooth ha il suo ffmpeg: due sulla stessa uscita suonerebbero insieme
        except ERRORI:
            pass
        with A.llock:
            A.lstates.get(vecchia.utente, {}).pop(dev, None)
        A.live_put(vecchia.utente, {"type": "gone", "device": dev})
        A.live_put(vecchia.utente, {"type": "join", "device": dev, "name": nome(d)})
    if not s:
        raise ValueError(f"Su {d['nome']} non suona ancora niente: scegli cosa suonare")
    if s.utente != u:
        raise ValueError(f"{d['nome']} la sta usando un altro utente")
    s.comando(cmd, v)


# ------------------------------------------------------------------ rotte
@bp.get("/api/casa")
def elenco():
    with lock:
        return jsonify(dispositivi=[{"id": d["id"], "nome": d["nome"], "modello": d["modello"], "ip": d["ip"], "tipo": d.get("tipo"),
                                     "usata": sessioni[d["id"]].utente if d["id"] in sessioni and sessioni[d["id"]].suona else None}
                                    for d in trovati.values()], multicast=A.MULTICAST, ultima=ultima["ts"], ssdp=ultima["ssdp"],
                       errori=ultima["errori"], bluetooth=bt_ok(), snapcast=SNAP["ok"])


@bp.post("/api/casa/cerca")
def cerca_ora():
    """Cerca adesso e risponde a ricerca finita (qualche secondo), con l'elenco nuovo."""
    cerca()
    return elenco()


def sessione_di(gettone):
    with lock:
        return next((s for s in sessioni.values() if secrets.compare_digest(s.gettone, gettone)), None)


@bp.get("/api/casa/flusso/<gettone>/<path:sid>")
def flusso(gettone, sid):
    """Il brano per la TV: Navidrome lo converte in mp3 (lo leggono tutte); le richieste parziali passano."""
    sid = sid.rsplit(".", 1)[0]
    s = sessione_di(gettone)
    if not A.dispositivi.is_local() or not s or not any(t.get("id") == sid for t in s.coda):
        return jsonify(error="Non trovato"), 404
    h = {"Range": request.headers["Range"]} if request.headers.get("Range") else {}
    r = A.http.get(f"{A.NAVIDROME_URL}/rest/stream", params={**A.federazione.nd_params(), "id": sid, "format": "mp3", "maxBitRate": 320,
                                                             "estimateContentLength": "true"}, headers=h, stream=True, timeout=(5, 60))
    passa = {k: v for k, v in r.headers.items() if k.lower() in ("content-length", "content-range", "accept-ranges")}
    return Response(stream_with_context(r.iter_content(64 * 1024)), status=r.status_code, mimetype="audio/mpeg",
                    headers={**passa, "transferMode.dlna.org": "Streaming", "contentFeatures.dlna.org": "DLNA.ORG_PN=MP3;DLNA.ORG_OP=01"})


@bp.get("/api/casa/copertina/<gettone>/<path:cid>")
def copertina(gettone, cid):
    if not A.dispositivi.is_local() or not sessione_di(gettone):
        return jsonify(error="Non trovato"), 404
    r = A.http.get(f"{A.NAVIDROME_URL}/rest/getCoverArt", params={**A.federazione.nd_params(), "id": cid, "size": 600}, timeout=15)
    return Response(r.content, status=r.status_code, mimetype=r.headers.get("Content-Type", "image/jpeg"))


@bp.get("/api/casa/bluetooth")
def bt_stato():
    if not bt_ok():
        return jsonify(ok=False, dispositivi=[])
    problema = bt_problema()
    if problema:
        return jsonify(ok=True, dispositivi=[], snapcast=SNAP["ok"], problema=problema)
    out = []
    for x in bt_elenco():
        out.append({**x, **bt_info(x["mac"])})
    out.sort(key=lambda x: (not x["abbinato"], not x["cassa"], x["nome"].lower()))
    tc = set(json.loads((db.one("SELECT value FROM settings WHERE key = 'snap_bt'") or {"value": "[]"})["value"]))
    for x in out:
        x["tuttacasa"] = x["mac"] in tc
    return jsonify(ok=True, dispositivi=out, snapcast=SNAP["ok"])


@bp.post("/api/casa/bluetooth/cerca")
def bt_cerca():
    if not bt_ok():
        return jsonify(error="Bluetooth non preparato su questo server (deploy/bluetooth.sh)"), 409
    problema = bt_problema()
    if problema:
        return jsonify(error=problema), 409
    btctl("power", "on", attesa=8)
    btctl("--timeout", "12", "scan", "on", attesa=20)
    return bt_stato()


@bp.post("/api/casa/bluetooth/<mac>")
def bt_azione(mac):
    mac = mac.upper()
    azione = (request.get_json(silent=True) or {}).get("azione")
    if not bt_ok() or not MAC.match(mac) or azione not in ("abbina", "collega", "scollega", "dimentica", "tuttacasa_si", "tuttacasa_no"):
        return jsonify(error="Richiesta non valida"), 400
    if azione == "abbina":
        t = btctl("--agent", "NoInputNoOutput", "pair", mac, attesa=40)
        if not bt_info(mac)["abbinato"]:
            err = re.search(r"Failed to pair: (\S+)", t)
            return jsonify(error="Abbinamento non riuscito" + (f" ({err.group(1)})" if err else "") + ": la cassa deve essere in modalità abbinamento"), 502
        btctl("trust", mac)
        btctl("connect", mac, attesa=25)
    elif azione == "collega":
        btctl("connect", mac, attesa=25)
    elif azione in ("tuttacasa_si", "tuttacasa_no"):
        v = set(json.loads((db.one("SELECT value FROM settings WHERE key = 'snap_bt'") or {"value": "[]"})["value"]))
        v = v | {mac} if azione == "tuttacasa_si" else v - {mac}
        db.run("INSERT INTO settings (key, value) VALUES ('snap_bt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", json.dumps(sorted(v)))
    elif azione == "scollega":
        btctl("disconnect", mac)
    else:
        btctl("remove", mac)
    threading.Thread(target=cerca, daemon=True).start()  # in «Dove suona» compare o sparisce subito
    return jsonify(ok=True, **bt_info(mac))


@bp.get("/api/casa/stanze")
def stanze_elenco():
    if not (A.dispositivi.is_local() or g.who["admin"]):
        return jsonify(error="Le stanze si vedono da casa"), 403
    try:
        casa_ = urllib.parse.urlparse(A.trasferimento.ip_casa() or "").hostname  # le stanze lo raggiungono in casa, non dal dominio
        return jsonify(ok=True, stanze=stanze(), host=casa_)
    except (requests.RequestException, ValueError, RuntimeError, KeyError):
        return jsonify(ok=False, stanze=[])


@bp.put("/api/casa/stanze/<cid>")
def stanza(cid):
    if not (A.dispositivi.is_local() or g.who["admin"]):
        return jsonify(error="Le stanze si comandano da casa"), 403
    d = request.get_json(silent=True) or {}
    try:
        x = next((x for x in stanze() if x["id"] == cid), None)
        if not x:
            return jsonify(error="Stanza non trovata"), 404
        if "volume" in d or "muto" in d:
            snap("Client.SetVolume", id=cid, volume={"percent": round(max(0.0, min(1.0, float(d.get("volume", x["volume"])))) * 100),
                                                     "muted": bool(d.get("muto", x["muto"]))})
        if str(d.get("nome") or "").strip():
            snap("Client.SetName", id=cid, name=str(d["nome"]).strip()[:40])
    except (requests.RequestException, ValueError, RuntimeError, TypeError) as e:
        return jsonify(error=str(e)[:200]), 502
    return jsonify(ok=True, stanze=stanze())


def init(flask_app, host):
    global A
    A = host
    flask_app.register_blueprint(bp)


def start():
    threading.Thread(target=giro, daemon=True).start()  # senza multicast cerca solo casse Bluetooth e Snapcast
    if bt_ok():
        threading.Thread(target=snap_bt, daemon=True).start()
