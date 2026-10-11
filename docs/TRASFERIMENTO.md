# Trasferimento di un server Armony

Progetto del protocollo con cui un server Armony passa tutto a un altro: identità, utenti, playlist, dispositivi,
collegamenti e, se si vuole, i brani. Caso tipico: il server di prova diventa il server di casa, su un mini PC con IP
pubblico, che da lì fa da centro della rete.

Stato: **progetto, da approvare**. Niente di questo è ancora nel codice.

## Le due parti

- **Vecchio**: il server che si sposta. Continua a funzionare per quasi tutto il trasferimento.
- **Nuovo**: appena installato con `installa.sh`, vuoto, con il servizio «Aggiorna» attivo (serve a sostituire i
  database come root). Deve essere raggiungibile dal vecchio: è lui il futuro centro, quindi ha un indirizzo.

Il verso è sempre **dal vecchio al nuovo**: il vecchio spinge, il nuovo riceve. Così basta che il nuovo si raggiunga,
anche se il vecchio è dietro NAT.

## Cosa si sposta

| Cosa | Dove sta | Perché |
|---|---|---|
| Identità federata | `data/armony/identita.key` | Il nuovo è *lo stesso nodo* per tutti i server collegati: niente nuovi inviti, la fiducia resta |
| Database di Armony | `data/armony/armony.db` | Dispositivi e sessioni (restano abbinati), preferenze, notifiche, collegamenti, collaboratori, importazioni, radio, impostazioni |
| Database di Navidrome | `data/navidrome/navidrome.db` | Utenti e password, playlist, preferiti, ascolti, valutazioni |
| Amministratore di Navidrome | `data/armony/navidrome-admin.json` o `.env` | Senza, Armony sul nuovo non potrebbe più parlare con Navidrome |
| Foto profilo | `data/armony/avatar/` | |
| Brani (facoltativo) | `musica/`, `federati/` | Stesso percorso relativo: Navidrome riconosce gli stessi file e tiene gli stessi id, quindi playlist e preferiti restano validi |
| Video (facoltativo) | `video/` | |

**Non si sposta**: `ARMONY_TOKEN` e il resto del `.env` del nuovo (tranne le credenziali dell'amministratore di
Navidrome), i certificati HTTPS (il nuovo ha il suo nome), la chiave di firma dell'APK (`data/android/`, è del progetto).

## Le fasi

