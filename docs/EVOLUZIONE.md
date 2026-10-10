# Evoluzione di Armony — funzioni, limiti, client multipiattaforma

Stato: **approvato**, 2026-10-08, su Armony 0.2.0 (decisioni in §5). Le proposte diventano voci di
`DECISIONS.md` quando vengono scelte. La federazione ha il suo documento
(`docs/FEDERAZIONE.md`); qui compare solo dove si incastra con il resto.

## 1. Le funzioni di oggi e come possono crescere

Peso: **S** ore · **M** giorni · **L** settimane.

| Area | Cosa c'è | Limite che si vede | Sviluppo proposto | Peso |
|---|---|---|---|---|
| **Ascolto** | 6 qualità, dissolvenza, ReplayGain, EQ 10 bande, volume notte, velocità, timer, più server in coda | Su telefono il browser può sospendere l'audio a schermo spento (iPhone: "modalità compatibile" che spegne EQ e dissolvenza) | Nell'app Android: servizio di riproduzione in primo piano con notifica e controlli (§3) | M |
| **Coda fra dispositivi** | `savePlayQueue` di Navidrome | Solo i brani del server del brano corrente | Va bene così finché la coda multi-server è rara | — |
| **Testi** | Sincronizzati, da server o LRCLIB, correzione sincronia | — | Salvare le correzioni di sincronia sul server, per tutti i dispositivi | S |
| **Scoperta** | Radio da brano/artista, mix, artisti simili | Calcolata solo su questo server | Playlist intelligenti di Navidrome (`.nsp`); con la federazione, "cosa ascoltano sui server collegati" | M |
| **Amici** | `getNowPlaying` del server, ascolta anche tu | Solo amici dello stesso server | Dopo la federazione: amici dei server collegati | M |
| **Jam** | P2P cifrata, sincronizzata o trasmessa, inviti, codice di sicurezza | Il link d'invito è costruito da `location.origin`: in un'app nativa punterebbe al telefono | Indirizzo pubblico del server negli inviti; Jam fra utenti di server collegati | S / L |
| **Offline** | Brani in IndexedDB nel browser | Spazio deciso dal browser, che può svuotarlo; su iPhone fragile | App native: file veri su disco; "tieni sempre offline" per playlist e preferiti, aggiornati da soli | M |
| **Download** | yt-dlp, ricerca, SponsorBlock, video | **La coda vive in memoria**: un riavvio (anche un aggiornamento dal tasto) la perde | Coda su SQLite, ripresa dopo il riavvio | S |
| **Caricamento** | Fase 0: file e cartelle, doppioni, verifica audio | Un file interrotto riparte da zero; pagina da tenere aperta | Caricamento a blocchi ripartibile; nell'app Android continua in sottofondo | M |
| **Playlist** | Import Spotify (Exportify) con download dei mancanti, M3U/JSON/CSV, link 30 giorni | — | Playlist offerte ai server collegati (federazione fase 2) | — |
| **Statistiche** | Complete e belle, immagine riepilogativa | **Solo sul dispositivo**: con web, PC e Android diventano tre storici diversi | Storico sul server, per utente. Navidrome lo tiene già (`scrobbles`, `annotation`): Armony lo legge e il client lo unisce al locale | M |
| **Impostazioni** | Backup/ripristino via file | Ogni dispositivo ha le sue, da rifare a mano | Preferenze di ascolto sincronizzate per utente sul server | S |
| **Accesso** | Server Navidrome (utente e password) **più** "servizio di download" (indirizzo e codice) | Due configurazioni per lo stesso server; un solo codice per tutto (download, caricamenti, aggiornamenti) | Accesso unico con le credenziali Navidrome, permessi dai ruoli (§2.1) | M |
| **Aggiornamenti** | Tag GitHub, avviso, tasto | Solo il server | Le app native controllano le release GitHub allo stesso modo (§3.4) | S |

## 2. Cosa blocca i client multipiattaforma

Quattro problemi da risolvere **prima** delle app. Sono anche le fondamenta
della federazione.

### 2.1 Accesso: un codice condiviso non basta

Oggi chi ha `ARMONY_TOKEN` può scaricare, caricare **e aggiornare il server**.
Per permettere a un amico di caricare musica bisogna dargli il potere di
aggiornare il server. Con app installate su telefoni di persone diverse peggiora.

