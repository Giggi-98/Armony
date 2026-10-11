#!/usr/bin/env bash
# Armony: installatore testuale (Ubuntu/Debian, anche via SSH). Installa Docker se manca, scarica l'ultima versione,
# sceglie porte libere (scritte in .env: docker-compose.yml resta quello del repository, altrimenti il tasto «Aggiorna»
# si rifiuta), crea l'amministratore di Navidrome, avvia tutto e abilita gli aggiornamenti.
#
#   Da una copia del repository:  sudo ./installa.sh
#   Su un server nuovo:           curl -fsSL https://raw.githubusercontent.com/Giggi-98/Armony/main/installa.sh -o installa.sh
#                                 sudo bash installa.sh
#   Senza domande (predefiniti):  sudo bash installa.sh --si
#   Disinstallare:                sudo bash installa.sh --disinstalla   (chiede sempre; musica e dati restano, se non dici il contrario)
#
# Si può rilanciare: legge il .env che trova e tiene le scelte già fatte.
set -euo pipefail

REPO_URL="https://github.com/Giggi-98/Armony.git"
SI=0; MODO=installa
for a in "$@"; do case "$a" in --si) SI=1;; --disinstalla) MODO=disinstalla;; *) echo "Opzione sconosciuta: $a" >&2; exit 1;; esac; done
# la disinstallazione chiede sempre conferma
[ "$MODO" = disinstalla ] && SI=0
[ "$(id -u)" = 0 ] || { echo "Lancialo con sudo: sudo bash $0" >&2; exit 1; }
# con "curl | bash" stdin è lo script: le risposte si leggono dal terminale
[ -t 0 ] || { [ "$SI" = 1 ] || exec </dev/tty; }
TITLE="Installazione di Armony"
UI=testo; [ "$SI" = 0 ] && command -v whiptail >/dev/null && [ -t 1 ] && UI=whiptail

# --- dialoghi: whiptail se c'è, altrimenti domande semplici ---------------------------------------------------------
msg()   { if [ "$UI" = whiptail ]; then whiptail --title "$TITLE" --msgbox "$1" 0 0; else printf '\n%b\n' "$1"; [ "$SI" = 1 ] || read -rp "[Invio per continuare] " _; fi; }
# chiedi "domanda" "predefinito" [segreta]
chiedi() {
  [ "$SI" = 1 ] && { echo "$2"; return; }
  local t=--inputbox r; [ -n "${3:-}" ] && t=--passwordbox
  if [ "$UI" = whiptail ]; then whiptail --title "$TITLE" $t "$1" 0 70 "$2" 3>&1 1>&2 2>&3 || { echo "Annullato." >&2; exit 1; }
  else printf '%b [%s]: ' "$1" "$2" >&2; read -r ${3:+-s} r; [ -n "${3:-}" ] && echo >&2; echo "${r:-$2}"; fi
}
# si_no "domanda" [predefinito s|n]
si_no() {
  local d=${2:-s}
  [ "$SI" = 1 ] && { [ "$d" = s ]; return; }
  if [ "$UI" = whiptail ]; then whiptail --title "$TITLE" $([ "$d" = n ] && echo --defaultno) --yesno "$1" 0 70
  else local r; printf '%b [%s]: ' "$1" "$([ "$d" = s ] && echo S/n || echo s/N)"; read -r r; r=${r:-$d}; [[ "$r" =~ ^[sSyY] ]]; fi
}
passo() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
casuale() { python3 -c 'import secrets,sys; print(secrets.token_urlsafe(int(sys.argv[1]))[:int(sys.argv[1])])' "$1"; }

