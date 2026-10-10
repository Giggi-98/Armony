/* Armony - Jam: ascolto insieme, peer-to-peer e cifrato.

   Collegamento: WebRTC. L'host è al centro, ogni ospite ha un canale diretto con lui.
   - Rete locale: nessun server STUN/TURN, solo indirizzi locali. Il traffico non esce dalla rete.
   - Internet (5G): STUN per attraversare i NAT, TURN facoltativo. Il relay vede solo dati cifrati.
   - Tramite il server: niente WebRTC. I messaggi della Jam passano dal relay di Armony
     (/api/jam/<id>/send e /recv) con gli stessi strati 2 e 3 qui sotto; il server fa anche da
     orologio comune (/api/jam/ora). Solo ascolto sincronizzato: serve un account sul server.

   Sicurezza (a strati):
   1. DTLS-SRTP di WebRTC: cifratura punto-punto di audio e dati, con chiavi effimere (ECDHE).
   2. Segnalazione cifrata con AES-GCM a 256 bit. La chiave nasce da un segreto casuale che
      viaggia solo nel link d'invito, dopo il #, quindi non arriva mai al server. Il server
      inoltra messaggi che non può leggere né falsificare: niente attacchi "man in the middle".
   3. Canale dati cifrato una seconda volta con chiave da scambio ECDH P-256 tra i due dispositivi.
   4. Codice di sicurezza: 5 simboli calcolati dalle impronte DTLS di entrambi (tramite il server:
      dalle due chiavi pubbliche ECDH). Se coincidono sui due telefoni, nessuno si è messo in mezzo.
   Gli strati 2 e 3 richiedono una pagina HTTPS (vincolo dei browser per la crittografia). */
'use strict';

const te = new TextEncoder(), td = new TextDecoder();
const now = () => performance.timeOrigin + performance.now();
const SUBTLE = !!(window.isSecureContext && crypto.subtle);
const b64u = {
  enc(buf) { const a = new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode.apply(null, a.subarray(i, i + 8192)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '==='.slice((s.length + 3) % 4); const b = atob(s); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
};
const SYMBOLS = ['🍎', '🍋', '🍇', '🍉', '🍒', '🥝', '🍍', '🥕', '🌽', '🍄', '🌵', '🌻', '🌙', '⭐', '🔥', '💧', '⚡', '❄️', '🌈', '☂️', '🎈', '🎁', '🎸', '🎺', '🥁', '🎻', '🎹', '🎧', '📻', '🎤', '🚲', '🚀', '⛵', '🚂', '🏠', '⛺', '🗻', '🌋', '🐶', '🐱', '🐭', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦉', '🐢', '🐍', '🐙', '🦀', '🐠', '🐳', '🦋', '🐝'];
const REACTIONS = ['🔥', '❤️', '🙌', '😂', '😮', '💃', '🕺', '👏'];
const COLORS = ['#f2a541', '#7fb7a4', '#e98b7a', '#9bb4f0', '#d7a6e0', '#c9d36a', '#f0c7a0', '#8fd0d8'];
const colorOf = id => COLORS[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % COLORS.length];

const JC = {
  async aesFrom(bits, info, salt = 'armony-jam') {
    const k = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode(salt), info: te.encode(info) }, k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  },
  async seal(key, obj) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj))); return b64u.enc(iv) + '.' + b64u.enc(ct); },
  async open(key, s) { const [iv, ct] = s.split('.'); return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(iv) }, key, b64u.dec(ct)))); },
  ecdh() { return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']); },
  async pub(kp) { return b64u.enc(await crypto.subtle.exportKey('raw', kp.publicKey)); },
  async shared(kp, peerPub, info, salt) {
    const pk = await crypto.subtle.importKey('raw', b64u.dec(peerPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return this.aesFrom(new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pk }, kp.privateKey, 256)), info, salt);
  }
};
const fingerprint = sdp => ((sdp || '').match(/a=fingerprint:\S+ ([0-9A-F:]+)/i)?.[1] || '').toUpperCase();
function safetyCode(sdpA, sdpB) {
  const [x, y] = [fingerprint(sdpA), fingerprint(sdpB)].sort();
  if (!x || !y) return '';
  const a = x.split(':').map(h => parseInt(h, 16)), b = y.split(':').map(h => parseInt(h, 16));
  const out = []; for (let i = 0; i < 5; i++) { let v = 0; for (let j = i; j < a.length; j += 5) v = (v * 31 + (a[j] ^ b[j])) % 4096; out.push(SYMBOLS[v % 64]); }
  return out.join(' ');
}
async function pack(obj) {
  const st = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return 'AM1' + b64u.enc(await new Response(st).arrayBuffer());
}
async function unpack(code) {
  code = String(code).trim().replace(/\s+/g, '');
  const m = code.match(/AM1[A-Za-z0-9_-]+/); if (!m) throw new Error('Codice non valido.');
  const st = new Blob([b64u.dec(m[0].slice(3))]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return JSON.parse(await new Response(st).text());
}
function stereoOpus(sdp) {
  const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1]; if (!pt) return sdp;
  return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (m, p) => `a=fmtp:${pt} ${p.replace(/;?(stereo|sprop-stereo|maxaveragebitrate)=[^;]*/g, '')};stereo=1;sprop-stereo=1;maxaveragebitrate=192000`);
}
const wire = t => t && ({ id: t.id, title: t.title, artist: t.artist, album: t.album, albumId: t.albumId, artistId: t.artistId, duration: t.duration, coverArt: t.coverArt, rg: t.rg, genre: t.genre, jamBy: t.jamBy, fed: t.fed, serverUrl: t.serverUrl || absUrl(srv(t.serverId)?.url || ''), pub: t.pub || srv(t.serverId)?.me?.public || undefined });
// lo stesso server si raggiunge con indirizzi diversi (in casa, Tailscale): si riconosce anche dall'indirizzo pubblico.
// near: il server da cui arriva il brano quando è certo (i propri dispositivi collegati allo stesso server)
const localize = (w, near) => {
  if (!w) return null;
  const s = S.servers.find(x => absUrl(x.url) === w.serverUrl || (w.pub && x.me?.public === w.pub) || (x.me?.public && x.me.public === w.serverUrl))
    || (near && w.serverUrl ? srv(near) : null);
  return { ...w, serverId: s ? s.id : 'nessuno' };
};
async function relayCode(a, b) {
  const [x, y] = [a, b].sort(), h = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(x + '.' + y)));
  return [...h.slice(0, 5)].map(v => SYMBOLS[v % 64]).join(' ');
}
// un account sul server della Jam: serve per ascoltare "tramite il server" (ognuno scarica la musica da lì)
const hasAccount = base => !!base && S.servers.some(s => absUrl(s.url) === absUrl(base) && (s.tok || s.pass));
const serverLabel = base => { try { return new URL(base).host; } catch { return 'quel server'; } };
const signalBase = () => (S.dl.url || (srv()?.url ? absUrl(srv().url) : '') || (!NATIVE && /^https?:/.test(location.protocol) ? location.origin : '')).replace(/\/+$/, '');

