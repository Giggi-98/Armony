# Il guardiano di Armony (servizio "guardiano" di docker-compose.yml): quello che serve a deploy/armony-update.sh e
# deploy/armony-trasferimento.sh per girare in un container invece che con systemd. Base: l'immagine ufficiale di
# Docker, con un compose recente (quello di Alpine 3.20 non conosce `pull_policy: daily` del servizio pot)
FROM docker:28.0.1-cli
RUN apk add --no-cache git python3 openssh-keygen util-linux coreutils