# --- .env: lettura e scrittura di una chiave --------------------------------------------------------------------
# valori fra virgolette doppie: compose li accetta con spazi, # e apostrofi; \ " e $ vanno protetti
env_get() { [ -f "$ENVF" ] || return 0; sed -n "s/^$1=//p" "$ENVF" | tail -n1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" -e 's/\\"/"/g' -e 's/\\\\/\\/g' -e 's/\$\$/$/g'; }
env_set() {
  local v; v=$(printf '%s' "$2" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\$/$$/g')
  if grep -q "^$1=" "$ENVF"; then K="$1" V="\"$v\"" python3 -c 'import os,re,sys; p=sys.argv[1]; s=open(p).read(); open(p,"w").write(re.sub("(?m)^"+re.escape(os.environ["K"])+"=.*$", lambda m: os.environ["K"]+"="+os.environ["V"], s))' "$ENVF"
  else printf '%s="%s"\n' "$1" "$v" >> "$ENVF"; fi
}

# --- porte -------------------------------------------------------------------------------------------------------
# porte pubblicate da container fermi: non ascoltano adesso, ma ripartirebbero sulla stessa porta
DOCKER_PORTE=""
PRESE=" "
occupata() {  # occupata porta tcp|udp
  local p=$1
  case "$PRESE" in *" $p "*) return 0;; esac
  if [ "$2" = udp ]; then [ -n "$(ss -Hlun "sport = :$p" 2>/dev/null)" ] && return 0
  else
    [ -n "$(ss -Hltn "sport = :$p" 2>/dev/null)" ] && return 0
    # chi risponde da fuori da questo sistema (Windows sotto WSL, Docker Desktop) "ss" non lo vede: ci si prova a collegare
    timeout 1 bash -c "exec 3<>/dev/tcp/127.0.0.1/$p" 2>/dev/null && return 0
  fi
  case " $DOCKER_PORTE " in *" $p "*) return 0;; esac
  return 1
}
# libera NOME predefinita tcp|udp|entrambe: la prima porta libera da lì in su
libera() {
  local p=$2
  while :; do
    if [ "$3" = entrambe ]; then occupata "$p" tcp || occupata "$p" udp || break
    else occupata "$p" "$3" || break; fi
    p=$((p + 1))
  done
  PRESE="$PRESE$p "; printf -v "$1" '%s' "$p"
}

# --- disinstallazione ----------------------------------------------------------------------------------------------
disinstalla() {
  local def dim k
  # la cartella dei container accesi, se ci sono; altrimenti quella dello script o ~/armony
  def=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' armony-app 2>/dev/null || true)
  [ -n "$def" ] || { def=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd); [ -f "$def/docker-compose.yml" ] || def="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)/armony"; }
  DIR=$(realpath -m "$(chiedi "Cartella di Armony da disinstallare" "$def")")
  ENVF="$DIR/.env"
  [ -f "$DIR/docker-compose.yml" ] && [ -f "$DIR/server/app.py" ] || { echo "In $DIR non c'è Armony." >&2; exit 1; }
  si_no "Disinstallo Armony da $DIR?\n\nSi fermano e si tolgono i container (Armony, Navidrome, pot, HTTPS, TURN), le loro immagini e il servizio del tasto «Aggiorna». Docker resta." n || exit 0
  cd "$DIR"

  passo "Container e immagini"
  docker compose --profile https --profile turn down --rmi all --remove-orphans 2>/dev/null \
    || docker rm -f armony-app armony-navidrome armony-pot armony-https armony-turn 2>/dev/null || true
  # copie di sicurezza dell'immagine fatte dagli aggiornamenti (armony-armony:prima-…)
  docker images -q armony-armony | sort -u | xargs -r docker rmi -f >/dev/null 2>&1 || true

  passo "Servizio di aggiornamento"
  if [ -f /etc/systemd/system/armony-update.path ]; then
    systemctl disable --now armony-update.path >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/armony-update.path /etc/systemd/system/armony-update.service
    systemctl daemon-reload
  fi
  rm -rf /etc/armony

  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    passo "Firewall"
    for k in ARMONY_PORT ARMONY_HTTPS_PORT TURN_PORT; do
      [ -n "$(env_get $k)" ] && { ufw delete allow "$(env_get $k)/tcp" >/dev/null 2>&1; ufw delete allow "$(env_get $k)" >/dev/null 2>&1; }
    done
    [ -n "$(env_get TURN_MIN_PORT)" ] && ufw delete allow "$(env_get TURN_MIN_PORT):$(env_get TURN_MAX_PORT)/udp" >/dev/null 2>&1
    ufw delete allow 47777/udp >/dev/null 2>&1 || true
  fi

  dim=$(du -sh "$DIR" 2>/dev/null | cut -f1)
  if si_no "Elimino anche la cartella $DIR ($dim)?\n\nDentro ci sono la MUSICA, i video, i database (utenti, playlist, ascolti), le chiavi dei dispositivi e dell'APK e il file .env. Non si torna indietro." n \
     && [ "$(chiedi "Per confermare scrivi ELIMINA" "")" = ELIMINA ]; then
    cd /; rm -rf "$DIR"
    msg "Armony è disinstallata e la cartella $DIR è eliminata."
  else
    msg "Armony è disinstallata. Musica, dati e .env restano in $DIR:\nper reinstallarla con gli stessi dati rilancia  sudo bash $DIR/installa.sh"
  fi
  exit 0
}

