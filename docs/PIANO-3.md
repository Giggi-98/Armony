# Piano 3 — dopo la 0.54

Fatto guardando tutte le funzioni (LEGGIMI.md), quello che resta del piano 2 e quello che è emerso nelle sessioni di
ottobre: i collaudi con più server veri hanno trovato difetti che a mano non si vedevano (canale che non si apriva con
«Solo lui vede me», catalogo che aspettava 20 minuti, simulazione della mappa che non si fermava, sessioni di prova che
scadevano). Da qui la prima fase.

Legenda: **impatto** alto/medio/basso per chi usa Armony; **sforzo** S (ore), M (un giorno), L (più giorni).
🔶 = c'è una scelta da fare insieme prima di scrivere codice.

## Fase A — Non rompere niente (collaudo e affidabilità)

| # | Cosa | Perché | Impatto | Sforzo |
|---|---|---|---|---|
| A1 | **Collaudo automatico a più server** nel repo (`deploy/collaudo.sh`): tira su 3–4 server isolati (Docker dentro Docker, come nelle prove di ottobre), li collega a maglia e a stella, prova collegamento, canale, catalogo, ascolto, collaboratori, trasferimento con e senza brani, e dice cosa è passato. Da lanciare prima di ogni tag | Ogni funzione della federazione ha avuto almeno un difetto visibile solo con più server; oggi il collaudo si rifà a mano ogni volta | alto | M |
| A2 | **«Scegli un'altra versione» su Yoga**: capire perché non va (manca la risposta dell'utente: errore, nessun risultato o tasto assente) e sistemarlo | Segnalato e ancora aperto | medio | S |
| A3 | **Servizio di sistema anche senza systemd** (WSL senza systemd, NAS, Docker Desktop): un piccolo container «guardiano» che fa quello che fa `armony-update.path` | Senza, il tasto «Aggiorna» e il trasferimento non funzionano: proprio su Yoga è successo | alto | M |
| A4 | **Prova del trasferimento prima di avviarlo**: versioni uguali, servizio di sistema attivo sul nuovo, spazio, raggiungibilità, ora dei due server; tutto in verde prima di «Avvia» | Il trasloco vero sul mini PC si fa una volta sola: meglio scoprire prima cosa manca | alto | S |
| A5 | **Copie di sicurezza incrociate fra amici** 🔶: ogni notte il DB (piccolo) va, cifrato con una chiave che resta a casa, a uno o due server collegati; da lì si ripristina se il disco muore | Oggi le copie stanno sullo stesso disco del server | alto | M |
| A6 | **Aggiornare Navidrome con un collaudo**: la versione è fissa (0.64.2) perché Armony legge il suo DB; un controllo automatico dello schema prima di alzarla | Prima o poi servirà, e un cambio di schema rompe statistiche e playlist importate | medio | S |

## Fase B — Ascolto

| # | Cosa | Perché | Impatto | Sforzo |
|---|---|---|---|---|
| B1 | **Gapless vero** (piano 2, 6.4): il brano dopo parte ~40 ms prima della fine, senza dissolvenza | LEGGIMI promette «senza pause»: album live e concept hanno un buco | medio | M |
| B2 | **Android Auto e cuffie all'avvio** (piano 2, 2.8): sessione multimediale pronta subito, libreria sfogliabile in auto | Per molti l'auto è il posto dove si ascolta di più | alto | L |
| B3 | **Suona sulle casse di casa** 🔶: il server manda la musica a casse e TV della rete (DLNA/UPnP, poi eventualmente Chromecast) e compaiono in «Dove suona» | Oggi si suona solo su dispositivi con Armony aperta | alto | L |
| B4 | **Telefono in pausa raggiungibile** (piano 2, 2.9) e **canale dal vivo sul server di casa** (2.10) | Il telefono in pausa sparisce da «Dove suona» dopo 2 minuti | medio | M |
| B5 | **Due dispositivi che partono insieme** (piano 2, 2.5): cede chi ha cominciato prima | Possono fermarsi a vicenda | basso | S |

## Fase C — Libreria

