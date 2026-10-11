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

## 2026-10-11 — Controllo giornaliero di nome e certificato

**Contesto:** con un DynDNS gratuito (No-IP: conferma ogni 30 giorni) e un inoltro sul firewall, Armony può sparire da internet senza che nessuno se ne accorga finché un amico non resta fuori.
**Scelta:** `diagnosi.controlla_dominio`, una volta al giorno dal giro orario: risoluzione del nome contro l'indirizzo d'uscita del server (api.ipify.org) e certificato servito da Caddy sulla porta locale, verificato come un browser (scadenza, emittente). Problemi → registro eventi, notifica agli amministratori (una al giorno) e `ARMONY_AVVISI`. L'esito sta in settings e compare in Stato del server.
**Alternative scartate:** chiamare il nome pubblico dal server stesso (dal server la 443 pubblica non torna indietro: niente NAT reflection per la sua rete); leggere i file del certificato di Caddy (dipende dal suo formato interno, e non dice cosa vede davvero un browser).
**Conseguenze:** una richiesta al giorno a un servizio esterno (ipify) che vede l'indirizzo del server; senza risposta il confronto si salta.
**Da rivedere se:** l'indirizzo pubblico diventa fisso (basta il controllo del certificato).

## 2026-10-11 — Trasloco: i dispositivi seguono il nuovo indirizzo pubblico

**Contesto:** passando dal Funnel (`…ts.net:10000`) a `armony-net.ddns.net`, app e browser degli amici restano sull'indirizzo vecchio.
**Scelta:** `Trasloco` (dispositivi.js): se `me.public` ha un altro host HTTPS e lì `/api/me` con la stessa sessione risponde lo stesso utente, l'app cambia `s.url` da sola; il browser (il suo localStorage è legato all'origine) mostra «Passa lì», crea un codice di abbinamento e apre `<nuovo>/#/abbina/<codice>.via`, che si abbina da solo. Indirizzi IP o http esclusi.
**Alternative scartate:** chiedere a ognuno di modificare il server a mano (gli amici non sanno cosa sia); reindirizzare dal vecchio indirizzo al nuovo (il browser arriverebbe senza accesso e chiederebbe la password); spostare i dati del browser fra origini (non si può).
**Conseguenze:** nel browser il vecchio dispositivo resta nell'elenco accanto al nuovo, finché non lo si revoca. Il Funnel va tenuto acceso finché gli APK vecchi non si sono aggiornati.
**Da rivedere se:** si cambia di nuovo indirizzo e si vuole spegnere subito il vecchio.

## 2026-10-11 — HTTPS diretto con Caddy (profilo "https") al posto del Funnel; pagina d'accesso a tutta pagina

**Contesto:** i registri di sessione mostrano blocchi sulla strada fra il server e i dispositivi che passano da Tailscale Funnel. L'utente ha un DynDNS (`armony-net.ddns.net`) che punta al suo firewall, che può inoltrare la 443. Sulla macchina nginx (servizi non di Armony) occupa 80, 443, 8443 (n8n, senza filtro sul nome) e 8444.
**Scelta:** servizio `https` (Caddy 2.8.4, profilo facoltativo, rete host) in ascolto sulla 8460 con certificato Let's Encrypt ottenuto con la sfida TLS-ALPN sulla 443 inoltrata (nessuna porta 80), `reverse_proxy` verso 127.0.0.1:8080 con `flush_interval -1` per il canale dal vivo e l'audio. Caddy mette in X-Forwarded-For solo l'indirizzo vero; waitress se ne fida perché arriva da 127.0.0.1. Verificato che il firewall inoltri senza mascherare l'origine (connessioni su :8460 dall'IP pubblico del client). L'indirizzo pubblico di Armony passa a quello nuovo; il Funnel resta acceso finché i dispositivi non sono passati. La pagina d'accesso del browser diventa una schermata a sé (`data-login`: niente barra laterale, lettore, sezioni).
**Alternative scartate:** inoltrare alla 8443 (avrebbe esposto n8n a internet al posto di Armony); un blocco nel nginx esistente con certbot (tocca la configurazione di altri servizi e chiede anche la porta 80); restare sul Funnel (i blocchi sono nel percorso, non in Armony).
**Conseguenze:** chi installa Armony senza un nome resta come prima (profilo spento). Un inoltro con SNAT renderebbe "di casa" chiunque: va controllato a ogni cambio del firewall.
**Da rivedere se:** il firewall o il DynDNS cambiano, o se i blocchi continuano anche sull'indirizzo diretto.

## 2026-10-11 — Primo blocco registrato: il server risponde subito, le risposte si fermano sulla strada; riaprire il canale dal vivo

**Contesto:** il primo evento «sessione» (PC dell'utente, Tailscale Funnel) mostra 16 richieste ricevute dal server e risposte in 0-13 ms, ma arrivate al browser 12-18 s dopo, tutte nello stesso istante: 0,8 s dopo che il client aveva riaperto il canale dal vivo (nessun segnale da 20 s). Le richieste nuove fatte durante il blocco non l'avevano sbloccato.
**Scelta:** esperimento: quando una richiesta resta ferma 8 s il client riapre subito il canale dal vivo (al più ogni 15 s) e lo scrive nel registro della sessione; il registro annota anche i segnali del canale dopo un silenzio. Il problema resta fuori da Armony (connessione verso il browser attraverso il Funnel); questo serve ad accorciare i blocchi e a confermare l'ipotesi.
**Alternative scartate:** cambiare il server (risponde in millisecondi: non è lui); togliere il canale dal vivo (serve al telecomando fra dispositivi); aspettare il controllo dei 40 s (i blocchi duravano proprio quanto lui).
**Conseguenze:** in un blocco l'elenco «Dove suona» si ridisegna una volta.
**Da rivedere se:** i prossimi eventi «sessione» mostrano blocchi che non finiscono alla riapertura del canale (allora l'ipotesi è sbagliata e l'esperimento va tolto), o se si sostituisce il Funnel.

## 2026-10-11 — Registro della sessione: richieste numerate dal client, viste dal server

**Contesto:** il web e il telefono dell'utente si bloccano per minuti e poi ripartono, mentre gli altri utenti no. I log di Tailscale mostrano pacchetti d'apertura dai nodi d'ingresso del Funnel verso la porta peerAPI scartati («no rules matched») nelle stesse ore, ma senza un legame con le singole richieste.
**Scelta:** `netFetch` numera ogni richiesta (`_r` nella query, che il proxy non passa a Navidrome) e la scrive in un registro in memoria (`Trace`) con durata ed esito, insieme a rete, visibilità, canale dal vivo e audio; una richiesta ferma oltre 8 s o fallita manda il minuto di registro come evento «sessione». Il server tiene per dispositivo le ultime 400 richieste ricevute (`diagnosi.req_seen`, millisecondi fino alle intestazioni) e le allega all'evento.
**Alternative scartate:** un'intestazione `X-Req` (nell'app Android è una richiesta da un'altra origine: un'intestazione nuova chiede il permesso CORS e i server vecchi la rifiuterebbero); registrare sempre tutto sul server in SQLite (scritture continue per un dato che serve solo quando qualcosa va storto); i log di accesso di waitress (non sanno quale dispositivo, né quando il client ha mandato la richiesta).
**Conseguenze:** al più un evento «sessione» al minuto per dispositivo; il registro del server si perde a ogni riavvio.
**Da rivedere se:** la causa dei blocchi è trovata e risolta: allora il registro può restare solo per i casi rari.

## 2026-10-11 — Testi in una schermata propria, mini lettore senza disco, sviluppo del client su una copia

**Contesto:** l'utente chiede testi come Spotify (righe cantate più grandi, una scheda dedicata), un mini lettore del telefono più pulito e il profilo nel pallino in alto a destra sul web. Nella stessa sessione una modifica a metà di `client/` (montato in produzione) ha servito per 35 secondi un `armony.js` rotto.
**Scelta:** rotta `#/testo` (`vLyrics`): fondo dal colore della copertina scurito (luminosità 0,33, così il testo bianco resta leggibile in entrambi i temi), righe con `transform: scale` (la riga attiva cresce senza spostare le altre), autoscroll sospeso 3,5 s quando si scorre a mano. Sul telefono «In riproduzione» mostra una scheda d'anteprima che apre `#/testo`, e il lettore grande ha il tasto Testo; sul computer il tasto Testo del lettore apre `#/testo`. Mini lettore del telefono: copertina quadrata ferma (l'animazione del disco gira solo su schermo largo), solo l'artista, binario d'avanzamento visibile. Profilo sul computer: `#hProf` apre un riquadro con foto, nome, visibilità. Il client si sviluppa in una copia montata nel container di prova e si copia in `client/` solo al rilascio.
**Alternative scartate:** testi più grandi solo dentro la scheda di «In riproduzione» (sul telefono restava una lista con scorrimento annidato sotto i comandi, il difetto segnalato); colore del fondo dal tema (Spotify usa la copertina, ed è ciò che rende riconoscibile la schermata); disco che gira anche nel mini lettore (a 40 px un disco storto sembra un errore).
**Conseguenze:** con copertine quasi grigie il fondo è un grigio scuro neutro.
**Da rivedere se:** si aggiungono testi parola per parola (servirebbero tempi per parola, che LRCLIB di solito non ha).

