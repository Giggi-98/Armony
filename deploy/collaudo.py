#!/usr/bin/env python3
"""
Armony - collaudo automatico a più server (docs/PIANO-3.md, A1). Da lanciare prima di ogni tag.

    sudo python3 deploy/collaudo.py            tutto (circa 15 minuti)
    sudo python3 deploy/collaudo.py --tieni    lascia accesi i server alla fine, per guardarli
    sudo python3 deploy/collaudo.py --pulisci  toglie i server di un collaudo lasciato acceso

Tira su quattro server isolati (Ubuntu con Docker dentro Docker, rete "armony-collaudo") dal codice di questa cartella,
così com'è, anche non ancora in git: A e C centri con indirizzo, B foglia dietro firewall (non si raggiunge), N nuovo
e vuoto. Nessuno ha systemd: aggiornamenti e trasferimento li esegue il guardiano, che così si collauda anche lui.
Poi prova: installazione, collegamenti e canale, catalogo e ascolto attraverso il collegamento, mappa, collaboratori
da un altro server, attività fra server, scelta della versione di un brano, trasferimento di A su N con i brani (il
centro C e la foglia B devono seguirlo al nuovo indirizzo). Alla fine l'elenco di cosa è passato.

─── PERCHÉ così ───
Ogni funzione della federazione ha avuto almeno un difetto visibile solo con più server veri (canale che non si apriva,
catalogo che aspettava 20 minuti, sessioni che scadevano): a mano il collaudo si rifaceva ogni volta. Niente produzione:
container e rete hanno nomi propri e non toccano gli altri.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NET, IMG = "armony-collaudo", "ubuntu:24.04"
NODI = ("a", "b", "c", "n")
esiti = []


def sh(cmd, check=True, timeout=900):
    r = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, timeout=timeout)
    if check and r.returncode:
        raise RuntimeError(f"{cmd if isinstance(cmd, str) else ' '.join(cmd)}\n{r.stdout[-800:]}{r.stderr[-800:]}")
    return r.stdout


def dx(n, cmd, timeout=900, check=True):
    """Un comando dentro il server n (bash)."""
    return sh(["docker", "exec", f"collaudo-{n}", "bash", "-c", cmd], check=check, timeout=timeout)


def ip(n):
    return sh(["docker", "inspect", "-f", f'{{{{(index .NetworkSettings.Networks "{NET}").IPAddress}}}}', f"collaudo-{n}"]).strip()


def env(n, k):
    return dx(n, f"sed -n 's/^{k}=//p' /root/armony/.env | tr -d '\"'").strip()


def api(n, method, path, body=None, tok=None, timeout=60):
    """Armony del server n. tok=None: accesso d'emergenza (da locale vale come amministratore senza utente)."""
    tok = tok or env(n, "ARMONY_TOKEN")
    data = f"-d {sh_q(json.dumps(body))}" if body is not None else ""
    out = dx(n, f"curl -s -m {timeout} -X {method} -H 'X-Token: {tok}' -H 'Content-Type: application/json' {data} 'http://127.0.0.1:8080{path}'",
             timeout=timeout + 10, check=False)
    try:
        return json.loads(out)
    except ValueError:
        return {"_raw": out[:300]}


def sh_q(s):
    return "'" + s.replace("'", "'\\''") + "'"


def sub(n, metodo, q=""):
    """Subsonic a Navidrome come il suo amministratore (dentro il container di Navidrome)."""
    p = env(n, "NAVIDROME_ADMIN_PASS")
    s = os.urandom(6).hex()
    t = hashlib.md5((p + s).encode()).hexdigest()
    out = dx(n, f"docker exec armony-navidrome wget -qO- 'http://127.0.0.1:4533/rest/{metodo}.view?u=admin&t={t}&s={s}&v=1.16.1&c=collaudo&f=json{'&' + q if q else ''}'", check=False)
    try:
        return json.loads(out)["subsonic-response"]
    except (ValueError, KeyError):
        return {}


utok = {}


