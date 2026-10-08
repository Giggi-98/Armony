# Armony

La musica della vostra compagnia, dai vostri server. Ascolto in più qualità, più server, Jam peer-to-peer cifrate, download da YouTube e centinaia di altri siti, offline, testi sincronizzati, statistiche. Tutto in un'app web leggera che si installa sul telefono come un'app vera.

## Cosa c'è dentro

```
armony/
├── docker-compose.yml   avvia tutto con un comando
├── client/              l'app (HTML + JS, nessuna compilazione)
│   ├── index.html       struttura e stile
│   ├── armony.js        libreria, lettore, offline, statistiche, download
│   ├── jam.js           Jam peer-to-peer cifrate
│   └── sw.js, manifest.json, icon.svg   installazione e apertura offline
├── server/              proxy, segnalazione Jam, multicast, download, aggiornamenti (Python)
├── deploy/              servizio che esegue il tasto «Aggiorna»
├── .env.example         password e nome del server: copialo in .env
├── VERSION              versione installata
├── musica/              ← i vostri file musicali
└── video/               ← i video scaricati
```

## Installazione

Serve un computer Linux sempre acceso con Docker: un Raspberry Pi 4/5, un NAS, un vecchio PC o un VPS.

1. Scarica Armony sul server con `git clone https://github.com/TUO-UTENTE/armony.git` ed entra nella cartella.
2. Copia `.env.example` in `.env` e cambia `ARMONY_TOKEN` (la password per i download e gli aggiornamenti), `TURN_PASS` e, se vuoi, `ARMONY_NAME`. Lascia `ARMONY_REPO` com'è: dice ad Armony dove cercare le versioni nuove.
3. Avvia con `docker compose up -d`, poi abilita il tasto «Aggiorna» con `sudo deploy/install-updater.sh` (una volta sola).
4. Apri `http://IP-DEL-SERVER:4533` e crea l'amministratore di Navidrome. Da lì crei anche un utente per ogni amico.
5. Apri `http://IP-DEL-SERVER:8080`. Questa è Armony. Aggiungi il server: l'indirizzo è già compilato, inserisci utente e password.

Per la musica che hai già, copiala in `musica/`: Navidrome la indicizza da solo in pochi minuti.

Su Mac o Windows con Docker Desktop leggi il commento in cima a `docker-compose.yml`: devi togliere la rete "host", e con lei il multicast.

## Consiglio forte: usa HTTPS

I browser riservano alcune funzioni alle pagine sicure. Senza HTTPS Armony funziona, ma perdi tre cose:

- lo strato di cifratura end-to-end delle Jam (resta la cifratura WebRTC);
- l'installazione come app e l'apertura senza rete;
- il salvataggio persistente dei brani offline su alcuni telefoni.

Il modo più semplice è **Tailscale**, gratuito per uso personale. Installalo sul server e sui telefoni degli amici, poi sul server esegui `tailscale serve --bg 8080`. Ottieni un indirizzo tipo `https://server.nome-rete.ts.net` con certificato valido, raggiungibile solo dai dispositivi della vostra rete Tailscale, da casa o in 5G.

In alternativa: un dominio con Caddy davanti alla porta 8080 (HTTPS automatico), oppure Cloudflare Tunnel.

## Funzioni

### Ascolto
- **Sei livelli di qualità**: dall'originale (FLAC compreso) a Opus 32 kbps. Puoi impostare una qualità diversa automatica quando sei su rete mobile.
- **Dissolvenza tra i brani** da 0 a 12 secondi. Il brano successivo viene precaricato, quindi i passaggi sono praticamente senza pause.
- **Normalizzazione del volume** (ReplayGain) per brano o per album: niente più salti di volume tra una canzone e l'altra.
- **Equalizzatore a 10 bande** con preimpostazioni, tra cui "Altoparlante del telefono" e "Cuffiette piccole".
- **Volume notte**: comprime la dinamica, così i passaggi forti non svegliano nessuno e quelli piano si sentono.
- **Velocità** da 0,75× a 2×, senza alterare l'intonazione.
- **Timer di spegnimento** con sfumata finale, oppure "a fine brano".
- **Più server** contemporaneamente. La coda può mescolare brani di server diversi.
- **Continua su un altro dispositivo**: la coda viene salvata sul server, così apri Armony sul PC e riprendi dal punto esatto.