/* ================= segnalazione tramite server (messaggi cifrati) ================= */
class Signal {
  constructor(base, room, peer, key) { Object.assign(this, { base, room, peer, key, running: false, chains: new Map() }); }
  async send(to, obj, plain = false) {
    const data = this.key && !plain ? 'e:' + await JC.seal(this.key, obj) : 'p:' + JSON.stringify(obj);
    const r = await fetch(`${this.base}/api/jam/${this.room}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: this.peer, to, data }) });
    if (r.status === 410) throw new Error('La Jam non esiste più.');
    if (!r.ok) throw new Error('Il server della Jam non risponde.');
  }
  async loop(onMsg, onGone) {
    this.running = true;
    while (this.running) {
      try {
        const r = await fetch(`${this.base}/api/jam/${this.room}/recv?peer=${this.peer}&timeout=25`);
        if (r.status === 410) { this.running = false; onGone?.(); break; }
        const j = await r.json();
        for (const m of j.messages) {
          let obj = null, enc = m.data.startsWith('e:');
          try { obj = enc ? (this.key ? await JC.open(this.key, m.data.slice(2)) : null) : JSON.parse(m.data.slice(2)); } catch { obj = null; }
          // in ordine per mittente (una chiave va ricavata prima dei dati), senza bloccare gli altri
          if (obj) this.chains.set(m.from, (this.chains.get(m.from) || Promise.resolve()).then(() => onMsg(m.from, obj, enc)).catch(() => {}));
        }
      } catch { await sleep(2500); }
    }
  }
  stop() { this.running = false; }
}

/* ================= collegamento con un partecipante ================= */
class Peer {
  constructor(id, opts) {
    Object.assign(this, { id, name: opts.name || 'Ospite', kp: opts.kp, key: null, dc: null, rtt: null, conn: 'collegamento…', safety: '', state: 'new', want: 'sync', sender: null });
    this.pc = new RTCPeerConnection(Jam.iceConfig());
    this.pc.onconnectionstatechange = () => {
      this.state = this.pc.connectionState;
      if (this.state === 'connected') this.detectRoute();
      if (['failed', 'closed'].includes(this.state)) Jam.peerGone(this);
      Jam.render();
    };
  }
  async detectRoute() {
    try {
      const stats = await this.pc.getStats(); let pair, local;
      stats.forEach(s => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
      if (!pair) stats.forEach(s => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
      if (pair) { local = stats.get(pair.localCandidateId); this.rtt = pair.currentRoundTripTime ? Math.round(pair.currentRoundTripTime * 1000) : this.rtt; }
      const ty = local?.candidateType;
      this.conn = ty === 'host' ? 'rete locale diretta' : ty === 'relay' ? 'tramite relay TURN' : ty ? 'internet diretto' : 'collegato';
    } catch {}
    this.safety = safetyCode(this.pc.localDescription?.sdp, this.pc.remoteDescription?.sdp);
    Jam.render();
  }
  attach(dc) {
    this.dc = dc;
    dc.onopen = async () => {
      if (this.kp && this.peerPub && SUBTLE) this.key = await JC.shared(this.kp, this.peerPub, 'armony-dc', Jam.room.id);
      this.detectRoute(); Jam.peerOpen(this);
    };
    dc.onmessage = async e => {
      let m; try { m = e.data.startsWith('e:') ? await JC.open(this.key, e.data.slice(2)) : (this.key ? null : JSON.parse(e.data.slice(2))); } catch { m = null; }
      if (m) Jam.onData(this, m);
    };
    dc.onclose = () => Jam.peerGone(this);
  }
  async send(obj) {
    if (this.dc?.readyState !== 'open') return;
    try { this.dc.send(this.key ? 'e:' + await JC.seal(this.key, obj) : 'p:' + JSON.stringify(obj)); } catch {}
  }
  close() { try { this.dc?.close(); } catch {} try { this.pc.close(); } catch {} }
}
/* ================= collegamento tramite il server (senza WebRTC) =================
   Stessa interfaccia di Peer. Ogni messaggio va dentro la segnalazione (già cifrata con la chiave della stanza)
   e dentro un secondo strato AES-GCM con chiave ECDH della coppia: un altro invitato, che conosce la chiave
   della stanza, non può leggere né falsificare i messaggi fra host e un ospite. */
class RelayPeer {
  constructor(id, opts) { Object.assign(this, { id, name: opts.name || 'Ospite', kp: opts.kp, key: null, rtt: null, conn: 'tramite il server', safety: '', state: 'connected', want: 'sync', relay: true, seen: Date.now(), q: Promise.resolve() }); }
  async setKey(peerPub) { this.key = await JC.shared(this.kp, peerPub, 'armony-relay', Jam.room.id); this.safety = await relayCode(await JC.pub(this.kp), peerPub); }
  raw(obj) { const to = this.id; this.q = this.q.then(() => Jam.sig?.send(to, obj)).catch(() => {}); return this.q; }
  async send(obj) { if (this.key) return this.raw({ t: 'data', d: await JC.seal(this.key, obj) }); }
  async open(d) { try { return await JC.open(this.key, d); } catch { return null; } }
  detectRoute() {}
  close() {}
}
// orologio del server: scarto stimato come NTP, tenendo il campione con il tempo di andata e ritorno minore
const SrvClock = {
  off: 0, samples: [], t: null, base: '',
  async sample() { const t0 = now(); const j = await (await fetch(this.base + '/api/jam/ora', { cache: 'no-store' })).json(); const t1 = now(); this.samples.push({ rtt: t1 - t0, off: j.t - (t0 + t1) / 2 }); this.samples = this.samples.slice(-16); this.off = this.samples.reduce((a, b) => b.rtt < a.rtt ? b : a).off; },
  async start(base) { this.stop(); this.base = base; this.samples = []; for (let i = 0; i < 6; i++) { try { await this.sample(); } catch {} } this.t = setInterval(() => this.sample().catch(() => {}), 15000); },
  stop() { clearInterval(this.t); this.t = null; },
  ready() { return this.samples.length > 0; }
};
const waitIce = pc => new Promise(res => { if (pc.iceGatheringState === 'complete') return res(); const t = setTimeout(res, 5000); pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } }); });

/* ================= Jam ================= */
const Jam = {
  role: null, mode: 'sync', room: null, me: uid(12), sig: null, peers: new Map(), host: null,
  track: null, queue: [], playing: false, st: null, offset: 0, samples: [], remoteAudio: null, duck: 1,
  set: { control: false, openQueue: true, visible: true, approve: false },
  chat: [], proposals: [], votes: new Map(), pending: new Map(), timers: [], net: 'lan', via: 'direct', lastHost: 0, renderT: null,

  init() {
    ['track', 'play', 'pause', 'seek', 'queue'].forEach(ev => Bus.addEventListener(ev, () => { if (this.role === 'host') { this.pushState(); if (ev === 'track' || ev === 'queue') this.pushQueue(); } }));
    addEventListener('beforeunload', () => { if (this.role) this.leave(true); });
  },
  iceConfig() {
    const ice = [];
    if (this.net === 'internet' && P.stun) ice.push({ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] });
    if (this.net === 'internet' && P.turn.url) ice.push({ urls: P.turn.url, username: P.turn.user, credential: P.turn.pass });
    return { iceServers: ice, bundlePolicy: 'max-bundle' };
  },
  name() { return P.nick || srv()?.user || 'Anonimo'; },
  // posizione dell'host adesso: con l'orologio dell'host (ping sul canale diretto) o con quello del server
  estPos() {
    const st = this.st; if (!st) return 0;
    const srvTime = this.via === 'server' && st.sat && SrvClock.ready();
    const el = srvTime ? now() + SrvClock.off - st.sat : now() + this.offset - st.at;
    return st.pos + (st.playing ? Math.max(0, el / 1000) * (st.rate || 1) : 0);
  },
  paintPill() {
    const p = $('#jamPill'); p.hidden = !this.role;
    p.className = 'pill jam'; p.textContent = this.role === 'host' ? `Jam, ${this.peers.size + 1} persone` : `Jam con ${this.st?.hostName || 'host'}`;
  },
  render() { clearTimeout(this.renderT); this.renderT = setTimeout(() => { this.paintPill(); if (location.hash.startsWith('#/jam')) vJam(); }, 120); },

  /* ---------- host ---------- */
  async create({ name, net, visible }) {
    this.net = net; this.role = 'host';
    const secret = SUBTLE ? crypto.getRandomValues(new Uint8Array(32)) : null;
    this.room = { id: uid(12), name: name || `La Jam di ${this.name()}`, secret, base: signalBase(), created: Date.now() };
    this.set.visible = visible;
    const key = secret ? await JC.aesFrom(secret, 'armony-signal', this.room.id) : null;
    if (this.room.base) {
      try {
        // la sessione (se la Jam sta sul server in uso) serve solo all'attività "ha avviato una Jam": il segreto resta nel link
        const tok = srv()?.session && absUrl(srv().url) === this.room.base ? { 'X-Token': srv().session } : {};
        const r = await fetch(`${this.room.base}/api/jam/${this.room.id}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...tok }, body: JSON.stringify({ host: this.me, name: this.room.name, hostName: this.name(), visible }) });
        if (!r.ok) throw 0;
        this.sig = new Signal(this.room.base, this.room.id, this.me, key);
        this.sig.loop((from, m, enc) => this.hostSignal(from, m, enc), () => toast('Il server ha chiuso la Jam.'));
        SrvClock.start(this.room.base);  // per gli ospiti che arrivano tramite il server
      } catch { this.sig = null; toast('Server della Jam non raggiungibile: usa gli inviti con codice.'); }
    }
    this.timers.push(setInterval(() => this.pushState(), 3000), setInterval(() => {
      this.peers.forEach(p => p.state === 'connected' && p.detectRoute());
      this.peers.forEach(p => p.relay && Date.now() - p.seen > 40000 && this.peerGone(p));  // ospite tramite server sparito
    }, 10000));
    this.sys('Jam creata. Invita gli amici con il link o il codice.');
    this.render();
  },
  async inviteLink() {
    const info = { b: this.room.base, r: this.room.id, n: this.room.name, h: this.name(), k: this.room.secret ? b64u.enc(this.room.secret) : null, net: this.net };
    // nell'app nativa l'invito porta al client web del server della Jam, non al telefono
    const base = !NATIVE && /^https?:/.test(location.protocol) ? location.origin + location.pathname : (this.room.base || '') + '/';
    return `${base}#/jam/entra/${await pack(info)}`;
  },
  async newPeer(id, name, peerPub) {
    const kp = SUBTLE ? await JC.ecdh() : null;
    const p = new Peer(id, { name, kp }); p.peerPub = peerPub;
    p.attach(p.pc.createDataChannel('jam', { ordered: true }));
    const tr = p.pc.addTransceiver('audio', { direction: 'sendonly' }); p.sender = tr.sender;
    this.peers.set(id, p);
    return p;
  },
  async hostSignal(from, m, enc) {
    if (!enc && this.room.secret && m.t !== 'knock') return;
    if (m.t === 'knock') return this.onKnock(from, m);
    if (m.t === 'data') { const p = this.peers.get(from); if (!p?.relay) return; const o = await p.open(m.d); if (o) { p.seen = Date.now(); this.onData(p, o); } return; }
    if (m.t === 'hello' && m.via === 'server') {
      // ospite tramite il server (scelto, o ripiego quando il collegamento diretto non si apre)
      if (!SUBTLE || !m.pub) return this.sig.send(from, { t: 'deny' });
      const old = this.peers.get(from); if (old) { old.close(); this.peers.delete(from); }
      else if (this.set.approve && !(await this.confirmGuest(m.name))) return this.sig.send(from, { t: 'deny' });
      const p = new RelayPeer(from, { name: String(m.name || 'Ospite').slice(0, 30), kp: await JC.ecdh() });
      await p.setKey(m.pub); this.peers.set(from, p);
      await p.raw({ t: 'relay', pub: await JC.pub(p.kp) });
      return this.peerOpen(p);
    }
    if (m.t === 'hello') {
      if (this.set.approve && !(await this.confirmGuest(m.name))) return this.sig.send(from, { t: 'deny' });
      this.peers.get(from)?.close();
      const p = await this.newPeer(from, String(m.name || 'Ospite').slice(0, 30), m.pub); p.want = m.want || 'sync';
      p.pc.onicecandidate = e => e.candidate && this.sig.send(from, { t: 'ice', c: e.candidate.toJSON() });
      const offer = await p.pc.createOffer(); offer.sdp = stereoOpus(offer.sdp);
      await p.pc.setLocalDescription(offer);
      await this.sig.send(from, { t: 'offer', sdp: p.pc.localDescription.sdp, pub: p.kp ? await JC.pub(p.kp) : null });
      this.render();
    } else if (m.t === 'answer') { const p = this.peers.get(from); if (p) await p.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); }
    else if (m.t === 'ice') { try { await this.peers.get(from)?.pc.addIceCandidate(m.c); } catch {} }
    else if (m.t === 'bye') { const p = this.peers.get(from); if (p) this.peerGone(p); }
  },
  confirmGuest(name) {
    return new Promise(res => {
      const d = $('#dlg2');
      d.innerHTML = `<h3>${esc(name || 'Qualcuno')} vuole entrare nella Jam</h3><p class="sub">Dopo l'ingresso confrontate il codice di sicurezza.</p>
        <div class="row"><button class="btn primary" id="gOk">Fai entrare</button><button class="btn" id="gNo">Rifiuta</button></div>`;
      const done = v => { d.onclose = null; d.close(); res(v); };
      $('#gOk').onclick = () => done(true); $('#gNo').onclick = () => done(false); d.onclose = () => res(false);
      d.showModal();
    });
  },
  async onKnock(from, m) {
    if (!(await this.confirmGuest(m.name))) return this.sig.send(from, { t: 'deny' }, true);
    if (this.room.secret && m.pub && SUBTLE) {
      const kp = await JC.ecdh(); const k = await JC.shared(kp, m.pub, 'armony-knock', this.room.id);
      await this.sig.send(from, { t: 'admit', pub: await JC.pub(kp), box: await JC.seal(k, { k: b64u.enc(this.room.secret), net: this.net }) }, true);
    } else await this.sig.send(from, { t: 'admit', k: this.room.secret ? b64u.enc(this.room.secret) : null, net: this.net }, true);
  },
  peerOpen(p) {
    if (this.role === 'host') {
      p.send({ t: 'welcome', room: this.room.name, hostName: this.name(), set: this.set });
      this.sys(`${p.name} è entrato.`); this.broadcast({ t: 'chat', sys: true, text: `${p.name} è entrato.` }, p);
      this.pushState(p); this.pushQueue(); this.pushPeers();
      if (p.want === 'broadcast') this.startBroadcast(p);
    } else {
      this.timers.push(setInterval(() => this.ping(), 10000));
      for (let i = 0; i < 8; i++) setTimeout(() => this.ping(), i * 250);
      p.send({ t: 'mode', want: this.mode });
    }
    this.render();
  },
  peerGone(p) {
    if (this.role === 'host') {
      if (!this.peers.has(p.id)) return;
      this.peers.delete(p.id); p.close(); this.sys(`${p.name} è uscito.`); this.pushPeers(); this.render();
    } else if (this.role === 'guest' && p === this.host) {
      toast('Collegamento con l\'host perso.'); this.leave(true);
    }
  },
  async startBroadcast(p) {
    if (p.relay) { p.send({ t: 'chat', sys: true, text: 'Tramite il server la trasmissione non c\'è: ascolti in modo sincronizzato.' }); return; }
    Engine.graph();
    if (!Engine.dest) { p.send({ t: 'chat', sys: true, text: 'L\'host usa la modalità compatibile: la trasmissione non è disponibile.' }); return; }
    const track = Engine.dest.stream.getAudioTracks()[0];
    await p.sender.replaceTrack(track);
    try { const prm = p.sender.getParameters(); prm.encodings = prm.encodings?.length ? prm.encodings : [{}]; prm.encodings[0].maxBitrate = 192000; prm.encodings[0].priority = 'high'; await p.sender.setParameters(prm); } catch {}
  },
  hostState() {
    const t = S.queue[S.index];
    const at = now();  // sat: lo stesso istante con l'orologio del server, per chi è collegato tramite il server
    return { t: 'state', track: wire(t), pos: Engine.time(), playing: !Engine.el.paused && !!t, at, sat: SrvClock.ready() ? at + SrvClock.off : null, rate: P.speed, hostName: this.name(), room: this.room.name };
  },
  pushState(only) { if (this.role !== 'host') return; const st = this.hostState(); only ? only.send(st) : this.broadcast(st); },
  queueMsg() {
    const up = S.queue.slice(S.index + 1, S.index + 41).map(t => ({ ...wire(t), k: key(t), votes: this.votes.get(key(t))?.size || 0 }));
    return { t: 'queue', items: up, proposals: this.proposals.map(x => ({ ...wire(x.track), by: x.by, k: x.k })) };
  },
  pushQueue() { if (this.role === 'host') this.broadcast(this.queueMsg()); },
  pushPeers() {
    if (this.role !== 'host') return;
    const list = [{ id: this.me, name: this.name(), host: true }, ...[...this.peers.values()].map(p => ({ id: p.id, name: p.name, conn: p.conn }))];
    this.broadcast({ t: 'peers', list });
  },
  broadcast(m, except) { this.peers.forEach(p => p !== except && p.send(m)); },
  async onData(p, m) {
    if (this.role === 'host') return this.hostData(p, m);
    return this.guestData(p, m);
  },
  async hostData(p, m) {
    switch (m.t) {
      case 'ping': p.send({ t: 'pong', t0: m.t0, th: now() }); break;
      case 'chat': { const text = String(m.text || '').slice(0, 500); if (!text) break; this.addChat(p.name, text, p.id); this.broadcast({ t: 'chat', name: p.name, text, from: p.id }, p); break; }
      case 'react': if (REACTIONS.includes(m.e)) { floatReaction(m.e); this.broadcast({ t: 'react', e: m.e }, p); } break;
      case 'mode': p.want = m.want === 'broadcast' && !p.relay ? 'broadcast' : 'sync'; if (p.want === 'broadcast') this.startBroadcast(p); else p.sender?.replaceTrack(null); break;
      case 'suggest': {
        const t = localize(m.track); if (!t || t.serverId === 'nessuno') { p.send({ t: 'chat', sys: true, text: 'Questo brano non è sul server dell\'host.' }); break; }
        t.jamBy = p.name;
        if (this.set.openQueue) { this.insertSuggestion(t); this.sys(`${p.name} ha aggiunto ${t.title}.`); }
        else { this.proposals.push({ track: t, by: p.name, k: uid(6) }); this.sys(`${p.name} propone ${t.title}.`); toast(`${p.name} propone ${t.title}`); }
        this.pushQueue(); this.render(); break;
      }
      case 'vote': { const s = this.votes.get(m.k) || new Set(); s.has(p.id) ? s.delete(p.id) : s.add(p.id); this.votes.set(m.k, s); this.pushQueue(); this.render(); break; }
      case 'control': {
        if (!this.set.control) { p.send({ t: 'chat', sys: true, text: 'L\'host non ha dato il controllo agli ospiti.' }); break; }
        const a = m.a;
        if (a === 'play' && Engine.el.paused) ctlToggle(); else if (a === 'pause' && !Engine.el.paused) ctlToggle();
        else if (a === 'next') ctlNext(false); else if (a === 'prev') ctlPrev(); else if (a === 'seek') ctlSeek(+m.v || 0);
        else if (a === 'jump') { const i = S.queue.findIndex(t => key(t) === m.k); if (i >= 0) playIndex(i); }
        this.sys(`${p.name}: ${{ play: 'play', pause: 'pausa', next: 'brano successivo', prev: 'brano precedente', seek: 'spostamento', jump: 'cambio brano' }[a] || a}`);
        break;
      }
      case 'search': {
        try { const r = (await api('search3', { query: String(m.q).slice(0, 100), songCount: 30, albumCount: 0, artistCount: 0 })).searchResult3; p.send({ t: 'searchres', req: m.req, items: arr(r.song).map(x => wire(norm(x))) }); }
        catch { p.send({ t: 'searchres', req: m.req, items: [] }); }
        break;
      }
      case 'bye': this.peerGone(p); break;
    }
  },
  insertSuggestion(t) {
    let at = S.index + 1; while (at < S.queue.length && S.queue[at].jamBy) at++;
    S.queue.splice(at, 0, t); persistQueue();
    if (!currentTrack()) playIndex(at);
  },
  sortByVotes() {
    const up = S.queue.slice(S.index + 1).map((t, i) => ({ t, i, v: this.votes.get(key(t))?.size || 0 }));
    up.sort((a, b) => b.v - a.v || a.i - b.i);
    S.queue = [...S.queue.slice(0, S.index + 1), ...up.map(x => x.t)]; persistQueue(); this.pushQueue(); this.render();
  },

  /* ---------- ospite ---------- */
  async join(info, { name, want } = {}) {
    if (this.role) await this.leave(true);
    if (name) { P.nick = name; savePrefs(); }
    const viaServer = info.net === 'server';
    if (viaServer && !SUBTLE) { toast('Per entrare tramite il server serve Armony in HTTPS (o l\'app).'); return; }
    if (viaServer && !hasAccount(info.b)) { toast(`Per ascoltare tramite il server ti serve un account su ${serverLabel(info.b)}.`, 6000); return; }
    this.net = info.net || 'internet'; this.role = 'guest'; this.mode = viaServer ? 'sync' : want || 'sync'; this.via = viaServer ? 'server' : 'direct';
    this.room = { id: info.r, name: info.n, base: info.b, secret: info.k ? b64u.dec(info.k) : null };
    const key = this.room.secret && SUBTLE ? await JC.aesFrom(this.room.secret, 'armony-signal', this.room.id) : null;
    if (this.room.secret && !SUBTLE) { toast('Questa Jam è cifrata e serve Armony in HTTPS per entrare.'); this.role = null; return; }
    this.sig = new Signal(this.room.base, this.room.id, this.me, key);
    const kp = SUBTLE ? await JC.ecdh() : null; this.kp = kp;
    this.sig.loop((from, m, enc) => this.guestSignal(from, m, enc, kp), () => { toast('La Jam è stata chiusa.'); this.leave(true); });
    if (viaServer) await SrvClock.start(this.room.base);
    try { await this.sig.send('host', { t: 'hello', name: this.name(), pub: kp ? await JC.pub(kp) : null, want: this.mode, via: viaServer ? 'server' : undefined }); }
    catch (e) { toast(e.message); this.leave(true); return; }
    this.sys(`Collegamento a ${info.h ? 'la Jam di ' + info.h : 'la Jam'}${viaServer ? ' tramite il server' : ''}…`);
    this.timers.push(setInterval(() => this.syncTick(), 1000));
    // collegamento diretto che non si apre (NAT difficili, 5G): con un account si passa al server
    if (!viaServer) setTimeout(() => this.fallback(), 10000);
    this.render(); location.hash = '#/jam';
  },
  async fallback() {
    if (this.role !== 'guest' || this.via === 'server' || this.host?.dc?.readyState === 'open') return;
    if (!SUBTLE || !hasAccount(this.room.base) || !this.sig) return toast('Il collegamento diretto non si apre. Con un account sul server dell\'host potresti entrare tramite il server.', 6000);
    this.host?.close(); this.peers.clear(); this.host = null;
    this.via = 'server'; this.mode = 'sync'; this.remoteAudio?.pause();
    await SrvClock.start(this.room.base);
    await this.sig.send('host', { t: 'hello', name: this.name(), pub: await JC.pub(this.kp), want: 'sync', via: 'server' }).catch(() => {});
    this.sys('Il collegamento diretto non si apriva: passo tramite il server.'); this.render();
  },
  async guestSignal(from, m, enc, kp) {
    if (!enc && this.room.secret && !['deny'].includes(m.t)) return;
    if (m.t === 'deny') { toast('L\'host non ti ha fatto entrare.'); return this.leave(true); }
    if (m.t === 'relay' && this.via === 'server') {
      const p = new RelayPeer(from, { name: 'host', kp }); await p.setKey(m.pub);
      this.host = p; this.peers.set(from, p); this.lastHost = Date.now(); return this.peerOpen(p);
    }
    if (m.t === 'data') { const p = this.peers.get(from); if (!p?.relay) return; const o = await p.open(m.d); if (o) { this.lastHost = Date.now(); this.onData(p, o); } return; }
    if (m.t === 'offer') {
      const p = new Peer(from, { name: 'host', kp }); p.peerPub = m.pub; this.host = p; this.peers.set(from, p);
      p.pc.ondatachannel = e => p.attach(e.channel);
      p.pc.ontrack = e => this.onRemoteAudio(e.streams[0] || new MediaStream([e.track]));
      p.pc.onicecandidate = e => e.candidate && this.sig.send(from, { t: 'ice', c: e.candidate.toJSON() });
      await p.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      const ans = await p.pc.createAnswer(); ans.sdp = stereoOpus(ans.sdp);
      await p.pc.setLocalDescription(ans);
      await this.sig.send(from, { t: 'answer', sdp: p.pc.localDescription.sdp });
    } else if (m.t === 'ice') { try { await this.host?.pc.addIceCandidate(m.c); } catch {} }
  },
  async knock(base, roomId) {
    const kp = SUBTLE ? await JC.ecdh() : null;
    const sig = new Signal(base, roomId, this.me, null);
    toast('Richiesta inviata, attendi che l\'host ti faccia entrare…', 30000);
    sig.loop(async (from, m) => {
      if (m.t === 'deny') { sig.stop(); toast('L\'host ha rifiutato.'); }
      if (m.t === 'admit') {
        sig.stop();
        let k = m.k, net = m.net;
        if (m.box && kp) { const sk = await JC.shared(kp, m.pub, 'armony-knock', roomId); const o = await JC.open(sk, m.box); k = o.k; net = o.net; }
        this.join({ b: base, r: roomId, k, net, n: 'Jam' });
      }
    });
    await sig.send('host', { t: 'knock', name: this.name(), pub: kp ? await JC.pub(kp) : null }, true);
  },
  async guestData(p, m) {
    switch (m.t) {
      case 'welcome': this.set = m.set || this.set; this.sys(`Sei nella Jam "${m.room}" di ${m.hostName}.`); this.room.name = m.room; break;
      case 'pong': { const t1 = now(), rtt = t1 - m.t0; this.samples.push({ rtt, off: m.th - (m.t0 + t1) / 2 }); this.samples = this.samples.slice(-12); this.offset = this.samples.reduce((a, b) => b.rtt < a.rtt ? b : a).off; p.rtt = Math.round(rtt); break; }
      case 'state': this.onState(m); break;
      case 'queue': this.queue = m.items.map(localize); this.proposals = m.proposals || []; break;
      case 'peers': this.roster = m.list; break;
      case 'chat': m.sys ? this.sys(m.text) : this.addChat(m.name, m.text, m.from); break;
      case 'react': floatReaction(m.e); break;
      case 'searchres': this.searchCb?.(m); break;
      case 'bye': toast('L\'host ha chiuso la Jam.'); this.leave(true); return;
    }
    this.render();
  },
  ping() { this.host?.send({ t: 'ping', t0: now() }); },
  onState(st) {
    const prev = this.track; this.st = st; this.playing = st.playing;
    this.track = localize(st.track);
    if (!prev || key(prev) !== key(this.track || {})) { updateNowPlaying(); if (location.hash.startsWith('#/ora')) vNow(); }
    paintButtons(); this.paintPill();
    if (this.mode === 'sync' && this.track && this.track.serverId === 'nessuno') { this.setMode('broadcast'); toast('Non hai accesso al server dell\'host: ascolti la sua trasmissione.'); return; }
    this.syncTick(true);
  },
  async syncTick(force) {
    if (this.role === 'guest' && this.via === 'server' && this.host && Date.now() - this.lastHost > 40000) { toast('L\'host non risponde più.'); return this.leave(true); }
    if (this.role !== 'guest' || !this.st) return;
    paintTime();
    if (this.mode !== 'sync' || !this.track || this.track.serverId === 'nessuno') return;
    const a = Engine.el, want = this.estPos();
    if (a.dataset.key !== key(this.track)) { await Engine.load(this.track, Engine.cur, { autoplay: this.st.playing, startAt: want + .3 }); return; }
    if (!this.st.playing) { if (!a.paused) a.pause(); return; }
    if (a.paused) { try { await a.play(); } catch {} }
    if (a.readyState < 3) return;
    const diff = a.currentTime - this.estPos();
    if (Math.abs(diff) > .45) { a.currentTime = this.estPos() + .12; a.playbackRate = P.speed; }
    else if (Math.abs(diff) > .03) a.playbackRate = (this.st.rate || 1) * (1 - Math.max(-.04, Math.min(.04, diff * .5)));
    else a.playbackRate = this.st.rate || 1;
  },
  onRemoteAudio(stream) {
    if (!this.remoteAudio) { this.remoteAudio = new Audio(); this.remoteAudio.autoplay = true; document.body.append(this.remoteAudio); }
    this.remoteAudio.srcObject = stream; Engine.applyVolume();
    if (this.mode === 'broadcast') this.remoteAudio.play().catch(() => toast('Tocca play per sentire la trasmissione.'));
  },
  setMode(mode) {
    this.mode = mode; this.host?.send({ t: 'mode', want: mode });
    if (mode === 'broadcast') { Engine.decks.forEach(d => d.pause()); this.remoteAudio?.play().catch(() => {}); }
    else { this.remoteAudio?.pause(); this.syncTick(true); }
    this.render(); paintButtons();
  },
  guestControl(a, v) {
    if (a === 'play' || a === 'pause') { if (this.mode === 'broadcast' && this.remoteAudio && this.remoteAudio.paused) { this.remoteAudio.play().catch(() => {}); return; } }
    if (!this.set.control) return toast('Solo l\'host controlla la musica. Puoi proporre brani e votare.');
    if (a === 'jump') { const t = S.lastList?.[v]; return t && this.host?.send({ t: 'control', a: 'jump', k: t.k || key(t) }); }
    this.host?.send({ t: 'control', a, v });
  },
  suggest(t) {
    if (!this.role) return;
    if (this.role === 'host') { this.insertSuggestion({ ...t, jamBy: this.name() }); this.pushQueue(); this.render(); return toast('Aggiunto alla coda della Jam.'); }
    this.host?.send({ t: 'suggest', track: wire(t) }); toast(this.set.openQueue ? 'Aggiunto alla coda della Jam.' : 'Proposta inviata all\'host.');
  },
  vote(k) { if (this.role === 'guest') this.host?.send({ t: 'vote', k }); else { const s = this.votes.get(k) || new Set(); s.has(this.me) ? s.delete(this.me) : s.add(this.me); this.votes.set(k, s); this.pushQueue(); this.render(); } },
  react(e) { floatReaction(e); this.role === 'host' ? this.broadcast({ t: 'react', e }) : this.host?.send({ t: 'react', e }); },
  say(text) {
    text = text.trim().slice(0, 500); if (!text) return;
    this.addChat(this.name(), text, this.me);
    this.role === 'host' ? this.broadcast({ t: 'chat', name: this.name(), text, from: this.me }) : this.host?.send({ t: 'chat', text });
  },
  addChat(name, text, from) { this.chat.push({ name, text, from, ts: Date.now() }); this.chat = this.chat.slice(-200); if (!location.hash.startsWith('#/jam') && from !== this.me) toast(`${name}: ${text}`); },
  sys(text) { this.chat.push({ sys: true, text, ts: Date.now() }); this.chat = this.chat.slice(-200); this.render(); },

  /* ---------- inviti manuali, senza server ---------- */
  async manualOffer() {
    const id = uid(12); const p = await this.newPeer(id, 'Ospite (codice)', null);
    p.manual = true;
    const offer = await p.pc.createOffer(); offer.sdp = stereoOpus(offer.sdp);
    await p.pc.setLocalDescription(offer); await waitIce(p.pc);
    this.pending.set(id, p);
    return pack({ v: 1, id, r: this.room.id, n: this.room.name, h: this.name(), net: this.net, sdp: p.pc.localDescription.sdp, pub: p.kp ? await JC.pub(p.kp) : null });
  },
  async manualAccept(code) {
    const m = await unpack(code); const p = this.pending.get(m.id);
    if (!p) throw new Error('Questo codice di risposta non corrisponde a un invito aperto.');
    p.peerPub = m.pub; p.name = String(m.name || 'Ospite').slice(0, 30);
    await p.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); this.pending.delete(m.id);
  },
  async manualJoin(code, name) {
    const m = await unpack(code);
    if (this.role) await this.leave(true);
    if (name) { P.nick = name; savePrefs(); }
    this.net = m.net; this.role = 'guest'; this.mode = 'sync';
    this.room = { id: m.r, name: m.n, base: '', secret: null };
    const kp = SUBTLE ? await JC.ecdh() : null;
    const p = new Peer('host', { name: m.h, kp }); p.peerPub = m.pub; this.host = p; this.peers.set('host', p);
    p.pc.ondatachannel = e => p.attach(e.channel);
    p.pc.ontrack = e => this.onRemoteAudio(e.streams[0] || new MediaStream([e.track]));
    await p.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
    const ans = await p.pc.createAnswer(); ans.sdp = stereoOpus(ans.sdp);
    await p.pc.setLocalDescription(ans); await waitIce(p.pc);
    this.timers.push(setInterval(() => this.syncTick(), 1000));
    this.sys(`Invia il codice di risposta a ${m.h}.`);
    return pack({ v: 1, id: m.id, name: this.name(), sdp: p.pc.localDescription.sdp, pub: kp ? await JC.pub(kp) : null });
  },

  /* ---------- uscita ---------- */
  async leave(silent) {
    const was = this.role;
    if (was === 'host') {
      this.broadcast({ t: 'bye' });
      if (this.room?.base && this.sig) fetch(`${this.room.base}/api/jam/${this.room.id}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: this.me }), keepalive: true }).catch(() => {});
    } else if (was === 'guest') { this.host?.send({ t: 'bye' }); this.sig?.send('host', { t: 'bye' }).catch(() => {}); }
    await sleep(80);
    this.sig?.stop(); this.peers.forEach(p => p.close()); this.peers.clear(); this.pending.forEach(p => p.close()); this.pending.clear();
    this.timers.forEach(clearInterval); this.timers = []; SrvClock.stop();
    if (was === 'guest') { Engine.stop(); this.remoteAudio?.pause(); if (this.remoteAudio) this.remoteAudio.srcObject = null; }
    Object.assign(this, { role: null, room: null, sig: null, host: null, track: null, st: null, queue: [], proposals: [], votes: new Map(), roster: null, samples: [], me: uid(12), via: 'direct', kp: null });
    if (!silent) toast(was === 'host' ? 'Jam chiusa.' : 'Sei uscito dalla Jam.');
    updateNowPlaying(); this.render(); paintTime();
    if (was === 'guest' && S.queue[S.index] && !silent) Engine.load(S.queue[S.index], Engine.cur, { autoplay: false });
  },
  async nearby() {
    const base = signalBase(); if (!base) return [];
    try { return (await (await fetch(base + '/api/jam/nearby')).json()).filter(j => j.id !== this.room?.id); } catch { return []; }
  },

  /* ---------- azioni dalla vista ---------- */
  async action(act, el) {
    switch (act) {
      case 'jamcreate': {
        if (!srv()) return toast('Per ospitare una Jam serve un server musicale.');
        const net = $('[name=jnet]:checked').value;
        if (P.nick !== $('#jName').value.trim() && $('#jName').value.trim()) { P.nick = $('#jName').value.trim(); savePrefs(); }
        await this.create({ name: $('#jRoom').value.trim(), net, visible: $('#jVis').checked });
        if (!S.queue.length) toast('Avvia della musica: gli ospiti la sentiranno subito.');
        break;
      }
      case 'jamjoinlink': {
        const v = $('#jCode').value.trim(); if (!v) return toast('Incolla un link o un codice.');
        const info = await unpack(v);
        if (info.sdp) { const ans = await this.manualJoin(v, $('#jName').value.trim()); showCode('Codice di risposta', 'Invialo a chi ti ha invitato: lo incolla nella sua Jam e siete collegati.', ans); location.hash = '#/jam'; }
        else this.join(info, { name: $('#jName').value.trim(), want: $('[name=jwant]:checked')?.value });
        break;
      }
      case 'jamconfirm': { const info = await unpack(el.dataset.code); this.join(info, { name: $('#jName').value.trim(), want: $('[name=jwant]:checked')?.value }); break; }
      case 'jamknock': this.knock(el.dataset.base || signalBase(), el.dataset.id); break;
      case 'jamcopy': { const l = await this.inviteLink(); if (navigator.share && /Mobi/.test(navigator.userAgent)) { try { await navigator.share({ title: 'Entra nella mia Jam', text: `Ascoltiamo insieme su Armony: ${this.room.name}`, url: l }); break; } catch {} } await copyText(l); toast('Link d\'invito copiato. Contiene la chiave: mandalo solo agli amici.'); break; }
      case 'jamqr': showCode('Invito', 'Inquadra con la fotocamera del telefono.', await this.inviteLink(), true); break;
      case 'jammanual': showCode('Codice d\'invito', 'Mandalo all\'amico (anche via WhatsApp). Lui ti rimanda un codice di risposta: incollalo qui sotto.', await this.manualOffer(), false, true); break;
      case 'jamleave': if (confirm(this.role === 'host' ? 'Chiudere la Jam per tutti?' : 'Uscire dalla Jam?')) this.leave(); break;
      case 'jamkick': { const p = this.peers.get(el.dataset.id); if (p) { p.send({ t: 'bye' }); this.peerGone(p); } break; }
      case 'jamvote': this.vote(el.dataset.k); break;
      case 'jamsort': this.sortByVotes(); break;
      case 'jamprop': {
        const i = this.proposals.findIndex(x => x.k === el.dataset.k); if (i < 0) break;
        const [x] = this.proposals.splice(i, 1); if (el.dataset.ok === '1') { this.insertSuggestion(x.track); this.sys(`Accettata la proposta di ${x.by}.`); }
        this.pushQueue(); this.render(); break;
      }
      case 'jamreact': this.react(el.dataset.e); break;
      case 'jammode': this.setMode(el.dataset.m); break;
      case 'jamset': this.set[el.dataset.k] = el.checked; this.broadcast({ t: 'welcome', room: this.room.name, hostName: this.name(), set: this.set }); if (el.dataset.k === 'visible' && this.room.base) fetch(`${this.room.base}/api/jam/${this.room.id}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: this.me, name: this.room.name, hostName: this.name(), visible: el.checked }) }); break;
      case 'jamplay': { const t = this.searchRes?.[+el.dataset.i]; if (t) this.suggest(t); break; }
    }
  }
};

