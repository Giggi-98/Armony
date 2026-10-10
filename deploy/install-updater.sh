#!/bin/sh
# Installa il servizio che esegue il tasto «Aggiorna». Da lanciare una volta, come root.
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
[ "$(id -u)" = 0 ] || { echo "Lancialo con sudo." >&2; exit 1; }
mkdir -p "$DIR/updates" && touch "$DIR/updates/installed"
for u in armony-update.path armony-update.service; do
  sed "s|@DIR@|$DIR|g" "$DIR/deploy/$u" > "/etc/systemd/system/$u"
done
# chiavi dei rilasci: da qui in poi l'aggiornamento accetta solo tag firmati con queste (armony-update.sh)
mkdir -p /etc/armony && cp "$DIR/deploy/allowed_signers" /etc/armony/allowed_signers && chmod 644 /etc/armony/allowed_signers
systemctl daemon-reload
systemctl enable --now armony-update.path
echo "Fatto. Stato: systemctl status armony-update.path · log: journalctl -u armony-update"