**Proposta**: l'utente entra **una volta sola** con indirizzo, utente e password
Navidrome. Il server Armony verifica le credenziali con Navidrome, emette un
proprio token di sessione e ne ricava i permessi dal ruolo:

| Ruolo Navidrome | Ascolto, Jam | Download, caricamento | Aggiornamenti, federazione, utenti |
|---|---|---|---|
| utente | sì | sì (disattivabile per utente) | no |
| amministratore | sì | sì | sì |

`ARMONY_TOKEN` resta solo come accesso di emergenza dell'amministratore.
"Server" e "Servizio di download" nelle impostazioni diventano **una cosa sola**.

### 2.2 La password non deve stare negli URL

Il client usa l'autenticazione Subsonic `p=enc:<password in esadecimale>`, che
è la password in chiaro, reversibile. Finisce in ogni URL di flusso e di
copertina, quindi nei log, nella cronologia e nei link copiati. È anche
salvata in chiaro in `localStorage`.

**Proposta**: autenticazione Subsonic **token + sale** (`t=md5(password+sale)`,
`s=sale`), calcolata una volta al login. Si salva il token, non la password.
*(Da verificare in implementazione: se Navidrome 0.64 supporta le chiavi API
OpenSubsonic, sono ancora meglio, perché si revocano una per una.)*

### 2.3 Il client non deve dipendere da chi lo serve

Oggi il client web è servito dal server, quindi usa `location.origin` come
indirizzo predefinito, per i link Jam e per la scoperta LAN. Un client
nell'app Android o PC è servito **da sé stesso**.

**Proposta**: un solo "indirizzo del server" scelto al primo avvio (o
precompilato quando il client è servito dal server), usato ovunque; mai
`location.origin` per costruire link da condividere.

### 2.4 Client e server avranno versioni diverse

Oggi client e server sono sempre allineati: il client arriva dal server.
Un'app installata può essere più nuova o più vecchia del server a cui si collega.

**Proposta**: `GET /api/health` restituisce anche un **livello di API** (intero)
e un elenco di capacità (`upload`, `stats`, `federazione`…). Il client
nasconde ciò che il server non ha e, se il livello è troppo vecchio, dice di
aggiornare il server. È lo stesso principio del `proto` della federazione.

### 2.5 Due fragilità del server da sistemare insieme

- **Stato in memoria**: coda dei download, stanze Jam. Serve SQLite (già
  previsto per la federazione): introdurlo una volta, per tutti.
- **48 thread di waitress**: ogni flusso audio passato dal proxy e ogni attesa
  della Jam (25 s) occupa un thread per tutta la durata. Con più utenti, più
  dispositivi e la federazione che trasferisce file si esauriscono. Da misurare
  con un test di carico, poi alzare il numero di thread o servire i flussi
  diversamente.

## 3. Client web, PC e Android

### 3.1 Un solo client, tre involucri

Il client è già HTML + JS puro senza passi di build (`DECISIONS.md`), e
questo è un vantaggio: **lo stesso codice di `client/`** si può impacchettare
così com'è.

| Piattaforma | Proposta | Perché | Alternativa scartata |
|---|---|---|---|
| **Web** | Come oggi, servito dal server | Zero installazione, sempre aggiornato | — |
| **Android** | **Capacitor** con `client/` come cartella web, più plugin nativi per riproduzione in sottofondo, notifica multimediale e file offline | Riusa tutto il codice; la WebView di Android ha WebRTC e Web Audio, quindi Jam, EQ e dissolvenza funzionano | **TWA** (Play Store sopra la PWA): è legata a **un** dominio, ma ogni utente ha il suo server, spesso su Tailscale. **App nativa Kotlin**: si riscrive tutto e si perdono EQ, dissolvenza e trasmissione Jam |
| **PC** | Prima la **PWA installabile** (Chrome/Edge: "Installa Armony"), che c'è già; poi **Electron**, se servono vassoio di sistema, avvio automatico o una cartella offline su disco | La PWA su PC è già un'app con tasti multimediali (Media Session). Electron porta lo stesso Chromium: tutto funziona uguale | **Tauri**: su Linux usa WebKitGTK, dove WebRTC e parti di Web Audio sono incomplete, e la Jam ne soffrirebbe |
| **iPhone** | Resta la PWA | Fuori dalla richiesta; un'app iOS richiede un account sviluppatore e un Mac | — |