## 2026-10-11 — Il gettone del dispositivo negli indirizzi; playlist ai server collegati solo col consenso

**Contesto:** voci 3.12 e 7.8 del piano. Il canale dal vivo (EventSource) e i video portavano la sessione nell'indirizzo (`?token=`): una credenziale che vale giorni, finita in cronologia e nei log dei proxy. `/api/lan/servers` e le Jam vicine mostravano a internet gli indirizzi della rete di casa. Ogni playlist pubblica andava a tutti i server collegati.
**Scelta:** negli indirizzi senza intestazioni il client usa il gettone del dispositivo (`?k=`, già usato per audio e copertine: 12-24 ore, valido solo finché il dispositivo ha una sessione viva), con `authQ`; la sessione resta solo per i server vecchi senza gettone. Gli elenchi della rete di casa rispondono vuoti a chi non è in casa né su Tailscale. Una playlist pubblica va ai server collegati solo se il proprietario la offre (`fed_offerte` nelle impostazioni, `/api/rete/offerta`); al primo uso le pubbliche di allora restano offerte e i proprietari ricevono un avviso.
**Alternative scartate:** un gettone nuovo apposta per il canale dal vivo (quello del dispositivo ha già scadenza, legame con la sessione e revoca: un secondo meccanismo uguale non aggiunge niente); rifiutare subito `?token=` (gli APK vecchi non aggiornati perderebbero il canale dal vivo); togliere l'offerta a tutte le pubbliche esistenti (romperebbe gli abbonamenti già fatti sugli altri server senza che il proprietario lo sappia).
**Conseguenze:** un EventSource aperto resta aperto anche se il gettone scade nel frattempo; al primo ricollegamento con il gettone scaduto il server risponde 401 e il client rinnova sessione e gettone (`relogin`).
**Da rivedere se:** tutti i client in uso hanno il gettone: allora `?token=` si può rifiutare del tutto.

## 2026-10-11 — Cartelle di playlist nelle preferenze; doppioni dei caricamenti per brano; avvisi esterni con un indirizzo