# =================================================================================================================
[ "$MODO" = disinstalla ] && disinstalla
msg "Benvenuto. Questo programma installa Armony su questo server:\n\n • Docker, se manca\n • Armony con Navidrome (la libreria musicale)\n • porte libere scelte da sole\n • l'amministratore di Navidrome\n • il servizio del tasto «Aggiorna»\n\nServe un Linux sempre acceso (Ubuntu o Debian) e qualche minuto."

. /etc/os-release 2>/dev/null || true
case "${ID:-}${ID_LIKE:-}" in *debian*|*ubuntu*) ;; *) si_no "Sistema «${PRETTY_NAME:-sconosciuto}»: l'installatore è pensato per Ubuntu/Debian. Continuo lo stesso?" n || exit 1;; esac

# --- utente e cartella ---------------------------------------------------------------------------------------------
UTENTE=$(chiedi "Utente proprietario dei file (quello con cui entri in SSH)" "${SUDO_USER:-root}")
id "$UTENTE" >/dev/null 2>&1 || { echo "L'utente $UTENTE non esiste." >&2; exit 1; }
CASA=$(getent passwd "$UTENTE" | cut -d: -f6)
QUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")
if [ -n "$QUI" ] && [ -f "$QUI/docker-compose.yml" ] && [ -f "$QUI/server/app.py" ]; then DEF_DIR=$QUI; else DEF_DIR="$CASA/armony"; fi
DIR=$(realpath -m "$(chiedi "Cartella di installazione" "$DEF_DIR")")
ENVF="$DIR/.env"

# --- programmi necessari -------------------------------------------------------------------------------------------
passo "Programmi necessari"
export DEBIAN_FRONTEND=noninteractive
MANCANO=""
for c in git curl python3 ss; do command -v $c >/dev/null || MANCANO="$MANCANO $c"; done
if [ -n "$MANCANO" ]; then
  apt-get update -qq
  apt-get install -y -qq git curl python3 iproute2 ca-certificates >/dev/null
fi
if ! command -v docker >/dev/null; then
  si_no "Docker non c'è. Lo installo ora (script ufficiale get.docker.com)?" || { echo "Senza Docker Armony non parte." >&2; exit 1; }
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  apt-get update -qq; apt-get install -y -qq docker-compose-plugin >/dev/null 2>&1 || apt-get install -y -qq docker-compose-v2 >/dev/null
fi
command -v systemctl >/dev/null && [ -d /run/systemd/system ] && systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || { echo "Docker è installato ma non risponde (systemctl status docker)." >&2; exit 1; }
# Docker Desktop: la rete host (quella di Armony e del multicast) c'è solo se attivata nelle sue impostazioni
case "$(docker info --format '{{.OperatingSystem}}' 2>/dev/null)" in *"Docker Desktop"*)
  si_no "Qui c'è Docker Desktop. Armony usa la rete «host» di Docker: senza, dagli altri dispositivi non si raggiunge.\n\nIn Docker Desktop: Settings → Resources → Network → «Enable host networking» (versione 4.34 o successiva).\nIn alternativa installa Docker direttamente in Linux/WSL.\n\nContinuo?" n || exit 1;;