### 3.2 Cosa serve davvero nell'app Android

1. **Riproduzione in sottofondo affidabile**: servizio in primo piano con
   notifica e controlli (schermata di blocco, cuffie, Android Auto in futuro).
   È il punto che giustifica l'app: il resto la PWA lo fa già.
2. **Offline su file**: brani salvati nel filesystem dell'app invece che in
   IndexedDB, senza il limite di spazio del browser.
3. **Rete in chiaro verso la LAN**: molti server sono `http://192.168.x.x`.
   Serve una `network_security_config` che lo permetta (con HTTPS raccomandato
   come oggi).
4. **Condividi con Armony**: un link YouTube condiviso da un'altra app finisce
   nei download.
5. **Caricamento in sottofondo** dalla galleria musicale del telefono.

### 3.3 Cosa cambia nel codice

- Uno strato sottile `Platform` nel client (web, android, desktop) per le
  poche cose che differiscono: dove salvare i file offline, come controllare la
  riproduzione in sottofondo, come aprire i link. Il resto del client non sa
  dove gira.
- Una cartella `app/android/` (progetto Capacitor) e poi `app/desktop/`, che
  **copiano** `client/` al momento del build: nessuna modifica al modo in cui
  il server serve il client.
- `sw.js` e `manifest.json` valgono solo per il web.

### 3.4 Distribuzione e aggiornamenti delle app

- Una GitHub Action, a ogni tag `vX.Y.Z`, costruisce l'APK Android (e poi
  gli installer PC) e li allega alla **Release** GitHub dello stesso tag.
- L'app controlla le release GitHub come fa già il server con i tag, e
  propone l'aggiornamento.
- Play Store solo in un secondo momento: richiede account, revisione e una
  politica sui contenuti scaricati da YouTube che oggi l'app non passerebbe.

## 3b. Grafica e movimento

Analisi fatta il 2026-10-08 su schermate reali (libreria di 551 brani, desktop
scuro e telefono chiaro, con un brano in riproduzione).

### Cosa tenere

Armony ha già un'identità che non sembra un modello: **il disco in vinile**
(logo, lettore, schermata "In riproduzione" con il visualizzatore circolare),
blu notte e ambra, titoli in Bricolage Grotesque 800, testo in Figtree. Il
lavoro grafico parte da qui, non la sostituisce.

| Token | Chiaro | Scuro | Ruolo |
|---|---|---|---|
| `--bg` | `#eef0f6` | `#1b1e36` | fondo, "la stanza" |
| `--surface` | `#ffffff` | `#252946` | pannelli |
| `--ink` | `#1d2140` | `#ece8dd` | testo |
| `--accent` | `#c9750f` | `#f2a541` | ambra: azione primaria, cose che suonano |
| `--sage` | `#2f7a64` | `#7fb7a4` | conferme, "salvato", "aggiornato" |

### L'unica cosa memorabile: la luce del disco

Oggi la schermata "In riproduzione" è blu notte con qualunque copertina. Il
gesto distintivo proposto è uno solo: **la copertina accende la stanza**.

- Dai pixel della copertina si estraggono due colori (dominante e secondario),
  nel client, con un canvas da 32×32. Niente librerie, niente server.
- In "In riproduzione" lo sfondo diventa una luce morbida di quei colori dietro
  al disco, come una lampada colorata in una stanza buia. Il blu notte resta il
  fondo, e il colore è luce sopra di esso, non una tinta piena.
- Nel lettore in basso resta solo una traccia di quel colore, sulla barra di
  avanzamento.
- Al cambio di brano la luce **sfuma** al colore nuovo in circa 1,2 s, la
  durata di un cambio di disco.
- Contrasto garantito: se il colore estratto non regge il testo (WCAG AA),
  si scurisce o si schiarisce finché lo regge. L'ambra resta il colore delle
  azioni, che non si confondono con la luce.

Tutto il resto dell'interfaccia resta quieto: è lì che si spende il coraggio,
e solo lì.

### Movimento: risponde a un gesto, non decora

Un sistema piccolo, in variabili CSS:

| Token | Valore | Uso |
|---|---|---|
| `--t-tap` | 120 ms, `ease-out` | stato premuto, interruttori |
| `--t-move` | 240 ms, `cubic-bezier(.2,.8,.2,1)` | pannelli, fogli, elementi che si spostano |
| `--t-scene` | 420 ms, stessa curva | cambio di pagina, apertura di "In riproduzione" |

Dove serve davvero:

1. **Dal lettore a "In riproduzione"**: la copertina piccola del lettore si
   espande nel disco grande, con la *View Transitions API* (Chrome, Edge,
   WebView di Android, Safari 18). È il momento orchestrato dell'app; dove
   l'API non c'è, si cambia pagina come oggi.
2. **Il disco come un giradischi**: al play accelera fino a 33 giri in circa
   0,6 s, alla pausa rallenta e si ferma; oggi parte e si ferma di colpo.
3. **Cambio di pagina**: dissolvenza breve del contenuto (`--t-scene`); barra
   laterale e lettore fermi, perché sono l'arredamento della stanza.
4. **Conferme**: il cuore del preferito fa un piccolo battito; "Aggiunto alla
   coda" vola verso l'icona della coda; il pulsante play/pausa trasforma la
   forma invece di scambiare icona.
5. **Caricamento**: sagome della pagina che arriva (copertine, righe) al posto
   della scritta "Caricamento…".

Cosa **non** fare: animare l'ingresso di ogni sezione, effetti al passaggio
del mouse su ogni scheda, parallasse. Solo `transform` e `opacity`, per
restare fluidi sui telefoni economici. Con `prefers-reduced-motion` restano
solo le dissolvenze; il CSS lo rispetta già in parte, va esteso a tutto.

### Sezione per sezione

| Sezione | Cosa si vede oggi | Proposta |
|---|---|---|
| **Telefono, navigazione** | 12 icone in alto da scorrere, senza indizio che continuino | Barra in basso con 4 voci (Home, Cerca, Libreria, Jam) più "Altro", attaccata al lettore. È lo schema che il pollice si aspetta, ed è quello che servirà all'app Android |
| **In riproduzione** | Fondo fisso; senza testo metà schermo vuota dentro un riquadro tratteggiato | La luce del disco; su schermi larghi, senza testo, il disco si centra e "Prossimi" prende il posto del testo |
| **Home** | Strisce di copertine tagliate a destra senza frecce su desktop; generi presi dalle categorie di YouTube | Frecce sulle strisce su desktop; generi ripuliti (vedi sotto) |
| **Album, artista** | Intestazione piatta | Intestazione con la luce della copertina (stesso codice della luce del disco) |
| **Libreria** | Righe molto alte e distanti su schermi larghi | Larghezza massima del contenuto; vista a griglia di copertine per gli album |
| **Jam** | Il selettore "Stessa rete / Internet" ha icone enormi e una forma rotta | **Difetto da correggere subito**; poi la Jam aperta con le facce dei partecipanti attorno al disco |
| **Statistiche** | Senza dati: cinque zeri, un grafico piatto e quattro "Ancora nessun dato" | Uno stato vuoto che invita ad ascoltare; con i dati, i numeri grandi in Bricolage come elemento grafico |
| **Barra laterale** | "Server" e "Qualità" sono due menu a tendina pesanti in fondo | Una riga compatta "Casa · 192k" che apre un foglio |
| **Impostazioni** | Un'unica pagina lunga | Gruppi richiudibili; ricerca fra le impostazioni |

**Problema di dati, non di grafica**: i generi "People & Blogs", "Gaming",
"Entertainment" sono le categorie dei video di YouTube, scritte nei file da
yt-dlp durante il download. Vanno lasciate fuori dai metadati dei download
(e i file già scaricati si possono ripulire con uno script).

### Soglia di qualità, senza annunciarla