def utente(n):
    """La sessione dell'utente admin (un dispositivo «collaudo», approvato con l'accesso d'emergenza se serve)."""
    if n in utok:
        return utok[n]
    p, s = env(n, "NAVIDROME_ADMIN_PASS"), os.urandom(6).hex()
    body = {"u": "admin", "t": hashlib.md5((p + s).encode()).hexdigest(), "s": s, "device": "collaudo"}
    r = api(n, "POST", "/api/login", body, tok="-")
    if not r.get("session") and r.get("dev"):
        api(n, "POST", f"/api/dispositivi/{r['dev']}/approva", {})
        s = os.urandom(6).hex()
        body.update(t=hashlib.md5((p + s).encode()).hexdigest(), s=s)
        r = api(n, "POST", "/api/login", body, tok="-")
    utok[n] = r.get("session") or ""
    return utok[n]


def esito(nome, ok, info=""):
    esiti.append((nome, ok, info))
    print(f"  {'✓' if ok is True else '✗' if ok is False else '·'} {nome}{' — ' + info if info else ''}", flush=True)


def aspetta(fn, sec, ogni=5):
    fine = time.time() + sec
    while time.time() < fine:
        try:
            v = fn()
            if v:
                return v
        except Exception:  # noqa: BLE001
            pass
        time.sleep(ogni)
    return None


def canzone(n, cartella, titolo, artista, freq=440, dur=20, anno=None, album=None, file=None):
    extra = f' -metadata date={anno}' if anno else ''
    dx(n, f"docker exec armony-app sh -c {sh_q(f'mkdir -p \"/music/{cartella}\" && ffmpeg -loglevel error -y -f lavfi -i sine=frequency={freq}:duration={dur} -metadata title=\"{titolo}\" -metadata artist=\"{artista}\" -metadata album=\"{album or cartella}\"{extra} -q:a 9 \"/music/{cartella}/{file or titolo}.mp3\"')}")
    sub(n, "startScan")


def cerca(n, q):
    return aspetta(lambda: (sub(n, "search3", f"query={q}").get("searchResult3") or {}).get("song", [None])[0], 60, 3)


# ------------------------------------------------------------------ preparazione
def pulisci():
    for n in NODI:
        sh(["docker", "rm", "-fv", f"collaudo-{n}"], check=False)
    sh(["docker", "network", "rm", NET], check=False)


def sorgente():
    """Il codice di questa cartella così com'è (anche modifiche non in git), senza i dati."""
    tmp = tempfile.mkdtemp(prefix="armony-collaudo-")
    files = sh(["git", "-C", ROOT, "-c", "safe.directory=*", "ls-files", "-co", "--exclude-standard"]).split("\n")
    for f in filter(None, files):
        src = os.path.join(ROOT, f)
        if os.path.isfile(src):
            os.makedirs(os.path.dirname(os.path.join(tmp, f)), exist_ok=True)
            shutil.copy2(src, os.path.join(tmp, f))
    sh(f"cd {tmp} && git init -q && git add -A && git -c user.email=c@c -c user.name=collaudo commit -qm collaudo")
    os.chmod(tmp, 0o755)
    return tmp


PREPARA = r"""set -e; export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq curl git ca-certificates iproute2 python3 iptables >/dev/null
curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
(dockerd >/var/log/dockerd.log 2>&1 &); for i in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
git config --global --add safe.directory '*'; git clone -q /src /root/armony
cd /root/armony && bash installa.sh --si >/tmp/installa.log 2>&1
"""


def prepara(src):
    sh(["docker", "network", "create", NET])
    for n in NODI:
        sh(["docker", "run", "-d", "--privileged", "--name", f"collaudo-{n}", "--network", NET, "-v", "/var/lib/docker",
            "-v", f"{src}:/src:ro", IMG, "sleep", "infinity"])
    errs = {}

    def uno(n):
        try:
            dx(n, PREPARA, timeout=1500)
        except Exception as e:  # noqa: BLE001
            errs[n] = str(e)[-400:]
    th = [threading.Thread(target=uno, args=(n,)) for n in NODI]
    [t.start() for t in th]
    [t.join() for t in th]
    return errs


