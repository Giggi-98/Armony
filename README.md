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
- Testi sincronizzati in stile karaoke, visualizzatore, radio da un brano o da un artista, mix pronti e **mix del giorno** sui tuoi artisti preferiti.
- **Cache dei brani** come Spotify: i prossimi della coda arrivano prima che servano e partono subito, anche senza rete. L'app si apre all'istante anche in 5G.
- Sul telefono si usa come Spotify: mini lettore da scorrere, lettore a tutto schermo, menu del profilo, tieni premuto per il menu di un brano, coda con «Prossimi in coda» e brani simili quando finisce.
- Menu, ordinamenti e «Cerca qui» come su Spotify in ogni playlist e album; sul computer, **tasto destro** su brani, album, artisti e playlist per tutte le azioni.

**Più dispositivi, una sola musica**
- Avvii sul telefono e il PC diventa il telecomando, o viceversa; "Dove suona" sposta la musica da un dispositivo all'altro dallo stesso punto. Se un'app si chiude male, si riaggancia da sola.
- Riconosce le cuffie Bluetooth (col nome) e mette in pausa quando le stacchi.

**Insieme agli amici**
- **Jam**: ascoltate la stessa musica nello stesso momento, ognuno dal suo telefono; proposte, voti, reazioni. Cifrata da un capo all'altro.
- **Amici dal vivo**: chi sta ascoltando cosa sul server, in tempo reale, e cosa fa (download, playlist, Jam).
- **Jam Radio**: stazioni che girano all'infinito sul server; ti sintonizzi e senti lo stesso punto degli altri, tipo Discord. Anche quelle dei server collegati.
- Gli amici si creano un account da soli con un invito, oppure li crei tu in un attimo: mandi un link o un QR e al primo ingresso scelgono la loro password. Per ognuno decidi cosa può fare (playlist proprie, vedere quelle degli altri, scaricare, caricare, radio…).

- **Playlist collaborative**, «Manda a un amico», il mix di due amici con la vostra affinità.

**La libreria**
- Download da YouTube, SoundCloud e centinaia di siti (yt-dlp), con copertina e metadati; caricamento di file dal dispositivo. La coda va a turno fra gli utenti; un brano già in libreria non entra due volte.
- **Importazione da Spotify** (CSV di Exportify): la fa il server in pochi secondi anche con migliaia di brani, scarica i mancanti e tiene le playlist complete e nell'ordine di Spotify mentre arrivano, anche ad app chiusa. «Brani che ti piacciono» diventano anche i tuoi Preferiti.
- **Scelta della versione giusta**: il server confronta più candidati e scarta live, cover e audio scadente; nelle informazioni del brano vedi da dove arriva il file e in che formato, e se è sbagliato ne scegli un'altra versione con un tocco.
- **Cerca anche fuori dalla libreria** (con anteprima di 30 secondi), **nuove uscite** dei tuoi artisti, volume uniforme sui brani scaricati, playlist da riordinare trascinando, cronologia degli ascolti.
- **Notifiche**: campanella con importazioni e download finiti, Jam degli amici e dispositivi da approvare, anche come avvisi del telefono o del computer.
- Album completi: le tracce che mancano compaiono al loro posto e si scaricano con un tocco.
- Cartelle di playlist, come su Spotify.
- Modifica di titoli, artisti e copertine; eliminazione dei brani; statistiche d'ascolto, tue e di tutto il server (quante volte è stato ascoltato ogni brano e da chi), con l'immagine da condividere tua e del gruppo.

**Per chi gestisce il server**
- **Stato del server**: processore, memoria, rete, chi sta ascoltando cosa, dispositivi collegati, coda dei download, con l'andamento dell'ultima ora e del giorno.
- **Registro eventi**: errori e situazioni incerte del server e dei telefoni in un posto solo, da copiare e mandare a chi ripara.
- **Aggiornamenti sicuri**: un tasto, una copia dei database prima di ogni versione (più una ogni notte), ritorno automatico alla versione di prima se la nuova non parte, e solo versioni firmate.
- Pensato per stare su internet: Navidrome raggiungibile solo da Armony, chiavi per dispositivo, limiti ai tentativi di password.

**Server collegati**
- Colleghi il tuo server a quello di un amico (con un codice di sicurezza da confrontare): in Cerca compare "Nella rete" con i loro brani, anche degli amici dei vostri amici. Li ascolti subito o li copi nella tua libreria. La pagina **Rete** mostra la mappa. Per ogni collegamento scegli il verso: vi vedete a vicenda, solo tu offri o solo tu ricevi. Funziona anche per i server dietro NAT, senza porte aperte: si appoggiano a uno raggiungibile e la rete si forma da sola, a maglia o a stella. Ti puoi **abbonare** alle playlist pubbliche degli amici: ne hai una copia che resta uguale all'originale.

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
