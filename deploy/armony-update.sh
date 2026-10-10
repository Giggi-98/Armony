#!/bin/sh
# Armony: porta il server all'ultimo tag vX.Y.Z del repository.
# Lo lancia armony-update.path quando l'app scrive updates/request (tasto «Aggiorna»).
# Gira come root per usare docker; git gira come il proprietario della cartella,
# così il checkout non lascia file di root nel repo.
#
# Prima di aggiornare: copia dei database (data/backup/, le ultime 5) e dell'immagine di Armony.
# Dopo: se la build fallisce o il server non risponde con la versione nuova entro 90 s, si torna alla versione di prima.
# Tag firmati: con /etc/armony/allowed_signers il tag deve avere la firma dei rilasci (deploy/allowed_signers), altrimenti
# niente aggiornamento. Il file si installa con install-updater.sh o, la prima volta, dalla versione già installata.
set -u
DIR=$(cd "$(dirname "$0")/.." && pwd)
U="$DIR/updates"
OWNER=$(stat -c %U "$DIR")
SIGNERS=/etc/armony/allowed_signers
cd "$DIR" || exit 1
g() { runuser -u "$OWNER" -- git "$@"; }
# JSON scritto da python: un messaggio con le virgolette rompeva il file e l'app non mostrava l'errore
status() {
  python3 -c 'import json,sys,time; json.dump({"state": sys.argv[1], "msg": sys.argv[2], "ts": int(time.time())}, open(sys.argv[3], "w"))' \
    "$1" "$2" "$U/status.json.tmp" && mv "$U/status.json.tmp" "$U/status.json"
}
fail() { status "errore" "$1"; echo "armony-update: $1" >&2; exit 1; }

rm -f "$U/request"
status "in corso" ""
g diff --quiet HEAD -- || fail "ci sono modifiche locali non salvate in git: aggiornamento annullato"
# niente --force: un tag già scaricato che punta altrove (spostato sul repo) fa fallire l'aggiornamento
g fetch --quiet --tags origin || fail "git fetch non riuscito (forse un tag è stato spostato sul repository)"
TAG=$(g tag -l 'v*.*.*' --sort=-v:refname | head -n1)
[ -n "$TAG" ] || fail "nessun tag di versione nel repository"
V=$(g show "$TAG:VERSION" 2>/dev/null)
[ "$V" = "${TAG#v}" ] || fail "il tag $TAG ha VERSION=$V: tag non valido"

# firma: la prima volta le chiavi si prendono dalla versione già installata (di cui ci si fida), poi solo da $SIGNERS
if [ ! -f "$SIGNERS" ] && [ -f "$DIR/deploy/allowed_signers" ]; then
  mkdir -p /etc/armony && cp "$DIR/deploy/allowed_signers" "$SIGNERS" && chmod 644 "$SIGNERS"
fi
if [ -f "$SIGNERS" ]; then
  g -c gpg.ssh.allowedSignersFile="$SIGNERS" verify-tag "$TAG" >/dev/null 2>&1 \
    || fail "il tag $TAG non ha la firma dei rilasci di Armony: aggiornamento rifiutato"
fi

PREV=$(g rev-parse HEAD)
PREV_V=$(cat VERSION 2>/dev/null || echo vecchia)
[ "$PREV_V" = "$V" ] && { status "fatto" "$TAG"; echo "armony-update: già a $TAG"; exit 0; }

# copie prima di migrazioni che non si annullano: backup coerente anche col database in uso (WAL)
B="$DIR/data/backup/$PREV_V-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$B" && chmod 700 "$DIR/data/backup" "$B"
for db in data/armony/armony.db data/navidrome/navidrome.db; do
  [ -f "$DIR/$db" ] || continue
  python3 -c 'import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close()' \
    "$DIR/$db" "$B/$(basename "$db")" || fail "copia di $db non riuscita: aggiornamento annullato"
done
chmod 600 "$B"/*.db 2>/dev/null
cp "$DIR/data/armony/identita.key" "$B/" 2>/dev/null && chmod 600 "$B/identita.key"
ls -1d "$DIR"/data/backup/*/ 2>/dev/null | sort | head -n -5 | xargs -r rm -rf  # si tengono le ultime 5
IMG=$(docker compose images -q armony 2>/dev/null | head -n1)
[ -n "$IMG" ] && docker tag "$IMG" "armony-armony:prima-$PREV_V"

if g symbolic-ref -q HEAD >/dev/null; then
  # checkout di sviluppo su un ramo: resta sul ramo, avanza solo in fast-forward
  g merge-base --is-ancestor "$TAG" HEAD || g merge --quiet --ff-only "$TAG" \
    || fail "il ramo $(g symbolic-ref --short HEAD) non può avanzare a $TAG senza merge"
  BRANCH=1
else
  g -c advice.detachedHead=false checkout --quiet "$TAG" || fail "checkout di $TAG non riuscito"
  BRANCH=0
fi

torna() {
  # versione nuova rotta: codice e immagine di prima (il client è montato dal repo: torna anche lui)
  if [ "$BRANCH" = 1 ]; then g reset --quiet --keep "$PREV"; else g -c advice.detachedHead=false checkout --quiet "$PREV"; fi
  if docker image inspect "armony-armony:prima-$PREV_V" >/dev/null 2>&1; then
    docker tag "armony-armony:prima-$PREV_V" armony-armony:latest && docker compose up -d --no-build
  else
    docker compose up -d --build
  fi
  fail "$1: tornato a $PREV_V (copia dei database in data/backup)"
}

docker compose up -d --build || torna "docker compose non riuscito con $TAG"
PORT=$(docker compose config 2>/dev/null | sed -n 's/^ *ARMONY_PORT: *"\{0,1\}\([0-9]*\)"\{0,1\}$/\1/p' | head -n1)
OK=0
for i in $(seq 1 30); do
  sleep 3
  if python3 -c 'import json,sys,urllib.request; sys.exit(0 if json.load(urllib.request.urlopen(sys.argv[1], timeout=3)).get("version") == sys.argv[2] else 1)' \
      "http://127.0.0.1:${PORT:-8080}/api/info" "$V" 2>/dev/null; then OK=1; break; fi
done
[ "$OK" = 1 ] || torna "il server $TAG non risponde dopo l'avvio"
status "fatto" "$TAG"
echo "armony-update: aggiornato a $TAG"