esac
[ "$UTENTE" != root ] && usermod -aG docker "$UTENTE"
echo "Docker: $(docker --version | cut -d, -f1) · $(docker compose version --short 2>/dev/null)"

# --- codice ---------------------------------------------------------------------------------------------------------
passo "Codice di Armony"
g() { runuser -u "$UTENTE" -- git -C "$DIR" "$@"; }
if [ -d "$DIR/.git" ]; then
  echo "Uso la copia che c'è già in $DIR ($(cat "$DIR/VERSION" 2>/dev/null))."
else
  [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ] && { echo "$DIR esiste e non è vuota: scegli un'altra cartella." >&2; exit 1; }
  mkdir -p "$DIR" && chown "$UTENTE": "$DIR"
  runuser -u "$UTENTE" -- git clone --quiet "$REPO_URL" "$DIR"
  # l'ultima versione rilasciata (come fa il tasto «Aggiorna»), non il ramo di sviluppo
  TAG=$(g tag -l 'v*.*.*' --sort=-v:refname | head -n1)
  [ -n "$TAG" ] && g -c advice.detachedHead=false checkout --quiet "$TAG"
  echo "Scaricata la versione $(cat "$DIR/VERSION")."
fi
cd "$DIR"

# --- domande ------------------------------------------------------------------------------------------------------
[ -f "$ENVF" ] || { cp .env.example "$ENVF"; NUOVO=1; }
chown "$UTENTE": "$ENVF"; chmod 600 "$ENVF"
NOME=$(chiedi "Nome del server (lo vedono gli amici)" "$( [ "${NUOVO:-0}" = 1 ] && hostname || env_get ARMONY_NAME)")
# l'amministratore si chiede finché Navidrome non ha utenti (non basta che esista il database: un'installazione
# interrotta lo lascia vuoto)
ND_UTENTI=$(python3 -c 'import sqlite3,sys; print(sqlite3.connect("file:"+sys.argv[1]+"?mode=ro", uri=True).execute("SELECT count(*) FROM user").fetchone()[0])' data/navidrome/navidrome.db 2>/dev/null || echo 0)
NUOVO_ND=0
if [ "$ND_UTENTI" = 0 ]; then
  NUOVO_ND=1
  ND_USER=$(chiedi "Nome dell'amministratore di Navidrome (sarà anche amministratore di Armony)" "$(env_get NAVIDROME_ADMIN_USER | grep . || echo admin)")
  ND_VECCHIA=$(env_get NAVIDROME_ADMIN_PASS)
  ND_PASS=$(chiedi "Password dell'amministratore (vuota = $([ -n "$ND_VECCHIA" ] && echo "tengo quella già in .env" || echo "ne genero una"))" "" segreta)
  [ -n "$ND_PASS" ] || ND_PASS=${ND_VECCHIA:-$(casuale 16)}
fi
DOMINIO=$(chiedi "HTTPS con un nome tuo (es. armony.ddns.net), con la 443 del router inoltrata qui. Vuoto = niente HTTPS diretto" "$(env_get ARMONY_DOMAIN)")
PROFILI=$(env_get COMPOSE_PROFILES)
TURN=n; case ",$PROFILI," in *,turn,*) TURN=s;; esac
si_no "Avviare anche il TURN? Serve alle Jam fra telefoni in 5G dietro reti difficili (porte UDP da aprire sul router)." $TURN && TURN=s || TURN=n

# --- porte ----------------------------------------------------------------------------------------------------------
passo "Porte"
# i container di questa installazione, se già accesi, tengono le loro porte: non vanno contate come occupate
ACCESI=" $(docker compose ps --status running --services 2>/dev/null | tr '\n' ' ') "
for id in $(docker ps -aq); do
  docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$id" | grep -qx "$DIR" && continue
  DOCKER_PORTE="$DOCKER_PORTE $(docker inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}} {{end}}{{end}}' "$id")"
