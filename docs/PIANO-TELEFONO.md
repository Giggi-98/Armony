# Piano: il telefono come server portatile

Obiettivo: l'app Android funziona da sola, senza nessun server: scarica, organizza, suona, fa la Jam
con chi è vicino e può servire la musica ad altri dispositivi. Il server di casa diventa
un'**alternativa** (una libreria più grande, sempre accesa) e la **copia di sicurezza** dei brani,
delle playlist e degli ascolti del telefono.

Scritto il 2026-10-11, prima di qualsiasi riga di codice. Nessuna delle scelte qui sotto è ancora
in `DECISIONS.md`: ci entrano quando si fa la fase che le contiene.

---

## 1. Da dove si parte

Molto c'è già (0.15.0, voce «App senza server» del 2026-10-09 in `DECISIONS.md`):

| C'è | Dove |
|---|---|
| «Questo telefono» come server finto: risponde alle chiamate Subsonic delle viste da MediaStore e dai brani offline | `client/telefono.js` (`Local.api`) |
| Lettura di MediaStore, audio e copertine serviti a `/_armony_/` con le Range | `ArmonyLibraryPlugin.java` |
| Preferiti, playlist e ascolti del telefono | IndexedDB, magazzino `telefono` |
| Copia sul server dei brani che mancano, a pezzi, e delle playlist (solo aggiungendo) | `Local.backup`, `/api/upload` |
| Riproduzione in sottofondo, notifica, cuffie, widget | `ArmonyMedia*`, `ArmonyWidget` |
| Brani offline dai server | `armony.js`, parte 2 |
| Aggiornamento dell'APK da GitHub | `ArmonyUpdatePlugin.java` |

Cosa manca perché il telefono basti a sé stesso:

1. **Procurarsi musica nuova**: oggi i download (yt-dlp, «Scegli un'altra versione», Deezer per i
   metadati) li fa solo il server.
2. **Sistemare la musica**: modificare i tag, trovare testi e copertine, i controlli della salute.
3. **Playlist intelligenti, statistiche complete, «Va bene così»**: oggi vivono su Navidrome o nel
   server Armony.
4. **Jam e «Dove suona» senza server**: la segnalazione cifrata della Jam e il canale dal vivo
   passano dal server.
5. **Servire gli altri**: un PC o un altro telefono non possono collegarsi al telefono.
6. **Copia nei due versi**: oggi il backup aggiunge e basta. Una playlist modificata sul server non
   torna sul telefono, gli ascolti del telefono non arrivano al server.

---

## 2. Le tre scelte che reggono tutto

### 2.1 L'indice della libreria scende nel codice nativo

**Proposta:** l'indice (brani, album, artisti, playlist, preferiti, ascolti) passa da IndexedDB a un
SQLite gestito da Java. `Local.api` diventa una chiamata al plugin: `ArmonyLibrary.api(method, q)`.
Lo stesso codice Java risponde sia alla WebView sia al server HTTP della fase 5.

**Perché:** un server portatile deve rispondere anche con lo schermo spento e la WebView chiusa, e
un indice in JS non si può servire ad altri. La voce del 2026-10-09 lo prevedeva già («Da rivedere
se: le librerie sul telefono diventano molto grandi, allora indice e ricerca nativi»).

**Alternativa scartata:** tenere l'indice in JS e aggiungere un secondo indice nativo solo per il
server. Sarebbero due codici da tenere uguali.

**Costo:** è la fase più lunga e non si vede. Si fa per prima perché tutto il resto ci si appoggia.

### 2.2 Il telefono dichiara le sue capacità come un server qualunque

Il client nasconde già le funzioni che un server non ha (`me.caps`, `CAPS` in `app.py`). Il server
del telefono risponde a `/api/health` e `/api/me` con le sue capacità, e il client fa il resto da
solo. Niente `if (srv().local)` sparsi nelle viste. Quelli che ci sono oggi si tolgono man mano che
una funzione arriva sul telefono.

Capacità che il telefono potrà avere, fase per fase: `download`, `scelta`, `tag`, `testi`,
`intelligenti`, `salute`, `jam`, `live`. Non avrà `federazione`, `trasferimento`, `utenti` (un
telefono ha un solo proprietario) né la transcodifica di Navidrome.

### 2.3 Chi comanda: il telefono, e il server è una copia

Tre modi, scelti al primo avvio e cambiabili in Impostazioni → Server musicali:

| Modo | La libreria che vedi | Il server |
|---|---|---|
| **Solo telefono** | quella del telefono | nessuno |
| **Telefono, con copia sul server** | quella del telefono | riceve brani, playlist, preferiti e ascolti; ci si può ascoltare anche ciò che sul telefono non c'è |
| **Server** (come oggi) | quella del server | è la fonte; il telefono tiene solo i brani offline |

