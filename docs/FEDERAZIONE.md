# Federazione fra server Armony — documento di progetto

Stato: **progetto approvato**, 2026-10-08. Nulla di questo è implementato.
Le domande aperte hanno avuto risposta (§13) e sono registrate in
`DECISIONS.md`. Restano da decidere solo dettagli di implementazione, segnati
*(in implementazione)*.

## 1. Obiettivo

Ogni server Armony è la libreria personale di qualcuno: ci carica musica, la
ascolta, la scarica sui suoi dispositivi. La federazione permette di **collegare
la propria libreria a quella di un altro**, decidendo:

- **se** collegarsi (nessun collegamento esiste senza il consenso di entrambi);
- **cosa** offrire all'altro e cosa prendere da lui;
- **come** prenderlo: copia fisica dei file, oppure in futuro solo ascolto a distanza.

Fuori obiettivo: una rete pubblica di server sconosciuti, un indice globale,
la condivisione transitiva (quello che ricevo da A non lo giro a C).

## 2. Cosa c'è già e cosa si riusa

| Pezzo esistente | Ruolo nella federazione |
|---|---|
| **Navidrome 0.64 con librerie multiple** (tabelle `library`, `user_library`; API nativa `/api/library`, verificata: risponde 401 senza login) | Ogni server collegato diventa **una libreria Navidrome separata**, con permessi per utente. Indicizzazione, copertine, transcodifica, offline, Jam e statistiche funzionano senza scrivere niente: per Navidrome sono file locali |
| Server Armony con `musica/` montata in scrittura | Scrive i file ricevuti |
| Scoperta LAN via multicast (`/api/lan/servers`) | Propone "Collega" per i server Armony trovati in casa |
| Invito della Jam (codice scambiato fuori banda, codice di sicurezza a simboli) | Stesso schema per l'abbinamento fra server |
| `/api/update` e i tag `vX.Y.Z` | I server collegati avranno versioni diverse: serve una versione di protocollo separata (§8) |

## 3. Concetti

- **Nodo**: un server Armony, identificato da una coppia di chiavi Ed25519
  generata al primo avvio (`data/armony/identita.key`). L'identificativo del
  nodo è l'impronta della chiave pubblica: non cambia se cambia l'indirizzo.
- **Collegamento**: rapporto di fiducia fra due nodi, creato da entrambi gli
  amministratori. Da solo non sposta nulla.
- **Offerta**: ciò che un nodo mette a disposizione di un collegamento:
  tutta la libreria, cartelle, artisti, album o playlist. Per collegamento:
  ad A offro tutto, a B solo una playlist.
- **Abbonamento**: ciò che un nodo sceglie di prendere da un'offerta, con le
  sue regole (modo, cancellazioni, spazio massimo, frequenza).

Il collegamento è simmetrico, il flusso no: ogni abbonamento va in **una
direzione**. "Sincronizzare in entrambi i sensi" significa due abbonamenti,
uno per parte, e nessuno dei due nodi scrive mai nella libreria dell'altro.

## 4. Chi decide

**Deciso: il collegamento è fra server e lo crea l'amministratore;
la visibilità è per utente.** Chi ha il codice di accesso (`ARMONY_TOKEN`)
collega i server e sceglie offerte e abbonamenti. Poi, tramite i permessi delle
librerie di Navidrome, decide quali utenti del proprio server vedono la libreria
ricevuta (predefinito: tutti).

