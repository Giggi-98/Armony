# Piano di lavoro 2 — dopo la 0.22.6 (2026-10-10)

Obiettivo: Armony che sostituisce Spotify del tutto, stabile su telefono in 5G e via Funnel, sicura
con il server esposto su internet, e più «sociale» per il gruppo di amici.

Nasce da un esame completo del codice (riproduzione e dispositivi; libreria e contenuti; social,
amministrazione, sicurezza e gestione) e dal registro eventi di produzione. Non ripropone le strade
già scartate in `DECISIONS.md` (riproduzione nativa Media3, push, WebSocket, Spotify Web API,
AcoustID, Prometheus…); dove ne riapre una, cita il suo «Da rivedere se».

Legenda: **peso** alto/medio/basso · **sforzo** S (ore) / M (giorno) / L (più giorni).
Le voci marcate **[chiedere]** cambiano la produzione in modo visibile o toccano la crittografia della
Jam: vanno decise con l'utente prima di scriverle (CLAUDE.md).

---

## Fase 1 — La musica non si ferma (affidabilità della riproduzione)

Quello che si sente di più sul telefono in 5G col Funnel che cade.

| # | Cosa | Perché | Peso | Sforzo |
|---|---|---|---|---|
| 1.1 | **Controllo degli stalli**: su `waiting`/`stalled`, se dopo 8 s il tempo non avanza si ricarica lo stesso brano dallo stesso punto | Oggi una connessione appesa lascia silenzio con l'interfaccia «in riproduzione», anche per minuti (nessun ascoltatore di `stalled`) | alto | S |
| 1.2 | **Nuovi tentativi senza limite sugli errori di rete** (1, 2, 4… fino a 30 s) e ripresa subito all'evento `online`; si salta il brano solo per errori di formato | Oggi si riprova una volta: al secondo calo di rete il brano si salta, al terzo la musica si ferma | alto | S |
| 1.3 | **Server irraggiungibile ma telefono «online»**: prova rapida all'avvio (3 s) e, se non risponde, banner «suono i brani sul dispositivo» con Offline/cache | Oggi si aspettano ~40 s e poi errori | medio | M |
| 1.4 | Offline o rete giù: dopo un errore si salta al prossimo brano **disponibile** (offline o in cache), non al successivo qualunque | Tre errori di fila fermano la musica anche se più avanti ci sono brani salvati | medio | S |
| 1.5 | La cache dei brani vale per **qualunque qualità** già scaricata (Wi-Fi → 5G) | Con «qualità in rete mobile» diversa la cache fatta in Wi-Fi viene ignorata proprio in 5G | medio | S |
| 1.6 | Tempo massimo e ripresa con `Range` per cache dei brani e salvataggi offline; un errore Subsonic (JSON) non si salva mai come brano | `fetch` senza tempo massimo blocca la coda dei salvataggi; Offline può salvare un errore come brano | medio | S |
| 1.7 | **Scrobble in coda** se falliscono (offline, server giù) e rimandati al ritorno della rete | Oggi gli ascolti fatti senza rete non arrivano mai al server | medio | S |
| 1.8 | AudioContext sospeso mentre suona → `resume()` automatico (da collaudare sul telefono) | Possibile silenzio con la barra che avanza dopo un cambio di uscita Bluetooth | medio | S |
| 1.9 | Togliere dalla coda il brano in corso passa al successivo invece di fermare tutto | `Engine.stop()` sul brano corrente | basso | S |

## Fase 2 — Un account, tutti i dispositivi (gemellaggio, coda, Android)

Continua il lavoro della 0.22.6 (casella dei comandi con conferma).

