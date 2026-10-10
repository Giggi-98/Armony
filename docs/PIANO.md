# Piano di lavoro — notte del 2026-10-10 (Armony 0.18.2 → 0.19.0)

Obiettivo dell'utente: un'app che renda Spotify inutile, che non si blocchi, con un registro per
trovare i guasti, un monitor delle risorse del server, playlist importate che corrispondono alla
realtà e avvio rapido anche in 5G.

## Cosa ho trovato studiando il codice

| # | Problema | Causa | Peso |
|---|---|---|---|
| 1 | Playlist importate quasi vuote (GgHerz 10 brani su 940, GGroove 8 su 494, GigItaly 0 su 70) | I brani **sono già in libreria** (711, 387, 69), ma le playlist le completava il telefono che aveva importato (`pending` nel localStorage): a app chiusa o su un altro dispositivo non succede niente. I lavori sul server non hanno le playlist (`pids`) | alto |
| 2 | Importare 900 brani dal telefono è lento | Il client fa una `search3` per brano, in sequenza, sul 5G | alto |
| 3 | Dopo un riavvio del server riprendono solo gli ultimi 200 download | `resume_jobs()` legge `LIMIT 200` | alto |
| 4 | Scelte sbagliate da YouTube («Door Hinges» → un video su come montare un fermaporta) | Il punteggio sceglie sempre il migliore, anche se pessimo | medio |
| 5 | I log del container sono illeggibili | yt-dlp stampa l'avanzamento (`quiet` non basta, serve `noprogress`) | medio |
| 6 | Nessun modo di vedere errori del client o del server senza la console | Le eccezioni vengono inghiottite (`except: pass`) | alto |
| 7 | Nessuna idea del carico del server | Manca un monitor; 96 thread di waitress senza contatore | medio |
| 8 | Avvio lento in 5G | Shell del service worker "prima la rete" (570 kB senza compressione a ogni apertura del browser); JSON senza gzip; nessuna cache dei brani: ogni brano, anche già ascoltato, riparte dalla rete | alto |

## Fasi

### Fase 1 — Vedere cosa succede (server)
- **Registro eventi**: errori e ambiguità di server e client in SQLite (migrazione 8), con
  raggruppamento dei ripetuti; `POST /api/log` per i client, lettura ed esportazione per
  l'amministratore. Impostazioni → Server → *Registro eventi*.
- **Stato del server**: CPU, memoria, carico, disco, rete, thread di waitress occupati, flussi audio
  in corso per utente, dispositivi collegati, coda dei download; ultima ora a 5 s e ultime 24 ore a
  1 minuto. Impostazioni → Server → *Stato del server*.
- Log del container puliti (`noprogress`).

### Fase 2 — Importazioni che corrispondono alla realtà
- **Importazione sul server** (`POST /api/import/playlist`): il client manda il CSV già letto, il
  server riconosce i brani sul DB di Navidrome (ISRC, poi titolo + artista + durata) in un attimo,
  crea o aggiorna la playlist, mette in coda i mancanti e **ricorda l'elenco** (migrazione 8).
- **Riconciliazione continua**: un thread rimette le playlist importate nell'ordine del CSV appena un
  brano entra in libreria, da qualunque parte arrivi; i brani aggiunti a mano restano in fondo.
- Stato per playlist: *in libreria / in download / non trovati*, nella pagina della playlist.
- Download ripresi tutti dopo un riavvio; soglia minima di somiglianza per i risultati di YouTube.
- Applicata subito alle playlist esistenti con i CSV in `spotify_playlists/`.

### Fase 3 — Velocità
- gzip sulle risposte JSON e sui file del client; service worker "prima la cache" con aggiornamento
  in sottofondo (la versione nuova arriva al giro dopo).
- **Cache dei brani** sul dispositivo (come Spotify): i prossimi brani della coda si scaricano mentre
  suona quello attuale, quelli ascoltati restano fino al limite scelto (predefinito 1 GB). Un brano in
  cache parte subito e non consuma dati.
- Avvio che non aspetta il rinnovo della sessione se non serve.

### Fase 4 — Rifinitura
- Revisione visiva a larghezza telefono e computer, nei due temi, delle pagine nuove e di quelle
  toccate; voci e testi coerenti.

### Fase 5 — Documentazione e rilascio
- `LEGGIMI.md`, `README.md`, `DECISIONS.md`, docstring di `app.py`, `CAPS`.
- Note di rilascio scritte a mano (`docs/rilasci/vX.Y.Z.md`, lette dalla Action dell'APK).

## Richieste aggiunte durante la notte
- Menu col tasto destro su ogni voce, sul computer. **Fatto.**
- Ascolti: contati dal server (totale e per utente), più la popolarità esterna dove si può avere. **Fatto** (indice di
  Deezer; gli stream di Spotify non sono pubblici).
- Note di rilascio curate per ogni versione e README allineato. **Fatto** (`docs/rilasci/`, letto dalla Action).
- Federazione: topologia a maglia o a stella secondo la rete del server. Analisi fatta; fatte le correzioni rapide e il
  verso dei collegamenti. **Fatto (0.20.0)** su richiesta dell'utente: canale inverso per i server dietro NAT/CGNAT
  (stella attorno ai server raggiungibili, maglia fra quelli raggiungibili), abbonamenti alle playlist pubbliche,
  collegamento mostrato in mappa e impostazioni. Vedi `docs/FEDERAZIONE.md` §16.

## Secondo giro (0.20.0)
- Mix del giorno dallo storico (artisti ascoltati insieme, simili di Deezer, genere). **Fatto.**
- Cache di Navidrome più grande (transcodifica 2 GB, copertine 500 MB). **Fatto.**
- Testi tradotti: **non fatto**, servirebbe un servizio di traduzione esterno con chiave (da decidere).

## Dopo (proposte, non in questa notte)
- Preferiti da «Liked Songs» di Spotify (stella su Navidrome invece di una playlist).
- Mix giornalieri calcolati dallo storico (tipo *Daily Mix*), testi tradotti, crossfade intelligente.
- Cache della transcodifica di Navidrome più grande (`ND_TRANSCODINGCACHESIZE`), richiede di
  ricreare il container di Navidrome: da decidere con l'utente.
