#!/bin/sh
# Installa il servizio che esegue il tasto «Aggiorna». Da lanciare una volta, come root.
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
[ "$(id -u)" = 0 ] || { echo "Lancialo con sudo." >&2; exit 1; }
mkdir -p "$DIR/updates" && touch "$DIR/updates/installed"
for u in armony-update.path armony-update.service; do
  sed "s|@DIR@|$DIR|g" "$DIR/deploy/$u" > "/etc/systemd/system/$u"
done
systemctl daemon-reload
systemctl enable --now armony-update.path
echo "Fatto. Stato: systemctl status armony-update.path · log: journalctl -u armony-update"