- Contrasto AA in entrambi i temi, compresa la luce del disco.
- Focus da tastiera visibile ovunque (c'è già `:focus-visible`).
- Area di tocco di almeno 44×44 px sul telefono.
- Collaudo come chiede `.claude/CLAUDE.md` §6: schermate degli stati (a
  riposo, con dati, vuoto, errore) nei due temi, a larghezza telefono e
  desktop; correzioni in un lotto solo, poi uno sguardo finale.

## 4. Ordine proposto

| Passo | Contenuto | Sblocca |
|---|---|---|
| **A** | Fondamenta: accesso unico con ruoli (§2.1), token + sale (§2.2), indirizzo del server esplicito (§2.3), livello di API (§2.4), SQLite e coda download persistente (§2.5) | App native e federazione |
| **B** | Statistiche e preferenze sul server, per utente | Esperienza uguale su tutti i dispositivi |
| **G** | Grafica e movimento (§3b): prima il difetto della Jam e i generi di YouTube, poi la luce del disco, la barra in basso su telefono, il movimento | L'app Android nasce già curata |
| **C** | App Android (Capacitor) con riproduzione in sottofondo e offline su file; APK nelle release GitHub | Android |
| **D** | Federazione fase 1 (`docs/FEDERAZIONE.md`) | Librerie collegate |
| **E** | Federazione fase 2, app PC (Electron) se la PWA non basta | — |
| **F** | Federazione fase 3 (ascolto a distanza) | — |

C e D sono indipendenti dopo A: l'ordine fra loro dipende da cosa serve prima.

## 4b. Stato del passo A (2026-10-08)

| Punto | Stato |
|---|---|
| §2.1 accesso unico con ruoli | Fatto: `/api/login`, sessioni in SQLite, permessi per utente, pannello Utenti |
| §2.2 token + sale | Fatto: il client non conserva più la password; migrazione automatica dei dispositivi esistenti |
| §2.3 indirizzo del server esplicito | Fatto: `NATIVE` nel client, inviti Jam e scoperta LAN non usano `location.origin` nell'app |
| §2.4 livello di API | Fatto: `/api/info` pubblica con `api` e `caps` |
| §2.5 SQLite e coda download persistente | Fatto. **Da fare**: misurare il limite dei 48 thread di waitress con un test di carico |

**0.21.0 (2026-10-10)**: utenti creati dall'amministratore con link e QR di benvenuto (la password la sceglie l'amico),
permessi per utente applicati dal proxy, playlist visibili solo al proprietario, schermata di accesso; correzioni dal
registro eventi (codice 40 di Navidrome occupato, saturazione dei thread).

**0.20.0 (2026-10-10)**: canale inverso per i server dietro NAT (rete a maglia o a stella), abbonamenti alle
playlist pubbliche dei server collegati, mix del giorno, cache di Navidrome più grande.

**0.19.0 (2026-10-10)**: importazioni ricordate dal server e playlist riconciliate; cache dei brani e service
worker «prima la cache», gzip; stato del server e registro eventi; ascolti contati dal server; menu col tasto destro;
federazione con verso dei collegamenti, epoca del catalogo e aggiornamenti in parallelo. Piano e analisi in `docs/PIANO.md`.

**0.18.1–0.18.2 (2026-10-10)**: ripristino del dispositivo; QR con la fotocamera; nomi dei
dispositivi distinti; impostazioni in schede (Questo dispositivo / Server); impostazioni del server
solo con chiave o da casa.

**0.18.0 (2026-10-10)**: dispositivi con chiave (attesa, abbinamento, revoca immediata, registro);
playlist completate dal server, barra di avanzamento e libreria in tempo reale; YouTube con PO Token e
ritmo; Radio sezione a sé, barra in basso personalizzabile, tasti del lettore nuovi; widget Android;
DNS di riserva nell'app; dispositivi gemellati con indirizzi diversi.

**0.17.0 (2026-10-09)**: Jam Radio, stazioni a orario sul server a cui ci si
sintonizza, anche dai server collegati. 0.16.3: indirizzo pubblico del server.

**0.16.1–0.16.2 (2026-10-09)**: informazioni dell'artista nell'intestazione;
link fisso e QR dell'ultima app Android dal server (`/app.apk`); Casuale che
accoda tutta la playlist; README e installazione da zero verificata.

**0.16.0 (2026-10-09)**: federazione fase "mappa" (server collegati, ricerca
"Nella rete" anche fra amici degli amici, ascolto tramite il proprio server,
copia in `federati/`, pagina Rete); presenza e attività dal vivo; playlist
senza doppioni; Spazio conta i brani; informazioni dell'artista a destra.

