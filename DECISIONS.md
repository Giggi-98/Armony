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

## 2026-10-10 — Importazioni ricordate dal server e riconciliate a ogni giro; riconoscimento sul DB di Navidrome

**Contesto:** dopo l'importazione le playlist restavano quasi vuote (GgHerz 10 brani su 940, GGroove 8 su 494) con 700 brani già in libreria: i lavori nati prima di `plserver`, o importati da un altro dispositivo, non sapevano in che playlist andare, e il telefono che li ricordava doveva restare aperto. Il riconoscimento dal telefono faceva 900 `search3` in sequenza in 5G.
**Scelta:** `server/importa.py`. Il client legge il file e crea la playlist (così è dell'utente), il server riconosce i brani leggendo il DB di Navidrome (ISRC, poi titolo normalizzato Unicode con e senza parentesi + artista; la durata sceglie fra più candidati, non esclude), ricorda l'elenco in `imports` (migrazione 8) e a ogni giro riscrive la playlist nell'ordine del file se è cambiata, con i brani aggiunti a mano in fondo. Lo stato (in libreria, in download, non trovati) si mostra nella pagina della playlist. Ribalta l'alternativa scartata «abbinamento per titolo/artista/durata (può sbagliare, richiede il client)» della voce *Playlist dei brani importati completate dal server* (2026-10-10): ora lo fa il server, e il percorso del file resta la prima prova per i brani scaricati da lì.
**Alternative scartate:** continuare con `pids` sui lavori (non copre i brani già in libreria né le importazioni vecchie); far creare la playlist all'amministratore di Navidrome (sarebbe sua, non dell'utente); solo aggiungere in fondo senza riordinare (l'ordine di Spotify si perde); togliere i brani che non sono nel file (si perderebbero quelli aggiunti a mano).
**Conseguenze:** una playlist importata non può tenere doppioni voluti; un brano con titolo diverso in libreria (traduzione, altro nome) resta «da scaricare»; la riscrittura usa `createPlaylist` con `playlistId` come amministratore. Le funzioni del client per i server senza `importsrv` (`matchTrack`, `pending`) restano per i server vecchi.
**Da rivedere se:** Navidrome offre playlist «intelligenti» aggiornabili dall'esterno, o le librerie superano le decine di migliaia di brani (allora un indice persistente invece di uno rifatto a ogni scansione).

## 2026-10-10 — Registro eventi e stato del server dentro Armony

**Contesto:** per riparare un guasto bisognava leggere i log del container (illeggibili per l'avanzamento di yt-dlp) e gli errori dei telefoni non si vedevano. Nessuna misura del carico, con 96 thread di waitress tenuti da dispositivi e flussi.
**Scelta:** `server/diagnosi.py`: tabella `log` (migrazione 8) con i ripetuti sommati in una riga, alimentata dalle eccezioni non gestite (rotte, thread, `logging` di waitress), dalle ambiguità che il codice risolve da solo e dagli errori dei client (`client/diagnosi.js`: `onerror`, promesse, `console.error`, audio, rete), mandati a lotti. Stato: campioni da `/proc` ogni 5 s (ultima ora) e al minuto (24 ore) in memoria, richieste e flussi audio contati con `before_request`/`teardown_request`. Due schede per l'amministratore; «Spazio del server» confluisce in «Stato del server».
**Alternative scartate:** Prometheus/Grafana o Netdata (un servizio in più da installare per un server fra amici); leggere i log di Docker dall'app (servirebbe il socket di Docker nel container); salvare i campioni su disco (bastano le ultime 24 ore).
**Conseguenze:** CPU e memoria sono quelle di tutta la macchina (con la rete host è giusto così), la CPU di Navidrome non si separa; lo storico dello stato si perde al riavvio.
**Da rivedere se:** servono avvisi fuori dall'app (notifiche, email) o storico di settimane.

## 2026-10-10 — Cache dei brani sul dispositivo, service worker «prima la cache», gzip

**Contesto:** in 5G l'app impiegava secondi ad aprirsi (shell da 570 kB «prima la rete», nessuna compressione) e ogni brano ripartiva dalla rete anche se appena ascoltato.
**Scelta:** i prossimi brani della coda (2 col Wi-Fi, 1 in rete mobile) si scaricano interi in IndexedDB (`acache`, `ACache`) 6 s dopo il cambio di brano; un brano in cache si suona da un blob. Limite per dispositivo (`cacheMB`, 1 GB), via i meno recenti. Service worker: risposta dalla cache e controllo in sottofondo con ETag, sostituzione di tutti i file insieme. Il server comprime con gzip JSON (anche quello di Navidrome dal proxy) e file del client; il brano ripreso all'avvio carica solo i metadati.
**Alternative scartate:** Cache Storage per l'audio (solo con HTTPS: in casa molti aprono Armony in http); salvare anche il brano in corso (doppio traffico: l'elemento audio non espone i byte); MediaSource per suonare mentre si scarica in cache (complessità e formati); service worker che aggiorna file per file (si mescolerebbero versioni diverse).
**Conseguenze:** in rete mobile si scarica un brano in anticipo che si può saltare; la versione nuova del client si vede alla seconda apertura.
**Da rivedere se:** la riproduzione diventa nativa nell'app Android (allora la cache va lì).

## 2026-10-10 — Federazione: verso dei collegamenti, epoca del catalogo, aggiornamenti in parallelo

**Contesto:** analisi della federazione: un nodo che perde il DB non veniva riscaricato da capo, un errore a metà dell'aggiornamento lasciava una transazione aperta, nodi spenti fermavano il giro per un minuto ciascuno, strutture in memoria senza limite, indirizzi interni accettati da `/pair`, nessun modo di condividere in un verso solo.
**Scelta:** epoca casuale del catalogo (reset se cambia); `_store` con rollback; aggiornamenti in parallelo con attesa crescente fino a 6 ore; pulizia di `rate`, `pair_failed`, inviti scaduti; rifiuto di loopback e link-local; `caps` in `/fed/hello` per crescere senza alzare `PROTO`; colonna `fed_nodes.dir` (migrazione 8): `entrambi`, `offro` (non chiedo niente a lui), `ricevo` (lui non vede la mia libreria, 403 `verso`).
**Alternative scartate:** alzare `PROTO` (chiude tutti i collegamenti esistenti); il verso deciso solo da chi invita (il verso è una scelta di ciascuno sulla propria libreria).
**Conseguenze:** un server dietro NAT continua a non essere raggiungibile dagli altri: con «ricevo» il collegamento è almeno coerente. Il canale inverso verso un server pubblico (topologia a stella) resta da fare: tocca la scelta «relay propri scartati» di *Federazione: forma generale* (2026-10-08) e va deciso con l'utente.
**Da rivedere se:** più server dietro CGNAT vogliono condividere (allora il canale inverso).

## 2026-10-10 — Ascolti contati dal DB di Navidrome; menu col tasto destro

**Contesto:** l'utente vuole il numero di ascolti dei brani (sul server, per utente, e quelli pubblici se esistono) e, sul computer, un menu col tasto destro su ogni voce.
**Scelta:** `server/ascolti.py` legge `annotation` (totali per utente) e `scrobbles` (ogni ascolto con l'istante) di Navidrome, filtrando per nome chi ha spento la condivisione; dall'esterno solo l'indice `rank` di Deezer, dichiarato come indice. Menu contestuale proprio vicino al puntatore, solo con `pointer:fine`, con le azioni del tasto ⋯; Maiusc lascia quello del browser.
**Alternative scartate:** lo storico di Armony (solo i client Armony con la sincronizzazione accesa); stream di Spotify o Last.fm (non pubblici, o con chiave API da registrare); riusare il foglio del telefono come menu (sul computer copre la pagina lontano dal puntatore).
**Conseguenze:** i conteggi seguono gli scrobble: un ascolto conta dopo metà brano o 4 minuti.
**Da rivedere se:** Navidrome cambia lo schema di `scrobbles`, o Deezer smette di dare `rank`.

## 2026-10-10 — Impostazioni del server solo con chiave o da casa; impostazioni in schede

**Contesto:** l'utente non vuole che chi entra possa cambiare le impostazioni del server, e vuole le impostazioni divise fra dispositivo e server, in schede.
**Scelta:** le rotte admin che cambiano qualcosa, e le azioni sui dispositivi altrui, vogliono un dispositivo con chiave o la rete di casa/Tailscale; da internet senza chiave l'amministratore legge ma riceve 403 `impserver` (registrato). Interfaccia: schede nell'indirizzo (`#/impostazioni/<scheda>`), divise fra Questo dispositivo e Server (solo amministratori), colonna a sinistra sul computer, elenco e pagina con ← sul telefono; tutte nella pagina, nascoste, perché la ricerca le attraversi.
**Alternative scartate:** un secondo fattore o una password di conferma (un segreto in più, quando la chiave del dispositivo c'è già); bloccare anche la lettura (all'admin serve vedere lo stato da fuori); la pagina unica di gruppi richiudibili.
**Da rivedere se:** i client senza chiave spariscono del tutto (modalità "mai" ovunque), e allora basta il controllo della chiave.

## 2026-10-10 — QR con la fotocamera nell'app, jsQR nel repo; ogni dispositivo con un nome suo

**Contesto:** per abbinare un telefono si doveva scrivere a mano il codice; i dispositivi avevano nomi uguali ("Telefono", "Chrome su Linux") e sembravano la stessa entità; importando le impostazioni si copiava anche il nome dell'altro dispositivo.
**Scelta:** `scanQR()` con `getUserMedia` (fotocamera posteriore): `BarcodeDetector` se il browser lo ha, altrimenti jsQR 1.4.0 (Apache 2.0) copiato in `client/vendor/` e caricato solo quando si apre la fotocamera; nell'app basta il permesso CAMERA (la WebView di Capacitor lo chiede da sé). Il QR letto apre la finestra giusta: abbinamento, invito, Jam o indirizzo di un server. Nome di base del dispositivo = tipo/browser, modello se disponibile, ultime 4 lettere del suo identificativo, calcolato una volta; l'importazione non copia le preferenze del singolo dispositivo (`DEVICE_PREFS`).
**Alternative scartate:** un plugin nativo di scansione (codice nativo in più per una cosa che la WebView fa già); jsQR da CDN (niente offline nell'app, dipendenza esterna); jsQR nella shell del service worker (256 kB caricati a ogni avvio per un uso raro).
**Da rivedere se:** `BarcodeDetector` arriva su tutte le WebView (allora jsQR si può togliere).

## 2026-10-10 — Dispositivi con chiave: attesa, abbinamento e revoca immediata

**Contesto:** server esposto su internet (Tailscale Funnel). Le sessioni Armony si potevano revocare, ma `/rest` inoltrava a Navidrome token+sale senza chiedere una sessione: un dispositivo revocato continuava ad ascoltare. `ARMONY_TOKEN` valeva anche da internet; dietro tailscaled tutte le richieste risultavano da 127.0.0.1 (waitress scartava `X-Forwarded-For`), quindi i limiti dei tentativi contavano tutta internet come un solo indirizzo locale.
**Scelta:** chiave ECDSA P-256 generata dal dispositivo (WebCrypto, non esportabile, IndexedDB); sessioni da firma su sfida, 24 ore, rinnovo silenzioso; un dispositivo nuovo con password resta in attesa (eccezioni: primo dispositivo da casa, account appena creato con invito); codice di abbinamento monouso da un dispositivo fidato. `/rest` vuole un gettone HMAC per dispositivo in query (finestre di 12 ore), ricontrollato a ogni richiesta; la revoca chiude sessioni, canale dal vivo e flussi audio subito. Client senza chiave: sempre/da casa e Tailscale/mai, con 14 giorni di transizione dopo l'aggiornamento; le sessioni esistenti diventano dispositivi fidati senza chiave che se la prendono al primo avvio. Funnel riconosciuto da `Tailscale-Funnel-Request`; waitress si fida di `X-Forwarded-For` solo da 127.0.0.1. Migrazione 7, modulo `server/dispositivi.py`, capacità `dispositivi`, `API_LEVEL` invariato. Scelte dell'utente: chiave generata dal dispositivo (non dal server, perché la privata non deve viaggiare), dispositivi nuovi in attesa.
**Alternative scartate:** chiavi generate dal server (la privata passerebbe dalla rete); Ed25519 (WebCrypto lo ha solo da Chrome 137, le WebView vecchie no); cookie per audio e copertine (altre origini, cookie di terze parti bloccati); firma su ogni richiesta (`<img>` e `<audio>` non possono mandarla); JWT senza stato (non si revocano); alzare `API_LEVEL` chiudendo fuori subito le app vecchie.
**Conseguenze:** senza HTTPS niente chiave; un client senza chiave revocato resta fuori solo dove la regola lo esclude, o cambiando la password; con «mai» le app Subsonic di terze parti tramite Armony smettono di funzionare; il primo amministratore deve entrare da casa; sessione e gettone rubati valgono al massimo 24 ore.
**Da rivedere se:** Navidrome offre chiavi API revocabili; WebCrypto Ed25519 è ovunque; si vuole la firma per ogni richiesta (DPoP); si esce da tailscaled (allora va rivisto `trusted_proxy`).

## 2026-10-10 — Dispositivi gemellati: lo stesso server riconosciuto anche con indirizzi diversi

**Contesto:** con il telefono su Tailscale e il PC sull'indirizzo di casa, i brani del telefono arrivavano al PC con un indirizzo di server sconosciuto: niente copertina né testo; il telecomando vedeva solo i prossimi 20 brani e sembrava che la coda fosse corta.
**Scelta:** nel brano viaggia anche l'indirizzo pubblico del server (`pub`); `localize` riconosce il server da quello, e per i propri dispositivi (Live) il brano è comunque del server del canale, salvo la musica del solo telefono. Il telecomando riceve i prossimi 50 e il numero di quelli dopo.
**Alternative scartate:** mandare tutta la coda (troppo per ogni cambio di stato); un identificativo di server nuovo (l'indirizzo pubblico c'è già).
**Da rivedere se:** un utente usa due server Armony diversi con lo stesso indirizzo pubblico.

## 2026-10-10 — Radio sezione a sé, barra in basso scelta dall'utente

**Contesto:** la Radio si raggiungeva dalla pagina Jam; l'utente vuole la Radio separata, Cerca sempre a portata e scegliere la barra in basso.
**Scelta:** Radio è una voce di `NAV` (ribalta «Pagina a sé raggiungibile da Jam» della voce Jam Radio del 2026-10-09). Sul telefono la barra ha 1–4 sezioni scelte dall'utente più "Altro" sempre ultimo, salvate per dispositivo (`store('tabs')`); una voce sconosciuta riporta al predefinito. Ordine con frecce. Lente fissa nell'intestazione del telefono. Icone del lettore piene; i tracciati di play/pausa tengono conto del contorno da 2 px (le barre della pausa si toccavano).
**Alternative scartate:** trascinamento (difficile da rendere accessibile); sincronizzare la barra fra dispositivi (telefoni diversi, usi diversi); Radio fissa nella barra.
**Da rivedere se:** serve la barra anche su tablet sopra gli 860 px.

## 2026-10-10 — App Android: widget della schermata Home dal servizio di riproduzione

**Contesto:** un widget musicale come quelli di One UI.
**Scelta:** `ArmonyWidget` (RemoteViews) legge lo stato di `ArmonyMediaService`, lo ridisegna a ogni `apply()`; i tasti usano gli stessi PendingIntent della notifica. La barra avanza ogni 15 s solo mentre suona e a schermo acceso. Impaginazione scelta dalle misure del launcher. Ad app chiusa "Niente in riproduzione" e ogni tocco apre l'app.
**Alternative scartate:** `updatePeriodMillis`/AlarmManager (sveglie a vuoto); avviare il servizio dal widget ad app chiusa (senza WebView non suona nulla, e da Android 12 il servizio in primo piano non parte dal sottofondo).
**Da rivedere se:** la riproduzione diventa nativa.

## 2026-10-10 — App Android: DNS di riserva con un proxy locale per la WebView

**Contesto:** con il DNS privato di Android il nome del Funnel (`….ts.net`) non si risolve e l'app non raggiunge il server; la WebView usa sempre il risolutore di sistema.
**Scelta:** proxy CONNECT su 127.0.0.1 (porta casuale) dentro l'app, impostato con `ProxyController` e bypass rovesciato: solo l'HTTPS verso i server configurati e GitHub passa da lì. Risolve con il DNS del telefono, poi DoH (Cloudflare, Google) o DoT (Quad9) per IP, con cache sul TTL; il TLS resta da capo a capo. Le richieste native usano lo stesso proxy. Interruttore acceso di serie.
**Alternative scartate:** `shouldInterceptRequest` (non vede i corpi delle POST/PUT); CapacitorHttp (non sceglie il DNS); IP fisso del Funnel (cambia); OkHttp con DoH (porta Kotlin nell'APK); segreto o controllo dell'UID sul proxy (non disponibili senza VPN): la protezione è l'elenco chiuso di host e porte.
**Da rivedere se:** la WebView permette di scegliere il risolutore.

## 2026-10-10 — YouTube dal server: PO Token in un servizio a parte, ritmo e pausa, cookie facoltativi

**Contesto:** durante una grossa importazione YouTube ha risposto «not a bot» a centinaia di richieste in un'ora; il ripiego su SoundCloud falliva spesso per DRM. Senza account YouTube regge circa 300 video l'ora per indirizzo, e yt-dlp ormai vuole un motore JavaScript (EJS).
**Scelta:** `yt-dlp[default,deno]` aggiornati a ogni avvio; servizio `pot` (bgutil-ytdlp-pot-provider, amd64/arm64) solo su localhost, con il suo plugin; un video ogni 12 s fra tutti gli esecutori (4 s con i cookie); al blocco mezz'ora di pausa e brani «in attesa» invece che in errore; cookie di un account secondario caricati dall'amministratore; brani DRM di SoundCloud saltati.
**Alternative scartate:** cookie obbligatori (rischio per l'account); `player_client` fisso (cambia spesso); istanze Invidious/Piped; yt-dlp-getpot-wpc (richiede un browser); riprovare subito dopo un blocco (lo allunga).
**Conseguenze:** un container in più; importazioni grandi più lente (circa 300 brani l'ora senza cookie).
**Da rivedere se:** bgutil smette di essere mantenuto, o YouTube blocca anche a 300 l'ora.

## 2026-10-10 — Playlist dei brani importati completate dal server, abbinando il brano per percorso

**Contesto:** i brani da aggiungere alle playlist dopo un'importazione stavano nel localStorage di chi importava e si aggiungevano solo con la pagina Scarica aperta: a telefono chiuso la playlist restava a 3 brani su 92.
**Scelta:** le playlist (`pids`) stanno nel lavoro; un thread del server le completa come amministratore di Navidrome riconoscendo il brano da `media_file.path` (lo stesso percorso scritto dal lavoro), senza doppioni e solo nelle playlist di chi ha chiesto il download; chiede la scansione al più ogni 2 minuti. Gli avvisi `{"type":"libreria"}` viaggiano su `/api/live`; le pagine mostrano una barra di avanzamento per job. Le tracce mancanti si scaricano con la data dell'album in libreria (Navidrome separa gli album per data).
**Alternative scartate:** abbinamento per titolo/artista/durata (può sbagliare, richiede il client); un canale nuovo per gli avvisi (thread di waitress); il `path` di Subsonic (Navidrome lo inventa).
**Da rivedere se:** Navidrome espone il percorso vero via Subsonic.

## 2026-10-09 — L'app si scarica direttamente da GitHub, non dal server

**Contesto:** con la 0.16.2 il server dava `/app.apk`, un rimando all'ultima APK su GitHub, usato da link e QR. L'utente vuole poter chiudere le porte del server: l'app non deve passare di lì (un gettone per proteggere il link non serve, visto che l'APK è pubblica nelle release).
**Scelta:** ogni release pubblica la stessa APK anche come `armony.apk` (con il suo `.sha256`), così `releases/latest/download/armony.apk` porta sempre all'ultima; link e QR (Impostazioni → App Android, pagina di benvenuto) usano quello, la versione la chiede il client all'API di GitHub. Tolti `/app.apk` e `/api/app` dal server (ribalta la scelta della 0.16.2).
**Alternative scartate:** link del server con un gettone rigenerabile (lo si era iniziato: tiene il server esposto e non protegge un file che è pubblico comunque); solo la pagina delle release (un tocco in più, e sul telefono la pagina di GitHub è scomoda).
**Conseguenze:** serve GitHub raggiungibile per scaricare l'app; l'aggiornamento dall'app può prendere indifferentemente `armony.apk` o `armony-vX.Y.Z.apk`, entrambi con l'impronta.
**Da rivedere se:** il repository diventa privato (allora il link deve tornare a passare dal server).

## 2026-10-09 — Jam Radio: stazione a orario sul server, elenco preparato dal client

**Contesto:** stazioni che girano all'infinito a cui sintonizzarsi, anche dai server collegati, tutti allo stesso punto.
**Scelta:** la stazione è un elenco con le durate più un istante d'inizio (SQLite, migrazione 6); la posizione si calcola dall'ora del server, a fine elenco si rimescola con un seme per giro. L'elenco lo prepara il client con le sue radio. Ascoltatori in memoria, confermati ogni minuto, mandati sul canale `/api/live`; fra server rotte firmate nuove (`proto` invariato) e scarto degli orologi stimato a ogni salto con `/fed/v1/ora`; audio dal proxy della rete. Client allineato con `SrvClock` della Jam: salto oltre 0,5 s, velocità ±5% sotto. Modulo `server/radio.py` come `federazione.py`. Pagina a sé (`#/radio`) raggiungibile da Jam e dalla Home.
**Alternative scartate:** un dispositivo che fa da host (la radio morirebbe con lui); trasmettere l'audio dal server (banda e transcodifica continue); un canale SSE nuovo (un thread di waitress in più per dispositivo); il server che calcola l'elenco (doppione delle radio del client); una sezione dentro la pagina Jam (con una Jam aperta la pagina è della Jam).
**Conseguenze:** gli ascoltatori remoti si aggiornano al più ogni minuto; i brani copiati in `federati/` dentro una stazione non si sentono da un altro server; con le durate di Navidrome arrotondate al secondo un brano può essere tagliato o finire un attimo prima del cambio.
**Da rivedere se:** le stazioni diventano tante o con molti ascoltatori remoti, o si vuole proporre e votare i brani della radio.

## 2026-10-09 — Indirizzo pubblico del server deciso dall'amministratore, non per dispositivo

**Contesto:** link condivisi, inviti, QR dell'app e indirizzo per i server collegati usavano l'"Indirizzo pubblico per i link" di ogni dispositivo, o in mancanza l'indirizzo con cui quel dispositivo raggiunge il server (in casa un nome locale come `gigi.econnet`, irraggiungibile da fuori).
**Scelta:** un indirizzo pubblico per server (`settings.public_url`, valore iniziale da `ARMONY_PUBLIC_URL`), impostato dall'amministratore con `PUT /api/indirizzo` e restituito da `/api/me` e `/api/info` (capacità `indirizzo`). Il client usa, in ordine: il campo del dispositivo, quello del server, l'indirizzo del dispositivo.
**Alternative scartate:** dedurlo dall'intestazione Host delle richieste (cambia a seconda di come entri, e in casa è proprio quello sbagliato); toglierlo dai dispositivi (chi ha due indirizzi pubblici può volerne uno diverso su un dispositivo).
**Conseguenze:** un campo in più da compilare una volta all'installazione; i link già condivisi con l'indirizzo vecchio restano com'erano.
**Da rivedere se:** si vuole un indirizzo diverso per ogni rete (casa, Tailscale, dominio) scelto da solo.

## 2026-10-09 — Federazione, fase "mappa": ricerca fra amici degli amici e ascolto a distanza prima della copia

**Contesto:** l'utente vuole una mappa live delle librerie sue e degli amici: server sempre collegati, ognuno di un proprietario, ricerca dei brani già presenti sui server agganciati, ascolto subito e copia a richiesta.
**Scelta:** ribalta «niente condivisione transitiva» e «l'ascolto a distanza nella fase 3» di *Federazione: forma generale* (2026-10-08). La ricerca e l'ascolto passano di server in server fino a N salti (predefinito 2), ma ogni server sceglie se la sua libreria è visibile agli amici degli amici (predefinito sì), non inoltra mai per nodi non collegati e ogni risultato dice da chi passa. I file copiati restano fuori dal catalogo (niente ricondivisione dei file). Ogni nodo espone un catalogo leggero (niente percorsi) con le differenze per versione; i vicini lo tengono in cache, la ricerca oltre i vicini si inoltra (ttl, rid, 3 s). Ascolto tramite il proprio server, a catena, con Range; copia di singoli brani in `federati/<server>/` verificata con sha256. Firme Ed25519 anche sulle risposte JSON. Codice in `server/federazione.py`, primo modulo separato da `app.py` (cambia la scelta implicita "server in un file", come previsto da `docs/FEDERAZIONE.md` §10). Una sola libreria Navidrome "Dalla rete".
**Alternative scartate:** copiare i cataloghi di tutti gli amici degli amici (dati di chi non conosco su ogni server, aggiornamenti a cascata); restare ai soli collegamenti diretti (non dà la mappa chiesta); ascolto direttamente dal client verso il server dell'amico (CORS, credenziali in giro, niente amici degli amici); catalogo letto dal DB di Navidrome (meno stabile fra versioni); una libreria Navidrome per server (permessi per utente e per libreria da gestire subito, senza abbonamenti che li richiedano).
**Conseguenze:** un server acceso fa da passaggio per l'audio degli amici dei suoi amici (banda e thread di waitress); un server spento si vede nella mappa ma i suoi brani non si ascoltano; i cataloghi in cache possono essere indietro fino a 10 minuti; la musica copiata la vedono tutti gli utenti del server. Il nuovo volume `federati/` nel compose fa ricreare anche Navidrome al primo aggiornamento. Con "Questo telefono" in uso la rete passa dal server di backup.
**Da rivedere se:** la rete supera qualche decina di server o i passaggi pesano sulla banda di chi sta in mezzo (allora: collegamenti diretti a richiesta, o niente audio a catena oltre un salto); serve visibilità per utente.

## 2026-10-09 — Presenza e attività sul canale dal vivo, privacy decisa dal server

**Contesto:** si vuole vedere ovunque nell'app chi sul server ascolta cosa e cosa fa, in tempo reale; prima c'era solo getNowPlaying a intervalli nella pagina Amici.
**Scelta:** presenza (`presence`) e attività (`activity`) viaggiano sullo stesso SSE `/api/live` di ogni dispositivo, mandate a tutti gli utenti collegati; il server inoltra la presenza solo a un cambio di brano, a play/pausa o a un salto oltre 8 s, il client stima l'avanzamento. Attività in memoria (ultime 50), raggruppate se ravvicinate. Preferenza "mostra agli altri" in `settings` (`nascondi:<utente>`), applicata dal server. Playlist solo se pubbliche (verificate con getPlaylist come l'utente); Jam solo "ha avviato una Jam", col nome solo se visibile.
**Alternative scartate:** un secondo canale SSE (un thread di waitress in più per dispositivo); getNowPlaying a intervalli (ritardo, niente attività); filtro della privacy nel client di chi guarda (i dati arriverebbero comunque); la preferenza dentro `/api/prefs` (non arriva al server se la sincronizzazione è spenta); una migrazione nuova (collisione con i lavori in parallelo).
**Conseguenze:** senza "Un solo dispositivo suona…" (Live spento) non si vede né si è visti. Un dispositivo chiuso male resta "in ascolto" fino a 45 s (fino a 120 s col solo battito). Attività perse al riavvio del server. Spegnere la privacy cancella le proprie attività recenti.
**Da rivedere se:** i dispositivi collegati diventano tanti che inoltrare a tutti pesa, o serve uno storico delle attività che sopravviva al riavvio.

## 2026-10-09 — Brani in attesa di una playlist: una nota per playlist, controllo all'arrivo

**Contesto:** reimportando lo stesso CSV (dopo la risistemazione della libreria) ogni importazione lasciava la sua nota "aggiungi questi brani quando arrivano": all'arrivo i brani entravano tre volte (Aether GG: 714 voci, 332 brani diversi).
**Scelta:** le note in attesa si uniscono per playlist e server, senza ripetere un brano; all'arrivo si aggiunge solo ciò che la playlist non ha. Per le playlist già sporche, "Togli doppioni" la riscrive (`createPlaylist` con `playlistId`) con i brani esistenti, una volta ciascuno, nello stesso ordine; spariscono anche le voci di file non più in libreria, che Navidrome contava nel totale.
**Alternative scartate:** pulizia automatica senza chiedere (una playlist può contenere ripetizioni volute); togliere i doppioni con `songIndexToRemove` (gli indici di Navidrome includono le voci di file spariti, che getPlaylist non restituisce).
**Conseguenze:** "Togli doppioni" toglie anche le ripetizioni volute.
**Da rivedere se:** serve distinguere le ripetizioni volute da quelle accidentali.

## 2026-10-09 — App senza server: «Questo telefono» come server locale, file serviti dal WebViewClient

**Contesto:** l'app Android deve funzionare senza server; il server diventa la copia.
**Scelta:** un server virtuale (`Local` in `client/telefono.js`, restituito da `srv()` ma fuori da `S.servers`) risponde alle chiamate Subsonic delle viste partendo da MediaStore (plugin `ArmonyLibrary`) e dai brani offline; preferiti, playlist e ascolti del telefono stanno nell'IndexedDB. Audio e copertine li serve un WebViewClient a `/_armony_/` (stessa origine della pagina, quindi Web Audio funziona, e le Range sono gestite). Il backup confronta i brani con `matchTrack` e carica i mancanti con `/api/upload`, dal plugin, a pezzi. Le playlist si copiano aggiungendo, mai togliendo.
**Alternative scartate:** `convertFileSrc`/`_capacitor_content_` (Range sbagliate: la barra non salta); viste riscritte per il locale (doppio codice); una voce finta in `S.servers` (finirebbe nelle esportazioni, nelle sessioni, in Live); scaricare tutta la libreria del server per il confronto (pesante sul telefono); caricare dal JS con un blob (tutto il file in memoria); riproduzione nativa (si perdono EQ e dissolvenza).
**Conseguenze:** gli ascolti dei brani del telefono non vanno al server; una playlist da cui togli un brano sul telefono lo tiene sul server; il primo backup fa una ricerca per ogni brano; un brano già sul server con titolo o artista diversi viene caricato di nuovo.
**Da rivedere se:** le librerie sul telefono diventano molto grandi (allora indice e ricerca nativi), o serve la sincronizzazione delle playlist nei due versi.

## 2026-10-09 — Dispositivi agganciati: stessa coda (i prossimi 20), visualizzatore calcolato dove non c'è audio

**Contesto:** il telefono che comanda il PC mostrava la sua coda e non quella del PC, e il visualizzatore restava vuoto perché legge l'audio locale; il disco partiva solo dopo la ricerca del testo.
**Scelta:** lo stato pubblicato da chi suona contiene anche i prossimi 20 brani e quanti ne restano (`next`, `left`), ripubblicato quando la coda cambia; "Prossimi" e Coda del telecomando mostrano quelli, e toccarne uno manda il comando `skipto`. Dove l'audio non passa da qui (telecomando, ospite di una Jam in trasmissione, modalità compatibile) il visualizzatore disegna onde calcolate dalla posizione del brano. Disco e visualizzatore partono prima della ricerca del testo. Risincronizza toglie il "per conto suo".
**Alternative scartate:** mandare tutta la coda (fino a 3000 brani per ogni cambio di stato, troppo per un canale che serve tutti i dispositivi); lo spettro vero via rete (banda continua per un effetto grafico).
**Conseguenze:** oltre i 20 prossimi il telecomando vede solo il numero; il visualizzatore del telecomando non segue la musica vera, solo il tempo.
**Da rivedere se:** serve modificare la coda di un altro dispositivo (togliere, spostare) dal telecomando.

## 2026-10-09 — Coda dei download raggruppata: gruppo deciso dal server, forma vecchia intatta

**Contesto:** un'importazione Spotify può mettere in coda migliaia di brani; la coda li mostrava uno per uno e `/api/jobs` restituisce solo gli ultimi 200, quindi il client non poteva calcolare un avanzamento complessivo.
**Scelta:** `/api/import` dà a tutti i brani della stessa richiesta un `batch` e un'etichetta (album o playlist); `GET /api/jobs?grouped=1` (capacità `jobgroups`) restituisce i gruppi già contati sul server (totale, finiti, errori, avanzamento, fino a 3 brani in corso e 50 errori) più i download singoli. Senza parametro la risposta resta quella di prima.
**Alternative scartate:** raggruppare nel client (vede solo 200 brani); cambiare la forma di `/api/jobs` (romperebbe gli APK già installati, servirebbe alzare `API_LEVEL`).
**Conseguenze:** "Rimuovi conclusi" toglie anche i brani finiti dai gruppi, che si accorciano.
**Da rivedere se:** si aggiunge la possibilità di fermare o riprendere un gruppo intero.

## 2026-10-09 — Dal vivo: battito e ping al posto del commento SSE, e niente musica mandata ai fantasmi

**Contesto:** una connessione mezza morta (app uccisa, cambio rete, schermo spento) restava "aperta" per sempre: il commento SSE non arriva al codice del client e il server non si accorge di un TCP mezzo aperto. In più, aprendo il PC subito dopo aver chiuso male il telefono mentre suonava, il PC diventava telecomando del telefono morto e la coda finiva lì.
**Scelta:** per i client che lo chiedono (`hb=1`, capacità `livehb`) il server manda un ping come dato e riceve un battito (`/api/live/beat`) ogni ~30 s. Il client si ricollega dopo 40 s di silenzio e subito su online, ritorno visibile e resume dell'app; con la sessione scaduta rifà l'accesso con tok/salt. Il server toglie dopo 120 s senza battito un dispositivo e chiude le connessioni vecchie dello stesso dispositivo quando si ricollega. Se dopo "suona qui la coda", play o pausa il dispositivo scelto non manda il suo stato entro 5 s (o sparisce), il client lo toglie e suona da sé.
**Alternative scartate:** solo il cane da guardia del client (il server terrebbe i fantasmi); keepalive TCP (minuti, non configurabile dal client); un ping a tutti senza `hb` (gli APK vecchi non lo conoscono); controllare anche "avanti" (un dispositivo vivo può metterci più di 5 s a caricare il brano: falsi allarmi).
**Conseguenze:** una richiesta ogni ~30 s per dispositivo collegato. Due schede dello stesso browser condividono l'id: resta collegata l'ultima, l'altra si riaggancia quando torna visibile. Fino a 5 s di silenzio prima che la musica torni qui.
**Da rivedere se:** Android congela la WebView in sottofondo oltre i 120 s mentre suona (allora il battito va mandato dal servizio nativo).

## 2026-10-09 — Telefono: spazi delle barre misurati dall'app, lettore che si riduce, pillole dentro il lettore

**Contesto:** su molte WebView `env(safe-area-inset-bottom)` vale 0 e la barra in basso finiva contro i tasti o i gesti. Il lettore restava in mezzo durante la navigazione e con la tastiera aperta. Le pillole sopra il lettore coprivano il contenuto. Mancava il nome delle cuffie.
**Scelta:** un plugin `ArmonyInsets` misura quanto barre e tastiera si sovrappongono alla WebView; sta sul genitore della WebView e lascia gli insets com'erano, così SystemBars di Capacitor resta l'unico a ridimensionarla. Le misure entrano nel `max()` di `--sat`/`--sab`, più 8 px sotto la barra delle sezioni. Scorrendo verso il basso il lettore si riduce a una riga e torna salendo; con la tastiera aperta sparisce. Le pillole stanno in una riga dentro il lettore. L'uscita audio arriva da `getAudioDevicesForAttributes` (Android 13+) o da `getDevices` con precedenza; `getProductName()` non richiede permessi.
**Alternative scartate:** `insetsHandling:'native'` o un listener sulla DecorView (avrebbero sostituito quello di Capacitor); chiedere BLUETOOTH_CONNECT (serve solo per l'indirizzo); pillole nell'intestazione (lontane dal lettore); lettore a una riga sempre (ribalterebbe la voce sul lettore a due righe senza motivo); leggere il nome delle cuffie nel browser del PC (servirebbe il permesso del microfono).
**Conseguenze:** lo spazio in fondo alle pagine resta quello del lettore grande. La riga delle pillole aggiunge 36 px quando c'è.
**Da rivedere se:** tutte le WebView supportate danno `env()` corretti (allora il plugin si può togliere), o la riga delle pillole si rivela troppo alta sui telefoni piccoli.

## 2026-10-09 — Discografia completa dell'artista da Deezer, schede "fantasma"

**Contesto:** dalla pagina artista si vuole vedere e scaricare tutto ciò che l'artista ha pubblicato, e navigare fra artisti simili anche fuori dalla libreria.
**Scelta:** `GET /api/discografia` cerca l'artista su Deezer e lo accetta solo con nome normalizzato identico (fra gli omonimi il più seguito); restituisce le uscite con `record_type` e gli artisti simili. Il client abbina gli album della libreria per titolo senza edizione (parentesi, "- …", deluxe, remaster) e mostra il resto come schede attenuate; l'album fantasma (`#/album-dz/<id>`) si scarica con `/api/import`. Gli artisti simili non in libreria hanno una pagina solo-Deezer (`#/artista-dz/<id>`) che rimanda a quella della libreria appena l'artista c'è.
**Alternative scartate:** primo risultato di Deezer per nome (omonimi, tribute band); numero di tracce per ogni uscita (una richiesta per album, troppe col limite di Deezer); MusicBrainz (1 richiesta/s, release da scegliere).
**Conseguenze:** il nome di ogni artista aperto va a Deezer; edizioni con titoli molto diversi restano fantasma anche se le hai; "Scarica l'album" può riscaricare brani che hai sotto un altro album.
**Da rivedere se:** Deezer chiude l'API pubblica.

## 2026-10-09 — EQ automatico e protezione dai gracchi: misura prima dell'EQ, modalità a sé, margine + limitatore

**Contesto:** richiesta di un equalizzatore che si regoli da solo sul brano e di niente gracchi quando EQ, normalizzazione e volume sommano guadagno.
**Scelta:** lo spettro si misura prima dell'EQ (misurarlo dopo creerebbe un anello in cui l'EQ corregge sé stesso), mediato su qualche secondo e confrontato con una curva fissa e indicativa (rosa fino a 250 Hz, poi −2 dB/ottava come la media dei mix commerciali); correzioni lente, entro ±6 dB. "Automatico" è una modalità alternativa alle preimpostazioni, non sommata (sommarle raddoppierebbe la curva). Contro il clipping: un margine pari al picco reale della curva dell'EQ (calcolato con `getFrequencyResponse`, perché le bande vicine si sommano) e un `DynamicsCompressor` come limitatore a −1 dB, con la compensazione automatica del browser tolta a mano.
**Alternative scartate:** una curva per genere (i tag spesso mancano o sono sbagliati); un limitatore in AudioWorklet (un file in più nella shell e costo sui telefoni economici).
**Conseguenze:** quando l'EQ alza, il volume complessivo cala (tutto a +12: circa 9 dB; automatico: 2–5 dB). A pagina nascosta l'analisi si ferma e restano le ultime correzioni.
**Da rivedere se:** un browser cambia la formula della compensazione del compressore, o servono picchi fra campioni sotto −1 dB.

## 2026-10-09 — Nuova disposizione: un solo carattere, AutoAnimate nel repo, tempo reale a intervalli

**Contesto:** richiesta di rifare disposizione ed elenchi in stile Spotify:
Cerca vuota, poco spazio usato sul computer, interruttori e scelte fuori stile,
playlist che non mostrano i brani appena aggiunti o scaricati, animazioni e
copertine all'altezza.
**Scelta:** Figtree per tutto il testo, gerarchia fatta da peso e grandezza
(`--fs-*`); Bricolage Grotesque resta solo nel marchio. Ribalta in parte la voce
«Grafica: tavolozza, caratteri e componenti a token» del 2026-10-08, che teneva
i due caratteri insieme nei titoli: due famiglie nella stessa schermata
facevano sembrare le pagine di app diverse. Tre misure di copertina (scheda,
intestazione, miniatura della riga) e un solo modello per pagina: intestazione
con la fascia del colore della copertina, barra azioni con ▶ ambra e icone, il
resto nel foglio ⋯. Riquadri colorati con una tavolozza unica scelta dal nome.
Interruttori per le impostazioni, caselle solo per le scelte multiple.
Animazioni delle liste con AutoAnimate 0.10.0 (MIT, 3 kB) copiato in
`client/vendor/` e caricato come modulo; dialoghi con `@starting-style`.
Playlist e album aperti si aggiornano da soli: subito quando il cambiamento
parte da questo dispositivo (`api()` emette `playlists`/`libreria`), altrimenti
con un controllo ogni 20 secondi; i brani nuovi entrano con un breve alone ambra.
**Alternative scartate:** Motion One o GSAP (più pesanti, servono per
coreografie che qui non ci sono); caricare AutoAnimate da CDN (l'app Android e
l'offline lo perderebbero); avvisare le pagine aperte via SSE da Navidrome
(Navidrome non emette eventi sulle playlist, servirebbe un osservatore sul
server per un guadagno di qualche secondo).
**Conseguenze:** fino a 20 s di ritardo per i cambiamenti fatti da altri
dispositivi o dai download; un file di terzi nel repo da aggiornare a mano.
**Da rivedere se:** Navidrome espone eventi sulle playlist, o se servono
animazioni coordinate fra più elementi che AutoAnimate non sa fare.

## 2026-10-08 — Modifica dei brani e copertine: tag scritti nel file, file fermi, copertine solo da Deezer o caricate

**Contesto:** cambiare titolo, artisti, album, anno, generi, traccia e scegliere
la copertina dall'app.
**Scelta:** il server trova il file con `track_paths()` (DB di Navidrome in sola
lettura, `realpath` dentro MUSIC_DIR) e scrive con mutagen solo i campi
passati; i file non si spostano, così l'id Navidrome e le playlist restano
(verificato). Copertina: `{url}` solo dagli host CDN di Deezer, oppure corpo
JPEG/PNG verificato dai byte iniziali, max 10 MB; per l'album sostituisce
`cover.jpg` e la incorpora, per un brano la incorpora soltanto. Stesso permesso
dell'eliminazione («Modifica ed eliminazione»).
**Alternative scartate:** rinominare o spostare il file (per Navidrome sarebbe
un brano nuovo: playlist, preferiti e ascolti persi); copertina da qualsiasi
URL (SSRF); un permesso a parte (due caselle per lo stesso livello di fiducia);
modifica tramite l'API di Navidrome (non esiste).
**Conseguenze:** nome e cartella del file restano quelli vecchi; cambiando nome
o artista di un album, per Navidrome è un album nuovo.
**Da rivedere se:** Navidrome rende stabili gli id anche dopo lo spostamento dei
file (allora si possono riordinare le cartelle).

## 2026-10-08 — Registrazione degli amici: utenti Navidrome creati con le credenziali dell'admin, su invito

**Contesto:** un amico che installa l'app deve potersi creare un account o
accedere con uno esistente; un solo amministratore per server.
**Scelta:** l'admin inserisce una volta utente e password dell'amministratore
di Navidrome (verificati, file 600 in /data, mai restituiti; o
NAVIDROME_ADMIN_USER/PASS). `POST /api/register` crea utenti normali con l'API
nativa (JWT rinnovato se scade). Modalità chiusa/invito/aperta, predefinita
invito; inviti monouso di 8 caratteri senza ambigui, 7 giorni, prenotati prima
della creazione e liberati se fallisce. Limiti: 10 errori in 10 minuti e 20
account all'ora per IP.
**Alternative scartate:** account propri di Armony (due anagrafiche da
allineare, Subsonic non li vede); credenziali dell'admin chieste a ogni invito
(scomodo); registrazione sempre aperta (chiunque raggiunga il server entra);
far creare gli utenti all'admin solo dalla UI di Navidrome (l'amico deve
aspettare e ricevere una password).
**Conseguenze:** la password dell'amministratore di Navidrome sta in chiaro sul
server (file 600); se viene cambiata la registrazione si ferma finché non la si
reinserisce. In modalità aperta valgono solo i limiti per IP, niente captcha.
**Da rivedere se:** Navidrome offre token di servizio o un'API per gli inviti.

## 2026-10-08 — Jam tramite il server: relay cifrato e orologio comune

**Contesto:** la Jam deve funzionare anche quando il collegamento diretto non
si apre (5G, NAT), usando il server come sincronizzatore.
**Scelta:** terzo collegamento «Server»: niente WebRTC; i messaggi passano dal
relay `/api/jam` dentro la segnalazione (AES-GCM con la chiave della stanza) e
in un secondo strato AES-GCM con chiave ECDH per coppia host↔ospite; codice di
sicurezza dallo SHA-256 delle due chiavi pubbliche. Orologio comune
`/api/jam/ora` con stima stile NTP (campione con RTT minimo); lo stato
dell'host porta l'ora del server (`sat`). Solo ascolto sincronizzato (serve un
account sul server). Predefinito quando c'è un server; ripiego automatico dal
diretto dopo 10 s. Senza HTTPS il modo non c'è.
**Alternative scartate:** TURN obbligatorio (un servizio in più da gestire, e
la trasmissione resterebbe pesante); ping verso l'host attraverso il relay per
l'orologio (latenza del long-poll, asimmetrica); trasmissione dell'audio
dell'host tramite il server (banda e latenza); modo server anche senza HTTPS
(messaggi in chiaro sul server).
**Conseguenze:** ogni partecipante tiene un `/recv` aperto (un thread di
waitress: 8 su 96 per una Jam di 8); l'allineamento dipende dalla simmetria
della rete (misurato entro ±41 ms, ~170 ms con ritardo molto asimmetrico).
**Da rivedere se:** le Jam diventano grandi (decine di persone): allora un
canale SSE unico per stanza invece del long-poll.

## 2026-10-08 — Album completi: scaletta da Deezer, tracce mancanti in grigio

**Contesto:** aprendo un album si vogliono vedere e scaricare anche le tracce
che non sono in libreria.
**Scelta:** `GET /api/album/scaletta` cerca l'album su Deezer: prima il titolo
identico, poi lo stesso titolo senza edizione; preferisce l'anno uguale, poi
più tracce. La pagina abbina i brani per titolo e durata (±5 s), poi per numero
di traccia, e mostra le mancanti al loro posto, in grigio, scaricabili con
`/api/import` usando album e artista dell'album della libreria.
**Alternative scartate:** scaletta da MusicBrainz (1 richiesta/s, release
multiple da scegliere); album di Deezer come fonte del nome (finirebbe in un
album diverso da quello della libreria); scaricare l'intero album con un solo
tasto (si riscaricherebbero i brani già presenti).
**Conseguenze:** artista e album di ogni pagina aperta vanno a Deezer; edizioni
diverse con titoli molto diversi non vengono riconosciute.
**Da rivedere se:** Deezer chiude l'API pubblica.

## 2026-10-08 — Download importati: la durata è una preferenza, non un filtro

**Contesto:** con il filtro rigido sulla durata (±5%) molti download fallivano
per brani validi (pochi secondi di silenzio, edizioni diverse).
**Scelta:** si guardano i primi 8 risultati senza scaricarli e si dà un
punteggio: titolo e artista nel titolo del video, canale "- Topic" di YouTube
Music (audio ufficiale, durata esatta), "official audio", penalità per live,
cover, remix… non richiesti, e durata (premio entro 3 s, penalità crescente
oltre). Si scarica il migliore, poi il secondo e il terzo se il download
fallisce; SoundCloud solo se YouTube non dà niente.
**Alternative scartate:** filtro rigido (scarta brani buoni); primo risultato
(spesso il video con intro o una versione live).
**Conseguenze:** si può scaricare una versione un po' più lunga o più corta;
il lavoro registra il video scelto (`scelto`) per controllarlo.
**Da rivedere se:** compaiono spesso versioni sbagliate (allora alzare il peso
della durata).

## 2026-10-08 — Telefono come telecomando: la notifica mostra il dispositivo che suona

**Contesto:** l'app sul telefono deve restare sincronizzata col PC anche in
sottofondo; senza servizio in primo piano Android la congela e il canale dal
vivo si chiude.
**Scelta:** quando il telefono comanda un altro dispositivo, `NativeMedia`
mostra nella notifica il brano di quel dispositivo ("Su Computer"), come
Spotify Connect: il servizio in primo piano tiene viva l'app e il canale SSE,
e i comandi della notifica passano da `ctl*`, cioè diventano comandi remoti.
**Alternative scartate:** una notifica fissa "Armony collegato" sempre accesa
(rumore costante anche quando non suona niente); servizio di tipo dataSync
(su Android 15 limitato a 6 ore al giorno).
**Conseguenze:** mentre il PC suona il telefono tiene svegli CPU e Wi-Fi come
quando suona lui. Se non suona niente da nessuna parte e l'app è in sottofondo
da tempo, Android può congelarla: si ricollega quando la riapri.
**Da rivedere se:** il consumo di batteria in modalità telecomando si nota
(allora niente wake lock della CPU in quella modalità).

## 2026-10-08 — Importazione da Spotify: CSV come fonte, Deezer per il resto, cartelle per album

**Contesto:** i brani importati arrivavano con un solo artista, album a caso,
titoli "NA", niente copertina né numero di traccia, in cartelle per artista.
**Scelta:** i CSV di Exportify sono la fonte (titolo, tutti gli artisti,
album, data, durata, ISRC, generi, etichetta); Deezer, API pubblica senza
chiave, completa solo copertina, traccia, disco e artista dell'album, e solo
se l'album coincide (`server/metadati.py`). Il server cerca con la durata come
filtro (YouTube, poi SoundCloud), estrae in M4A senza ricodificare, scrive i
tag con mutagen e mette il file in `<artista album>/<album>/<NN - titolo>` con
`cover.jpg`. I download passano da una coda con due esecutori. Lo stesso modulo
sistema i brani già in libreria (`deploy/riallinea-spotify.py`, prova a secco).
**Alternative scartate:**
- MusicBrainz per ISRC: dati ottimi ma 1 richiesta al secondo e copertine da
  un secondo servizio; Deezer è più veloce e ha quasi sempre la copertina.
- Spotify Web API: serve una chiave registrata per ogni server.
- Primo risultato di Deezer per ISRC: spesso è il singolo, non l'album della
  playlist.
- Tag con i `meta_*` di yt-dlp/ffmpeg: le chiavi cambiano per formato e
  copertina e ISRC non passano in modo uniforme.
- Un thread per download: con migliaia di brani importati non regge.
**Conseguenze:** i dati di ogni brano importato vanno a Deezer (ISRC, artista,
album); senza rete verso Deezer restano i dati del CSV. I brani sistemati o
spostati sono nuovi per Navidrome: le playlist si completano reimportando.
**Da rivedere se:** Deezer chiude l'API pubblica (allora MusicBrainz + Cover
Art Archive), oppure YouTube blocca stabilmente il server (cookie obbligatori).

## 2026-10-08 — Eliminare brani: percorso dal DB di Navidrome, in sola lettura

**Contesto:** eliminare brani dal server con un permesso per utente.
**Scelta:** permesso `delete` (spento per gli utenti, sempre per gli admin);
`POST /api/tracks/delete` legge `media_file.path` e `library.path` dal DB di
Navidrome montato in sola lettura (`./data/navidrome:/navidrome:ro`,
`?mode=ro`), accetta solo file dentro `MUSIC_DIR` dopo `realpath` e solo della
libreria montata in `/music`, poi toglie le cartelle rimaste senza audio.
**Alternative scartate:** percorso dal client (mai fidarsi); `getSong` Subsonic
(percorso inventato salvo "report real path" per client); API nativa di
Navidrome (serve un JWT, cioè la password); attivare "report real path" (a
mano, client per client).
**Conseguenze:** Armony dipende dallo schema interno di Navidrome per due
colonne (`media_file.path`, `library.path`); la scansione la chiede il client.
**Da rivedere se:** Navidrome cambia lo schema o espone il percorso vero via API
con un token di servizio.

## 2026-10-08 — Dal vivo: un solo dispositivo suona, gli altri lo comandano (SSE)

**Contesto:** fermare la musica sul PC deve fermarla sul telefono e viceversa;
si deve poter scegliere su quale dispositivo suona, spostarla, e anche lasciare
due dispositivi liberi di suonare cose diverse.
**Scelta:** modello "Connect": ogni dispositivo di un utente tiene aperto un
canale SSE (`/api/live`); chi suona pubblica brano, play/pausa e posizione solo
quando cambiano; chi comincia a suonare ferma gli altri, che diventano
telecomandi (`Live.remote()`, sullo stesso schema dell'ospite della Jam in
`currentTrack`/`isPlaying`/`ctl*`). "Dove suona" sposta la coda (`transfer`)
o chiede al dispositivo che suona di passarla (`handoff`). Un dispositivo "per
conto suo" (`P.solo`) è sganciato. Stato in memoria del server.
**Alternative scartate:**
- WebSocket: waitress non li gestisce; servirebbe un secondo server.
- Interrogare il server ogni pochi secondi: ritardo visibile e richieste
  continue anche da fermi.
- Tutti i dispositivi che suonano insieme sincronizzati: è la Jam, con i suoi
  costi (orologio condiviso, WebRTC).
- Solo un "ferma tutto": non dice cosa suona dove e non permette di spostarla.
**Conseguenze:** ogni dispositivo collegato occupa un thread di waitress per il
suo canale (portati a 96). Nel browser l'audio spostato da un altro dispositivo
può essere bloccato dalla regola dell'autoplay se la pagina non è mai stata
toccata (avviso a schermo); nell'app no. La notifica del telefono riguarda solo
la musica che suona sul telefono.
**Da rivedere se:** i dispositivi collegati diventano tanti da esaurire i
thread (allora un server asincrono per `/api/live`), oppure serve spostare la
musica fra utenti diversi (oggi è per utente).

## 2026-10-08 — Barra di avanzamento a onda: canvas sotto l'input

**Contesto:** il lettore deve mostrare l'avanzamento come un'onda morbida (stile
One UI / Android 13+), fatta di onde asincrone.
**Scelta:** canvas sotto `<input type=range id=seek>`, somma di tre sinusoidi
con lunghezze e velocità diverse, disegnato con requestAnimationFrame solo
mentre suona o mentre l'ampiezza cambia; l'input resta per trascinamento,
tastiera e accessibilità, con il binario trasparente.
**Alternative scartate:** SVG con animazione CSS (onda periodica, si vede la
ripetizione; nessun controllo sull'ampiezza in pausa); sostituire l'input con
un controllo disegnato (si perdono tastiera e accessibilità native); animazione
continua anche in pausa (consuma batteria per niente).
**Conseguenze:** con «Riduci movimento» la barra è una linea dritta.
**Da rivedere se:** il disegno pesa sui telefoni economici (allora meno punti o
30 fps).

## 2026-10-08 — Grafica: tavolozza, caratteri e componenti a token

**Contesto:** richiesta di un abbellimento generale (caratteri, colori, lettore,
pulsanti) e di spaziature adatte al telefono, con le skill `mobile-native`,
`emil-design-eng` e `impeccable` come riferimento.
**Scelta:** tenere l'identità (vinile, blu notte, ambra, Bricolage Grotesque e
Figtree) e portarla su token: colori in due temi (notte più profonda, bianco
"carta calda", `--on-accent` per il testo sull'ambra), spazi a passi di 4 px
(`--s1…--s7`), raggi per gerarchia (`--r-s…--r-xl`), ombre `--shadow-art` e
`--shadow-float`, altezza dei comandi `--hit` (40 px, 44 al tocco). Pulsanti di
tre tipi (tonale, primario, icona). Il play è l'etichetta ambra del disco.
Hover solo sotto `(hover:hover) and (pointer:fine)`. Sul telefono il lettore è
su due righe (brano e ⏮▶⏭; casuale, barra, ripeti); testi, coda e qualità
stanno in "In riproduzione" e nel pulsante in alto.
**Alternative scartate:** cambiare caratteri o colori di base (si perde
un'identità che non sembra un modello); lettore in vetro sfocato
(`backdrop-filter` pesa sui telefoni economici e qui sarebbe decorazione);
effetti al passaggio su ogni copertina (il difetto più tipico delle interfacce
generate); tenere tutti i comandi nel lettore del telefono (la barra di
avanzamento restava larga 16 px).
**Conseguenze:** stili nuovi vanno scritti con i token, non con valori sparsi.
Sul telefono testi e coda non hanno più un tasto nel lettore.
**Da rivedere se:** "In riproduzione" perde le schede Testi/Prossimi, oppure
serve un tema in più (allora i token vanno raccolti in un file a parte).

## 2026-10-08 — Aggiornamento dell'app dall'app: PackageInstaller con sha256 della release

**Contesto:** l'app proponeva solo un link all'APK da aprire nel browser.
**Scelta:** il plugin `ArmonyUpdate` scarica l'APK della release, verifica lo
sha256 pubblicato accanto all'APK (lo legge il plugin, perché il redirect di
GitHub verso i file non ha CORS) e lo passa a PackageInstaller; Android chiede
sempre conferma, e la prima volta il permesso "installa app sconosciute" per
Armony. Controllo all'avvio, al ritorno in primo piano, al massimo ogni 6 ore.
**Alternative scartate:** link nel browser (file in Download da cercare,
nessuna verifica); `ACTION_VIEW` con FileProvider (deprecato per l'installazione,
senza esito); installazione silenziosa (impossibile fuori dal Play Store senza
un dispositivo gestito); aggiornare solo il client web nell'app
(`setServerBasePath`): non porta le modifiche native e lega l'app a un secondo
canale di distribuzione.
**Conseguenze:** l'aggiornamento nell'app funziona dalla versione successiva a
quella installata con questo codice; senza il `.sha256` nella release non si
installa niente.
**Da rivedere se:** l'app va sul Play Store (aggiornamenti gestiti da Google).

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