# ------------------------------------------------------------------ prove
def prove():
    I = {n: ip(n) for n in NODI}
    print("\nInstallazione")
    for n in NODI:
        v = api(n, "GET", "/api/info").get("version")
        esito(f"server {n.upper()} installato e acceso", bool(v), v or "")
    g = dx("n", "docker ps --filter name=^armony-guardiano$ --format '{{.Status}}'; python3 -c 'import json,time;print(int(time.time()-json.load(open(\"/root/armony/updates/guardiano.json\"))[\"ts\"]))'", check=False)
    esito("guardiano attivo senza systemd (N)", "Up" in g, g.replace("\n", " · ").strip())
    for x in ("a", "c", "n"):
        dx("b", f"iptables -I INPUT -s {I[x]} -p tcp --dport 8080 -j DROP")
    api("a", "PUT", "/api/fed/settings", {"url": f"http://{I['a']}:8080", "attivita": True})
    api("c", "PUT", "/api/fed/settings", {"url": f"http://{I['c']}:8080"})
    api("b", "PUT", "/api/fed/settings", {"utenti": True})
    api("n", "PUT", "/api/indirizzo", {"url": f"http://{I['n']}:8080"})

    print("\nFederazione")

    def collega(figlio, centro, url):
        code = api(centro, "POST", "/api/fed/invites", {}).get("code")
        j = api(figlio, "POST", "/api/fed/join", {"code": code, "url": url})
        for x in api(centro, "GET", "/api/fed").get("nodes", []):
            if x["state"] == "richiesta":
                api(centro, "POST", f"/api/fed/nodes/{x['id']}/accept", {})
        return j
    j = collega("c", "a", f"http://{I['c']}:8080")
    esito("C (centro) si collega ad A", j.get("state") in ("attesa", "attivo"), j.get("error") or "")
    j = collega("b", "a", "http://127.0.0.1:8080")
    esito("B (foglia, senza indirizzo) si collega ad A", j.get("state") in ("attesa", "attivo"), j.get("error") or "")

    def nodi_a():
        return {x["name"]: x for x in api("a", "GET", "/api/fed").get("nodes", [])}
    nb = env("b", "ARMONY_NAME") or "?"
    ok = aspetta(lambda: (lambda d: [x for x in d.values() if x["online"]] if len(d) == 2 and all(x["online"] for x in d.values()) else None)(nodi_a()), 150)
    d = nodi_a()
    esito("A vede B e C in linea", bool(ok), " · ".join(f"{k}: {'in linea' if v['online'] else 'spento'} ({v['reach']})" for k, v in d.items()))
    esito("B passa dal suo canale", any(v["reach"] == "canale" for v in d.values()))

    print("\nCatalogo e ascolto attraverso il collegamento")
    canzone("b", "Dalla foglia", "Brano della foglia", "Foglia", 550)
    sb = cerca("b", "foglia")
    # il catalogo di un collegato si riscarica ogni 10 minuti: qui lo si chiede subito, come il tasto «Riscarica»
    aspetta(lambda: dx("b", "docker exec armony-app python -c \"import sqlite3;c=sqlite3.connect('/data/armony.db');print(c.execute('select count(*) from fed_mine').fetchone()[0])\"").strip() not in ("", "0"), 120, 5)
    nb_id0 = next((x["id"] for x in api("a", "GET", "/api/fed").get("nodes", []) if x["reach"] == "canale"), None)
    trovato = aspetta(lambda: api("a", "POST", f"/api/fed/nodes/{nb_id0}/refresh", {}) and (api("a", "GET", "/api/rete/cerca?q=foglia").get("songs") or [None])[0], 180, 10)
    esito("A trova il brano di B (catalogo dal canale)", bool(trovato))
    if trovato:
        r = ",".join(trovato.get("path") or [])
        md5a = dx("a", f"curl -s -H 'X-Token: {env('a', 'ARMONY_TOKEN')}' 'http://127.0.0.1:8080/api/rete/stream?id={trovato['id']}&r={r}&format=raw' | md5sum | cut -c1-32").strip()
        md5b = dx("b", f"md5sum '/root/armony/musica/Dalla foglia/Brano della foglia.mp3' | cut -c1-32").strip()
        esito("A ascolta il brano di B identico (byte per byte)", md5a == md5b, md5a[:8])

    print("\nMappa")
    t = aspetta(lambda: (lambda x: x if len(x.get("edges", [])) >= 2 else None)(api("c", "GET", "/api/rete/topologia")), 60)
    kinds = sorted(e["kind"] for e in (t or {}).get("edges", []))
    esito("C vede la maglia con A e la stella di B", kinds == ["canale", "diretto"], ", ".join(kinds))

    print("\nCollaboratori da un altro server")
    canzone("a", "Di casa", "Brano di casa", "Casa", 330)
    sa = cerca("a", "casa")
    pid = (sub("a", "createPlaylist", f"name=Collaudo&songId={sa['id']}").get("playlist") or {}).get("id") if sa else None
    nb_id = next((x["id"] for x in api("a", "GET", "/api/fed").get("nodes", []) if x["reach"] == "canale"), None)
    r = api("a", "GET", f"/api/collab/rete?pid={pid}", tok=utente("a"))
    nomi = next((x.get("utenti") for x in r.get("nodes", []) if x["id"] == nb_id), None)
    esito("A legge gli utenti di B", bool(nomi), ", ".join(nomi or []) or r.get("error", ""))
    api("a", "PUT", "/api/collab/rete", {"pid": pid, "users": [{"node": nb_id, "user": "admin"}]}, tok=utente("a"))
    lst = aspetta(lambda: api("b", "GET", "/api/rete/collab", tok=utente("b")).get("playlists"), 60)
    esito("B vede la playlist di A in «Su altri server»", bool(lst))
    if lst and sb:
        x = api("b", "POST", f"/api/rete/collab/{lst[0]['node']}/{pid}", {"ids": [sb["id"]]}, tok=utente("b"))
        dentro = aspetta(lambda: (sub("a", "getPlaylist", f"id={pid}").get("playlist") or {}).get("songCount") == 2, 180, 10)
        esito("il brano di B si copia su A ed entra nella playlist", bool(dentro), f"copia: {x.get('copia')}, errore: {x.get('error')}")

    print("\nLibreria: playlist intelligenti, salute, testi")
    canzone("a", "Anni 80", "Brano del 1985", "Retro", 600, anno=1985)
    canzone("a", "Anni 90", "Brano del 1995", "Retro", 620, anno=1995)
    canzone("a", "Doppio", "Brano di casa", "Casa", 330, file="Brano di casa (copia)")  # lo stesso brano due volte
    canzone("a", "Senza nome", "NA", "Qualcuno", 700)
    canzone("a", "Queen", "Bohemian Rhapsody", "Queen", 200, dur=354, album="A Night at the Opera")
    aspetta(lambda: cerca("a", "1995") and cerca("a", "Bohemian"), 90)
    j = api("a", "POST", "/api/playlist/intelligente", {"name": "Anni 80", "rules": {"all": [{"inTheRange": {"year": [1980, 1989]}}], "sort": "title"}}, tok=utente("a"))
    spid = j.get("id")
    pl = aspetta(lambda: (sub("a", "getPlaylist", f"id={spid}").get("playlist") or {}) if spid else None, 30, 3) or {}
    esito("playlist intelligente creata, dell'utente e solo con il brano del 1985", [e["title"] for e in pl.get("entry", [])] == ["Brano del 1985"] and pl.get("owner") == "admin",
          f"{[e['title'] for e in pl.get('entry', [])]} · di {pl.get('owner')} · {j.get('error') or ''}")
    rr = api("a", "GET", f"/api/playlist/intelligente/{spid}", tok=utente("a"))
    ok = api("a", "PUT", f"/api/playlist/intelligente/{spid}", {"name": "Anni 80 e 90", "rules": {"any": [{"inTheRange": {"year": [1980, 1999]}}]}}, tok=utente("a"))
    pl = aspetta(lambda: (lambda p: p if len(p.get("entry", [])) == 2 else None)(sub("a", "getPlaylist", f"id={spid}").get("playlist") or {}), 30, 3) or {}
    esito("le regole si rileggono e si modificano", bool(rr.get("rules")) and ok.get("ok") is True and len(pl.get("entry", [])) == 2, ok.get("error") or pl.get("name", ""))
    sal = api("a", "GET", "/api/salute")
    esito("salute: trova il doppione e il titolo «NA»", sal.get("doppioni_tot", 0) >= 1 and sal.get("vuoti_tot", 0) >= 1,
          f"doppioni {sal.get('doppioni_tot')}, senza titolo {sal.get('vuoti_tot')}, spezzati {len(sal.get('spezzati', []))}")
    api("a", "PUT", "/api/salute/testi", {"on": True})  # sveglia il giro: il brano è appena arrivato
    lrc = aspetta(lambda: dx("a", "ls '/root/armony/musica/Queen/' 2>/dev/null | grep -c lrc", check=False).strip() not in ("", "0"), 360, 10)
    esito("il server trova il testo di «Bohemian Rhapsody» e lo salva (.lrc)", bool(lrc), (api("a", "GET", "/api/salute").get("testi") or {}).get("fermo", ""))

    print("\nAttività fra server")
    p = api("c", "GET", "/api/rete/presenza", tok=utente("c"))
    esito("C riceve l'attività di A (che la condivide)", any(s.get("node") for s in p.get("servers", [])), str(len(p.get("servers", []))) + " server")

    print("\nScelta della versione di un brano")
    if sa:
        r = api("a", "GET", f"/api/scelta?id={sa['id']}", tok=utente("a"), timeout=120)
        n_ = len(r.get("candidates") or [])
        esito("«Scegli un'altra versione» trova candidati", True if n_ else None if r.get("avviso") else False,
              f"{n_} candidati" + (f", avviso: {r['avviso'][:80]}" if r.get("avviso") else "") + (f", errore: {r.get('error')}" if r.get("error") else ""))

    print("\nTrasferimento di A su N (con i brani)")
    old = api("a", "GET", "/api/fed").get("me", {}).get("nodo")
    tok_a = utente("a")
    code = api("n", "POST", "/api/trasferimento/ricevi", {}).get("code")
    j = api("a", "POST", "/api/trasferimento/aggancia", {"code": code})
    esito("A si aggancia a N", j.get("stage") == "agganciato", j.get("error") or j.get("safety", ""))
    v = api("a", "GET", "/api/trasferimento")
    esito("prova prima dell'avvio: blocca senza conferma", v.get("blocco") is True,
          " · ".join(f"{c['nome']}: {'sì' if c['ok'] else 'no'}" for c in v.get("verifica", [])))
    api("n", "POST", "/api/trasferimento/conferma", {})
    j = api("a", "POST", "/api/trasferimento/avvia", {"brani": True})
    esito("avvio dopo la conferma", j.get("ok") is True, j.get("error") or "")
    fine = aspetta(lambda: (lambda s: s if s.get("stage") in ("trasferito", "errore") else None)(api("a", "GET", "/api/trasferimento")), 420, 5)
    esito("trasferimento completato (applicato dal guardiano)", (fine or {}).get("stage") == "trasferito", (fine or {}).get("errore") or "")
    h = json.loads(dx("n", "curl -s http://127.0.0.1:8080/fed/hello", check=False) or "{}")
    esito("N ha l'identità di A", h.get("nodo") == old, h.get("nodo", "")[:8])
    pls = [p.get("name") for p in (sub("n", "getPlaylists").get("playlists") or {}).get("playlist", [])]
    esito("N ha le playlist di A", "Collaudo" in pls, ", ".join(pls))
    me = api("n", "GET", "/api/me", tok=tok_a)
    esito("il dispositivo di A entra in N con la stessa sessione", me.get("user") == "admin", me.get("public", ""))
    cu = aspetta(lambda: next((x for x in api("c", "GET", "/api/fed").get("nodes", []) if I["n"] in x["url"]), None), 90)
    esito("C ha il nuovo indirizzo", bool(cu))
    bu = aspetta(lambda: next((x for x in api("b", "GET", "/api/fed").get("nodes", []) if I["n"] in x["url"] and x["online"]), None), 240, 10)
    esito("B segue A al nuovo indirizzo (spostato, verificato)", bool(bu))


def main():
    if "--pulisci" in sys.argv:
        pulisci()
        return
    if os.geteuid() != 0:
        sys.exit("Lancialo con sudo: serve Docker con container privilegiati.")
    pulisci()
    t0 = time.time()
    print("Preparo quattro server isolati dal codice di questa cartella (qualche minuto)…", flush=True)
    src = sorgente()
    try:
        errs = prepara(src)
        for n, e in errs.items():
            print(f"  ✗ installazione di {n.upper()} non riuscita:\n{e}")
            esiti.append((f"installazione di {n.upper()}", False, "vedi sopra"))  # senza server non è un collaudo passato
        if not errs:
            prove()
    finally:
        if "--tieni" not in sys.argv:
            pulisci()
        shutil.rmtree(src, ignore_errors=True)
    ko = [e for e in esiti if e[1] is False]
    print(f"\n{len(esiti) - len(ko)} su {len(esiti)} passati in {int((time.time() - t0) / 60)} minuti." + (" Falliti:" if ko else " Tutto a posto."))
    for nome, _, info in ko:
        print(f"  ✗ {nome}{' — ' + info if info else ''}")
    sys.exit(1 if ko else 0)


if __name__ == "__main__":
    main()