**0.15.0 (2026-10-09)**: app Android anche senza server (musica del telefono,
playlist e statistiche locali, copia automatica sul server). 0.14.1–0.14.2:
cuffie (pausa allo stacco), Risincronizza, Spazio, coda dei download
raggruppata, tasto indietro, dispositivi agganciati con la stessa coda.

**0.14.0 (2026-10-09)**: riaggancio automatico fra dispositivi (battito, ping,
niente musica mandata a un'app chiusa male); sul telefono barra sopra tasti e
gesti, lettore che si riduce e sparisce con la tastiera, nome delle cuffie;
discografia completa dell'artista da Deezer; equalizzatore automatico e
protezione dai gracchi.

**0.13.0 (2026-10-09)**: nuova disposizione in stile Spotify (Home con accesso
rapido e mix, Cerca con riquadri e ricerche recenti, libreria a schede,
intestazioni con il colore della copertina, playlist nella barra laterale),
un solo carattere, interruttori e dialoghi animati, playlist in tempo reale.

**0.12.0 (2026-10-09)**: modifica delle informazioni dei brani e degli album,
copertine da Deezer o caricate.

**0.11.0 (2026-10-08)**: gli amici si creano un account dall'app (su invito,
o registrazione aperta); Jam tramite il server con orologio comune.

**0.10.0 (2026-10-08)**: album completi (tracce mancanti da Deezer, scaricabili);
scelta del video con un punteggio invece del filtro rigido sulla durata;
telefono telecomando nella notifica, sempre collegato in sottofondo.

**0.9.0 (2026-10-08)**: importazione da Spotify con metadati completi e
cartelle per album (più `deploy/riallinea-spotify.py` per la libreria esistente);
eliminazione dei brani con permesso; casuale e ripeti fra i dispositivi.

**0.8.0 (2026-10-08)**: barra a onde morbide; riproduzione condivisa fra i
dispositivi dell'utente (un solo dispositivo suona, gli altri lo comandano,
"Dove suona" per spostarla, dispositivi sganciati).

**0.7.0 (2026-10-08)**: abbellimento generale a token (tavolozza, caratteri,
pulsanti, lettore, telefono) con le skill di design; l'app Android si aggiorna
da sola (scarica, verifica lo sha256, conferma di Android).

**Passo C fatto (2026-10-08)**: app Android con Capacitor (`app/`), plugin di
riproduzione in sottofondo nostro, icona e avvio di Armony, APK firmato dalla
GitHub Action a ogni tag, aggiornamenti dell'app dalle release. Da collaudare
sul telefono: questa macchina non può far girare un emulatore. Rimandati:
offline su file invece che IndexedDB, "Condividi con Armony", caricamento in
sottofondo.

**Passo G fatto (2026-10-08)**, con cinque agenti in parallelo: selettore
della Jam e generi di YouTube (più `deploy/pulisci-generi.py`), luce del disco,
barra in basso su telefono, sistema di movimento (con la correzione della
corsa nel router), sezioni home/libreria/statistiche/impostazioni, ambra AA
per i testi nel tema chiaro. Restano aperti: applicare la pulizia dei generi
alla libreria vera; il volo "aggiunto alla coda" dal menu ⋯ su telefono; il
disco che continua a girare se "riduci movimento" si attiva durante un brano.

**Passo B fatto (2026-10-08)**: storico d'ascolto e preferenze per utente sul
server (`/api/history`, `/api/prefs`), sincronizzati in entrambe le direzioni;
interruttore in Impostazioni → Profilo.

## 5. Decisioni prese (2026-10-08)

| Domanda | Risposta |
|---|---|
| Ordine | A fondamenta → B statistiche e preferenze sul server → C app Android → D federazione fase 1 → E, F |
| Grafica (aggiunta il 2026-10-08) | Passo G fra B e C: l'app Android impacchetta il client già rifinito |
| Caricamento e download | Aperti a tutti gli utenti, disattivabili per utente dall'amministratore. Aggiornamenti e federazione solo agli amministratori |
| Android | APK costruito a ogni tag e allegato alla release GitHub; niente Play Store per ora |
| PC | PWA installabile da subito; Electron solo se serve qualcosa che la PWA non dà |

Verificato: Navidrome 0.64.2 **non** offre l'estensione OpenSubsonic delle
chiavi API (`getOpenSubsonicExtensions`), quindi §2.2 si fa con token + sale.
