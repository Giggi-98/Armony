#!/bin/sh
# Armony: applica un trasferimento ricevuto (server/trasferimento.py, docs/TRASFERIMENTO.md). Lo lancia
# armony-update.sh, come root, quando l'app scrive updates/trasferimento/applica.
# Copia di sicurezza dei dati di questo server, poi database, identità e foto del vecchio al loro posto, nome e
# amministratore di Navidrome nel .env, riavvio e controllo: deve rispondere con l'identità del vecchio. Se non va,
# si torna ai dati di prima.
set -u
DIR=$(cd "$(dirname "$0")/.." && pwd)
T="$DIR/updates/trasferimento"; A="$DIR/data/armony"; N="$DIR/data/navidrome"
cd "$DIR" || exit 1
esito() {
  python3 -c 'import json,sys,time; json.dump({"ok": sys.argv[1] == "1", "msg": sys.argv[2], "ts": int(time.time())}, open(sys.argv[3], "w"))' \
    "$1" "$2" "$T/esito.json"
}
rm -f "$T/applica"
for f in armony.db navidrome.db identita.key manifesto.json env.json; do
  [ -f "$T/$f" ] || { esito 0 "manca $f"; echo "armony-trasferimento: manca $f" >&2; exit 1; }
done
PUB=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pub"])' "$T/manifesto.json")

B="$DIR/data/backup/prima-del-trasferimento-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$B" && chmod 700 "$DIR/data/backup" "$B"
cp -a "$A/armony.db" "$A/identita.key" "$B/" 2>/dev/null
cp -a "$N/navidrome.db" "$B/" 2>/dev/null
[ -d "$A/avatar" ] && cp -a "$A/avatar" "$B/"
cp -a .env "$B/env"

torna() {
  docker compose stop armony navidrome >/dev/null 2>&1
  rm -f "$T/applicato.json" "$A"/armony.db-wal "$A"/armony.db-shm "$N"/navidrome.db-wal "$N"/navidrome.db-shm
  cp -a "$B/armony.db" "$B/identita.key" "$A/" 2>/dev/null
  cp -a "$B/navidrome.db" "$N/" 2>/dev/null
  cp -a "$B/env" .env
  docker compose up -d >/dev/null 2>&1
  esito 0 "$1: tornato ai dati di prima (copia in $B)"
  echo "armony-trasferimento: $1" >&2
  exit 1
}

docker compose stop armony navidrome || torna "non riesco a fermare Armony e Navidrome"
rm -f "$A"/armony.db-wal "$A"/armony.db-shm "$N"/navidrome.db-wal "$N"/navidrome.db-shm
cp "$T/armony.db" "$A/armony.db" && cp "$T/identita.key" "$A/identita.key" && chmod 600 "$A/identita.key" \
  && cp "$T/navidrome.db" "$N/navidrome.db" || torna "copia dei database non riuscita"
if [ -d "$T/avatar" ]; then mkdir -p "$A/avatar" && cp -a "$T/avatar/." "$A/avatar/"; fi
# nome del server e amministratore di Navidrome del vecchio: senza, Armony non parlerebbe più con Navidrome
python3 - "$T/env.json" .env <<'PY' || torna "scrittura del .env non riuscita"
import json, re, sys
env, path = json.load(open(sys.argv[1])), sys.argv[2]
s = open(path).read()
for k, v in env.items():
    v = '"' + str(v).replace("\\", "\\\\").replace('"', '\\"').replace("$", "$$") + '"'
    s, n = re.subn(rf"(?m)^{k}=.*$", lambda m: f"{k}={v}", s)
    if not n:
        s += f"\n{k}={v}\n"
open(path, "w").write(s)
PY
# all'avvio Armony lo vede e cambia gli indirizzi (trasferimento.dopo_applicazione)
python3 -c 'import json,sys,time; json.dump({"ts": int(time.time())}, open(sys.argv[1], "w"))' "$T/applicato.json"
docker compose up -d || torna "riavvio non riuscito"
PORT=$(docker compose config 2>/dev/null | sed -n 's/^ *ARMONY_PORT: *"\{0,1\}\([0-9]*\)"\{0,1\}$/\1/p' | head -n1)
OK=0
for i in $(seq 1 40); do
  sleep 3
  if python3 -c 'import json,sys,urllib.request; sys.exit(0 if json.load(urllib.request.urlopen(sys.argv[1], timeout=3)).get("pub") == sys.argv[2] else 1)' \
      "http://127.0.0.1:${PORT:-8080}/fed/hello" "$PUB" 2>/dev/null; then OK=1; break; fi
done
[ "$OK" = 1 ] || torna "dopo il riavvio Armony non risponde con l'identità del server trasferito"
# i database ricevuti non servono più (la copia di questo server resta in data/backup)
rm -f "$T/armony.db" "$T/navidrome.db" "$T/identita.key" "$T/env.json"
esito 1 "trasferimento applicato"
echo "armony-trasferimento: applicato"
