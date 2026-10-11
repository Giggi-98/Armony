#!/bin/sh
# Il guardiano: dove non c'è systemd (WSL, NAS, Docker Desktop) fa quello che fa armony-update.path. Ogni 5 secondi
# guarda se l'app ha chiesto un aggiornamento o un trasferimento (updates/request) e lancia deploy/armony-update.sh in
# un container a sé: se l'aggiornamento ricrea il guardiano, quel container finisce il lavoro lo stesso.
# Rete host: lo script controlla Armony su 127.0.0.1, come farebbe sulla macchina.
set -u
D="${ARMONY_DIR:-}"
[ -n "$D" ] && [ -f "$D/server/app.py" ] || { echo "guardiano: ARMONY_DIR in .env deve essere la cartella di Armony (percorso intero), non «$D»" >&2; sleep 60; exit 1; }
cd "$D" || exit 1
mkdir -p updates data/guardiano && touch updates/installed
echo "guardiano: attivo su $D"
while :; do
  echo "{\"ts\": $(date +%s)}" > updates/guardiano.json  # battito: il trasferimento controlla che ci sia
  if [ -f updates/request ] && [ -z "$(docker ps -q -f name=^armony-aggiorna$)" ]; then
    echo "guardiano: richiesta trovata, la eseguo"
    docker run --rm --name armony-aggiorna --network host -v /var/run/docker.sock:/var/run/docker.sock \
      -v "$D:$D" -v "$D/data/guardiano:/etc/armony" -w "$D" armony-guardiano sh deploy/armony-update.sh || true
  fi
  sleep 5
done
