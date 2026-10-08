# Linee guida di progetto — Armony

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 0. Il progetto in breve

Armony è un client web per Navidrome con Jam peer-to-peer, download yt-dlp,
offline e statistiche. **Prima di qualsiasi cosa leggi `LEGGIMI.md` e
`DECISIONS.md`** (§5b). `LEGGIMI.md` è il
manuale utente, ma anche l'unica descrizione completa delle funzioni. Se il
codice lo contraddice, fermati e segnalalo.

```
docker-compose.yml   navidrome (4533) · armony (8080, rete host) · turn (profilo opzionale)
server/app.py        Flask + waitress, un solo file. Docstring in testa = mappa delle rotte
client/              HTML + JS puro, nessun bundler, nessuna compilazione
  armony.js          Parte 1: utilità, API Subsonic, viste · Parte 2: database locale, …
  jam.js             Jam: segnalazione cifrata, WebRTC, orologio condiviso, codice di sicurezza
  sw.js              solo la shell dell'app; /rest /api /share non passano dal service worker
deploy/              aggiornamento eseguito dall'host (systemd .path → armony-update.sh)
VERSION · .env       versione dell'app (= tag vX.Y.Z) · segreti, fuori da git
musica/ video/ data/ dati dell'utente (root, montati nei container): non toccarli
```

### Vincoli che dal codice non si vedono

- **Il repo GitHub è pubblico.** Mai segreti in file tracciati: vanno in
  `.env` (con la voce corrispondente in `.env.example`). Ogni server Armony si
  aggiorna dai tag `vX.Y.Z`: **un tag è un rilascio a tutti i server**. Non
  creare né pushare tag senza richiesta esplicita; quando lo fai, `VERSION`
  deve contenere lo stesso numero (senza `v`), altrimenti l'updater rifiuta.
- **È in produzione su questa macchina** (`armony-app`, `armony-navidrome`
  girano adesso, accanto ad altri container non nostri). Non fermare, ricreare
  o fare `down` senza chiedere. `data/navidrome/navidrome.db` è il DB vivo.
- **Il client è montato in sola lettura** nel container: una modifica a
  `client/` è live al ricaricamento della pagina. Una modifica a `server/`
  richiede `docker compose up -d --build armony` (il contesto di build è la
  root: `.dockerignore` lascia entrare solo `server/` e `VERSION`).
- **Senza bundler e senza dipendenze npm, di proposito.** Non proporre
  React, Vite, TypeScript o un framework CSS. Gli script si caricano in ordine
  (`armony.js` poi `jam.js`, poi `boot()`) e condividono lo scope globale.
- **Sicurezza della Jam.** Il segreto della stanza vive nel frammento `#` del
  link e non deve mai arrivare al server; il server inoltra solo blob cifrati.
  Qualsiasi modifica che faccia passare in chiaro dal server un dato della Jam,
  o che tocchi `safetyCode`/ECDH/AES-GCM in `jam.js`, va segnalata prima di
  scriverla. Le funzioni crittografiche esistono solo in contesto sicuro
  (`SUBTLE`): verifica sempre anche il ramo senza HTTPS.
- **Rotte protette**: la tupla `PROTECTED` in `app.py` decide cosa richiede
  `ARMONY_TOKEN`. Una nuova rotta di download/gestione file va aggiunta lì.
- **Multicast** solo con `network_mode: host` su Linux; il resto dell'app deve
  funzionare anche con `ARMONY_MULTICAST=0`.
- **Lingua**: interfaccia, commenti e messaggi sono in italiano. Mantienilo.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently. Qui lo stile è
  compatto: funzioni brevi su una riga, helper `$`, `$$`, `esc`, `store`,
  `emit`. Usa `esc()` per ogni testo interpolato in HTML.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Reproduce it (curl, browser, log), then make it disappear"
- "Refactor X" → "Same behaviour before and after, checked the same way"

Non ci sono test automatici. Le verifiche disponibili:
- server: `python3 -m py_compile server/app.py`, poi `curl` sulle rotte
  (`/api/health` con `X-Token`, `/rest/ping.view` per il proxy),
  `docker logs armony-app`;
- client: `node --check client/*.js`, poi il browser (§6).

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Documentazione

**Se cambi una funzione visibile all'utente, aggiorna `LEGGIMI.md` nella stessa modifica.**

Va aggiornato quando aggiungi o togli una funzione, una variabile d'ambiente,
una porta, un servizio in `docker-compose.yml` o un passo di installazione.
Non serve per bugfix o ritocchi che non cambiano cosa l'utente può fare.
Tieni il tono del file: italiano semplice, rivolto a chi installa per gli amici.

Se cambi rotte in `app.py`, aggiorna anche la docstring in testa al file. Se
aggiungi un file alla shell del client, aggiungilo a `SHELL` in `sw.js` e
incrementa `V`.

## 5b. Registro decisioni

**Se una scelta ha escluso un'alternativa, va in `DECISIONS.md` nella stessa modifica.**

Leggilo prima di proporre cambi strutturali: molte cose che sembrano debito
(niente bundler, server in un file, rete host) sono scelte con un motivo. Non
riproporre un'alternativa già scartata; se pensi che le condizioni siano
cambiate, dillo citando la voce e il suo «Da rivedere se».

Il registro è append-only: voci nuove in cima, quelle esistenti non si toccano.
Una decisione ribaltata si registra con una voce nuova che cita la vecchia.

## 6. Lavoro di interfaccia

**Una modifica alla UI non è verificata finché non l'hai resa e guardata.**

Il diff pulito non dice se la pagina è giusta: colori sbagliati in un tema,
elementi sovrapposti su schermo da telefono, stati vuoti mai visti. Apri l'app
(`http://localhost:8080`) con Playwright o la skill `claude-in-chrome` e
**fotografa gli stati, non la pagina**: a riposo, con dati, vuota, in errore,
in entrambi i temi e a larghezza telefono (l'app si usa soprattutto da lì).
Per la Jam servono due schede/contesti collegati.

L'app ha già un suo linguaggio visivo (Bricolage Grotesque + Figtree, stili in
`index.html`): conformati. Le skill di design servono come spunto, non per
imporre un altro stile.

**Regola:** rendi, guarda, correggi in un lotto, riguarda una volta, fermati.
Dopo il secondo giro di screenshot il rapporto tempo/difetti trovati crolla.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