done
porta() {  # porta NOME predefinita protocollo servizio: se il servizio è già acceso, la sua porta resta
  local v; v=$(env_get "$1"); v=${v:-$2}
  case "$ACCESI" in *" $4 "*) PRESE="$PRESE$v "; printf -v "$1" '%s' "$v";; *) libera "$1" "$v" "$3";; esac
}
porta ARMONY_PORT 8080 tcp armony
porta NAVIDROME_PORT 4533 tcp navidrome
porta POT_PORT 4416 tcp pot
[ -n "$DOMINIO" ] && { porta ARMONY_HTTPS_PORT 8460 tcp https; porta ARMONY_CADDY_ADMIN_PORT 2019 tcp https; }
if [ "$TURN" = s ]; then
  porta TURN_PORT 3478 entrambe turn
  # intervallo dei relè: 41 porte UDP tutte libere, spostandosi di 100 alla volta
  A=$(env_get TURN_MIN_PORT); A=${A:-49160}
  case "$ACCESI" in *" turn "*) ;; *) while :; do
    ok=1; for p in $(seq "$A" $((A + 40))); do occupata "$p" udp && { ok=0; break; }; done
    [ "$ok" = 1 ] && break; A=$((A + 100))
  done;; esac
  TURN_MIN_PORT=$A; TURN_MAX_PORT=$((A + 40))
fi
riepilogo() {
  RIEPILOGO="Armony (app):       $ARMONY_PORT\nNavidrome (locale): $NAVIDROME_PORT\npot (locale):       $POT_PORT"
  [ -n "$DOMINIO" ] && RIEPILOGO="$RIEPILOGO\nHTTPS:              $ARMONY_HTTPS_PORT  (API di Caddy, locale: $ARMONY_CADDY_ADMIN_PORT)"
  [ "$TURN" = s ] && RIEPILOGO="$RIEPILOGO\nTURN:               $TURN_PORT tcp/udp, relè $TURN_MIN_PORT-$TURN_MAX_PORT udp"
  return 0
}
riepilogo
if ! si_no "Porte libere trovate:\n\n$RIEPILOGO\n\nVanno bene?"; then
  for k in ARMONY_PORT NAVIDROME_PORT POT_PORT; do
    PRESE=${PRESE/ ${!k} / }
    while :; do
      v=$(chiedi "Porta per $k" "${!k}")
      [[ "$v" =~ ^[0-9]+$ ]] && [ "$v" -ge 1024 ] && [ "$v" -le 65535 ] && { [ "$v" = "${!k}" ] || ! occupata "$v" tcp; } && break
      echo "La porta $v non è valida o è occupata." >&2
    done
    PRESE="$PRESE$v "; printf -v "$k" '%s' "$v"
  done
  riepilogo
fi
echo -e "$RIEPILOGO"

# --- .env -----------------------------------------------------------------------------------------------------------
passo "Configurazione (.env)"
T=$(env_get ARMONY_TOKEN); { [ "${#T}" -lt 16 ] || [ "$T" = cambiami-con-una-password-lunga ]; } && env_set ARMONY_TOKEN "$(casuale 32)"
T=$(env_get TURN_PASS); { [ -z "$T" ] || [ "$T" = cambiami-anche-questa ]; } && env_set TURN_PASS "$(casuale 24)"
env_set ARMONY_NAME "$NOME"
env_set ARMONY_DOMAIN "$DOMINIO"
for k in ARMONY_PORT NAVIDROME_PORT POT_PORT; do env_set $k "${!k}"; done
[ -n "$DOMINIO" ] && { env_set ARMONY_HTTPS_PORT "$ARMONY_HTTPS_PORT"; env_set ARMONY_CADDY_ADMIN_PORT "$ARMONY_CADDY_ADMIN_PORT"; }
[ "$TURN" = s ] && { env_set TURN_PORT "$TURN_PORT"; env_set TURN_MIN_PORT "$TURN_MIN_PORT"; env_set TURN_MAX_PORT "$TURN_MAX_PORT"; }
[ "$NUOVO_ND" = 1 ] && { env_set NAVIDROME_ADMIN_USER "$ND_USER"; env_set NAVIDROME_ADMIN_PASS "$ND_PASS"; }
# profili in .env: anche il tasto «Aggiorna» (docker compose up) li tiene accesi
P=""; [ -n "$DOMINIO" ] && P=https; [ "$TURN" = s ] && P="${P:+$P,}turn"
env_set COMPOSE_PROFILES "$P"
docker compose config -q || { echo "docker compose non accetta la configurazione: controlla $ENVF" >&2; exit 1; }
echo "Scritto $ENVF"