### Scoperta
- **Testi sincronizzati** in stile karaoke. Tocchi una riga e la musica salta lì, e puoi correggere la sincronia di mezzo secondo alla volta. I testi arrivano dal server o, se non ci sono, da LRCLIB (si può disattivare).
- **Visualizzatore** circolare attorno al disco.
- **Radio da un brano o da un artista**, basata su brani simili, genere e popolarità.
- **Mix pronti**: casuale, preferiti, "Riscoperte" (brani che non ascolti da almeno due mesi), per decennio, per genere.
- **Amici**: chi sta ascoltando cosa in tempo reale, con un tasto per ascoltarlo anche tu.
- Biografie, artisti simili e brani più popolari nella pagina di ogni artista.

### Jam: ascoltare insieme
Ognuno sul suo telefono sente lo stesso brano nello stesso istante. Si propongono brani, si vota l'ordine della coda, si chatta e si mandano reazioni che volano sullo schermo di tutti.

**Due reti:**
- **Stessa rete.** Il collegamento usa solo indirizzi locali e la musica non esce mai dal Wi-Fi. Le Jam aperte compaiono da sole a chi è sulla stessa rete. Il server Armony le annuncia con **multicast UDP** (gruppo 239.255.77.77), che permette anche a più server Armony in casa di trovarsi a vicenda. I browser non possono usare il multicast direttamente, quindi è il server a farlo per loro.
- **Internet / 5G.** Il collegamento attraversa le reti mobili con STUN. Se un operatore lo blocca (capita con alcuni NAT mobili), attiva il TURN incluso: `docker compose --profile turn up -d`, poi inserisci indirizzo e credenziali nelle impostazioni della Jam.

**Due modi di ascoltare:**
- **Sincronizzato.** Ogni telefono prende la musica dal server alla propria qualità e resta allineato all'host entro poche decine di millisecondi, grazie a un orologio condiviso con correzione continua.
- **Trasmissione.** L'host trasmette il suo audio, già equalizzato, a 192 kbps stereo. Non serve un account sul suo server. Chi non ha accesso al server passa da solo a questa modalità.

**Inviti:** link (anche come QR code), richiesta di ingresso dalla lista "Jam vicine", oppure **invito senza server**: vi scambiate due codici (anche via WhatsApp) e il collegamento è diretto, anche se il server Armony non è raggiungibile.

**Sicurezza**, a strati:
1. WebRTC cifra sempre audio e dati punto-punto (DTLS-SRTP, chiavi effimere).
2. La segnalazione passa dal server già cifrata con AES-GCM 256. La chiave nasce da un segreto casuale che sta nel link d'invito, dopo il simbolo #. Quella parte del link non viene mai inviata al server, che quindi inoltra messaggi che non può leggere né falsificare.
3. Il canale dati viene cifrato una seconda volta con una chiave nata da uno scambio ECDH P-256 tra i due telefoni.
4. **Codice di sicurezza**: cinque simboli calcolati dalle impronte crittografiche di entrambi. Se coincidono sui due schermi, nessuno si è messo in mezzo, nemmeno chi gestisce il server.

L'host decide le regole: coda aperta o con approvazione, controllo della musica agli ospiti, conferma per ogni ingresso, visibilità sulla rete.

### Offline
Salva album, playlist o singoli brani sul telefono, nella qualità che preferisci. Senza rete l'app si apre comunque e suona da lì. In ogni lista un pallino verde segna i brani già salvati.

