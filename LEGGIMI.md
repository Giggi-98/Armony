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

1. Scarica Armony sul server con `git clone https://github.com/Giggi-98/Armony.git armony` ed entra nella cartella.
2. Copia `.env.example` in `.env` e cambia `ARMONY_TOKEN` (l'accesso di emergenza dell'amministratore: normalmente non serve), `TURN_PASS` e, se vuoi, `ARMONY_NAME`. Lascia `ARMONY_REPO` com'è: dice ad Armony dove cercare le versioni nuove.
3. Avvia con `docker compose up -d`, poi abilita il tasto «Aggiorna» con `sudo deploy/install-updater.sh` (una volta sola).
4. Apri `http://IP-DEL-SERVER:4533` e crea l'amministratore di Navidrome. Da lì crei anche un utente per ogni amico.
5. Apri `http://IP-DEL-SERVER:8080`. Questa è Armony. Aggiungi il server: l'indirizzo è già compilato, inserisci utente e password di Navidrome. Gli amministratori di Navidrome lo sono anche in Armony (aggiornamenti, permessi degli utenti); gli altri utenti possono ascoltare, scaricare e caricare musica, e l'amministratore può togliere download o caricamento a chi vuole in Impostazioni → Utenti.

La password non viene salvata sul dispositivo né mandata negli indirizzi: Armony conserva solo un'impronta (token e sale Subsonic).

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
- **Un dispositivo suona, gli altri lo comandano.** Se avvii la musica sul telefono e stava suonando sul PC, il PC si ferma e il suo lettore mostra cosa suona sul telefono: pausa, avanti, indietro e la barra comandano il telefono, e viceversa. Il pulsante con l'altoparlante nel lettore ("Dove suona") elenca i tuoi dispositivi collegati: tocca quello su cui vuoi la musica e si sposta lì dallo stesso punto; se lo scegli prima di avviare un album, l'album parte lì. Nello stesso foglio puoi sganciare un dispositivo ("suona per conto suo"): PC e telefono suonano cose diverse senza fermarsi a vicenda. Vale per i dispositivi collegati allo stesso utente; si spegne in Impostazioni → Profilo, dove dai anche un nome al dispositivo.
- **La barra ondeggia** mentre suona, come nei lettori di Android, e torna dritta in pausa.

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

### Eliminare brani
Dal menu di un brano ("Elimina dal server") o dalla pagina dell'album ("Elimina album"). Il file viene cancellato per tutti, dopo una conferma. Gli amministratori possono sempre; agli altri utenti l'amministratore lo abilita in Impostazioni → Utenti → Eliminazione (spento di default).

### Caricamento dal dispositivo
- In Scarica → **Dal dispositivo** carichi sul server la musica che hai sul telefono o sul computer: file singoli, cartelle intere o trascinandoli nella pagina.
- Formati: MP3, FLAC, M4A/AAC, Opus, OGG, WAV, AIFF, WMA, WavPack, APE. Le copertine `cover.jpg` e `folder.jpg` vengono caricate insieme all'album.
- I file arrivano nella cartella scelta (predefinita `Caricati`), con la loro struttura di cartelle. Un file identico già presente non viene ricaricato.
- Serve il permesso di caricamento, attivo per tutti finché l'amministratore non lo toglie. Limite di 1 GB per file. Tieni aperta la pagina finché il caricamento non finisce.

### Playlist, importazione ed esportazione
- Playlist condivise con tutti gli utenti del server, con descrizione.
- **Importa da Spotify**: esporta le tue playlist con Exportify (exportify.app) e importa i CSV, anche tutti insieme: ogni file diventa una playlist (se esiste già, vi si aggiungono solo i brani mancanti, quindi si può rifare). Armony riconosce i brani che hai già da titolo, artisti e durata, poi **cerca, scarica e aggiunge da solo i mancanti** appena sono pronti, una volta sola anche se stanno in più playlist. I brani scaricati arrivano già ordinati: titolo, tutti gli artisti, album, artista dell'album, data d'uscita, numero di traccia, generi, etichetta e copertina (dal CSV, completati con Deezer), in `Spotify/<artista>/<album>/<NN - titolo>`; la ricerca online usa la durata per scartare versioni live, cover e video con introduzioni. Funziona anche con M3U e JSON.
- Esporta in M3U, JSON o CSV.
- **Link di condivisione** di 30 giorni per album, playlist o brani, ascoltabili anche da chi non ha un account.

### Statistiche
Minuti di ascolto, artisti, brani, album e generi preferiti, giorni consecutivi di ascolto e orari in cui ascolti, per 7 giorni, 30 giorni, anno o da sempre. Con un tasto crei un'**immagine riepilogativa** da condividere. Lo storico e le preferenze (qualità, equalizzatore, dissolvenza, tema…) sono gli stessi su tutti i tuoi dispositivi: vengono salvati sul server, legati al tuo utente. Volume e modalità compatibile restano di ogni dispositivo. Si può disattivare in Impostazioni → Profilo; lo storico si può esportare o cancellare, anche dal server.

### Comodità
Si installa come app ("Aggiungi a schermata Home"). Controlli dalla schermata di blocco e dalle cuffie, tema chiaro o scuro, scorciatoie da tastiera (premi `?`). Il backup delle impostazioni configura il telefono di un amico in dieci secondi.