# --- avvio ----------------------------------------------------------------------------------------------------------
passo "Avvio (la prima volta Docker scarica e prepara le immagini: qualche minuto)"
# create prima del primo avvio: altrimenti le crea Docker come root e per copiarci la musica servirebbe sudo
mkdir -p musica video federati updates
chown "$UTENTE": musica video federati
docker compose pull --quiet --ignore-buildable 2>/dev/null || docker compose pull --quiet --ignore-pull-failures || true
# una porta può essere occupata dove "ss" non guarda (Docker Desktop, WSL in modalità mirrored, porte riservate da
# Windows): Docker lo dice solo all'avvio. Allora si prende la successiva libera e si riprova
sposta() {  # sposta porta: la variabile di .env che la usa passa a un'altra porta libera
  local k
  for k in ARMONY_PORT NAVIDROME_PORT POT_PORT ARMONY_HTTPS_PORT ARMONY_CADDY_ADMIN_PORT TURN_PORT; do
    [ "${!k:-}" = "$1" ] || continue
    PRESE="$PRESE$1 "; libera "$k" $(( $1 + 1 )) tcp; env_set "$k" "${!k}"
    echo "La porta $1 è occupata (lo dice Docker, non si vedeva da qui): $k passa a ${!k}."
    return 0
  done
  return 1
}
for TENTATIVO in $(seq 1 10); do
  OUT=$(docker compose up -d --build 2>&1 | tee /dev/stderr) && break
  P=$(printf '%s' "$OUT" | sed -nE -e 's/.*(bind host port|exposing port TCP) [0-9.]*:([0-9]+).*/\2/p' -e 's/.*Bind for [0-9.]*:([0-9]+) failed.*/\1/p' | head -n1)
  [ -n "$P" ] && [ "$TENTATIVO" -lt 10 ] && sposta "$P" || { echo "docker compose non è riuscito ad avviare Armony (vedi sopra)." >&2; exit 1; }
done
# un profilo tolto (niente HTTPS o niente TURN) lascerebbe acceso il suo container: "up" non lo spegne
[ -z "$DOMINIO" ] && docker compose --profile https rm -sf https >/dev/null 2>&1
[ "$TURN" = n ] && docker compose --profile turn rm -sf turn >/dev/null 2>&1
printf 'Attendo che Armony risponda'
OK=0
for _ in $(seq 1 60); do
  if curl -fs "http://127.0.0.1:$ARMONY_PORT/api/info" >/dev/null 2>&1; then
    # deve rispondere la nostra: un'altra Armony (per esempio lato Windows) risponderebbe senza ascoltare in questo sistema
    [ -n "$(ss -Hltn "sport = :$ARMONY_PORT" 2>/dev/null)" ] && { OK=1; break; }
    sposta "$ARMONY_PORT" && docker compose up -d armony >/dev/null 2>&1
  fi
  # Armony usa la rete host: una porta occupata la fa ripartire in errore invece di fermare docker compose
  if docker logs --since 1m armony-app 2>&1 | grep -q "Address already in use"; then
    sposta "$ARMONY_PORT" && docker compose up -d armony >/dev/null 2>&1
  fi
  printf '.'; sleep 3
done
echo
[ "$OK" = 1 ] || { echo "Armony non risponde dopo 3 minuti: guarda  docker logs armony-app" >&2; exit 1; }