### Download
- Da link (uno o tanti) o con la **ricerca integrata** su YouTube e SoundCloud.
- Solo audio (MP3, M4A, Opus, FLAC) oppure video fino al 4K, anche intere playlist o canali.
- Copertina e metadati inclusi. **SponsorBlock** taglia intro, parti parlate e sponsor dai video musicali.
- La libreria si aggiorna da sola e i video si guardano dentro l'app.

### Playlist, importazione ed esportazione
- Playlist condivise con tutti gli utenti del server, con descrizione.
- **Importa da Spotify**: esporta le tue playlist con Exportify (exportify.app) e importa il CSV. Armony trova i brani che hai già, poi **cerca, scarica e aggiunge da solo i mancanti** appena sono pronti. Funziona anche con M3U e JSON.
- Esporta in M3U, JSON o CSV.
- **Link di condivisione** di 30 giorni per album, playlist o brani, ascoltabili anche da chi non ha un account.

### Statistiche
Minuti di ascolto, artisti, brani, album e generi preferiti, giorni consecutivi di ascolto e orari in cui ascolti, per 7 giorni, 30 giorni, anno o da sempre. Con un tasto crei un'**immagine riepilogativa** da condividere. Lo storico resta sul dispositivo e si può esportare o cancellare.

### Comodità
Si installa come app ("Aggiungi a schermata Home"). Controlli dalla schermata di blocco e dalle cuffie, tema chiaro o scuro, scorciatoie da tastiera (premi `?`). Il backup delle impostazioni configura il telefono di un amico in dieci secondi.

## App native
Navidrome funziona anche con app già pronte, collegate allo stesso server e alle stesse playlist: Symfonium o Tempo su Android, Amperfy o play:Sub su iPhone. La Jam però è solo di Armony.

## Manutenzione
- **Aggiornare Armony**: quando esce una versione nuova, l'app lo segnala a chi ha inserito il codice di accesso. In Impostazioni → Aggiornamenti premi «Aggiorna»: il server scarica la versione e si riavvia in un minuto. Senza il servizio installato, a mano: `git fetch --tags && git checkout <ultima versione> && docker compose up -d --build`. L'aggiornamento si rifiuta se hai modificato a mano dei file del repository (`.env` e i dati non contano).
- Aggiornare Navidrome e gli altri componenti: `docker compose pull && docker compose up -d`
- yt-dlp si aggiorna a ogni riavvio. Se un sito smette di funzionare, basta `docker compose restart armony`.
- Backup: le cartelle `data/` (utenti, playlist, statistiche del server) e `musica/`.

## Problemi frequenti

**iPhone: la musica si ferma a schermo bloccato.** Attiva "Modalità compatibile" in Impostazioni. Perdi equalizzatore, dissolvenza e trasmissione nella Jam, ma il resto funziona.

**Jam via 5G: gli ospiti restano su "collegamento…".** L'operatore blocca il collegamento diretto. Attiva il TURN (vedi sopra) e apri sul router le porte 3478 e 49160-49200 UDP verso il server.

**Le Jam vicine non compaiono.** Il multicast richiede la rete "host" di Docker su Linux, e alcuni router con "isolamento client" lo bloccano. Il link d'invito funziona sempre.

**Il server di un amico non suona nella mia coda.** Se il suo Navidrome è esposto direttamente, senza Armony davanti, deve permettere le richieste da altri siti (CORS). La soluzione più semplice è che installi anche lui Armony.

**I link condivisi non si aprono da fuori.** Nelle impostazioni del server, sotto "Avanzate", inserisci l'indirizzo pubblico del server.

## Una nota sui diritti
Scaricare da YouTube va contro i suoi termini di servizio, e condividere musica protetta tra persone diverse non rientra nella copia privata, anche senza scopo di lucro. Il download è perfetto per musica libera, registrazioni vostre e contenuti che gli autori distribuiscono gratuitamente. Valutate voi come usarlo.
