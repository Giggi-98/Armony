#!/bin/sh
# Armony: porta il server all'ultimo tag vX.Y.Z del repository.
# Lo lancia armony-update.path quando l'app scrive updates/request (tasto «Aggiorna»).
# Gira come root per usare docker; git gira come il proprietario della cartella,
# così il checkout non lascia file di root nel repo.
set -u
DIR=$(cd "$(dirname "$0")/.." && pwd)
U="$DIR/updates"
OWNER=$(stat -c %U "$DIR")
cd "$DIR" || exit 1
g() { runuser -u "$OWNER" -- git "$@"; }
status() {
  printf '{"state":"%s","msg":"%s","ts":%s}\n' "$1" "$2" "$(date +%s)" > "$U/status.json.tmp"
  mv "$U/status.json.tmp" "$U/status.json"
}
fail() { status "errore" "$1"; echo "armony-update: $1" >&2; exit 1; }

rm -f "$U/request"
status "in corso" ""
g diff --quiet HEAD -- || fail "ci sono modifiche locali non salvate in git: aggiornamento annullato"
g fetch --quiet --tags --force origin || fail "git fetch non riuscito"
TAG=$(g tag -l 'v*.*.*' --sort=-v:refname | head -n1)
[ -n "$TAG" ] || fail "nessun tag di versione nel repository"
V=$(g show "$TAG:VERSION" 2>/dev/null)
[ "$V" = "${TAG#v}" ] || fail "il tag $TAG ha VERSION=$V: tag non valido"
if g symbolic-ref -q HEAD >/dev/null; then
  # checkout di sviluppo su un ramo: resta sul ramo, avanza solo in fast-forward
  g merge-base --is-ancestor "$TAG" HEAD || g merge --quiet --ff-only "$TAG" \
    || fail "il ramo $(g symbolic-ref --short HEAD) non può avanzare a $TAG senza merge"
else
  g -c advice.detachedHead=false checkout --quiet "$TAG" || fail "checkout di $TAG non riuscito"
fi
docker compose up -d --build || fail "docker compose non riuscito: journalctl -u armony-update"
status "fatto" "$TAG"
echo "armony-update: aggiornato a $TAG"