ND_ESITO=""
if [ "$NUOVO_ND" = 1 ]; then
  # le richieste partono da dentro il container: così risponde di sicuro il nostro Navidrome, non un altro sulla stessa porta
  for _ in $(seq 1 30); do docker exec armony-navidrome wget -qO- http://127.0.0.1:4533/ping >/dev/null 2>&1 && break; sleep 2; done
  R=$(ND_USER="$ND_USER" ND_PASS="$ND_PASS" python3 -c 'import json,os; print(json.dumps({"username": os.environ["ND_USER"], "password": os.environ["ND_PASS"]}))' \
      | docker exec -i armony-navidrome wget -qO- --header 'Content-Type: application/json' --post-file /dev/stdin http://127.0.0.1:4533/auth/createAdmin 2>&1 || true)
  case "$R" in *'"isAdmin":true'*) ND_ESITO="Amministratore Navidrome (e di Armony): $ND_USER  ·  password: $ND_PASS";;
    *) ND_ESITO="Amministratore Navidrome NON creato ($R): crealo dalla pagina di Navidrome (vedi sotto)";; esac
fi

# --- aggiornamenti e firewall ---------------------------------------------------------------------------------------
passo "Tasto «Aggiorna»"
if [ -d /run/systemd/system ]; then sh deploy/install-updater.sh
else echo "Senza systemd il servizio di aggiornamento non si installa: aggiorna a mano (vedi LEGGIMI.md, Manutenzione)."; fi

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  if si_no "Il firewall ufw è attivo. Apro le porte di Armony ($ARMONY_PORT${DOMINIO:+, $ARMONY_HTTPS_PORT}${TURN_PORT:+, TURN})?"; then
    ufw allow "$ARMONY_PORT/tcp" >/dev/null
    [ -n "$DOMINIO" ] && ufw allow "$ARMONY_HTTPS_PORT/tcp" >/dev/null
    [ "$TURN" = s ] && { ufw allow "$TURN_PORT" >/dev/null; ufw allow "$TURN_MIN_PORT:$TURN_MAX_PORT/udp" >/dev/null; }
    # multicast in casa: le Jam vicine
    ufw allow 47777/udp >/dev/null
  fi
fi

# --- fine -----------------------------------------------------------------------------------------------------------
chown "$UTENTE": "$ENVF"
IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src") print $(i+1)}')
FINE="Armony $(cat VERSION) è installata e accesa.\n\nApri, dalla rete di casa:  http://${IP:-IP-DEL-SERVER}:$ARMONY_PORT\n"
[ -n "$ND_ESITO" ] && FINE="$FINE\n$ND_ESITO\n"
FINE="$FINE\nNella pagina tocca «Aggiungi server»: l'indirizzo è già compilato, entra con l'amministratore di Navidrome."
FINE="$FINE\n\nPagina di Navidrome (dal tuo computer):\n  ssh -L $NAVIDROME_PORT:127.0.0.1:$NAVIDROME_PORT $UTENTE@${IP:-server}   poi  http://localhost:$NAVIDROME_PORT"
FINE="$FINE\n\nMusica: copiala in $DIR/musica (Navidrome la trova in pochi minuti)."
[ -n "$DOMINIO" ] && FINE="$FINE\n\nHTTPS: sul router inoltra la 443 alla porta $ARMONY_HTTPS_PORT di ${IP:-questo server} (solo DNAT), poi https://$DOMINIO"
[ "$TURN" = s ] && FINE="$FINE\n\nTURN: sul router apri $TURN_PORT e $TURN_MIN_PORT-$TURN_MAX_PORT UDP. In Armony → Impostazioni → Jam:\n  turn:IL-TUO-INDIRIZZO:$TURN_PORT  utente armony, password TURN_PASS in .env"
FINE="$FINE\n\nPassword e porte sono in $ENVF (accesso d'emergenza: ARMONY_TOKEN)."
[ "$UTENTE" != root ] && FINE="$FINE\nPer usare docker senza sudo, $UTENTE deve uscire e rientrare."
msg "$FINE"
[ "$UI" = whiptail ] && printf '\n%b\n' "$FINE"
exit 0