| # | Cosa | Perché | Peso | Sforzo |
|---|---|---|---|---|
| 2.1 | **«Aggiungi alla coda» e «Riproduci dopo» da telecomando** arrivano al dispositivo che suona (comandi `enqueue`/`playnext` in `/api/live/cmd`, nuova capacità) | Oggi da telecomando modificano una coda nascosta che non suona. È il «Da rivedere se» della decisione del 2026-10-09 | alto | M |
| 2.2 | **Ordine della coda come Spotify**: i brani aggiunti a mano vanno dopo gli altri aggiunti a mano, prima del resto; sezione «Prossimi in coda» separata | Oggi «in coda» va in fondo a 900 brani e più «Riproduci dopo» si rovesciano | medio | S/M |
| 2.3 | **Posizione salvata alla chiusura** (`pagehide` con `keepalive`) e ogni 30 s mentre suona; un dispositivo messo in pausa da un altro non sovrascrive la coda sul server | «Continua su un altro dispositivo» riprende da minuti prima | medio | S |
| 2.4 | Lo spostamento porta anche **casuale e ripeti**; spegnendo il casuale torna l'ordine originale | Si perdono a ogni passaggio | basso | S |
| 2.5 | Due dispositivi che partono quasi insieme: cede solo chi ha cominciato prima (ora del server) | Oggi possono fermarsi a vicenda | basso | S |
| 2.6 | **Android: la WebView che muore non chiude l'app** (`onRenderProcessGone` → ricrea e riprende) | Con poca memoria a schermo spento l'app crasha e la musica si ferma | medio-alto | S |
| 2.7 | **Android: cuffie staccate = pausa immediata** (`ACTION_AUDIO_BECOMING_NOISY`) e audio focus esplicito (chiamate, navigatore) da collaudare | Oggi la pausa arriva dopo un frammento dall'altoparlante | medio | S |
| 2.8 | **Android: sessione multimediale pronta all'avvio** (play dalle cuffie o dall'auto con l'app appena aperta), `setQueue` e azioni personalizzate (cuore, casuale) nella notifica | Senza un primo play i tasti delle cuffie non fanno niente | medio | M |
| 2.9 | **Android in pausa a schermo spento raggiungibile da «Dove suona»**: canale nativo leggero nel servizio (battito e richiesta dei comandi ogni 60 s con AlarmManager inesatto) | Il telefono in pausa sparisce dopo 2 minuti; è il «Da rivedere se» delle decisioni del 2026-10-10. Consumo di batteria da misurare | medio | L |
| 2.10 | Il canale dal vivo resta sul server «di casa» anche cambiando server attivo | Cambiando server si sparisce da «Dove suona» | basso | M |

## Fase 3 — Sicurezza col server su internet

Il registro e la configurazione reale di produzione hanno mostrato rischi concreti.

| # | Cosa | Perché | Peso | Sforzo |
|---|---|---|---|---|
| 3.1 | **[chiedere]** Client senza chiave da «sempre» a «da casa e Tailscale», con avviso rosso in Sicurezza finché resta «sempre» col Funnel attivo | Oggi è «sempre» per scelta esplicita: dal Funnel basta la password per tutta la libreria | alto | S |
| 3.2 | Limite di tentativi falliti per **(indirizzo, utente)** indipendente dalle credenziali (es. 5 in 10 min → attesa) | `BAD_AUTH` della 0.22.6 ferma le stesse credenziali ripetute, non chi prova password diverse; e Navidrome blocca l'utente per tutti | alto | S |
| 3.3 | **[chiedere]** Navidrome solo su `127.0.0.1:4533` | Oggi è su 0.0.0.0: dalla LAN (o da internet su un VPS) si salta tutto Armony: chiavi, revoche, permessi | alto | S |
| 3.4 | Limiti per indirizzo su segnalazione Jam pubblica (`open`/`send`/`recv`) e su `/api/chiave/sfida` | Senza account si possono esaurire i thread di waitress o bloccare i rinnovi delle sessioni | alto | S |
| 3.5 | **[chiedere]** Jam: rifiutare il «bussare» senza chiave pubblica quando la stanza ha un segreto e mostrare il codice di sicurezza nel dialogo «vuole entrare» | Oggi il segreto può passare in chiaro dal server se chi bussa omette la chiave; tocca `jam.js` | medio | S |
| 3.6 | Permessi letti dal **nome canonico** anche per le app Subsonic senza chiave | Scrivendo «GG» invece di «gg» un utente limitato torna ai permessi predefiniti | medio | S |
| 3.7 | Dispositivi con chiave ricontrollati su Navidrome una volta al giorno (utente eliminato o declassato → revoca o ruolo aggiornato) | Oggi un utente eliminato in Navidrome resta attivo in Armony | medio | S |
| 3.8 | `armony.db` con permessi 600, token di sessione salvati come hash, abbinamenti scaduti ripuliti delle credenziali | Il DB è leggibile da tutti sull'host e contiene sessioni in chiaro e 3 abbinamenti con token e sale | medio | S/M |
| 3.9 | Rifiutare `ARMONY_TOKEN` e password TURN d'esempio; TURN con `--denied-peer-ip` per le reti private | Valori d'esempio pubblici nel repo; TURN può fare da ponte verso la LAN | medio | S |
| 3.10 | «Nuovo link di benvenuto» (telefono perso) revoca anche i dispositivi attuali; link attivi elencati e annullabili | Oggi il telefono perso resta fidato | medio | S |
| 3.11 | Il backup «per un amico» non porta mai le credenziali di chi lo esporta | Oggi l'amico entra con l'account altrui | medio | S |
| 3.12 | Gettone breve dedicato per SSE e video al posto della sessione nell'URL; `/api/lan/*` e Jam vicine solo da casa | Sessioni in cronologia e log dei proxy; indirizzi LAN mostrati a internet | basso | S |
| 3.13 | **[chiedere]** Aggiornamenti solo da tag firmati (`git verify-tag` con chiavi fuori dal repo), niente `--force` sui tag | Un account GitHub compromesso dà root su tutti i server degli amici | alto | M |