Sul telefono le sezioni principali sono in basso, sotto il lettore; le altre sono in "Altro". Il server in uso e la qualità si cambiano dal pulsante in alto (in fondo alla barra laterale sul computer). Le impostazioni sono divise in gruppi richiudibili, con una casella di ricerca: scrivi "tema" o "qualità" e restano solo le voci che ti servono.

Se nel sistema è attivo «Riduci movimento», Armony lo rispetta: niente dischi che girano né elementi in volo, solo dissolvenze.

"In riproduzione", album e artisti prendono la luce dei colori della copertina; se un brano non ha testo, al suo posto compaiono i prossimi brani.

## App Android
Armony per Android è la stessa app che apri nel browser, con in più ciò che il browser non dà: la musica continua a schermo spento, i comandi stanno nella notifica e nella schermata di blocco, i tasti delle cuffie funzionano, e il tasto indietro non la chiude mentre suona.

**Installarla.** Sul telefono apri la pagina delle release del progetto su GitHub (`https://github.com/Giggi-98/Armony/releases`), scarica `armony-vX.Y.Z.apk` e aprilo. Android chiede di consentire l'installazione da quella fonte (il browser): consentilo una volta. Al primo avvio inserisci indirizzo, utente e password del server, come nel browser. Al primo play l'app chiede di mostrare le notifiche: senza, la musica continua ma i comandi non si vedono.

**Aggiornarla.** Quando esce una versione nuova l'app la propone da sola, all'apertura o quando ci torni: "Aggiorna ora" la scarica, ne verifica l'impronta e apre la conferma di Android. La prima volta Android chiede di consentire ad Armony di installare app: consentilo e torna nell'app, l'aggiornamento riparte da solo. Si installa sopra la vecchia, senza perdere niente. Lo stesso tasto è in Impostazioni → App Android. Chi ha la 0.6.0 deve installare a mano la versione successiva una volta sola: l'aggiornamento dall'app esiste da lì in poi.

**Per chi pubblica le versioni.** Ogni tag `vX.Y.Z` fa costruire l'APK firmato a GitHub (`.github/workflows/android.yml`) e lo allega alla release. La chiave di firma sta in `data/android/` sul server: **fanne una copia di sicurezza**, perché senza la stessa chiave gli aggiornamenti non si installano sopra l'app esistente e ognuno dovrebbe disinstallarla e reinstallarla. Una volta sola, in GitHub → Settings → Secrets and variables → Actions, aggiungi `ARMONY_KEYSTORE_B64` (il contenuto di `data/android/ARMONY_KEYSTORE_B64.txt`), `ARMONY_KEYSTORE_PASSWORD`, `ARMONY_KEY_ALIAS` e `ARMONY_KEY_PASSWORD` (da `data/android/firma.properties`). Per costruire l'APK sul proprio computer: `app/toolchain.sh`, poi `. /opt/armony-android/env.sh && cd app && npm ci && npm run apk`.

## Altre app
Navidrome funziona anche con app già pronte, collegate allo stesso server e alle stesse playlist: Symfonium o Tempo su Android, Amperfy o play:Sub su iPhone. La Jam però è solo di Armony.

## Manutenzione
- **Aggiornare Armony**: quando esce una versione nuova, l'app lo segnala agli amministratori. In Impostazioni → Aggiornamenti premi «Aggiorna»: il server scarica la versione e si riavvia in un minuto. Senza il servizio installato, a mano: `git fetch --tags && git checkout <ultima versione> && docker compose up -d --build`. L'aggiornamento si rifiuta se hai modificato a mano dei file del repository (`.env` e i dati non contano).
- Aggiornare Navidrome e gli altri componenti: `docker compose pull && docker compose up -d`
- Generi sbagliati sui brani scaricati prima della 0.5 ("People & Blogs", "Gaming"…, sono le categorie dei video YouTube): `docker compose run --rm --no-deps -v ./deploy:/deploy:ro --entrypoint python armony /deploy/pulisci-generi.py /music` mostra cosa cambierebbe; aggiungi `--applica` per toglierli. Tocca solo i file scaricati da YouTube.
- **Sistemare i brani già in libreria con i CSV di Spotify** (titoli "NA", album sbagliati, niente copertina): metti i CSV di Exportify in `spotify_playlists/` (resta fuori da git) e lancia `docker compose run --rm --no-deps -v ./deploy:/deploy:ro -v ./spotify_playlists:/csv:ro --entrypoint python armony /deploy/riallinea-spotify.py /csv /music`. È una prova a secco: elenca file per file cosa cambierebbe. Con `--applica` riscrive i tag e sposta i file nelle cartelle degli album, e lascia un registro per annullare (`--annulla /music/.armony-riallinea-….jsonl`). Dopo, reimporta i CSV: Navidrome considera nuovi i brani sistemati e le playlist vanno completate.
- **YouTube chiede di confermare che non sei un robot**: succede a volte con gli indirizzi dei server. Armony prova allora SoundCloud. Se capita spesso, esporta i cookie di YouTube dal browser (estensione "Get cookies.txt LOCALLY") in `data/armony/youtube-cookies.txt`: i download li useranno. Usa un account secondario: il rischio ricade su quell'account.
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
