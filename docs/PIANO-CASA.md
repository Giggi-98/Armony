# Piano: Armony in casa e nelle chat

Scritto il 2026-10-12, su richiesta: «cercare in rete dispositivi su cui streammare audio (Alexa, TV)», «il server
dovrebbe avere il Bluetooth: collegarlo a più Alexa o altri dispositivi Bluetooth, e da server o da telefono scegliere
su quali suonare», «integrazione con bot Discord e Telegram».

## Fasi

| Fase | Cosa | Stato |
|---|---|---|
| 1 | **Bot Telegram e Discord**: collegamento con codice, notifiche, `/cerca` `/ora` `/amici` `/scarica` `/pausa` `/avanti` `/indietro` | ✅ fatto (0.62), da provare con i token veri |
| 2 | **Musica nel canale vocale Discord**: `/suona` (brano, album, playlist, la tua coda), `/coda`, `/salta`, `/esci`; il bot suona dal server, ffmpeg + Opus | da fare |
| 3 | **TV e casse in rete**: ricerca DLNA/UPnP (SSDP) e Google Cast (mDNS) dal server, che sta in casa con la rete host; compaiono in «Dove suona» come dispositivi; il server manda i brani e passa al successivo | da fare |
| 4 | **Bluetooth del mini PC**: il server si collega a casse Bluetooth (anche le Alexa, che fanno da cassa Bluetooth) e suona lì; scelta da «Dove suona» | da fare, si prova solo sul mini PC |

### Note su ogni fase

**Fase 3.** Le smart TV (Samsung, LG, Sony) e quasi tutte le casse di rete (Sonos, amplificatori) sono «renderer»
DLNA/UPnP: il server le trova con un messaggio multicast e manda l'indirizzo del brano (`SetAVTransportURI`, `Play`),
senza librerie. Google Cast (Android TV, Google TV, Chromecast) vuole `pychromecast`. Il brano lo scarica il
dispositivo dal server, quindi deve raggiungerlo in casa (rete host, già così). Il server segue lo stato del
renderer per passare al brano dopo. Le **Alexa** non accettano audio da programmi esterni in rete: si usano come casse
Bluetooth (fase 4) o, più avanti, con una skill Alexa (account sviluppatore Amazon e il dominio HTTPS, che c'è già).

**Fase 4.** Serve configurare il mini PC: BlueZ e PipeWire sull'host, il container di Armony che parla con loro
(socket di PipeWire e D-Bus montati). Più casse Bluetooth insieme si possono unire in un'uscita sola (PipeWire
«combine-sink»), ma restano piccoli sfasamenti fra loro, e un Echo accetta un solo dispositivo Bluetooth alla volta
(se è collegato al telefono, non al server). Da decidere prima di cominciare: lo faccio io via SSH sul mini PC o
lanci tu uno script `deploy/bluetooth.sh`?

## Cosa possiamo fare con i bot (idee, da scegliere)

- 🎵 **Brano in chat**: `/brano bohemian` e il bot manda il file audio, si ascolta dentro Telegram.
- 🔗 **Incolla un link e basta**: mandi un link di YouTube al bot e lui lo scarica, senza `/scarica`.
- 🔍 **Modalità in linea di Telegram**: in qualunque chat scrivi `@ArmonyBot queen` e scegli il brano da condividere.
- 🎉 **Jam dal bot**: `/jam` apre una Jam e manda il link nel gruppo degli amici.
- 📊 **Riepilogo della settimana**: ogni lunedì i tuoi brani e artisti più ascoltati, e quelli degli amici.
- 🆕 **Novità in libreria**: un canale Discord dove il bot scrive gli album arrivati sul server.
- 🎧 **Discord «ascolta con me»**: il bot nel canale vocale segue quello che suoni tu (come la Jam).
- 🗳️ **Coda condivisa su Discord**: tutti aggiungono brani, voto per saltare.
- 🎂 **Mix del giorno nel bot**: ogni mattina il link al tuo mix.