**Contesto:** cartelle di playlist (voce 6.10), voci 5.10 e 4.7 del piano.
**Scelta:** le cartelle sono `P.plDir` (nome e id delle playlist) nelle preferenze dell'utente, già sincronizzate fra i dispositivi; Navidrome non le vede. Un caricamento si confronta con l'indice della libreria usato dalle importazioni (`importa.lib().match`: titolo, artista, durata; dai tag o dal nome «Artista - Titolo»): se c'è già, il file si scarta e il client offre «Carica lo stesso» (`?doppio=1`); ai file senza album o artista si applica `metadati.riconosci_download`. Gli avvisi esterni sono un solo indirizzo in `.env` (`ARMONY_AVVISI`): POST del testo (ntfy) o JSON (`api.telegram.org`), per gli errori del server nuovi nell'ora e le versioni nuove, al più 20 l'ora.
**Alternative scartate:** cartelle come prefisso nel nome della playlist («Allenamento / Corsa»: si vedrebbe nelle altre app e nei link) o in una tabella del server (una rotta in più per un dato che le preferenze già portano); doppioni per impronta del contenuto (hash di tutta la libreria da calcolare e tenere aggiornato, e due codifiche dello stesso brano sono file diversi); avvisi su servizi push con chiavi e account (già scartati, vedi notifiche); avvisi esterni anche per gli errori dei client (troppi, e non li risolve chi gestisce il server).
**Conseguenze:** una playlist eliminata resta nella cartella finché qualcuno non la sposta (non si vede: si filtrano gli id che non ci sono). Un caricamento scartato come doppione è stato comunque inviato tutto: il confronto si fa sui tag, che stanno nel file.
**Da rivedere se:** si caricano spesso molti doppioni grandi (servirebbe un controllo prima dell'invio, leggendo i tag nel browser).

## 2026-10-11 — Cache dei brani con l'indice a parte, coda copiata in IndexedDB

**Contesto:** voce 8.5 del piano. All'avvio `ACache.init` leggeva tutti i file della cache (fino a 5 GB) per conoscerne la dimensione, e ogni ascolto da cache riscriveva il file intero per aggiornarne la data. La coda stava solo in localStorage: oltre i 5 MB la scrittura falliva in silenzio e al riavvio tornava una coda vecchia.
**Scelta:** IndexedDB passa alla versione 5 con due archivi: `acmeta` (chiave, dimensione, ultimo uso: l'unico che si legge all'avvio e si aggiorna a ogni ascolto) e `stato` (una copia della coda, scritta un secondo dopo ogni cambio). La copia in localStorage resta per l'avvio sincrono; `queueAt` si scrive solo se la coda è entrata, e all'avvio vince la copia più recente. La prima volta l'indice si ricostruisce leggendo i file uno alla volta.
**Alternative scartate:** spostare la coda solo in IndexedDB (l'avvio legge `S.queue` in modo sincrono in decine di punti prima di `boot()`: troppo da toccare per lo stesso risultato); Cache Storage per i file (non c'è senza HTTPS).
**Conseguenze:** due scritture per ogni cambio di coda; una scheda vecchia aperta si chiude da sola all'aggiornamento del database (già così dalla versione 4).
**Da rivedere se:** la coda deve sopravvivere anche alla pulizia dei dati del sito (andrebbe sul server, come lo storico).

## 2026-10-11 — Coda dei download a turni fra utenti, senza tetto giornaliero

**Contesto:** voce 4.6 del piano: un'importazione da migliaia di brani di un utente faceva aspettare ore il brano singolo di un altro.
**Scelta:** la coda unica (`queue.Queue`) diventa `Turni` in `app.py`: una fila per utente (dal campo `by` del lavoro) e un giro; ogni esecutore prende il primo lavoro dell'utente di turno, che torna in fondo al giro. Stessa interfaccia (`put`, `get`, `qsize`), quindi federazione e scelta non cambiano. I download finiti da più di 30 giorni escono da memoria e database nel giro orario (`pota_lavori`), tranne quelli da controllare o in attesa di una playlist.
**Alternative scartate:** tetto giornaliero per utente (con i turni chi importa tanto rallenta solo sé stesso; un tetto avrebbe chiesto un'impostazione in più e un messaggio d'errore per un caso che non si presenta fra amici); priorità ai download singoli sulle importazioni (un'importazione è comunque di qualcuno che aspetta).
**Conseguenze:** il ritmo verso YouTube (un video ogni 12 s, fra tutti) resta lo stesso: i turni cambiano l'ordine, non la velocità totale. Abbonamenti: ogni giro è un gruppo a sé (`sub:<pid>:<ora>`), così ogni giro con brani nuovi ha il suo avviso (prima la chiave fissa lo faceva arrivare solo la prima volta).
**Da rivedere se:** il server ha molti utenti che importano insieme e qualcuno abusa.

## 2026-10-11 — Selezione multipla nella pagina, mix come pagine, download a mano riconosciuti su Deezer

**Contesto:** voci 6.8, 6.10 e 5.6 del piano.
**Scelta:** selezione con Ctrl/⌘ e Maiusc sul computer e «Seleziona» dal menu del brano sul telefono (tenere premuto apre già il menu), con una barra fissa di azioni; un ascoltatore in fase di cattura sulla vista intercetta i clic sulle righe solo con i tasti o a selezione aperta. I mix della Home aprono `#/mix`: `setQueue` riconosce che il clic veniva da una scheda del mix (`MixPage.want`, azzerato dopo l'azione) e mostra i brani invece di suonarli. Per i download a mano `metadati.riconosci_download` ricava artista e titolo (YouTube Music li dà, altrimenti «Artista - Titolo» o il canale ripulito) e cerca il brano su Deezer (titolo uguale, durata entro 8 s; se la ricerca strutturata è vuota, quella semplice), poi tag e copertina dell'album.
**Alternative scartate:** modalità di selezione con caselle su ogni riga sempre visibili (riempie le righe sul telefono); riscrivere ogni mix perché restituisca un elenco (cinque funzioni da cambiare per la stessa cosa); spostare il file nella cartella dell'album dopo il riconoscimento (la coda dei download segue il percorso: resta dov'è, con i tag giusti).
**Conseguenze:** un download a mano di una versione molto diversa (videoclip lungo) resta con artista e titolo puliti ma senza album.
**Da rivedere se:** si vogliono i download a mano ordinati nelle cartelle degli album come le importazioni.

## 2026-10-11 — Foto profilo servite solo a chi è collegato; utenti ricontrollati ogni giorno

**Contesto:** l'utente vuole personalizzare la propria utenza con una foto. Dal piano: utenti eliminati o declassati su Navidrome restavano attivi in Armony.
**Scelta:** la foto la ritaglia e riduce il client (256 px JPEG); il server la salva in `data/armony/avatar/` con un nome dall'impronta del nome utente e la dà su `/api/avatar/<utente>` solo con una sessione; il client la tiene come blob e la dipinge su tutti gli avatar (`.pav[data-u]`), e un messaggio `avatar` sul canale dal vivo la fa ricaricare a tutti. `dispositivi.ricontrolla` una volta al giorno revoca i dispositivi degli utenti spariti da Navidrome e allinea il ruolo di amministratore; con Navidrome irraggiungibile o senza amministratore non tocca niente.
**Alternative scartate:** foto pubbliche per indirizzo (si vedrebbero da internet conoscendo i nomi utente); Gravatar o servizi esterni; foto nel database (pesa sul database e sui suoi backup per niente).
**Conseguenze:** la prima apertura di una pagina con molti amici fa una richiesta per foto (poi in memoria).
**Da rivedere se:** gli utenti diventano centinaia (allora un'unica richiesta con le foto in miniatura).

## 2026-10-11 — Fra amici: playlist collaborative, «Manda a un amico», mix di due amici, cambio password

**Contesto:** fase 7 del piano: il gruppo di amici sullo stesso server.
**Scelta:** `server/amici.py`, migrazione 13 (`collab`, `mandati`). Collaborative: Navidrome fa modificare solo il proprietario, quindi le aggiunte dei collaboratori le fa Armony come amministratore di Navidrome (sotto `importa.plock`), togliere e riordinare usano le rotte già esistenti con il permesso esteso ai collaboratori; con almeno un collaboratore la playlist diventa pubblica su Navidrome (i collaboratori la leggono anche dalle app Subsonic) e il filtro «solo le proprie» la lascia vedere a chi collabora. «Manda a un amico» è una riga in `mandati` più una notifica. Il mix di due amici usa gli scrobble di Navidrome degli ultimi 180 giorni e solo con chi condivide i propri ascolti; affinità = coseno fra i conteggi per artista. Cambio password: vecchia verificata su Navidrome, nuova scritta con l'API nativa, credenziali Subsonic nuove ai dispositivi dell'utente sul canale dal vivo.
**Alternative scartate:** collaboratori come proprietari multipli su Navidrome (non esiste); mandare un brano come link di condivisione (scade, vale per chiunque, non arriva come avviso); mix calcolato nel client (non ha gli ascolti dell'altro); lasciare il cambio password a Navidrome (la sua pagina non è più raggiungibile da fuori, e i dispositivi restavano con credenziali vecchie, poi fermati dal limite dei tentativi).
**Conseguenze:** una playlist collaborativa è visibile a tutti gli utenti del server (ma non modificabile da chi non collabora). Le credenziali nuove viaggiano sul canale dal vivo dei dispositivi dell'utente, come quelle dell'abbinamento.
**Da rivedere se:** Navidrome aggiunge collaboratori nativi, o serve una playlist collaborativa non visibile agli altri.

## 2026-10-11 — Notifiche sul canale dal vivo, senza push

**Contesto:** l'utente chiede notifiche su web e Android. Le notifiche push passano da servizi esterni (Firebase per Android, i server push dei browser per Web Push) con chiavi e account: già scartate per l'app (voci del 2026-10-10).
**Scelta:** `server/notifiche.py`: tabella `notifiche` per utente (migrazione 12), creata dove nasce l'evento (fine di un download o di un gruppo in `jupdate`, Jam visibile aperta, dispositivo in attesa), mandata sul canale `/api/live`; campanella e pagina Notifiche nel client; con la pagina nascosta, avviso di sistema (Notification API del browser, plugin `ArmonyFiles.notify` su Android, canale «Avvisi»). Preferenze per tipo e per dispositivo.
**Alternative scartate:** Firebase Cloud Messaging (servizio e chiavi esterni, Google Play Services); Web Push con VAPID (meno esterno, ma passa comunque dai server dei browser: resta nel piano, voce 9.7, da proporre); polling continuo dal client (batteria).
**Conseguenze:** con app o browser chiusi del tutto gli avvisi non arrivano, restano nella campanella. Su Android arrivano mentre l'app è aperta o in riproduzione in sottofondo.
**Da rivedere se:** si fa il canale nativo leggero (voce 2.9/9.6) o l'utente accetta Web Push.

## 2026-10-11 — Ricerca fuori libreria, popolari e nuove uscite da Deezer; ReplayGain misurato da Armony

**Contesto:** Cerca era un vicolo cieco per ciò che non è in libreria; «Popolari» vuoto senza Last.fm; volume diverso fra i brani scaricati.
**Scelta:** `/api/catalogo`, `/api/popolari`, `/api/novita` usano la stessa API pubblica di Deezer già usata per metadati e discografie (cache limitata, 9 richieste al secondo), con il riconoscimento della libreria di `importa.Lib`. Anteprime di 30 s dai server di Deezer, nel client. Dopo ogni download `ffmpeg ebur128` misura il volume e `metadati.scrivi_replaygain` scrive i tag (riferimento −18 LUFS); per la libreria già presente uno script da lanciare a mano (`deploy/normalizza.py`), perché modifica i file dell'utente.
**Alternative scartate:** Spotify Web API (scartata nel 2026-10-09); calcolare il volume nel client (ogni dispositivo rifarebbe il lavoro, e Navidrome non lo saprebbe); normalizzare la libreria in sottofondo da solo all'avvio (modificherebbe migliaia di file senza che l'utente lo chieda).
**Conseguenze:** le anteprime partono da internet (Deezer) e non dal server; un download aggiunge ~3 s di analisi.
**Da rivedere se:** Deezer chiude o limita l'API pubblica.

## 2026-10-11 — Riordino a mano delle playlist, anche importate

**Contesto:** le playlist non si riordinavano; quelle importate tornavano all'ordine di Spotify a ogni brano nuovo.
**Scelta:** `POST /api/playlist/ordina` riscrive la playlist con `scrivi` (prima aggiunge, poi toglie) dopo aver controllato che le voci siano le stesse; nelle importate segna `manual` nello stato, e la riconciliazione da lì aggiunge i brani nuovi in fondo invece di riordinare. Nel client un foglio con maniglie da trascinare (pointer events, niente librerie) e frecce da tastiera.
**Alternative scartate:** trascinare direttamente nelle righe della pagina (conflitti con il tocco che suona e col tenere premuto per il menu); spostare con `updatePlaylist` voce per voce (Subsonic non ha lo spostamento: una rimozione e un'aggiunta per brano).
**Conseguenze:** una playlist importata riordinata non torna più all'ordine di Spotify.
**Da rivedere se:** Navidrome aggiunge lo spostamento delle voci all'API.

## 2026-10-11 — Telefono riorganizzato come Spotify (ribalta le voci sul lettore a due righe e su «Altro»)

**Contesto:** l'utente chiede di riorganizzare l'app sul telefono «prendendo super spunto da Spotify moderno»: voci, disposizione e interazioni col lettore. Ribalta tre scelte: «Telefono: navigazione in basso, attaccata al lettore» (2026-10-08, che aveva scartato «lettore a una riga con i comandi solo in In riproduzione»), «Telefono: … lettore che si riduce» (2026-10-09) e «Radio sezione a sé, barra in basso scelta dall'utente» (2026-10-10) per la parte «"Altro" sempre ultimo».
**Scelta:** sul telefono (≤860 px): intestazione con l'iniziale dell'utente che apre un **menu del profilo** da sinistra (sezioni fuori dalla barra, server e qualità, tema, barra in basso); la barra in basso ha solo le sezioni scelte, senza «Altro». **Mini lettore** a una riga: scheda col colore della copertina (`--mini` da `Glow`), copertina quadrata, titolo e artista (o il dispositivo che suona), «Dove suona», cuore, ▶, linea d'avanzamento; scorrere a sinistra/destra cambia brano, in su apre il lettore. **Lettore a tutto schermo** su `#/ora`: niente intestazione né sezioni (`data-r="ora"`), il lettore in basso diventa il pannello comandi grande (stessi elementi, altra griglia CSS, niente doppioni di logica), in alto «In riproduzione da …» (`S.ctx`, salvato con la coda) e ⋯ con timer, velocità, equalizzatore, qualità. Tenere premuto un brano apre il suo menu dal basso. Libreria a elenco con «+». Computer invariato.
**Alternative scartate:** un secondo lettore a tutto schermo con i suoi comandi (doppia logica di posizione, onda, stati); togliere la scelta della barra (l'utente l'aveva voluta); copertina quadrata al posto del disco anche nel lettore grande (il disco è il segno di Armony: Spotify è il modello per disposizione e gesti, non per l'aspetto).
**Conseguenze:** prev/next, casuale e ripeti non sono più nel mini lettore: si cambiano brani scorrendo o dal lettore grande. Le pillole Jam/radio/timer restano in una riga sotto la scheda solo quando servono.
**Da rivedere se:** il telefono si usa in orizzontale o su tablet sopra gli 860 px.

## 2026-10-11 — Coda come Spotify, coda da telecomando, brani simili a fine coda

**Contesto:** «Aggiungi alla coda» finiva dopo tutta la playlist e da telecomando modificava una coda nascosta che non suonava (il «Da rivedere se» della voce sui dispositivi agganciati del 2026-10-09).
**Scelta:** `Q` in `armony.js`: i brani aggiunti a mano sono segnati `_q` e vanno dopo gli altri aggiunti a mano («Riproduci dopo»: subito dopo il brano in corso); da telecomando i comandi `enqueue`/`playnext` (capacità `liveq`) li mettono nella coda del dispositivo che suona. Il casuale ricorda l'ordine originale (`_o`) e lo ripristina. Il passaggio fra dispositivi porta casuale e ripeti. A fine coda `autoContinue` accoda 25 brani simili (`similar`, la stessa ricerca della radio del brano), segnati `_s`; preferenza `autoplay`.
**Alternative scartate:** una coda separata per i brani aggiunti a mano (due strutture da tenere allineate in Live, QSync e Jam); brani simili calcolati sul server (il client ha già la ricerca della radio).
**Conseguenze:** i segni `_q`/`_s`/`_o` non viaggiano nel passaggio fra dispositivi (wire): l'altro dispositivo vede una coda normale.
**Da rivedere se:** serve modificare la coda dell'altro dispositivo anche in altri modi (spostare, togliere).

## 2026-10-10 — Armony 0.23: decisioni del piano 2 prese dall'agente su mandato dell'utente

**Contesto:** l'utente ha chiesto di procedere con la 0.23 del piano (`docs/PIANO-2.md`) lasciando all'agente le sei decisioni aperte.
**Scelta:**
- *Client senza chiave* da «sempre» a «da casa e Tailscale» (setting `legacy` in produzione): tutti i dispositivi che entrano da internet avevano già la chiave; l'unico senza chiave era un browser di casa. In Sicurezza un avviso rosso se si torna a «sempre» con un indirizzo pubblico.
- *Navidrome solo su 127.0.0.1:4533* e versione fissa (0.64.2): da fuori si passa sempre da Armony (chiavi, revoche, permessi, limiti). Si amministra con un tunnel SSH.
- *Jam*: chi bussa senza chiave pubblica non riceve il segreto (prima gli arrivava in chiaro attraverso il server); host e ospite vedono la stessa impronta di quattro simboli della chiave con cui il segreto viaggia.
- *Tag firmati* con una chiave SSH dedicata ai rilasci (non quella di GitHub dell'utente; privata in `~gigi/.ssh/armony-rilasci`, pubblica in `deploy/allowed_signers`). L'aggiornamento verifica la firma con `/etc/armony/allowed_signers`; la prima volta lo copia dalla versione già installata (fiducia al primo uso), così i server degli amici non si bloccano. Niente `--force` sui tag.
- *Log dei container* a 3×10 MB; *pot* resta `latest` perché il PO Token deve seguire YouTube insieme a yt-dlp; coturn non fissato (non gira qui) ma con `--denied-peer-ip` per le reti private.
- *Permesso playlist diviso* (voce 7.2 del piano): **non fatto**. L'utente aveva chiesto esplicitamente che un non amministratore veda solo le playlist che ha creato; il suggerimento dell'esame del codice andava contro quella richiesta.
**Alternative scartate:** `ND_AUTHREQUESTLIMIT=0` su Navidrome (si perde la sua protezione; il limite per indirizzo e utente sta ora in Armony, solo per chi entra senza chiave); firmare con la chiave GitHub dell'utente (un furto della chiave darebbe insieme push e firma); rifiutare l'avvio senza `TURN_PASS` (Compose valuta le variabili anche dei profili spenti: si sarebbe rotto `up` per tutti).
**Conseguenze:** le app Subsonic di terze parti funzionano solo da casa o Tailscale; chi pubblica una versione deve firmare il tag (`git tag -s`). Se la chiave dei rilasci si perde, serve una versione con il nuovo `allowed_signers` installata a mano sui server (o `install-updater.sh`).
**Da rivedere se:** un amico ha bisogno di un'app Subsonic da internet (si torna a «sempre» per lui solo con un'app che supporta le chiavi), o i server degli amici diventano tanti da servire una firma con più chiavi.

## 2026-10-10 — Sessioni salvate come impronta, copie dei database e ritorno indietro negli aggiornamenti

**Contesto:** il database conteneva i token di sessione in chiaro ed era leggibile da tutti sull'host; nessuna copia automatica, e un aggiornamento fallito lasciava client nuovo con server vecchio.
**Scelta:** migrazione 11: token come SHA-256 (funzione `sha256` registrata su ogni connessione SQLite); permessi 600 sul file; giro orario che toglie le credenziali dagli abbinamenti scaduti e le sessioni scadute; copia notturna dei due database (API di backup di SQLite, coerente col WAL) e una prima di ogni aggiornamento, con ritorno automatico alla versione e all'immagine di prima se il server non risponde con la versione nuova entro 90 s.
**Alternative scartate:** cifrare il database (la chiave starebbe sullo stesso disco); ripristinare anche il database nel ritorno indietro (perderebbe quello che gli utenti hanno fatto nel frattempo: le migrazioni sono solo aggiunte e la versione vecchia le tollera).
**Conseguenze:** un ritorno indietro tiene il database già migrato.
**Da rivedere se:** una migrazione futura cambia colonne che la versione precedente usa.

## 2026-10-10 — Comandi fra dispositivi in una casella con conferma; credenziali sbagliate fermate prima di Navidrome

**Contesto:** il gemellaggio app–web restava instabile. Il registro ha mostrato due cause. (1) Un comando mandato mentre il canale del destinatario si riapriva andava perso. (2) Un telefono rimasto con la voce revocata (password vuota) ha chiesto a Navidrome un brano dopo l'altro, e Navidrome ha bloccato l'utente "gg" per troppi accessi falliti: per lui tutti i dispositivi arrivano dallo stesso indirizzo (Armony), quindi si è bloccato anche il computer.
**Scelta:** (1) `lcmds` in `app.py`: ogni comando ha un id e resta 30 s finché il destinatario non lo conferma (`/api/live/ack`); arriva col canale, nel "hello" di un canale riaperto o con `/api/live/stato?device=` che il client chiede ogni 5 s quando il canale non regge. Chi lo manda ne chiede lo stato (`?cmd=`), aspetta altri 5 s se il destinatario è collegato ma non l'ha preso, e prima di suonare lui lo annulla (`DELETE /api/live/cmd/<id>`); il client ignora i doppioni. Capacità "livecmd". (2) Nel proxy, credenziali vuote non arrivano a Navidrome e quelle rifiutate 3 volte (stesso indirizzo, utente e credenziali) si rifiutano qui per 5 minuti; il secondo tentativo sul codice 40 non si fa più per credenziali già rifiutate. All'avvio la coda che punta a una voce revocata passa a quella viva dello stesso server.
**Alternative scartate:** togliere il limite di Navidrome (`ND_AUTHREQUESTLIMIT=0`: serve ricreare il container di produzione e si perde la protezione contro chi prova le password); un WebSocket al posto dell'SSE (stessi problemi di rete, più codice, e waitress non lo gestisce); notifiche push native per l'app (servizi esterni).
**Conseguenze:** un dispositivo con il canale caduto riceve i comandi entro 5 s; chi sbaglia la password tre volte resta fermo 5 minuti con quelle credenziali, ma la password giusta è un’altra impronta e passa subito.
**Da rivedere se:** Navidrome legge l'indirizzo vero del client (X-Forwarded-For) per il suo limite, o l'app Android ottiene un canale nativo.

## 2026-10-10 — «Dove suona»: il client si riallinea da solo invece di chiedere «Risincronizza»

**Contesto:** passando la musica fra web e telefono serviva spesso «Risincronizza». Il canale SSE può cadere in silenzio (Funnel instabile, schermo spento): chi manda la musica non riceve la risposta, dopo 5 s conclude «non risponde» e suona anche lui, e da lì i dispositivi restano disallineati.
**Scelta:** prima di spostare la musica `Live.ready()` riapre il canale se non è sicuramente vivo e aspetta il "hello"; prima di suonare qui per mancata risposta `check()` chiede al server `GET /api/live/stato` (dispositivi e stati del momento, capacità "livestato") e, se l'altro ha risposto, diventa telecomando e rifà il proprio canale; un comando rifiutato perché il dispositivo non è collegato fa ripartire qui la coda che stava per andare là. Il canale si riprende anche quando la finestra torna in primo piano (`focus`).
**Alternative scartate:** conferme esplicite di ogni comando sul canale (un secondo giro di messaggi da gestire e lo stesso problema se il canale è sordo); notifiche push native per svegliare l'app Android (servizi esterni e chiavi, fuori dallo scopo).
**Conseguenze:** spostare la musica può aspettare fino a 4 s se il canale era morto; un dispositivo con l'app sospesa dal sistema continua a non rispondere finché non si riapre.
**Da rivedere se:** l'app Android tiene viva la WebView anche in pausa, o si aggiunge un canale nativo.

## 2026-10-10 — Proposte di «Da controllare» salvate (precisa la voce «Proposte … cercate in sottofondo»)

**Contesto:** le proposte vivevano solo in memoria: ogni riavvio del server rifaceva da capo un centinaio di ricerche su YouTube.
**Scelta:** si salvano in `settings` (`scelta_prop`, id → [candidato, quando]) a ogni proposta trovata e si ricaricano all'avvio; «niente di abbastanza vicino» vale un giorno, poi si ricerca.
**Alternative scartate:** una tabella nuova con migrazione (per un centinaio di righe basta la tabella delle impostazioni); tenere anche i «niente» per sempre (YouTube Music aggiunge brani).
**Conseguenze:** una proposta salvata può puntare a un video poi rimosso: la sostituzione fallisce e la riga offre «Riprova».
**Da rivedere se:** i brani da controllare diventano migliaia.

## 2026-10-10 — Tempo massimo sulle chiamate del client

**Contesto:** una pagina è rimasta per sempre sullo scheletro di caricamento: il tunnel del Funnel (indirizzo pubblico che cambia ogni 20–30 secondi) o un riavvio del server lasciavano una richiesta senza risposta, e `fetch` senza tempo massimo aspetta all'infinito.
**Scelta:** `netFetch` in `armony.js`: 20 s per le chiamate Subsonic, 30 s per `dlApi`, 45 s per `srvApi` (la ricerca dei candidati su YouTube può essere lenta), il triplo per le scritture; le letture si riprovano una volta dopo un secondo. Scaduto il tempo la pagina mostra «non risponde» con Riprova.
**Alternative scartate:** nessun tempo massimo (la pagina appesa); riprovare anche le scritture (un POST arrivato ma senza risposta si ripeterebbe); un tempo corto uguale per tutto (le ricerche di candidati e gli elenchi grandi lo superano).
**Conseguenze:** un server davvero appeso si scopre dopo circa 40 s (20 + 1 + 20) invece che mai.
**Da rivedere se:** una chiamata legittima supera questi tempi (il proxy chiude comunque a 30 s le chiamate JSON).

## 2026-10-10 — Proposte per «Da controllare» cercate in sottofondo, una alla volta

**Contesto:** con oltre cento brani da controllare, aprire «Scegli» per ognuno era troppo lento: l'utente vuole vedere subito la versione giusta quando c'è e farle partire tutte insieme.
**Scelta:** un thread del server (`scelta.proposte`) cerca un brano alla volta, con 2 secondi di pausa e rispettando la pausa di YouTube dopo un blocco; la proposta è il primo candidato sicuro, senza parole sospette, diverso dal file attuale e (se si conosce da Spotify) con la durata entro 4 s o il 3%. Le proposte restano in memoria; `POST /api/scelta/proposte` accoda le sostituzioni scelte. Una sostituzione finita segna il brano come controllato.
**Alternative scartate:** cercare dal client riga per riga quando la lista si apre (raffiche di ricerche a YouTube e lavoro perso chiudendo la pagina); sostituire da solo senza chiedere (una proposta può essere sbagliata e il file è di tutti).
**Conseguenze:** al primo avvio servono alcuni minuti per proporre cento brani; dopo un riavvio del server le proposte si ricercano.
**Da rivedere se:** YouTube limita le ricerche anche a questo ritmo, o le proposte servono anche fuori da «Da controllare».

## 2026-10-10 — Scelta del brano da scaricare: punteggio su più fonti, controllo dopo, origine nel file

**Contesto:** alcuni brani scaricati erano sbagliati: live con audio scarso, videoclip con intro parlata, versioni diverse. Chi ascolta non aveva modo di sapere da dove veniva un file né di correggerlo.
**Scelta:** `server/scelta.py`. Ricerca su YouTube Music (prima), YouTube e SoundCloud; ogni candidato prende un punteggio da titolo, artisti, durata attesa (dal manifesto Spotify quando c'è), canale ufficiale e parole che indicano un'altra versione (live, cover, remix, slowed…) solo se non stanno nella richiesta; niente espressioni regolari, parole normalizzate. Dopo il download `verifica()` confronta durata e bitrate e marca il lavoro «sospetto». L'origine (fonte, link, codec e bitrate di partenza) si scrive in un tag del file (`ARMONY_ORIGIN`), così resta col file anche se il DB si perde. «Scegli un'altra versione» riusa la stessa ricerca e sostituisce il file al suo posto con i tag copiati. Il file finale si sposta con `os.replace` da un nome temporaneo, mai scritto a metà dove Navidrome lo scansiona.
**Alternative scartate:** prendere il primo risultato di YouTube (era la causa delle live); un servizio di impronte audio come AcoustID (dipendenza e chiave esterna, e non dice se l'audio è scadente); tenere l'origine solo nel DB di Armony (si perde con un caricamento o un trasferimento del file).
**Conseguenze:** la ricerca manuale fa più richieste a YouTube (in parallelo); un brano davvero diverso dall'originale Spotify resta in «Da controllare» finché qualcuno dice «va bene così».
**Da rivedere se:** YouTube Music smette di rispondere alla ricerca per brani, o arriva una fonte con metadati affidabili (ISRC) direttamente nei risultati.

## 2026-10-10 — Un account, un nome: vale quello di Navidrome

**Contesto:** Navidrome accetta «GG» e «gg» come lo stesso utente, ma Armony usava il nome scritto al login: dispositivi, storico e riproduzione condivisa finivano sotto due utenti diversi e il web non vedeva l'app Android.
**Scelta:** al login il nome viene dalla risposta di Navidrome (`user.username`); all'avvio `unisci_nomi()` sposta sotto il nome vero le righe salvate con le maiuscole sbagliate.
**Alternative scartate:** confrontare i nomi senza maiuscole ovunque (decine di query da cambiare e un rischio a ogni rotta nuova).
**Conseguenze:** un nome scritto diverso al login non crea più un utente nuovo in Armony.
**Da rivedere se:** Armony gestisce utenti propri non presenti su Navidrome.

## 2026-10-10 — Utenti creati dall'amministratore con link di benvenuto; permessi applicati dal proxy

**Contesto:** l'utente vuole creare in fretta gli account degli amici, con playlist proprie, e che un utente non amministratore veda solo le playlist che ha creato; una sezione con cosa ogni utente può fare. Al primo ingresso l'amico deve scegliere la sua password, che sostituisce quella dell'account. Il codice d'invito per registrarsi da soli resta.
**Scelta:** `server/utenti.py`. L'amministratore crea l'utente su Navidrome con una password provvisoria casuale che nessuno vede e riceve un codice di benvenuto monouso (24 ore, `pairings.welcome`, migrazione 10): link `#/benvenuto/<codice>` per il browser, lo stesso come QR per l'app. Chi lo apre sceglie la password (`POST /api/benvenuto`, che la scrive su Navidrome come amministratore) e riceve il "grant" del primo accesso fidato già usato dagli inviti. Permessi per utente in `perms` (colonne di prima più `more` in JSON) con un elenco unico (`PERMS`), presenti in `g.who["perm"]` e in `/api/me`; il proxy rifiuta createPlaylist/updatePlaylist/deletePlaylist e le condivisioni a chi non può e toglie da getPlaylists/getPlaylist (JSON e XML) le playlist degli altri a chi non ha «vede le playlist degli altri» (spento di base). Corretto un difetto latente: un dispositivo abbinato ereditava il ruolo di amministratore di chi aveva creato il codice, anche per un altro utente.
**Alternative scartate:** mandare all'amico una password scelta dall'amministratore (la conoscerebbero in due e viaggerebbe in chat); filtrare le playlist solo nell'interfaccia (le app Subsonic le vedrebbero comunque); playlist private per tutti forzate su Navidrome (cambierebbe i dati degli utenti invece della vista); un codice d'abbinamento con dentro le credenziali Subsonic (resterebbe valida la password provvisoria).
**Conseguenze:** un utente senza «vede le playlist degli altri» non vede neanche quelle pubbliche dell'amministratore; i permessi di un client senza chiave si riconoscono dal nome utente. Il link vale una volta: se l'amico sbaglia dispositivo serve un link nuovo.
**Da rivedere se:** Navidrome aggiunge permessi per utente sulle playlist, o servono gruppi di utenti con gli stessi permessi.

## 2026-10-10 — Navidrome occupato: secondo tentativo sul codice 40; più thread e connessioni

**Contesto:** il registro eventi ha mostrato brani saltati ("non riproducibile") e «utente o password errati» con credenziali giuste, negli stessi minuti in cui Navidrome scansionava i download e riscriveva playlist; e il server saturo (96 thread su 96, limite di 100 connessioni) mentre Navidrome si riavviava, con le chiamate JSON del proxy appese fino a 10 minuti.
**Scelta:** il proxy riprova una volta, dopo 0,8 s, le risposte d'errore brevi con codice 40 (JSON o XML); lo stesso fa `nd_get` e il lettore riprova una volta un brano che non parte prima di saltarlo. Timeout di lettura di 30 s per tutto tranne flussi, scaricamenti e copertine; 160 thread, 1000 connessioni (dal Funnel ogni copertina è una connessione), pool di 64 connessioni verso Navidrome.
**Alternative scartate:** ridurre scansioni e riscritture (servono per vedere subito i download); un secondo tentativo su ogni errore (rallenterebbe le password davvero sbagliate più del necessario).
**Conseguenze:** una password davvero sbagliata risponde 0,8 s più tardi.
**Da rivedere se:** Navidrome smette di rispondere 40 quando il suo database è occupato.

## 2026-10-10 — Canale inverso per i server dietro NAT; abbonamenti alle playlist; mix del giorno dallo storico

**Contesto:** l'utente vuole una rete fra server a maglia o a stella secondo come ognuno esce su internet. Un server dietro NAT o CGNAT poteva chiamare gli altri, ma nessuno poteva chiamare lui: la sua libreria restava invisibile. Chiede anche di completare il piano: abbonamenti (sincronizzazione selettiva), mix in stile Daily Mix, cache di Navidrome.
**Scelta:** ribalta «Relay propri per server non raggiungibili» (alternativa scartata in *Federazione: forma generale*, 2026-10-08) e «Niente relay propri» di `docs/FEDERAZIONE.md` §6, per richiesta esplicita. Canale inverso fra amici: la foglia tiene in attesa una richiesta firmata verso un vicino raggiungibile, che ci mette le richieste per lei già firmate; la foglia le esegue sul proprio server (stessa verifica di sempre) e rimanda le risposte a pezzi da 512 kB. Scelta automatica in `fed_req` (canale se il diretto non risponde da 30 minuti, prova diretta in sottofondo ogni 10), decisa dalla foglia leggendo `ti_raggiungo` nel catalogo e ricordata dopo i riavvii. Abbonamenti a playlist **pubbliche** (`fed_subs`, migrazione 9) realizzati come importazioni: la riconciliazione di `importa.py` tiene la playlist locale uguale a quella remota e i mancanti si copiano. Mix del giorno nel client: artisti più ascoltati del mese, brani loro e degli artisti ascoltati nelle stesse sessioni, poi i simili di Deezer in libreria e lo stesso genere, mescolati con un seme del giorno. Cache di Navidrome: transcodifica 2 GB, copertine 500 MB.
**Alternative scartate:** un relay di servizio pubblico (costi e responsabilità per chi lo gestisce: qui il centro è il server di un amico, scelto da chi si collega); WebSocket (waitress non li gestisce); far passare l'audio intero in una sola richiesta del canale (waitress bufferizza il corpo: a pezzi la memoria resta limitata); copiare anche le playlist private (privacy); mix calcolati sul server (servirebbe uno storico che il client ha già); i simili di Navidrome da soli (senza Last.fm non ne dà).
**Conseguenze:** un server raggiungibile può fare da centro per molte foglie: un thread di waitress per foglia e la banda dei brani che passano. Una foglia dietro NAT vede e si fa vedere solo attraverso i vicini raggiungibili. Ricreare il container di Navidrome per la cache una volta.
**Da rivedere se:** un centro regge troppe foglie (allora un limite per centro o flussi contati per foglia), o waitress viene sostituito da un server con WebSocket.

## 2026-10-10 — Importazioni ricordate dal server e riconciliate a ogni giro; riconoscimento sul DB di Navidrome

**Contesto:** dopo l'importazione le playlist restavano quasi vuote (GgHerz 10 brani su 940, GGroove 8 su 494) con 700 brani già in libreria: i lavori nati prima di `plserver`, o importati da un altro dispositivo, non sapevano in che playlist andare, e il telefono che li ricordava doveva restare aperto. Il riconoscimento dal telefono faceva 900 `search3` in sequenza in 5G.
**Scelta:** `server/importa.py`. Il client legge il file e crea la playlist (così è dell'utente), il server riconosce i brani leggendo il DB di Navidrome (ISRC, poi titolo normalizzato Unicode con e senza parentesi + artista; la durata sceglie fra più candidati, non esclude), ricorda l'elenco in `imports` (migrazione 8) e a ogni giro riscrive la playlist nell'ordine del file se è cambiata, con i brani aggiunti a mano in fondo. Lo stato (in libreria, in download, non trovati) si mostra nella pagina della playlist. Ribalta l'alternativa scartata «abbinamento per titolo/artista/durata (può sbagliare, richiede il client)» della voce *Playlist dei brani importati completate dal server* (2026-10-10): ora lo fa il server, e il percorso del file resta la prima prova per i brani scaricati da lì.
**Alternative scartate:** continuare con `pids` sui lavori (non copre i brani già in libreria né le importazioni vecchie); far creare la playlist all'amministratore di Navidrome (sarebbe sua, non dell'utente); solo aggiungere in fondo senza riordinare (l'ordine di Spotify si perde); togliere i brani che non sono nel file (si perderebbero quelli aggiunti a mano).
**Conseguenze:** una playlist importata non può tenere doppioni voluti; un brano con titolo diverso in libreria (traduzione, altro nome) resta «da scaricare». La riscrittura usa `updatePlaylist` come amministratore (vale anche per le playlist degli altri utenti; `createPlaylist` con `playlistId` lo rifiuta), con un lock per playlist; avviene al primo giro dopo un'importazione, quando arriva un brano nuovo o ci sono doppioni. Un brano del file tolto a mano non torna (lo stato ricorda cosa ha messo la riconciliazione) finché non si reimporta il file; un riordino fatto a mano resta fino al brano nuovo successivo. Le funzioni del client per i server senza `importsrv` (`matchTrack`, `pending`) restano per i server vecchi.
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
