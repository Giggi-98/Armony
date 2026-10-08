# Registro decisioni — Armony

Perché il sistema è fatto così e cos'altro era sul tavolo. `LEGGIMI.md` dice
*cosa fa* Armony; questo file dice *perché è fatto in questo modo*.

**Regole**
- Append-only: le voci nuove vanno in cima. Non si modificano né si cancellano
  voci esistenti; se una decisione viene ribaltata, si aggiunge una voce che la
  cita e spiega cosa è cambiato.
- Una voce serve se c'era più di una strada e ne è stata chiusa una.
- Il campo che conta è **Da rivedere se**: senza, la voce non dice quando la
  scelta smette di valere.
- Le voci marcate *(ricostruita)* sono state dedotte dal codice esistente il
  2026-10-08, non registrate al momento della scelta. Il motivo è plausibile ma
  non confermato: se qualcuno lo sa meglio, aggiunga una voce che lo precisa.

**Formato**

```
## AAAA-MM-GG — Titolo breve
**Contesto:** il problema.
**Scelta:** cosa si è fatto.
**Alternative scartate:** cosa, e perché no.
**Conseguenze:** cosa si accetta in cambio.
**Da rivedere se:** la condizione che renderebbe la scelta sbagliata.
```

---

## 2026-10-08 — App Android: Capacitor, plugin di riproduzione nostro, APK firmato dalla Action

**Contesto:** passo C di `docs/EVOLUZIONE.md`. Serve che la musica continui a
schermo spento con notifica e cuffie, senza riscrivere il client.
**Scelta:** `app/` impacchetta `client/` così com'è con Capacitor 8.5.2
(`build-web.mjs` lo copia in `www/` e aggiunge `window.ARMONY_APP`). La musica
resta nella WebView (EQ, dissolvenza, Jam); un plugin locale (`ArmonyMediaPlugin`
+ `ArmonyMediaService`, in `app/android`) tiene un servizio in primo piano di tipo
mediaPlayback con MediaSession, notifica, wake lock e Wi-Fi lock. Il servizio
parte al primo play e resta in primo piano anche in pausa. L'APK lo costruisce
e firma la GitHub Action a ogni tag; l'app controlla le release GitHub.
`app/` usa npm: la regola "niente npm" vale per `client/`, che resta senza build.
**Alternative scartate:**
- `@jofr/capacitor-media-session`: fermo al 2024 e dichiarato per Capacitor 6.
- Riproduzione nativa (Media3/ExoPlayer): si perdono EQ, dissolvenza e
  trasmissione Jam, che vivono in Web Audio.
- Servizio che esce dal primo piano in pausa: da Android 12 ripartire dalla
  notifica con l'app in secondo piano non può più riavviarlo.
- Chiave di firma nel repository o chiave di debug: chiunque potrebbe firmare
  un "aggiornamento"; con la chiave di debug ogni build avrebbe una firma diversa.