| # | Cosa | Perché | Impatto | Sforzo |
|---|---|---|---|---|
| C1 | **Playlist intelligenti**: regole (genere, anno, artista, ascoltati/mai ascoltati, aggiunti negli ultimi N giorni) che si aggiornano da sole; Navidrome le supporta già | Le chiedono tutti quelli che vengono da iTunes/Plex | alto | M |
| C2 | **Salute della libreria**: brani doppi (anche con nomi diversi), copertine mancanti, tag strani («NA», categorie YouTube), album spezzati in due, con «Sistema» uno per uno o in blocco | Oggi ci sono script da terminale (`normalizza.py`, `riallinea-spotify.py`): portarli nell'app | alto | M |
| C3 | **Importare playlist da un link** di YouTube Music, Deezer o Apple Music (oltre a Spotify con Exportify) | Exportify è un passaggio in più che gli amici non sanno fare | medio | M |
| C4 | **Podcast** 🔶: abbonamento con RSS, episodi scaricati sul server, posizione ricordata fra i dispositivi | Navidrome non li gestisce; molti usano una seconda app solo per quelli | medio | L |
| C5 | **Testi che mancano**: cercati da soli (LRCLIB, gratuito) e salvati accanto al brano | Molti brani scaricati non hanno testo | medio | S |

## Fase D — Amici e federazione

| # | Cosa | Perché | Impatto | Sforzo |
|---|---|---|---|---|
| D1 | **Collaboratori da altri server completi**: anche togliere e riordinare; i brani aggiunti dal collaboratore ascoltabili anche da lui (oggi «non ascoltabile da qui») | Due limiti scritti in DECISIONS alla 0.52 | medio | M |
| D2 | **Jam fra server diversi** 🔶: un amico di Yoga entra nella Jam di casa; segnalazione e orologio passano dalla federazione, ognuno ascolta dal proprio server o dalla federazione | Oggi la Jam «tramite il server» vale solo per chi ha un account lì | alto | L |
| D3 | **TURN dal server** (piano 2, 7.6): credenziali temporanee date dal server, niente da scrivere sui telefoni | Oggi indirizzo e password si scrivono a mano su ogni telefono | medio | M |
| D4 | **Mappa con la storia**: per ogni collegamento le ultime 24 ore (in linea, spento, diretto o canale), più di due salti di distanza | Per capire perché un amico «a volte non c'è» | basso | M |
| D5 | **ListenBrainz/Last.fm per utente**: ognuno collega il suo account dal Profilo e gli ascolti vanno lì (Navidrome lo sa già fare) | Chi usa quei servizi oggi perde gli ascolti fatti con Armony | medio | S |
| D6 | **Il vostro anno** (stile Wrapped): a dicembre, dalle statistiche, una pagina da condividere con gli amici del server e della federazione | Le statistiche ci sono già; è il modo più amato di guardarle | medio | M |

## Fase E — Piattaforma

| # | Cosa | Perché | Impatto | Sforzo |
|---|---|---|---|---|
| E1 | **`armony.js` in più file** caricati in ordine, come già `jam.js` (federazione, trasferimento, notifiche, impostazioni), senza bundler (DECISIONS) | Quasi 6800 righe in un file: ogni modifica rischia di toccare il vicino | medio | M |
| E2 | **Interfaccia in inglese** 🔶 (italiano resta quello di base) | Per gli amici all'estero e per chi trova il progetto su GitHub | medio | L |
| E3 | **Notifiche web a browser chiuso** (piano 2, 9.7) 🔶: Web Push con chiavi del server, riapre la decisione «niente push» solo per il web | Sul web gli avvisi arrivano solo con la pagina aperta | basso | M |
| E4 | **Controllo di accessibilità**: tastiera ovunque, lettori di schermo sulla mappa e sui menu nuovi, contrasti nei due temi | Le sezioni nuove (mappa, menu a gruppi) sono state fatte in fretta | basso | S |

## Ordine proposto

1. **0.55 — prima del trasloco a casa**: A1, A2, A3, A4. Il collaudo automatico prima di tutto: protegge ogni rilascio dopo.
2. **0.56 — libreria**: C1, C2, C5.
3. **0.57 — ascolto**: B1, B5, B4.
4. **Da decidere insieme**: A5 (dove vanno le copie e con che chiave), B3 (DLNA sì, Chromecast forse), C4, D2, E2, E3.
5. **Poi**: B2 (Android Auto, va collaudato sul telefono e in auto), C3, D1, D3–D6, E1, E4, A6.
