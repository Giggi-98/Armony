# Snapcast per Armony (profilo "snapcast"): la stessa musica in sincrono in tutte le stanze. Armony manda l'audio
# alla sorgente TCP (solo da questa macchina); le stanze sono gli snapclient (porta 1704), il controllo è sulla 1780
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends snapserver ca-certificates && rm -rf /var/lib/apt/lists/*
COPY snapserver.conf /etc/snapserver.conf
CMD ["snapserver", "--config", "/etc/snapserver.conf"]