function floatReaction(e) {
  const s = document.createElement('div'); s.className = 'float-r'; s.textContent = e; s.style.left = (10 + Math.random() * 80) + 'vw';
  document.body.append(s); setTimeout(() => s.remove(), 2700);
}
async function showCode(title, text, code, qrOnly, withReply) {
  const d = $('#dlg2'); d.className = '';
  d.innerHTML = `<h3>${esc(title)}</h3><p class="sub">${esc(text)}</p>
    <div id="qrBox" style="text-align:center;margin-bottom:12px"></div>
    ${qrOnly ? '' : `<div class="code">${esc(code)}</div>`}
    <div class="row" style="margin:12px 0"><button class="btn primary" id="cCopy">Copia</button>${navigator.share ? '<button class="btn" id="cShare">Condividi</button>' : ''}<button class="btn" onclick="this.closest('dialog').close()">Chiudi</button></div>
    ${withReply ? `<label class="f">Codice di risposta dell'amico<textarea id="cReply" placeholder="AM1…"></textarea></label><div class="row" style="margin-top:10px"><button class="btn primary" id="cOk">Collega</button></div>` : ''}`;
  $('#cCopy').onclick = async () => { await copyText(code); toast('Copiato.'); };
  if ($('#cShare')) $('#cShare').onclick = () => navigator.share({ text: code }).catch(() => {});
  if (withReply) $('#cOk').onclick = async () => { try { await Jam.manualAccept($('#cReply').value); d.close(); toast('Collegamento in corso…'); } catch (e) { toast(e.message); } };
  d.showModal();
  if (code.length < 2300) {
    try {
      if (!window.QRCode) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'; s.onload = res; s.onerror = rej; document.head.append(s); });
      const box = document.createElement('div'); box.className = 'qr'; $('#qrBox').append(box);
      new QRCode(box, { text: code, width: 240, height: 240, correctLevel: QRCode.CorrectLevel.L });
    } catch { $('#qrBox').innerHTML = ''; }
  }
}