**Conseguenze:** in pausa la notifica resta finché l'app è aperta. Senza la
chiave in `data/android/` gli aggiornamenti non si installano sopra l'app
esistente. Collaudata qui solo con plugin simulati: questa macchina non ha
virtualizzazione per un emulatore.
**Da rivedere se:** la WebView si ferma comunque in secondo piano su qualche
telefono (allora riproduzione nativa almeno per l'audio), oppure si pubblica
sul Play Store (firma gestita da Google).

## 2026-10-08 — Movimento: View Transitions per le pagine, WAAPI per il disco

**Contesto:** §3b di `docs/EVOLUZIONE.md`.
**Scelta:** cambio pagina con `document.startViewTransition` che avvolge solo
lo scambio con le sagome di caricamento (la navigazione non aspetta la rete);
il disco gira con la Web Animations API e accelera e rallenta cambiando
`playbackRate`; play/pausa con la proprietà CSS `d`. Ogni navigazione ha un
numero (`Scene.nav`): una vista superata non scrive più nel DOM.
**Alternative scartate:** animazione CSS `spin` (non può accelerare né
rallentare dolcemente); transizione che aspetta il caricamento della vista
(pagina congelata durante le richieste); una libreria di animazioni
(dipendenza, contraria a "niente npm").
**Conseguenze:** dove le View Transitions non ci sono il cambio pagina è
istantaneo come prima; lettore, barra laterale e barra in basso hanno nomi di
transizione fissi.
**Da rivedere se:** l'app nativa ha bisogno di transizioni fra documenti
diversi.

## 2026-10-08 — La luce del disco: colori estratti nel client, variabili CSS animate

**Contesto:** §3b di `docs/EVOLUZIONE.md`, "l'unica cosa memorabile".
**Scelta:** canvas 32×32 della copertina, 12 tinte più i grigi, pesate per
saturazione; la luce è un livello `#glow` fisso con gradienti radiali, i
colori sono variabili `@property` così il cambio sfuma (1,2 s). L'intensità
viene abbassata finché i testi restano AA. Vale per "In riproduzione", album e
artista.
**Alternative scartate:** una libreria (es. node-vibrant): una dipendenza in
un client senza build; colori calcolati sul server: un passaggio in più e
niente per le copertine di altri server; tinta piena dello sfondo: toglie
leggibilità e l'identità del blu notte.
**Conseguenze:** copertine da domini senza CORS non danno luce; nei browser
senza `@property` il colore cambia di colpo.
Per i link il calcolo usa `--accent-text`, l'ambra come testo: nel tema chiaro
`#9c5806` (4,8:1 sul fondo) invece di `#c9750f` (3,05:1, sotto AA da prima),
che resta per pulsanti e barre.
**Da rivedere se:** la luce diventa troppo tenue su molte copertine per
rispettare l'AA: allora meglio un velo dietro ai testi che abbassare la luce.

## 2026-10-08 — Telefono: navigazione in basso, attaccata al lettore

**Contesto:** dodici icone in alto da scorrere, fuori dalla portata del pollice.
**Scelta:** quattro sezioni più "Altro" in una barra sotto il lettore, in un
blocco unico con la safe-area; il lettore su telefono scende a due righe; in
alto restano logo e server/qualità, e la barra non è più fissa. Su desktop
"Server" e "Qualità" diventano una riga compatta che apre un foglio.
**Alternative scartate:** barra in alto con meno voci (scomoda col pollice);
barra e lettore separati (due elementi fissi, safe-area doppia); lettore a una
riga con i comandi solo in "In riproduzione" (toglie comandi).
**Da rivedere se:** l'app Android usa una navigazione nativa, o "In
riproduzione" ottiene i comandi completi e il lettore può ridursi a una riga.

## 2026-10-08 — Generi dei download: niente categorie di YouTube

**Contesto:** yt-dlp, senza un genere vero, scrive come genere il primo campo
fra `genre`, `genres`, `categories`, `tags`: tutta la libreria (551 file su
551) aveva "Music", "People & Blogs"…
**Scelta:** `meta_genre` impostato prima del download al genere vero
(`genre`/`genres`) o vuoto; `deploy/pulisci-generi.py` per i file già scaricati,
che tocca solo file con un indirizzo YouTube nei tag e per default fa solo una
prova a secco.
**Alternative scartate:** togliere l'incorporamento dei metadati (si perdono
titolo, artista, copertina); usare i tag YouTube come genere (parole chiave
del video, non generi); dedurre il genere da servizi esterni (dipendenza e
richieste di rete per ogni download).
**Conseguenze:** i brani scaricati da YouTube non hanno genere; la sezione
Generi può restare vuota.
**Da rivedere se:** si aggiunge una fonte di generi (MusicBrainz, Last.fm) o
yt-dlp inizia a dare un genere vero per YouTube Music.

## 2026-10-08 — Storico e preferenze: copia locale completa, server come punto d'incontro