## Fase 4 — Non perdere niente (gestione del server)

| # | Cosa | Perché | Peso | Sforzo |
|---|---|---|---|---|
| 4.1 | **Backup prima di ogni aggiornamento** (`sqlite3 .backup` di armony.db e navidrome.db, ultime N copie) e uno notturno; LEGGIMI con l'elenco esatto di cosa salvare (anche `identita.key` e la chiave dell'APK) | Migrazioni irreversibili, nessuna copia automatica | alto | S/M |
| 4.2 | **Ritorno indietro automatico** se la build o il controllo dopo l'avvio falliscono | Oggi un aggiornamento fallito lascia client nuovo e server vecchio | alto | S |
| 4.3 | **[chiedere]** Rotazione dei log Docker (10 MB × 3) e versioni fissate di Navidrome, pot e coturn | Log senza limiti; un `pull` di Navidrome può cambiare lo schema che Armony legge | medio | S |
| 4.4 | Avviso sul canale dal vivo prima di un riavvio e «aggiorna quando nessuno ascolta» | Un aggiornamento interrompe Jam e ascolti senza preavviso | medio | S |
| 4.5 | Tetto di canali dal vivo per utente e per indirizzo; chi occupa i thread si vede in Stato | Un client difettoso può esaurire i 160 thread | medio | S |
| 4.6 | Coda dei download **a turni fra utenti** e tetto giornaliero facoltativo per utente | L'importazione da 5000 brani di uno blocca tutti per ore | medio | M |
| 4.7 | Avvisi fuori dall'app (webhook facoltativo, es. ntfy/Telegram) per errori e stato | È il «Da rivedere se» della decisione sul registro: server pubblico con amici | basso-medio | S |
| 4.8 | Giro orario di manutenzione: sessioni scadute, dizionari in memoria, abbinamenti, eventi | Tabelle e dizionari che crescono senza pulizia | basso | S |

## Fase 5 — Libreria e download senza sorprese