/* ================= vista Jam ================= */
async function vJam(sub = '') {
  const secureNote = SUBTLE ? `${ic('lock')} Cifratura end-to-end attiva` : `${ic('lock')} Cifratura WebRTC attiva. Apri Armony in HTTPS per lo strato end-to-end completo.`;
  if (sub.startsWith('entra/') && !Jam.role) {
    const code = sub.slice(6), n = Scene.nav; let info; try { info = await unpack(code); } catch { if (!stale(n)) view.innerHTML = '<div class="empty">Link d\'invito non valido.</div>'; return; }
    if (stale(n)) return;
    const viaServer = info.net === 'server', noAcc = viaServer && !hasAccount(info.b);
    view.innerHTML = `<h1>${esc(info.n)}</h1><p class="sub">${esc(info.h)} ti invita ad ascoltare insieme${viaServer ? ', tramite il server' : ''}.</p>
      <div class="panel stack" style="max-width:520px">
        <label class="f">Il tuo nome<input type="text" id="jName" value="${esc(P.nick)}" maxlength="30" placeholder="Come ti chiami?"></label>
        ${viaServer ? `<p class="small" style="color:var(--muted);margin:0">Ognuno ascolta dal server, alla sua qualità, allineato all'host.</p>` : joinModeSeg()}
        ${noAcc ? `<p class="small" style="margin:0">Per ascoltare tramite il server ti serve un account su ${esc(serverLabel(info.b))}.</p>
          <button class="btn primary" data-act="addsrv" data-url="${esc(info.b)}">${ic('plus')} Accedi o crea un account</button>`
          : `<button class="btn primary" data-act="jamconfirm" data-code="${esc(code)}">${ic('jam')} Entra nella Jam</button>`}
        <p class="small" style="color:var(--muted);margin:0">${secureNote}</p>
      </div>`;
    return;
  }
  if (!Jam.role) {
    const canRelay = SUBTLE && !!signalBase() && !!srv(), defNet = canRelay ? 'server' : 'lan';
    const radios = [...Radio.list.values()].filter(x => x.on).length;
    view.innerHTML = `<h1>Jam</h1><p class="sub">Ascoltate la stessa musica nello stesso momento, ognuno dal suo telefono. Proponete brani, votate, chattate.</p>
    ${Radio.ok() ? `<a class="hbanner" href="#/radio">${ic('radio')}<span class="grow"><small>Jam Radio${radios ? ` · ${radios} in onda` : ''}</small><b>Stazioni sempre accese: sintonizzati</b></span>${ic('chevr')}</a>` : ''}
    <div class="grid2" style="align-items:start">
      <div class="panel stack"><h3>Crea una Jam</h3>
        <label class="f">Il tuo nome<input type="text" id="jName" value="${esc(P.nick)}" maxlength="30"></label>
        <label class="f">Nome della Jam<input type="text" id="jRoom" placeholder="La Jam di ${esc(Jam.name())}" maxlength="60"></label>
        <div class="seg jnet" role="radiogroup" aria-label="Collegamento">
          <label><input type="radio" name="jnet" value="server" ${canRelay ? (defNet === 'server' ? 'checked' : '') : 'disabled'}><span>${ic('speaker')} Server</span></label>
          <label><input type="radio" name="jnet" value="lan" ${defNet === 'lan' ? 'checked' : ''}><span>${ic('wifi')} Stessa rete</span></label>
          <label><input type="radio" name="jnet" value="internet"><span>${ic('globe')} Internet</span></label></div>
        <p class="small" style="color:var(--muted);margin:0">Server: il più affidabile, anche in 5G; ognuno ascolta dal server allineato all'host (serve un account sul server${canRelay ? '' : ' e Armony in HTTPS o l\'app'}). Stessa rete: collegamento diretto dentro casa o sul Wi-Fi del locale. Internet: diretto fra reti diverse, permette anche la trasmissione dall'host.</p>
        <label class="check"><input type="checkbox" id="jVis" checked><span>Visibile a chi è sulla mia rete<small>Chi è vicino può chiedere di entrare senza link. Entra solo se lo accetti.</small></span></label>
        <button class="btn primary" data-act="jamcreate">${ic('jam')} Crea</button>
      </div>
      <div><div class="panel stack"><h3>Entra con un link o un codice</h3>
        <textarea id="jCode" placeholder="Incolla qui il link d'invito o il codice AM1…" style="min-height:70px"></textarea>
        ${joinModeSeg()}
        <button class="btn" data-act="jamjoinlink">Entra</button></div>
        <div class="panel"><div class="row between"><h3 style="margin:0">Jam vicine</h3><button class="btn sm" onclick="vJam()">Aggiorna</button></div><div id="jNear"><p class="sub">Cerco sulla rete…</p></div></div>
      </div>
    </div>
    <p class="small" style="color:var(--muted)">${secureNote}</p>`;
    Jam.nearby().then(js => { const b = $('#jNear'); if (b) b.innerHTML = js.length ? js.map(j => `<div class="list-item" data-act="jamknock" data-id="${esc(j.id)}" data-base="${esc(j.base || '')}"><span class="grow"><b>${esc(j.name)}</b><small>di ${esc(j.hostName || '?')}${j.server ? ', server ' + esc(j.server) : ''}</small></span><span class="btn sm">Chiedi di entrare</span></div>`).join('') : '<p class="sub" style="margin:8px 0 0">Nessuna Jam aperta sulla tua rete.</p>'; });
    return;
  }
  const host = Jam.role === 'host';
  const cur = currentTrack();
  const upcoming = host ? S.queue.slice(S.index + 1, S.index + 41).map(t => ({ ...t, k: key(t), votes: Jam.votes.get(key(t))?.size || 0 })) : Jam.queue;
  const props = host ? Jam.proposals.map(x => ({ ...x.track, by: x.by, k: x.k })) : Jam.proposals;
  const roster = host ? [{ id: Jam.me, name: Jam.name(), host: true }, ...[...Jam.peers.values()].map(p => ({ id: p.id, name: p.name, conn: p.conn, rtt: p.rtt, safety: p.safety, state: p.state }))]
    : (Jam.roster || []).map(r => r.host && Jam.host ? { ...r, conn: Jam.host.conn, rtt: Jam.host.rtt, safety: Jam.host.safety } : r);
  S.lastList = upcoming;
  view.innerHTML = `<div class="row between"><div><h1>${esc(Jam.room.name)}</h1><p class="sub">${host ? 'Sei l\'host.' : `Ospite di ${esc(Jam.st?.hostName || '…')}.`} ${Jam.role === 'guest' && Jam.via === 'server' ? 'Tramite il server.' : { lan: 'Solo rete locale.', server: 'Tramite il server.' }[Jam.net] || 'Via internet.'}</p></div>
    <button class="btn danger" data-act="jamleave">${host ? 'Chiudi la Jam' : 'Esci'}</button></div>
  <div class="jamgrid"><div>
    ${cur ? `<div class="list-item" style="cursor:pointer" onclick="location.hash='#/ora'"><span class="pic">${imgTag(cur.coverArt, 100, cur.serverId)}</span><span class="grow"><b>${esc(cur.title)}</b><small>${esc(cur.artist)}${cur.jamBy ? `, proposto da ${esc(cur.jamBy)}` : ''}</small></span><span class="tag ${isPlaying() ? 'ok' : ''}">${isPlaying() ? 'in onda' : 'in pausa'}</span></div>`
      : `<div class="empty">${host ? 'Avvia un brano: tutti lo sentiranno.' : 'In attesa che l\'host faccia partire la musica.'}</div>`}
    ${host ? '' : Jam.via === 'server' ? `<div class="panel" style="margin-top:14px"><h3>Come ascolti</h3><p class="small" style="color:var(--muted);margin:0">Tramite il server: scarichi la musica dal server alla tua qualità e resti allineato all'host con l'orologio del server.</p></div>`
      : `<div class="panel" style="margin-top:14px"><h3>Come ascolti</h3>${joinModeSeg(Jam.mode, true)}
      <p class="small" style="color:var(--muted);margin:8px 0 0">${Jam.mode === 'sync' ? 'Ogni telefono scarica la musica dal server alla qualità scelta e resta allineato all\'host.' : 'Ascolti l\'audio trasmesso dall\'host. Non serve un account sul suo server.'}</p></div>`}
    ${host ? `<div class="panel" style="margin-top:14px"><h3>Invita</h3><div class="row">
        <button class="btn primary" data-act="jamcopy">${ic('share')} Link d'invito</button><button class="btn" data-act="jamqr">QR code</button>
        <button class="btn" data-act="jammanual">Invito senza server</button></div>
        <p class="small" style="color:var(--muted);margin:8px 0 0">L'invito senza server funziona anche se il server Armony non è raggiungibile: vi scambiate due codici e il collegamento è diretto.</p></div>` : ''}
    ${props.length ? `<h2>Proposte</h2>${props.map(x => `<div class="list-item" style="cursor:default"><span class="grow"><b>${esc(x.title)}</b><small>${esc(x.artist)}, da ${esc(x.by)}</small></span>${host ? `<button class="btn sm primary" data-act="jamprop" data-k="${esc(x.k)}" data-ok="1">Accetta</button><button class="btn sm" data-act="jamprop" data-k="${esc(x.k)}" data-ok="0">No</button>` : '<span class="tag">in attesa</span>'}</div>`).join('')}` : ''}
    <div class="row between"><h2>Prossimi</h2>${host && upcoming.some(x => x.votes) ? '<button class="btn sm" data-act="jamsort">Ordina per voti</button>' : ''}</div>
    ${upcoming.length ? upcoming.map((t, i) => `<div class="list-item" style="cursor:default"><span class="n" style="width:22px;color:var(--muted);text-align:right">${i + 1}</span>
      <span class="grow"><b>${esc(t.title)}</b><small>${esc(t.artist)}${t.jamBy ? `, proposto da ${esc(t.jamBy)}` : ''}</small></span>
      <button class="btn sm vote" data-act="jamvote" data-k="${esc(t.k)}" aria-label="Vota">${ic('thumb')} ${t.votes || ''}</button></div>`).join('') : '<p class="sub">La coda è vuota.</p>'}
    <h2>Aggiungi brani</h2>
    <div class="row" style="flex-wrap:nowrap"><input type="search" id="jSearch" placeholder="${host || (Jam.track && Jam.track.serverId !== 'nessuno') ? 'Cerca nella libreria' : 'Cerca nella libreria dell\'host'}"><button class="btn" id="jSearchGo">${ic('search')}</button></div>
    <div id="jSearchRes"></div>
  </div>
  <div>
    <div class="panel"><h3>Persone (${roster.length})</h3>
      ${roster.map(r => `<div class="peer"><span class="av" style="background:${colorOf(r.id)}">${esc((r.name || '?')[0].toUpperCase())}</span>
        <span class="grow"><b>${esc(r.name)}${r.id === Jam.me ? ' (tu)' : ''}${r.host ? ' · host' : ''}</b>
        <small>${r.conn ? esc(r.conn) : ''}${r.rtt ? `, ${r.rtt} ms` : ''}${r.state && r.state !== 'connected' ? ', ' + esc(r.state) : ''}</small>
        ${r.safety ? `<small>Codice di sicurezza: <span class="safety">${r.safety}</span></small>` : ''}</span>
        ${host && !r.host ? `<button class="icon-btn" data-act="jamkick" data-id="${esc(r.id)}" aria-label="Fai uscire ${esc(r.name)}">${ic('close')}</button>` : ''}</div>`).join('')}
      <p class="small" style="color:var(--muted);margin:10px 0 0">Il codice di sicurezza deve essere uguale sui due telefoni. Se è diverso, qualcuno sta intercettando: uscite dalla Jam.</p>
    </div>
    <div class="panel"><div class="reacts" style="margin-bottom:12px">${REACTIONS.map(e => `<button data-act="jamreact" data-e="${e}" aria-label="Reazione ${e}">${e}</button>`).join('')}</div>
      <div class="chat" id="jChat">${Jam.chat.map(c => c.sys ? `<p class="sys">${esc(c.text)}</p>` : `<p class="${c.from === Jam.me ? 'me' : ''}"><b style="color:${colorOf(c.from || 'x')}">${esc(c.name)}</b>${esc(c.text)}</p>`).join('')}</div>
      <div class="row" style="flex-wrap:nowrap"><input type="text" id="jMsg" placeholder="Scrivi un messaggio" maxlength="500"><button class="btn primary" id="jSend" aria-label="Invia">${ic('send')}</button></div></div>
    ${host ? `<div class="panel stack"><h3>Regole</h3>
      <label class="check"><input type="checkbox" data-act="jamset" data-k="openQueue" ${Jam.set.openQueue ? 'checked' : ''}><span>Coda aperta<small>I brani proposti entrano subito in coda. Se spento, li approvi tu.</small></span></label>
      <label class="check"><input type="checkbox" data-act="jamset" data-k="control" ${Jam.set.control ? 'checked' : ''}><span>Gli ospiti possono controllare la musica<small>Play, pausa, salto e spostamento.</small></span></label>
      <label class="check"><input type="checkbox" data-act="jamset" data-k="approve" ${Jam.set.approve ? 'checked' : ''}><span>Chiedimi conferma anche per chi ha il link</span></label>
      <label class="check"><input type="checkbox" data-act="jamset" data-k="visible" ${Jam.set.visible ? 'checked' : ''}><span>Visibile sulla mia rete</span></label></div>` : ''}
    <p class="small" style="color:var(--muted)">${secureNote}</p>
  </div></div>`;
  const chat = $('#jChat'); chat.scrollTop = chat.scrollHeight;
  const send = () => { Jam.say($('#jMsg').value); $('#jMsg').value = ''; };
  $('#jSend').onclick = send; $('#jMsg').onkeydown = e => { if (e.key === 'Enter') send(); };
  const doSearch = async () => {
    const q = $('#jSearch').value.trim(); if (q.length < 2) return;
    const box = $('#jSearchRes'); box.innerHTML = '<p class="sub">Cerco…</p>';
    const own = host || S.servers.some(s => Jam.track && absUrl(s.url) === Jam.track.serverUrl) || (!Jam.track && srv());
    let items = [];
    if (own) { try { items = arr((await api('search3', { query: q, songCount: 30, albumCount: 0, artistCount: 0 })).searchResult3.song).map(x => norm(x)); } catch (e) { box.innerHTML = `<p class="sub">${esc(e.message)}</p>`; return; } }
    else items = await new Promise(res => { const req = uid(6); Jam.searchCb = m => { if (m.req === req) res(m.items.map(localize)); }; Jam.host?.send({ t: 'search', q, req }); setTimeout(() => res([]), 8000); });
    Jam.searchRes = items;
    box.innerHTML = items.length ? items.map((t, i) => `<div class="list-item" style="cursor:default"><span class="grow"><b>${esc(t.title)}</b><small>${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</small></span><button class="btn sm" data-act="jamplay" data-i="${i}">${ic('plus')} ${host || Jam.set.openQueue ? 'In coda' : 'Proponi'}</button></div>`).join('') : '<p class="sub">Nessun risultato.</p>';
  };
  $('#jSearchGo').onclick = doSearch; $('#jSearch').onkeydown = e => { if (e.key === 'Enter') doSearch(); };
  view.querySelectorAll('input[data-act="jamset"]').forEach(c => c.onclick = e => e.stopPropagation());
  view.querySelectorAll('input[data-act="jamset"]').forEach(c => c.onchange = () => Jam.action('jamset', c));
}
function joinModeSeg(cur = 'sync', live) {
  return `<div class="seg" role="radiogroup" aria-label="Modalità di ascolto">
    <label><input type="radio" name="jwant" value="sync" ${cur === 'sync' ? 'checked' : ''} ${live ? 'data-act="jammode" data-m="sync"' : ''}><span>Sincronizzato</span></label>
    <label><input type="radio" name="jwant" value="broadcast" ${cur === 'broadcast' ? 'checked' : ''} ${live ? 'data-act="jammode" data-m="broadcast"' : ''}><span>Trasmissione dall'host</span></label></div>`;
}