### 1. Apertura, sul nuovo
Impostazioni → Trasferimento → **«Ricevi un server»**. Il nuovo crea una coppia di chiavi Ed25519 *usa e getta* e un
codice `ART1…` con: indirizzo del nuovo, chiave pubblica usa e getta, segreto, scadenza (2 ore). Si può fare solo se il
nuovo è vuoto (nessun collegamento, nessuna playlist, nessun dispositivo oltre a quello dell'amministratore), oppure con
una conferma esplicita che dice cosa verrà sostituito.

### 2. Aggancio, sul vecchio
Impostazioni → Trasferimento → **«Trasferisci questo server»** → si incolla il codice. Il vecchio crea anche lui una
chiave usa e getta, chiama `/trasf/v1/ciao` con il segreto e la sua chiave. Sui due schermi compare lo stesso **codice
di sicurezza** (cinque simboli dall'hash delle due chiavi, come nella federazione): l'amministratore lo confronta e
conferma su tutti e due. Da qui ogni richiesta del vecchio è firmata con la sua chiave usa e getta (metodo, percorso,
data, destinatario, hash del corpo, come le richieste federate) e il nuovo risponde solo a quella chiave.

### 3. Scelte, sul vecchio
- Copiare i brani? Il nuovo dice quanto spazio ha libero, il vecchio quanto serve.
- Copiare i video?
- Nome del server dopo il trasferimento (di base lo stesso).

### 4. Fotografia e invio, mentre il vecchio funziona
- Copie coerenti dei due database (`sqlite3 backup`, come fa già l'aggiornamento), identità, credenziali, foto: un
  **pacchetto** con l'elenco dei file, dimensione e sha256.
- Invio a pezzi da 1 MB, ognuno firmato. Si **riprende** da dove si era fermato: per ogni file il nuovo dice quanti byte
  ha già, e il vecchio riparte da lì (rete che cade, vecchio riavviato).
- Database e identità vanno in una cartella d'appoggio (`updates/trasferimento/`); i brani direttamente in `musica/` e
  `federati/` con lo stesso percorso relativo.
- Avanzamento visibile sui due schermi: file, byte, velocità, tempo stimato.

### 5. Congelamento breve, sul vecchio
Per non perdere niente fra la fotografia e il passaggio: per un minuto il vecchio smette di accettare modifiche
(playlist, preferiti, caricamenti, download in pausa; l'ascolto continua), rifà le copie dei database (pochi MB) e le
manda. I brani cambiati nel frattempo si ricontrollano con un secondo giro di dimensioni e date.

### 6. Applicazione, sul nuovo (come root)
Il nuovo scrive una richiesta nella cartella degli aggiornamenti e il servizio di sistema (lo stesso del tasto
«Aggiorna»):
1. fa una copia di sicurezza dei dati del nuovo (`data/backup/prima-del-trasferimento-…`);
2. ferma Armony e Navidrome;
3. mette al loro posto database, identità, foto; scrive in `.env` le credenziali dell'amministratore di Navidrome del vecchio;
4. riavvia e controlla: Armony risponde, l'identità è quella del vecchio, Navidrome ha gli utenti del vecchio.

Se il controllo fallisce torna ai dati di prima, e il vecchio esce dal congelamento come se niente fosse.

### 7. Passaggio di testimone
- **Server collegati**: il nuovo, che ora ha l'identità, chiama ogni server collegato che raggiunge con
  `/fed/v1/indirizzo {url}`, firmato con l'identità: lo riconoscono (stessa chiave) e aggiornano l'indirizzo.
- **Foglie** (server senza indirizzo che chiamavano il vecchio): alle loro richieste il vecchio risponde «spostato a
  <indirizzo>», firmato con l'identità; loro passano al nuovo da sole.
- **Dispositivi**: il vecchio imposta come indirizzo pubblico quello del nuovo. Il Trasloco della 0.37 fa il resto:
  l'app controlla che al nuovo indirizzo la sua sessione valga (vale: il database è lo stesso) e si sposta; il browser
  mostra «Passa lì».
- Il vecchio mostra a tutti un avviso: «Questo server si è spostato su …».

### 8. Il vecchio, dopo
**Con i brani copiati**: resta «trasferito» finché tutti hanno seguito (la pagina dice quanti dispositivi e server
chiamano ancora il vecchio). Poi **«Concludi»**: cancella identità e sessioni, e il vecchio si può spegnere.

**Senza brani** (scelta del 2026-10-11): il vecchio diventa una **libreria collegata**. Si crea un'identità nuova, si
abbina da solo al nuovo dentro la sessione di trasferimento (verso «solo lui vede me»), e i suoi brani si cercano,
ascoltano e copiano dalla federazione. Sul nuovo, le playlist hanno i brani che mancano finché non arrivano:
**«Sposta i brani adesso»** riprende la fase 4 solo per i file, e Navidrome li ritrova con gli stessi id. L'identità
vecchia resta sul vecchio solo per rispondere «spostato» per 30 giorni, poi si cancella.

## Sicurezza
- Codice monouso con scadenza, codice di sicurezza confrontato a voce, richieste tutte firmate.
- Il pacchetto contiene le impronte delle password (Navidrome) e le chiavi dei dispositivi: senza HTTPS si fa solo
  dentro la stessa rete locale (Armony lo dice e chiede conferma).
- L'identità esiste in due posti solo fra il passaggio e la conclusione; il vecchio la usa solo per «spostato».
- Serve un amministratore su tutti e due i server; dopo l'applicazione si entra nel nuovo con gli account del vecchio.

## Annullare
- Prima dell'applicazione: «Annulla» su uno dei due; il vecchio non è stato toccato, il nuovo butta la cartella d'appoggio.
- Dopo: il nuovo tiene la copia dei suoi dati di prima; il vecchio, finché non ha concluso, può «Riprendere» (esce da
  «trasferito»), ma prima va spento il nuovo: due server con la stessa identità accesi insieme non devono esistere.

## Rotte nuove (previste)
```
/trasf/v1/ciao              segreto + chiave usa e getta del vecchio → codice di sicurezza
/trasf/v1/stato             spazio libero, versione, file già ricevuti
/trasf/v1/file/<nome>       HEAD: byte già ricevuti · POST ?da=N: un pezzo
/trasf/v1/applica           fine invio: il nuovo applica (fase 6)
/fed/v1/indirizzo           un nodo collegato annuncia il suo nuovo indirizzo (firmato con l'identità)
/api/trasferimento/*        gestione dalle impostazioni (solo amministratori)
```
