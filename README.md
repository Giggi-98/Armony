# Armony

**La musica della vostra compagnia, dai vostri server.**

Armony è un'app musicale in stile Spotify che gira su un server tuo: un Raspberry, un NAS, un vecchio PC. Usa [Navidrome](https://www.navidrome.org) per la libreria e ci aggiunge tutto il resto: ascolto insieme agli amici, download, importazione da Spotify, statistiche, un'app Android che funziona anche senza server, e server di amici collegati fra loro.

[![Ultima versione](https://img.shields.io/github/v/release/Giggi-98/Armony?label=versione&color=f4a63c)](https://github.com/Giggi-98/Armony/releases/latest)

Il manuale completo, in italiano semplice, è [`LEGGIMI.md`](LEGGIMI.md).

---

## Cosa fa

**Ascoltare**
- Web app (si installa come app sul telefono e sul PC) e app Android, con lo stesso aspetto: Home, Cerca, Libreria, playlist, artisti con la discografia completa.
- Qualità fino all'originale (FLAC), dissolvenza fra i brani, normalizzazione del volume, equalizzatore a 10 bande con modalità **automatica** che si regola su ogni brano, protezione dai gracchi, volume notte, timer.
- Testi sincronizzati in stile karaoke, visualizzatore, radio da un brano o da un artista, mix pronti.

**Più dispositivi, una sola musica**
- Avvii sul telefono e il PC diventa il telecomando, o viceversa; "Dove suona" sposta la musica da un dispositivo all'altro dallo stesso punto. Se un'app si chiude male, si riaggancia da sola.
- Riconosce le cuffie Bluetooth (col nome) e mette in pausa quando le stacchi.

**Insieme agli amici**
- **Jam**: ascoltate la stessa musica nello stesso momento, ognuno dal suo telefono; proposte, voti, reazioni. Cifrata da un capo all'altro.
- **Amici dal vivo**: chi sta ascoltando cosa sul server, in tempo reale, e cosa fa (download, playlist, Jam).
- **Jam Radio**: stazioni che girano all'infinito sul server; ti sintonizzi e senti lo stesso punto degli altri, tipo Discord. Anche quelle dei server collegati.
- Gli amici si creano un account da soli, con un invito.

**La libreria**
- Download da YouTube, SoundCloud e centinaia di siti (yt-dlp), con copertina e metadati; caricamento di file dal dispositivo.
- **Importazione da Spotify** (CSV di Exportify): riconosce i brani che hai, scarica i mancanti e li mette nelle playlist.
- Album completi: le tracce che mancano compaiono al loro posto e si scaricano con un tocco.
- Modifica di titoli, artisti e copertine; eliminazione dei brani; statistiche d'ascolto.

**Server collegati**
- Colleghi il tuo server a quello di un amico (con un codice di sicurezza da confrontare): in Cerca compare "Nella rete" con i loro brani, anche degli amici dei vostri amici. Li ascolti subito o li copi nella tua libreria. La pagina **Rete** mostra la mappa.

**App Android**
- Musica a schermo spento, comandi nella notifica, aggiornamenti dall'app stessa.
- Funziona **anche senza server** con la musica del telefono; il server diventa la copia di sicurezza.
- Si scarica con un QR code (Impostazioni → App Android) o da [questo link](https://github.com/Giggi-98/Armony/releases/latest/download/armony.apk), che porta sempre all'ultima versione.

---

## Installazione da zero

Serve un computer **Linux** sempre acceso (Raspberry Pi 4/5, NAS, vecchio PC, VPS). Su Mac o Windows leggi la nota in fondo.

```sh
# 1. Docker (se non c'è già), poi esci e rientra dalla sessione
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER

# 2. Armony
git clone https://github.com/Giggi-98/Armony.git armony
cd armony
mkdir -p musica video federati      # prima del primo avvio, così le cartelle sono tue e non di root

# 3. Configurazione: cambia ARMONY_TOKEN e TURN_PASS, e se vuoi ARMONY_NAME (il nome del server)
cp .env.example .env
nano .env

# 4. Avvio
docker compose up -d

# 5. Tasto «Aggiorna» nell'app (una volta sola)
sudo deploy/install-updater.sh
```

6. Apri `http://IP-DEL-SERVER:4533` e crea l'**amministratore di Navidrome** (nome utente e password).
7. Apri `http://IP-DEL-SERVER:8080`: questa è Armony. Tocca **Aggiungi server** (l'indirizzo è già compilato) ed entra con l'utente appena creato.
8. In Armony: **Impostazioni → Utenti → Registrazione**, inserisci una volta le stesse credenziali dell'amministratore. Servono per far creare un account agli amici con un invito e per collegare il tuo server a quello di altri.
9. Copia la tua musica in `musica/`: Navidrome la trova da solo in pochi minuti (o subito con il tasto di scansione).

Fatto: da qui in avanti gli aggiornamenti arrivano con il tasto **Aggiorna** in Impostazioni.

**Consigliato:** HTTPS. Il modo più semplice è [Tailscale](https://tailscale.com): sul server `tailscale serve --bg 8080` e ottieni un indirizzo `https://…ts.net` con certificato valido (dettagli in [`LEGGIMI.md`](LEGGIMI.md#consiglio-forte-usa-https)). Poi scrivi quell'indirizzo in **Impostazioni → Server musicali → Indirizzo pubblico di questo server**: link, inviti e QR useranno quello. Senza HTTPS Armony funziona, ma perdi la cifratura end-to-end delle Jam, l'installazione come app dal browser e l'offline persistente su alcuni telefoni.

**Mac o Windows (Docker Desktop):** nel `docker-compose.yml` togli `network_mode: host` dal servizio `armony`, aggiungi `ports: ["8080:8080"]`, metti `NAVIDROME_URL: "http://navidrome:4533"` e `ARMONY_MULTICAST: "0"`. Si perde solo la scoperta automatica in casa (multicast).

**Porte:** 8080 (Armony), 4533 (Navidrome); il servizio `pot` (aiuta i download da YouTube) ascolta solo in locale. Facoltativo: `docker compose --profile turn up -d` avvia un server TURN per la Jam dietro reti mobili difficili.

---

## Documentazione

| File | Cosa contiene |
|---|---|
| [`LEGGIMI.md`](LEGGIMI.md) | Manuale completo: funzioni, installazione, amici, app Android, manutenzione, problemi frequenti |
| [`DECISIONS.md`](DECISIONS.md) | Perché Armony è fatta così: ogni scelta con le alternative scartate |
| [`docs/FEDERAZIONE.md`](docs/FEDERAZIONE.md) | Come funzionano i server collegati (protocollo, sicurezza) |
| [`docs/EVOLUZIONE.md`](docs/EVOLUZIONE.md) | Cosa c'è in ogni versione e cosa viene dopo |

## Com'è fatta

```
server/       Flask + waitress: proxy verso Navidrome, download, Jam, dispositivi, federazione
client/       HTML e JavaScript puro, senza bundler né dipendenze
app/          app Android (Capacitor) che impacchetta client/; l'APK firmato lo costruisce GitHub a ogni versione
deploy/       aggiornamento dal tasto «Aggiorna» (systemd) e utilità
musica/ video/ federati/ data/    i tuoi dati: restano sul server e fuori da git
```

Ogni versione è un tag `vX.Y.Z`: i server Armony la vedono e si aggiornano con un tasto, l'app Android la propone da sola.

## Una nota sui diritti

Scaricare da YouTube va contro i suoi termini di servizio, e condividere musica protetta fra persone diverse non rientra nella copia privata. Il download e i server collegati sono pensati per musica libera, registrazioni vostre e contenuti che gli autori distribuiscono gratuitamente.
