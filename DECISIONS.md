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
