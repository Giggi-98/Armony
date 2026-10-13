#!/bin/sh
# Casse Bluetooth del server per Armony (anche le Alexa, che fanno da cassa Bluetooth). Si lancia una volta, sulla
# macchina di Armony, dalla sua cartella:   sudo sh deploy/bluetooth.sh
#
# Cosa fa (Debian/Ubuntu):
#  - installa BlueZ e PipeWire (con il suo pezzo per il Bluetooth) e accende il Bluetooth a ogni avvio;
#  - crea l'utente di sistema "armony-bt" che sul bus di sistema può parlare solo con BlueZ: il container usa lui per
#    abbinare e collegare le casse (root sul bus di sistema potrebbe comandare tutto l'host);
#  - fa girare come armony-bt un ponte D-Bus (xdg-dbus-proxy, servizio armony-bt-dbus) con una presa sua in
#    /run/armony-bt: con AppArmor (Ubuntu) il bus di sistema rifiuta i processi dei container, il ponte no;
#  - fa partire PipeWire nella sessione dell'utente che possiede la cartella anche senza schermo e senza login
#    (linger), e dice a WirePlumber di usare il Bluetooth anche così;
#  - scrive ARMONY_BT_UID, ARMONY_BT_DBUS e ARMONY_BT_PULSE in .env e ricrea il container di Armony.
# Rilanciarlo non fa danni.
set -e
[ "$(id -u)" = 0 ] || { echo "Lancialo con sudo: sudo sh deploy/bluetooth.sh"; exit 1; }
cd "$(dirname "$0")/.."
[ -f .env ] && [ -f docker-compose.yml ] || { echo "Non trovo .env e docker-compose.yml: lancialo dalla cartella di Armony"; exit 1; }
command -v apt-get >/dev/null || { echo "Serve Debian o Ubuntu (apt-get)"; exit 1; }
UTENTE=$(stat -c %U .)
[ "$UTENTE" != root ] || UTENTE=${SUDO_USER:-}
[ -n "$UTENTE" ] && [ "$UTENTE" != root ] || { echo "Non so di quale utente è la sessione per PipeWire: lancialo con sudo da un utente normale"; exit 1; }
UUID_=$(id -u "$UTENTE")
CASA=$(getent passwd "$UTENTE" | cut -d: -f6)

if ! ls /sys/class/bluetooth 2>/dev/null | grep -q hci; then
  echo "Attenzione: non vedo un adattatore Bluetooth (/sys/class/bluetooth). Continuo, ma senza non suonerà niente."
fi

echo "1/5 Installo BlueZ e PipeWire…"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bluez pipewire pipewire-pulse wireplumber libspa-0.2-bluetooth rfkill xdg-dbus-proxy >/dev/null

echo "2/5 Bluetooth acceso a ogni avvio…"
if [ -f /etc/bluetooth/main.conf ]; then
  if grep -q '^#\?AutoEnable' /etc/bluetooth/main.conf; then sed -i 's/^#\?AutoEnable *=.*/AutoEnable=true/' /etc/bluetooth/main.conf
  else printf '\n[Policy]\nAutoEnable=true\n' >> /etc/bluetooth/main.conf; fi
fi
rfkill unblock bluetooth 2>/dev/null || true
systemctl enable --now bluetooth >/dev/null 2>&1
systemctl restart bluetooth

echo "3/5 Utente armony-bt (solo BlueZ) e ponte D-Bus…"
id armony-bt >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin armony-bt
cat > /etc/dbus-1/system.d/armony-bluetooth.conf <<'EOF'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<!-- Armony (deploy/bluetooth.sh): il container abbina e collega le casse con questo utente, che parla solo con BlueZ -->
<busconfig>
  <policy user="armony-bt">
    <allow send_destination="org.bluez"/>
  </policy>
</busconfig>
EOF
systemctl reload dbus 2>/dev/null || systemctl reload dbus-broker 2>/dev/null || true
# il ponte: il container si collega alla sua presa; lui parla col bus di sistema come armony-bt (vedi in testa)
cat > /etc/systemd/system/armony-bt-dbus.service <<'FINE'
[Unit]
Description=Armony: ponte D-Bus per il Bluetooth (deploy/bluetooth.sh)
After=dbus.service bluetooth.service

[Service]
User=armony-bt
RuntimeDirectory=armony-bt
RuntimeDirectoryMode=0755
# la cartella resta anche quando il ponte si riavvia: il container la tiene montata
RuntimeDirectoryPreserve=yes
ExecStart=/usr/bin/xdg-dbus-proxy unix:path=/run/dbus/system_bus_socket /run/armony-bt/system_bus_socket
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
FINE
systemctl daemon-reload
systemctl enable armony-bt-dbus >/dev/null 2>&1
systemctl restart armony-bt-dbus
i=0; while [ ! -S /run/armony-bt/system_bus_socket ] && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
[ -S /run/armony-bt/system_bus_socket ] || { echo "Il ponte D-Bus non è partito: journalctl -u armony-bt-dbus"; exit 1; }

echo "4/5 PipeWire per $UTENTE anche senza login…"
loginctl enable-linger "$UTENTE"
i=0; while [ ! -d "/run/user/$UUID_" ] && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
# WirePlumber di solito usa il Bluetooth solo con qualcuno seduto davanti allo schermo: qui non c'è nessuno
mkdir -p "$CASA/.config/wireplumber/wireplumber.conf.d" "$CASA/.config/wireplumber/bluetooth.lua.d"
cat > "$CASA/.config/wireplumber/wireplumber.conf.d/80-armony-bluetooth.conf" <<'EOF'
# Armony (deploy/bluetooth.sh): Bluetooth anche senza nessuno davanti allo schermo (WirePlumber 0.5)
wireplumber.profiles = {
  main = {
    monitor.bluez.seat-monitoring = disabled
  }
}
EOF
cat > "$CASA/.config/wireplumber/bluetooth.lua.d/80-armony-bluetooth.lua" <<'EOF'
-- Armony (deploy/bluetooth.sh): Bluetooth anche senza nessuno davanti allo schermo (WirePlumber 0.4)
bluez_monitor.properties["with-logind"] = false
EOF
chown -R "$UTENTE": "$CASA/.config/wireplumber"
su -s /bin/sh "$UTENTE" -c "export XDG_RUNTIME_DIR=/run/user/$UUID_; systemctl --user enable pipewire pipewire-pulse wireplumber >/dev/null 2>&1; systemctl --user restart pipewire pipewire-pulse wireplumber"
i=0; while [ ! -S "/run/user/$UUID_/pulse/native" ] && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
[ -S "/run/user/$UUID_/pulse/native" ] || { echo "PipeWire non è partito (manca /run/user/$UUID_/pulse/native)"; exit 1; }

echo "5/5 .env e container di Armony…"
metti() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
metti ARMONY_BT_UID "$(id -u armony-bt)"
metti ARMONY_BT_DBUS /run/armony-bt
metti ARMONY_BT_PULSE "/run/user/$UUID_/pulse"
docker compose up -d --build armony

echo
echo "Fatto. In Armony: Impostazioni → Casse Bluetooth → «Cerca casse», con la cassa in modalità abbinamento"
echo "(per un'Alexa: «Alexa, associa il Bluetooth»). Poi la cassa compare in «Dove suona»."