Nel modo con copia, il telefono vince sempre sui **suoi** dati, con una sola eccezione: una
playlist modificata sul server dopo l'ultima copia non si sovrascrive, si chiede (§3, fase 6).

---

## 3. Le fasi

Ogni fase si rilascia da sola e si collauda **sul telefono** (qui non c'è un emulatore). Ognuna dice
come si verifica.

### Fase 1 — Indice nativo (nessuna novità visibile)

- `ArmonyLibraryPlugin.java`: SQLite (`armony-telefono.db`) con brani da MediaStore, playlist,
  preferiti, ascolti. Ricerca con FTS5 (titolo, artista, album, senza accenti).
- `api(method, q)` risponde ai metodi che oggi gestisce `Local.api`: `getAlbumList2`, `search3`,
  `getAlbum`, `getArtist`, `getPlaylists`, `star`, `scrobble`… con le stesse risposte JSON.
- Migrazione: al primo avvio i dati di IndexedDB (`telefono`) passano nel DB nativo. IndexedDB si
  svuota solo dopo che la migrazione ha avuto successo.
- I brani offline dei server restano nel client, che li ha già.

**Verifica:** su una libreria vera di almeno 2000 brani, le stesse viste di prima e le stesse
risposte di `Local.api` (si confrontano le due versioni con un interruttore di prova). Avvio a
freddo e prima ricerca più veloci di adesso.

### Fase 2 — Scaricare dal telefono

La parte più delicata. Due strade:

| | Pro | Contro |
|---|---|---|
| **A. NewPipeExtractor** (Java, la libreria di NewPipe) + jaudiotagger per i tag | leggera (qualche MB), niente Python, scarica direttamente m4a/opus senza convertire | si aggiorna con l'app; un cambio di YouTube rompe i download finché non esce un APK nuovo |
| **B. youtubedl-android** (Python + yt-dlp + ffmpeg dentro l'app) | lo stesso yt-dlp del server, si aggiorna da solo senza APK nuovo | +40–60 MB nell'APK, avvio lento del primo download, più batteria |

**Proposta: A**, con il server come riserva: nel modo con copia, se il download sul telefono fallisce,
si chiede al server di scaricarlo e poi lo si tiene offline. L'aggiornamento dell'APK da GitHub c'è
già, quindi un NewPipeExtractor nuovo arriva con un rilascio.

- I brani finiscono in `Music/Armony/` attraverso MediaStore, così li vedono anche le altre app e
  restano se si disinstalla Armony.
- Metadati da Deezer chiamato dal telefono (la stessa logica di `server/metadati.py`, portata in Java
  o fatta dal client), copertina incorporata nel file.
- «Scegli un'altra versione» usa la stessa ricerca di NewPipeExtractor.
- Coda dei download nel servizio in primo piano già esistente (`ArmonyMediaService`), che continua a
  schermo spento.

**Verifica:** 20 brani da una playlist di YouTube Music con il Wi-Fi spento (solo dati mobili):
tag, copertina, durata giusta, visibili in un'altra app musicale. Download interrotto togliendo la
rete, poi ripreso.

### Fase 3 — Sistemare la musica sul telefono

- **Modifica dei tag**: jaudiotagger sui file di Armony. Per un file di un'altra app Android chiede
  il permesso con `MediaStore.createWriteRequest`: una finestra di sistema per brano o per gruppo.
- **Testi**: LRCLIB chiamato dal telefono, `.lrc` salvato accanto al brano (come fa il server).
- **Salute della libreria**: i controlli di `server/libreria.py` che si basano solo su regole (durata,
  troncato, qualità, tag, titolo sporco, numero di traccia doppio) girano sull'indice nativo. La
  durata attesa da Deezer solo sui brani nuovi, come sul server.
- **Playlist intelligenti**: le regole hanno lo stesso formato di Navidrome, così si copiano sul
  server senza conversioni. Le valuta il DB nativo con SQL.

**Verifica:** un brano con «(Official Video)» nel titolo: «Sistema» lo pulisce e il nome si vede
subito anche in un'altra app. Playlist intelligente «Anni '80» uguale sul telefono e, dopo la copia,
sul server.

### Fase 4 — Jam e «Dove suona» senza server

- La segnalazione della Jam oggi passa dal server, che inoltra solo blob cifrati. Il telefono che
  apre la Jam fa da inoltro allo stesso modo, sul suo server HTTP (fase 5) e sulla rete locale o sul
  suo hotspot. Gli altri lo trovano con NSD (mDNS di Android) o con il QR del link.
- **Il segreto resta nel frammento `#`** e non arriva al telefono che inoltra, esattamente come
  oggi con il server. `jam.js` non cambia: cambia solo l'indirizzo della segnalazione. Prima di
  scrivere questa parte va ricontrollato il ramo senza HTTPS (`SUBTLE`): sulla rete locale il
  telefono risponde in HTTP, quindi la Jam funziona solo se la pagina dell'ospite è in contesto
  sicuro (l'app Android lo è; un browser su `http://192.168…` no). **Da decidere con l'utente** prima
  della fase: certificato autofirmato con impronta nel QR, oppure Jam locale solo fra app.
- Su internet, senza nessun server, la Jam non si può fare (qualcuno deve inoltrare i messaggi):
  si usa un server Armony qualsiasi di cui si ha l'accesso, come oggi.

**Verifica:** due telefoni sull'hotspot del primo, senza internet: Jam aperta, codice di sicurezza
uguale, musica in sincrono.

### Fase 5 — Il telefono serve gli altri

- Un piccolo server HTTP nel servizio in primo piano (NanoHTTPD, una sola dipendenza Gradle), acceso
  da un interruttore: «Fai ascoltare questo telefono agli altri dispositivi».
- Risponde a `/rest/*` (Subsonic, con la stessa API della fase 1) e alle rotte Armony che servono al
  client: `/api/health`, `/api/me`, `/api/login`, la segnalazione della Jam. Così un PC apre
  `http://<telefono>:8080` e trova l'app intera, servita dal telefono stesso.
- Accesso: un codice a 6 cifre mostrato sul telefono, oppure il QR. Ogni dispositivo nuovo va
  approvato dal telefono (come «Dispositivi e sicurezza» sul server).
- Solo rete locale e hotspot. Esporlo su internet non fa parte di questo piano.

**Verifica:** PC sullo stesso Wi-Fi: libreria del telefono nel browser, ascolto con la barra che
salta (Range), telefono a schermo spento per 30 minuti senza che il servizio muoia.

### Fase 6 — Il server come copia, nei due versi

- **Brani**: come oggi (si caricano quelli che mancano) più il verso opposto, facoltativo: i brani
  del server segnati «tieni anche sul telefono» si scaricano quando c'è Wi-Fi.
- **Playlist**: ognuna ha un registro delle modifiche (aggiunto, tolto, spostato, con l'ora). Alla
  copia si applicano le modifiche dei due lati; se lo stesso brano è stato toccato da entrambe le
  parti si chiede. Questo toglie la conseguenza oggi accettata nella voce del 2026-10-09 («una
  playlist da cui togli un brano sul telefono lo tiene sul server»).
- **Preferiti e ascolti**: gli ascolti fatti offline si mandano a Navidrome con `scrobble` e l'ora
  vera (`time`), così le statistiche del server sono complete.
- **Ripristino**: telefono nuovo o perso → «Prendi tutto dal server» rimette brani, playlist,
  preferiti e impostazioni sincronizzate.

**Verifica:** stessa playlist modificata sui due lati senza rete, poi riconnessione: nessun brano
perso, la domanda compare solo per il brano toccato da entrambi.

---

## 4. Cosa non si fa

- **Federazione dal telefono.** Un telefono si spegne, cambia rete, non ha un indirizzo stabile. La
  federazione resta fra server; il telefono ci entra attraverso il server di casa.
- **Un server Python sul telefono** (Termux, Chaquopy con `app.py`): sarebbe lo stesso codice, ma
  pesante, lento ad avviarsi e fragile con le restrizioni di Android sui processi in sottofondo.
- **Transcodifica.** Il telefono serve i file così come sono.
- **iOS.** Fuori da questo piano.

---

## 5. Rischi

| Rischio | Cosa si fa |
|---|---|
| YouTube cambia e i download sul telefono si rompono | riserva sul server (fase 2); rilascio rapido con NewPipeExtractor aggiornato |
| Android uccide il servizio in sottofondo (soprattutto Xiaomi, Huawei, Samsung) | servizio in primo piano con notifica; spiegazione su come escludere Armony dall'ottimizzazione della batteria |
| Scoped storage: file di altre app non modificabili | permesso esplicito per gruppo di brani (fase 3); i download di Armony sono sempre suoi |
| Due copie della logica (Python sul server, Java sul telefono) per salute, metadati, regole | si porta solo ciò che serve offline; i dati restano nello stesso formato (regole di Navidrome, `.lrc`, tag) così le due parti si capiscono |
| Jam locale senza HTTPS | decisione da prendere prima della fase 4 (§3) |

---

## 6. Ordine e dimensioni

| Fase | Contenuto | Dimensione indicativa | Dipende da |
|---|---|---|---|
| 1 | Indice nativo | grande | — |
| 2 | Download dal telefono | grande | 1 |
| 3 | Tag, testi, salute, intelligenti | media | 1 |
| 6 | Copia nei due versi | media | 1 |
| 5 | Il telefono serve gli altri | media | 1 |
| 4 | Jam senza server | piccola, dopo la decisione su HTTPS | 5 |

La 6 viene prima della 5 perché «il server come copia» è la metà della richiesta, e serve a chi
usa già il telefono senza server. Se interessa di più il «server portatile» si scambiano: non
dipendono l'una dall'altra.