**Contesto:** passo B di `docs/EVOLUZIONE.md`: con web, PC e Android le
statistiche e le preferenze si dividevano per dispositivo.
**Scelta:** ogni dispositivo tiene lo storico completo in IndexedDB, come
prima, e lo sincronizza con il server: invia gli ascolti con un identificativo
`dispositivo:istante` (idempotente), riceve quelli nuovi a pagine per numero
progressivo. Le statistiche si calcolano ancora sul dispositivo. Le preferenze
sono un documento per utente: vince la modifica più recente; volume, modalità
compatibile e l'interruttore stesso restano locali.
**Alternative scartate:**
- Leggere lo storico di Navidrome (`scrobbles`): tabella interna, senza
  durata, generi o copertina, e senza gli ascolti fatti offline.
- Statistiche calcolate sul server: il client offline non le avrebbe, e la
  vista andrebbe riscritta.
- Unire le preferenze campo per campo: complessità senza un caso reale; due
  dispositivi che cambiano impostazioni diverse nello stesso minuto sono rari.
**Conseguenze:** lo storico è sul server in chiaro, leggibile da chi gestisce
il server (lo dice l'interruttore). Ogni dispositivo scarica tutto lo storico
la prima volta. Ogni ascolto va al server del brano: con più server, ogni
server ha la sua parte.
**Da rivedere se:** lo storico diventa così grande da pesare sui telefoni,
oppure serve unire le preferenze campo per campo.

## 2026-10-08 — Accesso per utente: sessioni Armony sopra le credenziali Navidrome

**Contesto:** passo A di `docs/EVOLUZIONE.md`. Un codice condiviso dava a chi
carica musica anche il potere di aggiornare il server, e la password Navidrome
stava in chiaro negli URL e nel `localStorage`.
**Scelta:** il client calcola token + sale Subsonic (`md5(password+sale)`) e
conserva solo quelli. `POST /api/login` li verifica con `getUser` di Navidrome
e crea una sessione Armony (SQLite, 180 giorni dall'ultimo uso), che va in
`X-Token`. Il ruolo viene da `adminRole`; download e caricamento sono permessi
per utente, attivi per default. `ARMONY_TOKEN` resta come accesso di emergenza.
Dieci accessi falliti in dieci minuti bloccano l'indirizzo.
**Alternative scartate:**
- Chiavi API OpenSubsonic: Navidrome 0.64.2 non le offre.
- Verificare token + sale su Navidrome a ogni richiesta, senza sessioni: una
  chiamata in più per ogni richiesta, e nessun modo di disconnettere un
  dispositivo.
- Utenti propri di Armony: due anagrafiche da tenere allineate.
- JWT firmati invece di sessioni nel DB: non si revocano senza una lista nera,
  che è di nuovo una tabella.
**Conseguenze:** token + sale valgono quanto la password per l'API Subsonic
finché la password non cambia: rubarli dal dispositivo dà accesso
all'ascolto. Il pannello Utenti mostra solo chi ha fatto accesso almeno una
volta. Un server Armony 0.2 non ha `/api/info`: il client lo tratta come
"solo ascolto" e usa ancora il vecchio codice di accesso, se c'è.
**Da rivedere se:** Navidrome aggiunge le chiavi API (revocabili una per una),
oppure serve un permesso che i ruoli Navidrome non esprimono.

## 2026-10-08 — Client multipiattaforma: un solo codice, tre involucri

**Contesto:** i client devono esistere su web, PC e Android, contro server
di persone diverse. Analisi completa in `docs/EVOLUZIONE.md`.
**Scelta:** lo stesso `client/` ovunque. Web servito dal server come oggi;
Android con Capacitor e plugin nativi (sottofondo, offline su file), APK nelle
release GitHub; PC come PWA installabile, Electron solo se serve. Prima delle
app, fondamenta comuni: accesso con credenziali Navidrome e permessi per
ruolo, autenticazione Subsonic token + sale, indirizzo del server esplicito,
livello di API, SQLite.
**Alternative scartate:**
- TWA sul Play Store: legata a un dominio, ma ogni utente ha il suo server.
- App Android nativa da zero: riscrittura completa, e si perdono EQ,
  dissolvenza e trasmissione Jam, che vivono in Web Audio.
- Tauri per il PC: su Linux usa WebKitGTK, con WebRTC e Web Audio incompleti.
- Play Store: account, revisione e una politica che i download da YouTube
  non passerebbero.
- Codice di accesso unico per tutto: chi carica musica potrebbe anche
  aggiornare il server.
**Conseguenze:** il client deve funzionare senza sapere chi lo serve, e con
server di versione diversa. L'app Android dipende dalla WebView di sistema.
**Da rivedere se:** la riproduzione in sottofondo con WebView si rivela
inaffidabile anche con il servizio in primo piano (allora: riproduzione nativa
con Media3, perdendo gli effetti Web Audio in sottofondo).

## 2026-10-08 — Caricamento dal client: un file per richiesta, dietro il token

**Contesto:** fase 0 di `docs/FEDERAZIONE.md`: caricare musica dal
dispositivo nella libreria del server.
**Scelta:** `PUT /api/upload?folder=…&path=…` con il file come corpo grezzo,
un file per richiesta, scritto su disco man mano che arriva come
`.armony-part` e rinominato a fine invio. Solo estensioni audio e copertine
(`cover`/`folder`), verificate con `mutagen`. Doppioni riconosciuti per sha256
e saltati, omonimi diversi rinominati con ` (2)`. Nessuna conversione: il file
entra com'è. Protetto da `ARMONY_TOKEN`, come i download.
**Alternative scartate:**
- `multipart/form-data` con più file: niente avanzamento e niente nuovi
  tentativi file per file, e Flask lo analizza in memoria o su file temporanei
  prima di poterlo validare.
- Caricamento aperto a ogni utente Navidrome: Armony non ha un modello di
  utenti suo e il server riempirebbe il disco di chiunque abbia un account.
- Conversione in un formato unico: perde qualità e toglie a chi carica la
  scelta del formato.
- Archivi zip: un formato in più da validare e spacchettare, e cartelle e
  trascinamento coprono lo stesso caso.
**Conseguenze:** limite di 1 GB per file, quello predefinito di waitress
(`max_request_body_size`). I file sono di root, come quelli scaricati. Un file
con estensione sbagliata ma audio valido (un FLAC chiamato `.mp3`) viene
accettato.
**Da rivedere se:** si vuole che gli utenti senza codice di accesso carichino
nella propria parte della libreria (servirebbero cartelle per utente e un
limite di spazio).

## 2026-10-08 — Federazione: forma generale

**Contesto:** i server Armony diventano librerie personali da collegare fra
loro. Il progetto completo è in `docs/FEDERAZIONE.md`; qui solo le scelte che
hanno chiuso delle strade.
**Scelta:** collegamenti fra server creati dall'amministratore, visibilità per
utente tramite le librerie di Navidrome; un nodo collegato = una libreria
Navidrome in `federati/<nodo>/`, mai dentro `musica/`; abbonamenti in una sola
direzione, scaricati da chi riceve; prima la copia fisica; cancellazioni a
monte *conservate* per default; niente condivisione transitiva; abbinamento con
codice di sicurezza e richieste firmate Ed25519; protocollo versionato
`/fed/v1`. Prima della federazione si fa il caricamento di file dal client.
**Alternative scartate:**
- Collegamenti fra singoli utenti: Armony non ha un modello di utenti suo, e
  le reti di collegamenti si moltiplicherebbero per ogni utente.
- Ascolto a distanza come primo modo: richiede di rifare navigazione e
  streaming remoti nel client, e funziona solo se l'altro server è acceso.
- Cancellazioni sempre rispecchiate: un errore di chi offre cancellerebbe
  musica a tutti quelli che la ricevono.
- Relay propri per server non raggiungibili: costi e responsabilità; bastano
  LAN, Tailscale (anche *node sharing*) o HTTPS pubblico.
**Conseguenze:** la musica ricevuta occupa spazio; serve stato persistente
(SQLite) e un modulo server separato, da registrare quando si implementa.
**Da rivedere se:** le librerie da collegare diventano troppo grandi per
essere copiate, oppure i server diventano davvero multiutente.

## 2026-10-08 — L'updater non stacca un checkout di sviluppo dal suo ramo

**Contesto:** precisa la voce «Aggiornamenti da GitHub» qui sotto, che diceva
di sviluppare in un clone separato. Su questa macchina sviluppo e produzione
sono la stessa cartella, e un checkout del tag la lascerebbe "detached".
**Scelta:** se HEAD è su un ramo, `armony-update.sh` non fa checkout: se il
tag è già nel ramo ricostruisce soltanto, altrimenti avanza in fast-forward, e
se servirebbe un merge rifiuta. Se HEAD è già detached (server di sola
produzione) fa checkout del tag.
**Alternative scartate:** obbligare a un clone separato per la produzione
(cartella dati da spostare, doppia configurazione); merge automatico (un
conflitto a metà lascerebbe il server rotto).
**Conseguenze:** su un ramo con commit locali non pubblicati il tasto rifiuta
finché non si allinea a mano.
**Da rivedere se:** la produzione si sposta in una cartella separata.

## 2026-10-08 — Aggiornamenti da GitHub: tag, avviso e tasto eseguito dall'host

**Contesto:** Armony girerà su più server di persone diverse; ognuno deve
sapere se è indietro rispetto al repository e potersi aggiornare senza
terminale. Il repository è pubblico.
**Scelta:** una versione è un tag `vX.Y.Z` con `VERSION` uguale (lo script
rifiuta tag incoerenti). Il server confronta `VERSION`, copiato nell'immagine,
con i tag letti dall'API GitHub senza token, ogni 6 ore. Il tasto «Aggiorna»
scrive `updates/request`; un'unità systemd `.path` sull'host lancia
`deploy/armony-update.sh`, che fa checkout del tag e `docker compose up -d --build`.
Segreti spostati in `.env`, fuori da git.
**Alternative scartate:**
- Ogni push su `main` come versione: il lavoro a metà arriverebbe ai server.
- Aggiornamento automatico: un tag sbagliato arriva subito ovunque.
- Socket Docker montato nel container o Watchtower: il container avrebbe
  l'equivalente di root sull'host, e Watchtower aggiorna immagini, non un
  checkout git con un client montato.
- `VERSION` montato come file: dopo il checkout il container vede ancora il
  file vecchio (bind mount sull'inode), e se l'immagine non cambia non viene
  ricreato.
- Releases GitHub invece dei tag: un passaggio in più per pubblicare, senza
  vantaggi finché non servono note di rilascio.
**Conseguenze:** i server in produzione stanno su un checkout "detached" del
tag; lo sviluppo si fa in un clone separato. Sulla macchina di sviluppo il
tasto rifiuta se ci sono modifiche non committate. Il client cambia al
`git checkout`, il server solo dopo la ricostruzione: per pochi secondi possono
essere disallineati.
**Da rivedere se:** il repository diventa privato (serve un token per server),
oppure con la federazione i server devono parlarsi fra versioni diverse e
serve una versione di protocollo separata da quella dell'app.

## 2026-10-08 — Client senza bundler né dipendenze npm *(ricostruita)*

**Contesto:** il client deve girare su un Raspberry e installarsi come PWA,
modificabile da chi lo ospita.
**Scelta:** HTML + JS puro in `client/`, script caricati in ordine con scope
globale condiviso, nessun passo di build.
**Alternative scartate:** React/Vite/TypeScript: una toolchain da mantenere
in cambio di nulla che serva a un'app con un solo sviluppatore; e il montaggio
in sola lettura di `client/` nel container (modifica = live) sparirebbe.
**Conseguenze:** `armony.js` è grande (~125 KB) e lo scope globale va gestito a
mano; niente tipi.
**Da rivedere se:** il client si divide fra più persone che lavorano in
parallelo, o i file superano una dimensione in cui non si orienta più nessuno.

## 2026-10-08 — Navidrome come motore della libreria *(ricostruita)*

**Contesto:** servono indicizzazione, transcodifica, utenti, playlist, share.
**Scelta:** Navidrome (API Subsonic) dietro un proxy in `app.py`; Armony
aggiunge solo ciò che Subsonic non ha (Jam, download, scoperta LAN).
**Alternative scartate:** una libreria propria (riscrivere scanner e
transcoder); Jellyfin (più pesante, API meno adatta a client musicali).
**Conseguenze:** utenti e permessi si gestiscono nell'interfaccia di Navidrome
(porta 4533). Compatibilità gratuita con le app Subsonic native.
**Da rivedere se:** serve un modello di permessi o di sincronizzazione che
Subsonic non può esprimere (vedi la federazione fra server, quando arriverà).

## 2026-10-08 — Proxy su un'unica origine *(ricostruita)*

**Contesto:** il client parla con Navidrome e con le API di Armony.
**Scelta:** `/rest/*` e `/share/*` passano dal server Armony su 8080.
**Alternative scartate:** client che parla direttamente con Navidrome: due
origini, CORS da configurare su Navidrome, due certificati per HTTPS.
**Conseguenze:** un solo indirizzo da esporre (es. `tailscale serve 8080`).
Il server di un amico senza Armony davanti richiede CORS (vedi `LEGGIMI.md`).
**Da rivedere se:** il proxy diventa un collo di bottiglia per lo streaming.

## 2026-10-08 — Segnalazione Jam dal server, ma cifrata dai client *(ricostruita)*

**Contesto:** WebRTC ha bisogno di un canale di segnalazione; il server non
deve poter leggere né falsificare.
**Scelta:** relay via `/api/jam/*` di messaggi AES-GCM con chiave derivata dal
segreto nel frammento `#` del link; secondo strato ECDH sul canale dati;
codice di sicurezza a cinque simboli dalle impronte DTLS.
**Alternative scartate:** server di segnalazione che vede i messaggi (fiducia
nel gestore); solo scambio manuale di codici (esiste, ma come ripiego).
**Conseguenze:** gli strati crittografici aggiuntivi esistono solo in contesto
sicuro (HTTPS); senza, resta solo la cifratura WebRTC.
**Da rivedere se:** mai per ragioni di comodità. Solo se cambia il modello di
minaccia.

## 2026-10-08 — Rete host per il container armony *(ricostruita)*

**Contesto:** i browser non fanno multicast; serve che lo faccia il server.
**Scelta:** `network_mode: host`, multicast UDP su 239.255.77.77.
**Alternative scartate:** rete bridge (il multicast non esce dal container);
mDNS (più dipendenze, stesso vincolo di rete).
**Conseguenze:** funziona solo su Linux; su Docker Desktop si toglie, con
`ARMONY_MULTICAST=0`. Tutto il resto deve funzionare anche senza multicast.
**Da rivedere se:** si sostituisce la scoperta LAN con un registro centrale o
con la federazione fra server.

## 2026-10-08 — yt-dlp non bloccato, aggiornato a ogni avvio *(ricostruita)*

**Contesto:** i siti cambiano spesso e una versione fissa di yt-dlp smette di
funzionare in settimane.
**Scelta:** `yt-dlp` senza versione in `requirements.txt` e `pip install -U` nel
`CMD` del Dockerfile.
**Alternative scartate:** versione bloccata (build riproducibili, download rotti).
**Conseguenze:** il comportamento può cambiare a un riavvio senza modifiche al
codice; serve rete all'avvio.
**Da rivedere se:** un aggiornamento di yt-dlp rompe l'API usata in `app.py`.