| # | Cosa | Perché | Peso | Sforzo |
|---|---|---|---|---|
| 5.1 | **Riscrittura delle playlist importate sicura** (prima aggiungere, poi togliere; `put`/`gone` aggiornati solo se è andata) | Un errore a metà svuota la playlist e i brani tolti non tornano più | alto | S |
| 5.2 | **«Togli dalla playlist» per id**, non per posizione (ricontrollo sotto `plock`) | Con la riconciliazione o un altro dispositivo in mezzo si toglie il brano sbagliato | alto | S |
| 5.3 | **Soglia della scelta legata al titolo**: il bonus di fonte o canale si somma solo se il titolo somiglia | Un risultato di YouTube Music qualunque supera la soglia minima: si scarica un brano a caso | alto | S |
| 5.4 | Cache di Deezer e copertine con limite e scadenza; gli errori temporanei non restano «non trovato» | Memoria che cresce senza limite; discografie mai aggiornate | alto | S |
| 5.5 | «Da controllare» non perde i brani dopo «Rimuovi conclusi» o un riavvio | Oggi spariscono senza essere controllati | medio | S |
| 5.6 | Download da «Cerca online» e da link: metadati veri (non il canale YouTube), cartelle ordinate, controllo «già in libreria» | Libreria sporca proprio dove si cerca a mano | medio | M |
| 5.7 | «Liked Songs» importate: anche i brani arrivati dopo prendono il cuore | Playlist e Preferiti si allontanano | medio | S |
| 5.8 | Testi: ricerca di riserva su LRCLIB controllata per durata e titolo; testi salvati con gli offline; correzione della sincronia sul server | Oggi può mostrare il testo di un altro brano; la correzione vale su un dispositivo | medio | S |
| 5.9 | **Normalizzazione del volume per i download** (misura del loudness e tag ReplayGain) | Gran parte della libreria arriva da YouTube senza ReplayGain: il volume salta fra un brano e l'altro | alto | M |
| 5.10 | Caricamenti: controllo dei doppioni per contenuto e «completa i dati da Deezer» | Lo stesso brano entra due volte | basso | M |

## Fase 6 — Come Spotify: scoprire e ascoltare

| # | Cosa | Perché | Peso | Sforzo |
|---|---|---|---|---|
| 6.1 | **Cerca anche fuori dalla libreria**: sezione «Non in libreria» da Deezer, anteprima di 30 s, «Scarica»; corregge anche gli errori di battitura | Oggi un titolo assente o scritto male è un vicolo cieco | alto | M |
| 6.2 | **Riordinare le playlist** col trascinamento (anche sul telefono) e la coda | Le playlist non si riordinano; la coda solo sul computer | alto | M |
| 6.3 | **Continua con brani simili** a fine coda (acceso di base, brani segnati «suggeriti») | A fine coda la musica si ferma | medio | S |
| 6.4 | Gapless vero senza dissolvenza (avvio del brano successivo ~40 ms prima della fine) e niente dissolvenza fra brani consecutivi dello stesso album | Album live e concept hanno un buco; LEGGIMI promette «senza pause» | medio | M |
| 6.5 | **Nuove uscite** degli artisti che ascolti (controllo giornaliero su Deezer) in Home | Manca un «Release Radar» | medio | M |
| 6.6 | «Popolari» dell'artista anche senza Last.fm (Deezer top abbinato alla libreria, o ascolti del server); cuore agli artisti | La sezione è vuota su molti server | medio | S |
| 6.7 | **Cronologia** degli ascolti (brani, per giorno) e scaffale «Riascolta» | Esiste solo «ascoltati di recente» per album | medio | S |
| 6.8 | **Selezione multipla** (tieni premuto / Maiusc+clic) con azioni di gruppo | Oggi un brano alla volta o tutto l'elenco | medio | M |
| 6.9 | «Aggiunti di recente» nei Preferiti per data del cuore; «Aggiungi a playlist» con avviso doppioni e ricerca; playlist nella ricerca; ospiti (feat) raggiungibili | Rifiniture che Spotify ha | basso | S |
| 6.10 | Pagina dei mix con elenco e «Salva come playlist»; cartelle di playlist | I mix sono solo azioni | basso | S/M |

## Fase 7 — Insieme agli amici