Alternativa: collegamenti fra singoli utenti (l'utente `brollo` di Casa si
collega con l'utente `marco` di un altro server). È più fine, ma Armony oggi non
ha un modello di utenti suo, che è di Navidrome, e un server usato da quattro
amici diventerebbe quattro reti di collegamenti diverse. Da rivalutare se i
server diventano davvero multiutente.

## 5. Abbinamento e fiducia

1. A apre *Impostazioni → Librerie collegate → Collega* e ottiene un **codice
   di invito** (link e QR) che contiene il suo indirizzo, la sua chiave
   pubblica e un segreto monouso valido 24 ore.
2. B lo incolla. Il server di B contatta quello di A e si presenta con la sua
   chiave pubblica e il segreto.
3. A riceve una **richiesta di collegamento** da accettare. Entrambi vedono un
   **codice di sicurezza** a cinque simboli calcolato dalle due chiavi (lo stesso
   schema della Jam): se coincide, nessuno si è messo in mezzo.
4. Le chiavi vengono fissate. Da qui ogni richiesta fra i due nodi è **firmata**:
   firma Ed25519 su metodo, percorso, data e hash del corpo, rifiutata se
   più vecchia di 5 minuti.

Per i server trovati in LAN il punto 1 si salta: l'invito parte dal tasto
"Collega" accanto al server scoperto. Il codice di sicurezza resta.

**Revoca**: chiunque dei due può chiudere il collegamento. Dall'altra parte le
richieste vengono rifiutate subito; i file già ricevuti restano o vengono
cancellati, a scelta di chi li ha (§7).

## 6. Raggiungibilità

La sincronizzazione è **a richiesta di chi riceve**: B scarica da A. Quindi
deve essere raggiungibile **solo chi offre**. Se l'abbonamento è in un verso solo,
il nodo che riceve può stare dietro qualsiasi NAT.

Modi supportati, senza scrivere niente di nuovo:
- **stessa LAN**: indirizzo locale;
- **Tailscale**: entrambi nella stessa tailnet, oppure con *node sharing*
  (A condivide il suo nodo con la tailnet di B), che è la strada per amici con
  reti diverse;
- **HTTPS pubblico**: dominio con Caddy o Cloudflare Tunnel, già descritti in
  `LEGGIMI.md`.

Niente relay propri: è una fonte di costi e responsabilità che i casi d'uso non
giustificano.

## 7. Sincronizzazione in copia (il modo principale)

### Flusso

```
B (riceve)                                   A (offre)
  │  GET /fed/v1/manifest?offerta=…  ───────▶  elenco file dell'offerta:
  │                                            id opaco, percorso relativo,
  │                                            dimensione, mtime, sha256
  │  confronto con lo stato locale
  │  GET /fed/v1/file/<id>  (Range)  ───────▶  il file, ripartibile
  │  scrive in federati/<nodo A>/…  (prima .part, poi rinomina)
  │  verifica sha256
  └─ a fine giro: chiede a Navidrome una scansione della libreria di A
```

### Regole

- **Dove finiscono i file**: `federati/<nome nodo>/`, mai dentro `musica/`.
  Ogni cartella di nodo è una libreria Navidrome. Così si sa sempre cosa è
  mio e cosa è ricevuto, e un file ricevuto non può rientrare per sbaglio
  in un'offerta (niente cicli, niente condivisione transitiva).
- **Identità dei file**: sha256, calcolato da chi offre e tenuto in cache per
  (percorso, dimensione, mtime). La prima indicizzazione di 4 GB costa qualche
  minuto, le successive niente.
- **Doppioni**: un file con lo stesso hash già presente nella libreria locale
  non viene scaricato. Riconoscere lo stesso brano in codifiche diverse
  (artista + titolo + durata) è un passo successivo (fase 2).
- **Cancellazioni a monte**, per abbonamento: *conserva* (predefinito: quello
  che ho ricevuto resta mio), oppure *rispecchia* (sparisce anche da me).
- **Modifiche locali** ai file ricevuti: non previste. La cartella è di sola
  lettura per Navidrome e il giro successivo riallinea a quella del nodo che offre.
- **Spazio**: prima di confermare un abbonamento si vede quanto pesa. Si può
  fissare un tetto in GB: oltre, il giro si ferma e lo segnala.
- **Quando**: un tasto "Sincronizza ora", più un intervallo per abbonamento
  (predefinito ogni 24 ore). Due trasferimenti per volta, come i download.
- **Playlist offerte**: arrivano i file **e** una playlist omonima sul nodo
  che riceve, aggiornata a ogni giro.

### Cosa si può offrire

Tutta la libreria · cartelle · artisti · album · playlist. Le regole sono
**dinamiche**: offrire un artista vuol dire anche i suoi album futuri. Il
manifest si calcola a ogni richiesta interrogando il DB di Navidrome in sola
lettura, oppure la sua API *(in implementazione: l'API è più stabile fra
versioni, il DB più veloce)*.

**Avviso sui diritti**: la prima volta che si crea un'offerta compare un
avviso breve (condividere musica protetta fra persone diverse non è copia
privata) da confermare una volta sola per server. La nota in `LEGGIMI.md` va
estesa alla federazione.

## 8. Versioni e compatibilità

- Le rotte sono versionate: `/fed/v1/…`. `GET /fed/hello` risponde con
  `{nodo, nome, proto: 1, app: "0.3.0"}`.
- Due nodi si parlano se hanno lo stesso `proto` maggiore. Se no, il
  collegamento resta ma si mette in pausa con un messaggio chiaro ("aggiorna
  Armony su …"), e chi è indietro vede già l'avviso di aggiornamento.
- `proto` cambia solo per modifiche incompatibili; aggiunte di campi no.

## 9. Sicurezza

- Le rotte `/fed/v1/*` **non** usano `ARMONY_TOKEN`: le autentica la firma del
  nodo. Le rotte di gestione (`/api/fed/*`, chi collega e cosa si offre) restano
  dietro il token, aggiunte a `PROTECTED`.
- I file si chiedono per **id opaco** emesso dal manifest, mai per percorso:
  niente traversal, e un nodo vede solo ciò che è nella sua offerta.
- Il manifest rivela nomi di file e cartelle dell'offerta, non altro.
- Ogni collegamento ha un limite di richieste e di banda.
- Il trasporto è quello del server: HTTPS (Tailscale o dominio) fortemente
  raccomandato. Senza HTTPS la firma impedisce di falsificare richieste, ma
  il contenuto viaggia in chiaro.

## 10. Persistenza e codice

Oggi `app.py` tiene tutto in memoria. La federazione ha bisogno di stato che
sopravviva ai riavvii: nodi, chiavi fissate, offerte, abbonamenti, cache degli
hash, stato dei giri.

- **SQLite con il modulo standard** `sqlite3` in `data/armony/armony.db`,
  senza ORM, con migrazioni numerate semplici.
- **Un modulo nuovo**, `server/federazione.py`, registrato da `app.py`. La
  federazione da sola peserà quanto il resto del server, e mescolarla in un
  file unico renderebbe entrambi illeggibili. Cambia la scelta implicita
  "server in un file": va registrato in `DECISIONS.md`.
- **Compose**: `./federati` montata in scrittura in `armony` e in sola
  lettura in `navidrome`; le librerie si creano dall'API di Navidrome con un
  utente amministratore dedicato, le cui credenziali vanno in `.env`.
- Firme Ed25519: libreria `cryptography`, nuova dipendenza pip con pacchetti
  pronti anche per Raspberry (arm64).

## 11. Interfaccia

*Impostazioni → Librerie collegate*, visibile solo con il codice di accesso:

- elenco dei nodi collegati: nome, stato (attivo, in pausa, versione
  incompatibile, irraggiungibile), ultimo giro;
- **Collega una libreria**: codice d'invito, QR, server trovati in LAN;
- per ogni nodo, due schede: **Cosa offro** (scelta per cartelle, artisti,
  album, playlist, con il peso totale) e **Cosa ricevo** (abbonamenti: cosa,
  regola sulle cancellazioni, tetto, frequenza, avanzamento);
- nella libreria, un filtro per provenienza (mia o di un nodo). Da verificare se
  l'API Subsonic di Navidrome 0.64 permette già di filtrare per libreria
  (`musicFolderId`) o se va fatto nel client.

## 12. Fasi

| Fase | Contenuto | Valore che porta da sola |
|---|---|---|
| **0** | Caricamento di file dal client nella propria libreria (trascina e rilascia). Non è federazione, ma è il "caricare fisicamente" che rende un server una libreria personale | Sì |
| **1** | Identità, abbinamento con codice di sicurezza, offerta *tutta la libreria* o *cartelle*, abbonamento in copia, cancellazioni *conserva*, giro manuale, libreria Navidrome per nodo, SQLite, `proto: 1` | Due amici si scambiano librerie intere |
| **2** | Offerte per artista, album e playlist; regola *rispecchia*; tetto di spazio; giri pianificati; doppioni per metadati; "Collega" dalla scoperta LAN | Scelta fine di cosa sincronizzare |
| **3** | Ascolto a distanza senza copia: il server locale fa da proxy verso il manifest e i file dell'altro, il client mostra le librerie remote come un server in più | Librerie troppo grandi da copiare |

La fase 3 è l'unica che richiede lavoro nel client oltre alle impostazioni,
per questo è ultima.

## 13. Decisioni prese (2026-10-08)

| Domanda | Risposta |
|---|---|
| Chi crea i collegamenti (§4) | Il server, tramite l'amministratore; la visibilità della libreria ricevuta si sceglie per utente (predefinito: tutti) |
| Copia o ascolto a distanza (§12) | Prima la copia fisica (fase 1); l'ascolto a distanza nella fase 3 |
| Cancellazioni a monte (§7) | Predefinito *conserva*; *rispecchia* sceglibile per abbonamento dalla fase 2 |
| Caricamento dal client (fase 0) | Prima della federazione |
| Diritti | Nota estesa in `LEGGIMI.md` e avviso alla prima offerta, confermato una volta |

Fase 0 fatta (2026-10-08): Scarica → Dal dispositivo, `PUT /api/upload`.
Prossimo passo: fase 1.