| # | Cosa | Perché | Peso | Sforzo |
|---|---|---|---|---|
| 7.1 | **Playlist collaborative** (tabella Armony, modifiche eseguite come amministratore di Navidrome, attività «X ha aggiunto…») | Fra amici manca «aggiungete tutti» | alto | M |
| 7.2 | **[chiedere]** Permesso playlist diviso: le pubbliche sempre visibili, «vede tutte» a parte | Oggi «vede le playlist degli altri» spento nasconde anche le pubbliche (il «Da rivedere se» della decisione sugli utenti) | medio | S |
| 7.3 | **Blend**: un mix fatto con gli ascolti di due amici, con punteggio di affinità e rispetto della privacy | Funzione sociale chiave di Spotify; i dati ci sono | medio | M |
| 7.4 | Attività degli amici che sopravvive al riavvio e «ascoltato di recente» per ciascuno | Oggi si vede solo chi suona adesso | medio | S/M |
| 7.5 | **«Manda a un amico»** (brano, album o playlist a un utente del server, con avviso su Amici) e profilo dell'amico | Oggi solo link pubblici | medio | M |
| 7.6 | TURN configurato dal server con credenziali temporanee | Oggi si scrive a mano su ogni telefono | medio | M |
| 7.7 | Cambio password dentro Armony, con gli altri dispositivi avvisati | Oggi serve Navidrome o un link dell'amministratore | medio | M |
| 7.8 | Playlist pubbliche offerte ai server collegati solo col consenso | Oggi vanno a tutta la federazione | basso-medio | M |
| 7.9 | Riepilogo del gruppo («Il nostro mese») | C'è solo quello personale | basso | S/M |

## Fase 8 — Veloce anche con librerie grandi

| # | Cosa | Perché | Peso | Sforzo |
|---|---|---|---|---|
| 8.1 | `content-visibility` sulle righe, poi elenchi disegnati a blocchi (playlist, coda, artisti) | Una playlist da 2000 brani crea decine di migliaia di nodi | alto | S → M |
| 8.2 | Playlist aperta: controllo leggero di `changed` invece di ricaricarla intera ogni 20 s | Consuma dati e batteria in 5G | medio | S |
| 8.3 | Storico letto per intervallo (indice `ts`) per Home e mix | Con anni di ascolti Home e statistiche rallentano | medio | S |
| 8.4 | Pagina Scarica: riepiloghi tenuti aggiornati sul server, risposte con ETag; «Da controllare» in cache per scansione | Il server ricalcola tutto ogni 2 s per ogni client | medio | M |
| 8.5 | Cache dei brani: data d'uso salvata a parte (non riscrivere il file intero a ogni ascolto); coda in IndexedDB invece che in localStorage | Scritture inutili sulla memoria del telefono; coda persa se la quota si riempie | medio | S/M |
| 8.6 | A schermo spento niente disegni né calcoli della coda a ogni `timeupdate` | Batteria | basso | S |

---

## Stato

- **0.23.0 (2026-10-10)**: fatte 1.1, 1.2, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.3, 2.6, 2.7 (solo cuffie staccate; audio focus da collaudare), 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 3.9 (in parte: token d'esempio e TURN), 3.13, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 5.5, 8.1 (primo passo). Decisa e **non** fatta: 7.2 (va contro la richiesta dell'utente; vedi DECISIONS).
- **0.24.0 (2026-10-11)**: telefono riorganizzato come Spotify (menu del profilo, mini lettore, lettore a tutto schermo, Libreria a elenco, tieni premuto); 2.1, 2.2, 2.4, 6.3, 6.4 (solo niente dissolvenza nello stesso album; il gapless vero resta da fare).
- In più, fuori piano: telecomando con testi, dettagli e bande; utenti eliminati che ricomparivano.

## Ordine proposto

1. **Subito (0.23)**: 1.1, 1.2, 1.4, 1.5, 1.6, 1.7, 1.9, 2.3, 2.6, 2.7, 3.2, 3.4, 3.6, 3.8, 4.1, 4.2, 5.1, 5.2, 5.3, 5.4, 5.5, 8.1 (primo passo). Tutti di sforzo S, nessuna scelta da fare.
2. **Da decidere insieme**: 3.1, 3.3, 3.5, 3.13, 4.3, 7.2.
3. **0.24 — telecomando e coda come Spotify**: 2.1, 2.2, 2.4, 2.5, 2.8, 6.3, 6.4.
4. **0.25 — scoprire**: 6.1, 6.2, 6.5, 6.6, 6.7, 5.9.
5. **0.26 — amici**: 7.1, 7.3, 7.4, 7.5, 7.6, 7.7.
6. **Poi**: 2.9 (canale nativo Android), 2.10, 4.4–4.8, 5.6–5.10, 6.8–6.10, 7.8–7.9, resto della fase 8.
