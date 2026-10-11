/* Armony - client web. Parte 1: fondamenta, API, viste della libreria */
'use strict';

/* ================= utilità ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const fmtLong = s => { const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return h ? `${h} h ${m} min` : `${m} min`; };
const bytes = n => n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : (n / 1e6).toFixed(1) + ' MB';
const uid = (n = 10) => { const a = crypto.getRandomValues(new Uint8Array(n)); return [...a].map(b => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join(''); };
const arr = x => !x ? [] : Array.isArray(x) ? x : [x];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shuffleArr = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const store = {
  get(k, d) { try { const v = localStorage.getItem('armony:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('armony:' + k, JSON.stringify(v)); } catch {} }
};
// nell'app Android/PC il client è servito da sé stesso: mai usare location.origin come indirizzo del server
const NATIVE = !!window.Capacitor?.isNativePlatform?.();
// MD5 per l'autenticazione Subsonic token + sale: crypto.subtle non lo offre
function md5(str) {
  const R = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21], K = [];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;
  const b = new TextEncoder().encode(str), n = ((b.length + 8) >> 6) + 1, w = new Int32Array(n * 16);
  for (let i = 0; i < b.length; i++) w[i >> 2] |= b[i] << (i % 4 * 8);
  w[b.length >> 2] |= 0x80 << (b.length % 4 * 8); w[n * 16 - 2] = b.length * 8;
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  for (let o = 0; o < w.length; o += 16) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      const q = i >> 4, f = q === 0 ? (B & C) | (~B & D) : q === 1 ? (D & B) | (~D & C) : q === 2 ? B ^ C ^ D : C ^ (B | ~D);
      const g = q === 0 ? i : q === 1 ? (5 * i + 1) % 16 : q === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
      const x = (A + f + K[i] + w[o + g]) | 0, r = R[q * 4 + i % 4];
      A = D; D = C; C = B; B = (B + ((x << r) | (x >>> (32 - r)))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  return [a0, b0, c0, d0].map(v => [0, 8, 16, 24].map(s => ((v >>> s) & 255).toString(16).padStart(2, '0')).join('')).join('');
}
const Bus = new EventTarget();
const emit = (type, detail) => Bus.dispatchEvent(new CustomEvent(type, { detail }));
// 'libreria' e 'playlists': le viste aperte e la barra laterale si ridisegnano da sole. Più modifiche
// di fila (es. 200 brani alla volta in una playlist) diventano un solo avviso
const soonT = {};
const emitSoon = type => { clearTimeout(soonT[type]); soonT[type] = setTimeout(() => emit(type), 300); };
let toastTimer;
function toast(msg, ms = 3200) {
  $$('.toast').forEach(t => t.remove());
  const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg; document.body.append(t);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), ms);
}
// nell'app Android un link "download" non fa niente: i file vanno in Download/Armony, le immagini nel foglio Condividi
const blobB64 = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
async function saveFile(name, data, type = 'text/plain') {
  const F = NATIVE && window.Capacitor?.Plugins?.ArmonyFiles;
  if (F) {
    const b = data instanceof Blob ? data : new Blob([data], { type });
    try {
      const args = { name, mime: b.type || type, data: await blobB64(b) };
      if ((b.type || type).startsWith('image/')) await F.share({ ...args, title: name });
      else { const r = await F.save(args); toast(r.where === 'shared' ? 'Scegli dove salvarlo.' : `Salvato in ${r.where}.`, 5000); }
    } catch (e) { toast(e.message || 'Salvataggio non riuscito.'); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
function pickFile(accept, multiple = false) {
  // nell'app nessun filtro: Android dà ai CSV scaricati tipi diversi (text/comma-separated-values…) e li mostrava in grigio
  return new Promise(res => { const f = $('#filePick'); f.accept = NATIVE ? '' : accept; f.multiple = multiple; f.value = ''; f.onchange = () => res(multiple ? [...f.files] : f.files[0] || null); f.click(); });
}
// il file originale di un brano: nel browser un link, nell'app scaricato dall'app (passa dal suo DNS di riserva) e salvato
async function downloadOriginal(t) {
  const u = apiUrl(srv(t.serverId), 'download', { id: t.id });
  if (!NATIVE) { const a = document.createElement('a'); a.href = u; a.download = ''; a.click(); return; }
  toast('Scarico il file originale…', 30000);
  try {
    const r = await fetch(u); if (!r.ok || /json|xml/.test(r.headers.get('content-type') || '')) throw new Error('Il server non ha dato il file.');
    const b = await r.blob(), ext = ({ 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/opus': 'opus' })[b.type] || (t.suffix || 'audio');
    await saveFile(safeName(`${t.artist} - ${t.title}.${ext}`), b, b.type);
  } catch (e) { toast(e.message); }
}
async function copyText(t) { try { await navigator.clipboard.writeText(t); return true; } catch { prompt('Copia questo testo:', t); return false; } }
const safeName = n => String(n).replace(/[\\/:*?"<>|]/g, '_');
function ask(title, value = '', label = '') {
  return new Promise(res => {
    const d = $('#dlg2');
    d.innerHTML = `<h3>${esc(title)}</h3><label class="f">${esc(label)}<input type="text" id="askIn" value="${esc(value)}"></label>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="askOk">Conferma</button><button class="btn" id="askNo">Annulla</button></div>`;
    const done = v => { d.close(); res(v); };
    $('#askOk').onclick = () => done($('#askIn').value.trim());
    $('#askNo').onclick = () => done(null);
    $('#askIn').onkeydown = e => { if (e.key === 'Enter') done($('#askIn').value.trim()); };
    d.onclose = () => res(null);
    d.showModal(); $('#askIn').select();
  });
}

/* ================= icone ================= */
const I = {
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  grip: '<circle cx="9" cy="6" r="1.2" fill="currentColor"/><circle cx="15" cy="6" r="1.2" fill="currentColor"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><circle cx="9" cy="18" r="1.2" fill="currentColor"/><circle cx="15" cy="18" r="1.2" fill="currentColor"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  speaker: '<rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="14" r="4"/><path d="M12 6h.01"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  laptop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/>',
  headphones: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/>',
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  lib: '<path d="M4 4v16M9 4v16M14 5l5 15"/>',
  artist: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  list: '<path d="M4 6h12M4 12h12M4 18h8"/><circle cx="19" cy="17" r="2"/><path d="M21 17V8"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  queue: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  down: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
  pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z" fill="currentColor"/>',
  prev: '<path d="M19 6.5 10 12l9 5.5z" fill="currentColor"/><path d="M5.5 6v12" stroke-width="2.6"/>',
  next: '<path d="M5 6.5 14 12l-9 5.5z" fill="currentColor"/><path d="M18.5 6v12" stroke-width="2.6"/>',
  shuffle: '<path d="M3 7h3c6 0 6 10 12 10h3M3 17h3c2 0 3-1.2 4-3M14 10c1-1.8 2-3 4-3h3M18 4l3 3-3 3M18 14l3 3-3 3"/>',
  repeat: '<path d="M4 11V9a3 3 0 0 1 3-3h13M17 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H4M7 21l-3-3 3-3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  addlist: '<path d="M4 6h11M4 12h11M4 18h7M18 14v6M15 17h6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>', dn: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  nextup: '<path d="M5 6h10M5 12h10M5 18h6M16 15l4 3-4 3z"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  lyrics: '<path d="M4 5h16M4 10h10M4 15h12M4 20h7"/>',
  radio: '<circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
  offline: '<path d="M12 3v12M7 10l5 5 5-5"/><circle cx="12" cy="12" r="10"/>',
  stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  friends: '<circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.5"/><path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5M16 14.5c3 0 6 1.5 6 4.5"/>',
  jam: '<circle cx="8" cy="15" r="5"/><circle cx="16" cy="9" r="5"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3M21 14v.01M14 21h.01M18 18h3v3h-3z"/>',
  moon: '<path d="M20 14A8 8 0 1 1 10 4a6.5 6.5 0 0 0 10 10z"/>',
  speed: '<path d="M12 13l4-4M4 18a9 9 0 1 1 16 0"/>',
  album: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevl: '<path d="M15 5l-7 7 7 7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chevr: '<path d="M9 5l7 7-7 7"/>',
  send: '<path d="M4 12l16-8-6 16-2-7z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  wifi: '<path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  thumb: '<path d="M7 11v9H4v-9zM7 11l4-7a2 2 0 0 1 3 2l-1 5h6a2 2 0 0 1 2 2.3l-1.3 6A2 2 0 0 1 17.7 21H7"/>'
};
const ic = (n, fill) => `<svg viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n] || ''}</svg>`;

/* ================= stato e preferenze ================= */
const QUALITIES = {
  orig: { label: 'Originale (nessuna conversione)', short: 'Originale', params: { format: 'raw' } },
  '320': { label: 'Altissima, MP3 320 kbps', short: '320k', params: { format: 'mp3', maxBitRate: 320 } },
  '192': { label: 'Alta, MP3 192 kbps', short: '192k', params: { format: 'mp3', maxBitRate: 192 } },
  '128': { label: 'Normale, MP3 128 kbps', short: '128k', params: { format: 'mp3', maxBitRate: 128 } },
  '64': { label: 'Risparmio dati, Opus 64 kbps', short: 'Opus 64k', params: { format: 'opus', maxBitRate: 64 } },
  '32': { label: 'Minimo, Opus 32 kbps (parlato, rete scarsa)', short: 'Opus 32k', params: { format: 'opus', maxBitRate: 32 } }
};
const DEFAULT_PREFS = {
  quality: '192', qualityMobile: 'same', offlineQ: '192', crossfade: 0, rg: 'track', rgPre: 0, night: false, speed: 1,
  eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], eqOn: true, eqAuto: false, compat: false, lyricsOnline: true, syncQueue: true,
  nick: '', stun: true, turn: { url: '', user: '', pass: '' }, theme: 'auto', volume: 1, visualizer: true, sync: true, live: true, deviceName: '', solo: false, cacheMB: 1024, autoplay: true,
  notifOn: false, nImport: true, nDownload: true, nJam: true, nDev: true, nAmici: true
};
const P = Object.assign({}, DEFAULT_PREFS, store.get('prefs', {}));
// restano su questo dispositivo anche con la sincronizzazione attiva
const DEVICE_PREFS = ['compat', 'volume', 'sync', 'live', 'deviceName', 'solo', 'cacheMB', 'notifOn', 'nImport', 'nDownload', 'nJam', 'nDev', 'nAmici'];
const savePrefs = () => { store.set('prefs', P); store.set('prefsAt', Date.now()); PrefSync.schedule(); };
const S = {
  servers: store.get('servers', []),
  active: store.get('active', null),
  queue: store.get('queue', []), ctx: store.get('qctx', null),
  index: store.get('index', -1),
  shuffle: store.get('shuffle', false),
  repeat: store.get('repeat', 'off'),
  device: store.get('device', null) || (() => { const d = 'armony-' + uid(5).toLowerCase(); store.set('device', d); return d; })(),
  lastList: [], me: {}
};
if (S.active !== 'telefono' && !S.servers.find(s => s.id === S.active)) S.active = S.servers[0]?.id || null;
// una coda salvata quando il dispositivo era stato revocato e poi riabbinato punta ancora alla voce morta: ogni brano
// verrebbe rifiutato (ed è così che un telefono ha fatto bloccare l'utente da Navidrome). Passa alla voce viva
// dello stesso server e utente
{
  const dead = x => !x || x.revoked || x.pending;
  const alive = x => S.servers.find(y => !dead(y) && y.url && x && y.url.replace(/\/+$/, '') === String(x.url || '').replace(/\/+$/, '') && y.user === x.user);
  let moved = 0;
  S.queue.forEach(t => { const x = S.servers.find(y => y.id === t.serverId); if (dead(x) && x) { const y = alive(x); if (y) { t.serverId = y.id; moved++; } } });
  if (moved) store.set('queue', S.queue);
  const act = S.servers.find(y => y.id === S.active); if (dead(act) && act && alive(act)) { S.active = alive(act).id; store.set('active', S.active); }
}
// credenziali Subsonic: si conserva token + sale, mai la password (che negli URL sarebbe leggibile)
const subsonicCreds = pass => { const salt = uid(12); return { tok: md5(pass + salt), salt }; };
function migrateCreds(list) {
  for (const s of list) if (s.pass) { Object.assign(s, subsonicCreds(s.pass)); delete s.pass; delete s.session; }
  return list;
}
migrateCreds(S.servers); store.set('servers', S.servers);
// Armony è il server in uso: la sessione arriva dall'accesso (armonyLogin). 'downloader' è il vecchio
// codice di accesso separato, usato solo finché il server non ha una sessione (server Armony 0.2 o precedenti)
Object.defineProperty(S, 'dl', {
  get() {
    const s = dlSrv(); if (s?.session) return { url: absUrl(s.url), token: s.session };
    const l = store.get('downloader', null); return l?.url && l?.token ? l : { url: '', token: '' };
  }
});
const access = () => dlSrv()?.session ? dlSrv().me || {} : S.dl.token ? { admin: true, upload: true, download: true } : {};
// con "Questo telefono" in uso download e caricamenti vanno al server del backup (telefono.js)
const dlSrv = () => srv()?.local ? Local.target() : srv();
// chi sono negli indirizzi che non possono avere intestazioni (EventSource, <video>, link da scaricare): il gettone del
// dispositivo (12-24 ore, spento con la sessione) e non la sessione, che vale giorni e resterebbe in cronologia e nei log
const authQ = (s, tok = s?.session) => s?.tk ? 'k=' + encodeURIComponent(s.tk) : 'token=' + encodeURIComponent(tok || '');
if (P.theme !== 'auto') document.documentElement.dataset.theme = P.theme;
const srv = id => (id || S.active) === 'telefono' ? (Local.on() ? Local.srv : undefined) : S.servers.find(s => s.id === (id || S.active));
const key = t => t.serverId + ':' + t.id;
const hex = s => [...new TextEncoder().encode(s)].map(b => b.toString(16).padStart(2, '0')).join('');
const onMobileData = () => { const c = navigator.connection; return !!c && (c.type === 'cellular' || c.saveData); };
const activeQuality = () => (onMobileData() && P.qualityMobile !== 'same') ? P.qualityMobile : P.quality;

/* ================= API Subsonic / OpenSubsonic ================= */
function absUrl(u) { try { return new URL(u, location.href).toString().replace(/\/+$/, ''); } catch { return u; } }
function apiParams(s, params = {}) {
  const p = new URLSearchParams();
  const auth = s.tok ? { t: s.tok, s: s.salt } : { p: 'enc:' + hex(s.pass || '') };
  // k: gettone del dispositivo (dispositivi.js), l'unico modo per audio e copertine di dire chi sono
  const all = { u: s.user, ...auth, v: '1.16.1', c: S.device, f: 'json', ...(s.tk ? { k: s.tk } : {}), ...params };
  for (const [k, v] of Object.entries(all)) {
    if (Array.isArray(v)) v.forEach(x => p.append(k, x)); else if (v !== undefined && v !== null && v !== '') p.set(k, v);
  }
  return p;
}
// una richiesta appesa (il tunnel che cade, il server che riparte) non deve lasciare la pagina in caricamento per sempre:
// tempo massimo, e le letture si riprovano una volta dopo un secondo
/* registro della sessione: le ultime richieste di questo dispositivo (numero, percorso, durata, esito) e cosa è
   successo intorno (rete, pagina in primo piano, canale dal vivo, audio). Una richiesta ferma oltre 8 s o fallita
   manda al registro eventi del server il pezzo di registro di quel minuto; il server ci allega le richieste che ha
   ricevuto davvero da questo dispositivo (diagnosi.py). Così si vede se un blocco nasce prima del server o dentro */
const Trace = {
  seq: 0, ev: [], t: null, sent: 0, from: 0,
  add(txt) { this.ev.push([Date.now(), txt]); if (this.ev.length > 400) this.ev.splice(0, 100); },
  // solo percorso e metodo Subsonic, mai credenziali né gettoni
  path(url) { try { const u = new URL(url, location.href); return u.pathname.replace(/\/api\/(avatar|videos)\/.*/, '/api/$1/…') + (u.searchParams.get('id') ? '?id=' + u.searchParams.get('id').slice(0, 24) : ''); } catch { return '?'; } },
  stall(rid, path, t0) {
    this.add(`#${rid} ferma da 8 s: ${path}`);
    // esperimento (0.35.1): nei blocchi registrati le risposte ferme arrivavano tutte appena il canale dal vivo si
    // riapriva. Riaprirlo subito dovrebbe accorciare il blocco: il registro dirà se è vero
    if (Live.es && Date.now() - (this.kick || 0) > 15000) { this.kick = Date.now(); this.add('canale dal vivo: riaperto per sbloccare'); Live.connect(); }
    this.from = this.from || t0 - 60000;
    clearTimeout(this.t); this.t = setTimeout(() => this.send(), 25000);  // si aspetta come va a finire
  },
  send() {
    if (!this.from || Date.now() - this.sent < 60000) return;
    const from = this.from; this.from = 0; this.sent = Date.now();
    const f = ms => new Date(ms).toLocaleTimeString('it-IT', { hour12: false }) + '.' + String(ms % 1000).padStart(3, '0').slice(0, 1);
    const lines = this.ev.filter(([t]) => t >= from).map(([t, x]) => `${f(t)} ${x}`).join('\n');
    const c = navigator.connection;
    window.Diag?.report('avviso', 'sessione', `richieste bloccate (${this.ev.filter(([t, x]) => t >= from && / ferma da /.test(x)).length})`,
      `rete: ${navigator.onLine ? 'sì' : 'no'}${c ? `, ${c.effectiveType || ''} ${c.type || ''} ${c.rtt != null ? c.rtt + ' ms' : ''}` : ''} · pagina ${document.hidden ? 'nascosta' : 'visibile'}\n${lines}`, { since: from / 1000 });
  }
};
addEventListener('online', () => Trace.add('rete: tornata')); addEventListener('offline', () => Trace.add('rete: assente'));
document.addEventListener('visibilitychange', () => Trace.add(document.hidden ? 'pagina nascosta' : 'pagina visibile'));
async function netFetch(url, opts = {}, ms = 20000) {
  const get = !opts.method || opts.method === 'GET';
  for (let i = 0; ; i++) {
    // _r: il numero della richiesta, che il server registra (diagnosi.py) e Navidrome ignora
    const rid = (++Trace.seq).toString(36), path = Trace.path(url), t0 = Date.now();
    const u = /\/(rest|api)\//.test(url) ? url + (url.includes('?') ? '&' : '?') + '_r=' + rid : url;
    Trace.add(`#${rid} → ${opts.method || 'GET'} ${path}`);
    const dog = setTimeout(() => Trace.stall(rid, path, t0), 8000);
    try { const r = await fetch(u, { ...opts, signal: opts.signal || AbortSignal.timeout?.(get ? ms : ms * 3) }); Trace.add(`#${rid} ← ${r.status} in ${Date.now() - t0} ms`); return r; }
    catch (e) { Trace.add(`#${rid} ✕ ${e?.name === 'TimeoutError' ? 'scaduta' : e?.name || 'errore'} dopo ${Date.now() - t0} ms`); if (Date.now() - t0 < 8000 && e?.name !== 'AbortError') Trace.stall(rid, path, t0); if (!get || i || opts.signal) throw e; await new Promise(r => setTimeout(r, 1000)); }
    finally { clearTimeout(dog); }
  }
}
const apiBase = (s, method) => absUrl(s.url) + '/rest/' + method;
const apiUrl = (s, method, params) => apiBase(s, method) + '?' + apiParams(s, params);
async function api(method, params, s = srv(), post = false, again = false) {
  if (!s) throw new Error('Nessun server configurato. Aggiungine uno in Impostazioni.');
  if (s.local) return Local.api(method, params);
  if (s.pending || s.revoked) throw new Error(s.revoked ? 'Questo dispositivo è stato revocato.' : 'Questo dispositivo aspetta l\'approvazione.');
  await NetDns.need(s.url);
  let r;
  try {
    r = post ? await netFetch(apiBase(s, method), { method: 'POST', body: apiParams(s, params) })
      : await netFetch(apiUrl(s, method, params));
  } catch (e) {
    const slow = e?.name === 'TimeoutError';
    if (navigator.onLine) window.Diag?.report('avviso', 'rete', `${s.name} ${slow ? 'non risponde' : 'non raggiungibile'} (${method})`);
    throw new Error(slow ? `${s.name} non risponde. Riprova fra poco.` : `Non riesco a raggiungere ${s.name}. Controlla indirizzo e connessione.`);
  }
  if (r.status === 401 && s.armony && !again) {
    const j = await r.clone().json().catch(() => ({}));
    if (j.code === 'revocato') { Disp.revoke(s, true); throw new Error(j.error); }
    await Disp.fresh(s, true);
    if (s.session) return api(method, params, s, post, true);
    throw new Error(s.pending ? 'Questo dispositivo aspetta l\'approvazione.' : j.error || 'Accesso scaduto: in Impostazioni modifica il server e reinserisci la password.');
  }
  if (!r.ok) { if (r.status >= 500) window.Diag?.report('errore', 'rete', `${s.name}: errore ${r.status} su ${method}`); throw new Error(`${s.name} ha risposto con errore ${r.status}.`); }
  const sr = (await r.json())['subsonic-response'];
  if (sr.status !== 'ok') throw new Error(sr.error?.code === 40 ? 'Utente o password errati.' : sr.error?.message || 'Il server ha rifiutato la richiesta.');
  if (/^(create|update|delete)Playlist$/.test(method)) { emitSoon('playlists'); emitSoon('libreria'); }
  // Navidrome scansiona in differita: un avviso dopo pochi secondi e uno di sicurezza dopo 15
  if (method === 'startScan') { setTimeout(() => emit('libreria'), 4000); setTimeout(() => emit('libreria'), 15000); }
  return sr;
}
const norm = (x, sid = S.active) => ({
  id: x.id, title: x.title || 'Senza titolo', artist: x.displayArtist || x.artist || 'Artista sconosciuto',
  // "[Unknown Album]" è il segnaposto di Navidrome per i file senza album: non si mostra
  artistId: x.artistId, album: x.album === '[Unknown Album]' ? '' : x.album || '', albumId: x.albumId, duration: x.duration || 0, track: x.track,
  // gli ospiti (feat.): Navidrome li elenca in artists, ognuno con la sua pagina
  artists: x.artists?.length > 1 ? x.artists.filter(a => a.id).map(a => ({ id: a.id, name: a.name })) : undefined,
  coverArt: x.coverArt, starred: !!x.starred, starredAt: x.starred || undefined, suffix: x.suffix, bitRate: x.bitRate, genre: x.genre, year: x.year, created: x.created,
  rg: x.replayGain ? { trackGain: x.replayGain.trackGain, albumGain: x.replayGain.albumGain, trackPeak: x.replayGain.trackPeak, albumPeak: x.replayGain.albumPeak } : null,
  serverId: sid
});
// coverBust: dopo aver cambiato una copertina, l'indirizzo cambia e il browser non mostra quella vecchia dalla cache
let coverBust = 0;
// brani della rete (server collegati, /api/rete): copertina e audio passano dal mio server Armony, che fa da proxy firmato
// per il registro eventi: un indirizzo senza credenziali (token, sale, gettone, password)
const safeUrl = u => String(u || '').replace(/([?&](t|s|k|p|token)=)[^&]*/g, '$1…');
const reteUrl = (s, path, p) => absUrl(s.url) + '/api/rete/' + path + '?' + new URLSearchParams({ ...p, ...(s.tk ? { k: s.tk } : { token: s.session || '' }) });
const coverUrl = (coverArt, size = 300, sid) => {
  const s = srv(sid); if (!coverArt || !s) return '';
  if (s.local) return Local.cover(coverArt, size);
  if (String(coverArt).startsWith('rete|')) { const [, r, id] = coverArt.split('|'); return reteUrl(s, 'cover', { r, id, size }); }
  return apiUrl(s, 'getCoverArt', { id: coverArt, size, ...(coverBust ? { v: coverBust } : {}) });
};
// lo stesso brano anche se l'oggetto è un altro: da telecomando currentTrack() ne crea uno nuovo a ogni stato ricevuto,
// e il confronto per identità faceva credere che il brano fosse cambiato (testi e dettagli non arrivavano mai)
const sameTrack = (a, b) => !!a && !!b && key(a) === key(b);
const streamUrl = (t, q = activeQuality()) => srv(t.serverId)?.local ? Local.stream(t.id)
  : t.fed ? reteUrl(srv(t.serverId), 'stream', { r: t.fed.r, id: t.fed.id, ...QUALITIES[q].params })
  : apiUrl(srv(t.serverId), 'stream', { id: t.id, ...QUALITIES[q].params, ...(Sost.bust[key(t)] ? { b: Sost.bust[key(t)] } : {}) });
const imgTag = (coverArt, size, sid) => { const u = coverUrl(coverArt, size, sid); return u ? `<img src="${esc(u)}" alt="" loading="lazy" onerror="this.remove()">` : ''; };

/* ================= accesso ad Armony (sessione per utente, permessi dal ruolo Navidrome) ================= */
async function armonyLogin(s) {
  const base = absUrl(s.url);
  const info = await fetch(base + '/api/info').then(r => r.ok ? r.json() : null).catch(() => undefined);
  if (info === undefined) return null;  // irraggiungibile: si riprova al prossimo avvio
  if (!info?.armony) { s.armony = false; delete s.session; delete s.me; return null; }  // Subsonic senza Armony, o Armony 0.2
  if (info.caps?.includes('dispositivi')) return Disp.login(s);  // chiave del dispositivo, attesa, revoca
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ u: s.user, t: s.tok, s: s.salt, device: S.device }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Errore ${r.status}`);
  s.armony = true; s.session = j.session; delete j.session; s.me = j;
  return j;
}
async function syncSessions() {
  for (const s of S.servers) {
    if (!s.tok || s.revoked) continue;  // anche i server "senza Armony": potrebbero averlo installato nel frattempo
    if (s.session) {
      const r = await fetch(absUrl(s.url) + '/api/me', { headers: { 'X-Token': s.session } }).catch(() => null);
      if (r?.ok) {
        s.me = await r.json(); s.tk = s.me.ticket; s.dev = s.me.dev || s.dev;
        if (s.me.user && s.me.user.toLowerCase() === String(s.user).toLowerCase()) s.user = s.me.user;  // il nome com'è sul server
        // client aggiornato che entrava senza chiave: se la crea adesso, senza chiedere niente
        if (Disp.ok(s) && !s.me.keyed && Disp.can()) await Disp.setKey(s).catch(() => {});
        continue;
      }
      if (r?.status !== 401) continue;
      delete s.session;
    }
    await armonyLogin(s).catch(() => {});
  }
  persistServers();
  if (srv()?.session) store.set('downloader', null);
}

/* ================= movimento: risponde a un gesto, non decora (docs/EVOLUZIONE.md §3b) ================= */
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// giradischi: al play il disco accelera fino a regime, alla pausa rallenta e si ferma
const Turntable = {
  set(el, on, now) {
    if (!el) return;
    if (calm()) { el._spin?.cancel(); el._spin = null; return; }
    let a = el._spin;
    if (!a) {
      if (!on) return;
      a = el._spin = el.animate([{ transform: 'rotate(0turn)' }, { transform: 'rotate(1turn)' }], { duration: el.classList.contains('rec') ? 4000 : 3200, iterations: Infinity });
      a.playbackRate = now ? 1 : 0;
    }
    const to = on ? 1 : 0;
    if (el._to === to) return;
    el._to = to; cancelAnimationFrame(el._raf); a.play();
    const from = a.playbackRate, dur = on ? 600 : 900, t0 = performance.now();
    const step = () => {
      const k = Math.max(0, Math.min(1, (performance.now() - t0) / dur)), e = on ? 1 - (1 - k) ** 3 : 1 - (1 - k) ** 2;
      a.playbackRate = from + (to - from) * e;
      if (k < 1) el._raf = requestAnimationFrame(step); else if (!on) a.pause();
    };
    el._raf = requestAnimationFrame(step);
  }
};
// cambio di pagina con le View Transitions dove esistono: il contenuto si dissolve, e andando a
// "In riproduzione" la copertina del lettore si espande nel disco grande (e torna indietro all'uscita)
const Scene = {
  hash: null, r: null, nav: 0,
  go(run, from, to) {
    if (!document.startViewTransition || from === null) return run();
    const morph = calm() || !currentTrack() ? null : to === 'ora' && from !== 'ora' ? 'in' : from === 'ora' && to !== 'ora' ? 'out' : null;
    const mini = $('#disc'), rec = () => $('#bigdisc .rec'), name = (el, n) => { if (el) el.style.viewTransitionName = n; };
    if (morph === 'in') name(mini, 'disc'); else if (morph === 'out') name(rec(), 'disc');
    return new Promise((res, rej) => {
      const vt = document.startViewTransition(() => {
        run().then(res, rej);
        if (morph === 'in') { name(mini, ''); name(rec(), 'disc'); } else if (morph === 'out') name(mini, 'disc');
      });
      // una navigazione che ne interrompe un'altra rifiuta ready/finished: è normale, non è un errore
      vt.ready.catch(() => {});
      vt.finished.catch(() => {}).finally(() => { name(mini, ''); name(rec(), ''); });
    });
  }
};
// una vista superata da una navigazione più recente non deve più scrivere in #view:
// ogni vista ricorda il proprio numero (const n = Scene.nav) e lo controlla dopo ogni attesa
const stale = n => n !== Scene.nav;
const SK = {
  card: '<div class="card"><div class="art sk"></div><i class="sk sk-line"></i><i class="sk sk-line short"></i></div>',
  row: '<div class="list-item"><span class="pic sk"></span><span class="grow"><i class="sk sk-line"></i><i class="sk sk-line short"></i></span></div>',
  pills: n => `<div class="sk-row">${'<i class="sk sk-pill"></i>'.repeat(n)}</div>`
};
// sagome della pagina che arriva, al posto della scritta "Caricamento…"
function skeleton(r, id) {
  const h = '<i class="sk sk-h1"></i><i class="sk sk-line short"></i>', rows = n => SK.row.repeat(n);
  const body = r === 'home' ? h + SK.pills(4) + '<i class="sk sk-h2"></i><div class="cards shelf">' + SK.card.repeat(8) + '</div><i class="sk sk-h2"></i>' + SK.pills(6)
    : /^(album|artista)(-dz)?$/.test(r) ? `<div class="phero"><div class="art sk"${r.startsWith('artista') ? ' style="border-radius:50%"' : ''}></div><div class="sk-wrap">${h}</div></div>` + rows(8)
    : r === 'genere' || r === 'decennio' || (r === 'libreria' && id === 'album') ? h + '<div class="cards" style="margin-top:18px">' + SK.card.repeat(12) + '</div>'
    : r === 'ora' || r === 'cerca' || r === 'impostazioni' || r === 'scarica' || r === 'jam' || r === 'tasti' ? ''
    : h + '<div style="margin-top:18px">' + rows(8) + '</div>';
  return `<div class="sk-page" aria-busy="true" aria-label="Caricamento">${body}</div>`;
}
const beat = el => { if (el && !calm()) el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(.92)' }, { transform: 'scale(1)' }], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' }); };
// "aggiunto alla coda": un punto ambra vola dal tasto premuto all'icona della coda nel lettore
function flyToQueue(from) {
  const q = $('#bQueue'); if (!from || !q || calm()) return;
  const a = from.getBoundingClientRect(), b = q.getBoundingClientRect(); if (!b.width || !a.width) return;
  const x0 = a.left + a.width / 2, y0 = a.top + a.height / 2;
  const f = document.createElement('div'); f.className = 'fly'; f.style.left = x0 - 6 + 'px'; f.style.top = y0 - 6 + 'px'; f.innerHTML = '<i></i>';
  document.body.append(f);
  // x e y su due elementi con curve diverse: la traiettoria è un arco, non una retta
  const o = { duration: 520, fill: 'forwards' };
  f.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${b.left + b.width / 2 - x0}px)` }], { ...o, easing: 'cubic-bezier(.3,.6,.4,1)' });
  f.firstChild.animate([{ transform: 'translateY(0) scale(1)', opacity: 1 }, { transform: `translateY(${b.top + b.height / 2 - y0}px) scale(.6)`, opacity: .9 }], { ...o, easing: 'cubic-bezier(.6,0,.9,.6)' })
    .finished.then(() => { f.remove(); q.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' }); });
}
// play/pausa: le due metà del triangolo diventano le due barre (stessa sequenza di punti, la forma si trasforma).
// Il contorno da 2 px arrotonda gli spigoli e allarga ogni forma di 1 px per lato: le barre della pausa sono larghe
// 4,5 px con 4,5 px di vuoto fra loro, il triangolo sta un poco a destra del centro perché all'occhio sembri centrato
const PP = { play: ['M8 5.5L13.25 8.75L13.25 15.25L8 18.5Z', 'M13.25 8.75L18.5 12L18.5 12L13.25 15.25Z'], pause: ['M6.25 6L8.75 6L8.75 18L6.25 18Z', 'M15.25 6L17.75 6L17.75 18L15.25 18Z'] };

/* ================= router ================= */
const NAV = [
  ['home', 'Home', 'home'], ['cerca', 'Cerca', 'search'], ['libreria', 'Libreria', 'lib'], ['playlist', 'Playlist', 'list'],
  ['preferiti', 'Preferiti', 'heart'], ['jam', 'Jam', 'jam'], ['radio', 'Radio', 'radio'], ['amici', 'Amici', 'friends'], ['rete', 'Rete', 'globe'], ['offline', 'Offline', 'offline'], ['video', 'Video', 'film'],
  ['statistiche', 'Statistiche', 'stats'], ['scarica', 'Scarica', 'down'], ['impostazioni', 'Impostazioni', 'gear']
];
const view = $('#view');
const ROUTE_PARENT = { mix: 'home', album: 'libreria', artista: 'libreria', 'album-dz': 'libreria', 'artista-dz': 'libreria', genere: 'libreria', decennio: 'libreria' };
// su telefono: fino a quattro sezioni nella barra in basso (scelte in Impostazioni → Aspetto, o tenendo premuta la barra),
// le altre nel foglio "Altro". Si salvano su questo dispositivo; una sezione che non esiste più riporta al predefinito
const TABS_DEF = ['home', 'cerca', 'libreria', 'jam'];
const tabsOf = () => { const t = store.get('tabs', null); return Array.isArray(t) && t.length && t.length <= 4 && new Set(t).size === t.length && t.every(h => NAV.some(n => n[0] === h)) ? t : TABS_DEF; };
const inMore = h => h === 'tasti' || (NAV.some(n => n[0] === h) && !tabsOf().includes(h));
let viewTimers = [];
const viewInterval = (fn, ms) => viewTimers.push(setInterval(fn, ms));
function markNav(r) {
  $$('#nav a, #tabs a').forEach(a => { const on = a.dataset.r === r || ROUTE_PARENT[r] === a.dataset.r; a.classList.toggle('on', on); on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
  $('#tabMore')?.classList.toggle('on', inMore(ROUTE_PARENT[r] || r));
}
async function route() {
  viewTimers.forEach(clearInterval); viewTimers = [];
  emit('route');
  const [r = 'home', ...rest] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const id = rest.join('/');
  markNav(r);
  // da una scheda all'altra delle impostazioni senza ridisegnare la pagina (route() con lo stesso indirizzo la ridisegna)
  if (r === 'impostazioni' && Scene.r === 'impostazioni' && location.hash !== Scene.hash && $('#view .setp')) { Scene.hash = location.hash; return setTab(id); }
  $$('#sidePl a').forEach(a => a.classList.toggle('on', r === 'playlist' && a.dataset.pl === id));
  const fn = Disp.gate(r) || {
    home: vHome, cerca: vSearch, libreria: vLibrary, artista: vArtist, album: vAlbum, 'artista-dz': vArtistDz, 'album-dz': vAlbumDz, genere: vGenre, decennio: vDecade,
    playlist: id ? vPlaylist : vPlaylists, preferiti: vStarred, coda: vQueue, ora: vNow, amici: vFriends, offline: vOffline,
    statistiche: vStats, scarica: vDownload, notifiche: vNotifiche, mix: vMix, testo: vLyrics, video: vVideo, impostazioni: vSettings, jam: vJam, tasti: vKeys, invito: vInvite, rete: vRete, radio: vRadio, abbina: vAbbina, benvenuto: vBenvenuto
  }[r] || vHome;
  const changed = location.hash !== Scene.hash, from = Scene.r, n = ++Scene.nav;
  if (changed && Scene.hash) Scene.back = Scene.r === 'ora' || Scene.r === 'testo' ? Scene.back : Scene.hash;  // dove torna la freccia del lettore
  Scene.hash = location.hash; Scene.r = r;
  document.documentElement.dataset.r = r;  // il telefono cambia il lettore in basso su "In riproduzione" (index.html)
  const run = async () => {
    if (stale(n)) return;
    if (typeof VPlayer !== 'undefined') VPlayer.dock();  // il video in corso esce dalla pagina vecchia e continua in piccolo (video.js; const di un altro script: non sta in window)
    delete view.dataset.pl; delete document.documentElement.dataset.login;  // la pagina d'accesso lo rimette (utenti.js)
    view.innerHTML = skeleton(r, id);
    if (changed && r !== 'ora') window.scrollTo(0, 0);
    return fn(id);
  };
  try { await (changed ? Scene.go(run, from, r) : run()); }
  catch (e) {
    console.error(e);
    if (stale(n)) return;
    view.innerHTML = `<div class="empty"><h3>Qualcosa non ha funzionato</h3><p>${esc(e.message)}</p>
      <div class="row" style="justify-content:center"><button class="btn" onclick="route()">Riprova</button><a class="btn" href="#/impostazioni">Impostazioni</a>${Local.on() && !srv()?.local ? '<button class="btn" data-act="phone" data-do="use">Musica del telefono</button>' : Offline.keys.size ? '<a class="btn" href="#/offline">Ascolta offline</a>' : ''}</div></div>`;
  }
  if (!changed && r !== 'ora' && !stale(n)) window.scrollTo(0, 0);
}

/* ================= componenti ================= */
// griglia di copertine. opts.strip: una sola riga (su telefono scorre col dito); opts.title: titolo della
// sezione, con accanto "Mostra tutto" se c'è opts.more (un indirizzo #/…); opts.sid: server delle copertine
function albumGrid(albums, opts = {}) {
  const head = opts.title ? `<div class="shelf-head"><h2>${esc(opts.title)}</h2>${opts.more ? `<a href="${esc(opts.more)}">Mostra tutto</a>` : ''}</div>` : '';
  if (!albums.length) return head + `<div class="empty">${opts.empty || 'Nessun album.'}</div>`;
  return head + `<div class="cards${opts.strip ? ' shelf' : ''}">${albums.map(a => `
    <div class="card">
      <div class="art">${imgTag(a.coverArt, 300, opts.sid)}<button class="card-play" data-act="playalbum" data-id="${esc(a.id)}"${opts.sid ? ` data-sid="${esc(opts.sid)}"` : ''} aria-label="Riproduci ${esc(a.name || a.title)}">${ic('play')}</button></div>
      <button class="card-go" data-act="album" data-id="${esc(a.id)}"><b>${esc((a.name || a.title) === '[Unknown Album]' ? 'Brani senza album' : a.name || a.title)}</b></button>
      <small>${esc(a.artist || '')}${a.year ? ' · ' + a.year : ''}</small>
    </div>`).join('')}</div>`;
}
// elenco di brani (.tracklist): su schermo largo a colonne con intestazione (#, titolo, album, durata),
// su telefono miniatura, titolo e artista. Le righe restano .song: albumGaps vi inserisce le tracce mancanti
// ogni elenco disegnato tiene i suoi brani: un tocco usa l'elenco della riga, "Riproduci"/"Casuale" quello principale
// della pagina. Prima si usava solo l'ultimo elenco disegnato, e un elenco corto disegnato dopo accorciava la coda
const Lists = new Map(); let listSeq = 0;
function songList(tracks, opts = {}) {
  S.lastList = tracks;
  const lid = ++listSeq; Lists.set(lid, tracks); if (Lists.size > 40) Lists.delete(Lists.keys().next().value);
  if (!tracks.length) return `<div class="empty">${opts.empty || 'Nessun brano.'}</div>`;
  const cur = currentTrack();
  const art = opts.art !== false, alb = opts.showAlbum !== false;
  return `<div class="songs tracklist${alb ? '' : ' noalb'}${opts.queue ? ' q' : ''}" data-l="${lid}">
    <div class="th${art ? '' : ' noart'}"${opts.sortable ? '' : ' aria-hidden="true"'}><span class="n">#</span><span class="tt"${opts.sortable ? ' data-sort="title" role="button" tabindex="0"' : ''}>Titolo</span>${alb ? `<span class="al"${opts.sortable ? ' data-sort="album" role="button" tabindex="0"' : ''}>Album</span>` : ''}<span class="d"${opts.sortable ? ' data-sort="duration" role="button" tabindex="0" aria-label="Durata"' : ''}>${ic('clock')}</span><span></span></div>${tracks.map((t, i) => `
    <div class="song ${art ? '' : 'noart'} ${cur && key(cur) === key(t) ? 'now' : ''}" data-act="${opts.queue ? 'qplay' : 'play'}" data-i="${i}" data-tid="${esc(t.id)}">
      <span class="n">${opts.queue ? i + 1 : (opts.numbers ? (t.track || i + 1) : i + 1)}</span>
      <span class="thumb">${art ? imgTag(t.coverArt, 84, t.serverId) : ''}</span>
      <span class="t"><b>${Offline.has(t) ? '<span class="badge-off" title="Disponibile offline"></span>' : ''}${esc(t.title)}</b><small>${esc(t.artist)}</small></span>
      ${alb ? `<span class="al">${t.album ? `<span${t.albumId ? ` data-act="album" data-id="${esc(t.albumId)}"` : ''}>${esc(t.album)}</span>` : ''}</span>` : ''}
      <span class="d">${fmt(t.duration)}</span>
      <span class="acts">
        ${opts.queue ? `
          <button class="icon-btn desk-only" data-act="qup" data-i="${i}" aria-label="Sposta su">${ic('up')}</button>
          <button class="icon-btn desk-only" data-act="qdn" data-i="${i}" aria-label="Sposta giù">${ic('dn')}</button>
          <button class="icon-btn" data-act="qrm" data-i="${i}" aria-label="Togli dalla coda">${ic('close')}</button>` : `
          <button class="icon-btn desk-only" data-act="enqueue" data-i="${i}" aria-label="Aggiungi alla coda" title="Aggiungi alla coda">${ic('plus')}</button>
          <button class="icon-btn ${t.starred ? 'on' : ''}" data-act="star" data-i="${i}" aria-label="Preferito">${ic('heart', t.starred)}</button>`}
        <button class="icon-btn" data-act="more" data-i="${i}" aria-label="Altre azioni">${ic('more')}</button>
      </span>
    </div>`).join('')}</div>`;
}
const listActions = (extra = '') => `<div class="row acts-row" style="margin-bottom:16px">
  <button class="btn primary" data-act="playall">${ic('play')} Riproduci</button>
  <button class="btn" data-act="shuffleall">${ic('shuffle')} Mescola</button>
  <button class="btn" data-act="enqueueall">${ic('plus')} In coda</button>
  <button class="btn" data-act="offlineall">${ic('offline')} Offline</button>${extra}</div>`;
function noServer() {
  const local = /^https?:/.test(location.protocol) && !NATIVE;
  // nell'app si parte anche senza server, con la musica del telefono (telefono.js)
  const ph = !!Local.p;
  if (local && !ph) {  // nel browser servito dal server: il modulo di accesso subito (utenti.js)
    view.innerHTML = loginCard();
    wireLogin();
  } else view.innerHTML = `<h1>Benvenuto in Armony</h1><p class="sub">La musica della vostra compagnia, dai vostri server.</p>
  <div class="empty"><h3>${ph ? 'Da dove arriva la musica?' : 'Collega il primo server'}</h3><p>${ph ? 'Ascolta subito i brani che hai sul telefono, anche senza rete. Un server lo colleghi quando vuoi: ci salvi una copia della tua musica e da lì prendi quella degli amici.' : 'Accedi con il tuo utente del server musicale, oppure creane uno se chi lo gestisce ti ha dato un invito.'}</p>
  <div class="row" style="justify-content:center">
    ${ph ? `<button class="btn primary" data-act="phone" data-do="on">${ic('phone')} Usa la musica del telefono</button>` : ''}
    <button class="btn${ph ? '' : ' primary'}" data-act="addsrv" ${local ? `data-url="${esc(location.origin)}"` : ''}>${ph ? 'Collegati a un server' : 'Aggiungi server'}</button>
    <button class="btn" data-act="scanqr">${ic('qr')} Inquadra un QR</button>
    <button class="btn" data-act="importset">Importa impostazioni da un amico</button>
    <a class="btn" href="#/jam">Entra in una Jam</a>
  </div></div>${local ? `<div class="row" style="justify-content:center;margin-top:var(--s5)"><a class="btn sm" href="${esc(apkUrl())}">${ic('down')} App Android</a><button class="btn sm" id="welQr">QR code</button></div>` : ''}`;
  $('#welQr')?.addEventListener('click', e => {
    e.preventDefault(); const d = $('#dlg2'), url = apkUrl();
    d.innerHTML = `<h3>App Android</h3><p class="sub">Inquadra il codice con la fotocamera del telefono.</p><div id="welQrBox" style="margin:var(--s4) 0;display:grid;place-items:center"></div><div class="code" style="font-size:.8rem">${esc(url)}</div><div class="row"><button class="btn" onclick="this.closest('dialog').close()">Chiudi</button></div>`;
    closeOutside(d); d.showModal(); qrInto($('#welQrBox'), url).catch(() => {});
  });
}

// link d'invito (<server>/#/invito/<codice>): apre "Crea un account" con indirizzo e codice già compilati
function vInvite(code) {
  noServer();
  serverDialog(null, { url: NATIVE ? '' : location.origin, mode: 'crea', code: code || '' });
}

/* ================= L: intestazioni di pagina, barra azioni, schede artista, riquadri colorati ================= */
// percorso dentro l'app: il tasto ← delle intestazioni torna alla pagina di prima, o alla libreria se si è entrati da un link
const navStack = [location.hash];
addEventListener('hashchange', () => { if (navStack.at(-2) === location.hash) navStack.pop(); else navStack.push(location.hash); if (navStack.length > 50) navStack.shift(); });
function goBack() { if (navStack.length > 1) history.back(); else location.hash = '#/libreria'; }
// aside: riquadro a destra dell'intestazione, solo su schermo largo (CSS)
function lPhero({ kind, title, art = '', round = false, meta = '', tile = '', ph, aside = '' }) {
  const url = ph ? coverUrl(ph, 300) : '';
  if (url) Glow.colors(url).then(c => { const el = $('#view .phero'); if (el && Glow.usable(c)) el.style.setProperty('--ph', Glow.tone(c.c1, .55, c.neutral)); });
  return `<header class="phero${round ? ' round' : ''}"${tile.startsWith('#') ? ` style="--ph:${tile}"` : ''}><button class="ph-back" data-act="goback" aria-label="Indietro" title="Indietro">${ic('chevl')}</button><div class="phero-art${tile ? ' tile' : ''}"${tile ? ` style="--tile:${tile}"` : ''}>${art}</div>
    <div class="phero-txt"><span class="phero-kind">${kind}</span><h1 class="phero-title">${esc(title)}</h1>${meta ? `<p class="phero-meta">${meta}</p>` : ''}</div>${aside ? `<button class="ph-aside" data-act="bio" aria-label="Leggi la biografia">${aside}</button>` : ''}</header>`;
}
// barra azioni: play grande, poi icone; il resto nel foglio "⋯" (lMore)
let lMoreItems = [];
function lActionBar({ play = { act: 'playall' }, shuffle = { act: 'shuffleall' }, star = null, offline = true, addpl = true, extra = '', more = [] } = {}) {
  lMoreItems = more.filter(Boolean);
  const d = o => Object.entries(o.data || {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  return `<div class="actionbar">
    <button class="ab-play" data-act="${play.act}"${d(play)} aria-label="${play.label || 'Riproduci'}" title="${play.label || 'Riproduci'}">${ic('play', true)}</button>
    ${shuffle ? `<button class="icon-btn ab" data-act="${shuffle.act}"${d(shuffle)} aria-label="${shuffle.label || 'Riproduci in ordine casuale'}" title="${shuffle.label || 'Casuale'}">${ic(shuffle.icon || 'shuffle')}</button>` : ''}
    ${star ? `<button class="icon-btn ab${star.on ? ' on' : ''}" data-act="${star.act}"${d(star)} aria-label="${star.on ? 'Togli dai preferiti' : 'Aggiungi ai preferiti'}" title="Preferito">${ic('heart', star.on)}</button>` : ''}
    ${offline && !srv()?.local ? `<button class="icon-btn ab" data-act="offlineall" aria-label="Salva per l'offline" title="Offline">${ic('offline')}</button>` : ''}
    ${addpl && can('playlist') ? `<button class="icon-btn ab" data-act="addalltopl" aria-label="Aggiungi a una playlist" title="Aggiungi a playlist">${ic('addlist')}</button>` : ''}
    ${extra}${lMoreItems.length ? `<button class="icon-btn ab" data-act="lmore" aria-label="Altre azioni" title="Altro">${ic('more')}</button>` : ''}
  </div>`;
}
// "sempre offline" (OffPin) al posto del semplice salvataggio, per playlist e Preferiti
const pinBtn = pid => { const on = OffPin.has(pid); return `<button class="icon-btn ab${on ? ' on' : ''}" data-act="offpin" data-id="${esc(pid)}" aria-pressed="${on}" aria-label="${on ? 'Sempre offline: attivo' : 'Tieni sempre offline'}" title="${on ? 'Sempre offline' : 'Tieni sempre offline'}">${ic('offline')}</button>`; };
// il foglio "⋯": ogni voce ripete la sua azione come un clic nella pagina (la delegazione è su #view)
function lMore() {
  const d = $('#dlg'); d.className = 'sheet';
  d.innerHTML = lMoreItems.map((it, k) => `<button class="mi${it.danger ? ' danger' : ''}" data-k="${k}">${ic(it.icon || 'more')}<span>${esc(it.label)}</span></button>`).join('');
  d.querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
    const it = lMoreItems[+b.dataset.k]; d.close();
    const x = document.createElement('button'); x.hidden = true; x.dataset.act = it.act;
    Object.entries(it.data || {}).forEach(([k, v]) => x.dataset[k] = v);
    view.append(x); x.click(); x.remove();
  });
  d.onclose = () => { d.className = ''; d.onclose = null; };
  closeOutside(d); d.showModal();
}
function lArtistCard(a) {
  const img = a.coverArt ? imgTag(a.coverArt, 300) : a.artistImageUrl ? `<img src="${esc(a.artistImageUrl)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<button class="lcard round" data-act="artist" data-id="${esc(a.id)}"><div class="lcover">${img || ic('artist')}</div><b>${esc(a.name)}</b><small>Artista</small></button>`;
}
function lPlCard(p) {
  return `<button class="lcard" data-act="openpl" data-id="${esc(p.id)}"><div class="lcover">${p.songCount ? imgTag(p.coverArt, 300) : ic('list')}</div><b>${esc(p.name)}</b><small>${p.owner ? esc(p.owner) + ' · ' : ''}${p.songCount} ${p.songCount === 1 ? 'brano' : 'brani'}</small></button>`;
}
// ordina e cerca dentro un elenco di brani, come su Spotify: "Ordina per" (personalizzato, titolo, artista, album, aggiunti
// di recente, durata, crescente o decrescente) e la lente per filtrare. Si ricorda per pagina (store 'ord:<chiave>').
// Ogni brano tiene la sua posizione vera (_pi): "Togli dalla playlist" deve togliere quella, non la riga mostrata
const ORD = [['custom', 'Personalizzato'], ['title', 'Titolo'], ['artist', 'Artista'], ['album', 'Album'], ['added', 'Aggiunti di recente'], ['duration', 'Durata']];
const Ord = {
  get: k => ({ by: 'custom', dir: 1, q: '', ...store.get('ord:' + k, {}) }),
  set(k, o) { store.set('ord:' + k, { by: o.by, dir: o.dir }); },
  apply(songs, o) {
    songs.forEach((t, i) => { if (t._pi == null) t._pi = i; });
    const q = cleanTxt(o.q || ''), cmp = (a, b) => String(a || '').localeCompare(String(b || ''), 'it', { sensitivity: 'base', numeric: true });
    let l = q ? songs.filter(t => cleanTxt(`${t.title} ${t.artist} ${t.album}`).includes(q)) : songs.slice();
    const f = { title: (a, b) => cmp(a.title, b.title), artist: (a, b) => cmp(a.artist, b.artist) || cmp(a.album, b.album) || (a.track || 0) - (b.track || 0),
      album: (a, b) => cmp(a.album, b.album) || (a.track || 0) - (b.track || 0), added: (a, b) => cmp(b.created, a.created), duration: (a, b) => (a.duration || 0) - (b.duration || 0) }[o.by];
    if (f) l.sort((a, b) => f(a, b) * o.dir);
    else if (o.dir < 0) l.reverse();
    return l;
  },
  // la barra sopra l'elenco: lente che si apre, e "Ordina per" con le voci di Spotify
  bar(k) {
    const o = this.get(k), lab = ORD.find(x => x[0] === o.by)?.[1] || ORD[0][1];
    return `<div class="ordbar" data-ord="${esc(k)}"><label class="ordq">${ic('search')}<input type="search" placeholder="Cerca qui" aria-label="Cerca in questo elenco" autocomplete="off"></label>
      <button class="ordby" aria-haspopup="menu"><span>${esc(lab)}</span>${o.dir < 0 && o.by !== 'custom' ? ic('dn') : o.by !== 'custom' ? ic('up') : ic('queue')}</button></div>`;
  },
  // collega barra ed elenco: render(lista ordinata) ridisegna, songs() dà l'elenco intero più recente
  wire(k, songs, render) {
    const bar = $(`.ordbar[data-ord="${CSS.escape(k)}"]`); if (!bar) return;
    const o = this.get(k), redo = () => render(this.apply(songs(), o));
    let t; bar.querySelector('input').oninput = e => { clearTimeout(t); t = setTimeout(() => { o.q = e.target.value; redo(); }, 150); };
    bar.querySelector('.ordby').onclick = e => {
      const r = e.currentTarget.getBoundingClientRect();
      ctxMenuOrPick([r.left, r.bottom + 4], ORD.map(([v, l]) => [v === o.by ? 'check' : 'more', l + (v === o.by && v !== 'custom' ? (o.dir > 0 ? ' · crescente' : ' · decrescente') : ''), () => {
        o.dir = v === o.by && v !== 'custom' ? -o.dir : v === 'added' ? 1 : 1; o.by = v; this.set(k, o);
        bar.outerHTML = this.bar(k); this.wire(k, songs, render); const nb = $(`.ordbar[data-ord="${CSS.escape(k)}"] input`); if (nb && o.q) nb.value = o.q;
        redo();
      }]), 'Ordina per');
    };
    // sul computer anche le intestazioni delle colonne ordinano, come su Spotify
    const host = bar.nextElementSibling;
    if (host) host.onclick = e => {
      const h = e.target.closest('.th [data-sort]'); if (!h) return;
      const v = h.dataset.sort; o.dir = o.by === v ? -o.dir : 1; o.by = v; this.set(k, o); bar.outerHTML = this.bar(k); this.wire(k, songs, render); redo();
    };
  }
};
// sul telefono il menu col tasto destro non esiste: lo stesso elenco di voci come foglio
function ctxMenuOrPick(at, items, title) {
  if (matchMedia('(pointer:fine)').matches) return ctxMenu(at, items, title ? `<b>${esc(title)}</b>` : '');
  const d = $('#dlg'); d.className = 'sheet';
  d.innerHTML = `${title ? `<div class="head"><b>${esc(title)}</b></div>` : ''}${items.map(([i, l], n) => `<button class="mi" data-n="${n}">${ic(i)}<span>${esc(l)}</span></button>`).join('')}`;
  d.querySelectorAll('[data-n]').forEach(b => b.onclick = () => { d.close(); items[+b.dataset.n][2](); });
  d.onclose = () => { d.className = ''; d.onclose = null; }; closeOutside(d); d.showModal();
}
// tempo reale: mentre una playlist o un album sono aperti, i brani nuovi entrano al loro posto e quelli tolti escono,
// senza ridisegnare la pagina (ogni 20 s, e subito all'evento 'libreria' di Bus)
function lLive(n, fetch, opts, after) {
  const check = async () => {
    if (stale(n)) return Bus.removeEventListener('libreria', check);
    let songs; try { songs = await fetch(); } catch { return; }
    if (stale(n)) return;
    // anche durata e titolo: un brano appena scaricato può comparire prima con durata 0 e poi giusto
    const sig = l => l.map(t => `${t.id}|${t.duration}|${t.title}`).join();
    if (sig(S.lastList) === sig(songs)) return;
    lMerge(songs, opts); after?.(songs);
  };
  // col canale dal vivo aperto gli arrivi li annuncia il server (evento 'libreria'): niente richiesta intera ogni 20 s,
  // che in 5G su una playlist da mille brani erano centinaia di kB a vuoto. Senza canale, o a pagina nascosta, come prima
  viewInterval(() => { if (!document.hidden && !Live.alive()) check(); }, 20000); Bus.addEventListener('libreria', check);
}
function lMerge(songs, opts) {
  const host = $('#lList'); if (!host) return;
  const box = host.querySelector('.songs');
  if (!box || !songs.length) { host.innerHTML = songList(songs, opts); window.autoAnimate?.(host.querySelector('.songs') || host); return; }
  window.autoAnimate?.(box);
  const old = S.lastList, keep = new Map();
  box.querySelectorAll(':scope > .song:not(.ghost)').forEach(el => { const id = old[+el.dataset.i]?.id; (keep.get(id) || keep.set(id, []).get(id)).push(el); });
  const tmp = document.createElement('div'); tmp.innerHTML = songList(songs, opts);  // aggiorna anche S.lastList
  const fresh = [...tmp.querySelectorAll('.songs > .song')];  // senza l'intestazione .th
  box.querySelectorAll(':scope > .song.ghost').forEach(el => el.remove());
  fresh.forEach((nu, i) => {
    let el = keep.get(songs[i].id)?.shift();
    if (el) {
      el.dataset.i = i; el.querySelectorAll('[data-i]').forEach(b => b.dataset.i = i);
      for (const sel of ['.n', '.d', '.t small']) { const a = el.querySelector(sel), b = nu.querySelector(sel); if (a && b && a.textContent !== b.textContent) a.innerHTML = b.innerHTML; }
      const tb = el.querySelector('.t b'), nb = nu.querySelector('.t b'); if (tb && nb && tb.textContent !== nb.textContent) tb.innerHTML = nb.innerHTML;
    }
    else { el = nu; el.classList.add('arrivato'); }
    box.append(el);
  });
  keep.forEach(list => list.forEach(el => el.remove()));
  box.dataset.l = tmp.querySelector('.songs').dataset.l;  // l'elenco ora è quello nuovo
}

/* ================= viste: libreria ================= */
// ---- Home e Cerca: accesso rapido, mix, scaffali; Sfoglia con riquadri colorati ----
// tavolozza dei riquadri (Cerca, generi, decenni): colori saturi che reggono testo bianco, scelti per nome (lo stesso nome ha sempre lo stesso colore)
const TILE_HUES = ['#d1345b', '#2d46b9', '#8d4fc2', '#c2560a', '#16825d', '#2f7fd6', '#c93b1d', '#3f7f98', '#a0522d', '#5b3fd1', '#b8457f', '#1f8a8a', '#7a3fa0', '#b07a12', '#386641', '#c0392b'];
const tileColor = name => TILE_HUES[[...String(name)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % TILE_HUES.length];
// titolo di sezione con "Mostra tutto" verso la libreria con l'ordinamento giusto
const secHead = (title, sort) => `<div class="hsec"><h2>${title}</h2>${sort ? `<button class="hsec-more" data-act="showall" data-sort="${sort}">Mostra tutto</button>` : ''}</div>`;
async function vHome() {
  if (!srv()) return noServer();
  const s = srv();
  if (!navigator.onLine && !s.local) { location.hash = '#/offline'; return; }
  if (s.local && (await Local.ready, !Local.songs.length)) return Local.emptyHome();
  const n = Scene.nav;
  const [nw, rnd, freq, recent, hist] = await Promise.all([
    api('getAlbumList2', { type: 'newest', size: 18 }),
    api('getAlbumList2', { type: 'random', size: 18 }),
    api('getAlbumList2', { type: 'frequent', size: 18 }).catch(() => null),
    api('getAlbumList2', { type: 'recent', size: 18 }).catch(() => null),
    Stats.since(30)  // solo l'ultimo mese: con anni di ascolti la Home rallentava sul telefono
  ]);
  // mix del giorno: i tre artisti che ascolti di più nell'ultimo mese (storico di tutti i tuoi dispositivi), ognuno con i simili
  const top = new Map(); hist.filter(x => x.ts > Date.now() - 30 * 864e5 && x.artistId && x.serverId === s.id).forEach(x => { const e = top.get(x.artistId) || { n: 0, name: x.artist }; e.n++; top.set(x.artistId, e); });
  const daily = [...top].sort((a, b) => b[1].n - a[1].n).slice(0, 3);
  const DAILY_HUES = ['#2f7fd6', '#b8457f', '#386641'];
  if (stale(n)) return;
  const L = x => arr(x?.albumList2?.album);
  const hour = new Date().getHours();
  const hello = hour < 6 ? 'Buonanotte' : hour < 13 ? 'Buongiorno' : hour < 18 ? 'Buon pomeriggio' : 'Buonasera';
  // accesso rapido: gli ultimi ascoltati, completati con i più ascoltati e i nuovi, senza doppioni
  const seen = new Set(), quick = [...L(recent), ...L(freq), ...L(nw)].filter(a => !seen.has(a.id) && seen.add(a.id)).slice(0, 8);
  // decennio più presente fra gli album più ascoltati, per il suo mix
  const byDec = L(freq).concat(L(recent)).reduce((m, a) => { if (a.year) { const d = Math.floor(a.year / 10) * 10; m[d] = (m[d] || 0) + 1; } return m; }, {});
  const dec = Object.entries(byDec).sort((a, b) => b[1] - a[1])[0]?.[0];
  const mix = (act, title, sub, icon, hue, extra = '') => `<button class="hmix" data-act="${act}" ${extra} style="--h1:${hue}">
    <span class="hmix-art">${ic(icon)}<b>${title}</b></span><span class="hmix-t"><b>${title}</b><small>${sub}</small></span></button>`;
  view.innerHTML = `<div class="stories" id="presStories" data-pres hidden></div><h1 class="hhello">${hello}${P.nick || s.user ? ', ' + esc(P.nick || s.user) : ''}</h1>
    <div class="hradio-box" id="radioRow" hidden></div><div id="resume"></div><div id="friendsStrip"></div>
    ${quick.length ? `<div class="quick">${quick.map(a => `<div class="qk" data-act="album" data-id="${esc(a.id)}" role="link" tabindex="0">
      <span class="qk-art">${imgTag(a.coverArt, 160)}</span><b>${esc(a.name)}</b>
      <button class="qk-play" data-act="playalb" data-id="${esc(a.id)}" aria-label="Riproduci ${esc(a.name)}">${ic('play', true)}</button></div>`).join('')}</div>` : ''}
    ${secHead('Fatti per te')}
    <div class="hgrid shelf">
      ${daily.map(([id, e], i) => mix('dailymix', `Mix di ${esc(e.name)}`, `${esc(e.name)} e artisti simili, rimescolato ogni giorno`, 'artist', DAILY_HUES[i], `data-id="${esc(id)}" data-name="${esc(e.name)}"`)).join('')}
      ${mix('radio', 'Mix casuale', 'Ottanta brani a caso da tutta la libreria', 'shuffle', '#d1345b')}
      ${mix('mixfav', 'I tuoi preferiti', 'I brani col cuore, mescolati', 'heart', '#8d4fc2')}
      ${mix('mixforgot', 'Riscoperte', 'Quello che non senti da almeno due mesi', 'radio', '#16825d')}
      ${dec ? mix('decademix', `Anni ${String(dec).slice(2)}`, 'Il decennio che ascolti di più', 'album', '#c2560a', `data-y="${dec}"`) : ''}
      <a class="hmix" href="#/jam" style="--h1:#2d46b9"><span class="hmix-art">${ic('jam')}<b>Jam</b></span><span class="hmix-t"><b>Avvia una Jam</b><small>Ascoltate insieme, ognuno dal suo telefono</small></span></a>
    </div>
    ${L(recent).length ? secHead('Ascoltati di recente') + albumGrid(L(recent), { strip: true }) : ''}
    ${secHead('Aggiunti di recente', 'newest')}${albumGrid(L(nw), { strip: true })}
    ${L(freq).length ? secHead('I più ascoltati', 'frequent') + albumGrid(L(freq), { strip: true }) : ''}
    ${secHead('Da riscoprire', 'random')}${albumGrid(L(rnd), { strip: true })}<div id="newRel"></div>`;
  newReleases(n);
  if (Radio.ok()) { window.autoAnimate?.($('#radioRow')); Radio.paintAll(); if (!Live.es) Radio.load(); }
  QSync.check().then(q => {
    if (!q || !$('#resume')) return;
    $('#resume').innerHTML = `<div class="hbanner">${q.current.coverArt ? `<span class="hb-art">${imgTag(q.current.coverArt, 96, q.current.serverId)}</span>` : ''}
      <span class="grow"><small>Su un altro dispositivo${q.by ? ` (${esc(q.by)})` : ''}</small><b>${esc(q.current.title)}</b></span>
      <button class="btn sm primary" id="resumeBtn">${ic('play', true)} Riprendi da ${fmt(q.position)}</button></div>`;
    $('#resumeBtn').onclick = () => { S.queue = q.tracks; playIndex(q.index, { startAt: q.position }); $('#resume').innerHTML = ''; };
  });
  friendsNow().then(list => {
    const box = $('#friendsStrip'); if (!box || !list.length || Presence.on()) return;  // con la presenza ci sono le storie
    box.innerHTML = `<a class="hbanner" href="#/amici">${ic('friends')}<span class="grow"><small>Amici in ascolto</small><b>${list.slice(0, 2).map(f => `${esc(f.username)}: ${esc(f.title)}`).join(' · ')}${list.length > 2 ? ` e altri ${list.length - 2}` : ''}</b></span>${ic('chevr')}</a>`;
  });
}
// "Nuove uscite" in Home, come il Release Radar: dischi degli ultimi 60 giorni dei tuoi 15 artisti più ascoltati negli
// ultimi 90 giorni, che non sono ancora in libreria (capacità "novita"); si aprono e si scaricano da Deezer
async function newReleases(n) {
  if (!dlSrv()?.me?.caps?.includes('novita')) return;
  const from = Date.now() - 90 * 864e5, c = new Map();
  // niente segnaposto ("NA" di alcuni CSV, "Unknown", "Various Artists"): darebbero gli artisti sbagliati su Deezer
  const junk = a => a.length < 2 || /^(n\/?a|unknown( artist)?|\[unknown.*\]|various artists|artisti vari)$/i.test(a);
  (await Stats.since(90)).forEach(x => { if (x.ts >= from && x.artist) { const a = x.artist.split(/\s*[,•&]\s*|\s+feat\.?\s+/i)[0].trim(); if (!junk(a)) c.set(a, (c.get(a) || 0) + 1); } });
  const top = [...c].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([a]) => a);
  if (!top.length) return;
  let r; try { r = await dlApi('/api/novita?artists=' + encodeURIComponent(top.join('|'))); } catch { return; }
  const box = $('#newRel'); if (!box || stale(n) || !r.items.length) return;
  box.innerHTML = `<div class="shelf-head"><h2>Nuove uscite</h2></div><div class="cards shelf">${r.items.map(a => discoCard({ type: a.type, year: a.date?.slice(0, 4), x: { id: a.dz, cover: a.cover, title: a.title } }).replace('</small></div>', ` · ${esc(a.artist)}</small></div>`)).join('')}</div>`;
}
async function vLibrary(tab) {
  if (!srv()) return noServer();
  tab = tab || 'playlist';
  const n = Scene.nav;
  // tempo reale: artisti, album e generi arrivati con un download compaiono da soli (evento 'libreria')
  const live = f => { const on = () => { Bus.removeEventListener('libreria', on); if (!stale(n)) f(); }; Bus.addEventListener('libreria', on); };
  const tabs = `<div class="lhead"><h1>Libreria</h1>${can('playlist') ? `<button class="icon-btn" data-act="libplus" aria-label="Crea o importa una playlist">${ic('plus')}</button>` : ''}</div><div class="lpills" role="navigation" aria-label="Sezioni della libreria">${[['playlist', 'Playlist'], ['artisti', 'Artisti'], ['album', 'Album'], ['cronologia', 'Cronologia'], ['generi', 'Generi'], ['brani', 'Brani a caso']].map(([k, l]) => `<a href="#/libreria/${k}" class="${k === tab ? 'on' : ''}"${k === tab ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</div>`;
  if (tab === 'cronologia') {
    // gli ultimi ascolti, per giorno (lo storico è quello di tutti i tuoi dispositivi se la sincronizzazione è accesa)
    const h = (await Stats.all()).sort((a, b) => b.ts - a.ts).slice(0, 400);
    if (stale(n)) return;
    const today = new Date().toDateString(), yest = new Date(Date.now() - 864e5).toDateString();
    const days = new Map();
    h.forEach(x => { const d = new Date(x.ts), k = d.toDateString(); if (!days.has(k)) days.set(k, { label: k === today ? 'Oggi' : k === yest ? 'Ieri' : d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }), list: [] }); days.get(k).list.push({ ...x, duration: x.duration || 0 }); });
    view.innerHTML = tabs + (h.length ? [...days.values()].map(d => `<h2 class="qhead">${esc(d.label)}</h2>${songList(d.list.filter(t => srv(t.serverId)), { empty: '' })}`).join('')
      : '<div class="empty"><h3>Ancora nessun ascolto</h3><p>Qui trovi i brani che ascolti, giorno per giorno.</p></div>');
    return;
  }
  if (tab === 'playlist') {
    view.innerHTML = tabs + '<div id="plBox"></div>';
    await playlistsInto($('#plBox'), n);
    live(() => vLibrary(tab));
  } else if (tab === 'artisti') {
    const idx = arr((await api('getArtists')).artists.index);
    if (stale(n)) return;
    const tot = idx.reduce((k, x) => k + arr(x.artist).length, 0);
    view.innerHTML = tabs + `<p class="sub">${tot} artisti</p>` + (tot ? `<div class="lcards">` +
      idx.map(x => `<div class="lletter">${esc(x.name)}</div>` + arr(x.artist).map(lArtistCard).join('')).join('') + '</div>' : '<div class="empty">Nessun artista. Aggiungi musica alla cartella del server.</div>');
    live(() => vLibrary(tab));
  } else if (tab === 'album') {
    let offset = 0, sort = sessionStorage.getItem('armony:asort') || 'alphabeticalByName';
    view.innerHTML = tabs + `<div class="lbar"><label class="lsort">${ic('sliders')}<select id="aSort" aria-label="Ordina gli album">
      ${[['alphabeticalByName', 'Per titolo'], ['alphabeticalByArtist', 'Per artista'], ['newest', 'Aggiunti di recente'], ['frequent', 'Più ascoltati'], ['starred', 'Preferiti'], ['random', 'A caso']].map(([v, l]) => `<option value="${v}"${v === sort ? ' selected' : ''}>${l}</option>`).join('')}
      </select></label></div><div id="aGrid"></div><div class="row" style="justify-content:center;margin-top:20px"><button class="btn" id="aMore">Carica altri</button></div>`;
    const load = async (reset) => {
      const al = arr((await api('getAlbumList2', { type: sort, size: 60, offset: reset ? 0 : offset })).albumList2.album);
      if (stale(n)) return;
      if (reset) { offset = 0; $('#aGrid').innerHTML = ''; }
      $('#aGrid').insertAdjacentHTML('beforeend', albumGrid(al, { empty: offset ? 'Non ci sono altri album.' : 'Nessun album.' }));
      offset += al.length; $('#aMore').hidden = al.length < 60;
    };
    $('#aSort').onchange = e => { sort = e.target.value; sessionStorage.setItem('armony:asort', sort); load(true); };
    $('#aMore').onclick = () => load(false);
    await load(true);
    const re = () => { live(re); if (offset <= 60) load(true); };  // dopo "Carica altri" no: si perderebbe il punto
    live(re);
  } else if (tab === 'generi') {
    const g = arr((await api('getGenres')).genres.genre).sort((a, b) => a.value.localeCompare(b.value));
    if (stale(n)) return;
    view.innerHTML = tabs + (g.length ? `<div class="ltiles">${g.map(x => `<a class="ltile" style="--tile:${tileColor(x.value)}" href="#/genere/${encodeURIComponent(x.value)}"><b>${esc(x.value)}</b><small>${x.songCount} ${x.songCount === 1 ? 'brano' : 'brani'} · ${x.albumCount} album</small></a>`).join('')}</div>` : '<div class="empty">Nessun genere nei metadati dei brani.</div>');
    live(() => vLibrary(tab));
  } else {
    const r = await api('getRandomSongs', { size: 80 });
    if (stale(n)) return;
    view.innerHTML = tabs + lActionBar({ extra: `<button class="icon-btn ab" id="lReroll" aria-label="Altri brani a caso" title="Altri brani">${ic('repeat')}</button>`, more: [{ act: 'enqueueall', label: 'Aggiungi tutti alla coda', icon: 'queue' }] }) + songList(arr(r.randomSongs.song).map(x => norm(x)));
    $('#lReroll').onclick = () => route();
  }
}

async function vArtist(id) {
  const n = Scene.nav;
  const a = (await api('getArtist', { id })).artist;
  // la discografia di Deezer arriva insieme al resto; se tarda più di 3 s la pagina esce senza e la aggiunge dopo
  const dzP = discoOk() ? Promise.all([dlApi('/api/discografia?artist=' + encodeURIComponent(a.name)), libNames()]).catch(() => null) : null;
  // informazioni e popolari insieme (prima una dopo l'altra: Navidrome può chiederle a Last.fm, lente)
  let [info, top] = await Promise.all([api('getArtistInfo2', { id, count: 12 }).then(r => r.artistInfo2).catch(() => null),
    api('getTopSongs', { artist: a.name, count: 10 }).then(r => arr(r.topSongs?.song).map(x => norm(x))).catch(() => [])]);
  // senza Last.fm su Navidrome i popolari sono vuoti: si prendono quelli di Deezer che sono in libreria
  if (!top.length && dlSrv()?.me?.caps?.includes('catalogo')) {
    try { const ids = (await dlApi('/api/popolari?artist=' + encodeURIComponent(a.name))).ids; top = (await Promise.all(ids.map(sid => api('getSong', { id: sid }).then(r => norm(r.song)).catch(() => null)))).filter(Boolean); } catch {}
  }
  const early = dzP && await Promise.race([dzP, new Promise(r => setTimeout(r, 3000))]);
  if (stale(n)) return;
  const bio = (info?.biography || '').replace(/<a[^>]*>.*?<\/a>/g, '').replace(/<[^>]+>/g, '').trim();
  // luce dalla copertina sul server (stessa origine): l'immagine grande dell'artista spesso è di un altro dominio
  Glow.show(coverUrl(a.coverArt || arr(a.album)[0]?.coverArt, 300), 'album');
  const albums = arr(a.album), sim = arr(info?.similarArtist).filter(x => x.id);
  const img = info?.largeImageUrl ? `<img src="${esc(info.largeImageUrl)}" alt="" onerror="this.remove()">` : imgTag(a.coverArt, 500);
  const aside = bio ? `<span class="phero-kind">Informazioni</span><span class="lbio" style="display:block">${esc(bio.slice(0, 600))}</span>` : '';
  S.bio = { name: a.name, text: bio };
  view.innerHTML = lPhero({ kind: 'Artista', title: a.name, ph: a.coverArt, art: img, round: true, aside, meta: `${albums.length} album${top.length ? ` · ${top.length} brani popolari` : ''}` }) +
    lActionBar({ play: { act: 'artistall', data: { id }, label: 'Riproduci tutto' }, shuffle: { act: 'artistradio', data: { id, name: a.name }, icon: 'radio', label: 'Radio dell\'artista' }, offline: false, addpl: false }) +
    (top.length ? `<h2>Popolari</h2><div class="ltop" id="lTop">${songList(top)}</div>${top.length > 5 ? `<button class="lmorebtn" id="lTopMore">Mostra altri</button>` : ''}` : '') +
    `<div id="lDisco">${discoHtml(albums, early?.[0])}</div><div id="lSim">${simHtml(sim, early?.[0], early?.[1])}</div>` +
    (bio ? `<div class="bio-bottom"><h2>Informazioni</h2><p class="lbio">${esc(bio.slice(0, 700))}${bio.length > 700 ? '…' : ''}</p></div>` : '');

  playCounts($('#lTop'), n);
  const more = $('#lTopMore');
  if (more) more.onclick = () => { const t = $('#lTop'); t.classList.toggle('all'); more.textContent = t.classList.contains('all') ? 'Mostra meno' : 'Mostra altri'; };
  const got = early || await dzP; if (!got || stale(n)) return;
  const [dz, names] = got;
  if (!early) { $('#lDisco').innerHTML = discoHtml(albums, dz); $('#lSim').innerHTML = simHtml(sim, dz, names); }
  // tempo reale: un album scaricato entra in libreria e la sua scheda fantasma diventa normale
  let cur = albums.map(x => x.id).join();
  const check = async () => {
    if (stale(n)) return Bus.removeEventListener('libreria', check);
    let b; try { b = arr((await api('getArtist', { id })).artist.album); } catch { return; }
    if (stale(n) || b.map(x => x.id).join() === cur) return;
    cur = b.map(x => x.id).join(); $('#lDisco').innerHTML = discoHtml(b, dz);
  };
  viewInterval(check, 20000); Bus.addEventListener('libreria', check);
}

/* ---- discografia completa da Deezer (/api/discografia): ciò che manca in libreria come schede "fantasma" ---- */
const discoOk = () => !!(srv()?.me?.caps?.includes('discografia') && access().download && S.dl.url);
// il server aggiunge da sé alle playlist i brani scaricati e chiede lui la scansione (altrimenti lo fa il client: 'pending')
const plServer = () => !!srv()?.me?.caps?.includes('plserver');
const DZTYPE = { album: 'Album', ep: 'EP', single: 'Singolo', compile: 'Compilation' };
// titolo per riconoscere lo stesso album fra edizioni: senza parentesi, "- 2011 Remaster", "Deluxe", "Edition"…
const albKey = s => cleanTxt(String(s || '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s[-–]\s.*$/, '')).replace(/\b(deluxe|remaster(ed)?|expanded|edition|version|anniversary|edizione)\b/g, '').replace(/\s+/g, ' ').trim();
// artisti della libreria per nome (una richiesta, ricordata finché la libreria non cambia)
let libNamesP = null;
Bus.addEventListener('libreria', () => { libNamesP = null; });
const libNames = () => libNamesP ||= api('getArtists').then(r => new Map(arr(r.artists.index).flatMap(x => arr(x.artist)).map(x => [cleanTxt(x.name), x.id]))).catch(() => (libNamesP = null, new Map()));
// sezioni come su Spotify: Album, Singoli ed EP, Compilation; dentro, dal più recente. Senza Deezer: la griglia di sempre
function discoHtml(albums, dz) {
  if (!dz) return `<h2>Discografia</h2>${albumGrid(albums, { strip: true })}`;
  const lib = new Map(); albums.forEach(a => { const k = albKey(a.name); if (!lib.has(k)) lib.set(k, a); });
  const used = new Set(), seen = new Set(), items = [];
  // le edizioni dello stesso titolo diventano una scheda (la più breve, di solito l'originale); la libreria vince
  [...dz.albums].sort((x, y) => (x.type !== 'album') - (y.type !== 'album') || x.title.length - y.title.length).forEach(x => {
    const k = albKey(x.title), a = lib.get(k); if (seen.has(x.type + '|' + k)) return; seen.add(x.type + '|' + k);
    if (!a) items.push({ type: x.type, year: x.year, x });
    else if (!used.has(a.id)) { used.add(a.id); items.push({ type: x.type, year: a.year || x.year, a }); }
  });
  albums.forEach(a => { if (!used.has(a.id)) items.push({ type: 'album', year: a.year, a }); });
  return [['Album', ['album']], ['Singoli ed EP', ['single', 'ep']], ['Compilation', ['compile']]].map(([t, ts]) => {
    const g = items.filter(i => ts.includes(i.type)).sort((p, q) => (q.year || 0) - (p.year || 0));
    return g.length ? `<h2>${t}</h2><div class="cards shelf disco">${g.map(discoCard).join('')}</div>` : '';
  }).join('') || `<h2>Discografia</h2>${albumGrid([], {})}`;
}
function discoCard({ type, year, a, x }) {
  const sub = esc((year ? year + ' · ' : '') + (DZTYPE[type] || 'Album'));
  if (a) return `<div class="card"><div class="art">${imgTag(a.coverArt, 300)}<button class="card-play" data-act="playalbum" data-id="${esc(a.id)}" aria-label="Riproduci ${esc(a.name)}">${ic('play')}</button></div>
    <button class="card-go" data-act="album" data-id="${esc(a.id)}"><b>${esc(a.name)}</b></button><small>${sub}</small></div>`;
  return `<div class="card ghost"><div class="art">${x.cover ? `<img src="${esc(x.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<span class="ghost-tag">Non in libreria</span></div>
    <button class="card-go" data-act="dzalbum" data-id="${esc(x.id)}"><b>${esc(x.title)}</b></button><small>${sub}</small></div>`;
}
// simili della libreria, poi quelli di Deezer: se l'artista c'è in libreria apre la sua pagina, altrimenti quella da Deezer
function simHtml(sim, dz, names) {
  const have = new Set(sim.map(x => cleanTxt(x.name)));
  const extra = (dz?.similar || []).filter(x => !have.has(cleanTxt(x.name))).map(x => {
    const lid = names?.get(cleanTxt(x.name));
    return lid ? lArtistCard({ id: lid, name: x.name, artistImageUrl: x.picture })
      : `<button class="lcard round" data-act="dzartist" data-id="${esc(x.id)}"><div class="lcover">${x.picture ? `<img src="${esc(x.picture)}" alt="" loading="lazy" onerror="this.remove()">` : ic('artist')}</div><b>${esc(x.name)}</b><small>Non in libreria</small></button>`;
  });
  return sim.length || extra.length ? `<h2>Artisti simili</h2><div class="lcards shelfish">${sim.map(lArtistCard).join('')}${extra.join('')}</div>` : '';
}
// pagina di un artista che non è in libreria: solo la discografia di Deezer. Se c'è in libreria (anche dopo un download) si va alla sua pagina
async function vArtistDz(dzid) {
  const n = Scene.nav;
  if (!discoOk()) throw new Error('Questa pagina viene da Deezer: serve il permesso di download su un server Armony.');
  const [dz, names] = await Promise.all([dlApi('/api/discografia?id=' + encodeURIComponent(dzid)), libNames()]);
  if (stale(n)) return;
  const own = names.get(cleanTxt(dz.artist.name)); if (own) return location.replace('#/artista/' + encodeURIComponent(own));
  Glow.show(dz.artist.picture, 'album');
  view.innerHTML = lPhero({ kind: 'Artista', title: dz.artist.name, round: true, art: dz.artist.picture ? `<img src="${esc(dz.artist.picture)}" alt="" onerror="this.remove()">` : ic('artist'),
      meta: `Non in libreria · ${dz.albums.length} ${dz.albums.length === 1 ? 'uscita' : 'uscite'} su Deezer` }) +
    `<div id="lDisco">${discoHtml([], dz)}</div>${simHtml([], dz, names)}`;
  const check = async () => {
    if (stale(n)) return Bus.removeEventListener('libreria', check);
    const id = (await libNames()).get(cleanTxt(dz.artist.name)); if (id && !stale(n)) location.replace('#/artista/' + encodeURIComponent(id));
  };
  Bus.addEventListener('libreria', check);
}
// pagina di un album che non è in libreria: scaletta di Deezer, righe fantasma come quelle di albumGaps, "Scarica l'album"
async function vAlbumDz(dzid) {
  const n = Scene.nav;
  if (!discoOk()) throw new Error('Questa pagina viene da Deezer: serve il permesso di download su un server Armony.');
  const sc = await dlApi('/api/discografia/album/' + encodeURIComponent(dzid));
  if (stale(n)) return;
  const tot = sc.tracks.reduce((m, t) => m + (t.duration || 0), 0), discs = new Set(sc.tracks.map(t => t.disc)).size, nt = sc.tracks.length;
  Glow.show(sc.cover, 'album');
  view.innerHTML = lPhero({ kind: DZTYPE[sc.type] || 'Album', title: sc.album, art: sc.cover ? `<img src="${esc(sc.cover)}" alt="" onerror="this.remove()">` : ic('album'),
      meta: `<a href="#/artista-dz/${esc(sc.artist.id)}"><b>${esc(sc.albumartist)}</b></a>${sc.date ? ' · ' + esc(sc.date.slice(0, 4)) : ''} · ${nt} ${nt === 1 ? 'brano' : 'brani'}, ${fmtLong(tot)}${discs > 1 ? ' · ' + discs + ' dischi' : ''}` }) +
    `<div id="gapsNote"><div class="gaps-note"><span id="dzState">Non è nella tua libreria: la scaletta viene da Deezer.</span><button class="btn sm primary" id="gapsAll">${ic('down')} Scarica l'album</button></div></div>
    <div class="songs tracklist noalb"><div class="th noart" aria-hidden="true"><span class="n">#</span><span class="tt">Titolo</span><span class="d">${ic('clock')}</span><span></span></div>${sc.tracks.map((t, k) => `
    <div class="song noart ghost"><span class="n">${t.track}</span><span class="thumb"></span>
      <span class="t"><b>${esc(t.title)}</b><small>${esc(t.artists.join(', '))} · non in libreria</small></span>
      <span class="d">${fmt(t.duration)}</span><span class="acts"><button class="btn sm" data-gap="${k}">${ic('down')} Scarica</button></span></div>`).join('')}</div>`;
  gapButtons($('#view .songs'), sc.tracks, { album: sc.album, albumartist: sc.albumartist, date: sc.date, cover: sc.cover });
  // tempo reale: quando l'album entra in libreria lo si può aprire da lì
  const check = async () => {
    if (stale(n)) return Bus.removeEventListener('libreria', check);
    let r; try { r = await api('search3', { query: sc.album, albumCount: 20, artistCount: 0, songCount: 0 }); } catch { return; }
    const a = arr(r.searchResult3?.album).find(x => albKey(x.name) === albKey(sc.album) && cleanTxt(x.artist) === cleanTxt(sc.albumartist));
    if (a && !stale(n) && $('#dzState')) $('#dzState').innerHTML = `È arrivato nella tua libreria. <a href="#/album/${encodeURIComponent(a.id)}"><b>Apri l'album</b></a>`;
  };
  viewInterval(check, 20000); Bus.addEventListener('libreria', check);
}

async function vAlbum(id) {
  const n = Scene.nav;
  const a = (await api('getAlbum', { id })).album;
  if (stale(n)) return;
  const songs = arr(a.song).map(x => norm(x));
  view.dataset.album = JSON.stringify({ name: a.name, artist: a.artist, year: a.year || '', genre: a.genre || '', coverArt: a.coverArt });
  // conteggio e durata si ricalcolano quando arrivano tracce scaricate
  const info = songs => { const tot = songs.reduce((n, t) => n + t.duration, 0), discs = new Set(songs.map(s => s.disc)).size; return `${songs.length} ${songs.length === 1 ? 'brano' : 'brani'}, ${fmtLong(tot)}${discs > 1 ? ' · ' + discs + ' dischi' : ''}`; };
  const opts = { showAlbum: false, art: false, numbers: true };
  Glow.show(coverUrl(a.coverArt, 300), 'album');
  view.innerHTML = lPhero({ kind: 'Album', title: a.name, ph: a.coverArt, art: imgTag(a.coverArt, 500),
      meta: `<a href="#/artista/${encodeURIComponent(a.artistId || '')}"><b>${esc(a.artist)}</b></a>${a.year ? ' · ' + a.year : ''}${a.genre ? ' · ' + esc(a.genre) : ''} · <span id="lCount">${info(songs)}</span>` }) +
    lActionBar({ star: { act: 'staralbum', on: a.starred, data: { id, on: a.starred ? 1 : 0 } }, more: [
      { act: 'enqueueall', label: 'Aggiungi alla coda', icon: 'queue' },
      !srv().local && can('condividi') && { act: 'shareitem', label: 'Condividi un link', icon: 'share', data: { id, name: a.name } },
      Amici.on() && { act: 'sendalb', label: 'Manda a un amico', icon: 'send', data: { id, name: a.name, sub: a.artist || '' } },
      canEdit() && { act: 'editalbum', label: 'Modifica album', icon: 'pen' },
      canDelete() && { act: 'delalbum', label: 'Elimina album dal server', icon: 'trash', danger: true, data: { name: a.name } }] }) +
    `<div id="gapsNote"></div><div id="lList">${songList(songs, opts)}</div>`;
  albumGaps(a, songs, n); playCounts($('#lList'), n);
  // tempo reale: le tracce scaricate entrano nell'album appena Navidrome le vede, le grigie si ricalcolano
  let raw = a;
  lLive(n, async () => { raw = (await api('getAlbum', { id })).album; return arr(raw.song).map(x => norm(x)); }, opts,
    fresh => {
      $('#gapsNote').innerHTML = ''; albumGaps(raw, fresh, n);
      const c = $('#lCount'), el = $('#view .phero-art'); if (c) c.textContent = info(fresh);
      if (el && raw.coverArt !== a.coverArt) { a.coverArt = raw.coverArt; el.innerHTML = imgTag(raw.coverArt, 500); }  // la copertina può arrivare col brano
    });
}

// tracce dell'album che mancano in libreria (scaletta di Deezer, /api/album/scaletta): grigie, al loro posto, scaricabili
async function albumGaps(a, songs, n) {
  if (!srv()?.me?.caps?.includes('scaletta') || !access().download || !S.dl.url || !songs.length) return;
  let sc;
  try { sc = await dlApi(`/api/album/scaletta?artist=${encodeURIComponent(a.artist || '')}&album=${encodeURIComponent(a.name || '')}${a.year ? '&year=' + a.year : ''}`); } catch { return; }
  if (stale(n) || !$('#gapsNote')) return;
  const raw = arr(a.song), disc = i => raw[i]?.discNumber || 1, used = new Set(), found = new Set();
  // abbinamento: titolo e durata (±5 s), poi numero di traccia e disco per ciò che resta
  sc.tracks.forEach((t, k) => {
    const i = songs.findIndex((s, j) => !used.has(j) && cleanTxt(s.title) === cleanTxt(t.title) && (!t.duration || !s.duration || Math.abs(s.duration - t.duration) <= 5));
    if (i >= 0) { used.add(i); found.add(k); }
  });
  sc.tracks.forEach((t, k) => {
    if (found.has(k)) return;
    const i = songs.findIndex((s, j) => !used.has(j) && s.track && s.track === t.track && disc(j) === t.disc);
    if (i >= 0) { used.add(i); found.add(k); }
  });
  const miss = sc.tracks.filter((_, k) => !found.has(k)); if (!miss.length) return;
  const box = $('#view .songs'); if (!box) return;
  const pos = t => t.disc * 1000 + t.track;
  miss.forEach((t, k) => {
    const row = document.createElement('div');
    row.className = 'song noart ghost'; row.dataset.gi = k;
    row.innerHTML = `<span class="n">${t.track}</span><span class="thumb"></span>
      <span class="t"><b>${esc(t.title)}</b><small>${esc(t.artists.join(', '))} · non in libreria</small></span>
      <span class="d">${fmt(t.duration)}</span><span class="acts"><button class="btn sm" data-gap="${k}">${ic('down')} Scarica</button></span>`;
    const next = [...box.querySelectorAll('.song')].find(el => pos(el.dataset.gi != null ? miss[+el.dataset.gi] : { disc: disc(+el.dataset.i), track: songs[+el.dataset.i].track || 0 }) > pos(t));
    box.insertBefore(row, next || null);
  });
  $('#gapsNote').innerHTML = `<div class="gaps-note"><span>Questo album ha ${sc.tracks.length} tracce, in libreria ne hai ${sc.tracks.length - miss.length}.</span>
    <button class="btn sm primary" id="gapsAll">${ic('down')} Scarica le ${miss.length} mancanti</button></div>`;
  // i file arrivano con gli stessi album e artista dell'album della libreria: Navidrome li mette nello stesso album
  // la data dev'essere quella dell'album in libreria, così com'è: Navidrome separa gli album anche per data, e con
  // la data completa di Deezer su un album che ha solo l'anno (o nessuna) la traccia finirebbe in un album a parte
  const rd = a.releaseDate, p2 = n => String(n).padStart(2, '0');
  const date = rd?.year ? `${rd.year}${rd.month ? '-' + p2(rd.month) + (rd.day ? '-' + p2(rd.day) : '') : ''}` : a.year ? String(a.year) : '';
  gapButtons(box, miss, { album: a.name, albumartist: a.artist || sc.albumartist, date, cover: sc.cover });
}
// tasti "Scarica" delle righe fantasma ([data-gap] = indice in miss) e "Scarica tutte" (#gapsAll): /api/import, stessa cartella
function gapButtons(box, miss, alb) {
  // una traccia già chiesta (anche prima che la pagina si ridisegnasse) mostra la sua barra al posto del tasto
  const key = k => cleanTxt(alb.album) + '|' + cleanTxt(miss[k].title);
  const bars = () => { box.querySelectorAll('[data-gap]').forEach(b => { const id = JobBar.byKey.get(key(+b.dataset.gap)); if (id) b.outerHTML = JobBar.html(id); }); if (!box.querySelector('[data-gap]')) $('#gapsAll')?.remove(); JobBar.watch(); };
  const send = async ks => {
    const tracks = ks.map(k => { const t = miss[k]; return { title: t.title, artists: t.artists, ...alb, duration: t.duration, track: t.track, disc: t.disc, isrc: t.isrc }; });
    try {
      const r = await dlApi('/api/import', { method: 'POST', body: JSON.stringify({ tracks, folder: store.get('impDir', 'Spotify'), label: alb.album }) });
      // server vecchio: niente id dei lavori, solo l'etichetta
      if (r.jobs) { ks.forEach((k, i) => r.jobs[i] && JobBar.byKey.set(key(k), r.jobs[i])); bars(); }
      else ks.forEach(k => { const b = box.querySelector(`[data-gap="${k}"]`); if (b) b.outerHTML = '<span class="tag">in coda</span>'; });
      if (!box.querySelector('[data-gap]')) $('#gapsAll')?.remove();
      toast(r.added ? `${r.added} ${r.added === 1 ? 'traccia in coda' : 'tracce in coda'}: arrivano nell'album appena scaricate.` : 'Già in coda.');
    } catch (e) { toast(e.message); }
  };
  box.querySelectorAll('[data-gap]').forEach(b => b.onclick = e => { e.stopPropagation(); send([+b.dataset.gap]); });
  $('#gapsAll').onclick = () => send([...box.querySelectorAll('[data-gap]')].map(b => +b.dataset.gap));
  bars();
}
// download avviati da una pagina (tracce mancanti di un album, risultati della ricerca): una barretta con l'avanzamento
// del lavoro (/api/jobs?ids=) al posto del tasto, finché il brano non entra in libreria. Si chiede solo mentre ci sono
// barre in corso sullo schermo e la pagina è in primo piano
const JobBar = {
  st: new Map(), byKey: new Map(), done: new Map(), t: null,
  html(id) { return `<span class="jbar" data-job="${esc(id)}" role="status">${this.inner(this.st.get(id))}</span>`; },
  inner(j) {
    const s = j?.status || 'in coda', p = j?.inlib || s.startsWith('completato') ? 100 : s === 'in corso' ? j.progress || 0 : s === 'conversione' ? 100 : 0;
    const t = j?.inlib ? 'in libreria' : s.startsWith('completato') ? 'in arrivo' : s === 'errore' ? 'non trovato' : s === 'in corso' ? Math.floor(p) + '%' : s === 'metadati' ? 'cerco' : s === 'conversione' ? 'converto' : 'in coda';
    return `<span class="jbar-t"><i style="width:${p}%"></i></span><em>${t}</em>`;
  },
  open(j) { return !j || (!j.inlib && j.status !== 'errore' && !(j.status.startsWith('completato') && Date.now() - (this.done.get(j.id) || Date.now()) > 300000)); },
  paint() {
    $$('[data-job]').forEach(el => {
      const j = this.st.get(el.dataset.job); if (!j) return;
      el.innerHTML = this.inner(j); el.classList.toggle('ok', !!j.inlib); el.classList.toggle('err', j.status === 'errore');
      el.title = j.status === 'errore' ? j.error || '' : '';
    });
  },
  watch() { if (!this.t && !document.hidden) this.t = setTimeout(() => this.tick(), 1500); },
  async tick() {
    this.t = null;
    const ids = [...new Set([...$$('[data-job]')].map(e => e.dataset.job))].filter(id => this.open(this.st.get(id)));
    if (!ids.length || document.hidden || !S.dl.url) return;
    let came = false;
    try {
      for (const j of await dlApi('/api/jobs?ids=' + ids.join(','))) {
        if (j.inlib && !this.st.get(j.id)?.inlib) came = true;
        if (j.status.startsWith('completato') && !this.done.has(j.id)) this.done.set(j.id, Date.now());
        this.st.set(j.id, j);
      }
    } catch {}
    this.paint();
    if (came && !Live.es) emitSoon('libreria');  // senza il canale dal vivo l'avviso lo dà l'avanzamento
    this.watch();
  }
};
document.addEventListener('visibilitychange', () => JobBar.watch());
async function vGenre(name) {
  const n = Scene.nav;
  const [songs, albums] = await Promise.all([
    api('getSongsByGenre', { genre: name, count: 200 }),
    api('getAlbumList2', { type: 'byGenre', genre: name, size: 30 }).catch(() => null)
  ]);
  if (stale(n)) return;
  const so = arr(songs.songsByGenre.song).map(x => norm(x)), al = arr(albums?.albumList2?.album);
  view.innerHTML = lPhero({ kind: 'Genere', title: name, tile: tileColor(name), art: `<b>${esc(name)}</b>`, meta: `${so.length} brani${al.length ? ' · ' + al.length + ' album' : ''}` }) +
    lActionBar({ more: [{ act: 'enqueueall', label: 'Aggiungi alla coda', icon: 'queue' }] }) +
    (al.length ? `<h2>Album</h2>${albumGrid(al, { strip: true })}` : '') + `<h2>Brani</h2>${songList(so)}`;
}

async function vDecade(y) {
  y = +y;
  const n = Scene.nav;
  const al = arr((await api('getAlbumList2', { type: 'byYear', fromYear: y, toYear: y + 9, size: 120 })).albumList2.album);
  if (stale(n)) return;
  const label = `Anni ${String(y).slice(2)}`;
  view.innerHTML = lPhero({ kind: 'Decennio', title: label, tile: tileColor(label), art: `<b>${String(y).slice(2)}</b>`, meta: `${al.length} album dal ${y} al ${y + 9}` }) +
    lActionBar({ play: { act: 'decademix', data: { y }, label: 'Mix del decennio' }, shuffle: null, offline: false, addpl: false }) +
    `<h2>Album</h2>${albumGrid(al)}`;
}
// ricerche recenti (solo su questo dispositivo): si salvano quando si apre o si ascolta un risultato
const recentQ = {
  get: () => store.get('searches', []),
  add(q) { q = q.trim(); if (q.length < 2) return; store.set('searches', [q, ...this.get().filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 12)); },
  del(q) { store.set('searches', this.get().filter(x => x !== q)); }
};
let searchFocus = false;  // la lente in alto (telefono): Cerca si apre con il campo già pronto
async function vSearch() {
  if (!srv()) return noServer();
  const n = Scene.nav;
  view.innerHTML = `<h1 class="hhello">Cerca</h1>
    <label class="hsearch">${ic('search')}<input type="search" id="q" placeholder="Cosa vuoi ascoltare?" aria-label="Cerca brani, artisti, album" enterkeyhint="search" autocomplete="off"></label>
    <div id="res"></div>`;
  let t;
  const q = $('#q'); q.value = sessionStorage.getItem('armony:q') || '';
  if (searchFocus || (!NATIVE && matchMedia('(pointer:fine)').matches)) q.focus();
  searchFocus = false;
  const L1 = r => arr(r?.albumList2?.album)[0];
  const tile = (label, attrs, k) => `<a class="htile" ${attrs} data-k="${esc(k)}" style="--th:${tileColor(label)}" ${attrs.startsWith('href') ? '' : 'role="link" tabindex="0"'}><b>${esc(label)}</b><span class="ht-art"></span></a>`;
  // aprire o ascoltare un risultato salva la ricerca fra le recenti
  $('#res').addEventListener('click', e => {
    if (q.value.trim().length >= 2 && e.target.closest('[data-act="album"],[data-act="artist"],[data-act="play"],[data-act="playalb"],[data-act="artistall"]')) recentQ.add(q.value);
  }, true);
  const browse = async () => {
    const rq = recentQ.get();
    const fixed = [['Aggiunti di recente', 'newest', 'newest'], ['Più ascoltati', 'frequent', 'frequent'], ['Preferiti', 'starred', null], ['A caso', 'random', 'random']];
    $('#res').innerHTML = `${rq.length ? `<div class="hsec"><h2>Ricerche recenti</h2></div><div class="hrecent">${rq.map(x => `<span class="hrq"><button class="hrq-t" data-q="${esc(x)}">${ic('search')}<span>${esc(x)}</span></button><button class="hrq-x" data-rm="${esc(x)}" aria-label="Togli ${esc(x)} dalle ricerche recenti">${ic('close')}</button></span>`).join('')}</div>` : ''}
      <div class="hsec"><h2>Sfoglia tutto</h2></div><div class="htiles" id="tiles">${fixed.map(([l, k, sort]) => tile(l, sort ? `data-act="showall" data-sort="${sort}"` : 'href="#/preferiti"', k)).join('')}</div>`;
    $('#res').querySelectorAll('[data-q]').forEach(b => b.onclick = () => { q.value = b.dataset.q; run(); });
    $('#res').querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { recentQ.del(b.dataset.rm); browse(); });
    // copertine dei riquadri fissi, poi generi e decenni con almeno un album
    const cover = (k, al) => { const el = [...$$('#tiles .htile')].find(x => x.dataset.k === k)?.querySelector('.ht-art'); if (el && al?.coverArt) el.innerHTML = imgTag(al.coverArt, 200); };
    fixed.forEach(([, k]) => api('getAlbumList2', { type: k, size: 1 }).then(r => cover(k, L1(r))).catch(() => {}));
    const [gs, ...decs] = await Promise.all([api('getGenres').catch(() => null),
      ...[1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020].map(y => api('getAlbumList2', { type: 'byYear', fromYear: y, toYear: y + 9, size: 1 }).then(r => [y, L1(r)]).catch(() => [y, null]))]);
    if (stale(n) || q.value.trim().length >= 2 || !$('#tiles')) return;
    const genres = arr(gs?.genres?.genre).filter(g => g.albumCount).sort((a, b) => b.songCount - a.songCount).slice(0, 16);
    $('#tiles').insertAdjacentHTML('beforeend', genres.map(g => tile(g.value, `href="#/genere/${encodeURIComponent(g.value)}"`, 'g:' + g.value)).join('')
      + decs.filter(([, a]) => a).map(([y]) => tile(`Anni ${String(y).slice(2)}`, `href="#/decennio/${y}"`, 'd:' + y)).join(''));
    decs.forEach(([y, a]) => cover('d:' + y, a));
    genres.forEach(g => api('getAlbumList2', { type: 'byGenre', genre: g.value, size: 1 }).then(r => cover('g:' + g.value, L1(r))).catch(() => {}));
  };
  const run = async () => {
    const v = q.value.trim(); sessionStorage.setItem('armony:q', v);
    if (v.length < 2) return browse();
    try {
      if (!$('#res .hres')) $('#res').innerHTML = `<div class="sk-page" style="margin-top:18px">${SK.row.repeat(6)}</div>`;
      const r = (await api('search3', { query: v, songCount: 60, albumCount: 18, artistCount: 12 })).searchResult3;
      if (q.value.trim() !== v || stale(n)) return;  // nel frattempo si è scritto altro o cambiato pagina
      const ar = arr(r.artist), al = arr(r.album), so = arr(r.song).map(x => norm(x)), V = cleanTxt(v);
      if (!ar.length && !al.length && !so.length) {
        $('#res').innerHTML = `<div class="empty hres"><h3>Nessun risultato per "${esc(v)}"</h3><p>Controlla come l'hai scritto, oppure cercalo online e scaricalo.</p>
          <a class="btn primary" href="#/scarica/cerca/${encodeURIComponent(v)}">${ic('down')} Cerca "${esc(v)}" online</a></div><div id="catRes"></div><div id="netRes"></div>`;
        catSearch(v, n, q); return netSearch(v, n, q);
      }
      // risultato migliore: l'artista se il nome coincide con la ricerca, altrimenti il primo album, altrimenti il primo brano
      const bestA = ar.find(a => cleanTxt(a.name) === V) || (ar[0] && cleanTxt(ar[0].name).startsWith(V) ? ar[0] : null);
      const best = bestA ? { kind: 'Artista', name: bestA.name, img: imgTag(bestA.coverArt, 200), round: true, open: `data-act="artist" data-id="${esc(bestA.id)}"`, play: `data-act="artistall" data-id="${esc(bestA.id)}"` }
        : al[0] ? { kind: 'Album', name: al[0].name, sub: al[0].artist, img: imgTag(al[0].coverArt, 200), open: `data-act="album" data-id="${esc(al[0].id)}"`, play: `data-act="playalb" data-id="${esc(al[0].id)}"` }
        : { kind: 'Brano', name: so[0].title, sub: so[0].artist, img: imgTag(so[0].coverArt, 200, so[0].serverId), open: 'data-act="play" data-i="0"', play: 'data-act="play" data-i="0"' };
      const top = so.slice(0, 4);
      $('#res').innerHTML = `<div class="hres"><div class="hbest-wrap">
        <section><div class="hsec"><h2>Risultato migliore</h2></div>
          <div class="hbest" ${best.open} role="link" tabindex="0"><span class="hbest-art ${best.round ? 'round' : ''}">${best.img}</span>
            <b>${esc(best.name)}</b><span class="hbest-meta">${best.sub ? `${esc(best.sub)} · ` : ''}<span class="hbest-kind">${best.kind}</span></span>
            <button class="hbest-play" ${best.play} aria-label="Riproduci ${esc(best.name)}">${ic('play', true)}</button></div></section>
        ${top.length ? `<section class="hbest-songs"><div class="hsec"><h2>Brani</h2>${so.length > 4 ? `<button class="hsec-more" id="allSongs">Mostra tutti (${so.length})</button>` : ''}</div><div id="songsBox">${songList(top)}</div></section>` : ''}
        </div>
        ${ar.length ? `<div class="hsec"><h2>Artisti</h2></div><div class="hgrid shelf">${ar.map(lArtistCard).join('')}</div>` : ''}
        ${al.length ? `<div class="hsec"><h2>Album</h2></div>${albumGrid(al, { strip: true })}` : ''}<div id="plRes"></div><div id="catRes"></div><div id="netRes"></div></div>`;
      plSearch(V, n, q, v); catSearch(v, n, q); netSearch(v, n, q);
      $('#allSongs')?.addEventListener('click', e => { $('#songsBox').innerHTML = listActions() + songList(so); e.target.remove(); $('#res .hbest-wrap').classList.add('open'); });
    } catch (e) { $('#res').innerHTML = `<p class="sub">${esc(e.message)}</p>`; }
  };
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 260); });
  q.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(t); run(); } });
  run();
}
// le playlist (tue, collaborative e pubbliche) col nome che contiene la ricerca, come su Spotify
async function plSearch(V, n, q, v) {
  let pls; try { pls = arr((await api('getPlaylists')).playlists.playlist); } catch { return; }
  const box = $('#plRes'); if (!box || q.value.trim() !== v || stale(n)) return;
  const hit = pls.filter(p => cleanTxt(p.name).includes(V)).slice(0, 12);
  if (hit.length) box.innerHTML = `<div class="hsec"><h2>Playlist</h2></div><div class="lcards shelf">${hit.map(lPlCard).join('')}</div>`;
}
/* ---- fuori dalla libreria (capacità "catalogo", /api/catalogo): brani e album di Deezer, anteprima e "Scarica" ---- */
async function catSearch(v, n, q) {
  if (!dlSrv()?.me?.caps?.includes('catalogo') || !access().download) return;
  let r; try { r = await dlApi('/api/catalogo?q=' + encodeURIComponent(v)); } catch { return; }
  const box = $('#catRes'); if (!box || q.value.trim() !== v || stale(n)) return;
  const tr = r.tracks.filter(t => !t.inlib).slice(0, 8), al = r.albums.slice(0, 10);
  if (!tr.length && !al.length) return;
  box.innerHTML = `${tr.length ? `<div class="hsec"><h2>Non in libreria</h2></div><div class="catlist">${tr.map((t, i) => `<div class="catrow">
      <span class="catart">${t.cover ? `<img src="${esc(t.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ''}${t.preview ? `<button class="catprev" data-cp="${i}" aria-label="Ascolta 30 secondi di ${esc(t.title)}">${ic('play', true)}</button>` : ''}</span>
      <span class="grow"><b>${esc(t.title)}</b><small>${esc(t.artists.join(', '))}${t.album ? ' · ' + esc(t.album) : ''}${t.duration ? ' · ' + fmt(t.duration) : ''}</small></span>
      <button class="btn sm" data-cd="${i}">${ic('down')}<span>Scarica</span></button></div>`).join('')}</div>` : ''}
    ${al.length ? `<div class="hsec"><h2>Album da scaricare</h2></div><div class="cards shelf">${al.map(a => discoCard({ type: a.type, x: { id: a.dz, cover: a.cover, title: a.title } }).replace('</small></div>', ` · ${esc(a.artist)}</small></div>`)).join('')}</div>` : ''}`;
  box.querySelectorAll('[data-cp]').forEach(b => b.onclick = () => Preview.toggle(tr[+b.dataset.cp].preview, b));
  box.querySelectorAll('[data-cd]').forEach(b => b.onclick = async () => {
    const t = tr[+b.dataset.cd]; b.disabled = true;
    try {
      const r = await dlApi('/api/import', { method: 'POST', body: JSON.stringify({ tracks: [{ title: t.title, artists: t.artists, album: t.album, duration: t.duration, cover: t.cover }], folder: store.get('impDir', 'Spotify'), label: t.title }) });
      if (r.jobs?.[0]) { b.outerHTML = JobBar.html(r.jobs[0]); JobBar.watch(); } else b.outerHTML = '<span class="tag">in coda</span>';
      toast('In arrivo: lo trovi in libreria appena scaricato.');
    } catch (e) { b.disabled = false; toast(e.message); }
  });
}
// anteprime di 30 secondi: un elemento audio a parte; la musica in corso si mette in pausa e riparte alla fine
const Preview = {
  a: null, btn: null, resume: false,
  toggle(url, btn) {
    if (this.btn === btn && this.a && !this.a.paused) return this.stop();
    this.stop();
    this.a = new Audio(url); this.btn = btn; this.resume = !Engine.el.paused && !Live.remote();
    if (this.resume) Engine.el.pause();
    btn.innerHTML = ic('pause', true); btn.classList.add('on');
    this.a.onended = () => this.stop(); this.a.play().catch(() => this.stop());
  },
  stop() {
    if (this.a) { this.a.pause(); this.a = null; }
    if (this.btn) { this.btn.innerHTML = ic('play', true); this.btn.classList.remove('on'); this.btn = null; }
    if (this.resume) { this.resume = false; Engine.el.play().catch(() => {}); }
  }
};
Bus.addEventListener('route', () => Preview.stop());
/* ---- rete: le librerie dei server collegati, e degli amici degli amici (server/federazione.py) ---- */
// con "Questo telefono" in uso la rete passa dal server di backup (dlSrv), come i download
const netOk = () => !!(dlSrv()?.session && dlSrv().me?.caps?.includes('federazione')) && can('rete');
// un brano di un altro server come brano della coda: suona e si copia tramite il mio server (streamUrl, coverUrl)
function netTrack(x, nodes) {
  const own = x.path[x.path.length - 1], o = nodes[own] || {};
  return { id: 'rete:' + own + ':' + x.id, title: x.title || 'Senza titolo', artist: x.artist || 'Artista sconosciuto', album: x.album || '',
    duration: x.duration || 0, track: x.track, year: x.year, genre: x.genre, suffix: x.suffix, serverId: dlSrv()?.id,
    coverArt: x.cover ? `rete|${x.path.join(',')}|${x.id}` : undefined,
    fed: { id: x.id, r: x.path.join(','), node: o.name || 'Server', owner: o.owner || '', via: x.path.slice(0, -1).map(p => nodes[p]?.name || '…'), off: !!x.offline } };
}
// "su Casa di Marco · via Lucia": di chi è il brano e da chi passa
const netSrc = f => `su ${esc(f.node)}${f.owner ? ` di ${esc(f.owner)}` : ''}${f.via.length ? ` · via ${f.via.map(esc).join(', ')}` : ''}${f.off ? ' · ora non raggiungibile' : ''}`;
async function netCopy(tracks) {
  if (!access().download) return toast('La copia nella tua libreria richiede il permesso di download.');
  let ok = 0;
  for (const t of tracks) { try { await dlApi('/api/rete/copia', { method: 'POST', body: JSON.stringify({ id: t.fed.id, r: t.fed.r, title: `${t.artist} - ${t.title}` }) }); ok++; } catch (e) { toast(e.message); } }
  if (ok) toast(ok === 1 ? 'In copia: arriva nella tua libreria fra poco (Scarica → coda).' : `${ok} brani in copia: arrivano nella tua libreria fra poco.`);
}
async function netSearch(v, n, q) {
  const box = $('#netRes'); if (!box || !netOk()) return;
  box.innerHTML = `<div class="hsec"><h2>Nella rete</h2></div><p class="sub">Cerco nelle librerie collegate…</p>`;
  let r; try { r = await dlApi('/api/rete/cerca?q=' + encodeURIComponent(v)); } catch { box.innerHTML = ''; return; }
  if (q.value.trim() !== v || stale(n) || !box.isConnected) return;
  const libs = Object.keys(r.nodes).length;
  const songs = r.songs.map(x => netTrack(x, r.nodes)), albums = r.albums.map(a => ({ ...a, tr: a.tracks.map(x => netTrack({ ...x, path: a.path, offline: a.offline }, r.nodes)) }));
  if (!songs.length && !albums.length) { box.innerHTML = libs ? `<div class="hsec"><h2>Nella rete</h2></div><p class="sub">Niente ${libs === 1 ? 'nella libreria collegata' : `nelle ${libs} librerie collegate`}.</p>` : ''; return; }
  const row = (t, i) => `<div class="song" data-net="${i}" role="button" tabindex="0"><span class="n">${i + 1}</span><span class="thumb">${imgTag(t.coverArt, 84, t.serverId)}</span>
    <span class="t"><b>${esc(t.title)}</b><small>${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</small><small class="netsrc">${ic('globe')}${netSrc(t.fed)}</small></span>
    <span class="d">${fmt(t.duration)}</span><span class="acts"><button class="icon-btn" data-netcopy="${i}" aria-label="Copia nella mia libreria" title="Copia nella mia libreria">${ic('down')}</button>
    <button class="icon-btn" data-netmore="${i}" aria-label="Altre azioni">${ic('more')}</button></span></div>`;
  box.innerHTML = `<div class="hsec"><h2>Nella rete</h2><small class="netms">${libs} ${libs === 1 ? 'libreria' : 'librerie'}</small></div>
    ${albums.map((a, k) => `<div class="list-item netalb"><span class="pic">${imgTag(a.tr[0]?.coverArt, 100, S.active)}</span>
      <span class="grow"><b>${esc(a.album)}</b><small>${esc(a.albumArtist)} · ${a.tr.length} ${a.tr.length === 1 ? 'brano' : 'brani'}</small><small class="netsrc">${ic('globe')}${netSrc(a.tr[0].fed)}</small></span>
      <button class="icon-btn" data-albplay="${k}" aria-label="Ascolta ${esc(a.album)}">${ic('play')}</button><button class="btn sm" data-albcopy="${k}">${ic('down')} Copia</button></div>`).join('')}
    ${songs.length ? `<div class="songs tracklist noalb netsongs">${songs.map(row).join('')}</div>` : ''}`;
  box.onclick = e => {
    const b = e.target.closest('[data-netcopy],[data-netmore],[data-albplay],[data-albcopy],[data-net]'); if (!b) return;
    e.stopPropagation(); if (q.value.trim().length >= 2) recentQ.add(q.value);
    const d = b.dataset;
    if (d.netcopy) netCopy([songs[+d.netcopy]]);
    else if (d.netmore) songMenu(songs[+d.netmore]);
    else if (d.albplay) setQueue(albums[+d.albplay].tr, 0);
    else if (d.albcopy) netCopy(albums[+d.albcopy].tr);
    else setQueue(songs, +d.net);
  };
}
// la mappa: io, i server collegati e, sotto ciascuno, quelli che si vedono passando da lui
async function vRete() {
  if (!srv()) return noServer();
  const n = Scene.nav;
  view.innerHTML = `<h1>Rete</h1><p class="sub">Le librerie collegate a questo server e quelle degli amici degli amici. Da Cerca trovi i loro brani sotto "Nella rete": li ascolti subito e li copi nella tua libreria.</p><div id="netMap"><div class="sk-page">${SK.row.repeat(3)}</div></div>`;
  if (!netOk()) { $('#netMap').innerHTML = '<div class="empty"><h3>Rete non disponibile</h3><p>Questo server non ha ancora le librerie collegate: serve una versione più nuova di Armony.</p></div>'; return; }
  const m = await dlApi('/api/rete/mappa');
  if (stale(n)) return;
  const num = x => `${x.songs || 0} ${x.songs === 1 ? 'brano' : 'brani'} · ${x.albums || 0} album`;
  const dot = x => `<span class="netdot${x.online === false ? ' off' : ''}" role="img" aria-label="${x.online === false ? 'non raggiungibile' : 'in linea'}"></span>`;
  const name = id => m.nodes.find(x => x.id === id)?.name || m.far.find(x => x.id === id)?.name || '…';
  const nodeHtml = (x, via) => `<li><div class="netnode"><span class="netav" style="--th:${tileColor(x.name || '?')}">${esc((x.name || '?').trim().charAt(0).toUpperCase())}</span>
      <span class="grow"><b>${esc(x.name)}${x.owner ? ` <small>di ${esc(x.owner)}</small>` : ''}</b><small>${num(x)}${via ? ` · via ${esc(via)}` : ''}${x.reach === 'canale' ? ' · tramite canale' : x.reach === 'uscita' ? ' · in uscita' : ''}</small></span>${!via && x.state === 'attivo' && access().download && dlSrv()?.me?.caps?.includes('abbonamenti') ? `<button class="btn sm" data-netpl="${esc(x.id)}" data-name="${esc(x.name)}">${ic('list')} Playlist</button>` : ''}${dot(x)}</div>${sub(x.path || [x.id])}</li>`;
  const sub = path => { const k = m.far.filter(x => x.path.length === path.length + 1 && path.every((p, i) => x.path[i] === p)); return k.length ? `<ul>${k.map(x => nodeHtml(x, x.path.slice(0, -1).map(name).join(', '))).join('')}</ul>` : ''; };
  const tot = [m.me, ...m.nodes, ...m.far].reduce((a, x) => a + (x.songs || 0), 0);
  $('#netMap').innerHTML = `<ul class="nettree"><li><div class="netnode me"><span class="netav">${ic('home')}</span>
      <span class="grow"><b>${esc(m.me.name)}${m.me.owner ? ` <small>di ${esc(m.me.owner)}</small>` : ''}</b><small>Questo server · ${num(m.me)}</small></span></div>
    ${m.nodes.length ? `<ul>${m.nodes.map(x => nodeHtml(x)).join('')}</ul>` : ''}</li></ul>
    ${m.nodes.length ? `<p class="small" style="color:var(--muted);margin-top:var(--s4)">${m.nodes.length + m.far.length + 1} librerie, ${tot} brani in tutto. Si vedono fino a ${m.hops} ${m.hops === 1 ? 'passaggio' : 'passaggi'} di distanza; gli amici degli amici compaiono solo se il loro server lo permette.</p>`
      : `<div class="empty" style="margin-top:var(--s4)"><h3>Nessun server collegato</h3><p>${access().admin ? 'Collega la libreria di un amico in Impostazioni → Librerie collegate.' : 'L\'amministratore di questo server può collegarlo alle librerie degli amici.'}</p>${access().admin ? '<a class="btn primary" href="#/impostazioni">Impostazioni</a>' : ''}</div>`}`;
  $('#netMap').onclick = e => { const b = e.target.closest('[data-netpl]'); if (b) netPlaylists(b.dataset.netpl, b.dataset.name); };
}
// le playlist pubbliche di un server collegato: abbonandosi, una playlist qui resta uguale alla sua (i brani si copiano)
async function netPlaylists(nid, name) {
  const d = $('#dlg'); d.className = 'sheet';
  d.innerHTML = `<div class="head"><span style="min-width:0"><b style="display:block">Playlist di ${esc(name)}</b><small style="color:var(--muted)">Solo quelle pubbliche. Abbonandoti ne hai una copia tua: i brani si copiano qui e resta uguale all'originale.</small></span></div><div id="npl"><p class="sub" style="padding:0 14px">Chiedo…</p></div>`;
  closeOutside(d); d.showModal();
  const paint = async () => {
    let r; try { r = await dlApi('/api/rete/playlist?node=' + encodeURIComponent(nid)); } catch (e) { $('#npl').innerHTML = `<p class="sub" style="padding:0 14px">${esc(e.message)}</p>`; return; }
    if (!$('#npl')) return;
    $('#npl').innerHTML = r.playlists.length ? r.playlists.map((p, i) => `<div class="mi" style="cursor:default">${ic('list')}<span class="grow"><b>${esc(p.name)}</b><small style="color:var(--muted)">${p.songs} ${p.songs === 1 ? 'brano' : 'brani'}</small></span>
      ${p.sub ? `<button class="btn sm" data-unsub="${esc(p.sub)}">${ic('check')} Abbonato</button>` : `<button class="btn sm primary" data-sub="${i}">Abbonati</button>`}</div>`).join('')
      : '<p class="sub" style="padding:0 14px">Nessuna playlist pubblica su questo server.</p>';
    $('#npl').querySelectorAll('[data-sub]').forEach(b => b.onclick = async () => {
      const p = r.playlists[+b.dataset.sub]; b.disabled = true;
      try {
        const title = `${p.name} · ${name}`, pid = await createPlaylist(title, []);
        await dlApi('/api/rete/abbonati', { method: 'POST', body: JSON.stringify({ node: nid, id: p.id, pid, name: title }) });
        emit('playlists'); toast(`Abbonato a «${p.name}»: i brani si copiano qui e la playlist «${title}» resta uguale all'originale.`, 5000); paint();
      } catch (e) { b.disabled = false; toast(e.message); }
    });
    $('#npl').querySelectorAll('[data-unsub]').forEach(b => b.onclick = async () => {
      if (!confirm('Smettere di seguire questa playlist? La tua copia e i brani già copiati restano.')) return;
      try { await dlApi('/api/rete/abbonati/' + encodeURIComponent(b.dataset.unsub), { method: 'DELETE' }); toast('Abbonamento tolto.'); paint(); } catch (e) { toast(e.message); }
    });
  };
  paint();
}
async function vPlaylists() {
  if (!srv()) return noServer();
  const n = Scene.nav;
  view.innerHTML = `<h1>Playlist</h1><p class="sub">${srv().local ? 'Restano su questo telefono; con la copia sul server attiva finiscono anche lì.' : 'Le tue playlist e, se puoi vederle, quelle condivise degli altri.'}</p><div id="plBox"></div>`;
  await playlistsInto($('#plBox'), n);
  // tempo reale: conteggi e copertine cambiano quando una playlist si riempie (anche dal server, dopo i download)
  const again = () => { Bus.removeEventListener('playlists', again); if (!stale(n)) vPlaylists(); };
  Bus.addEventListener('playlists', again);
}
// le playlist come in "La tua libreria" di Spotify: Preferiti fissato in cima, cerca, ordina (recenti, alfabetico, creatore)
// riordinare una playlist trascinando (dito o mouse) la maniglia di ogni brano, o con le frecce dalla tastiera;
// "Fatto" la riscrive sul server (POST /api/playlist/ordina, capacità "plordina")
async function reorderPl(id) {
  const p = (await api('getPlaylist', { id })).playlist, l = arr(p.entry).map(x => norm(x));
  if (l.length < 2) return toast('Non c\'è niente da riordinare.');
  const d = $('#dlg'); d.className = 'sheet reord';
  d.innerHTML = `<div class="head"><span class="grow"><b style="display:block">Riordina «${esc(p.name)}»</b><small style="color:var(--muted)">Trascina la maniglia a destra di un brano</small></span><button class="btn sm primary" id="roOk">Fatto</button></div>
    <div class="rolist" id="roList">${l.map((t, i) => `<div class="rorow" data-i="${i}"><span class="pic">${imgTag(t.coverArt, 84, t.serverId)}</span><span class="grow"><b>${esc(t.title)}</b><small>${esc(t.artist)}</small></span><button class="icon-btn rohandle" aria-label="Sposta ${esc(t.title)} (frecce su e giù)">${ic('grip')}</button></div>`).join('')}</div>`;
  const list = $('#roList');
  let row = null, y0 = 0, scroller = null;
  list.addEventListener('pointerdown', e => {
    const h = e.target.closest('.rohandle'); if (!h) return;
    e.preventDefault(); row = h.closest('.rorow'); y0 = e.clientY; row.classList.add('drag'); h.setPointerCapture(e.pointerId);
  });
  list.addEventListener('pointermove', e => {
    if (!row) return;
    const half = row.offsetHeight / 2;
    let dy = e.clientY - y0;
    for (let n = row.nextElementSibling; n && dy > half; n = row.nextElementSibling) { list.insertBefore(n, row); y0 += n.offsetHeight; dy = e.clientY - y0; }
    for (let n = row.previousElementSibling; n && dy < -half; n = row.previousElementSibling) { list.insertBefore(row, n); y0 -= n.offsetHeight; dy = e.clientY - y0; }
    row.style.transform = `translateY(${dy}px)`;
    // vicino ai bordi la lista scorre da sola
    const r = list.getBoundingClientRect(); clearInterval(scroller);
    const v = e.clientY < r.top + 50 ? -10 : e.clientY > r.bottom - 50 ? 10 : 0;
    if (v) scroller = setInterval(() => { const before = list.scrollTop; list.scrollTop += v; y0 -= list.scrollTop - before; }, 16);  // solo quanto ha scorso davvero
  });
  const end = () => { if (!row) return; clearInterval(scroller); row.style.transform = ''; row.classList.remove('drag'); row = null; };
  list.addEventListener('pointerup', end); list.addEventListener('pointercancel', end);
  list.addEventListener('keydown', e => {
    const h = e.target.closest('.rohandle'); if (!h || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault(); const r = h.closest('.rorow');
    if (e.key === 'ArrowUp' && r.previousElementSibling) list.insertBefore(r, r.previousElementSibling);
    if (e.key === 'ArrowDown' && r.nextElementSibling) list.insertBefore(r.nextElementSibling, r);
    h.focus();
  });
  $('#roOk').onclick = async () => {
    const ids = [...list.children].map(r => l[+r.dataset.i].id);
    if (ids.join() === l.map(t => t.id).join()) return d.close();
    $('#roOk').disabled = true;
    try { await srvApi(srv(), '/api/playlist/ordina', { method: 'POST', body: JSON.stringify({ pid: id, ids }) }); d.close(); toast('Nuovo ordine salvato.'); route(); }
    catch (e) { $('#roOk').disabled = false; toast(/409/.test(e.message) ? 'La playlist è cambiata nel frattempo: riapri «Riordina».' : e.message); }
  };
  d.onclose = () => { clearInterval(scroller); d.className = ''; d.onclose = null; };
  d.showModal();
}
// "+" della Libreria, come Spotify: crea una playlist o importala
function libPlus() {
  const d = $('#dlg'); d.className = 'sheet';
  d.innerHTML = `<button class="mi" id="lpNew">${ic('list')}<span class="grow">Playlist<small>Crea una playlist vuota</small></span></button>
    <button class="mi" id="lpDir">${ic('folder')}<span class="grow">Cartella<small>Per raggruppare le playlist</small></span></button>
    <button class="mi" id="lpImp">${ic('down')}<span class="grow">Importa<small>Da Spotify (CSV di Exportify), M3U o JSON</small></span></button>`;
  $('#lpDir').onclick = () => { d.close(); PlDir.create(); };
  $('#lpNew').onclick = async () => { d.close(); const name = await ask('Nuova playlist', '', 'Nome'); if (name) { await api('createPlaylist', { name }); route(); } };
  $('#lpImp').onclick = () => { d.close(); importPlaylist(); };
  closeOutside(d); d.showModal();
}
// cartelle di playlist, come Spotify: solo un raggruppamento nelle preferenze (P.plDir, le stesse su tutti i tuoi
// dispositivi). Navidrome non le conosce: per le altre app le playlist restano tutte allo stesso livello
const PlDir = {
  all() { return Array.isArray(P.plDir) ? P.plDir : []; },
  save(l) { P.plDir = l; savePrefs(); emit('playlists'); },
  of(id) { return this.all().find(d => d.ids.includes(id)); },
  async create(first) {
    const n = (await ask('Nuova cartella', '', 'Nome'))?.trim().slice(0, 80); if (!n) return;
    if (this.all().some(d => d.n === n)) return toast('C\'è già una cartella con questo nome.');
    this.save([...this.all().map(d => ({ ...d, ids: d.ids.filter(x => x !== first) })), { n, ids: first ? [first] : [] }]);
    toast(first ? `Spostata in «${n}».` : `Cartella «${n}» creata: sposta le playlist dal loro menu.`);
  },
  move(id, n) { this.save(this.all().map(d => ({ ...d, ids: d.n === n ? [...d.ids.filter(x => x !== id), id] : d.ids.filter(x => x !== id) }))); if (n) toast(`Spostata in «${n}».`); },
  pick(id, at) {
    const cur = this.of(id)?.n;
    ctxMenuOrPick(at, [...this.all().map(d => [d.n === cur ? 'check' : 'folder', d.n, () => this.move(id, d.n)]), ['plus', 'Nuova cartella…', () => this.create(id)],
      cur ? ['close', 'Fuori dalle cartelle', () => this.move(id, null)] : null].filter(Boolean), 'Sposta in una cartella');
  },
  async rename(n) {
    const m = (await ask('Rinomina la cartella', n, 'Nome'))?.trim().slice(0, 80); if (!m || m === n) return m || n;
    if (this.all().some(d => d.n === m)) { toast('C\'è già una cartella con questo nome.'); return n; }
    if (sessionStorage.getItem('armony:pldir') === n) sessionStorage.setItem('armony:pldir', m);  // la pagina si ridisegna nella cartella rinominata
    this.save(this.all().map(d => d.n === n ? { ...d, n: m } : d)); return m;
  },
  remove(n) { this.save(this.all().filter(d => d.n !== n)); toast('Cartella tolta: le playlist restano.'); }
};
async function playlistsInto(box, n) {
  const [pr, st] = await Promise.all([api('getPlaylists'), api('getStarred2').catch(() => null)]);
  if (stale(n) || !box.isConnected) return;
  const pls = arr(pr.playlists.playlist), favs = arr(st?.starred2?.song).length, o = { by: 'recent', ...store.get('plOrd', {}) }, me = srv().user;
  const sortL = [['recent', 'Recenti'], ['alpha', 'Alfabetico'], ['owner', 'Creatore']];
  // elenco (come Spotify sul telefono) o griglia di copertine; si ricorda su questo dispositivo
  let mode = store.get('plView', matchMedia('(max-width:860px)').matches ? 'list' : 'grid'), dir = sessionStorage.getItem('armony:pldir');  // resta aperta quando la pagina si ridisegna
  const paint = q => {
    const Q = cleanTxt(q || ''), cmp = (a, b) => String(a || '').localeCompare(String(b || ''), 'it', { sensitivity: 'base' });
    const ids = new Set(pls.map(p => p.id)), dirs = PlDir.all().map(d => ({ ...d, ids: d.ids.filter(x => ids.has(x)) })), inDir = new Set(dirs.flatMap(d => d.ids));
    const open = !Q && dir != null ? dirs.find(d => d.n === dir) : null; if (!open && !Q) dir = null;
    if (dir == null) sessionStorage.removeItem('armony:pldir'); else sessionStorage.setItem('armony:pldir', dir);
    const l = pls.filter(p => Q ? cleanTxt(`${p.name} ${p.owner || ''}`).includes(Q) : open ? open.ids.includes(p.id) : !inDir.has(p.id))
      .sort({ recent: (a, b) => cmp(b.changed || b.created, a.changed || a.created), alpha: (a, b) => cmp(a.name, b.name), owner: (a, b) => (a.owner !== me) - (b.owner !== me) || cmp(a.owner, b.owner) || cmp(a.name, b.name) }[o.by]);
    const special = can('playlist') && !Q ? `<button class="lcard special" data-act="newpl"><div class="lcover">${ic('plus')}</div><b>Nuova playlist</b><small>Vuota, da riempire</small></button>
        <button class="lcard special alt" data-act="importpl"><div class="lcover">${ic('down')}</div><b>Importa da Spotify</b><small>CSV di Exportify, M3U, JSON</small></button>` : '';
    $('#plCards').className = 'lcards ' + mode;
    $('#plDirHead').innerHTML = open ? `<button class="icon-btn" data-dir="" aria-label="Tutte le playlist">${ic('chevl')}</button>${ic('folder')}<b>${esc(open.n)}</b>
      <button class="icon-btn" data-dirx="ren" aria-label="Rinomina la cartella" title="Rinomina">${ic('pen')}</button><button class="icon-btn" data-dirx="del" aria-label="Togli la cartella (le playlist restano)" title="Togli la cartella">${ic('trash')}</button>` : '';
    if (open) { $('#plCards').innerHTML = l.map(lPlCard).join('') || '<p class="sub">Cartella vuota: sposta qui una playlist dal suo menu («Sposta in una cartella»).</p>'; return; }
    const dirCards = Q ? '' : dirs.map(d => `<button class="lcard dir" data-dir="${esc(d.n)}"><div class="lcover">${ic('folder')}</div><b>${esc(d.n)}</b><small>Cartella · ${d.ids.length} ${d.ids.length === 1 ? 'playlist' : 'playlist'}</small></button>`).join('');
    $('#plCards').innerHTML = (!Q || cleanTxt('preferiti').includes(Q) ? `<a class="lcard favs" href="#/preferiti"><div class="lcover">${ic('heart', true)}</div><b>Preferiti</b><small>Playlist · ${favs} ${favs === 1 ? 'brano' : 'brani'}</small></a>` : '')
      + (mode === 'grid' ? special : '') + dirCards + l.map(lPlCard).join('') + (mode === 'list' ? special : '') + (Q && !l.length ? `<p class="sub">Nessuna playlist con «${esc(q)}».</p>` : '');
  };
  box.innerHTML = `<div class="ordbar"><label class="ordq">${ic('search')}<input type="search" id="plQ" placeholder="Cerca nelle playlist" aria-label="Cerca nelle playlist" autocomplete="off"></label>
    <button class="ordby" id="plOrd"><span>${esc(sortL.find(x => x[0] === o.by)[1])}</span>${ic('sliders')}</button>
    <button class="icon-btn" id="plView" aria-label="${mode === 'list' ? 'Mostra a griglia' : 'Mostra a elenco'}">${ic(mode === 'list' ? 'grid' : 'list')}</button></div><div class="plDirHead" id="plDirHead"></div><div class="lcards" id="plCards"></div>`;
  paint('');
  box.onclick = async e => {
    const d = e.target.closest('[data-dir]'), x = e.target.closest('[data-dirx]');
    if (d) { dir = d.dataset.dir || null; $('#plQ').value = ''; paint(''); scrollTo(0, 0); }
    else if (x?.dataset.dirx === 'ren') { dir = await PlDir.rename(dir); }
    else if (x?.dataset.dirx === 'del' && confirm(`Togliere la cartella «${dir}»? Le playlist restano.`)) { PlDir.remove(dir); dir = null; }
  };
  $('#plView').onclick = e => { mode = mode === 'list' ? 'grid' : 'list'; store.set('plView', mode); e.currentTarget.innerHTML = ic(mode === 'list' ? 'grid' : 'list'); e.currentTarget.setAttribute('aria-label', mode === 'list' ? 'Mostra a griglia' : 'Mostra a elenco'); paint($('#plQ').value); };
  $('#plQ').oninput = e => paint(e.target.value);
  $('#plOrd').onclick = e => { const r = e.currentTarget.getBoundingClientRect(); ctxMenuOrPick([r.left, r.bottom + 4], sortL.map(([v, l]) => [v === o.by ? 'check' : 'more', l, () => { o.by = v; store.set('plOrd', o); $('#plOrd span').textContent = l; paint($('#plQ').value); }]), 'Ordina per'); };
}

async function vPlaylist(id) {
  const n = Scene.nav;
  const p = (await api('getPlaylist', { id })).playlist;
  if (stale(n)) return;
  let songs = arr(p.entry).map(x => norm(x)); songs.forEach((t, i) => t._pi = i);
  const ok = 'pl:' + id, popts = { empty: 'Playlist vuota. Aggiungi brani dal menu ⋯ accanto a ogni canzone.', sortable: true };
  // modificarla: è mia (o sono l'amministratore) e posso gestire playlist
  const owner = can('playlist') && (access().admin || srv().local || !p.owner || p.owner === srv().user);
  const mine = owner || (can('playlist') && Amici.collab.has(id));  // chi collabora modifica come il proprietario
  const count = q => { const k = arr(q.entry).length; return `${k} ${k === 1 ? 'brano' : 'brani'}, ${fmtLong(q.duration || 0)}`; };
  const empty = { empty: 'Playlist vuota. Aggiungi brani dal menu ⋯ accanto a ogni canzone.' };
  Glow.show(coverUrl(p.coverArt, 300), 'album');
  view.innerHTML = lPhero({ kind: p.public ? 'Playlist condivisa' : 'Playlist', title: p.name, ph: p.coverArt, art: p.songCount ? imgTag(p.coverArt, 500) : ic('list'),
      meta: `${p.comment ? `<span class="phero-desc">${esc(p.comment)}</span>` : ''}${p.owner ? `<b>${esc(p.owner)}</b> · ` : ''}<span id="lCount">${count(p)}</span>` }) +
    lActionBar({ offline: false, extra: srv().local ? '' : pinBtn(id), more: [
      { act: 'enqueueall', label: 'Aggiungi alla coda', icon: 'queue' },
      !srv().local && can('condividi') && { act: 'shareitem', label: 'Condividi un link', icon: 'share', data: { id, name: p.name } },
      { act: 'exportpl', label: 'Esporta (M3U, JSON, CSV)', icon: 'down', data: { id } },
      mine && { act: 'editpl', label: 'Modifica nome e descrizione', icon: 'pen', data: { id } },
      mine && !srv().local && srv().me?.caps?.includes('plordina') && { act: 'reorderpl', label: 'Riordina i brani', icon: 'grip', data: { id } },
      owner && !srv().local && Amici.on() && { act: 'collabpl', label: 'Collaboratori', icon: 'friends', data: { id } },
      Amici.on() && !srv().local && { act: 'sendpl', label: 'Manda a un amico', icon: 'send', data: { id, name: p.name } },
      mine && !srv().local && { act: 'dedupepl', label: 'Togli doppioni', icon: 'list', data: { id } },
      mine && p.public && can('rete') && srv().me?.caps?.includes('fedofferta') && { act: 'offerpl', label: 'Server collegati…', icon: 'globe', data: { id } },
      { act: 'dirpl', label: PlDir.of(id) ? `Nella cartella «${PlDir.of(id).n}»` : 'Sposta in una cartella', icon: 'folder', data: { id } },
      mine && { act: 'delpl', label: 'Elimina playlist', icon: 'trash', danger: true, data: { id } }] }) +
    `<div id="impSt"></div>${songs.length > 1 ? Ord.bar(ok) : ''}<div id="lList">${songList(Ord.apply(songs, Ord.get(ok)), popts)}</div>`;
  Ord.wire(ok, () => songs, l => { $('#lList').innerHTML = songList(l, popts); });
  view.dataset.pl = id;
  impStatus(id, n);
  view.dataset.plMeta = JSON.stringify({ name: p.name, comment: p.comment || '', public: !!p.public });
  // tempo reale: brani aggiunti da altri dispositivi o arrivati dai download entrano senza ricaricare
  let art = (p.songCount ? 1 : 0) + '|' + p.coverArt;  // la copertina cambia quando la playlist si riempie
  lLive(n, async () => {
    const q = (await api('getPlaylist', { id })).playlist; const c = $('#lCount'); if (c) c.textContent = count(q);
    const k = (q.songCount ? 1 : 0) + '|' + q.coverArt, el = $('#view .phero-art');
    if (k !== art && el) { art = k; el.innerHTML = q.songCount ? imgTag(q.coverArt, 500) : ic('list'); }
    impStatus(id, n);
    songs = arr(q.entry).map(x => norm(x)); songs.forEach((t, i) => t._pi = i);
    return Ord.apply(songs, { ...Ord.get(ok), q: $('.ordbar input')?.value || '' });
  }, popts);
}
// ascolti sul server accanto ai brani (album, popolari dell'artista): una richiesta per tutta la lista
async function playCounts(box, n) {
  const s = srv(), lst = box?.querySelector('.songs[data-l]'); if (!lst || !s?.me?.caps?.includes('ascolti')) return;
  const tracks = Lists.get(+lst.dataset.l) || [], ids = tracks.filter(t => !t.fed).map(t => t.id).slice(0, 500); if (!ids.length) return;
  let m; try { m = await srvApi(s, '/api/ascolti/brani?ids=' + ids.map(encodeURIComponent).join(',')); } catch { return; }
  if (stale(n)) return;
  lst.querySelectorAll('.song[data-i]').forEach(el => {
    const t = tracks[+el.dataset.i], c = t && m[t.id], sm = el.querySelector('.t small'); if (!sm) return;
    sm.querySelector('.pcnt')?.remove();
    if (c) sm.insertAdjacentHTML('beforeend', `<span class="pcnt"> · ${c.toLocaleString('it-IT')} ${c === 1 ? 'ascolto' : 'ascolti'}</span>`);
  });
}
// playlist importata (server/importa.py): quanti brani del file sono in libreria, in download, non trovati
async function impStatus(id, n) {
  if (!srv()?.me?.caps?.includes('importsrv')) return;
  let st; try { st = await dlApi('/api/import/stato?pid=' + encodeURIComponent(id)); } catch { return; }
  const box = $('#impSt'); if (!box || stale(n) || !st?.total) return;
  const f = x => x.toLocaleString('it-IT'), all = st.inlib >= st.total, src = st.sub ? `della playlist su ${esc(st.sub.server)}` : 'del file importato';
  box.innerHTML = `<div class="impst${all ? ' ok' : ''}"><div class="grow"><b>${all ? `Tutti i ${f(st.total)} brani ${src} sono in libreria` : `${f(st.inlib)} di ${f(st.total)} brani ${src} in libreria`}</b>
    ${st.sub?.error ? `<small style="color:var(--danger)">Abbonamento: ${esc(st.sub.error)}</small>` : ''}
    <small>${[st.dl ? `${f(st.dl)} in download` : '', st.err ? `${f(st.err)} non trovati online` : '', st.miss ? `${f(st.miss)} ${st.sub ? 'in copia' : 'da scaricare'}` : ''].filter(Boolean).join(' · ') || (st.sub ? 'Resta uguale a quella originale: i brani nuovi si copiano da soli.' : 'Si completa da sola quando arrivano brani nuovi.')}</small>
    ${all ? '' : `<span class="bar"><i style="width:${st.inlib / st.total * 100}%"></i></span>`}</div>
    ${st.failed?.length ? `<details class="jerr"><summary>Vedi i non trovati</summary>${st.failed.map(x => `<div><b>${esc(x.title)}</b><small>${esc(x.error || '')}</small></div>`).join('')}</details>` : ''}</div>`;
}

// «Brani che ti piacciono» importata da Spotify: i brani che arrivano dopo l'importazione entrano nella playlist ma non
// prendevano il cuore. Aprendo i Preferiti (al più una volta l'ora) si mette il cuore a quelli che mancano
async function likedSync(have) {
  if (Date.now() - (store.get('likedSync', 0)) < 3600e3) return; store.set('likedSync', Date.now());
  try {
    const me = (srv()?.user || '').toLowerCase(), on = new Set(have.map(t => t.id));
    const pls = arr((await api('getPlaylists')).playlists.playlist).filter(p => (p.owner || '').toLowerCase() === me && /^(liked[ _]songs|brani che ti piacciono)$/i.test(p.name.trim()));
    let add = [];
    for (const p of pls) add = add.concat(arr((await api('getPlaylist', { id: p.id })).playlist.entry).map(x => x.id).filter(id => !on.has(id)));
    add = [...new Set(add)];
    for (let i = 0; i < add.length; i += 100) await api('star', { id: add.slice(i, i + 100) });
    if (add.length) { toast(`${add.length} brani di «Brani che ti piacciono» aggiunti ai Preferiti.`); if (location.hash.startsWith('#/preferiti')) route(); }
  } catch {}
}
async function vStarred() {
  if (!srv()) return noServer();
  const n = Scene.nav;
  const r = (await api('getStarred2')).starred2;
  if (stale(n)) return;
  const songs = arr(r.song).map(x => norm(x)), ar = arr(r.artist), al = arr(r.album), fopts = { empty: 'Tocca il cuore accanto a un brano per ritrovarlo qui.', sortable: true };
  songs.forEach(t => { if (t.starredAt) t.created = t.starredAt; });  // «Aggiunti di recente» = quando hai messo il cuore, come su Spotify
  likedSync(songs);
  view.innerHTML = lPhero({ kind: 'Raccolta', title: 'Preferiti', tile: 'linear-gradient(135deg,#4a2fbd,#c7a0ff)', art: ic('heart', true),
      meta: `${songs.length} brani · ${al.length} album · ${ar.length} artisti` }) +
    lActionBar({ offline: false, extra: srv().local ? '' : pinBtn('preferiti'), more: [{ act: 'enqueueall', label: 'Aggiungi alla coda', icon: 'queue' }] }) +
    (songs.length > 1 ? Ord.bar('preferiti') : '') + `<div id="lList">${songList(Ord.apply(songs, Ord.get('preferiti')), fopts)}</div>` +
    (al.length ? `<h2>Album</h2>${albumGrid(al, { strip: true })}` : '') +
    (ar.length ? `<h2>Artisti</h2><div class="lcards shelfish">${ar.map(lArtistCard).join('')}</div>` : '');
  Ord.wire('preferiti', () => songs, l => { $('#lList').innerHTML = songList(l, fopts); });
}

function vQueue() {
  if (Live.remote()) {
    const st = Live.st() || {}, up = arr(st.next).map(w => Live.loc(w)).filter(Boolean), cur = Live.track();
    view.innerHTML = `<h1>Coda</h1><p class="sub">Su ${esc(Live.devices.get(Live.target) || 'un altro dispositivo')}: ${st.left || 0} brani dopo questo. Tocca un brano per suonarlo lì.</p>
      ${cur ? songList([cur], { empty: '' }) : ''}<h2>Prossimi</h2>${songList(up, { empty: 'Non c\'è altro in coda.' })}
      ${(st.left || 0) > up.length ? `<p class="sub" style="margin-top:var(--s3)">…e altri ${(st.left - up.length).toLocaleString('it-IT')} brani in coda su ${esc(Live.devices.get(Live.target) || 'quel dispositivo')}.</p>` : ''}`;
    const lists = view.querySelectorAll('.songs');
    if (cur) lists[0]?.querySelectorAll('.song').forEach(el => el.removeAttribute('data-act'));  // il brano in corso è già lì
    lists[cur ? 1 : 0]?.querySelectorAll('.song').forEach(el => el.dataset.act = 'qremote');
    return;
  }
  if (Jam.role === 'guest') {
    view.innerHTML = `<h1>Coda della Jam</h1><p class="sub">La coda la gestisce l'host. Puoi proporre brani e votare dalla pagina Jam.</p><a class="btn primary" href="#/jam">Apri la Jam</a>`; return;
  }
  const tot = S.queue.slice(Math.max(0, S.index)).reduce((n, t) => n + t.duration, 0);
  view.innerHTML = `<h1>Coda</h1><p class="sub">${S.queue.length} brani, ${fmtLong(tot)} rimanenti. Può contenere brani di server diversi.</p>
    <div class="row" style="margin-bottom:16px">
      ${can('playlist') ? '<button class="btn" data-act="savequeue">Salva come playlist</button>' : ''}
      <button class="btn" data-act="exportqueue">Esporta</button>
      <button class="btn" data-act="dedupe">Togli doppioni</button>
      <button class="btn danger" data-act="clearqueue">Svuota</button>
    </div>${songList(S.queue, { queue: true, empty: 'La coda è vuota.' })}`;
  // come Spotify: "In riproduzione", "Prossimi in coda" (aggiunti a mano) e "Prossimi da …" (il resto della playlist o dell'album)
  const row = i => view.querySelector(`.songs .song[data-i="${i}"]`), head = (i, txt) => row(i)?.insertAdjacentHTML('beforebegin', `<h2 class="qhead">${txt}</h2>`);
  if (S.index >= 0) head(S.index, 'In riproduzione');
  let i = S.index + 1; if (S.queue[i]?._q) { head(i, 'Prossimi in coda'); while (S.queue[i]?._q) i++; }
  if (S.queue[i]) head(i, S.ctx?.name ? `Prossimi da: ${esc(S.ctx.name)}` : 'Prossimi');
  $('.song.now')?.scrollIntoView?.({ block: 'center' });
}
function vKeys() {
  const k = [['Spazio', 'Riproduci o pausa'], ['Maiusc + →', 'Brano successivo'], ['Maiusc + ←', 'Brano precedente'], ['→ / ←', 'Avanti o indietro di 10 secondi'],
    ['↑ / ↓', 'Volume'], ['M', 'Silenzia'], ['L', 'Testi'], ['Q', 'Coda'], ['S', 'Ordine casuale'], ['R', 'Ripeti'], ['F', 'Preferito'], ['/', 'Cerca'], ['?', 'Questa pagina']];
  view.innerHTML = `<h1>Scorciatoie da tastiera</h1><div class="panel">${k.map(([a, b]) => `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>${b}</span><kbd>${a}</kbd></div>`).join('')}</div>`;
}

/* ================= Parte 2: database locale ================= */
const DB = {
  _db: null,
  open() {
    return this._db ||= new Promise((res, rej) => {
      const r = indexedDB.open('armony', 5);
      r.onupgradeneeded = e => {
        const d = r.result;
        if (e.oldVersion < 1) {
          d.createObjectStore('offline', { keyPath: 'key' });
          d.createObjectStore('history', { keyPath: 'n', autoIncrement: true }).createIndex('ts', 'ts');
        }
        if (e.oldVersion < 2) d.createObjectStore('telefono', { keyPath: 'k' });  // telefono.js
        if (e.oldVersion < 3) d.createObjectStore('chiavi', { keyPath: 'k' });  // dispositivi.js: chiavi private non esportabili
        if (e.oldVersion < 4) d.createObjectStore('acache', { keyPath: 'k' });  // cache dei brani (ACache)
        if (e.oldVersion < 5) {
          d.createObjectStore('acmeta', { keyPath: 'k' });  // ACache: dimensione e ultimo uso, a parte dai file
          d.createObjectStore('stato', { keyPath: 'k' });  // copia della coda (persistQueue)
        }
      };
      // una scheda vecchia aperta non deve bloccare l'aggiornamento del database (né l'avvio di questa):
      // chi ha la versione vecchia la chiude quando ne arriva una nuova, e se resta bloccata si va avanti senza
      r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); DB._db = null; }; res(d); };
      r.onerror = () => rej(r.error);
      r.onblocked = () => { toast('Chiudi le altre schede di Armony per completare l\'aggiornamento.', 6000); setTimeout(() => rej(new Error('database bloccato')), 4000); };
    }).catch(e => { this._db = null; throw e; });
  },
  async run(st, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const tx = d.transaction(st, mode); const req = fn(tx.objectStore(st)); let out;
      if (req) req.onsuccess = () => { out = req.result; };
      tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
  },
  get: (st, k) => DB.run(st, 'readonly', s => s.get(k)),
  put: (st, v) => DB.run(st, 'readwrite', s => s.put(v)),
  del: (st, k) => DB.run(st, 'readwrite', s => s.delete(k)),
  all: st => DB.run(st, 'readonly', s => s.getAll()),
  // dall'indice, solo da un valore in su (lo storico recente senza leggere anni di ascolti)
  since: (st, idx, from) => DB.run(st, 'readonly', s => s.index(idx).getAll(IDBKeyRange.lowerBound(from))),
  keys: st => DB.run(st, 'readonly', s => s.getAllKeys()),
  clear: st => DB.run(st, 'readwrite', s => s.clear()),
  putMany: (st, list) => DB.run(st, 'readwrite', s => { list.forEach(v => s.put(v)); })
};

/* ================= offline ================= */
// un brano salvato offline visto dentro "Questo telefono" ha id "o:<server>:<id>": la chiave è quella di origine
const offKey = t => t.serverId === 'telefono' && /^o:/.test(t.id) ? t.id.slice(2) : key(t);
const Offline = {
  keys: new Set(), busy: false,
  async init() { try { (await DB.keys('offline')).forEach(k => this.keys.add(k)); } catch {} },
  has(t) { return !!t && this.keys.has(offKey(t)); },
  async url(t) { try { const r = await DB.get('offline', offKey(t)); return r ? URL.createObjectURL(r.blob) : null; } catch { return null; } },
  // quiet: salvataggio in sottofondo delle playlist sempre offline (OffPin), senza avvisi a ogni brano
  async save(tracks, quiet = false) {
    const todo = tracks.filter(t => !this.has(t) && !srv(t.serverId)?.local);
    if (!todo.length) return quiet ? 0 : toast(tracks.some(t => srv(t.serverId)?.local) ? 'Questi brani sono già sul telefono.' : 'Questi brani sono già disponibili offline.');
    if (this.busy) return quiet ? 0 : toast('Sto già salvando altri brani, attendi.');
    this.busy = true; navigator.storage?.persist?.();
    let done = 0, fail = 0;
    for (const t of todo) {
      if (!quiet) toast(`Salvo per l'offline ${done + 1} di ${todo.length}…`, 60000);
      try {
        // Subsonic risponde agli errori con 200 e un JSON: non deve finire salvato come brano (resterebbe muto per sempre)
        const r = await fetch(streamUrl(t, P.offlineQ), { signal: AbortSignal.timeout?.(300000) }); if (!r.ok || /json|xml/.test(r.headers.get('content-type') || '')) throw 0;
        const blob = await r.blob(); if (blob.size < 20000) throw 0;
        let cover = null;
        if (t.coverArt) { try { const c = await fetch(coverUrl(t.coverArt, 300, t.serverId)); if (c.ok) cover = await c.blob(); } catch {} }
        let lyr = null; try { lyr = await Lyrics.get(t); } catch {}  // il testo resta disponibile anche senza rete
        await DB.put('offline', { key: key(t), track: t, blob, cover, lyr, size: blob.size, q: P.offlineQ, added: Date.now() });
        this.keys.add(key(t)); done++;
      } catch { fail++; }
    }
    this.busy = false;
    if (!quiet) toast(fail ? `${done} brani salvati, ${fail} non riusciti.` : `${done} brani disponibili offline.`);
    if (location.hash.startsWith('#/offline')) route();
    return done;
  },
  async remove(k) { await DB.del('offline', k); this.keys.delete(k); }
};

/* ================= playlist e preferiti sempre offline (come «Scarica» di Spotify) =================
   Una playlist (o i Preferiti) segnata «sempre offline» si salva sul dispositivo e resta aggiornata: i brani che
   entrano dopo si salvano da soli, col Wi-Fi, all'avvio, quando le playlist cambiano e ogni mezz'ora. Per dispositivo */
const OffPin = {
  busy: false, t: null,
  all: () => store.get('offPins', {}),
  k: (pid, sid = S.active) => `${sid}:${pid}`,
  has(pid) { return !!this.all()[this.k(pid)]; },
  async toggle(pid, name, tracks) {
    const a = this.all(), k = this.k(pid);
    if (a[k]) { delete a[k]; store.set('offPins', a); return toast('Non più sempre offline. I brani già salvati restano (Offline → Elimina per toglierli).'); }
    a[k] = { sid: S.active, pid, name }; store.set('offPins', a);
    toast(`«${name}» sempre offline: i brani nuovi si salvano da soli col Wi-Fi.`, 4500);
    if (tracks?.length) Offline.save(tracks);
  },
  tracks: async (pin, s) => pin.pid === 'preferiti' ? arr((await api('getStarred2', {}, s)).starred2.song).map(x => norm(x, pin.sid))
    : arr((await api('getPlaylist', { id: pin.pid }, s)).playlist.entry).map(x => norm(x, pin.sid)),
  async sync() {
    if (this.busy || !navigator.onLine || onMobileData() || Offline.busy) return;
    this.busy = true; let n = 0;
    try {
      for (const pin of Object.values(this.all())) {
        const s = srv(pin.sid); if (!s || s.local) continue;
        try { n += await Offline.save(await this.tracks(pin, s), true) || 0; } catch {}
      }
    } finally { this.busy = false; }
    if (n) toast(`${n} ${n === 1 ? 'brano nuovo salvato' : 'brani nuovi salvati'} per l'offline.`);
  },
  soon(ms = 60000) { clearTimeout(this.t); this.t = setTimeout(() => this.sync(), ms); }
};
Bus.addEventListener('playlists', () => OffPin.soon()); Bus.addEventListener('libreria', () => OffPin.soon());
setInterval(() => OffPin.sync(), 30 * 60000);

/* ================= cache dei brani: come Spotify, i prossimi della coda arrivano prima che servano =================
   Mentre suona un brano si scaricano per intero i prossimi (2 col Wi-Fi, 1 in rete mobile, nessuno con «risparmio
   dati»), alla qualità in uso; un brano in cache parte subito e senza rete. Restano fino al limite scelto in
   Impostazioni → Ascolto (P.cacheMB, per dispositivo), poi se ne vanno i meno recenti. IndexedDB e non Cache Storage:
   funziona anche aprendo Armony senza HTTPS */
const ACache = {
  idx: {}, busy: new Set(), t: null,
  // l'indice si ricostruisce dal database: con più schede aperte una copia in localStorage si sovrascriverebbe.
  // Dimensione e ultimo uso stanno in «acmeta», a parte: prima l'avvio leggeva tutti i file della cache (centinaia di MB)
  // e ogni ascolto riscriveva il file intero solo per aggiornarne la data
  async init() {
    try {
      let m = await DB.all('acmeta');
      if (!m.length) {  // la prima volta dopo l'aggiornamento: l'indice dai file, uno alla volta
        for (const k of await DB.run('acache', 'readonly', s => s.getAllKeys())) {
          const r = await DB.get('acache', k); if (!r?.blob) continue;
          const x = { k, size: r.blob.size, at: r.at || 0 }; m.push(x); await DB.put('acmeta', x);
        }
      }
      for (const r of m) this.idx[r.k] = { size: r.size, at: r.at };
    } catch {}
  },
  meta(k) { const x = this.idx[k]; DB.put('acmeta', { k, size: x.size, at: x.at }).catch(() => {}); },
  drop(k) { delete this.idx[k]; DB.del('acache', k).catch(() => {}); DB.del('acmeta', k).catch(() => {}); },
  k: (t, q) => `${key(t)}@${q}`,
  max: () => (P.cacheMB ?? 1024) * 1e6,
  size() { return Object.values(this.idx).reduce((n, x) => n + x.size, 0); },
  ok(t) { return !!t && P.cacheMB !== 0 && !Offline.has(t) && !srv(t.serverId)?.local && !t.fed && !!srv(t.serverId); },
  has(t, q = activeQuality()) { return !!this.idx[this.k(t, q)]; },
  // la qualità da usare: quella attiva se c'è, altrimenti la migliore già in cache (in Wi-Fi si salva a 192k, in 5G
  // con "qualità in rete mobile" diversa quei brani valgono lo stesso: niente dati spesi per riscaricarli)
  pick(t) {
    if (!t || !this.ok(t)) return null;
    const q = activeQuality(); if (this.idx[this.k(t, q)]) return q;
    const order = Object.keys(QUALITIES); return order.find(x => this.idx[this.k(t, x)]) || null;
  },
  async url(t, q = activeQuality()) {
    const k = this.k(t, q); if (!this.idx[k]) return null;
    try {
      const r = await DB.get('acache', k);
      if (!r?.blob) { this.drop(k); return null; }
      this.idx[k].at = Date.now(); this.meta(k);
      return URL.createObjectURL(r.blob);
    } catch { return null; }
  },
  async get(t, q = activeQuality()) {
    const k = this.k(t, q); if (!this.ok(t) || this.idx[k] || this.busy.has(k) || !navigator.onLine) return;
    this.busy.add(k);
    try {
      // tempo massimo: una connessione appesa non deve bloccare la cache dei brani dopo
      const r = await fetch(streamUrl(t, q), { signal: AbortSignal.timeout?.(180000) }); if (!r.ok || /json|xml/.test(r.headers.get('content-type') || '')) return;
      const blob = await r.blob(); if (blob.size < 20000) return;  // una risposta d'errore, non un brano
      await DB.put('acache', { k, blob });
      this.idx[k] = { size: blob.size, at: Date.now() }; this.meta(k); this.trim();
    } catch {} finally { this.busy.delete(k); }
  },
  async trim() {
    let tot = this.size(); const max = this.max(); if (tot <= max) return;
    for (const [k, x] of Object.entries(this.idx).sort((a, b) => a[1].at - b[1].at)) {
      if (tot <= max * .9) break;
      this.drop(k); tot -= x.size;
    }
  },
  async clear() { await DB.clear('acache').catch(() => {}); await DB.clear('acmeta').catch(() => {}); this.idx = {}; },
  // dopo un cambio di brano, lasciato il tempo al brano attuale di riempire il suo buffer
  ahead() {
    clearTimeout(this.t);
    if (P.cacheMB === 0 || navigator.connection?.saveData || Jam.role === 'guest' || Radio.st || Live.remote()) return;
    this.t = setTimeout(async () => {
      const n = onMobileData() ? 1 : 2;
      for (let i = 1; i <= n; i++) { const t = S.queue[S.index + i]; if (t) await this.get(t); }
    }, 6000);
  }
};

/* ================= storico e statistiche ================= */
const Stats = {
  async add(t) {
    t = Local.orig(t);
    const ts = Date.now();
    try { await DB.put('history', { ts, hid: `${S.device}:${ts}`, synced: false, key: key(t), id: t.id, serverId: t.serverId, title: t.title, artist: t.artist, artistId: t.artistId, album: t.album, albumId: t.albumId, coverArt: t.coverArt, duration: t.duration || 0, genre: t.genre || '' }); } catch {}
    HistSync.schedule();
  },
  all() { return DB.all('history').catch(() => []); },
  since(days) { return DB.since('history', 'ts', Date.now() - days * 864e5).catch(() => this.all()); }
};

/* ================= storico e preferenze condivisi fra i dispositivi (sul server, per utente) ================= */
const syncable = s => P.sync && s?.session && s.me?.caps?.includes('history');
async function srvApi(s, path, opts = {}) {
  const r = await netFetch(absUrl(s.url) + path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Token': s.session, ...(opts.headers || {}) } }, 45000);
  if (!r.ok) throw new Error(`Errore ${r.status}`);
  return r.json();
}
const HistSync = {
  busy: false, t: null,
  // gli ascolti registrati senza durata (client 0.19–0.21) si completano una volta con getSong, al più 300 brani
  async repair() {
    if (store.get('histFix1')) return;
    const all = await DB.all('history').catch(() => []), bad = all.filter(x => !x.duration && x.id && srv(x.serverId) && !srv(x.serverId).local);
    const ids = [...new Set(bad.map(x => x.serverId + '|' + x.id))].slice(0, 300), dur = new Map();
    for (const k of ids) { const [sid, id] = k.split('|'); try { dur.set(k, (await api('getSong', { id }, srv(sid))).song.duration || 0); } catch {} }
    const fixed = bad.filter(x => dur.get(x.serverId + '|' + x.id)).map(x => ({ ...x, duration: dur.get(x.serverId + '|' + x.id) }));
    if (fixed.length) await DB.putMany('history', fixed).catch(() => {});
    if (ids.length < 300) store.set('histFix1', 1);
  },
  schedule(ms = 30000) { clearTimeout(this.t); this.t = setTimeout(() => this.run(), ms); },
  async run() {
    if (this.busy || !P.sync) return; this.busy = true;
    try {
      const all = await DB.all('history');
      // invio: gli ascolti fatti qui (anche quelli di prima della sincronizzazione) al server del brano
      const out = new Map();
      for (const x of all) if (!x.synced && syncable(srv(x.serverId))) { x.hid ||= `${S.device}:${x.ts}`; (out.get(x.serverId) || out.set(x.serverId, []).get(x.serverId)).push(x); }
      for (const [sid, list] of out) for (let i = 0; i < list.length; i += 500) {
        const part = list.slice(i, i + 500);
        await srvApi(srv(sid), '/api/history', { method: 'POST', body: JSON.stringify(part.map(({ n, key, serverId, synced, ...x }) => x)) });
        await DB.putMany('history', part.map(x => ({ ...x, synced: true })));
      }
      // ricezione: gli ascolti degli altri dispositivi, solo quelli nuovi dall'ultima volta
      const known = new Set(all.map(x => x.hid).filter(Boolean));
      for (const s of S.servers) {
        if (!syncable(s)) continue;
        for (let more = true; more;) {
          const r = await srvApi(s, `/api/history?since=${store.get('histSeq:' + s.id, 0)}`);
          const fresh = r.items.filter(x => !known.has(x.hid)).map(x => ({ ...x, key: s.id + ':' + x.id, serverId: s.id, synced: true }));
          if (fresh.length) await DB.putMany('history', fresh);
          fresh.forEach(x => known.add(x.hid)); store.set('histSeq:' + s.id, r.next); more = r.more;
        }
      }
    } catch {} finally { this.busy = false; }
  }
};
const PrefSync = {
  t: null, last: null,
  shared() { const o = { ...P }; DEVICE_PREFS.forEach(k => delete o[k]); return o; },
  schedule() { clearTimeout(this.t); this.t = setTimeout(() => this.push(), 3000); },
  async push() {
    const s = srv(); if (!syncable(s) || !s.me.caps.includes('prefs')) return;
    const data = this.shared(), j = JSON.stringify(data); if (j === this.last) return;  // es. solo il volume è cambiato
    try { await srvApi(s, '/api/prefs', { method: 'PUT', body: JSON.stringify({ data, updated: store.get('prefsAt', Date.now()) }) }); this.last = j; } catch {}
  },
  async pull() {
    const s = srv(); if (!syncable(s) || !s.me.caps.includes('prefs')) return;
    let r; try { r = await srvApi(s, '/api/prefs'); } catch { return; }
    if (r.data && r.updated > store.get('prefsAt', 0)) {
      for (const [k, v] of Object.entries(r.data)) if (!DEVICE_PREFS.includes(k) && k in DEFAULT_PREFS) P[k] = v;
      store.set('prefs', P); store.set('prefsAt', r.updated); this.last = JSON.stringify(this.shared());
      applyTheme();
      Engine.applyEq(); Engine.applyNight(); Engine.decks.forEach(a => a.playbackRate = P.speed); fillSelectors();
    } else if (store.get('prefsAt', 0) > r.updated) this.push();
  }
};

/* ================= testi ================= */
function parseLrc(text) {
  let offset = 0; const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const o = raw.match(/^\[offset:\s*([+-]?\d+)\]/i); if (o) { offset = +o[1] / 1000; continue; }
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    const v = raw.replace(/\[[^\]]*\]/g, '').trim();
    stamps.forEach(m => lines.push({ t: +m[1] * 60 + parseFloat(m[2].replace(':', '.')) - offset, v }));
  }
  if (lines.length) return { synced: true, lines: lines.sort((a, b) => a.t - b.t) };
  return { synced: false, lines: text.split(/\r?\n/).map(v => ({ t: null, v })) };
}
const Lyrics = {
  cache: new Map(),
  async get(t) {
    const k = key(t); if (this.cache.has(k)) return this.cache.get(k);
    // salvato offline insieme al brano: senza rete il testo c'è lo stesso
    if (Offline.has(t)) { try { const r = await DB.get('offline', key(t)); if (r?.lyr) { this.cache.set(k, r.lyr); return r.lyr; } } catch {} }
    let res = null, fail = false; const s = srv(t.serverId);
    if (s) {
      try {
        const L = arr((await api('getLyricsBySongId', { id: t.id }, s)).lyricsList?.structuredLyrics);
        const best = L.find(x => x.synced) || L[0];
        if (best && arr(best.line).length) res = { synced: !!best.synced, lines: arr(best.line).map(l => ({ t: l.start != null ? l.start / 1000 - (best.offset || 0) / 1000 : null, v: l.value })), src: s.name };
      } catch {}
      if (!res) { try { const v = (await api('getLyrics', { artist: t.artist, title: t.title }, s)).lyrics?.value; if (v) res = { ...parseLrc(v), src: s.name }; } catch {} }
    }
    if (!res && P.lyricsOnline) {
      try {
        // il primo artista: «A, B» non trova niente nella ricerca esatta di LRCLIB
        const a1 = String(t.artist || '').split(/\s*[,•&]\s*|\s+feat\.?\s+/i)[0];
        const u = new URL('https://lrclib.net/api/get');
        u.search = new URLSearchParams({ artist_name: a1, track_name: t.title, album_name: t.album || '', duration: Math.round(t.duration || 0) });
        let r = await fetch(u, { signal: AbortSignal.timeout?.(10000) });
        if (r.status === 404) { const s2 = new URL('https://lrclib.net/api/search'); s2.search = new URLSearchParams({ artist_name: a1, track_name: t.title }); r = await fetch(s2, { signal: AbortSignal.timeout?.(10000) }); }
        if (r.ok) {
          // nella ricerca di riserva solo un risultato col titolo giusto e la durata entro 3 s: prima prendeva il primo, anche di un altro brano
          let j = await r.json(); if (Array.isArray(j)) { const T = cleanTxt(t.title), ok = x => cleanTxt(x.trackName || '') === T && (!t.duration || !x.duration || Math.abs(x.duration - t.duration) <= 3); j = j.find(x => ok(x) && x.syncedLyrics) || j.find(ok); }
          if (j?.instrumental) res = { instrumental: true };
          else if (j?.syncedLyrics) res = { ...parseLrc(j.syncedLyrics), src: 'LRCLIB' };
          else if (j?.plainLyrics) res = { synced: false, lines: j.plainLyrics.split('\n').map(v => ({ t: null, v })), src: 'LRCLIB' };
        }
      } catch { fail = true; }  // rete giù: non si ricorda "niente testo", si riprova la prossima volta
    }
    if (!fail) this.cache.set(k, res); return res;
  }
};

/* ================= timer di spegnimento ================= */
const Sleep = {
  end: 0, eot: false, timer: null, factor: 1,
  set(min) {
    this.clear();
    if (min === 'eot') this.eot = true;
    else { this.end = Date.now() + min * 60000; this.timer = setInterval(() => this.tick(), 1000); }
    paintSleep(); toast(min === 'eot' ? 'La musica si fermerà a fine brano.' : `La musica si fermerà tra ${min} minuti, sfumando.`);
  },
  tick() {
    const rem = (this.end - Date.now()) / 1000;
    if (rem <= 0) { Engine.el.pause(); this.clear(); toast('Timer concluso. Buonanotte.'); return; }
    this.factor = rem < 45 ? rem / 45 : 1; Engine.applyVolume(); paintSleep();
  },
  clear() { clearInterval(this.timer); this.end = 0; this.eot = false; this.factor = 1; Engine.applyVolume(); paintSleep(); }
};
function paintSleep() {
  const p = $('#sleepPill'); if (!p) return;
  p.hidden = !Sleep.end && !Sleep.eot;
  p.textContent = Sleep.eot ? 'Timer: fine brano' : 'Timer ' + fmt((Sleep.end - Date.now()) / 1000);
}
function sleepDialog() {
  const d = $('#dlg');
  d.innerHTML = `<h3>Timer di spegnimento</h3><p class="sub">Il volume sfuma negli ultimi 45 secondi.</p>
    <div class="chips">${[5, 10, 15, 30, 45, 60, 90].map(m => `<button class="chip" data-m="${m}">${m} min</button>`).join('')}<button class="chip" data-m="eot">Fine brano</button></div>
    <div class="row" style="margin-top:16px">${Sleep.end || Sleep.eot ? '<button class="btn danger" data-m="off">Annulla timer</button>' : ''}<button class="btn" onclick="this.closest('dialog').close()">Chiudi</button></div>`;
  d.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { const m = b.dataset.m; m === 'off' ? Sleep.clear() : Sleep.set(m === 'eot' ? 'eot' : +m); d.close(); });
  d.showModal();
}

/* ================= motore audio =================
   Due "piatti" audio per crossfade e passaggi senza pause.
   Catena: piatto → guadagno (normalizzazione + dissolvenza) → margine (pre) → EQ 10 bande → compressore (volume notte)
   → limitatore → volume → uscita. Da pre parte anche la misura dello spettro per l'EQ automatico (tap).
   Contro i gracchi: pre abbassa il segnale di quanto l'EQ alza nel punto più alto della sua curva, e il limitatore
   (soglia -1 dB) ferma quel che resta (normalizzazione con preamplificazione, picchi fra campioni). Sotto soglia non tocca nulla.
   L'uscita viene anche resa disponibile come flusso, usato dalla Jam in modalità trasmissione. */
const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  'Piatto': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'Bassi potenti': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0], 'Acuti brillanti': [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  'Voce': [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1], 'Rock': [4, 3, 1, -1, -2, -1, 1, 3, 4, 4], 'Elettronica': [5, 4, 1, 0, -2, 1, 0, 2, 4, 5],
  'Acustica': [3, 2, 1, 1, 2, 2, 3, 3, 2, 1], 'Classica': [3, 2, 1, 0, 0, 0, -1, 1, 2, 3], 'Cuffiette piccole': [5, 4, 3, 1, 0, 0, 1, 2, 2, 1],
  'Altoparlante del telefono': [-6, -4, -1, 2, 3, 3, 2, 1, 0, -2]
};
/* EQ automatico: misura lo spettro medio del brano PRIMA dell'EQ (le correzioni non rientrano nella misura),
   come energia per ottava sulle 10 bande, e lo confronta con EQ_REF. In bande d'ottava il rumore rosa è piatto;
   lo spettro medio dei mix commerciali (es. Pestana et al., AES 2013, su migliaia di brani masterizzati) ha bassi
   pieni e scende di circa 2 dB per ottava sopra i 250 Hz, con un calo netto agli estremi. La curva è indicativa:
   si corregge metà della differenza, entro EQ_LIM, ancorata alle bande centrali, quindi conta la forma, non il decimale.
   È una modalità a sé (non si somma alle preimpostazioni): sommarle porterebbe la curva a doppio, e chi sceglie
   "Bassi potenti" vuole proprio scostarsi dal riferimento. */
const EQ_REF = [-4, 0, 0, -1.5, -3, -5, -7, -9, -11, -16];
const EQ_LIM = [3, 4.5, 6, 6, 6, 6, 6, 6, 4.5, 3];
const EQ_ZERO = new Float32Array(10);
// 72 frequenze in scala logaritmica 20 Hz – 20 kHz per leggere la curva dell'EQ, allocate una volta
const EQ_RESP = { f: Float32Array.from({ length: 72 }, (_, i) => 20 * 1000 ** (i / 71)), m: new Float32Array(72), p: new Float32Array(72), acc: new Float32Array(72) };
// il compressore del browser aggiunge un guadagno di compensazione fisso, (−soglia·(1−1/rapporto))·0,6 = +0,57 dB
// con soglia -1 e rapporto 20 (misurato in Chromium): lo si toglie, così sotto soglia il limitatore è trasparente
const LIM_MAKEUP = 10 ** (-.57 / 20);
const AutoEq = {
  timer: 0, n: 0, key: '', buf: null, bins: null, onpaint: null,
  pow: new Float32Array(10), now: new Float32Array(10), d: new Float32Array(10), t: new Float32Array(10),
  setup(ctx, tap) {
    this.buf = new Float32Array(tap.frequencyBinCount); const hz = ctx.sampleRate / tap.fftSize;
    this.bins = EQ_FREQS.map(f => [Math.max(1, Math.round(f / Math.SQRT2 / hz)), Math.min(tap.frequencyBinCount - 1, Math.round(f * Math.SQRT2 / hz))]);
    document.addEventListener('visibilitychange', () => this.run());
  },
  reset() { this.key = ''; this.n = 0; this.pow.fill(0); this.t.fill(0); },
  // gira solo se serve: modalità attiva, musica in corso, pagina visibile. Una lettura ogni 400 ms
  run() {
    const go = P.eqOn && P.eqAuto && !!Engine.ctx && !Engine.el.paused && !document.hidden;
    if (go && !this.timer) this.timer = setInterval(() => this.step(), 400);
    else if (!go && this.timer) { clearInterval(this.timer); this.timer = 0; this.onpaint?.(); }
  },
  step() {
    const k = Engine.el.dataset.key; if (k !== this.key) { this.key = k; this.n = 0; this.pow.fill(0); }  // brano nuovo: si riparte
    Engine.tap.getFloatFrequencyData(this.buf);
    let tot = 0;
    for (let i = 0; i < 10; i++) { let s = 0; const [a, b] = this.bins[i]; for (let j = a; j <= b; j++) s += 10 ** (this.buf[j] / 10); this.now[i] = s; tot += s; }
    if (tot < 1e-7) return;  // silenzio o intro quasi muto (sotto -70 dB): non conta
    this.n++; const w = 1 / Math.min(this.n, 20);  // media semplice per i primi 8 s, poi media mobile lenta (~8 s)
    let m = 0;
    for (let i = 0; i < 10; i++) { this.pow[i] += (this.now[i] - this.pow[i]) * w; this.d[i] = EQ_REF[i] - 10 * Math.log10(this.pow[i] + 1e-20); if (i > 1 && i < 8) m += this.d[i] / 6; }
    const conf = Math.min(1, this.n / 12);  // le prime letture contano poco: si parte morbidi
    for (let i = 0; i < 10; i++) {
      const x = this.d[i] - m;  // > 0: la banda manca rispetto al riferimento
      const c = (x > 12 ? Math.max(0, 24 - x) : x) * .5;  // banda quasi assente (filtro dell'MP3, niente sub): non si gonfia il rumore
      this.t[i] = Math.round(Math.max(-EQ_LIM[i], Math.min(EQ_LIM[i], c)) * conf * 10) / 10;
    }
    Engine.applyEq(); this.onpaint?.();
  }
};
// ascolti che non sono arrivati al server (senza rete, server giù): si tengono e si rimandano con la loro ora,
// così le statistiche "Sul server" contano anche quelli fatti in metropolitana
const Scrob = {
  keep(t, time) { const q = store.get('scrobq', []); q.push({ sid: t.serverId, id: t.id, time }); store.set('scrobq', q.slice(-500)); },
  async flush() {
    if (this.busy || !navigator.onLine) return;
    const q = store.get('scrobq', []).filter(x => Date.now() - x.time < 14 * 864e5); if (!q.length) return;
    this.busy = true; const left = [];
    for (const x of q) { const s = srv(x.sid); if (!s) continue; try { await api('scrobble', { id: x.id, submission: true, time: x.time }, s); } catch { left.push(x); } }
    store.set('scrobq', left); this.busy = false;
  }
};
const Engine = {
  decks: [], gains: [], cur: 0, ctx: null, master: null, eq: [], comp: null, analyser: null, pre: null, tap: null, lim: null, shadow: [], dest: null, fading: false, blobUrls: [null, null], scrobbled: null, fails: 0,
  init() {
    for (let i = 0; i < 2; i++) {
      const a = document.createElement('audio'); a.preload = 'auto';
      if (!P.compat) a.crossOrigin = 'anonymous';
      a.preservesPitch = true;
      document.body.append(a); this.decks.push(a);
      for (const ev of ['timeupdate', 'play', 'pause', 'ended', 'error', 'loadedmetadata', 'playing', 'waiting', 'stalled']) a.addEventListener(ev, e => this.on(ev, i, e));
    }
    this.applyVolume();
  },
  get el() { return this.decks[this.cur]; },
  get idle() { return this.decks[1 - this.cur]; },
  graph() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    if (P.compat) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' }); this.ctx = ctx;
      // sospeso dal sistema mentre l'elemento suona (cambio di uscita Bluetooth, interruzioni): il tempo andrebbe avanti muto
      ctx.onstatechange = () => { if (ctx.state !== 'running' && ctx.state !== 'closed' && !this.el.paused) ctx.resume().catch(() => {}); };
      this.eq = EQ_FREQS.map((f, i) => { const b = ctx.createBiquadFilter(); b.type = i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking'; b.frequency.value = f; b.Q.value = 1.1; return b; });
      // copie scollegate dei filtri: servono solo a calcolare la curva dell'EQ (getFrequencyResponse), non suonano
      this.shadow = EQ_FREQS.map((f, i) => { const b = ctx.createBiquadFilter(); b.type = this.eq[i].type; b.frequency.value = f; b.Q.value = 1.1; return b; });
      this.pre = ctx.createGain(); this.tap = ctx.createAnalyser(); this.tap.fftSize = 4096; this.tap.smoothingTimeConstant = 0;
      this.decks.forEach((a, i) => { const src = ctx.createMediaElementSource(a); const g = ctx.createGain(); g.gain.value = i === this.cur ? this.rg(currentTrack()) : 0; src.connect(g); g.connect(this.pre); this.gains[i] = g; });
      this.pre.connect(this.eq[0]); this.pre.connect(this.tap); AutoEq.setup(ctx, this.tap);
      this.eq.reduce((p, n) => { p.connect(n); return n; });
      this.comp = ctx.createDynamicsCompressor(); this.master = ctx.createGain();
      // limitatore: rapporto massimo, attacco immediato (il nodo guarda avanti di 6 ms); lo segue la compensazione tolta
      const l = this.lim = ctx.createDynamicsCompressor(); l.threshold.value = -1; l.knee.value = 0; l.ratio.value = 20; l.attack.value = 0; l.release.value = .1;
      const lo = ctx.createGain(); lo.gain.value = LIM_MAKEUP;
      this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 512; this.analyser.smoothingTimeConstant = .8;
      this.eq[9].connect(this.comp); this.comp.connect(l); l.connect(lo); lo.connect(this.master); this.master.connect(this.analyser); this.analyser.connect(ctx.destination);
      this.dest = ctx.createMediaStreamDestination(); this.master.connect(this.dest);
      this.applyEq(); this.applyNight(); this.applyVolume();
    } catch (e) { console.warn('Web Audio non disponibile', e); this.ctx = null; }
  },
  // manuale: subito; automatico: scivola con costante di 2,5 s (niente pompaggio). pre segue di pari passo
  applyEq() {
    AutoEq.run(); if (!this.ctx) return;
    const g = !P.eqOn ? EQ_ZERO : P.eqAuto ? AutoEq.t : P.eq, now = this.ctx.currentTime, tau = P.eqOn && P.eqAuto ? 2.5 : .02;
    this.eq.forEach((b, i) => b.gain.setTargetAtTime(g[i] || 0, now, tau));
    this.pre.gain.setTargetAtTime(10 ** (-this.eqPeak(g) / 20), now, tau);
  },
  // punto più alto della curva dell'EQ, in dB (0 se nessuna banda alza): è il margine da lasciare prima dell'EQ
  eqPeak(g) {
    const acc = EQ_RESP.acc.fill(1);
    this.shadow.forEach((b, i) => { b.gain.value = g[i] || 0; b.getFrequencyResponse(EQ_RESP.f, EQ_RESP.m, EQ_RESP.p); for (let j = 0; j < acc.length; j++) acc[j] *= EQ_RESP.m[j]; });
    let mx = 1; for (let j = 0; j < acc.length; j++) if (acc[j] > mx) mx = acc[j];
    return 20 * Math.log10(mx);
  },
  applyNight() {
    const c = this.comp; if (!c) return;
    if (P.night) { c.threshold.value = -34; c.knee.value = 14; c.ratio.value = 7; c.attack.value = .004; c.release.value = .3; }
    else { c.threshold.value = 0; c.knee.value = 0; c.ratio.value = 1; }
  },
  applyVolume() {
    const v = Math.max(0, Math.min(1, P.volume * Sleep.factor * (Jam.duck || 1)));
    if (this.master) { this.master.gain.value = v; this.decks.forEach(d => d.volume = 1); } else this.decks.forEach(d => d.volume = v);
    if (Jam.remoteAudio) Jam.remoteAudio.volume = v;
  },
  rg(t) {
    if (P.rg === 'off' || !t?.rg) return 1;
    const g = t.rg, alb = P.rg === 'album';
    const db = alb ? (g.albumGain ?? g.trackGain) : (g.trackGain ?? g.albumGain);
    if (db == null) return 1;
    let lin = Math.pow(10, (db + (+P.rgPre || 0)) / 20);
    const peak = alb ? (g.albumPeak || g.trackPeak) : (g.trackPeak || g.albumPeak);
    if (peak) lin = Math.min(lin, 1 / peak);
    return Math.min(lin, 4);
  },
  setGain(i, v) { const g = this.gains[i]; if (!g) return; const now = this.ctx.currentTime; g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(v, now); },
  // lazy: solo i metadati finché non si preme play (il brano ripreso all'avvio non deve rubare la rete alla Home)
  async load(t, i, { autoplay = true, startAt = 0, lazy = false } = {}) {
    const a = this.decks[i], k = key(t);
    a.preload = lazy ? 'metadata' : 'auto';
    a.dataset.key = k; a.dataset.q = activeQuality();
    const cq = !Offline.has(t) && ACache.pick(t), blob = Offline.has(t) ? await Offline.url(t) : cq ? await ACache.url(t, cq) : null;
    if (a.dataset.key !== k) { if (blob) URL.revokeObjectURL(blob); return false; }
    if (this.blobUrls[i]) URL.revokeObjectURL(this.blobUrls[i]);
    this.blobUrls[i] = blob;
    a.src = blob || streamUrl(t); a.playbackRate = P.speed;
    if (startAt) a.addEventListener('loadedmetadata', () => { try { a.currentTime = startAt; } catch {} }, { once: true });
    this.setGain(i, i === this.cur ? this.rg(t) : 0);
    if (autoplay) { this.graph(); try { await a.play(); } catch (e) { if (e.name === 'NotAllowedError') toast('Tocca play per iniziare.'); else if (e.name !== 'AbortError') window.Diag?.report('avviso', 'audio', `play() non riuscito: ${e.name} ${e.message}`, safeUrl(a.src)); } }
    return true;
  },
  swap(t) {
    const old = this.cur; this.cur = 1 - old;
    this.decks[old].pause(); this.graph();
    this.setGain(this.cur, this.rg(t)); this.setGain(old, 0);
    try { this.el.currentTime = 0; } catch {}
    this.el.playbackRate = P.speed; this.el.play().catch(() => {});
  },
  nextIndex() {
    if (S.index < S.queue.length - 1) return S.index + 1;
    if (S.repeat === 'all' && S.queue.length) return 0;
    return null;
  },
  on(ev, i) {
    if (i !== this.cur) return;
    if (ev === 'error') {
      if (!this.el.getAttribute('src')) return;
      const src = this.el.getAttribute('src'), sv = srv(currentTrack()?.serverId);
      if (sv?.armony && /[?&]k=/.test(src) && this.el._tk !== src) {
        const el = this.el, at = el.currentTime, go = !el.paused || !!el.error; el._tk = src;  // dopo un errore risulta fermo: si riparte
        Disp.fresh(sv, true).then(() => { if (!sv.tk || sv.revoked || el.getAttribute('src') !== src) return; el.src = src.replace(/([?&]k=)[^&]*/, '$1' + encodeURIComponent(sv.tk)); el._tk = el.src; el.currentTime = at; if (go) el.play().catch(() => {}); });
        return;
      }
      const off = !navigator.onLine, me = this.el.error, el = this.el;
      // senza rete: si aspetta che torni (stesso brano, stesso punto), salvo saltare a un brano che c'è sul dispositivo
      if (off) {
        const n = this.availableNext();
        if (n != null) { toast('Senza rete: passo al prossimo brano salvato sul dispositivo.'); playIndex(n); return; }
        toast('Senza rete: riprendo appena torna.', 5000);
        addEventListener('online', () => { if (el.getAttribute('src') === src) this.reload(el, src); }, { once: true });
        return;
      }
      // errore di rete o flusso interrotto (il Funnel che cade, Navidrome che riparte): stesso brano dallo stesso punto,
      // con attese crescenti, finché non si rinuncia (circa un minuto). Un formato che non si apre si riprova una volta sola
      const net = me?.code === 2 || me?.code === 3 || (me?.code === 4 && el.currentTime > 0);
      // i tentativi ripartono da capo se dall'ultimo errore il brano è andato avanti (un errore fisso nello stesso punto no)
      if (el._src === src && Math.abs(el.currentTime - (el._errAt ?? -99)) > 5) el._tries = 0;
      el._tries = el._src === src ? (el._tries || 0) + 1 : 1; el._src = src; el._errAt = el.currentTime;
      if (el._tries <= (net ? 6 : 1)) {
        const wait = Math.min(30000, 1000 * 2 ** (el._tries - 1));
        setTimeout(() => { if (el.getAttribute('src') === src) this.reload(el, src); }, wait);
        return;
      }
      if (!off) window.Diag?.report('errore', 'audio', `brano non riproducibile: ${currentTrack()?.title || '?'}`, `codice ${me?.code ?? '?'} ${me?.message || ''}\n${safeUrl(src)}`);
      // tre brani di fila che non partono: è il server o l'accesso, non i brani. Fermarsi invece di scorrere tutta la coda
      if (++this.fails >= 3 || sv?.revoked || sv?.pending) {
        this.fails = 0; this.el.pause();
        toast(sv?.revoked ? 'Questo server è stato revocato su questo dispositivo: scegli il server giusto in Impostazioni.' : 'Più brani di fila non partono: mi fermo. Controlla la connessione o il server.', 7000);
        window.Diag?.report('avviso', 'audio', 'riproduzione fermata: più brani di fila non riproducibili', sv ? `${sv.name}${sv.revoked ? ' (revocato)' : ''}` : 'server sconosciuto');
        return;
      }
      toast(off ? 'Sei offline e questo brano non è salvato sul dispositivo.' : 'Impossibile riprodurre questo brano, passo al successivo.');
      if (Jam.role !== 'guest' && !Radio.st) setTimeout(() => ctlNext(true), 1500);
      return;
    }
    if (ev === 'waiting' || ev === 'stalled') return this.watchStall();
    if (ev === 'timeupdate') { this.tick(); emit('time'); }
    else if (ev === 'play' || ev === 'playing') { if (ev === 'playing') { this.fails = 0; clearTimeout(this.stallT); } paintButtons(); emit('play'); AutoEq.run(); }
    else if (ev === 'pause') { paintButtons(); emit('pause'); QSync.schedule(); AutoEq.run(); }
    else if (ev === 'ended') this.ended();
    else if (ev === 'loadedmetadata') emit('time');
  },
  // ricarica lo stesso indirizzo dallo stesso punto; se nel frattempo il brano è finito in cache o offline, da lì
  async reload(el, src, at = el.currentTime) {
    const t = currentTrack(), go = !el.paused || !!el.error;  // dopo un errore l'elemento risulta fermo: si riparte
    const blob = t && el === this.el ? (Offline.has(t) ? await Offline.url(t) : ACache.pick(t) ? await ACache.url(t, ACache.pick(t)) : null) : null;
    if (el.getAttribute('src') !== src) { if (blob) URL.revokeObjectURL(blob); return; }
    if (blob) { const i = this.decks.indexOf(el); if (this.blobUrls[i]) URL.revokeObjectURL(this.blobUrls[i]); this.blobUrls[i] = blob; }
    el.src = blob || src;
    el.addEventListener('loadedmetadata', () => { try { el.currentTime = at; } catch {} }, { once: true });
    if (go) el.play().catch(() => {});
  },
  // il brano aspetta dati: se dopo 8 s è ancora fermo nello stesso punto la connessione è appesa (non arriva nessun
  // errore), e lo si ricarica. Prima un brano poteva restare muto per minuti con il lettore "in riproduzione"
  watchStall() {
    const el = this.el, src = el.getAttribute('src'), at = el.currentTime; if (!src || src.startsWith('blob:')) return;
    clearTimeout(this.stallT);
    this.stallT = setTimeout(() => {
      if (el !== this.el || el.paused || el.getAttribute('src') !== src || Math.abs(el.currentTime - at) > .5) return;
      window.Diag?.report('avviso', 'audio', 'flusso fermo da 8 s: ricarico', safeUrl(src)); Trace.add('audio fermo da 8 s: ricarico ' + Trace.path(src));
      this.reload(el, src, at);
    }, 8000);
  },
  // il primo brano dopo questo che si può ascoltare senza rete (salvato offline o nella cache dei brani)
  availableNext() {
    for (let i = S.index + 1; i < S.queue.length; i++) { const t = S.queue[i]; if (Offline.has(t) || ACache.pick(t) || srv(t.serverId)?.local) return i; }
    return null;
  },
  tick() {
    const a = this.el, t = currentTrack(); if (!t) return;
    if (this.scrobbled !== key(t) + '@' + S.index && a.currentTime > Math.min(240, (t.duration || 60) / 2)) {
      this.scrobbled = key(t) + '@' + S.index;
      if (srv(t.serverId) && !t.fed) { const at = Date.now(); api('scrobble', { id: t.id, submission: true }, srv(t.serverId)).catch(() => Scrob.keep(t, at)); }
      Stats.add(t);
    }
    if (Radio.st) return;  // la radio la manda avanti radio.js, secondo l'orario del server
    if (Math.floor(a.currentTime) % 5 === 0) store.set('pos', a.currentTime);
    // mentre suona la posizione arriva al server ogni 30 s: "continua su un altro dispositivo" non riparte da minuti prima
    if (P.syncQueue && !a.paused && Jam.role !== 'guest' && Date.now() - (QSync.at || 0) > 30000) QSync.push();
    if (Jam.role === 'guest') return;
    const rem = a.duration - a.currentTime; if (!isFinite(rem)) return;
    const n = this.nextIndex(); if (n == null || S.repeat === 'one' || Sleep.eot) return;
    const nt = S.queue[n];
    if (rem < 30 && this.idle.dataset.key !== key(nt) && !this.fading) this.load(nt, 1 - this.cur, { autoplay: false });
    // niente dissolvenza fra brani consecutivi dello stesso album (live, mix, concept: sono fatti per legarsi)
    const seq = t.albumId && t.albumId === nt.albumId && nt.track === (t.track || 0) + 1;
    if (P.crossfade > 0 && this.ctx && !this.fading && !seq && rem <= P.crossfade && rem > .3) this.crossfade(n, rem);
  },
  async crossfade(n, rem) {
    this.fading = true;
    const old = this.cur, nw = 1 - old, t = S.queue[n], d = Math.max(.8, Math.min(P.crossfade, rem));
    if (this.decks[nw].dataset.key !== key(t)) await this.load(t, nw, { autoplay: false });
    const now = this.ctx.currentTime;
    const gn = this.gains[nw].gain, go = this.gains[old].gain;
    gn.cancelScheduledValues(now); gn.setValueAtTime(0.0001, now); gn.exponentialRampToValueAtTime(this.rg(t), now + d);
    go.cancelScheduledValues(now); go.setValueAtTime(Math.max(go.value, .0001), now); go.exponentialRampToValueAtTime(0.0001, now + d);
    this.decks[nw].playbackRate = P.speed; this.decks[nw].play().catch(() => {});
    this.cur = nw; S.index = n; persistQueue(); trackChanged(t);
    setTimeout(() => { if (this.cur !== old) this.decks[old].pause(); this.fading = false; }, d * 1000 + 150);
  },
  ended() {
    if (Jam.role === 'guest' || Radio.st) return;
    if (Sleep.eot) { Sleep.clear(); toast('Fine brano: buonanotte.'); paintButtons(); return; }
    if (S.repeat === 'one') { this.el.currentTime = 0; this.el.play(); return; }
    const n = this.nextIndex();
    if (n == null) { if (P.autoplay !== false) return autoContinue(currentTrack()); paintButtons(); emit('pause'); return; }
    playIndex(n);
  },
  time() { return this.el.currentTime || 0; },
  duration() { const d = this.el.duration; return isFinite(d) && d > 0 ? d : (currentTrack()?.duration || 0); },
  stop() { this.decks.forEach(d => { d.pause(); d.removeAttribute('src'); d.dataset.key = ''; d.load(); }); }
};

/* ================= riproduzione ================= */
// quattro casi: ospite della Jam, Jam Radio (radio.js: posizione e durata dall'orario della stazione), telecomando, qui
function currentTrack() { return Jam.role === 'guest' ? Jam.track : Radio.st ? Radio.track : Live.remote() ? Live.track() : S.queue[S.index]; }
const broadcastGuest = () => Jam.role === 'guest' && Jam.mode === 'broadcast';
function isPlaying() { return broadcastGuest() ? Jam.playing : Live.remote() ? Live.playing() : !Engine.el.paused; }
function playPos() { return broadcastGuest() ? Jam.estPos() : Radio.st ? Radio.pos() : Live.remote() ? Live.pos() : Engine.time(); }
function playDur() { return broadcastGuest() ? (Jam.track?.duration || 0) : Radio.st ? Radio.dur() : Live.remote() ? Live.dur() : Engine.duration(); }
// la coda va anche in IndexedDB: se localStorage è pieno (5 MB, e una coda da 3000 brani ne occupa più di uno)
// la scrittura fallisce in silenzio e al riavvio tornava una coda vecchia. queueAt dice quale copia è più recente
function persistQueue() {
  const at = Date.now();
  try { localStorage.setItem('armony:queue', JSON.stringify(S.queue.slice(0, 3000))); store.set('queueAt', at); } catch {}
  store.set('index', S.index);
  clearTimeout(persistQueue.d); persistQueue.d = setTimeout(() => DB.put('stato', { k: 'queue', at, queue: S.queue.slice(0, 3000), index: S.index }).catch(() => {}), 1000);
  clearTimeout(persistQueue.t); persistQueue.t = setTimeout(() => Live.publish(), 300);  // gli altri dispositivi vedono la stessa coda
}
// da dove suona la coda ("In riproduzione da PLAYLIST · Nome", come Spotify): la pagina da cui è partita
const CTX_KIND = { playlist: 'Playlist', album: 'Album', 'album-dz': 'Album', artista: 'Artista', 'artista-dz': 'Artista', preferiti: 'Preferiti',
  cerca: 'Ricerca', home: 'Home', genere: 'Genere', decennio: 'Decennio', offline: 'Offline', libreria: 'Libreria', statistiche: 'Statistiche', amici: 'Amici' };
function setCtx() {
  const r = location.hash.replace(/^#\/?/, '').split('/')[0] || 'home';
  // pagine senza un nome proprio (la Home ha il saluto come titolo): basta il nome della sezione
  const own = ['playlist', 'album', 'album-dz', 'artista', 'artista-dz', 'genere', 'decennio'].includes(r);
  S.ctx = r === 'ora' || r === 'coda' ? S.ctx : own ? { kind: CTX_KIND[r] || '', name: ($('#view h1')?.textContent || '').trim().slice(0, 80), hash: location.hash }
    : { kind: '', name: CTX_KIND[r] || '', hash: location.hash };
  store.set('qctx', S.ctx);
}
const MixPage = { want: false, at: 0, tracks: [], name: '', sub: '', hue: '' };
Bus.addEventListener('route', () => { if (Scene.r !== 'home') MixPage.want = false; });  // un mix non riuscito non cattura la riproduzione dopo
function vMix() {
  if (!MixPage.tracks.length) { location.hash = '#/home'; return; }
  const t = MixPage.tracks, dur = t.reduce((n, x) => n + (x.duration || 0), 0);
  view.innerHTML = lPhero({ kind: 'Mix', title: MixPage.name, tile: `linear-gradient(135deg,${MixPage.hue || '#4a2fbd'},#141626)`, art: ic('shuffle'),
      meta: `${esc(MixPage.sub)}${MixPage.sub ? ' · ' : ''}${t.length} brani, ${fmtLong(dur)}` }) +
    lActionBar({ play: { act: 'mixplay' }, shuffle: { act: 'mixshuf' }, offline: false, addpl: false, more: [
      can('playlist') && !srv()?.local && { act: 'mixsave', label: 'Salva come playlist', icon: 'addlist' },
      { act: 'enqueueall', label: 'Aggiungi alla coda', icon: 'queue' }] }) +
    `<div id="lList">${songList(t)}</div>`;
}
function setQueue(tracks, start = 0, shuffle = false) {
  if (Jam.role === 'guest') { tracks[start] && Jam.suggest(tracks[start]); return; }
  if (!tracks.length) return toast('Non ci sono brani da riprodurre.');
  let q = tracks.slice();
  if (shuffle) { q = shuffleArr(q); start = 0; }
  // un mix toccato in Home apre la sua pagina (come Spotify) invece di partire: elenco, Riproduci, Salva come playlist
  if (MixPage.want && Date.now() - MixPage.at < 30000) { MixPage.want = false; MixPage.tracks = q; location.hash = '#/mix'; if (Scene.r === 'mix') route(); return; }
  if (Live.remote()) return Live.cmd('transfer', Live.pack(q, start, 0));  // l'uscita scelta è un altro dispositivo
  setCtx(); S.queue = q; playIndex(start);
}
async function playIndex(i, o = {}) {
  if (Jam.role === 'guest') return Jam.guestControl('jump', i);
  if (i < 0 || i >= S.queue.length) return;
  if (Radio.st) await Radio.leave(true);  // suonare la coda vuol dire uscire dalla radio
  S.index = i; persistQueue();
  const t = S.queue[i];
  if (!srv(t.serverId) && !Offline.has(t)) { toast('Il server di questo brano non è più configurato.'); return; }
  const idle = Engine.idle;
  if (!o.startAt && o.autoplay !== false && !Engine.fading && idle.dataset.key === key(t) && idle.dataset.q === activeQuality() && idle.readyState >= 2) Engine.swap(t);
  else { idle.pause(); Engine.fading = false; await Engine.load(t, Engine.cur, { autoplay: o.autoplay !== false, startAt: o.startAt }); }
  trackChanged(t);
}
function trackChanged(t) {
  updateNowPlaying();
  $$('.song').forEach(el => { const x = S.lastList[+el.dataset.i]; el.classList.toggle('now', !!x && !!t && key(x) === key(t)); });
  if (t && srv(t.serverId) && !t.fed && Jam.role !== 'guest') api('scrobble', { id: t.id, submission: false }, srv(t.serverId)).catch(() => {});
  QSync.schedule(); emit('track', t); ACache.ahead();
  if (location.hash.startsWith('#/ora')) vNow();
  else if (location.hash.startsWith('#/testo')) vLyrics();
  else if (location.hash.startsWith('#/coda')) vQueue();
}
function ctlToggle() {
  if (Jam.role === 'guest') return Jam.guestControl(isPlaying() ? 'pause' : 'play');
  if (Radio.st) return Radio.on ? Radio.pause() : Radio.resume();
  if (Live.remote()) return Live.cmd('toggle');
  const a = Engine.el;
  if (!a.getAttribute('src')) { if (S.queue.length) playIndex(Math.max(0, S.index)); return; }
  Engine.graph(); a.paused ? a.play().catch(() => {}) : a.pause();
}
const radioNo = () => toast('È una radio: va avanti da sola. Per scegliere tu, esci dalla radio.');
function ctlNext(auto) {
  if (Jam.role === 'guest') return Jam.guestControl('next');
  if (Radio.st) return auto ? undefined : radioNo();
  if (Live.remote()) return auto ? undefined : Live.cmd('next');
  const n = S.index < S.queue.length - 1 ? S.index + 1 : (S.repeat === 'all' ? 0 : null);
  if (n != null) playIndex(n); else if (auto) Engine.el.pause(); else if (P.autoplay !== false) autoContinue(currentTrack());
}
function ctlPrev() {
  if (Jam.role === 'guest') return Jam.guestControl('prev');
  if (Radio.st) return radioNo();
  if (Live.remote()) return Live.cmd('prev');
  if (Engine.time() > 4 || S.index <= 0) ctlSeek(0); else playIndex(S.index - 1);
}
function ctlSeek(sec) {
  if (Jam.role === 'guest') return Jam.guestControl('seek', sec);
  if (Radio.st) { paintTime(); return radioNo(); }
  if (Live.remote()) return Live.cmd('seek', Math.max(0, sec));
  try { Engine.el.currentTime = Math.max(0, sec); } catch {}
  emit('seek');
}
// casuale come Spotify: i brani aggiunti a mano restano primi; spegnendolo torna l'ordine della playlist o dell'album (_o)
function ctlShuffle() {
  S.shuffle = !S.shuffle; store.set('shuffle', S.shuffle);
  const head = S.queue.slice(0, S.index + 1), rest = S.queue.slice(S.index + 1), mine = rest.filter(t => t._q), ctx = rest.filter(t => !t._q);
  if (S.shuffle) { S.queue.forEach((t, i) => { if (t._o == null) t._o = i; }); S.queue = [...head, ...mine, ...shuffleArr(ctx)]; }
  else S.queue = [...head, ...mine, ...ctx.sort((a, b) => (a._o ?? 1e9) - (b._o ?? 1e9))];
  if (rest.length > 1) { persistQueue(); emit('queue'); if (location.hash.startsWith('#/coda')) vQueue(); }
  paintButtons();
}
function ctlRepeat() { S.repeat = { off: 'all', all: 'one', one: 'off' }[S.repeat]; store.set('repeat', S.repeat); paintButtons(); }
function updateNowPlaying() {
  const t = currentTrack();
  $('#npT').textContent = t ? t.title : 'Niente in riproduzione';
  $('#npA').innerHTML = t ? esc(t.artist) + (t.album ? `<span class="npalb"> · ${esc(t.album)}</span>` : '') : esc(Jam.role === 'guest' ? 'In attesa dell\'host della Jam' : 'Scegli un album o una playlist');  // sul telefono solo l'artista
  $('#disc').innerHTML = t && t.coverArt && srv(t.serverId) ? `<img src="${esc(coverUrl(t.coverArt, 80, t.serverId))}" alt="" onerror="this.outerHTML='<div class=lbl></div>'">` : '<div class="lbl"></div>';
  // telecomando: sotto il titolo il dispositivo che suona (come la riga verde di Spotify)
  if (t && Live.remote()) { $('#npA').innerHTML = `<span class="ondev">${ic('speaker')}${esc(Live.devices.get(Live.target) || 'Altro dispositivo')}</span>`; }
  // il mini lettore del telefono prende il colore della copertina
  const mu = t?.coverArt && srv(t.serverId) ? coverUrl(t.coverArt, 80, t.serverId) : '';
  Glow.colors(mu).then(c => { if (!sameTrack(currentTrack(), t)) return; $('#player').style.setProperty('--mini', c && Glow.usable(c) ? Glow.tone(c.c1, .6, c.neutral) : 'transparent'); });
  document.title = t ? `${t.title} · ${t.artist}` : 'Armony';
  Glow.track(t);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = t ? new MediaMetadata({ title: t.title, artist: t.artist, album: t.album,
      artwork: t.coverArt && srv(t.serverId) ? [{ src: coverUrl(t.coverArt, 512, t.serverId), sizes: '512x512' }] : [] }) : null;
  }
  paintButtons(); NativeMedia.sync(); Live.publish(); paintStar();
}
function paintButtons() {
  const playing = isPlaying();
  const bp = $('#bPlay');
  if (!bp.querySelector('.pp')) bp.innerHTML = '<svg class="pp" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path/><path/></svg>';
  bp.querySelectorAll('.pp path').forEach((p, i) => p.setAttribute('d', PP[playing ? 'pause' : 'play'][i]));
  bp.classList.toggle('on', playing);
  document.documentElement.dataset.playing = playing;  // le barre del brano in riproduzione ballano solo mentre suona
  bp.setAttribute('aria-label', playing ? 'Pausa' : 'Riproduci');
  $('#disc').classList.toggle('spin', playing);
  $('#bigdisc')?.classList.toggle('spin', playing);
  // sul telefono il mini lettore ha una copertina quadrata e ferma: l'animazione (Web Animations) scavalcherebbe il CSS
  if (matchMedia('(max-width:860px)').matches) { const d = $('#disc'); d._spin?.cancel(); d._spin = null; d._to = null; } else Turntable.set($('#disc'), playing);
  Turntable.set($('#bigdisc .rec'), playing); Wave.set(playing);
  const rs = Live.remote() ? Live.st() : null, shuf = rs ? !!rs.shuffle : S.shuffle, rep = rs ? rs.repeat || 'off' : S.repeat;
  $('#bShuf').innerHTML = ic('shuffle'); $('#bShuf').classList.toggle('on', shuf);
  $('#bRep').innerHTML = ic('repeat') + (rep === 'one' ? '<span class="mini">1</span>' : '');
  $('#bRep').classList.toggle('on', rep !== 'off');
  $('#bRep').title = { off: 'Ripeti: no', all: 'Ripeti: tutta la coda', one: 'Ripeti: questo brano' }[rep];
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  NativeMedia.sync(); Live.publish();
}
let seeking = false;
const rangeFill = el => {
  if (!el) return; const p = ((el.value - (el.min || 0)) / ((el.max || 100) - (el.min || 0)) * 100) + '%'; el.style.setProperty('--p', p);
  if (el.id === 'seek') { Wave.draw(); $('#player').style.setProperty('--pp', p); }  // linea sottile del lettore piccolo
};
/* barra di avanzamento a onda, come i controlli multimediali di Android: la parte ascoltata è un'onda
   morbida che scorre mentre suona, somma di tre sinusoidi con lunghezze e velocità che non si ripetono
   insieme; in pausa si spegne in una linea dritta. Il disegno gira solo mentre serve. */
const Wave = {
  cv: null, g: null, amp: 0, target: 0, t: 0, last: 0, raf: 0, w: 0, h: 0, col: {},
  // lunghezza d'onda (px), velocità (rad/ms), fase, peso: valori senza multipli comuni, così il disegno non torna mai uguale
  parts: [[38, .0034, 0, .55], [23, -.0051, 1.7, .28], [61, .0019, 3.1, .3]],
  init() {
    this.cv = $('#seekWave'); if (!this.cv) return;
    this.g = this.cv.getContext('2d');
    new ResizeObserver(() => this.size()).observe(this.cv);
    const recolor = () => { this.colors(); this.draw(); };
    new MutationObserver(recolor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', recolor);
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => this.set(isPlaying()));
    document.addEventListener('visibilitychange', () => this.kick());
    this.colors(); this.size();
  },
  // la parte da ascoltare: --surface2 schiarita verso --muted, perché sul fondo del lettore da sola quasi sparisce
  colors() {
    const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
    const rgb = h => (h.match(/^#([0-9a-f]{6})$/i) ? [0, 2, 4].map(i => parseInt(h.slice(1 + i, 3 + i), 16)) : null);
    const [a, m] = [rgb(v('--surface2')), rgb(v('--muted'))];
    this.col = { on: v('--accent'), off: a && m ? `rgb(${a.map((x, i) => Math.round(x * .7 + m[i] * .3)).join(' ')})` : v('--surface2') };
  },
  size() {
    const r = this.cv.getBoundingClientRect(), d = devicePixelRatio || 1;
    this.w = r.width; this.h = r.height; this.cv.width = Math.round(r.width * d); this.cv.height = Math.round(r.height * d);
    this.g.setTransform(d, 0, 0, d, 0, 0); this.draw();
  },
  set(playing) { this.target = playing && !calm() ? 1 : 0; if (calm()) this.amp = this.target; this.kick(); },
  kick() {
    if (this.raf || document.hidden || (this.amp === 0 && this.target === 0)) return this.draw();
    this.last = performance.now(); this.raf = requestAnimationFrame(n => this.frame(n));
  },
  frame(now) {
    const dt = Math.min(now - this.last, 50); this.last = now; this.t += dt;
    // ampiezza verso l'obiettivo con un'uscita morbida: ~400 ms per spegnersi o riaccendersi
    this.amp += (this.target - this.amp) * (1 - Math.exp(-dt / 110));
    if (Math.abs(this.target - this.amp) < .004) this.amp = this.target;
    this.draw();
    this.raf = document.hidden || (this.amp === 0 && this.target === 0) ? 0 : requestAnimationFrame(n => this.frame(n));
  },
  draw() {
    const { g, w, h } = this; if (!g || !w) return;
    const s = $('#seek'), p = s ? s.value / 1000 : 0, r = 7, x0 = r, x1 = w - r, px = x0 + p * (x1 - x0), y = h / 2, A = 3.2 * this.amp;
    g.clearRect(0, 0, w, h); g.lineCap = 'round'; g.lineJoin = 'round';
    g.lineWidth = 3; g.strokeStyle = this.col.off; g.beginPath(); g.moveTo(Math.min(px + r, x1), y); g.lineTo(x1, y); if (px + r < x1) g.stroke();
    if (px <= x0) return;
    g.lineWidth = 3.5; g.strokeStyle = this.col.on; g.beginPath();
    // ogni componente respira lentamente con un suo ritmo: le onde restano dolci e non sincronizzate
    const k = this.parts.map(([l, v, f, a], i) => [2 * Math.PI / l, v * this.t + f, a * (.75 + .25 * Math.sin(this.t * (.0006 + i * .00023) + f))]);
    for (let x = x0; x <= px; x += 1.5) {
      const env = Math.min(1, (x - x0) / 10, (px - x) / 10 + .15);  // l'onda nasce dal bordo e si posa sotto il pomello
      let o = 0; for (const [kk, ph, a] of k) o += Math.sin(x * kk - ph) * a;
      x === x0 ? g.moveTo(x, y + o * A * env) : g.lineTo(x, y + o * A * env);
    }
    g.lineTo(px, y); g.stroke();
  }
};
function paintTime() {
  const d = playDur(), p = playPos();
  // a schermo spento niente barra, onda e testi da ridisegnare: solo posizione per il sistema, l'app e gli altri dispositivi
  if (document.hidden) {
    if ('mediaSession' in navigator && d && navigator.mediaSession.setPositionState) { try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(p, d), playbackRate: P.speed }); } catch {} }
    NativeMedia.sync(); Live.publish(); return;
  }
  if (!seeking) { $('#seek').value = d ? p / d * 1000 : 0; $('#tCur').textContent = fmt(p); }
  rangeFill($('#seek'));
  $('#tDur').textContent = fmt(d);
  if ('mediaSession' in navigator && d && navigator.mediaSession.setPositionState) {
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(p, d), playbackRate: P.speed }); } catch {}
  }
  NativeMedia.sync(); Live.publish();
}
Bus.addEventListener('time', paintTime);

/* ================= coda sincronizzata tra dispositivi ================= */
const QSync = {
  t: null,
  // un dispositivo fermato perché suona un altro (o che fa da telecomando) non salva: vincerebbe sulla coda di chi suona
  schedule() { if (!P.syncQueue || Jam.role === 'guest' || Radio.st || Live.target) return; clearTimeout(this.t); this.t = setTimeout(() => this.push(), 4000); },
  // last: l'app si sta chiudendo (pagehide): keepalive, così la richiesta parte anche a pagina chiusa
  async push(last) {
    const cur = S.queue[S.index]; if (!cur || !srv(cur.serverId) || srv(cur.serverId).local || Live.target) return;
    const ids = S.queue.filter(x => x.serverId === cur.serverId).slice(0, 1000).map(x => x.id);
    const params = { id: ids, current: cur.id, position: Math.floor(Engine.time() * 1000) };
    this.at = Date.now();
    try {
      if (last) fetch(apiBase(srv(cur.serverId), 'savePlayQueue'), { method: 'POST', body: apiParams(srv(cur.serverId), params), keepalive: true }).catch(() => {});
      else await api('savePlayQueue', params, srv(cur.serverId), true);
      store.set('qsyncSaved', Date.now());
    } catch {}
  },
  async check() {
    if (!P.syncQueue || !srv()) return null;
    try {
      const pq = (await api('getPlayQueue')).playQueue; if (!pq || !arr(pq.entry).length) return null;
      const changed = Date.parse(pq.changed || 0);
      if (pq.changedBy === S.device || changed <= store.get('qsyncSeen', 0) || changed <= store.get('qsyncSaved', 0)) return null;
      const tracks = arr(pq.entry).map(x => norm(x)); const index = Math.max(0, tracks.findIndex(x => x.id === pq.current));
      if (S.queue[S.index] && S.queue[S.index].id === pq.current) return null;
      store.set('qsyncSeen', changed);
      return { tracks, index, current: tracks[index], position: (pq.position || 0) / 1000, by: (pq.changedBy || '').replace(/^armony-/, 'dispositivo ') };
    } catch { return null; }
  }
};

/* ================= amici ================= */
async function friendsNow() {
  const s = srv(); if (!s) return [];
  try {
    return arr((await api('getNowPlaying')).nowPlaying?.entry).filter(e => e.username !== s.user && (e.minutesAgo ?? 0) <= 10).map(e => ({ ...norm(e), username: e.username, minutesAgo: e.minutesAgo, player: e.playerName }));
  } catch { return []; }
}
async function vFriends() {
  if (!srv()) return noServer();
  const n = Scene.nav, live = Presence.on();
  view.innerHTML = `<h1>Amici</h1><p class="sub">${live ? 'Chi ascolta cosa' : 'Chi sta ascoltando cosa'} su ${esc(srv().name)}, in tempo reale.</p>${live
    ? `<h2 class="pf-h">In ascolto ora</h2><div class="pnow" id="presNow" data-pres></div><h2>Attività</h2><div class="pfeed" id="presFeed" data-pres></div>` : '<div id="fl"></div>'}
    <h2>Jam vicine</h2><div id="fj"><p class="sub">Cerco…</p></div>
    ${Amici.on() ? '<h2>Il vostro mix</h2><div id="fBlend"></div><h2>Ricevuti</h2><div id="fRic"></div>' : ''}`;
  if (Amici.on()) { Amici.blendBox($('#fBlend')); Amici.ricevuti($('#fRic'), n); }
  // con la presenza (stesso canale di Live) tutto arriva da solo; senza, getNowPlaying ogni 15 secondi
  const paint = live ? async () => Presence.paintView() : async () => {
    const list = await friendsNow(); const box = $('#fl'); if (!box) return;
    S.lastList = list;
    box.innerHTML = list.length ? list.map((f, i) => `<div class="list-item" style="cursor:default">
      <span class="pic">${imgTag(f.coverArt, 100, f.serverId)}</span>
      <span class="grow"><b>${esc(f.username)}</b><small>${esc(f.title)} · ${esc(f.artist)}${f.minutesAgo ? `, ${f.minutesAgo} min fa` : ', adesso'}</small></span>
      <button class="btn sm" data-act="play1" data-i="${i}">${ic('play')} Ascolta</button>
      <button class="icon-btn" data-act="more" data-i="${i}" aria-label="Altre azioni">${ic('more')}</button></div>`).join('')
      : '<div class="empty">Nessun amico sta ascoltando in questo momento.</div>';
  };
  await paint(); if (stale(n)) return; viewInterval(paint, 15000);
  Jam.nearby().then(js => { const b = $('#fj'); if (b) b.innerHTML = js.length ? js.map(j => `<div class="list-item" data-act="jamknock" data-id="${esc(j.id)}" data-base="${esc(j.base || '')}"><span class="pic" style="display:grid;place-items:center">${ic('jam')}</span><span class="grow"><b>${esc(j.name)}</b><small>di ${esc(j.hostName || '?')}${j.server ? ', sul server ' + esc(j.server) : ''}</small></span><span class="btn sm">Chiedi di entrare</span></div>`).join('') : '<div class="empty">Nessuna Jam aperta sulla tua rete.</div>'; });
}

/* ================= la luce del disco: i colori della copertina illuminano la stanza =================
   Due colori (dominante e secondario) da un canvas 32×32 della copertina. La luce sta in #glow, fisso dietro
   ai contenuti e acceso solo su "In riproduzione", album e artista; il lettore ne tiene una traccia sulla barra.
   I colori sono variabili CSS registrate con @property, così il cambio di brano sfuma invece di scattare. */
function pickColors(d) {
  const B = Array.from({ length: 13 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));  // 12 tinte da 30° + i grigi
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    const sat = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
    let k = 12, w = .05;
    if (sat > .15 && l > .08 && l < .92) {
      const h = mx === r ? ((g - b) / (mx - mn) + 6) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
      k = Math.floor(h * 2) % 12; w = sat * (1 - Math.abs(l - .5)) + .05;
    }
    const e = B[k]; e.w += w; e.r += d[i] * w; e.g += d[i + 1] * w; e.b += d[i + 2] * w;
  }
  const avg = e => [e.r / e.w, e.g / e.w, e.b / e.w].map(Math.round);
  const hues = B.slice(0, 12).map((e, k) => ({ e, k })).filter(x => x.e.w > 0).sort((a, b) => b.e.w - a.e.w);
  const total = B.reduce((n, e) => n + e.w, 0); if (!total) return null;
  // copertina quasi senza colore (bianco e nero): una luce neutra, tenue
  if (!hues.length || hues[0].e.w < total * .08) { const c = avg(B[12]); return { c1: c, c2: c, neutral: true }; }
  const d1 = hues[0], d2 = hues.find(x => Math.min(Math.abs(x.k - d1.k), 12 - Math.abs(x.k - d1.k)) >= 2 && x.e.w > d1.e.w * .15) || d1;
  return { c1: avg(d1.e), c2: avg(d2.e) };
}
const lumOf = hex => { const h = hex.trim().replace('#', ''); const f = v => (v /= 255) <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, d / (1 - Math.abs(2 * l - 1)), l];
}
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map(v => Math.round((v + m) * 255));
}
const Glow = {
  cache: new Map(), tok: 0,
  colors(url) {
    if (!url) return Promise.resolve(null);
    if (!this.cache.has(url)) this.cache.set(url, new Promise(res => {
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => {
        // una copertina di un altro dominio senza CORS "contamina" il canvas: niente luce, nessun errore
        try { const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, 32, 32); res(pickColors(x.getImageData(0, 0, 32, 32).data)); }
        catch { res(null); }
      };
      img.onerror = () => res(null); img.src = url;
    }));
    return this.cache.get(url);
  },
  // adatta il colore al tema e abbassa la luce finché testo, testo secondario e link restano AA (4,5:1) sul fondo
  // illuminato; un colore già sotto AA sul fondo normale perde al massimo il 12%
  tone(c, a0, neutral) {
    const cs = getComputedStyle(document.documentElement), hx = v => { const h = cs.getPropertyValue(v).trim().replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
    const lum = ([r, g, b]) => { const f = v => (v /= 255) <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
    const ratio = (x, y) => { const [a, b] = [lum(x), lum(y)].sort((m, n) => n - m); return (a + .05) / (b + .05); };
    const bg = hx('--bg'), texts = ['--ink', '--muted', '--accent-text'].map(hx), dark = lum(bg) < .2;
    let [h, sat, l] = rgbToHsl(c);
    // una luce deve essere più chiara della stanza: sul blu notte anche una copertina blu scura deve vedersi
    sat = neutral ? Math.min(sat, .1) : Math.min(Math.max(sat, .45), .8); l = dark ? Math.min(Math.max(l, .48), .62) : Math.min(Math.max(l, .66), .8);
    const rgb = hslToRgb(h, sat, l), on = a => bg.map((v, i) => v * (1 - a) + rgb[i] * a);
    const need = texts.map(t => { const r = ratio(t, bg); return r >= 4.5 ? 4.5 : r * .88; });
    let a = neutral ? a0 * .5 : a0;
    while (a > .08 && texts.some((t, i) => ratio(t, on(a)) < need[i])) a -= .02;
    return `rgb(${rgb.join(' ')} / ${a.toFixed(2)})`;
  },
  // la luce della stanza: 'ora' (dietro al disco) o 'album' (dietro alla copertina dell'intestazione)
  async show(url, where) {
    const tok = ++this.tok, el = $('#glow'); if (!el) return;
    const c = await this.colors(url);
    if (tok !== this.tok) return;  // nel frattempo è cambiata pagina o brano
    if (!this.usable(c)) return this.off();
    el.style.setProperty('--g1', this.tone(c.c1, .5, c.neutral));
    el.style.setProperty('--g2', this.tone(c.c2, .34, c.neutral));
    document.documentElement.dataset.glow = where;
  },
  off() { this.tok++; delete document.documentElement.dataset.glow; },
  // una copertina senza colore nel tema chiaro darebbe una macchia grigia, non una luce
  usable(c) { return !!c && (!c.neutral || lumOf(getComputedStyle(document.documentElement).getPropertyValue('--bg')) < .2); },
  // la traccia nel lettore: il colore del brano in riproduzione sulla barra di avanzamento
  async track(t) {
    const url = t && t.coverArt && srv(t.serverId) ? coverUrl(t.coverArt, 300, t.serverId) : '';
    const c = await this.colors(url), seek = $('#seekWave'); if (!seek || !sameTrack(currentTrack(), t)) return;
    if (this.usable(c)) seek.style.setProperty('--tint', this.tone(c.c1, .9, c.neutral)); else seek.style.removeProperty('--tint');
  }
};
addEventListener('hashchange', () => { if (!/^#\/(ora|album|artista)/.test(location.hash)) Glow.off(); });

/* ================= testi a tutta pagina (#/testo), come Spotify =================
   Il colore della copertina come fondo, righe grandi: quella cantata in piena luce e più grande, le passate attenuate,
   le prossime più scure. Scorre da sola; se scorri tu si ferma qualche secondo. Toccando una riga si salta lì */
function lyrBg(c) {
  if (!c) return '';
  let [h, s] = rgbToHsl(c.c1);
  s = c.neutral ? Math.min(s, .08) : Math.min(Math.max(s, .35), .62);
  return `rgb(${hslToRgb(h, s, c.neutral ? .26 : .33).join(' ')})`;  // abbastanza scuro per il testo bianco (AA)
}
function lyrTint(el, t) {
  const url = t.coverArt && srv(t.serverId) ? coverUrl(t.coverArt, 300, t.serverId) : '';
  Glow.colors(url).then(c => { const v = lyrBg(c); if (!v || !sameTrack(currentTrack(), t)) return; el?.style.setProperty('--lyr-bg', v); if (location.hash.startsWith('#/testo')) document.documentElement.style.setProperty('--lyr-bg', v); });
}
function lyrIndex(lyr, t) {
  if (!lyr?.synced) return -1;
  const p = playPos() + store.get('lyrOff:' + key(t), 0);
  let idx = -1; for (let i = 0; i < lyr.lines.length; i++) { if (lyr.lines[i].t <= p) idx = i; else break; }
  return idx;
}
// l'anteprima della scheda «Testo» in «In riproduzione» (telefono): la riga cantata e le tre dopo
function lyrPreview(lyr, t, force) {
  const box = $('#lyrPrev'); if (!box) return;
  const idx = lyrIndex(lyr, t); if (!force && box._i === idx) return; box._i = idx;
  const from = Math.max(0, idx), ls = lyr.lines.slice(from, from + 4).filter(l => l.v);
  box.innerHTML = ls.map((l, k) => `<span class="${k === 0 && idx >= 0 ? 'on' : ''}">${esc(l.v)}</span>`).join('');
}
async function vLyrics() {
  const t = currentTrack();
  if (!t) { location.replace('#/ora'); return; }
  const cover = t.coverArt && srv(t.serverId) ? coverUrl(t.coverArt, 300, t.serverId) : '';
  Glow.off(); document.documentElement.style.removeProperty('--lyr-bg');
  view.innerHTML = `<div class="lyrpage" id="lyrPage">
    <div class="lyrhead"><button class="icon-btn" data-act="lyrclose" aria-label="Chiudi il testo">${ic('chev')}</button>
      <span class="pic">${cover ? `<img src="${esc(cover)}" alt="">` : ic('album')}</span>
      <span class="grow"><b>${esc(t.title)}</b><small>${esc(t.artist)}</small></span></div>
    <div class="lyrbig" id="lyrBig"><p class="lyrmsg">Cerco il testo…</p></div><div class="lyrfoot" id="lyrFoot"></div></div>`;
  lyrTint($('#lyrPage'), t); lyrFit();
  const lyr = await Lyrics.get(t);
  const box = $('#lyrBig');
  if (!box || !sameTrack(currentTrack(), t)) return;
  if (!lyr || lyr.instrumental) {
    box.innerHTML = `<p class="lyrmsg">${lyr ? 'Brano strumentale.' : `Nessun testo per questo brano.${P.lyricsOnline ? '' : ' Attiva la ricerca online dei testi nelle impostazioni.'}`}</p>`;
    return;
  }
  box.classList.toggle('plain', !lyr.synced);
  box.innerHTML = lyr.lines.map((l, i) => `<p data-i="${i}">${esc(l.v) || '♪'}</p>`).join('');
  const off = () => store.get('lyrOff:' + key(t), 0);
  $('#lyrFoot').innerHTML = `<span>Fonte: ${esc(lyr.src || '')}</span>${lyr.synced ? `<span class="row">Sincronia <button class="btn sm" data-off="-0.5" aria-label="Testo prima di mezzo secondo">−0,5</button><span id="offv">${off().toFixed(1)} s</span><button class="btn sm" data-off="0.5" aria-label="Testo dopo mezzo secondo">+0,5</button></span>` : ''}`;
  if (!lyr.synced) return;
  $$('#lyrFoot [data-off]').forEach(b => b.onclick = () => { const v = +(off() + +b.dataset.off).toFixed(1); store.set('lyrOff:' + key(t), v); $('#offv').textContent = v.toFixed(1) + ' s'; });
  box.onclick = e => { const p = e.target.closest('p[data-i]'); if (p && lyr.lines[+p.dataset.i].t != null) { held = 0; ctlSeek(lyr.lines[+p.dataset.i].t - off() + .05); } };
  // scorrere a mano ferma lo scorrimento automatico per 3,5 s, poi torna alla riga cantata
  let last = -2, held = 0, wait = false;
  const hold = () => { held = Date.now() + 3500; wait = true; };
  ['wheel', 'touchmove'].forEach(ev => box.addEventListener(ev, hold, { passive: true }));
  const ps = [...box.children];
  const tick = () => {
    if (!box.isConnected) return;
    const idx = lyrIndex(lyr, t), free = Date.now() > held;
    if (idx !== last || (wait && free)) {
      if (idx !== last) ps.forEach((el, i) => { el.classList.toggle('on', i === idx); el.classList.toggle('past', i < idx); });
      last = idx;
      if (free) { wait = false; const el = ps[Math.max(0, idx)]; if (el) box.scrollTo({ top: el.offsetTop - box.clientHeight * .3, behavior: calm() ? 'auto' : 'smooth' }); }
    }
    requestAnimationFrame(tick);
  };
  tick();
}
addEventListener('hashchange', () => { if (!location.hash.startsWith('#/testo')) document.documentElement.style.removeProperty('--lyr-bg'); if (!location.hash.startsWith('#/ora')) document.documentElement.style.removeProperty('--np-bg'); });
// telefono, «In riproduzione»: la pagina non scorre, e trascinandola verso il basso si chiude (come Spotify)
(() => {
  let y0 = null, x0 = 0, dy = 0;
  const on = () => document.documentElement.dataset.r === 'ora' && matchMedia('(max-width:860px)').matches;
  const reset = () => { view.style.transform = view.style.opacity = view.style.transition = ''; };
  view.addEventListener('touchstart', e => { if (!on() || e.touches.length > 1 || e.target.closest('input,textarea,select')) return; y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; dy = 0; }, { passive: true });
  view.addEventListener('touchmove', e => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (dy <= 0 || Math.abs(e.touches[0].clientX - x0) > dy) { dy = 0; reset(); return; }
    view.style.transition = 'none'; view.style.transform = `translateY(${Math.round(dy * .8)}px)`; view.style.opacity = String(1 - Math.min(.4, dy / 900));
  }, { passive: true });
  view.addEventListener('touchend', () => {
    if (y0 == null) return; y0 = null;
    if (dy > 110) {
      view.style.transition = 'transform .2s var(--ease-out), opacity .2s'; view.style.transform = 'translateY(60vh)'; view.style.opacity = '0';
      setTimeout(() => { reset(); Scene.back ? history.back() : (location.hash = '#/home'); }, 170);
    } else if (dy) { view.style.transition = 'transform .25s var(--ease-out), opacity .25s'; view.style.transform = ''; view.style.opacity = ''; setTimeout(reset, 260); }
    dy = 0;
  });
})();
function lyrFit() {
  const pg = $('#lyrPage'); if (!pg) return;
  if (!matchMedia('(max-width:860px)').matches) { pg.style.height = ''; return; }
  pg.style.height = Math.max(240, $('#player').getBoundingClientRect().top - pg.getBoundingClientRect().top) + 'px';
}
new ResizeObserver(() => lyrFit()).observe($('#player'), { box: 'border-box' }); addEventListener('resize', lyrFit);

/* ================= in riproduzione: testi e visualizzatore ================= */
async function vNow() {
  const t = currentTrack();
  if (!t) { Glow.off(); view.innerHTML = '<div class="empty"><h3>Niente in riproduzione</h3><p>Scegli qualcosa da ascoltare.</p><a class="btn primary" href="#/home">Vai alla home</a></div>'; return; }
  Glow.show(t.coverArt && srv(t.serverId) ? coverUrl(t.coverArt, 300, t.serverId) : '', 'ora');
  // telefono, come Spotify: lo sfondo prende il colore della copertina (scuro, il testo resta bianco)
  Glow.colors(t.coverArt && srv(t.serverId) ? coverUrl(t.coverArt, 300, t.serverId) : '').then(c => { const v = lyrBg(c); if (v && sameTrack(currentTrack(), t) && location.hash.startsWith('#/ora')) document.documentElement.style.setProperty('--np-bg', v); });
  const tab = sessionStorage.getItem('armony:nowtab') || 'lyr';
  const cx = Live.remote() ? { kind: 'Su', name: Live.devices.get(Live.target) || '' } : Jam.role ? { kind: 'Jam', name: Jam.room?.name || '' } : Radio.st ? { kind: 'Radio', name: Radio.st.name } : S.ctx || store.get('qctx', null);
  view.innerHTML = `<div class="now"><div class="np-head mobile-only">
      <button class="icon-btn" data-act="npclose" aria-label="Chiudi il lettore">${ic('chev')}</button>
      <div class="np-ctx">${cx?.name ? `<small>${cx.kind ? 'In riproduzione da ' + esc(cx.kind.toLowerCase()) : 'In riproduzione'}</small>${cx.hash ? `<a href="${esc(cx.hash)}">${esc(cx.name)}</a>` : `<b>${esc(cx.name)}</b>`}` : '<small>In riproduzione</small>'}</div>
      <button class="icon-btn" data-act="nowtools" aria-label="Altre azioni">${ic('more')}</button></div><div>
      <div class="np-art mobile-only">${t.coverArt && srv(t.serverId) ? `<img src="${esc(coverUrl(t.coverArt, 600, t.serverId))}" alt="">` : `<span>${ic('album')}</span>`}</div>
      <div class="bigdisc ${isPlaying() ? 'spin' : ''}" id="bigdisc"><canvas id="viz" width="640" height="640"></canvas>
        <div class="rec">${t.coverArt && srv(t.serverId) ? `<img src="${esc(coverUrl(t.coverArt, 600, t.serverId))}" alt="">` : '<div class="lbl"></div>'}</div></div>
      <div class="now-title"><h1>${esc(t.title)}</h1><button class="icon-btn now-star" id="nowStar" aria-label="Preferito"></button></div>
      <p class="sub now-meta">${t.artists ? t.artists.map(a => `<a class="ar" href="#/artista/${encodeURIComponent(a.id)}">${esc(a.name)}</a>`).join(', ') : t.artistId ? `<a href="#/artista/${encodeURIComponent(t.artistId)}">${esc(t.artist)}</a>` : esc(t.artist)}${t.album ? ` · ${t.albumId ? `<a href="#/album/${encodeURIComponent(t.albumId)}">${esc(t.album)}</a>` : esc(t.album)}` : ''}</p>
      <div class="row now-acts">
        <button class="btn sm" data-act="nowmore">${ic('more')} Azioni</button>
        <button class="btn sm" data-act="sleep">${ic('moon')} Timer</button>
        <button class="btn sm" data-act="speed">${ic('speed')} ${P.speed}×</button>
        <button class="btn sm" data-act="eq">${ic('sliders')} Equalizzatore</button>
        ${Jam.role ? `<a class="btn sm" href="#/jam">${ic('jam')} Jam</a>` : ''}${Radio.st ? `<a class="btn sm" href="#/radio">${ic('radio')} ${esc(Radio.st.name)}</a>` : ''}
      </div>
    </div>
    <div><div class="tabs">${[['lyr', 'Testi'], ['next', 'Prossimi'], ['info', 'Dettagli']].map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div><div id="nowPane"></div></div></div>`;
  view.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { sessionStorage.setItem('armony:nowtab', b.dataset.tab); vNow(); });
  $('#nowStar').onclick = () => toggleStar(currentTrack()); paintStar();
  Turntable.set($('#bigdisc .rec'), isPlaying(), true);  // il disco grande nasce già alla velocità del piccolo
  const pane = $('#nowPane');
  let lyr = null;
  // disco e testi partono subito: il testo, quando arriva dalla rete, entra nel giro già in corso
  const canvas = $('#viz'), c2 = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const buf = Engine.analyser ? new Uint8Array(Engine.analyser.frequencyBinCount) : null;
  let lastLine = -1;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const loop = () => {
    if (!document.contains(canvas)) return;
    c2.clearRect(0, 0, 640, 640);
    const here = buf && !Live.remote() && Jam.mode !== 'broadcast' && !Engine.el.paused;
    if (P.visualizer && !reduce && isPlaying() && (here || Live.remote() || broadcastGuest() || !buf)) {
      if (here) Engine.analyser.getByteFrequencyData(buf);
      const N = 96; c2.strokeStyle = accent; c2.lineWidth = 4; c2.lineCap = 'round';
      for (let i = 0; i < N; i++) {
        // senza audio qui: onde dolci sfasate (stessa forma, ampiezza più bassa), legate alla posizione del brano
        const ph = playPos() * 2.2, v = here ? buf[Math.floor(Math.pow(i / N, 1.6) * buf.length * .75)] / 255
          : .18 + .16 * Math.sin(ph + i * .37) * Math.sin(ph * .61 + i * .13) + .1 * Math.sin(ph * 1.7 + i * .9) ** 2;
        const ang = i / N * Math.PI * 2 - Math.PI / 2, r1 = 255, r2 = r1 + 8 + v * 52;
        c2.globalAlpha = .35 + v * .65;
        c2.beginPath(); c2.moveTo(320 + Math.cos(ang) * r1, 320 + Math.sin(ang) * r1); c2.lineTo(320 + Math.cos(ang) * r2, 320 + Math.sin(ang) * r2); c2.stroke();
      }
      c2.globalAlpha = 1;
    }
    if (lyr && $('#lyrPrev')) lyrPreview(lyr, t);
    if (lyr?.synced && $('#lyr')) {
      const p = playPos() + store.get('lyrOff:' + key(t), 0);
      let idx = -1; for (let i = 0; i < lyr.lines.length; i++) { if (lyr.lines[i].t <= p) idx = i; else break; }
      if (idx !== lastLine) {
        lastLine = idx; const ps = $$('#lyr p'); ps.forEach((el, i) => el.classList.toggle('on', i === idx));
        const el = ps[idx]; if (el) { const box = $('#lyr'); box.scrollTop = el.offsetTop - box.clientHeight * .35; }
      }
    }
    requestAnimationFrame(loop);
  };
  loop();
  if (tab === 'lyr') {
    pane.innerHTML = '<p class="sub">Cerco il testo…</p>';
    lyr = await Lyrics.get(t);
    if (!sameTrack(currentTrack(), t) || !$('#nowPane')) return;
    if (!lyr || lyr.instrumental) {
      // senza testo, al suo posto i prossimi brani: niente mezzo schermo vuoto
      const up = Jam.role === 'guest' ? Jam.queue.slice(0, 12) : Radio.st ? Radio.next() : Live.remote() ? arr(Live.st()?.next).slice(0, 12).map(w => Live.loc(w)).filter(Boolean) : S.queue.slice(S.index + 1, S.index + 13);
      pane.innerHTML = `<p class="sub">${lyr ? 'Brano strumentale.' : `Nessun testo per questo brano.${P.lyricsOnline ? '' : ' Attiva la ricerca online dei testi nelle impostazioni.'}`}</p>
        ${up.length ? `<h2 style="margin-top:8px">Prossimi</h2>${songList(up)}` : ''}`;
      if (up.length && Jam.role !== 'guest' && !Radio.st && !Live.remote()) { S.lastList = up; pane.querySelectorAll('.song').forEach(el => el.dataset.act = 'qplayoff'); }
    }
    else if (matchMedia('(max-width:860px)').matches) {
      // sul telefono, come Spotify: una scheda con le righe di adesso; toccandola il testo si apre a tutta pagina
      pane.innerHTML = `<button class="lyrcard" data-act="lyropen" aria-label="Apri il testo a tutta pagina"><span class="lyrcard-h"><b>Testo</b>${ic('chevr')}</span><span class="lyrcard-l" id="lyrPrev"></span></button>`;
      lyrTint($('.lyrcard'), t); lyrPreview(lyr, t, true);
    }
    else {
      const off = store.get('lyrOff:' + key(t), 0);
      pane.innerHTML = `<button class="btn sm lyrfull" data-act="lyropen">${ic('lyrics')} Testo a tutta pagina</button><div class="lyrics ${lyr.synced ? '' : 'plain'}" id="lyr">${lyr.lines.map((l, i) => `<p data-i="${i}">${esc(l.v) || '&nbsp;'}</p>`).join('')}</div>
        <div class="row between small" style="color:var(--muted)"><span>Fonte: ${esc(lyr.src || '')}</span>${lyr.synced ? `<span class="row">Sincronia <button class="btn sm" data-off="-0.5">−0,5 s</button><span id="offv">${off.toFixed(1)} s</span><button class="btn sm" data-off="0.5">+0,5 s</button></span>` : ''}</div>`;
      if (lyr.synced) {
        $('#lyr').onclick = e => { const p = e.target.closest('p'); if (p) ctlSeek(lyr.lines[+p.dataset.i].t - store.get('lyrOff:' + key(t), 0) + .05); };
        pane.querySelectorAll('[data-off]').forEach(b => b.onclick = () => { const v = +(store.get('lyrOff:' + key(t), 0) + +b.dataset.off).toFixed(1); store.set('lyrOff:' + key(t), v); $('#offv').textContent = v.toFixed(1) + ' s'; });
      }
    }
  } else if (tab === 'next') {
    const remote = Live.remote();
    const up = Jam.role === 'guest' ? Jam.queue.slice(0, 25) : Radio.st ? Radio.next() : remote ? arr(Live.st()?.next).map(w => Live.loc(w)).filter(Boolean) : S.queue.slice(S.index + 1, S.index + 26);
    pane.innerHTML = up.length ? songList(up) : '<div class="empty">Non c\'è altro in coda.</div>';
    if (Jam.role !== 'guest' && !Radio.st) S.lastList = up, pane.querySelectorAll('.song').forEach(el => el.dataset.act = remote ? 'qremote' : 'qplayoff');
  } else {
    const s = srv(t.serverId);
    let raw = null; try { raw = s && (await api('getSong', { id: t.id }, s)).song; } catch {}
    const rows = [['Server', s?.name || 'non configurato'], ['Formato originale', raw ? `${(raw.suffix || '').toUpperCase()}, ${raw.bitRate || '?'} kbps${raw.samplingRate ? ', ' + (raw.samplingRate / 1000) + ' kHz' : ''}${raw.bitDepth ? ', ' + raw.bitDepth + ' bit' : ''}` : '?'],
      ['Ascolto attuale', Offline.has(t) ? 'Dal dispositivo (offline)' : QUALITIES[activeQuality()].label], ['Genere', t.genre || raw?.genre || '—'], ['Anno', t.year || raw?.year || '—'],
      ['Normalizzazione', t.rg ? `brano ${t.rg.trackGain ?? '—'} dB, album ${t.rg.albumGain ?? '—'} dB` : 'nessun dato ReplayGain'],
      ['Ascolti tuoi', raw?.playCount ?? '—'], ['File', raw?.path || '—']];
    // ascolti di tutti gli utenti del server e indice di popolarità di Deezer (capacità "ascolti", server/ascolti.py)
    if (s?.me?.caps?.includes('ascolti') && !t.fed) {
      const a = await srvApi(s, '/api/ascolti/brano?dz=1&id=' + encodeURIComponent(t.id)).catch(() => null);
      if (a) rows.splice(rows.length - 1, 0, ['Ascolti sul server', `${a.total.toLocaleString('it-IT')}${a.users.length ? ' · ' + a.users.map(u => `${u.name} ${u.plays}`).join(', ') : ''}${a.hidden ? ` · altri ${a.hidden}` : ''}`],
        ...(a.deezer?.rank ? [['Popolarità su Deezer', `${a.deezer.rank.toLocaleString('it-IT')} (indice da 0 a 1.000.000, non il numero di stream)`]] : []));
      if (!sameTrack(currentTrack(), t) || !$('#nowPane')) return;
    }
    pane.innerHTML = `<div id="origBox"></div><div class="panel">${rows.map(([a, b]) => `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line);flex-wrap:nowrap;gap:16px"><span style="color:var(--muted)">${a}</span><span style="text-align:right;word-break:break-word">${esc(b)}</span></div>`).join('')}</div>`;
    origBox(s, t);
  }
}
// ⋯ del lettore a tutto schermo (telefono): gli strumenti che sul computer sono pulsanti sotto il titolo, poi il menu del brano
function nowTools() {
  const d = $('#dlg'); d.className = 'sheet'; const t = currentTrack();
  d.innerHTML = `${t ? `<div class="pcard"><span class="pic">${imgTag(t.coverArt, 112, t.serverId)}</span><span class="grow"><b>${esc(t.title)}</b><small>${esc(t.artist)}</small></span></div>` : ''}
    <button class="mi" data-t="sleep">${ic('moon')}<span class="grow">Timer di spegnimento${Sleep.end || Sleep.eot ? '<small>attivo</small>' : ''}</span></button>
    <button class="mi" data-t="speed">${ic('speed')}<span class="grow">Velocità<small>${P.speed}×</small></span></button>
    <button class="mi" data-t="eq">${ic('sliders')}<span class="grow">Equalizzatore</span></button>
    <button class="mi" data-t="q">${ic('album')}<span class="grow">Qualità di ascolto<small>${esc(QUALITIES[P.quality].label)}</small></span></button>
    ${t ? `<button class="mi" data-t="song">${ic('more')}<span class="grow">Azioni del brano<small>Playlist, coda, artista, album, condividi…</small></span></button>` : ''}`;
  d.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { d.close(); ({ sleep: sleepDialog, speed: speedDialog, eq: eqDialog, q: qualityDialog, song: () => songMenu(currentTrack()) })[b.dataset.t](); });
  closeOutside(d); d.showModal();
}
/* ================= tema: sul web un pulsante in alto a destra, nell'app in Impostazioni → Aspetto ================= */
I.sun = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
I.themeauto = '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>';
// stato → [nome, icona, il prossimo al tocco]
const THEMES = { auto: ['Automatico', 'themeauto', 'light'], light: ['Chiaro', 'sun', 'dark'], dark: ['Scuro', 'moon', 'auto'] };
function paintTheme() {
  const b = $('#themeBtn'); if (!b) return;
  const [name, icon, next] = THEMES[P.theme] || THEMES.auto;
  b.hidden = NATIVE; b.innerHTML = ic(icon);
  b.title = `Tema: ${name.toLowerCase()}. Tocca per ${THEMES[next][0].toLowerCase()}`; b.setAttribute('aria-label', b.title);
}
function applyTheme() {
  if (P.theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = P.theme;
  paintTheme();
}
/* ================= origine del file e scelta della versione (capacità "scelta", server/scelta.py) ================= */
I.yt = '<rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9l5 3-5 3z" fill="currentColor"/>';
I.ytm = '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M11 10l3 2-3 2z" fill="currentColor"/>';
I.cloud = '<path d="M7 18a4 4 0 0 1-.5-8A5.5 5.5 0 0 1 17 9a4.5 4.5 0 0 1 .5 9z"/>';
const SRC_UI = { ytmusic: ['ytm', 'YouTube Music'], youtube: ['yt', 'YouTube'], soundcloud: ['cloud', 'SoundCloud'], caricato: ['up', 'Caricato da un dispositivo'],
  scaricato: ['down', 'Scaricato'], libreria: ['album', 'Libreria del server'], rete: ['globe', 'Copiato dalla rete'] };
const CODEC = c => ({ mp4a: 'AAC', opus: 'Opus', vorbis: 'Vorbis', mp3: 'MP3', flac: 'FLAC' }[String(c || '').toLowerCase()] || c || '?');
const fmtQ = q => q ? [CODEC(q.codec), q.kbps ? q.kbps + ' kbps' : '', q.hz ? (q.hz / 1000).toLocaleString('it-IT') + ' kHz' : ''].filter(Boolean).join(' · ') : '';
const canPick = sid => !!srv(sid)?.me?.caps?.includes('scelta') && (access().admin || access().delete);
// nei Dettagli: da dove viene il file, che conversione ha avuto, e "Scegli un'altra versione"
async function origBox(s, t, any = false) {
  if (!s?.me?.caps?.includes('scelta') || t.fed || s.local) return;
  const r = await srvApi(s, '/api/origine?id=' + encodeURIComponent(t.id)).catch(() => null), box = $('#origBox');
  if (!r || !box || (!any && !sameTrack(currentTrack(), t))) return;
  const o = r.origine || {}, [icon, label] = SRC_UI[r.kind === 'rete' ? 'rete' : o.src] || ['down', o.src || 'Sconosciuta'];
  const conv = o.da && o.a ? `${fmtQ(o.da)} → ${fmtQ(o.a)}` : r.file ? fmtQ(r.file) : '';
  box.innerHTML = `<div class="panel origin"><div class="orig-h"><span class="orig-ic src-${esc(o.src || r.kind)}">${ic(icon)}</span><span class="grow"><b>${esc(label)}</b>
      <small>${o.title ? esc(o.title) + (o.canale ? ' · ' + esc(o.canale) : '') : o.vecchio ? 'Scaricato prima che Armony registrasse l\'origine' : ''}</small></span>
      ${o.url ? `<a class="icon-btn" href="${esc(o.url)}" target="_blank" rel="noopener" aria-label="Apri l'originale" title="Apri l'originale">${ic('globe')}</a>` : ''}</div>
    ${conv ? `<p class="orig-c">${ic('sliders')}<span>${o.da && o.a ? 'Conversione' : 'File'} <b>${esc(conv)}</b></span></p>` : ''}
    ${o.dubbi?.length ? `<p class="orig-c warn">${ic('close')}<span>Da controllare: ${esc(o.dubbi.join(' · '))}</span></p>` : ''}
    ${canPick(t.serverId) && r.kind === 'file' ? `<button class="btn sm" id="pickVer">${ic('repeat')} Scegli un'altra versione</button>` : ''}</div>`;
  $('#pickVer')?.addEventListener('click', () => versionSheet(t));
}
// il pool: i candidati di YouTube Music, YouTube e SoundCloud con il punteggio; "Usa questa" sostituisce il file nello stesso posto
async function versionSheet(t, onPick) {
  const d = $('#dlg'); d.className = 'sheet vsheet';
  d.innerHTML = `<div class="head"><span class="grow" style="min-width:0"><b style="display:block">Scegli la versione</b><small style="color:var(--muted)">${esc([t.artist, t.title].filter(Boolean).join(' – '))}</small></span></div><div id="vpool"><p class="sub" style="padding:0 14px">Cerco su YouTube Music, YouTube e SoundCloud…</p></div>`;
  closeOutside(d); d.showModal();
  let r; try { r = await srvApi(srv(t.serverId), '/api/scelta?id=' + encodeURIComponent(t.id)); } catch (e) { $('#vpool').innerHTML = `<p class="sub" style="padding:0 14px">${esc(e.message)}</p>`; return; }
  if (!$('#vpool')) return;
  const want = r.track.duration, diff = c => c.duration && want ? Math.round(c.duration - want) : null;
  $('#vpool').innerHTML = `<p class="small" style="padding:0 14px;margin:0 0 var(--s2);color:var(--muted)">Si cerca «${esc(r.track.title)}»${want ? `, ${fmt(want)}` : ''}${r.track.da === 'Spotify' ? ' (come su Spotify)' : ''}. Adesso il file è ${esc(fmtQ(r.file))}${r.file?.dur ? ', ' + fmt(r.file.dur) : ''}. Il file nuovo prende il posto del vecchio: playlist e preferiti restano.</p>
    ${r.avviso ? `<p class="small" style="padding:0 14px;color:var(--danger)">${esc(r.avviso)}</p>` : ''}
    ${r.candidates.length ? r.candidates.map((c, i) => { const [icn, lab] = SRC_UI[c.source], dd = diff(c); return `<div class="vcand">
      <span class="orig-ic src-${c.source}" title="${esc(lab)}">${ic(icn)}</span>
      <span class="grow"><b>${esc(c.title)}</b><small>${esc(c.channel || lab)}${c.duration ? ' · ' + fmt(c.duration) : ''}${dd != null && Math.abs(dd) > 3 ? ` <span class="${Math.abs(dd) > 15 ? 'bad' : ''}">(${dd > 0 ? '+' : ''}${dd} s)</span>` : dd != null ? ' <span class="good">(durata giusta)</span>' : ''}</small>
        ${c.flags.length ? `<span class="vflags">${c.flags.map(f => `<em>${esc(f)}</em>`).join('')}</span>` : ''}</span>
      <span class="vscore" title="Punteggio di somiglianza">${String(c.score).replace('.', ',')}</span>
      <a class="icon-btn" href="${esc(c.url)}" target="_blank" rel="noopener" aria-label="Ascolta sul sito">${ic('globe')}</a>
      <button class="btn sm${i ? '' : ' primary'}" data-vi="${i}">Usa</button></div>`; }).join('') : '<p class="sub" style="padding:0 14px">Nessun candidato trovato.</p>'}`;
  $('#vpool').querySelectorAll('[data-vi]').forEach(b => b.onclick = async () => {
    const c = r.candidates[+b.dataset.vi]; b.disabled = true;
    try {
      const j = await srvApi(srv(t.serverId), '/api/scelta', { method: 'POST', body: JSON.stringify({ id: t.id, url: c.url, source: c.source, title: c.title, score: c.score }) });
      d.close(); Sost.follow(t, j, !!onPick); if (onPick) onPick(j); emitSoon('libreria');
    } catch (e) { b.disabled = false; toast(e.message); }
  });
}
// una sostituzione in corso: se il brano è quello che suona si ferma (il file sta per cambiare sotto i piedi),
// e quando il file nuovo è al suo posto e Navidrome l'ha letto, i dati del brano si aggiornano e riparte da capo.
// Vale per web e app (la riproduzione è la stessa); se questo dispositivo fa da telecomando o è ospite di una Jam non si tocca
const Sost = {
  bust: {},  // brano → numero da aggiungere all'indirizzo, così né il browser né la cache dei brani danno il file vecchio
  async follow(t, j, quiet) {
    const k = key(t), mine = () => { const c = currentTrack(); return !!c && key(c) === k && !Live.remote() && Jam.role !== 'guest' && !Radio.st; };
    const was = mine();
    if (was) Engine.el.pause();
    if (!quiet || was) toast(was ? 'Fermo il brano: lo sostituisco e riparte da solo appena è pronto.' : 'Sostituisco il brano: fra poco trovi la versione nuova.', 5000);
    const bar = st => { const b = $('#pickVer'); if (!b) return;
      b.outerHTML = `<span class="jbar" id="pickVer" role="status" style="width:100%"><span class="jbar-t"><i style="width:${st.p}%"></i></span><em>${esc(st.t)}</em></span>`; };
    let job = j;
    for (let n = 0; n < 400; n++) {  // al più una decina di minuti
      await new Promise(r => setTimeout(r, 1500));
      try { job = (await srvApi(srv(t.serverId), '/api/jobs?ids=' + j.id))[0] || job; } catch { continue; }
      const p = job.status === 'in corso' ? job.progress || 0 : 0;
      if (job.status === 'errore' || job.status.startsWith('completato')) break;
      bar({ p, t: job.status === 'in coda' ? 'in coda' : p >= 100 ? 'sistemo il file' : Math.floor(p) + '%' });
    }
    if (job.status === 'errore') {
      toast('Sostituzione non riuscita: ' + (job.error || 'errore'), 6000);
      if (was && mine()) Engine.el.play().catch(() => {});
      const cur = currentTrack(); if ($('#origBox') && cur && key(cur) === k) origBox(srv(t.serverId), cur, true);  // torna "Scegli un'altra versione"
      return;
    }
    if (!job.status.startsWith('completato')) return;
    bar({ p: 100, t: 'aggiorno il brano' });
    // Navidrome rilegge il file (il server gli ha chiesto una scansione): si aspetta che finisca, al più 30 secondi
    const s = srv(t.serverId);
    for (let n = 0; n < 20; n++) {
      await new Promise(r => setTimeout(r, 1500));
      try { if (!(await api('getScanStatus', {}, s)).scanStatus?.scanning) break; } catch { break; }
    }
    this.bust[k] = Date.now();
    for (const q of Object.keys(QUALITIES)) { const ck = ACache.k(t, q); if (ACache.idx[ck]) ACache.drop(ck); }
    if (Engine.idle.dataset.key === k) { Engine.idle.removeAttribute('src'); delete Engine.idle.dataset.key; }
    try {
      const nt = norm((await api('getSong', { id: t.id }, s)).song, s.id);
      [...S.queue, ...(S.lastList || [])].forEach(x => { if (key(x) === k) Object.assign(x, { duration: nt.duration, title: nt.title, artist: nt.artist, album: nt.album, coverArt: nt.coverArt }); });
    } catch {}
    persistQueue(); updateNowPlaying();
    if (was && mine()) { await playIndex(S.index); toast('Versione nuova: riparte da capo.'); }
    else if (!quiet) toast('La versione nuova è pronta.');
    const cur = currentTrack(); if ($('#origBox') && cur && key(cur) === k) origBox(s, cur, true);
    emitSoon('libreria');
  }
};
// pagina Scarica: brani da controllare (verifica non convinta, o durata diversa da Spotify). Il server cerca in sottofondo
// una versione da proporre per ognuno (durata giusta, audio ufficiale): quelle spuntate si sostituiscono in un colpo solo.
// Scelta una versione, la riga mostra l'avanzamento e a lavoro finito esce dalla lista (il server la segna come controllata)
async function refreshSosp() {
  const box = $('#sosp'); if (!box || !srv()?.me?.caps?.includes('scelta')) return;
  let list; try { list = await dlApi('/api/scelta/sospetti'); } catch { box.innerHTML = ''; return; }
  if ($('#sosp') !== box) return;
  const pick = canPick(), busy = x => x.sost && x.sost.status !== 'errore';
  let all = true;  // le proposte che arrivano dopo seguono «Tutte le proposte»
  list.forEach(x => { x.sel = !!x.prop; });
  const state = x => { const j = x.sost;
    if (j?.status === 'errore') return `<span class="bad">Non riuscita: ${esc(j.error || 'errore')}</span>`;
    if (j) return j.status.startsWith('completato') ? '<span class="good">Sistemato: la versione nuova è in libreria</span>' : 'Scelta registrata: ' + (j.status === 'in coda' ? 'in attesa del suo turno' : (j.progress || 0) >= 100 ? 'sistemo il file al suo posto' : 'scarico la versione nuova');
    return esc(x.motivi.join(' · ')); };
  const prop = x => { if (busy(x)) return '';
    if (x.cerco) return '<small class="sprop wait">Cerco la versione giusta…</small>';
    const c = x.prop; if (!c) return '<small class="sprop">Nessuna versione abbastanza vicina: scegli a mano</small>';
    const [icn, lab] = SRC_UI[c.source] || ['down', c.source];
    return `<small class="sprop"><span class="orig-ic src-${esc(c.source)}" title="${esc(lab)}">${ic(icn)}</span><span class="grow">${esc(c.title)}${c.channel ? ' · ' + esc(c.channel) : ''}${c.duration ? ' · ' + fmt(c.duration) : ''}</span></small>`; };
  const act = (x, i) => { const j = x.sost;
    if (busy(x)) { const fin = j.status.startsWith('completato'), p = fin ? 100 : j.status === 'in corso' ? j.progress || 0 : 0;
      return `<span class="jbar${fin ? ' ok' : ''}" role="status"><span class="jbar-t"><i style="width:${p}%"></i></span><em>${fin ? 'fatto' : j.status === 'in coda' ? 'in coda' : p >= 100 ? 'sistemo' : Math.floor(p) + '%'}</em></span>`; }
    return `${pick ? `<button class="btn sm" data-sp="${i}">${j ? 'Riprova' : 'Scegli'}</button>` : ''}<button class="btn sm" data-ok="${i}">Va bene</button>`; };
  const row = (x, i) => `<div class="vcand${busy(x) ? ' busy' : ''}" data-row="${i}">
    <span class="scheck">${pick && x.prop && !busy(x) ? `<input type="checkbox" data-sel="${i}" aria-label="Usa la versione proposta"${x.sel ? ' checked' : ''}>` : ''}</span>
    <span class="grow"><b>${esc(x.title || '')}</b><small>${state(x)}</small>${prop(x)}</span><span class="sosp-act">${act(x, i)}</span></div>`;
  const bar = () => { const live = list.filter((x, i) => box.querySelector(`[data-row="${i}"]`) && !busy(x)), n = live.filter(x => x.prop && x.sel).length, wait = live.filter(x => x.cerco).length;
    return pick ? `<label class="sall"><input type="checkbox" id="sospAll"${n && n === live.filter(x => x.prop).length ? ' checked' : ''}> Tutte le proposte</label>
      <small>${wait ? `Cerco ancora ${wait} ${wait === 1 ? 'proposta' : 'proposte'}…` : ''}</small>
      <button class="btn sm primary" id="sospGo"${n ? '' : ' disabled'}>${ic('repeat')} Sostituisci${n ? n === 1 ? ' 1 brano' : ` ${n} brani` : ''}</button>` : ''; };
  box.innerHTML = list.length ? `<details class="panel sosp"${list.length < 8 || list.some(x => x.sost) ? ' open' : ''}><summary><b>Da controllare</b> <span class="tag acc" data-n>${list.length}</span><small>Brani forse sbagliati: una live, un videoclip con l'introduzione, un'altra versione. Per ognuno cerco la versione con la durata giusta: spunta quelle che vanno bene e sostituiscile insieme.</small></summary>
    <div class="sosp-bar"></div>${list.map(row).join('')}</details>` : '';
  const paintBar = () => { const b = box.querySelector('.sosp-bar'); if (b) b.innerHTML = bar(); };
  const paint = i => { const el = box.querySelector(`[data-row="${i}"]`); if (el) el.outerHTML = row(list[i], i); paintBar(); };
  paintBar();
  const gone = i => {
    const el = box.querySelector(`[data-row="${i}"]`); if (!el || el.classList.contains('out')) return;
    el.style.height = el.offsetHeight + 'px'; requestAnimationFrame(() => el.classList.add('out'));
    setTimeout(() => { el.remove(); const n = box.querySelectorAll('[data-row]').length, tag = box.querySelector('[data-n]'); if (!n) box.innerHTML = ''; else { if (tag) tag.textContent = n; paintBar(); } }, 380);
  };
  // avanzamento delle sostituzioni e proposte che arrivano, finché la pagina è aperta
  let t = null, last = 0;
  const tick = async () => {
    t = null; if (!box.isConnected || $('#sosp') !== box) return;
    const open = list.map((x, i) => [x, i]).filter(([x]) => busy(x) && !x.sost.status.startsWith('completato'));
    const wait = list.some((x, i) => x.cerco && box.querySelector(`[data-row="${i}"]`));
    if (!open.length && !wait) return;
    if (!document.hidden) try {
      if (open.length) {
        const js = new Map((await dlApi('/api/jobs?ids=' + open.map(([x]) => x.sost.id).join(','))).map(j => [j.id, j]));
        for (const [x, i] of open) {
          const j = js.get(x.sost.id); if (!j) continue;
          x.sost = { ...x.sost, status: j.status, progress: j.progress, error: j.error }; paint(i);
          if (j.status.startsWith('completato')) setTimeout(() => gone(i), 1400);
        }
      }
      if (wait && Date.now() - last > 6000) {
        last = Date.now();
        const fresh = new Map((await dlApi('/api/scelta/sospetti')).map(y => [y.id, y]));
        list.forEach((x, i) => { const y = fresh.get(x.id); if (x.cerco && y && !y.cerco) { x.cerco = false; x.prop = y.prop; x.sel = !!y.prop && all; paint(i); } });
      }
    } catch {}
    t = setTimeout(tick, 1500);
  };
  const follow = () => { if (!t) t = setTimeout(tick, 800); };
  const started = (i, j) => { list[i].sost = { id: j.id, status: j.status || 'in coda', progress: 0 }; list[i].sel = false; paint(i); follow(); };
  box.onchange = e => {
    if (e.target.id === 'sospAll') { all = e.target.checked; list.forEach((x, i) => { if (x.prop && !busy(x)) { x.sel = e.target.checked; const c = box.querySelector(`[data-sel="${i}"]`); if (c) c.checked = x.sel; } }); paintBar(); }
    else if (e.target.dataset.sel != null) { list[+e.target.dataset.sel].sel = e.target.checked; paintBar(); }
  };
  box.onclick = async e => {
    const go = e.target.closest('#sospGo');
    if (go) {
      const ids = list.filter((x, i) => x.sel && x.prop && !busy(x) && box.querySelector(`[data-row="${i}"]`)).map(x => x.id); if (!ids.length) return;
      go.disabled = true;
      try { const r = await dlApi('/api/scelta/proposte', { method: 'POST', body: JSON.stringify({ ids }) }); list.forEach((x, i) => { if (r.jobs[x.id]) started(i, r.jobs[x.id]); }); emitSoon('libreria'); }
      catch (err) { toast(err.message); paintBar(); }
      return;
    }
    const b = e.target.closest('[data-sp],[data-ok]'); if (!b) return;
    const i = +(b.dataset.sp ?? b.dataset.ok), x = list[i];
    if (b.dataset.sp != null) return versionSheet({ id: x.id, serverId: dlSrv().id, title: x.title, artist: '' }, j => started(i, j));
    b.disabled = true;
    try { await dlApi('/api/scelta/sospetti/' + encodeURIComponent(x.key), { method: 'DELETE' }); gone(i); } catch (err) { b.disabled = false; toast(err.message); }
  };
  follow();
}

/* ================= offline (vista) ================= */
async function vOffline() {
  const n = Scene.nav;
  const recs = (await DB.all('offline').catch(() => [])).sort((a, b) => b.added - a.added);
  const tot = recs.reduce((n, r) => n + r.size, 0);
  let est = ''; try { const e = await navigator.storage.estimate(); est = `, spazio disponibile ${bytes(e.quota - e.usage)}`; } catch {}
  const tracks = recs.map(r => r.track);
  if (stale(n)) return;
  view.innerHTML = `<h1>Offline</h1><p class="sub">${recs.length} brani salvati su questo dispositivo, ${bytes(tot)}${est}. ${navigator.onLine ? '' : '<b>Sei offline:</b> puoi ascoltare solo questi.'}</p>
    <div class="row" style="margin-bottom:16px">
      <button class="btn primary" data-act="playall">${ic('play')} Riproduci</button><button class="btn" data-act="shuffleall">${ic('shuffle')} Mescola</button>
      ${recs.length ? '<button class="btn danger" data-act="offclear">Elimina tutto</button>' : ''}
      <label class="row small" style="gap:6px;color:var(--muted)">Qualità dei salvataggi <select id="offQ" style="width:auto">${Object.entries(QUALITIES).map(([k, q]) => `<option value="${k}" ${k === P.offlineQ ? 'selected' : ''}>${q.short}</option>`).join('')}</select></label>
    </div>
    ${songList(tracks, { empty: 'Nessun brano salvato. Usa il pulsante Offline su album e playlist, o il menu ⋯ di un brano.' })}`;
  $('#offQ').onchange = e => { P.offlineQ = e.target.value; savePrefs(); };
}

/* ================= statistiche ================= */
async function vStats() {
  const period = sessionStorage.getItem('armony:sp') || '30';
  const n = Scene.nav;
  // "I tuoi ascolti" (storico di questo utente) o "Sul server" (tutti gli utenti, server/ascolti.py)
  const svOk = !!srv()?.me?.caps?.includes('ascolti') && can('stats'), sv = svOk && sessionStorage.getItem('armony:sv') === 'server';
  const svTabs = svOk ? `<div class="lpills" role="navigation" aria-label="Quali ascolti">${[['me', 'I tuoi ascolti'], ['server', 'Sul server']].map(([k, l]) => `<a href="#/statistiche" data-act="sv" data-k="${k}" class="${(k === 'server') === sv ? 'on' : ''}"${(k === 'server') === sv ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</div>` : '';
  if (sv) return vStatsServer(period, svTabs, n);
  const all = await Stats.all();
  if (stale(n)) return;
  const from = period === 'all' ? 0 : period === 'year' ? new Date(new Date().getFullYear(), 0, 1).getTime() : Date.now() - (+period) * 864e5;
  const h = all.filter(x => x.ts >= from);
  const secs = h.reduce((n, x) => n + x.duration, 0);
  const count = (f) => { const m = new Map(); h.forEach(x => { const k = f(x); if (!k) return; const e = m.get(k) || { n: 0, x }; e.n++; m.set(k, e); }); return [...m.values()].sort((a, b) => b.n - a.n); };
  const songs = count(x => x.key), artists = count(x => x.artist), albums = count(x => x.albumId), genres = count(x => x.genre);
  const hours = Array(24).fill(0); h.forEach(x => hours[new Date(x.ts).getHours()]++);
  const maxH = Math.max(1, ...hours);
  const days = new Set(all.map(x => new Date(x.ts).toDateString()));
  let streak = 0; for (let d = new Date(); days.has(d.toDateString()); d.setDate(d.getDate() - 1)) streak++;
  const top = (title, list, label) => list.length ? `<div><h2>${title}</h2><ol class="rank">${list.slice(0, 10).map(e => `<li><span class="grow"><b>${label(e.x)}</b></span><small>${e.n} ascolti</small></li>`).join('')}</ol></div>` : '';
  const num = v => v.toLocaleString('it-IT');
  const sub = syncable(srv()) ? `Calcolate sui tuoi ascolti da tutti i tuoi dispositivi collegati a ${esc(srv().name)}.` : 'Calcolate sui tuoi ascolti da questo dispositivo. Restano qui, non vengono inviate a nessuno.';
  // nessun ascolto in assoluto: una pagina che invita ad ascoltare, non una fila di zeri
  if (!all.length) {
    view.innerHTML = `<h1>Statistiche</h1>${svTabs}<p class="sub">${sub}</p>
      <div class="stats-empty"><div class="vinyl" aria-hidden="true"></div><div>
        <h3>Il primo ascolto apre le statistiche</h3>
        <p>Ogni brano che ascolti finisce qui: quanti minuti, gli artisti che torni a cercare, le ore in cui suoni di più.</p>
        <div class="row"><button class="btn primary" data-act="radio">${ic('shuffle')} Fai partire un mix casuale</button><a class="btn" href="#/libreria">Sfoglia la libreria</a></div>
      </div></div>`;
    return;
  }
  const label = { '7': 'negli ultimi 7 giorni', '30': 'negli ultimi 30 giorni', year: 'quest\'anno', all: 'da quando usi Armony' }[period];
  view.innerHTML = `<h1>Statistiche</h1>${svTabs}<p class="sub">${sub}</p>
    <div class="row" style="margin-bottom:24px"><div class="seg">${[['7', '7 giorni'], ['30', '30 giorni'], ['year', 'Quest\'anno'], ['all', 'Sempre']].map(([v, l]) => `<label><input type="radio" name="sp" value="${v}" ${v === period ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      ${h.length ? `<button class="btn" data-act="wrapped">${ic('image')} Crea immagine da condividere</button>` : ''}</div>
    ${!h.length ? `<div class="empty"><h3>Nessun ascolto ${label}</h3><p>Hai ${num(all.length)} ascolti in tutto.</p><button class="btn" data-act="spall">Guarda da sempre</button></div>` : `
    <div class="statshero">
      <div class="lead"><b>${num(Math.round(secs / 60))}</b><span>minuti di musica ${label}${artists[0] ? `, soprattutto con <em>${esc(artists[0].x.artist)}</em>` : ''}</span></div>
      <dl class="minor"><div><dt>ascolti</dt><dd>${num(h.length)}</dd></div><div><dt>brani diversi</dt><dd>${num(songs.length)}</dd></div>
        <div><dt>artisti</dt><dd>${num(artists.length)}</dd></div><div><dt>${streak === 1 ? 'giorno di fila' : 'giorni di fila'}</dt><dd>${streak}</dd></div></dl>
    </div>
    <h2>Quando ascolti</h2><div class="panel"><div class="hours">${hours.map((v, i) => `<i style="height:${v / maxH * 100}%" title="${i}:00, ${v} ascolti"></i>`).join('')}</div>
      <div class="hours-l">${hours.map((_, i) => `<span>${i % 3 === 0 ? i : ''}</span>`).join('')}</div></div>
    <div class="grid2">${top('Artisti', artists, x => esc(x.artist))}${top('Brani', songs, x => `${esc(x.title)}<small style="display:block">${esc(x.artist)}</small>`)}
      ${top('Album', albums, x => `${esc(x.album)}<small style="display:block">${esc(x.artist)}</small>`)}${top('Generi', genres, x => esc(x.genre))}</div>`}
    <h2>I tuoi dati</h2><div class="row"><button class="btn" data-act="histexport">Esporta storico (CSV)</button><button class="btn danger" data-act="histclear">Cancella storico</button></div>`;
  view.querySelectorAll('[name=sp]').forEach(r => r.onchange = () => { sessionStorage.setItem('armony:sp', r.value); vStats(); });
  view._wrapped = { title: { '7': 'Ultimi 7 giorni', '30': 'Ultimi 30 giorni', year: 'Il mio ' + new Date().getFullYear(), all: 'Da sempre' }[period],
    mins: Math.round(secs / 60), a: ['Artisti', artists.map(e => e.x.artist)], b: ['Brani', songs.map(e => e.x.title)], foot: `${h.length} ascolti, ${artists.length} artisti`, share: 'Il mio Armony' };
}
// tutti gli ascolti del server: chi ascolta di più, i brani più ascoltati e un registro degli ultimi ascolti
async function vStatsServer(period, tabs, n) {
  const days = { '7': 7, '30': 30, year: Math.ceil((Date.now() - new Date(new Date().getFullYear(), 0, 1)) / 864e5), all: 3650 }[period] || 30;
  const d = await srvApi(srv(), '/api/ascolti/server?days=' + days);
  if (stale(n)) return;
  const f = x => x.toLocaleString('it-IT'), max = Math.max(1, ...d.users.map(u => u.plays));
  const label = { '7': 'negli ultimi 7 giorni', '30': 'negli ultimi 30 giorni', year: 'quest\'anno', all: 'da sempre' }[period];
  view.innerHTML = `<h1>Statistiche</h1>${tabs}<p class="sub">Gli ascolti di tutti gli utenti di ${esc(srv().name)}, contati dal server: valgono anche per le app Subsonic collegate. Chi non vuole comparire conta nei totali ma non per nome.</p>
    <div class="row" style="margin-bottom:24px"><div class="seg">${[['7', '7 giorni'], ['30', '30 giorni'], ['year', 'Quest\'anno'], ['all', 'Sempre']].map(([v, l]) => `<label><input type="radio" name="sp" value="${v}" ${v === period ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      ${d.total ? `<button class="btn" data-act="wrapped">${ic('image')} Crea immagine del gruppo</button>` : ''}</div>
    <div class="statshero"><div class="lead"><b>${f(d.total)}</b><span>ascolti sul server ${label}${d.users[0] ? `, il più assiduo è <em>${esc(d.users[0].name)}</em>` : ''}</span></div>
      <dl class="minor"><div><dt>da sempre</dt><dd>${f(d.ever)}</dd></div><div><dt>${d.users.length === 1 ? 'utente' : 'utenti'}</dt><dd>${f(d.users.length)}</dd></div></dl></div>
    <div class="grid2"><div><h2>Per utente</h2>${d.users.length ? `<div class="srvusers">${d.users.map(u => `<div class="srvuser">${pavatar(u, 's')}<span class="grow"><b>${esc(u.name)}</b><span class="srvbar"><i style="width:${u.plays / max * 100}%"></i></span></span><span class="srvn"><b>${f(u.plays)}</b><small>${u.last ? ago(u.last * 1000) : ''}</small></span></div>`).join('')}${d.others ? `<p class="small" style="color:var(--muted)">Altri utenti: ${f(d.others)} ascolti.</p>` : ''}</div>` : '<div class="empty">Nessun ascolto in questo periodo.</div>'}</div>
      <div><h2>I più ascoltati</h2>${d.top.length ? `<ol class="rank">${d.top.map(t => `<li${t.albumId ? ` data-act="album" data-id="${esc(t.albumId)}" style="cursor:pointer"` : ''}><span class="grow"><b>${esc(t.title)}</b><small>${esc(t.artist)}</small></span><small>${f(t.plays)} ascolti${t.listeners > 1 ? ` · ${t.listeners} persone` : ''}</small></li>`).join('')}</ol>` : '<div class="empty">Ancora niente.</div>'}</div></div>
    <h2>Ultimi ascolti</h2>${d.recent.length ? `<div class="srvlog">${d.recent.map(r => `<div class="srvlogrow"${r.albumId ? ` data-act="album" data-id="${esc(r.albumId)}"` : ''}>${pavatar(r, 's')}<span class="grow"><b>${esc(r.name)}</b> ha ascoltato <b>${esc(r.title)}</b> <small>· ${esc(r.artist)}</small></span><small data-at="${r.at * 1000}">${ago(r.at * 1000)}</small></div>`).join('')}</div>` : '<div class="empty">Nessun ascolto registrato.</div>'}`;
  view.querySelectorAll('[name=sp]').forEach(r => r.onchange = () => { sessionStorage.setItem('armony:sp', r.value); vStats(); });
  // «Il nostro mese»: la stessa immagine di quella personale, con chi ascolta di più al posto degli artisti
  view._wrapped = { title: { '7': 'La nostra settimana', '30': 'Il nostro mese', year: 'Il nostro ' + new Date().getFullYear(), all: 'Da sempre, insieme' }[period],
    mins: d.minutes || 0, a: ['Chi ascolta di più', d.users.map(u => u.name)], b: [d.artists?.length ? 'Artisti' : 'Brani', d.artists?.length ? d.artists.map(a => a.artist) : d.top.map(t => t.title)],
    foot: `${f(d.total)} ascolti su ${srv().name}`, share: 'Il nostro Armony' };
}
async function makeWrapped() {
  const w = view._wrapped; if (!w) return;
  await document.fonts.ready;
  const c = document.createElement('canvas'); c.width = 1080; c.height = 1350; const x = c.getContext('2d');
  x.fillStyle = '#1b1e36'; x.fillRect(0, 0, 1080, 1350);
  const ring = (cx, cy, r) => { for (let i = 0; i < 40; i++) { x.strokeStyle = i % 2 ? '#23264a' : '#191b30'; x.lineWidth = 3; x.beginPath(); x.arc(cx, cy, r - i * 3, 0, Math.PI * 2); x.stroke(); } x.fillStyle = '#f2a541'; x.beginPath(); x.arc(cx, cy, r * .38, 0, Math.PI * 2); x.fill(); x.fillStyle = '#1b1e36'; x.beginPath(); x.arc(cx, cy, 10, 0, Math.PI * 2); x.fill(); };
  ring(900, 200, 240);
  x.fillStyle = '#ece8dd'; x.font = '800 64px "Bricolage Grotesque", sans-serif'; x.fillText('armony', 80, 130);
  x.fillStyle = '#a3a8c8'; x.font = '500 40px Figtree, sans-serif'; x.fillText(w.title, 80, 190);
  x.fillStyle = '#f2a541'; x.font = '800 190px "Bricolage Grotesque", sans-serif'; x.fillText(w.mins.toLocaleString('it-IT'), 80, 470);
  x.fillStyle = '#ece8dd'; x.font = '500 44px Figtree, sans-serif'; x.fillText('minuti di musica', 86, 535);
  const col = (title, items, y0, X) => { x.fillStyle = '#a3a8c8'; x.font = '600 36px Figtree, sans-serif'; x.fillText(title, X, y0); items.slice(0, 5).forEach((t, i) => { x.fillStyle = '#ece8dd'; x.font = '600 38px Figtree, sans-serif'; let s = `${i + 1}  ${t}`; while (x.measureText(s).width > 440 && s.length > 4) s = s.slice(0, -2); if (s !== `${i + 1}  ${t}`) s += '…'; x.fillText(s, X, y0 + 70 + i * 64); }); };
  col(w.a[0], w.a[1], 680, 80);
  col(w.b[0], w.b[1], 680, 560);
  x.fillStyle = '#a3a8c8'; x.font = '500 30px Figtree, sans-serif'; x.fillText(w.foot, 80, 1260);
  c.toBlob(async b => {
    const f = new File([b], 'armony.png', { type: 'image/png' });
    if (navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f], title: w.share }); return; } catch {} }
    saveFile('armony.png', b);
  });
}

/* ================= download ================= */
async function dlApi(path, opts = {}, retry = true) {
  if (!S.dl.url) throw new Error(srv() ? 'Questo server non ha Armony: download, caricamenti e aggiornamenti non sono disponibili.' : 'Aggiungi un server in Impostazioni.');
  const r = await netFetch(S.dl.url.replace(/\/+$/, '') + path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Token': S.dl.token, ...(opts.headers || {}) } }, 30000);
  if (r.status === 401) {
    const s = srv(), j = await r.clone().json().catch(() => ({}));
    if (j.code === 'revocato' && s) { Disp.revoke(s, true); throw new Error(j.error); }
    if (retry && s?.session) { delete s.session; await armonyLogin(s).catch(() => {}); persistServers(); if (s.session) return dlApi(path, opts, false); }
    throw new Error('Accesso scaduto: in Impostazioni modifica il server e reinserisci la password.');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Errore ${r.status}`);
  return j;
}
const scanned = new Set(store.get('scanned', []));
const videoUrl = (p, dl) => `${S.dl.url.replace(/\/+$/, '')}/api/videos/${p.split('/').map(encodeURIComponent).join('/')}?${authQ(dlSrv(), S.dl.token)}${dl ? '&dl=1' : ''}`;
function dlOptions() {
  return { mode: $('[name=mode]:checked').value, format: $('#dFmt').value, quality: $('#dQ').value, playlist: $('#dPl').checked, folder: $('#dDir').value.trim() || 'Scaricati', sponsorblock: $('#dSb').checked };
}
async function vDownload(sub = '') {
  const [tab, ...rest] = (sub || '').split('/'); const q0 = rest.join('/');
  const t = ['cerca', 'carica'].includes(tab) ? tab : 'link';
  const tabs = `<div class="tabs"><a href="#/scarica" class="${t === 'link' ? 'on' : ''}">Da un link</a><a href="#/scarica/cerca" class="${t === 'cerca' ? 'on' : ''}">Cerca online</a><a href="#/scarica/carica" class="${t === 'carica' ? 'on' : ''}">Dal dispositivo</a></div>`;
  if (t === 'carica') return vUpload(tabs);
  if (S.dl.url && !access().download) { view.innerHTML = `<h1>Scarica</h1>${tabs}<div class="empty">I download non sono abilitati per il tuo utente. Chiedilo a chi gestisce il server.</div>`; return; }
  view.innerHTML = `<h1>Scarica</h1><p class="sub">Da YouTube, SoundCloud, Bandcamp, Vimeo e centinaia di altri siti. L'audio entra nella libreria, i video restano qui sotto.</p>
  <div id="sosp"></div>${tabs}
  <div class="svc"><div class="svc-main">
  <div class="panel">
    ${t === 'link' ? `<label class="f">Link, uno per riga<textarea id="dUrl" placeholder="https://www.youtube.com/watch?v=..."></textarea></label>`
      : `<div class="row" style="flex-wrap:nowrap"><input type="search" id="ySearch" placeholder="Artista e titolo" value="${esc(q0)}"><select id="ySrc" style="width:auto"><option value="yt">YouTube</option><option value="sc">SoundCloud</option></select><button class="btn primary" id="yGo">${ic('search')}</button></div>`}
    <div class="row" style="margin:14px 0 0">
      <div class="seg" role="radiogroup" aria-label="Tipo"><label><input type="radio" name="mode" value="audio" checked><span>Solo audio</span></label><label><input type="radio" name="mode" value="video"><span>Video</span></label></div>
      <select id="dFmt" style="width:auto" aria-label="Formato"></select><select id="dQ" style="width:auto" aria-label="Qualità"></select>
    </div>
    <details style="margin-top:12px"><summary class="small" style="cursor:pointer;color:var(--muted)">Altre opzioni</summary>
      <div class="stack" style="margin-top:10px">
        <label class="f">Cartella nella libreria<input type="text" id="dDir" value="${esc(store.get('dlDir', 'Scaricati'))}"></label>
        <label class="check"><input type="checkbox" id="dPl"><span>Scarica l'intera playlist o canale<small>Se il link fa parte di una playlist, scarica tutti i brani.</small></span></label>
        <label class="check"><input type="checkbox" id="dSb" ${store.get('dlSb', true) ? 'checked' : ''}><span>Togli parti parlate e sponsor<small>Usa SponsorBlock per tagliare intro, outro e parti non musicali dei video.</small></span></label>
      </div></details>
    ${t === 'link' ? `<div class="row" style="margin-top:14px"><button class="btn primary" id="dGo">${ic('down')} Scarica</button></div>` : ''}
  </div>
  ${t === 'cerca' ? '<div id="yRes"></div>' : ''}
  </div><div class="svc-side">
  <div class="row between"><h2>Download</h2><button class="btn sm" data-act="clearjobs">Rimuovi conclusi</button></div>
  <div id="jobs"><p class="sub">Caricamento…</p></div>
  <h2>Video</h2><div id="vids"></div></div></div>`;
  const setOpts = () => {
    const m = $('[name=mode]:checked').value;
    $('#dFmt').innerHTML = m === 'audio' ? '<option value="mp3">MP3</option><option value="m4a">M4A (AAC)</option><option value="opus">Opus</option><option value="flac">FLAC</option>' : '<option value="mp4">MP4</option>';
    $('#dQ').innerHTML = m === 'audio' ? '<option value="best">Qualità massima</option><option value="320">320 kbps</option><option value="256">256 kbps</option><option value="192">192 kbps</option><option value="128">128 kbps</option>'
      : '<option value="best">Massima</option><option value="2160">4K</option><option value="1080" selected>1080p</option><option value="720">720p</option><option value="480">480p</option><option value="360">360p</option>';
  };
  $$('[name=mode]').forEach(r => r.onchange = setOpts); setOpts();
  $('#dDir').onchange = e => store.set('dlDir', e.target.value); $('#dSb').onchange = e => store.set('dlSb', e.target.checked);
  if (t === 'link') $('#dGo').onclick = async () => {
    const urls = $('#dUrl').value.split(/\s+/).filter(Boolean);
    if (!urls.length) return toast('Incolla almeno un link.');
    try { for (const url of urls) await dlApi('/api/download', { method: 'POST', body: JSON.stringify({ ...dlOptions(), url }) }); $('#dUrl').value = ''; toast(urls.length > 1 ? `${urls.length} download avviati.` : 'Download avviato.'); refreshJobs(); }
    catch (e) { toast(e.message); }
  };
  else {
    let results = [];
    const go = async () => {
      const q = $('#ySearch').value.trim(); if (!q) return;
      $('#yRes').innerHTML = '<p class="sub">Cerco…</p>';
      try {
        results = await dlApi(`/api/search?q=${encodeURIComponent(q)}&n=12&source=${$('#ySrc').value}`);
        $('#yRes').innerHTML = results.length ? results.map((r, i) => `<div class="list-item" style="cursor:default">
          <span class="pic" style="width:92px;aspect-ratio:16/9;height:auto">${r.thumb ? `<img src="${esc(r.thumb)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>
          <span class="grow"><b>${esc(r.title)}</b><small>${esc(r.channel || '')}${r.duration ? ', ' + fmt(r.duration) : ''}${r.views ? ', ' + r.views.toLocaleString('it-IT') + ' visualizzazioni' : ''}</small></span>
          <a class="icon-btn" href="${esc(r.url)}" target="_blank" rel="noopener" aria-label="Apri sul sito">${ic('globe')}</a>
          <button class="btn sm primary" data-yi="${i}">${ic('down')} Scarica</button></div>`).join('') : '<div class="empty">Nessun risultato.</div>';
        $$('[data-yi]').forEach(b => b.onclick = async () => {
          try { const j = await dlApi('/api/download', { method: 'POST', body: JSON.stringify({ ...dlOptions(), playlist: false, url: results[+b.dataset.yi].url }) }); b.outerHTML = JobBar.html(j.id); JobBar.watch(); refreshJobs(); } catch (e) { toast(e.message); }
        });
      } catch (e) { $('#yRes').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    };
    $('#yGo').onclick = go; $('#ySearch').onkeydown = e => { if (e.key === 'Enter') go(); };
    if (q0) go();
  }
  refreshJobs(); refreshVideos(); refreshSosp(); viewInterval(refreshJobs, 2000);
}
// un gruppo (importazione, album): una riga con l'avanzamento complessivo, i brani in corso e gli errori a richiesta
const jobGroup = gr => {
  const fin = gr.done + gr.errors >= gr.total, n = x => x.toLocaleString('it-IT');
  return `<div class="panel jgroup" style="padding:14px">
    <div class="row between" style="flex-wrap:nowrap"><b style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(gr.label)}</b>
    <span class="tag ${fin ? gr.errors ? 'err' : 'ok' : ''}">${fin ? gr.errors ? 'completato con errori' : 'completato' : Math.floor(gr.progress) + '%'}</span></div>
    <small style="color:var(--muted)">${n(gr.done)} di ${n(gr.total)} brani scaricati${gr.errors ? ` · <span style="color:var(--danger)">${n(gr.errors)} non trovati</span>` : ''}${fin ? '' : ` · ${n(gr.total - gr.done - gr.errors)} da fare`}</small>
    ${fin ? '' : `<div class="bar"><i style="width:${gr.progress}%"></i></div>`}
    ${gr.running.map(r => `<div class="jnow">${ic('down')}<span>${esc(r.title || '')}</span><em>${Math.round(r.progress)}%</em></div>`).join('')}
    ${gr.failed.length ? `<details class="jerr"><summary>Vedi i non trovati</summary>${gr.failed.map(f => `<div><b>${esc(f.title || '')}</b><small>${esc(f.error || '')}</small></div>`).join('')}${gr.errors > gr.failed.length ? `<small>…e altri ${n(gr.errors - gr.failed.length)}</small>` : ''}</details>` : ''}
  </div>`;
};
const groupDone = new Map();  // gruppo → brani finiti all'ultimo controllo, per chiedere la scansione quando cresce
async function refreshJobs() {
  const box = $('#jobs');
  try {
    const grouped = !!srv()?.me?.caps?.includes('jobgroups');
    const res = await dlApi('/api/jobs' + (grouped ? '?grouped=1' : '')), jobs = grouped ? res.jobs : res, groups = grouped ? res.groups : [];
    let grew = false;
    for (const gr of groups) { if (groupDone.has(gr.id) && gr.done > groupDone.get(gr.id)) grew = true; groupDone.set(gr.id, gr.done); }
    if (box) box.innerHTML = groups.map(jobGroup).join('') + (jobs.length ? jobs.map(j => {
      const done = j.status.startsWith('completato'), err = j.status === 'errore';
      return `<div class="panel" style="padding:14px">
        <div class="row between" style="flex-wrap:nowrap"><b style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(j.title || j.url)}</b>
        <span class="tag ${done ? 'ok' : err ? 'err' : ''}">${esc(j.status)}${j.items ? ` ${j.item || 0}/${j.items}` : ''}</span></div>
        <small style="color:var(--muted)">${j.mode === 'audio' ? 'Audio ' + esc(j.format.toUpperCase()) : 'Video'}, ${esc(j.quality === 'best' ? 'qualità massima' : j.quality)}</small>
        ${err ? `<p style="color:var(--danger);margin:6px 0 0;font-size:.88rem">${esc(j.error)}</p>` : done ? '' : `<div class="bar"><i style="width:${j.progress || 0}%"></i></div>`}
      </div>`;
    }).join('') : groups.length ? '' : '<div class="empty">Nessun download.</div>');
    let audioDone = grew, changed = false;
    for (const j of jobs) if (j.status.startsWith('completato') && !scanned.has(j.id)) { scanned.add(j.id); changed = true; if (j.mode === 'audio') audioDone = true; else refreshVideos(); }
    if (changed) store.set('scanned', [...scanned].slice(-400));
    if (audioDone && !plServer()) {  // con "plserver" la scansione e le playlist le fa il server
      api('startScan').then(() => toast('Libreria in aggiornamento: i nuovi brani arrivano tra poco.')).catch(() => {});
      setTimeout(resolvePending, 25000);
    }
  } catch (e) { if (box) box.innerHTML = `<div class="empty"><h3>Servizio di download non raggiungibile</h3><p>${esc(e.message)}</p><a class="btn" href="#/impostazioni">Impostazioni</a></div>`; viewTimers.forEach(clearInterval); }
}
async function refreshVideos() {
  const box = $('#vids'); if (!box) return;
  try {
    const v = await dlApi('/api/videos');
    box.innerHTML = v.length ? v.map(x => `<div class="list-item" data-act="playvideo" data-path="${esc(x.path)}" data-name="${esc(x.name)}">
      <span class="pic" style="display:grid;place-items:center">${ic('film')}</span><span class="grow"><b>${esc(x.name)}</b><small>${esc(x.folder)}, ${bytes(x.size)}</small></span>
      <a class="icon-btn" href="${esc(videoUrl(x.path, true))}"${NATIVE ? ' target="_blank" rel="noopener"' : ''} aria-label="Scarica sul dispositivo" onclick="event.stopPropagation()">${ic('down')}</a>
      <button class="icon-btn" data-act="delvideo" data-path="${esc(x.path)}" aria-label="Elimina">${ic('trash')}</button></div>`).join('')
      : '<div class="empty">Nessun video. Scegli "Video" per scaricarne uno.</div>';
  } catch { box.innerHTML = ''; }
}

/* ================= caricamento dal dispositivo nella libreria del server ================= */
const UP_EXT = /\.(mp3|flac|m4a|aac|ogg|oga|opus|wav|aif|aiff|wma|wv|ape)$/i, UP_COVER = /^(cover|folder)\.(jpe?g|png)$/i;
const Up = { list: [], busy: false };
function vUpload(tabs) {
  if (S.dl.url && !access().upload) { view.innerHTML = `<h1>Scarica</h1>${tabs}<div class="empty">Il caricamento non è abilitato per il tuo utente. Chiedilo a chi gestisce il server.</div>`; return; }
  view.innerHTML = `<h1>Scarica</h1><p class="sub">Dal telefono o dal computer alla libreria del server: file singoli o cartelle intere. Le copertine cover.jpg e folder.jpg vengono caricate insieme agli album.</p>
  ${tabs}
  <div class="panel">
    <div class="drop" id="upDrop"><b>Trascina qui file o cartelle</b><small>MP3, FLAC, M4A, Opus, OGG, WAV, AIFF e altri formati audio</small>
      <div class="row" style="justify-content:center;margin-top:12px"><label class="btn primary">${ic('plus')} Scegli file<input type="file" id="upFiles" multiple accept="audio/*,.flac,.opus,.ape,.wv,.wma" hidden></label><label class="btn">Scegli cartella<input type="file" id="upDir" webkitdirectory hidden></label></div></div>
    <label class="f" style="margin-top:14px">Cartella nella libreria<input type="text" id="upDest" value="${esc(store.get('upDir', 'Caricati'))}"></label>
  </div>
  <div class="row between"><h2>Caricamenti</h2><button class="btn sm" data-act="upclear">Rimuovi conclusi</button></div>
  <div id="ups"></div>`;
  $('#upDest').onchange = e => store.set('upDir', e.target.value.trim() || 'Caricati');
  $('#upFiles').onchange = e => { upAdd([...e.target.files].map(f => [f, f.name])); e.target.value = ''; };
  $('#upDir').onchange = e => { upAdd([...e.target.files].map(f => [f, f.webkitRelativePath || f.name])); e.target.value = ''; };
  const drop = $('#upDrop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = async e => {
    e.preventDefault(); drop.classList.remove('over');
    const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
    upAdd(entries.length ? (await Promise.all(entries.map(readEntry))).flat() : [...e.dataTransfer.files].map(f => [f, f.name]));
  };
  upRender();
}
// una cartella trascinata va letta a pezzi: readEntries restituisce al massimo 100 voci per volta
async function readEntry(en) {
  if (en.isFile) return [[await new Promise((res, rej) => en.file(res, rej)), en.fullPath.replace(/^\//, '')]];
  const r = en.createReader(), out = [];
  for (let batch; (batch = await new Promise((res, rej) => r.readEntries(res, rej))).length;) out.push(...batch);
  return (await Promise.all(out.map(readEntry))).flat();
}
function upAdd(files) {
  if (!S.dl.url) return toast('Questo server non ha Armony: il caricamento non è disponibile.');
  const folder = $('#upDest')?.value.trim() || store.get('upDir', 'Caricati');
  let skipped = 0;
  for (const [file, path] of files) {
    const name = path.split('/').pop();
    if (UP_EXT.test(name) || UP_COVER.test(name)) Up.list.push({ file, path, folder, status: 'in coda', progress: 0 });
    else if (!name.startsWith('.')) skipped++;
  }
  if (skipped) toast(skipped === 1 ? '1 file ignorato: non è audio né una copertina.' : `${skipped} file ignorati: non sono audio né copertine.`);
  upRender(); upRun();
}
async function upRun() {
  if (Up.busy) return; Up.busy = true;
  let added = 0;
  for (let u; (u = Up.list.find(x => x.status === 'in coda'));) {
    u.status = 'in corso'; upRender();
    try {
      const r = await upSend(u);
      u.status = r.status; u.dup = r.existing; if (r.status === 'caricato') added++;
    } catch (e) { u.status = 'errore'; u.error = e.message; }
    upRender();
  }
  Up.busy = false;
  if (added) (plServer() ? Promise.resolve() : api('startScan')).then(() => toast(`${added} file caricati: la libreria si aggiorna tra poco.`)).catch(() => {});
}
function upSend(u) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();  // fetch non dà l'avanzamento dell'invio
    x.open('PUT', `${S.dl.url.replace(/\/+$/, '')}/api/upload?folder=${encodeURIComponent(u.folder)}&path=${encodeURIComponent(u.path)}${u.force ? '&doppio=1' : ''}`);
    x.setRequestHeader('X-Token', S.dl.token);
    x.upload.onprogress = e => { if (e.lengthComputable) { u.progress = Math.round(e.loaded * 100 / e.total); upRender(u); } };
    x.onload = () => {
      let j = {}; try { j = JSON.parse(x.responseText); } catch {}
      if (x.status === 401) rej(new Error('Codice di accesso del servizio di download errato.'));
      else if (x.status === 413) rej(new Error('File troppo grande per il server.'));
      else if (x.status >= 400) rej(new Error(j.error || `Errore ${x.status}`));
      else res(j);
    };
    x.onerror = () => rej(new Error('Server non raggiungibile.'));
    x.send(u.file);
  });
}
function upRender(only) {
  const box = $('#ups'); if (!box) return;
  if (only) { const b = box.querySelector(`[data-ui="${Up.list.indexOf(only)}"] .bar i`); if (b) { b.style.width = only.progress + '%'; return; } }
  const n = s => Up.list.filter(x => x.status === s).length, left = n('in coda') + n('in corso');
  box.innerHTML = Up.list.length ? (left ? `<p class="small" style="color:var(--muted);margin:0 0 8px">${left} da caricare. Tieni aperta questa pagina finché non finisce.</p>` : '')
    + Up.list.map((u, i) => `<div class="panel" style="padding:12px 14px" data-ui="${i}">
      <div class="row between" style="flex-wrap:nowrap"><b style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(u.path)}</b>
      <span class="tag ${u.status === 'caricato' || u.status === 'già presente' ? 'ok' : u.status === 'errore' ? 'err' : ''}">${esc(u.status)}</span></div>
      <small style="color:var(--muted)">${bytes(u.file.size)}</small>
      ${u.status === 'già in libreria' ? `<div class="row between" style="margin-top:6px;flex-wrap:nowrap"><small style="min-width:0">C'è già: ${esc(u.dup || '')}</small><button class="btn sm" data-act="upforce" data-i="${i}">Carica lo stesso</button></div>` : ''}
      ${u.status === 'errore' ? `<p style="color:var(--danger);margin:6px 0 0;font-size:.88rem">${esc(u.error)}</p>` : u.status === 'in corso' ? `<div class="bar"><i style="width:${u.progress}%"></i></div>` : ''}
    </div>`).join('') : '<div class="empty">Nessun caricamento.</div>';
}
addEventListener('beforeunload', e => { if (Up.busy) e.preventDefault(); });

/* ================= playlist: import, export, completamento ================= */
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',' || c === ';' && !text.slice(0, 2000).includes(',')) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
function parsePlaylistFile(name, text) {
  let title = name.replace(/\.[^.]+$/, ''), items = [];
  if (/\.json$/i.test(name)) {
    const j = JSON.parse(text); title = j.name || title;
    items = arr(j.tracks).map(t => ({ title: t.title, artist: t.artist, album: t.album }));
  } else if (/\.csv$/i.test(name)) {
    const rows = parseCSV(text); const h = rows.shift().map(x => x.trim().toLowerCase());
    if (h.includes('track name') && h.includes('artist name(s)')) return { title, items: rows.map(r => exportifyRow(h, r)).filter(x => x.title) };
    const ti = h.findIndex(x => /track name|^title$|titolo|^name$|song/.test(x)), ai = h.findIndex(x => /artist/.test(x)), li = h.findIndex(x => /album name|^album$/.test(x));
    if (ti < 0) throw new Error('Nel CSV manca una colonna con il titolo.');
    items = rows.map(r => ({ title: r[ti], artist: ai >= 0 ? (r[ai] || '').split(/[;,]/)[0].trim() : '', album: li >= 0 ? r[li] : '' })).filter(x => x.title);
  } else {
    let pending = null;
    for (const raw of text.split(/\r?\n/)) {
      const l = raw.trim();
      if (l.startsWith('#EXTINF')) { const info = l.split(',').slice(1).join(','); const m = info.split(' - '); pending = m.length > 1 ? { artist: m[0].trim(), title: m.slice(1).join(' - ').trim() } : { title: info.trim() }; }
      else if (l.startsWith('#PLAYLIST:')) title = l.slice(10).trim();
      else if (l && !l.startsWith('#')) {
        if (!pending) { const b = decodeURIComponent(l.split(/[\\/]/).pop()).replace(/\.[^.]+$/, '').replace(/^\d+[\s.\-_]+/, ''); const m = b.split(' - '); pending = m.length > 1 ? { artist: m[0], title: m.slice(1).join(' - ') } : { title: b }; }
        items.push(pending); pending = null;
      }
    }
  }
  return { title, items };
}
// una riga di Exportify (formato vecchio e nuovo) con tutto ciò che serve a riconoscere e a etichettare il brano;
// lo stesso schema lo legge il server (server/metadati.py, da_exportify)
function exportifyRow(h, r) {
  const g = (...ks) => { for (const k of ks) { const i = h.indexOf(k); if (i >= 0 && (r[i] || '').trim()) return r[i].trim(); } return ''; };
  const ms = +g('duration (ms)', 'track duration (ms)');
  // Exportify separa gli artisti con ";": la virgola può far parte del nome ("Tyler, The Creator")
  const artists = g('artist name(s)').split(';').map(x => x.trim()).filter(Boolean);
  return { title: g('track name'), artist: artists[0] || '', artists, album: g('album name'), albumartist: g('album artist name(s)').split(';')[0].trim(),
    date: g('release date', 'album release date'), duration: ms ? Math.round(ms / 1000) : null, isrc: g('isrc').toUpperCase(),
    genres: g('genres').split(',').map(x => x.trim()).filter(Boolean), label: g('record label', 'label'),
    track: +g('track number') || null, disc: +g('disc number') || null, cover: g('album image url'), spotify: g('track uri') };
}
const cleanTxt = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\(.*?\)|\[.*?\]|- .*remaster.*$|feat\..*$/g, '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
// riconoscere un brano già in libreria: titolo, artisti, durata (il segnale più affidabile) e album
async function matchTrack(it, s = srv()) {
  const T = cleanTxt(it.title); if (!T) return null;
  const arts = (it.artists?.length ? it.artists : [it.artist]).map(cleanTxt).filter(Boolean);
  const r = (await api('search3', { query: T, songCount: 30, artistCount: 0, albumCount: 0 }, s)).searchResult3;
  const score = x => {
    const xt = cleanTxt(x.title), xa = cleanTxt(`${x.artist || ''} ${x.displayArtist || ''}`);
    let sc = xt === T ? 3 : xt.startsWith(T) || T.startsWith(xt) ? 1.5 : -9;
    if (arts.length) sc += arts.some(a => xa.includes(a) || (xa && a.includes(xa))) ? 2 : -2;
    if (it.duration && x.duration) { const dd = Math.abs(x.duration - it.duration); sc += dd <= 3 ? 2 : dd <= 8 ? .5 : -2; }
    if (it.album && cleanTxt(x.album) === cleanTxt(it.album)) sc += 1;
    return sc;
  };
  let best = null, bs = -Infinity;
  for (const x of arr(r.song)) { const sc = score(x); if (sc > bs) { bs = sc; best = x; } }
  return best && bs >= (arts.length ? 4.5 : 3) ? best : null;
}
async function addSongsToPlaylist(pid, ids, sid) { for (let i = 0; i < ids.length; i += 200) await api('updatePlaylist', { playlistId: pid, songIdToAdd: ids.slice(i, i + 200) }, srv(sid), true); }
async function createPlaylist(name, ids, sid = S.active) {
  const r = await api('createPlaylist', { name, songId: ids.slice(0, 200) }, srv(sid), true);
  const pid = r.playlist?.id; if (pid && ids.length > 200) await addSongsToPlaylist(pid, ids.slice(200), sid);
  return pid;
}
// importazione: uno o più file (es. tutte le playlist esportate con Exportify). Ogni file diventa una playlist
// (se esiste già con lo stesso nome vi si aggiungono i brani mancanti, così si può rifare dopo i download);
// i brani assenti si scaricano una volta sola anche se stanno in più playlist (/api/import).
async function importPlaylist() {
  if (!srv()) return toast('Prima aggiungi un server.');
  const files = await pickFile('.m3u,.m3u8,.json,.csv,.txt', true); if (!files?.length) return;
  const lists = [];
  for (const f of files) { try { const p = parsePlaylistFile(f.name, await f.text()); if (p.items.length) lists.push(p); } catch (e) { toast(`${f.name}: ${e.message || 'file non valido'}`); } }
  if (!lists.length) return toast('Nessun brano trovato nei file.');
  if (srv()?.me?.caps?.includes('importsrv')) return importOnServer(lists);
  const total = lists.reduce((n, l) => n + l.items.length, 0), d = $('#dlg'); d.className = '';
  d.innerHTML = `<h3>Importo ${lists.length > 1 ? `${lists.length} playlist` : `"${esc(lists[0].title)}"`}</h3><p class="sub" id="impMsg">0 di ${total}</p><div class="bar"><i id="impBar" style="width:0"></i></div>`; d.showModal();
  const k = it => it.isrc || cleanTxt(`${it.artist} ${it.title}`), seen = new Map(), missing = new Map(), report = [];
  let done = 0, existing = [];
  try { existing = arr((await api('getPlaylists')).playlists?.playlist); } catch {}
  for (const l of lists) {
    const ids = [], miss = [];
    for (const it of l.items) {
      const key = k(it);
      if (!seen.has(key)) { let m = null; try { m = await matchTrack(it); } catch {} seen.set(key, m?.id || null); }
      const id = seen.get(key); id ? ids.push(id) : (miss.push(it), missing.set(key, it));
      if (++done % 5 === 0 || done === total) { const b = $('#impBar'); if (b) { $('#impMsg').textContent = `${done} di ${total} · ${l.title}`; b.style.width = (done / total * 100) + '%'; } }
    }
    let pid = existing.find(p => p.name === l.title)?.id;
    try {
      if (pid) { const have = new Set(arr((await api('getPlaylist', { id: pid })).playlist?.entry).map(x => x.id)); const add = [...new Set(ids)].filter(x => !have.has(x)); if (add.length) await addSongsToPlaylist(pid, add, S.active); }
      else pid = await createPlaylist(l.title, [...new Set(ids)]);
    } catch (e) { toast(`${l.title}: ${e.message}`); }
    report.push({ title: l.title, pid, found: ids.length, total: l.items.length, miss });
  }
  const nMiss = missing.size, canDl = !!S.dl.url && access().download;
  d.innerHTML = `<h3>Importazione conclusa</h3>
    <p>${total - [...report].reduce((n, r) => n + r.miss.length, 0)} brani su ${total} erano già in libreria${lists.length > 1 ? `, in ${lists.length} playlist` : ''}.</p>
    ${lists.length > 1 ? `<div class="code" style="font-family:inherit;font-size:.88rem;max-height:180px">${report.map(r => `${esc(r.title)}: ${r.found} di ${r.total}`).join('<br>')}</div>` : ''}
    ${nMiss ? `<p class="sub" style="margin:12px 0 6px">${nMiss} brani mancano sul server${nMiss < 40 ? ':' : '.'}</p>
      ${nMiss < 40 ? `<div class="code" style="font-family:inherit;font-size:.88rem">${[...missing.values()].map(m => esc(`${(m.artists || [m.artist]).filter(Boolean).join(', ')} - ${m.title}`)).join('<br>')}</div>` : ''}
      <p class="small" style="color:var(--muted)">${canDl ? 'Armony li cerca online con la durata giusta, li scarica con copertina, album, numero di traccia e data, e li aggiunge alle playlist appena la libreria si aggiorna.' : 'Per scaricarli serve il permesso di download.'}</p>` : ''}
    <div class="row">${nMiss && canDl ? `<button class="btn primary" id="getMissing">Scarica i ${nMiss} mancanti</button>` : ''}<button class="btn" onclick="this.closest('dialog').close()">Chiudi</button></div>`;
  if (nMiss && canDl) $('#getMissing').onclick = async () => {
    try {
      const label = `Spotify: ${lists.length === 1 ? report[0]?.title || 'playlist' : lists.length + ' playlist'}`;
      // "plserver": ogni brano porta le sue playlist e le completa il server, anche a dispositivo spento
      const pl = plServer(), pids = new Map();
      if (pl) for (const rp of report) if (rp.pid) for (const it of rp.miss) { const key = k(it); pids.has(key) || pids.set(key, []); pids.get(key).includes(rp.pid) || pids.get(key).push(rp.pid); }
      const tracks = [...missing].map(([key, it]) => pl ? { ...it, pids: pids.get(key) || [] } : it);
      const r = await dlApi('/api/import', { method: 'POST', body: JSON.stringify({ tracks, folder: store.get('impDir', 'Spotify'), label }) });
      if (pl) { d.close(); toast(`${r.added} download in coda${r.skipped ? `, ${r.skipped} già in coda` : ''}. Entrano nelle playlist appena sono in libreria.`); location.hash = '#/scarica'; return; }
      // in attesa: solo ciò che serve a riconoscerli quando arrivano in libreria
      const slim = it => ({ title: it.title, artist: it.artist, artists: it.artists, album: it.album, duration: it.duration, isrc: it.isrc });
      const pend = store.get('pending', []);
      // una sola nota per playlist: reimportare lo stesso CSV non deve aggiungere i brani più volte
      const kOf = it => it.isrc || cleanTxt((it.artists?.[0] || it.artist || '') + ' ' + it.title);
      for (const rp of report) if (rp.pid && rp.miss.length) {
        let e = pend.find(x => x.pid === rp.pid && x.sid === S.active);
        if (!e) pend.push(e = { pid: rp.pid, sid: S.active, name: rp.title, items: [], created: Date.now() });
        const have = new Set(e.items.map(kOf));
        for (const it of rp.miss.map(slim)) if (!have.has(kOf(it))) { have.add(kOf(it)); e.items.push(it); }
        e.created = Date.now();
      }
      store.set('pending', pend);
      d.close(); toast(`${r.added} download in coda${r.skipped ? `, ${r.skipped} già in coda` : ''}. Li aggiungo alle playlist quando sono pronti.`); location.hash = '#/scarica';
    } catch (e) { toast(e.message); }
  };
  if (location.hash.startsWith('#/playlist')) route();
}
// importazione sul server (capacità "importsrv", server/importa.py): il server riconosce i brani sul suo database,
// ricorda l'elenco e tiene la playlist completa e in ordine mentre i mancanti arrivano, anche ad app chiusa.
// La playlist la crea il client, così è dell'utente; un secondo invio con download=true mette in coda i mancanti
async function importOnServer(lists) {
  const d = $('#dlg'); d.className = '';
  d.innerHTML = `<h3>Importo ${lists.length > 1 ? `${lists.length} playlist` : `"${esc(lists[0].title)}"`}</h3><p class="sub" id="impMsg">Riconosco i brani sul server…</p><div class="bar"><i id="impBar" style="width:4%"></i></div>`; d.showModal();
  const me = srv().user, mine = arr((await api('getPlaylists').catch(() => null))?.playlists?.playlist).filter(p => !p.owner || p.owner === me);
  const send = (x, download) => dlApi('/api/import/playlist', { method: 'POST', body: JSON.stringify({ pid: x.pid, name: x.title, items: x.items, download, ids: !!x.ids, folder: store.get('impDir', 'Spotify'), format: 'm4a' }) });
  const done = [];
  for (const [i, l] of lists.entries()) {
    $('#impMsg').textContent = `${l.title} · ${i + 1} di ${lists.length}`;
    try {
      const pid = mine.find(p => p.name === l.title)?.id || await createPlaylist(l.title, []);
      const items = l.items.map(it => ({ ...it, artists: it.artists?.length ? it.artists : [it.artist].filter(Boolean) }));
      const liked = /^(liked[ _]?songs|brani che ti piacciono|saved[ _]?tracks)$/i.test(l.title.trim());
      const r = await send({ pid, title: l.title, items, ids: liked }, false);
      // "Brani che ti piacciono" di Spotify: oltre alla playlist, i brani riconosciuti prendono il cuore (Preferiti)
      if (liked && r.ids?.length) { for (let k = 0; k < r.ids.length; k += 100) await api('star', { id: r.ids.slice(k, k + 100) }).catch(() => {}); r.starred = r.ids.length; }
      done.push({ title: l.title, pid, items, r });
    } catch (e) { done.push({ title: l.title, err: e.message }); }
    $('#impBar').style.width = ((i + 1) / lists.length * 100) + '%';
  }
  emit('playlists');
  const ok = done.filter(x => x.r), tot = ok.reduce((n, x) => n + x.r.total, 0), have = ok.reduce((n, x) => n + x.r.inlib, 0);
  const miss = ok.reduce((n, x) => n + x.r.miss, 0), canDl = !!S.dl.url && access().download;
  d.innerHTML = `<h3>Importazione conclusa</h3>
    <p>${have.toLocaleString('it-IT')} brani su ${tot.toLocaleString('it-IT')} erano già in libreria${ok.length > 1 ? `, in ${ok.length} playlist` : ''}: sono già al loro posto.</p>
    ${done.length > 1 || done.some(x => x.err) ? `<div class="code" style="font-family:inherit;font-size:.88rem;max-height:180px">${done.map(x => x.err ? `${esc(x.title)}: <span style="color:var(--danger)">${esc(x.err)}</span>` : `${esc(x.title)}: ${x.r.inlib} di ${x.r.total}${x.r.starred ? ` · ${x.r.starred} nei Preferiti` : ''}`).join('<br>')}</div>` : ''}
    ${miss ? `<p class="sub" style="margin:12px 0 6px">${miss} brani mancano sul server${ok.length === 1 && ok[0].r.missing?.length ? ':' : '.'}</p>
      ${ok.length === 1 && ok[0].r.missing?.length ? `<div class="code" style="font-family:inherit;font-size:.88rem;max-height:160px">${ok[0].r.missing.map(esc).join('<br>')}${miss > ok[0].r.missing.length ? '<br>…' : ''}</div>` : ''}
      <p class="small" style="color:var(--muted)">${canDl ? 'Armony li cerca online con la durata giusta e li scarica con copertina, album e numero di traccia. Entrano nella playlist al loro posto appena arrivano, anche se chiudi l\'app.' : 'Per scaricarli serve il permesso di download.'}</p>` : ''}
    <div class="row">${miss && canDl ? `<button class="btn primary" id="getMissing">Scarica i ${miss} mancanti</button>` : ''}<button class="btn" onclick="this.closest('dialog').close()">Chiudi</button></div>`;
  if (miss && canDl) $('#getMissing').onclick = async () => {
    $('#getMissing').disabled = true; let q = 0;
    try { for (const x of ok) if (x.r.miss) q += (await send(x, true)).queued; } catch (e) { return toast(e.message); }
    d.close(); toast(`${q} download in coda: entrano nelle playlist appena sono in libreria.`); location.hash = '#/scarica';
  };
  if (location.hash.startsWith('#/playlist')) route();
}
let pendingBusy = false;
async function resolvePending() {
  let pend = store.get('pending', []); if (!pend.length || pendingBusy) return;
  pendingBusy = true; let added = 0, budget = 150;  // per giro: con migliaia di brani in attesa non si blocca il server
  for (const p of pend) {
    const s = srv(p.sid); if (!s) continue;
    const still = [], ids = [];
    for (const it of p.items) {
      if (budget-- <= 0) { still.push(it); continue; }
      try { const m = await matchTrack(it, s); m ? ids.push(m.id) : still.push(it); } catch { still.push(it); }
    }
    if (ids.length) {
      try {
        const have = new Set(arr((await api('getPlaylist', { id: p.pid }, s)).playlist?.entry).map(x => x.id));
        const add = [...new Set(ids)].filter(x => !have.has(x));
        if (add.length) await addSongsToPlaylist(p.pid, add, p.sid);
        added += add.length;
      } catch { still.push(...p.items.filter((_, i) => i < ids.length)); }
    }
    p.items = still;
  }
  pend = pend.filter(p => p.items.length && Date.now() - p.created < 14 * 864e5); store.set('pending', pend);
  pendingBusy = false;
  if (added) toast(`${added} brani scaricati aggiunti alle playlist.`);
  if (pend.length && budget <= 0) setTimeout(resolvePending, 60000);
}
function toM3U(name, tracks) {
  return '#EXTM3U\n#PLAYLIST:' + name + '\n' + tracks.map(t => `#EXTINF:${Math.round(t.duration)},${t.artist} - ${t.title}\n${safeName(t.artist + ' - ' + t.title)}.${t.suffix || 'mp3'}`).join('\n') + '\n';
}
const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
function exportTracks(name, tracks) {
  const d = $('#dlg2');
  d.innerHTML = `<h3>Esporta "${esc(name)}"</h3><p class="sub">M3U per altri lettori, JSON per Armony, CSV per fogli di calcolo e altri servizi.</p>
    <div class="row"><button class="btn" data-f="m3u">M3U</button><button class="btn" data-f="json">JSON</button><button class="btn" data-f="csv">CSV</button><button class="btn" onclick="this.closest('dialog').close()">Chiudi</button></div>`;
  d.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
    const f = b.dataset.f, n = safeName(name);
    if (f === 'm3u') saveFile(n + '.m3u', toM3U(name, tracks), 'audio/x-mpegurl');
    else if (f === 'json') saveFile(n + '.json', JSON.stringify({ app: 'armony', version: 1, name, exported: new Date().toISOString(), tracks: tracks.map(t => ({ title: t.title, artist: t.artist, album: t.album, duration: t.duration })) }, null, 2), 'application/json');
    else saveFile(n + '.csv', 'Track Name,Artist Name(s),Album Name,Duration (s)\n' + tracks.map(t => [t.title, t.artist, t.album, t.duration].map(csvCell).join(',')).join('\n'), 'text/csv');
    d.close();
  });
  d.showModal();
}
async function addToPlaylistDialog(tracks) {
  const d = $('#dlg'); d.className = '';
  d.innerHTML = '<h3>Aggiungi a playlist</h3><p class="sub">Caricamento…</p>'; d.showModal();
  try {
    const sid = tracks[0].serverId;
    // le mie e quelle in cui collaboro (le altre pubbliche si vedono ma non si modificano)
    const me = (srv(sid)?.user || '').toLowerCase(), pls = arr((await api('getPlaylists', {}, srv(sid))).playlists.playlist).filter(p => !p.owner || p.owner.toLowerCase() === me || Amici.collab.has(p.id) || access().admin);
    pls.sort((a, b) => String(b.changed || '').localeCompare(String(a.changed || '')));  // le usate di recente in cima
    d.innerHTML = `<h3>Aggiungi ${tracks.length > 1 ? tracks.length + ' brani' : 'a playlist'}</h3>
      ${pls.length > 6 ? '<input type="search" id="apQ" placeholder="Cerca una playlist" style="margin-bottom:8px">' : ''}
      <div style="max-height:45vh;overflow:auto" id="apList">${pls.map(p => `<div class="list-item" data-pl="${esc(p.id)}"><span class="grow"><b>${esc(p.name)}</b>${Amici.collab.has(p.id) ? `<small>collaborativa · di ${esc(p.owner)}</small>` : ''}</span><small>${p.songCount}</small></div>`).join('')}</div>
      <div class="row" style="margin-top:12px;flex-wrap:nowrap"><input type="text" id="npName" placeholder="Nuova playlist"><button class="btn primary" id="npGo">Crea</button></div>
      <div class="row" style="margin-top:10px"><button class="btn" onclick="this.closest('dialog').close()">Chiudi</button></div>`;
    const ids = tracks.map(t => t.id);
    $('#apQ')?.addEventListener('input', e => { const q = cleanTxt(e.target.value); d.querySelectorAll('#apList [data-pl]').forEach(el => { el.hidden = !!q && !cleanTxt(el.textContent).includes(q); }); });
    d.querySelectorAll('[data-pl]').forEach(el => el.onclick = async () => {
      try {
        // come Spotify: avviso se ci sono già, e si può saltare i doppioni
        const there = new Set(arr((await api('getPlaylist', { id: el.dataset.pl }, srv(sid))).playlist.entry).map(x => x.id));
        const dup = ids.filter(i => there.has(i));
        if (dup.length === ids.length) { d.close(); return toast(ids.length === 1 ? 'È già nella playlist.' : 'Sono già tutti nella playlist.'); }
        if (dup.length && !confirm(`${dup.length === 1 ? 'Un brano è' : dup.length + ' brani sono'} già nella playlist.\n\nOK = aggiungili comunque, Annulla = salta i doppioni`)) ids.splice(0, ids.length, ...ids.filter(i => !there.has(i)));
        if (Amici.collab.has(el.dataset.pl)) await srvApi(srv(sid), '/api/collab/aggiungi', { method: 'POST', body: JSON.stringify({ pid: el.dataset.pl, ids }) });
        else await addSongsToPlaylist(el.dataset.pl, ids, sid);
        d.close(); toast('Aggiunto alla playlist.');
      } catch (e) { toast(e.message); }
    });
    $('#npGo').onclick = async () => { const name = $('#npName').value.trim(); if (!name) return; try { await createPlaylist(name, ids, sid); d.close(); toast(`Playlist "${name}" creata.`); } catch (e) { toast(e.message); } };
  } catch (e) { d.innerHTML = `<h3>Errore</h3><p>${esc(e.message)}</p><button class="btn" onclick="this.closest('dialog').close()">Chiudi</button>`; }
}
async function shareItem(id, name, sid = S.active) {
  const s = srv(sid);
  try {
    const r = await api('createShare', { id, description: name, expires: Date.now() + 30 * 864e5 }, s);
    let url = arr(r.shares?.share)[0]?.url; if (!url) throw new Error('Il server non ha creato il link.');
    const pb = s.shareBase || s.me?.public; if (pb) { const u = new URL(url); url = pb.replace(/\/+$/, '') + u.pathname + u.search; }
    if (navigator.share) { try { await navigator.share({ title: name, text: `Ascolta "${name}" su Armony`, url }); return; } catch {} }
    await copyText(url); toast('Link copiato. Funziona per 30 giorni, anche per chi non ha un account.');
  } catch (e) { toast(e.message.includes('sharing') || e.message.includes('70') ? 'Le condivisioni non sono attive sul server (ND_ENABLESHARING).' : e.message); }
}
// brani simili all'artista; se il server non ne conosce, tutti i suoi album
async function artistRadio(id) {
  let songs = []; try { songs = arr((await api('getSimilarSongs2', { id, count: 80 })).similarSongs2?.song); } catch {}
  if (!songs.length) { const a = (await api('getArtist', { id })).artist; const albums = await Promise.all(arr(a.album).map(al => api('getAlbum', { id: al.id }))); songs = albums.flatMap(r => arr(r.album.song)); }
  return songs;
}
/* ================= fra amici (capacità "amici", server/amici.py) ================= */
I.send = '<path d="M4 12l16-8-6 16-3-7z"/><path d="M11 13l9-9"/>';
const Amici = {
  collab: new Set(), users: null,
  on() { return !!srv()?.me?.caps?.includes('amici') && !!srv()?.session && !srv()?.local; },
  async load() { if (!this.on()) return; try { this.collab = new Set((await srvApi(srv(), '/api/collab/mie')).items.map(x => x.id)); } catch {} },
  async utenti() { if (!this.users) { try { this.users = (await srvApi(srv(), '/api/amici/utenti')).users; } catch { this.users = []; } } return this.users; },
  // «Manda a un amico»: scegli chi, un messaggio facoltativo; arriva come notifica e in Amici → Ricevuti
  async manda(x) {
    const us = await this.utenti(); if (!us.length) return toast('Su questo server non ci sono altri utenti.');
    const d = $('#dlg'); d.className = 'sheet';
    d.innerHTML = `<div class="head"><span class="grow"><b style="display:block">Manda a un amico</b><small style="color:var(--muted)">«${esc(x.title)}»${x.sub ? ' · ' + esc(x.sub) : ''}</small></span></div>
      <label class="f" style="padding:0 14px">Messaggio (facoltativo)<input type="text" id="mMsg" maxlength="280" placeholder="Senti questa!"></label>
      ${us.map(u => `<button class="mi" data-u="${esc(u)}">${pavatar({ user: u, name: u }, 's')}<span class="grow">${esc(u)}</span>${ic('send')}</button>`).join('')}`;
    d.querySelectorAll('[data-u]').forEach(b => b.onclick = async () => {
      try { await srvApi(srv(), '/api/manda', { method: 'POST', body: JSON.stringify({ ...x, to: b.dataset.u, msg: $('#mMsg').value }) }); d.close(); toast(`Mandato a ${b.dataset.u}.`); }
      catch (e) { toast(e.message); }
    });
    closeOutside(d); d.showModal();
  },
  async ricevuti(box, n) {
    let r; try { r = await srvApi(srv(), '/api/manda'); } catch { return; }
    if (stale(n) || !box.isConnected) return;
    const KIND = { brano: 'Brano', album: 'Album', playlist: 'Playlist', artista: 'Artista' };
    box.innerHTML = r.ricevuti.length ? r.ricevuti.map((x, i) => `<div class="nrow go" data-ri="${i}" role="button" tabindex="0"><span class="nic">${ic(x.kind === 'album' ? 'album' : x.kind === 'playlist' ? 'list' : x.kind === 'artista' ? 'user' : 'play')}</span>
        <span class="grow"><b>${esc(x.title)}</b><small>${KIND[x.kind]}${x.sub ? ' · ' + esc(x.sub) : ''} · da ${esc(x.nome || x.da)}${x.msg ? ` — «${esc(x.msg)}»` : ''}</small></span>
        <time>${new Date(x.ts * 1000).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}</time></div>`).join('')
      : '<p class="sub">Quando un amico ti manda un brano, un album o una playlist, lo trovi qui.</p>';
    box.querySelectorAll('[data-ri]').forEach(el => el.onclick = async () => {
      const x = r.ricevuti[+el.dataset.ri];
      if (x.kind === 'brano') { try { setQueue([norm((await api('getSong', { id: x.ref })).song)], 0); } catch { toast('Il brano non è più in libreria.'); } }
      else location.hash = { album: '#/album/', playlist: '#/playlist/', artista: '#/artista/' }[x.kind] + encodeURIComponent(x.ref);
    });
  },
  // Blend: il mix di due amici dai loro ascolti, con quanto vi somigliate
  async blendBox(box) {
    const us = await this.utenti(); if (!box.isConnected) return;
    if (!us.length) { box.innerHTML = '<p class="sub">Servono altri utenti su questo server.</p>'; return; }
    box.innerHTML = `<p class="sub" style="margin-top:0">Un mix fatto con i tuoi ascolti e quelli di un amico: prima i brani che piacciono a tutti e due, poi alternati quelli di ciascuno.</p>
      <div class="row">${us.map(u => `<button class="chip" data-b="${esc(u)}">${pavatar({ user: u, name: u }, 'xs')} ${esc(u)}</button>`).join('')}</div><div id="blendRes"></div>`;
    box.querySelectorAll('[data-b]').forEach(b => b.onclick = async () => {
      const res = $('#blendRes'); res.innerHTML = '<p class="sub">Preparo il mix…</p>';
      let r; try { r = await srvApi(srv(), '/api/blend?con=' + encodeURIComponent(b.dataset.b)); }
      catch (e) { res.innerHTML = `<p class="sub">${/403/.test(e.message) ? `${esc(b.dataset.b)} non mostra i suoi ascolti agli amici.` : 'Non ci sono ancora abbastanza ascolti per un mix.'}</p>`; return; }
      res.innerHTML = `<div class="panel blend"><span class="blend-aff"><b>${r.affinita}%</b><small>affinità</small></span><span class="grow"><b>Tu + ${esc(r.nome)}</b><small>${r.ids.length} brani · ${r.comuni} che ascoltate entrambi${r.artisti.length ? ' · insieme: ' + r.artisti.slice(0, 3).map(esc).join(', ') : ''}</small></span>
        <button class="btn primary" id="blendGo">${ic('play', true)} Ascolta</button></div>`;
      $('#blendGo').onclick = async () => {
        toast('Preparo il mix…');
        const l = (await Promise.all(r.ids.map(id => api('getSong', { id }).then(x => norm(x.song)).catch(() => null)))).filter(Boolean);
        if (!l.length) return toast('I brani del mix non sono più in libreria.');
        S.ctx = { kind: 'Blend', name: `Tu + ${r.nome}` }; store.set('qctx', S.ctx); S.queue = l; playIndex(0);
      };
    });
  },
  // collaboratori di una playlist (solo il proprietario li sceglie)
  async collabSheet(pid) {
    const [us, cur] = await Promise.all([this.utenti(), srvApi(srv(), '/api/collab?pid=' + encodeURIComponent(pid)).catch(e => ({ error: e.message }))]);
    if (cur.error) return toast(cur.error);
    const on = new Set(cur.users.map(u => u.toLowerCase())), d = $('#dlg'); d.className = 'sheet';
    d.innerHTML = `<div class="head"><span class="grow"><b style="display:block">Collaboratori</b><small style="color:var(--muted)">Possono aggiungere, togliere e riordinare i brani. La playlist diventa visibile agli altri utenti del server.</small></span></div>
      ${us.length ? us.map(u => `<label class="check" style="padding:8px 14px"><input type="checkbox" value="${esc(u)}" ${on.has(u.toLowerCase()) ? 'checked' : ''}><span>${esc(u)}</span></label>`).join('') : '<p class="sub" style="padding:0 14px">Non ci sono altri utenti.</p>'}
      <div class="row" style="padding:8px 14px"><button class="btn primary" id="coOk">Salva</button></div>`;
    $('#coOk').onclick = async () => {
      const users = [...d.querySelectorAll('input:checked')].map(i => i.value);
      try { await srvApi(srv(), '/api/collab', { method: 'PUT', body: JSON.stringify({ pid, users }) }); d.close(); toast(users.length ? `Collaborativa con ${users.join(', ')}.` : 'Non è più collaborativa.'); route(); }
      catch (e) { toast(/409/.test(e.message) ? 'Serve l\'amministratore di Navidrome in Impostazioni → Utenti → Registrazione.' : e.message); }
    };
    closeOutside(d); d.showModal();
  },
  // cambio password (Profilo): la vecchia si verifica su Navidrome; gli altri tuoi dispositivi ricevono le credenziali nuove
  passwordSheet() {
    const d = $('#dlg2'); d.className = '';
    d.innerHTML = `<h3>Cambia password</h3><p class="sub">Vale per Armony e per le app Subsonic collegate. I tuoi dispositivi con Armony aperta restano collegati.</p>
      <label class="f">Password attuale<input type="password" id="pwOld" autocomplete="current-password"></label>
      <label class="f">Password nuova (almeno 8 caratteri)<input type="password" id="pwNew" autocomplete="new-password" minlength="8"></label>
      <label class="f">Ripeti la password nuova<input type="password" id="pwNew2" autocomplete="new-password"></label>
      <p class="sub" id="pwMsg" style="color:var(--danger);min-height:1.2em"></p>
      <div class="row"><button class="btn primary" id="pwOk">Cambia</button><button class="btn" onclick="this.closest('dialog').close()">Annulla</button></div>`;
    $('#pwOk').onclick = async () => {
      const o = $('#pwOld').value, a = $('#pwNew').value, b = $('#pwNew2').value, msg = t => { $('#pwMsg').textContent = t; };
      if (a.length < 8) return msg('La password nuova deve avere almeno 8 caratteri.');
      if (a !== b) return msg('Le due password nuove non coincidono.');
      $('#pwOk').disabled = true;
      try {
        const r = await srvApi(srv(), '/api/password', { method: 'POST', body: JSON.stringify({ old: o, new: a }) });
        const s = srv(); s.tok = r.t; s.salt = r.s; persistServers(); d.close(); toast('Password cambiata.');
      } catch (e) { $('#pwOk').disabled = false; msg(/403/.test(e.message) ? 'La password attuale non è giusta.' : /429/.test(e.message) ? 'Troppi tentativi: riprova fra qualche minuto.' : e.message); }
    };
    d.showModal();
  }
};
/* ================= notifiche (capacità "notifiche", server/notifiche.py) ================= */
I.bell = '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>';
const NKIND = { import: 'nImport', download: 'nDownload', jam: 'nJam', dispositivi: 'nDev', amici: 'nAmici', sistema: null };
const Notif = {
  items: [], unread: 0,
  on() { return !!srv()?.me?.caps?.includes('notifiche') && !!srv()?.session; },
  async load() {
    if (!this.on()) { this.paint(); return; }
    try { const r = await srvApi(srv(), '/api/notifiche'); this.items = r.items; this.unread = r.unread; } catch {}
    this.paint(); this.views(); this.seen(Math.max(0, ...this.items.map(x => x.id))); this.native();
  },
  // riquadro aperto o pagina delle notifiche: si ridisegnano con lo stato nuovo
  views() { NotifPop.paint(); if (location.hash.startsWith('#/notifiche') && $('#nPage')) vNotifiche(); },
  // app Android: le notifiche arrivano anche ad app chiusa (ArmonyNotificheWorker, ogni 15 minuti) con un gettone che
  // vale solo per leggere quelle nuove; i tipi seguono Impostazioni → Notifiche. Con l'app aperta restano dentro l'app
  async native() {
    const F = NATIVE && window.Capacitor?.Plugins?.ArmonyFiles, s = srv();
    if (!F?.notifySetup || !s?.session || s.local || !s.me?.caps?.includes('notifondo')) return;
    if (!P.notifOn) return F.notifySetup({ on: false }).catch(() => {});
    try {
      const j = await srvApi(s, '/api/notifiche/gettone', { method: 'POST' });
      const kinds = Object.entries(NKIND).filter(([, k]) => P[k] !== false).map(([kind]) => kind).join(',');
      await F.notifySetup({ on: true, url: absUrl(s.url), token: j.token, last: j.last, kinds });
    } catch {}
  },
  seen(id) { const F = NATIVE && window.Capacitor?.Plugins?.ArmonyFiles; if (F?.notifySeen && id) F.notifySeen({ last: id }).catch(() => {}); },
  paint() {
    const b = $('#hBell'); if (!b) return;
    b.hidden = !this.on();
    b.innerHTML = ic('bell') + (this.unread ? `<i class="nbadge">${this.unread > 9 ? '9+' : this.unread}</i>` : '');
    b.setAttribute('aria-label', this.unread ? `Notifiche, ${this.unread} da leggere` : 'Notifiche');
  },
  // dal canale dal vivo: una nuova, o lette su un altro dispositivo
  recv(m) {
    if (m.lette) { if (m.lette === 'tutte') { this.items.forEach(x => x.letta = 1); this.unread = 0; } else { this.items.forEach(x => { if (m.lette.includes(x.id)) x.letta = 1; }); this.unread = this.items.filter(x => !x.letta).length; } this.paint(); return; }
    const n = m.item; if (!n || this.items.some(x => x.id === n.id)) return;
    this.items.unshift(n); this.unread++; this.paint(); this.seen(n.id);  // mostrata qui: il controllo nativo non la ripete
    this.views();
    const k = NKIND[n.kind];
    if (document.visibilityState === 'visible') return toast(`${n.title}${n.body ? ' · ' + n.body : ''}`, 5000);
    if (!P.notifOn || (k && P[k] === false)) return;
    this.system(n);
  },
  // avviso di sistema: notifica del telefono nell'app, del browser sul web (solo con la pagina nascosta)
  // più avvisi in pochi secondi (un album che finisce brano per brano, aggiunte in una playlist) diventano uno solo
  system(n) {
    (this.burst ||= []).push(n); clearTimeout(this.bt);
    this.bt = setTimeout(() => { const b = this.burst; this.burst = []; this.show(b.length === 1 ? b[0] : { id: b[b.length - 1].id, title: `${b.length} nuove notifiche`, body: b.map(x => x.title).slice(0, 4).join(' · '), link: '#/notifiche' }); }, 4000);
  },
  show(n) {
    const F = NATIVE && window.Capacitor?.Plugins?.ArmonyFiles;
    if (F) { F.notify({ id: n.id, title: n.title, body: n.body || '', link: n.link || '' }).catch(() => {}); return; }
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const w = new Notification(n.title, { body: n.body || '', icon: 'icon.svg', tag: 'armony-' + n.id });
    w.onclick = () => { window.focus(); if (n.link) location.hash = n.link; w.close(); };
  },
  async permission() {
    const F = NATIVE && window.Capacitor?.Plugins?.ArmonyFiles;
    if (F) { try { return (await F.notifyPermission()).granted; } catch { return false; } }
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    return (await Notification.requestPermission()) === 'granted';
  },
  async read(ids) {
    if (!this.on()) return;
    try { await srvApi(srv(), '/api/notifiche/lette', { method: 'POST', body: JSON.stringify(ids ? { ids } : {}) }); } catch {}
    this.items.forEach(x => { if (!ids || ids.includes(x.id)) x.letta = 1; }); this.unread = this.items.filter(x => !x.letta).length; this.paint(); this.views();
  }
};
// notifiche: «Nuove» (non lette) sopra e «Già lette» sotto, per giorno. Una diventa letta quando la si apre o con il
// suo pallino, o con «Segna tutte»: guardarle non basta, così le due parti restano distinte. Sul computer la campanella
// apre un riquadro a comparsa (NotifPop); sul telefono questa pagina
const NICON = { import: 'down', download: 'down', jam: 'jam', dispositivi: 'shield', amici: 'friends', sistema: 'bell' };
const nWhen = ts => { const d = new Date(ts * 1000), t = new Date(), y = new Date(t - 864e5), h = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === t.toDateString() ? h : d.toDateString() === y.toDateString() ? 'ieri ' + h : d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }); };
const nDay = ts => { const d = new Date(ts * 1000), t = new Date(), y = new Date(t - 864e5); return d.toDateString() === t.toDateString() ? 'Oggi' : d.toDateString() === y.toDateString() ? 'Ieri' : d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' }); };
const nRow = n => `<div class="nrow${n.letta ? '' : ' new'}${n.link ? ' go' : ''}" data-nid="${n.id}" role="button" tabindex="0"><span class="nic">${ic(NICON[n.kind] || 'bell')}</span>
  <span class="grow"><b>${esc(n.title)}</b>${n.body ? `<small>${esc(n.body)}</small>` : ''}<time>${nWhen(n.ts)}</time></span>
  ${n.letta ? '' : `<button class="ndot" data-nread="${n.id}" aria-label="Segna come letta" title="Segna come letta"></button>`}</div>`;
function notifBody() {
  if (!Notif.items.length) return '<div class="empty nempty"><h3>Niente di nuovo</h3><p>Qui arrivano importazioni e download finiti, le Jam degli amici, i brani mandati a te e i dispositivi da approvare.</p></div>';
  const nu = Notif.items.filter(x => !x.letta), old = Notif.items.filter(x => x.letta);
  let last = '';
  return `<section class="nsec"><p class="nsec-h">Nuove${nu.length ? ` <span class="tag acc">${nu.length}</span>` : ''}</p>
    ${nu.length ? nu.map(nRow).join('') : `<p class="nnone">${ic('check')} Hai letto tutto</p>`}</section>
    ${old.length ? `<section class="nsec"><p class="nsec-h">Già lette</p>${old.map(n => { const d = nDay(n.ts), h = d !== last ? `<p class="nday">${d}</p>` : ''; last = d; return h + nRow(n); }).join('')}</section>` : ''}`;
}
// un clic su una riga: letta e, se ha un indirizzo, ci si va; sul pallino: solo letta
function wireNotif(box, done) {
  const go = el => {
    const id = +el.dataset.nid, n = Notif.items.find(x => x.id === id); if (!n) return;
    if (!n.letta) Notif.read([id]);
    if (n.link) { done?.(); location.hash = n.link; }
  };
  box.onclick = e => { const d = e.target.closest('[data-nread]'); if (d) { e.stopPropagation(); Notif.read([+d.dataset.nread]); return; } const r = e.target.closest('.nrow'); if (r) go(r); };
  box.onkeydown = e => { const r = e.target.closest('.nrow'); if (r && (e.key === 'Enter' || e.key === ' ') && e.target === r) { e.preventDefault(); go(r); } };
}
const NotifPop = {
  open() {
    if (!matchMedia('(min-width:861px)').matches) { location.hash = '#/notifiche'; return; }
    const d = $('#dlg'); if (d.open && d.classList.contains('notifpop')) return d.close();
    d.className = 'notifpop'; d.setAttribute('aria-label', 'Notifiche');
    const r = $('#hBell').getBoundingClientRect(); d.style.top = Math.round(r.bottom + 8) + 'px'; d.style.right = Math.max(8, Math.round(innerWidth - r.right - 8)) + 'px';
    this.paint(); closeOutside(d); d.addEventListener('close', () => { d.style.top = d.style.right = ''; $('#hBell').setAttribute('aria-expanded', 'false'); }, { once: true });
    d.showModal(); $('#hBell').setAttribute('aria-expanded', 'true');
    Notif.load();  // le ultime dal server: il riquadro si ridisegna da sé (Notif.views)
  },
  paint() {
    const d = $('#dlg'); if (!d.classList.contains('notifpop')) return;
    const top = d.querySelector('.np-list')?.scrollTop || 0;
    d.innerHTML = `<div class="npo-head"><b>Notifiche</b>${Notif.unread ? `<button class="btn sm" id="npAll">Segna tutte come lette</button>` : ''}
      <a class="icon-btn" href="#/impostazioni/notifiche" aria-label="Impostazioni delle notifiche" title="Impostazioni">${ic('gear')}</a></div>
      ${!P.notifOn ? `<a class="np-hint" href="#/impostazioni/notifiche">${ic('bell')}<span>Ricevile anche quando Armony non è in primo piano</span>${ic('chevr')}</a>` : ''}
      <div class="np-list">${notifBody()}</div>
      <a class="np-foot" href="#/notifiche">Apri la pagina delle notifiche</a>`;
    d.querySelector('.np-list').scrollTop = top;
    wireNotif(d.querySelector('.np-list'), () => d.close());
    $('#npAll')?.addEventListener('click', () => Notif.read());
    d.querySelectorAll('a[href]').forEach(a => a.addEventListener('click', () => d.close()));
  }
};
async function vNotifiche() {
  if (!Notif.on()) { view.innerHTML = '<h1>Notifiche</h1><div class="empty"><h3>Notifiche non disponibili</h3><p>Il server va aggiornato ad Armony 0.25 o successiva.</p></div>'; return; }
  if (!Notif.items.length) await Notif.load();
  view.innerHTML = `<div class="lhead"><h1>Notifiche</h1>${Notif.unread ? '<button class="btn sm" id="nAll">Segna tutte come lette</button>' : ''}</div>
    ${!P.notifOn ? `<div class="panel nhint"><span class="grow">Ricevi gli avvisi anche quando ${NATIVE ? 'l\'app è in sottofondo' : 'Armony non è in primo piano'}.</span><a class="btn sm primary" href="#/impostazioni/notifiche">Attiva</a></div>` : ''}
    <div class="nlist" id="nPage">${notifBody()}</div>`;
  $('#nAll')?.addEventListener('click', () => Notif.read());
  wireNotif($('#nPage'));
}
// coda come Spotify: "Riproduci dopo" va subito dopo il brano attuale, "Aggiungi alla coda" dopo gli altri brani aggiunti a
// mano (segnati _q) e prima del resto della playlist o dell'album (prima andava in fondo, dopo centinaia di brani).
// Da telecomando i brani vanno al dispositivo che suona (comandi "playnext"/"enqueue", capacità "liveq")
const Q = {
  local(tracks, next) {
    const l = tracks.map(t => ({ ...t, _q: 1 }));
    let p = S.index + 1; if (!next) while (S.queue[p]?._q) p++;
    S.queue.splice(p, 0, ...l); persistQueue(); emit('queue');
    if (location.hash.startsWith('#/coda')) vQueue();
  },
  add(tracks, next) {
    if (!tracks.length) return toast('Non ci sono brani.');
    if (Jam.role === 'guest') { tracks.slice(0, 10).forEach(t => Jam.suggest(t)); return; }
    if (Live.remote()) {
      if (!srv()?.me?.caps?.includes('liveq')) return toast('Da qui non posso aggiungere brani alla coda del dispositivo che suona: aggiorna Armony sul server.');
      Live.cmd(next ? 'playnext' : 'enqueue', { tracks: tracks.slice(0, 300).map(wire) });
    } else this.local(tracks, next);
    const n = tracks.length, where = Live.remote() ? ` su ${Live.devices.get(Live.target) || 'l\'altro dispositivo'}` : '';
    toast(next ? (n === 1 ? `Verrà riprodotto dopo il brano attuale${where}.` : `${n} brani dopo quello attuale${where}.`) : (n === 1 ? `Aggiunto alla coda${where}.` : `${n} brani aggiunti alla coda${where}.`));
  }
};
// a fine coda, come l'Autoplay di Spotify: brani simili all'ultimo, segnati "suggeriti" (_s), in fondo alla coda
async function autoContinue(t) {
  if (!t || Jam.role || Radio.st || !srv(t.serverId) || t.fed) { paintButtons(); emit('pause'); return; }
  let l = [];
  try { l = await similar(t); } catch {}
  const have = new Set(S.queue.map(key));
  l = l.filter(x => !have.has(key(x))).slice(0, 25).map(x => ({ ...x, _s: 1 }));
  if (!l.length || !sameTrack(currentTrack(), t)) { paintButtons(); emit('pause'); return; }
  S.queue.push(...l); persistQueue(); emit('queue');
  toast('La coda è finita: continuo con brani simili.');
  playIndex(S.index + 1);
}
async function similar(t) {
  const s = srv(t.serverId); let songs = [];
  try { songs = arr((await api('getSimilarSongs', { id: t.id, count: 60 }, s)).similarSongs?.song); } catch {}
  if (songs.length < 15) { try { songs = songs.concat(arr((await api('getTopSongs', { artist: t.artist, count: 15 }, s)).topSongs?.song)); } catch {} }
  if (songs.length < 25 && t.genre) { try { songs = songs.concat(arr((await api('getSongsByGenre', { genre: t.genre, count: 60 }, s)).songsByGenre?.song)); } catch {} }
  if (songs.length < 25) { try { songs = songs.concat(arr((await api('getRandomSongs', { size: 40 }, s)).randomSongs?.song)); } catch {} }
  const seen = new Set([t.id]);
  return shuffleArr(songs.filter(x => !seen.has(x.id) && seen.add(x.id))).map(x => norm(x, t.serverId)).slice(0, 80);
}
async function radioFrom(t) {
  toast('Preparo la radio…');
  setQueue([t, ...await similar(t)], 0);
}

/* ================= menu di un brano ================= */
/* ================= eliminazione dal server (permesso "delete", /api/tracks/delete) ================= */
const canDelete = sid => { const s = srv(sid); return !!s?.session && !!s.me?.caps?.includes('delete') && !!(s.me.delete || s.me.admin); };
async function deleteTracks(tracks, what) {
  const sid = tracks[0]?.serverId, s = srv(sid);
  if (!tracks.length || !canDelete(sid)) return false;
  if (!confirm(`Eliminare definitivamente «${what}» dal server? Il file viene cancellato per tutti.`)) return false;
  let r;
  try {
    const res = await fetch(absUrl(s.url) + '/api/tracks/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': s.session }, body: JSON.stringify({ ids: tracks.map(t => t.id) }) });
    r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error || `Errore ${res.status}`);
  } catch (e) { toast('Eliminazione non riuscita: ' + e.message); return false; }
  // via dalla coda (il brano in riproduzione resta finché suona) e dalle liste a schermo
  const gone = new Set(arr(r.ids).map(id => sid + ':' + id)), cur = S.queue[S.index];
  S.queue = S.queue.filter((t, i) => i === S.index || !gone.has(key(t))); if (cur) S.index = S.queue.indexOf(cur); persistQueue();
  $$('.song').forEach(el => { const x = S.lastList[+el.dataset.i]; if (x && gone.has(key(x))) el.remove(); });
  api('startScan', {}, s).catch(() => {});
  const errs = Object.values(r.errors || {});
  toast(errs.length ? `${r.deleted} eliminati, ${errs.length} non riusciti: ${errs[0]}.` : r.deleted === 1 ? 'Brano eliminato dal server.' : `${r.deleted} brani eliminati dal server.`, 5000);
  return r.deleted > 0;
}
/* ================= modifica dei brani e copertine (stesso permesso dell'eliminazione, /api/tracks/*) =================
   I file restano dove sono: per Navidrome l'id di un brano dipende dal percorso, così playlist e preferiti restano. */
const canEdit = sid => canDelete(sid) && !!srv(sid)?.me?.caps?.includes('edit');
async function edApi(s, path, opts = {}) {
  const r = await fetch(absUrl(s.url) + path, { ...opts, headers: { 'X-Token': s.session, ...(opts.body && !(opts.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Errore ${r.status}`);
  return j;
}
const splitList = v => v.split(';').map(x => x.trim()).filter(Boolean);
// dopo il salvataggio: brani a schermo, coda e lettore mostrano subito i dati nuovi; Navidrome li rilegge poco dopo
function applyEdit(sid, ids, f) {
  const keys = new Set(ids.map(id => sid + ':' + id));
  const patch = t => { if (!t || !keys.has(key(t))) return; if (f.title) t.title = f.title; if (f.artists?.length) t.artist = f.artists.join(', '); if (f.album) t.album = f.album; };
  S.queue.forEach(patch); persistQueue();
  $$('.song').forEach(el => { const x = S.lastList[+el.dataset.i]; if (!x || !keys.has(key(x))) return; patch(x);
    const b = el.querySelector('.t b'), sm = el.querySelector('.t small'); if (b && f.title) b.lastChild.textContent = x.title; if (sm && f.artists?.length) sm.textContent = x.artist + (sm.textContent.includes(' · ') && x.album ? ' · ' + x.album : ''); });
  updateNowPlaying();
}
async function editTrack(t) {
  const s = srv(t.serverId); if (!canEdit(t.serverId)) return;
  let tg; try { tg = await edApi(s, `/api/tracks/${encodeURIComponent(t.id)}/tags`); } catch (e) { return toast(e.message); }
  const d = $('#dlg'); d.className = 'wide';
  const f = (id, label, v, attrs = '') => `<label class="f">${label}<input type="text" id="${id}" value="${esc(v ?? '')}" ${attrs}></label>`;
  d.innerHTML = `<h3>Modifica informazioni</h3>
    <div class="editcover"><span class="art">${imgTag(t.coverArt, 200, t.serverId)}</span><div class="stack"><small style="color:var(--muted)">${tg.cover ? 'Copertina dentro il file.' : 'Copertina dell\'album.'}</small><button class="btn" id="eCover">${ic('image')} Cambia copertina</button></div></div>
    <div class="grid2" style="margin-top:var(--s4)">
      ${f('eTitle', 'Titolo', tg.title)}${f('eArt', 'Artisti (separati da ;)', tg.artists.join('; '))}
      ${f('eAlb', 'Album', tg.album)}${f('eAA', 'Artista dell\'album', tg.albumartist)}
      ${f('eDate', 'Anno o data', tg.date, 'inputmode="numeric"')}${f('eGen', 'Generi (separati da ;)', tg.genres.join('; '))}
      ${f('eTr', 'Traccia', tg.track, 'inputmode="numeric"')}${f('eDisc', 'Disco', tg.disc, 'inputmode="numeric"')}
    </div>
    <div class="row" style="margin-top:var(--s5)"><button class="btn primary" id="eSave">Salva</button><button class="btn" onclick="this.closest('dialog').close()">Annulla</button></div>`;
  d.showModal(); $('#eTitle').focus();
  $('#eCover').onclick = () => coverPicker(s, [t.id], false, `${tg.artists[0] || t.artist} ${tg.album || t.album || ''}`.trim());
  $('#eSave').onclick = async () => {
    const now = { title: $('#eTitle').value.trim(), artists: splitList($('#eArt').value), album: $('#eAlb').value.trim(), albumartist: $('#eAA').value.trim(),
      date: $('#eDate').value.trim(), genres: splitList($('#eGen').value), track: $('#eTr').value.trim(), disc: $('#eDisc').value.trim() };
    // solo i campi cambiati: il resto del file non si tocca
    const fields = Object.fromEntries(Object.entries(now).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(Array.isArray(tg[k]) ? tg[k] : String(tg[k] ?? ''))));
    if (!Object.keys(fields).length) return d.close();
    if ('title' in fields && !fields.title) return toast('Il titolo non può essere vuoto.');
    try { await edApi(s, '/api/tracks/tags', { method: 'PUT', body: JSON.stringify({ ids: [t.id], fields }) }); }
    catch (e) { return toast(e.message); }
    d.close(); applyEdit(t.serverId, [t.id], fields); api('startScan', {}, s).catch(() => {});
    toast('Salvato. La libreria si aggiorna tra poco.');
  };
}
async function editAlbum() {
  const a = JSON.parse(view.dataset.album || '{}'), songs = S.lastList.filter(x => x?.id), s = srv(songs[0]?.serverId);
  if (!songs.length || !canEdit(songs[0].serverId)) return;
  const d = $('#dlg'); d.className = 'wide';
  const f = (id, label, v, attrs = '') => `<label class="f">${label}<input type="text" id="${id}" value="${esc(v ?? '')}" ${attrs}></label>`;
  d.innerHTML = `<h3>Modifica album</h3><p class="sub" style="margin-bottom:var(--s3)">Vale per tutti i ${songs.length} brani dell'album.</p>
    <div class="editcover"><span class="art">${imgTag(a.coverArt, 200)}</span><div class="stack"><button class="btn" id="aCover">${ic('image')} Cambia copertina dell'album</button></div></div>
    <div class="grid2" style="margin-top:var(--s4)">${f('aAlb', 'Album', a.name)}${f('aAA', 'Artista dell\'album', a.artist)}${f('aYear', 'Anno', a.year, 'inputmode="numeric"')}${f('aGen', 'Genere (separati da ;)', a.genre)}</div>
    <div class="row" style="margin-top:var(--s5)"><button class="btn primary" id="aSave">Salva</button><button class="btn" onclick="this.closest('dialog').close()">Annulla</button></div>`;
  d.showModal(); $('#aAlb').focus();
  const ids = songs.map(x => x.id);
  $('#aCover').onclick = () => coverPicker(s, ids, true, `${a.artist || ''} ${a.name || ''}`.trim());
  $('#aSave').onclick = async () => {
    const now = { album: $('#aAlb').value.trim(), albumartist: $('#aAA').value.trim(), date: $('#aYear').value.trim(), genres: splitList($('#aGen').value) };
    const old = { album: a.name || '', albumartist: a.artist || '', date: String(a.year || ''), genres: splitList(a.genre || '') };
    const fields = Object.fromEntries(Object.entries(now).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(old[k])));
    if (!Object.keys(fields).length) return d.close();
    if ('album' in fields && !fields.album) return toast('Il nome dell\'album non può essere vuoto.');
    try { await edApi(s, '/api/tracks/tags', { method: 'PUT', body: JSON.stringify({ ids, fields }) }); } catch (e) { return toast(e.message); }
    d.close(); applyEdit(songs[0].serverId, ids, fields); api('startScan', {}, s).catch(() => {});
    // nome o artista nuovi = per Navidrome un album nuovo, con un altro indirizzo: si torna agli album
    if (fields.album || fields.albumartist) { toast('Salvato. L\'album compare col nome nuovo tra poco.'); location.hash = '#/libreria/album'; }
    else toast('Salvato. La libreria si aggiorna tra poco.');
  };
}
// scelta della copertina: ricerca su Deezer (il server scarica solo da lì) o un'immagine dal dispositivo
function coverPicker(s, ids, album, q) {
  const d = $('#dlg2'); d.className = 'sheet cover-sheet';
  let pick = null;  // { url } oppure { blob }
  d.innerHTML = `<div class="head"><span style="min-width:0"><b style="display:block">${album ? 'Copertina dell\'album' : 'Copertina del brano'}</b><small style="color:var(--muted)">${album ? 'Vale per tutti i brani dell\'album.' : 'Solo per questo brano.'}</small></span></div>
    <div class="tabs" role="tablist"><button class="on" data-tab="web" role="tab">Cerca online</button><button data-tab="dev" role="tab">Dal dispositivo</button></div>
    <div data-pane="web"><form class="row" id="cvForm" style="flex-wrap:nowrap"><input type="search" id="cvQ" value="${esc(q)}" aria-label="Cerca copertine" enterkeyhint="search"><button class="btn">${ic('search')}</button></form><div class="covergrid" id="cvRes"></div></div>
    <div data-pane="dev" hidden><label class="btn">${ic('image')} Scegli un'immagine<input type="file" id="cvFile" accept="image/jpeg,image/png" hidden></label><div class="covergrid one" id="cvPrev"></div></div>
    <div class="row" style="padding:var(--s3) 10px 4px"><button class="btn primary" id="cvOk" disabled>Usa questa copertina</button><button class="btn" onclick="this.closest('dialog').close()">Annulla</button></div>`;
  const tabs = d.querySelectorAll('[data-tab]');
  tabs.forEach(b => b.onclick = () => { tabs.forEach(x => x.classList.toggle('on', x === b)); d.querySelectorAll('[data-pane]').forEach(p => p.hidden = p.dataset.pane !== b.dataset.tab); });
  const choose = (el, p) => { d.querySelectorAll('.covergrid button').forEach(x => x.classList.toggle('on', x === el)); pick = p; $('#cvOk').disabled = !p; };
  const search = async () => {
    const box = $('#cvRes'); box.innerHTML = '<p class="sub">Cerco…</p>';
    let res = []; try { res = await edApi(s, '/api/cover/search?q=' + encodeURIComponent($('#cvQ').value.trim())); } catch (e) { box.innerHTML = `<p class="sub">${esc(e.message)}</p>`; return; }
    box.innerHTML = res.length ? res.map((r, i) => `<button type="button" data-i="${i}" aria-label="${esc(r.title + ' · ' + r.artist)}"><img src="${esc(r.preview)}" alt="" loading="lazy"><small>${esc(r.title)}</small></button>`).join('') : '<p class="sub">Nessuna copertina trovata: prova con meno parole.</p>';
    box.querySelectorAll('button').forEach(b => b.onclick = () => choose(b, { url: res[+b.dataset.i].cover }));
  };
  $('#cvForm').onsubmit = e => { e.preventDefault(); search(); };
  $('#cvFile').onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    if (!/^image\/(jpeg|png)$/.test(file.type)) return toast('Serve un\'immagine JPEG o PNG.');
    if (file.size > 10 * 1024 * 1024) return toast('Immagine troppo grande (massimo 10 MB).');
    $('#cvPrev').innerHTML = `<button type="button"><img src="${URL.createObjectURL(file)}" alt="Anteprima"></button>`;
    choose($('#cvPrev button'), { blob: file });
  };
  $('#cvOk').onclick = async () => {
    if (!pick) return; $('#cvOk').disabled = true;
    try {
      await edApi(s, `/api/tracks/cover?album=${album ? 1 : 0}&ids=${ids.map(encodeURIComponent).join(',')}`, pick.blob
        ? { method: 'PUT', body: pick.blob, headers: { 'Content-Type': pick.blob.type } } : { method: 'PUT', body: JSON.stringify({ url: pick.url }) });
    } catch (e) { $('#cvOk').disabled = false; return toast(e.message); }
    d.close(); $('#dlg').close(); coverBust = Date.now(); api('startScan', {}, s).catch(() => {});
    toast('Copertina cambiata. La libreria si aggiorna tra poco.');
    updateNowPlaying(); setTimeout(() => { coverBust = Date.now(); route(); updateNowPlaying(); }, 4000);
  };
  d.onclose = () => { d.className = ''; d.onclose = null; };
  closeOutside(d); d.showModal(); if (q) search();
}
function songMenu(t, ctx = {}) {
  const d = $('#dlg'), phoneT = !!srv(t.serverId)?.local; d.className = 'sheet';
  const items = t.fed ? [
    ['nextup', 'Riproduci dopo', () => Q.add([t], true)],
    ['plus', 'Aggiungi alla coda', () => Q.add([t])],
    ['down', 'Copia nella mia libreria', () => netCopy([t])],
    ['offline', 'Salva per l\'offline', () => Offline.save([t])]
  ] : [
    // l'ordine di Spotify: preferiti, playlist, coda, radio, album, artista, crediti, condividi; poi offline e il resto
    ['heart', t.starred ? 'Togli dai Preferiti' : 'Aggiungi ai Preferiti', () => toggleStar(t)],
    can('playlist') ? ['addlist', 'Aggiungi a playlist', () => addToPlaylistDialog([t])] : null,
    ['plus', 'Aggiungi alla coda', () => Q.add([t])],
    ['nextup', 'Riproduci dopo', () => Q.add([t], true)],
    Jam.role ? ['jam', Jam.role === 'host' ? 'Aggiungi alla coda della Jam' : 'Proponi alla Jam', () => Jam.suggest(t)] : null,
    ['radio', 'Vai alla radio del brano', () => radioFrom(t)],
    t.albumId ? ['album', 'Vai all\'album', () => location.hash = '#/album/' + encodeURIComponent(t.albumId)] : null,
    ...(t.artists ? t.artists.map(a => ['artist', `Vai a ${a.name}`, () => location.hash = '#/artista/' + encodeURIComponent(a.id)])
      : [t.artistId ? ['artist', 'Vai all\'artista', () => location.hash = '#/artista/' + encodeURIComponent(t.artistId)] : null]),
    phoneT ? null : ['sliders', 'Crediti e dettagli', () => songInfo(t)],
    ctx.row ? ['check', 'Seleziona', () => { const l = ctx.row.closest('.songs[data-l]'); if (l) Sel.toggle(+l.dataset.l, +ctx.row.dataset.i); }] : null,
    Amici.on() && !t.fed && !phoneT ? ['send', 'Manda a un amico', () => Amici.manda({ kind: 'brano', id: t.id, title: t.title, sub: t.artist })] : null,
    !phoneT && can('condividi') ? ['share', 'Condividi', () => shareItem(t.id, `${t.title} - ${t.artist}`, t.serverId)] : null,
    phoneT && !Offline.has(t) ? null : Offline.has(t) ? ['trash', 'Togli dall\'offline', async () => { await Offline.remove(offKey(t)); toast('Rimosso dall\'offline.'); if (location.hash.startsWith('#/offline')) route(); }]
      : ['offline', 'Salva per l\'offline', () => Offline.save([t])],
    phoneT ? null : ['down', 'Scarica il file originale', () => downloadOriginal(t)],
    ['lyrics', 'Testo', () => { if (key(currentTrack() || {}) !== key(t)) return toast('Il testo si apre per il brano in riproduzione.'); location.hash = '#/testo'; }],
    ctx.pl != null && can('playlist') ? ['trash', 'Togli dalla playlist', async () => {
      // per id sul server (capacità "pltogli"): la posizione vista qui può essere cambiata nel frattempo
      const s = srv(t.serverId), pid = view.dataset.pl;
      try {
        if (s?.me?.caps?.includes('pltogli')) await srvApi(s, '/api/playlist/togli', { method: 'POST', body: JSON.stringify({ pid, id: t.id, index: ctx.pl }) });
        else await api('updatePlaylist', { playlistId: pid, songIndexToRemove: ctx.pl });
      } catch (e) { if (/409/.test(e.message)) await api('updatePlaylist', { playlistId: pid, songIndexToRemove: ctx.pl }); else return toast(e.message); }
      emitSoon('playlists'); route();
    }] : null,
    canEdit(t.serverId) ? ['pen', 'Modifica informazioni', () => editTrack(t)] : null,
    canPick(t.serverId) && !t.fed && !phoneT ? ['repeat', 'Scegli un\'altra versione', () => versionSheet(t)] : null,
    canDelete(t.serverId) ? ['trash', 'Elimina dal server', () => deleteTracks([t], t.title), 'danger'] : null
  ].filter(Boolean);
  if (ctx.q != null && !Live.remote() && Jam.role !== 'guest') items.splice(2, 0, ['close', 'Togli dalla coda', () => { const b = document.createElement('button'); b.hidden = true; b.dataset.act = 'qrm'; b.dataset.i = ctx.q; view.append(b); b.click(); b.remove(); }]);
  if (ctx.at) return ctxMenu(ctx.at, items, `<b>${esc(t.title)}</b><small>${esc(t.artist)}</small>`);
  d.innerHTML = `<div class="head"><span class="pic">${imgTag(t.coverArt, 100, t.serverId)}</span><span style="min-width:0"><b style="display:block">${esc(t.title)}</b><small style="color:var(--muted)">${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}${t.fed ? '<br>' + netSrc(t.fed) : ''}</small></span></div>
    ${items.map(([i, l, , cls], n) => `<button class="mi${cls ? ' ' + cls : ''}" data-n="${n}">${ic(i)}${esc(l)}</button>`).join('')}`;
  d.querySelectorAll('[data-n]').forEach(b => b.onclick = () => { d.close(); items[+b.dataset.n][2](); });
  d.onclose = () => { d.className = ''; d.onclose = null; };
  d.showModal();
}

// preferito come su Spotify: dal menu, dal lettore, da "In riproduzione"; le righe a schermo si aggiornano
async function toggleStar(t) {
  try { await api(t.starred ? 'unstar' : 'star', { id: t.id }, srv(t.serverId)); } catch (e) { return toast(e.message); }
  t.starred = !t.starred;
  [...S.queue, ...S.lastList].forEach(x => { if (x && key(x) === key(t)) x.starred = t.starred; });
  $$(`.song[data-tid="${CSS.escape(t.id)}"] [data-act="star"]`).forEach(b => { b.classList.toggle('on', t.starred); b.innerHTML = ic('heart', t.starred); });
  paintStar(); toast(t.starred ? 'Aggiunto ai Preferiti.' : 'Tolto dai Preferiti.');
}
function paintStar() {
  const t = currentTrack(), on = !!t?.starred;
  $$('#bStar, #bStarM, #nowStar').forEach(b => { b.hidden = !t || !!t.fed || !srv(t.serverId); b.classList.toggle('on', on); b.innerHTML = ic('heart', on); b.setAttribute('aria-label', on ? 'Togli dai Preferiti' : 'Aggiungi ai Preferiti'); });
}
// crediti e dettagli di un brano qualsiasi (quello in riproduzione li ha nella scheda Dettagli)
async function songInfo(t) {
  if (currentTrack() && key(currentTrack()) === key(t)) { sessionStorage.setItem('armony:nowtab', 'info'); location.hash = '#/ora'; return; }
  const s = srv(t.serverId), d = $('#dlg2'); d.className = '';
  d.innerHTML = `<h3>${esc(t.title)}</h3><p class="sub">${esc(t.artist)}</p><div id="origBox"></div><div id="siRows"><p class="sub">Carico…</p></div><div class="row"><button class="btn" onclick="this.closest('dialog').close()">Chiudi</button></div>`;
  closeOutside(d); d.showModal();
  let raw = null; try { raw = (await api('getSong', { id: t.id }, s)).song; } catch {}
  const rows = raw ? [['Album', raw.album], ['Artista dell\'album', raw.displayAlbumArtist || raw.albumArtist], ['Anno', raw.year], ['Genere', raw.genre], ['Traccia', raw.track && `${raw.track}${raw.discNumber > 1 ? ' · disco ' + raw.discNumber : ''}`],
    ['Durata', fmt(raw.duration)], ['Formato', `${(raw.suffix || '').toUpperCase()}, ${raw.bitRate || '?'} kbps`], ['Ascolti tuoi', raw.playCount || 0]].filter(r => r[1]) : [];
  const box = $('#siRows'); if (!box) return;
  box.innerHTML = rows.map(([a, b]) => `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line);flex-wrap:nowrap;gap:16px"><span style="color:var(--muted)">${esc(a)}</span><span style="text-align:right">${esc(b)}</span></div>`).join('');
  origBox(s, t, true);
}

/* ================= menu col tasto destro (computer) =================
   Su un dispositivo con il mouse ogni brano, album, artista, playlist, voce di navigazione e il lettore hanno un menu
   vicino al puntatore, con le stesse azioni del tasto ⋯. Maiusc + tasto destro apre quello del browser. */
const albumTracks = async (id, sid = S.active) => arr((await api('getAlbum', { id }, srv(sid))).album.song).map(x => norm(x, sid));
const plTracks = async id => arr((await api('getPlaylist', { id })).playlist.entry).map(x => norm(x));
const artistTracks = async id => (await Promise.all(arr((await api('getArtist', { id })).artist.album).map(a => albumTracks(a.id)))).flat();
// le azioni di sempre su un gruppo di brani, caricato solo quando si sceglie la voce
function groupItems(get, before = [], after = []) {
  const run = f => async () => { try { const l = await get(); if (!l.length) return toast('Non ci sono brani.'); f(l); } catch (e) { toast(e.message); } };
  const guest = l => Jam.role === 'guest' && (l.slice(0, 10).forEach(t => Jam.suggest(t)), true);
  return [...before,
    ['play', 'Riproduci', run(l => setQueue(l, 0))],
    ['shuffle', 'Riproduci in ordine casuale', run(l => setQueue(l, 0, true))],
    ['nextup', 'Riproduci dopo', run(l => Q.add(l, true))],
    ['plus', 'Aggiungi alla coda', run(l => Q.add(l))],
    can('playlist') ? ['addlist', 'Aggiungi a una playlist', run(l => addToPlaylistDialog(l))] : null,
    srv()?.local ? null : ['offline', 'Salva per l\'offline', run(l => Offline.save(l))], ...after].filter(Boolean);
}
function ctxMenu([x, y], items, head = '') {
  $('#cmenu')?.remove();
  const m = document.createElement('div'); m.id = 'cmenu'; m.className = 'cmenu'; m.setAttribute('role', 'menu');
  m.innerHTML = (head ? `<div class="cm-head">${head}</div>` : '') + items.map(([i, l, , cls], n) => `<button role="menuitem" class="mi${cls ? ' ' + cls : ''}" data-n="${n}">${ic(i)}<span>${esc(l)}</span></button>`).join('');
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  const close = () => { m.remove(); removeEventListener('pointerdown', out, true); removeEventListener('keydown', keys, true); removeEventListener('scroll', close, true); removeEventListener('blur', close); removeEventListener('hashchange', close); };
  const out = e => { if (!m.contains(e.target)) close(); };
  const keys = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const b = [...m.querySelectorAll('button')], i = b.indexOf(document.activeElement); b[(i + (e.key === 'ArrowDown' ? 1 : -1) + b.length) % b.length]?.focus(); }
  };
  m.onclick = e => { const b = e.target.closest('[data-n]'); if (!b) return; close(); items[+b.dataset.n][2](); };
  addEventListener('pointerdown', out, true); addEventListener('keydown', keys, true); addEventListener('scroll', close, true); addEventListener('blur', close); addEventListener('hashchange', close);
  m.querySelector('button')?.focus({ preventScroll: true });
}
document.addEventListener('contextmenu', e => {
  // sul telefono tenere premuto un brano (o il mini lettore) apre il suo menu dal basso, come Spotify
  const touch = !matchMedia('(pointer:fine)').matches;
  if (e.defaultPrevented || e.shiftKey || e.target.closest('input,textarea,select,[contenteditable],dialog,#cmenu,.lyrics')) return;
  if (touch && !e.target.closest('.song[data-i]:not(.ghost), #player .np')) return;
  const at = touch ? undefined : [e.clientX, e.clientY], go = h => () => { location.hash = h; }, menu = (items, head) => { e.preventDefault(); ctxMenu(at, items, head); };
  const song = e.target.closest('.song[data-i]:not(.ghost)');
  if (song) {
    const lst = song.closest('.songs[data-l]'), t = (lst && Lists.get(+lst.dataset.l) || S.lastList)[+song.dataset.i]; if (!t) return;
    const q = song.dataset.act === 'qplay' ? +song.dataset.i : null, pl = view.dataset.pl && song.closest('#lList') ? (t._pi ?? +song.dataset.i) : null;
    e.preventDefault(); navigator.vibrate?.(10); return songMenu(t, touch ? { pl, q, row: song } : { at, pl, q, row: song });
  }
  if (e.target.closest('#player .np, #player .meta, #disc') && currentTrack()) { e.preventDefault(); return songMenu(currentTrack(), touch ? {} : { at }); }
  const alb = e.target.closest('.card:not(.ghost), .qk, .hbest');
  const aid = alb?.querySelector('[data-act="playalbum"],[data-act="playalb"]')?.dataset.id || (alb?.dataset.act === 'album' ? alb.dataset.id : null);
  if (aid) {
    const sid = alb.querySelector('[data-sid]')?.dataset.sid || S.active, name = alb.querySelector('b')?.textContent || 'Album';
    return menu(groupItems(() => albumTracks(aid, sid), [['album', 'Apri l\'album', go('#/album/' + encodeURIComponent(aid))]],
      [srv(sid)?.local || !can('condividi') ? null : ['share', 'Condividi un link', () => shareItem(aid, name, sid)]].filter(Boolean)), `<b>${esc(name)}</b><small>Album</small>`);
  }
  const art = e.target.closest('[data-act="artist"][data-id]');
  if (art) {
    const id = art.dataset.id, name = art.querySelector('b')?.textContent || 'Artista';
    return menu(groupItems(() => artistTracks(id), [['artist', 'Apri l\'artista', go('#/artista/' + encodeURIComponent(id))]],
      [['radio', 'Radio dell\'artista', async () => { try { setQueue((await artistRadio(id)).map(x => norm(x)), 0, true); } catch (er) { toast(er.message); } }]]), `<b>${esc(name)}</b><small>Artista</small>`);
  }
  const pl = e.target.closest('[data-act="openpl"][data-id], #sidePl a[data-pl]');
  if (pl) {
    const id = pl.dataset.id || pl.dataset.pl, name = pl.querySelector('b')?.textContent || 'Playlist';
    return menu(groupItems(() => plTracks(id), [['list', 'Apri la playlist', go('#/playlist/' + encodeURIComponent(id))]],
      [['down', 'Esporta (M3U, JSON, CSV)', async () => { try { exportTracks(name, await plTracks(id)); } catch (er) { toast(er.message); } }],
       srv()?.local || !can('condividi') ? null : ['share', 'Condividi un link', () => shareItem(id, name)],
       ['folder', 'Sposta in una cartella', () => PlDir.pick(id, at || [innerWidth / 2, innerHeight / 3])]].filter(Boolean)), `<b>${esc(name)}</b><small>Playlist</small>`);
  }
  const ghost = e.target.closest('.card.ghost [data-act="dzalbum"], .card.ghost')?.closest('.card');
  if (ghost) { const id = ghost.querySelector('[data-act="dzalbum"]')?.dataset.id; if (id) return menu([['album', 'Apri (non in libreria)', go('#/album-dz/' + encodeURIComponent(id))]]); }
  const nav = e.target.closest('#nav a[data-r], #tabs a[data-r]');
  if (nav) {
    const h = '#/' + nav.dataset.r;
    return menu([['chevr', 'Apri', go(h)], ['share', 'Apri in una nuova finestra', () => open(location.pathname + h, '_blank')],
      nav.closest('#tabs') ? ['sliders', 'Personalizza la barra', tabsEditor] : null].filter(Boolean));
  }
});

/* ================= impostazioni =================
   Due aree: "Questo dispositivo" (preferenze, i miei dispositivi, server collegati, telefono, backup) e "Server" (solo
   amministratori: utenti, sicurezza, indirizzo pubblico, YouTube, librerie collegate, aggiornamenti, disco). Una scheda per
   gruppo, nell'indirizzo (#/impostazioni/ascolto). Su schermo largo elenco a sinistra e scheda a destra; sul telefono
   l'elenco è la pagina e la scheda si apre a tutta pagina con ←. Tutte le schede stanno nella pagina, nascoste: la ricerca
   le attraversa tutte. Da internet senza chiave l'area Server è in sola lettura (il server rifiuta: capacità "impserver") */
I.disk = '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>';
I.archive = '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>';
I.user = '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>';
const SET_AREAS = [['dev', 'Questo dispositivo'], ['srv', 'Server']];
function vSettings(id = location.hash.split('/')[2]) {
  const opt = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${String(k) === String(cur) ? 'selected' : ''}>${v}</option>`).join('');
  const qOpts = Object.fromEntries(Object.entries(QUALITIES).map(([k, q]) => [k, q.label]));
  const ds = dlSrv(), adm = !!access().admin, caps = ds?.me?.caps || [];
  // [area, id, titolo, icona, parole per la ricerca, contenuto]
  const T = [
  ['dev', 'profilo', 'Profilo', 'user', 'nome nick foto profilo avatar immagine sincronizzazione dispositivi password', `<div class="panel stack">
    ${Avatar.ok() ? `<div class="mecard">${pavatar({ user: srv().user, name: P.nick || srv().user }, 'xl')}<span class="grow"><b>${esc(P.nick || srv().user)}</b><small>${esc(srv().user)} · ${esc(srv().name)}</small>
      <span class="row"><button class="btn sm" id="pAv">${ic('image')} Cambia foto</button><button class="btn sm" id="pAvDel">Togli</button></span></span></div>` : ''}
    <label class="f">Il tuo nome per gli amici e nelle Jam<input type="text" id="pNick" value="${esc(P.nick)}" placeholder="Es. Giulia" maxlength="30"></label>
    <label class="check"><input type="checkbox" data-pb="sync" ${P.sync ? 'checked' : ''}><span>Stesse statistiche e impostazioni su tutti i dispositivi<small>Storico d'ascolto e preferenze vengono salvati sul server, legati al tuo utente. Chi gestisce il server può vederli. Volume e modalità compatibile restano di ogni dispositivo.</small></span></label>
    <label class="check"><input type="checkbox" data-pb="live" ${P.live !== false ? 'checked' : ''}><span>Un solo dispositivo suona, gli altri lo comandano<small>Se avvii la musica qui, sugli altri tuoi dispositivi si ferma e il lettore mostra cosa suona qui. Da "Dove suona" nel lettore la sposti dove vuoi.</small></span></label>
    ${Presence.on() ? `<label class="check"><input type="checkbox" id="pShare" ${Presence.share ? 'checked' : ''}><span>Mostra agli altri cosa ascolto e cosa faccio<small>Gli utenti di questo server vedono il brano che ascolti e le tue attività (download, caricamenti, playlist pubbliche, Jam). Spento, non compari; tu vedi comunque gli altri.</small></span></label>` : ''}
    <label class="f">Nome di questo dispositivo<input type="text" id="pDev" value="${esc(P.deviceName)}" placeholder="${esc(Live.name())}" maxlength="30"></label>
    ${Amici.on() ? '<div class="row"><button class="btn" id="pPw">Cambia password</button></div>' : ''}</div>`],

  srv()?.me?.caps?.includes('notifiche') ? ['dev', 'notifiche', 'Notifiche', 'bell', 'notifiche avvisi campanella importazioni download jam dispositivi', `<div class="panel stack">
    <label class="check"><input type="checkbox" id="pNotif" ${P.notifOn ? 'checked' : ''}><span>Avvisi su questo dispositivo<small>Quando ${NATIVE ? 'l\'app è in sottofondo' : 'Armony non è la scheda in primo piano'}, le notifiche arrivano come avvisi del ${NATIVE ? 'telefono' : 'sistema'}. Tutte restano comunque nella campanella.</small></span></label>
    ${[['nImport', 'Importazioni e album finiti', 'Quanti brani sono arrivati e quanti non si trovano'], ['nDownload', 'Download singoli', 'Scaricati o non riusciti'], ['nJam', 'Jam degli amici', 'Quando qualcuno apre una Jam visibile'], ['nDev', 'Dispositivi da approvare', 'Un tuo dispositivo nuovo aspetta l\'approvazione'], ['nAmici', 'Amici', 'Brani mandati a te, inviti e aggiunte nelle playlist collaborative']].map(([k, l, h]) => `<label class="check"><input type="checkbox" data-pb="${k}" ${P[k] !== false ? 'checked' : ''}><span>${l}<small>${h}</small></span></label>`).join('')}
    <p class="small" style="color:var(--muted);margin:0">${NATIVE ? 'Con l\'app chiusa del tutto gli avvisi non arrivano: li ritrovi nella campanella quando la riapri.' : 'Con il browser chiuso gli avvisi non arrivano: li ritrovi nella campanella.'}</p></div>`] : null,

  ['dev', 'ascolto', 'Ascolto', 'headphones', 'audio qualità bitrate equalizzatore eq dissolvenza crossfade velocità volume notte replaygain normalizzazione visualizzatore iphone', `<div class="panel stack">
    <div class="grid2">
      <label class="f">Qualità<select data-p="quality">${opt(qOpts, P.quality)}</select></label>
      <label class="f">Qualità con rete mobile<select data-p="qualityMobile">${opt({ same: 'Uguale', ...qOpts }, P.qualityMobile)}</select></label>
      <label class="f">Qualità per l'offline<select data-p="offlineQ">${opt(qOpts, P.offlineQ)}</select></label>
      <label class="f">Normalizzazione volume<select data-p="rg">${opt({ off: 'Spenta', track: 'Per brano', album: 'Per album' }, P.rg)}</select></label>
    </div>
    <label class="f">Cache dei brani su questo dispositivo<select id="cacheMB">${opt({ 0: 'Spenta', 512: '500 MB', 1024: '1 GB', 2048: '2 GB', 5120: '5 GB' }, P.cacheMB ?? 1024)}</select></label>
    <div class="row between" style="flex-wrap:nowrap;margin-top:calc(-1 * var(--s2))"><small id="cacheUse" style="color:var(--muted)">${bytes(ACache.size())} usati</small><button class="btn sm" data-act="cacheclear">Svuota la cache</button></div>
    <p class="small" style="color:var(--muted);margin:0">Mentre ascolti, i prossimi brani della coda si scaricano prima: partono subito e senza rete. Col Wi-Fi due, in rete mobile uno, con «risparmio dati» nessuno.</p>
    <label class="f">Dissolvenza tra i brani: <span id="cfv">${P.crossfade ? P.crossfade + ' secondi' : 'spenta'}</span><input type="range" min="0" max="12" step="1" value="${P.crossfade}" id="cf"></label>
    <label class="check"><input type="checkbox" data-pb="autoplay" ${P.autoplay !== false ? 'checked' : ''}><span>Continua con brani simili<small>Quando la coda finisce, la musica prosegue con brani simili all'ultimo, come su Spotify.</small></span></label>
    <label class="check"><input type="checkbox" data-pb="night" ${P.night ? 'checked' : ''}><span>Volume notte<small>Comprime la dinamica: i passaggi forti si abbassano, quelli piano si sentono. Utile di sera o in auto.</small></span></label>
    <label class="check"><input type="checkbox" data-pb="visualizer" ${P.visualizer ? 'checked' : ''}><span>Visualizzatore nella schermata In riproduzione</span></label>
    <label class="check"><input type="checkbox" data-pb="compat" ${P.compat ? 'checked' : ''}><span>Modalità compatibile<small>Disattiva equalizzatore, dissolvenza e trasmissione nelle Jam. Attivala se su iPhone la musica si ferma a schermo bloccato. Richiede di ricaricare la pagina.</small></span></label>
    <div class="row"><button class="btn" data-act="eq">${ic('sliders')} Equalizzatore</button><button class="btn" data-act="speed">${ic('speed')} Velocità: ${P.speed}×</button></div>
  </div>`],

  ['dev', 'testi', 'Testi e sincronizzazione', 'lyrics', 'lyrics lrclib coda continua dispositivi', `<div class="panel stack">
    <label class="check"><input type="checkbox" data-pb="lyricsOnline" ${P.lyricsOnline ? 'checked' : ''}><span>Cerca i testi online se il server non li ha<small>Usa LRCLIB, un archivio libero di testi sincronizzati. Invia solo titolo, artista e durata del brano.</small></span></label>
    <label class="check"><input type="checkbox" data-pb="syncQueue" ${P.syncQueue ? 'checked' : ''}><span>Continua su altri dispositivi<small>Salva la coda sul server: apri Armony sul PC e riprendi da dove eri al telefono.</small></span></label>
  </div>`],

  // sul web non c'è: il tema sta nel pulsante in alto a destra, la barra in basso si personalizza tenendola premuta
  NATIVE ? ['dev', 'aspetto', 'Aspetto', 'moon', 'tema chiaro scuro automatico colori barra in basso sezioni navigazione', `<div class="seg">${[['auto', 'Automatico'], ['light', 'Chiaro'], ['dark', 'Scuro']].map(([v, l]) => `<label><input type="radio" name="theme" value="${v}" ${P.theme === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
    <div class="tbset"><span class="grow"><b>Barra in basso</b><small>${tabsOf().map(h => NAV.find(n => n[0] === h)[1]).join(' · ')}</small></span><button class="btn sm" data-act="tabsedit">Personalizza</button></div>`] : null,

  ['dev', 'jam', 'Jam', 'jam', 'stun turn 5g internet nat ascoltare insieme', `<div class="panel stack">
    <label class="check"><input type="checkbox" data-pb="stun" ${P.stun ? 'checked' : ''}><span>Permetti Jam via internet (5G)<small>Usa server STUN pubblici per scoprire l'indirizzo esterno. Non passa musica né chiavi da quei server.</small></span></label>
    <p class="small" style="color:var(--muted);margin:0">Server TURN (facoltativo). Serve quando operatori mobili o reti aziendali impediscono il collegamento diretto. Il traffico che vi passa resta cifrato.</p>
    <div class="grid2">
      <label class="f">Indirizzo TURN<input type="text" id="tUrl" value="${esc(P.turn.url)}" placeholder="turn:mio-server.it:3478"></label>
      <label class="f">Utente<input type="text" id="tUser" value="${esc(P.turn.user)}"></label>
      <label class="f">Password<input type="password" id="tPass" value="${esc(P.turn.pass)}"></label>
    </div>
  </div>`],

  // i miei dispositivi qui; quelli degli altri utenti, la regola dei client senza chiave e il registro in Server → Sicurezza
  srv()?.session && Disp.ok(srv()) ? ['dev', 'dispositivi', 'Dispositivi e sicurezza', 'shield', 'dispositivi sicurezza chiave abbina codice revoca approva attesa sessioni', '<div id="devBox"><p class="sub">Caricamento…</p></div>'] : null,

  ['dev', 'server', 'Server musicali', 'lib', 'navidrome subsonic account accesso password indirizzo rete lan', `<p class="sub">Qualsiasi server compatibile Subsonic: Navidrome, Gonic, Airsonic, Ampache.</p>
  <div>${S.servers.map(s => `<div class="list-item" style="cursor:default">
    <span class="grow"><b>${esc(s.name)} ${s.id === S.active ? '<span class="tag ok">in uso</span>' : ''}</b><small>${esc(s.url)}, utente ${esc(s.user)}${s.me ? (s.me.admin ? ', amministratore' : '') + ` · Armony ${esc(s.me.version || '')}` : s.armony === false ? ' · solo ascolto (server senza Armony)' : ''}</small></span>
    ${s.id !== S.active ? `<button class="btn sm" data-act="usesrv" data-id="${s.id}">Usa</button>` : ''}
    <button class="btn sm" data-act="editsrv" data-id="${s.id}">Modifica</button>
    <button class="icon-btn" data-act="delsrv" data-id="${s.id}" aria-label="Rimuovi">${ic('trash')}</button></div>`).join('') || '<p class="sub">Nessun server.</p>'}</div>
  <div class="row" style="margin-top:12px"><button class="btn primary" data-act="addsrv">${ic('plus')} Aggiungi server</button><button class="btn" data-act="lanscan">${ic('wifi')} Cerca sulla rete</button></div>
  <div id="lanRes"></div>`],

  Local.p ? ['dev', 'telefono', 'Questo telefono', 'phone', 'musica telefono memoria backup copia caricamento wifi', '<div class="panel stack" id="phoneBox"></div>'] : null,

  ['dev', 'spazio', 'Spazio', 'disk', 'memoria disco spazio occupato libero gb archiviazione', '<div class="panel stack" id="spazioBox"><p class="sub">Calcolo…</p></div>'],

  window.ARMONY_APP ? ['dev', 'app', 'App Android', 'phone', 'apk aggiornamento versione telefono android', '<div class="panel" id="appBox"><p class="sub">Controllo…</p></div><div id="dnsBox"></div><div id="apkBox"></div>']
    : ['dev', 'app', 'App Android', 'phone', 'apk app android telefono scarica installa qr', '<div class="panel" id="apkBox"><p class="sub">Controllo…</p></div>'],

  ['dev', 'backup', 'Backup e trasferimento', 'archive', 'esporta importa file amico scorciatoie tastiera ripristina reset cancella vergine', `<p class="sub">Sposta tutto su un altro telefono, o passa la configurazione a un amico in dieci secondi.</p>
  <div class="row"><button class="btn" data-act="exportset">Esporta impostazioni</button><button class="btn" data-act="importset">Importa impostazioni</button><a class="btn" href="#/tasti">Scorciatoie da tastiera</a></div>
  <div class="row" style="margin-top:var(--s5);padding-top:var(--s4);border-top:1px solid var(--line)"><span class="grow" style="min-width:200px"><b>Ripristina ${NATIVE ? 'l\'app' : 'questo browser'}</b><br><small style="color:var(--muted)">Toglie server, chiavi, brani offline e preferenze da questo dispositivo, come appena installata${NATIVE ? '' : ''}.</small></span><button class="btn danger" data-act="resetapp">Ripristina</button></div>`],

  // ---------------- area Server: solo amministratori
  adm && ds?.session ? ['srv', 'utenti', 'Utenti e registrazione', 'friends', 'utenti permessi caricamento download disconnetti amministratore registrazione inviti nuovo utente account playlist benvenuto qr', '<p class="sub">Gli utenti del server. Tocca un nome per scegliere cosa può fare; l\'amministratore può sempre tutto. «Nuovo utente» crea un account e ti dà un link e un QR: al primo ingresso l\'amico sceglie la sua password.</p><div id="usrBox"><p class="sub">Caricamento…</p></div><h3 style="margin-top:var(--s5)">Registrazione</h3><div id="regBox"><p class="sub">Caricamento…</p></div>'] : null,
  adm && srv()?.session && Disp.ok(srv()) ? ['srv', 'sicurezza', 'Sicurezza', 'lock', 'dispositivi sicurezza chiave approva attesa revoca client senza chiave registro accessi eventi', '<div id="secBox"><p class="sub">Caricamento…</p></div>'] : null,
  adm && caps.includes('indirizzo') ? ['srv', 'indirizzo', 'Indirizzo pubblico', 'globe', 'indirizzo pubblico tailscale dominio link qr', `<div class="panel stack">
    <label class="f">Indirizzo pubblico di questo server<input type="url" id="pubUrl" value="${esc(ds.me.public || '')}" placeholder="https://armony.nome-rete.ts.net"></label>
    <p class="small" style="color:var(--muted);margin:0">Quello con cui gli altri raggiungono Armony (Tailscale, dominio). Vale per tutti i dispositivi: link condivisi, inviti agli amici, QR dell'app e server collegati lo usano al posto dell'indirizzo di casa.</p>
    <div class="row"><button class="btn" id="pubSave">Salva</button></div></div>`] : null,
  adm && caps.includes('youtube') ? ['srv', 'youtube', 'YouTube', 'film', 'download cookie robot bot bloccato account prova yt-dlp', '<div class="panel stack" id="ytBox"><p class="sub">Controllo…</p></div>'] : null,
  adm && netOk() ? ['srv', 'librerie', 'Librerie collegate', 'wifi', 'federazione rete server amici collegare invito codice sicurezza', '<p class="sub">Collega questo server a quelli degli amici: in Cerca compaiono anche i loro brani, da ascoltare subito o da copiare qui.</p><div id="fedBox"><p class="sub">Caricamento…</p></div>'] : null,
  adm ? ['srv', 'aggiornamenti', 'Aggiornamenti', 'repeat', 'versione github aggiorna', '<div class="panel" id="updBox"><p class="sub">Controllo…</p></div>'] : null,
  // stato del server (diagnosi.js) con dentro lo spazio del disco; sui server che non lo conoscono, solo lo spazio
  adm && ds?.session && caps.includes('diagnosi') ? ['srv', 'stato', 'Stato del server', 'pulse', 'cpu processore memoria ram carico rete thread ascolti flussi dispositivi risorse monitor disco spazio occupato libero', '<div id="statoBox"><p class="sub">Misuro…</p></div><h3>Spazio</h3><div class="panel stack" id="spazioSrvBox"><p class="sub">Calcolo…</p></div>']
    : adm && srv()?.session && caps.includes('spazio') ? ['srv', 'disco', 'Spazio del server', 'disk', 'memoria disco spazio occupato libero gb musica video', '<div class="panel stack" id="spazioSrvBox"><p class="sub">Calcolo…</p></div>'] : null,
  adm && ds?.session && caps.includes('diagnosi') ? ['srv', 'registro', 'Registro eventi', 'bug', 'log errori debug problemi eventi ambiguità guasti', '<div id="logBox"><p class="sub">Caricamento…</p></div>'] : null
  ].filter(Boolean);
  const ro = `<p class="ro-note" hidden>${ic('lock')}<span>Sola lettura. Da internet le impostazioni del server si cambiano solo da un dispositivo con chiave (l'app, o Armony aperta con HTTPS) oppure da casa o da Tailscale.</span></p>`;
  view.innerHTML = `<div class="setp"><h1>Impostazioni</h1><p class="sub">Tutto resta su questo dispositivo, salvo ciò che sta sui server.</p>
  <label class="setsearch">${ic('search')}<input type="search" id="setQ" placeholder="Cerca nelle impostazioni" aria-label="Cerca nelle impostazioni" autocomplete="off"></label>
  <div id="setNone" class="empty" hidden></div>
  <div class="set"><div class="setnav" role="navigation" aria-label="Gruppi di impostazioni">${SET_AREAS.map(([a, l]) => T.some(t => t[0] === a) ? `<p class="setnav-h">${a === 'srv' ? `${l} <span>${esc(ds?.name || '')}</span>` : l}</p>
    ${T.filter(t => t[0] === a).map(([, k, title, icon]) => `<a href="#/impostazioni/${k}" data-t="${k}"><i class="setic">${ic(icon)}</i><span>${title}</span><i class="dot" data-dot="${k}" aria-label="da vedere" hidden></i>${ic('chevr')}</a>`).join('')}` : '').join('')}</div>
  <div class="setbody">${T.map(([a, k, title, , keys, body]) => `<section class="stab" data-t="${k}" data-k="${esc(keys)}" aria-label="${esc(title)}">
    <header class="stab-h"><button class="icon-btn stab-back" aria-label="Torna alle impostazioni">${ic('chevl')}</button><h2><small class="stab-area">${a === 'srv' ? 'Server' : 'Questo dispositivo'}</small>${title}</h2></header>
    ${a === 'srv' ? `${ro}<fieldset class="sbody srvfs">${body}</fieldset>` : `<div class="sbody">${body}</div>`}</section>`).join('')}</div></div>
  <p class="small" style="color:var(--muted);margin-top:24px">Armony, dispositivo ${esc(S.device)}.</p></div>`;
  $('#setQ').oninput = e => settingsFilter(e.target.value);
  view.querySelectorAll('.stab-back').forEach(b => b.onclick = () => navStack.at(-2) === '#/impostazioni' ? history.back() : location.hash = '#/impostazioni');
  $('#pNick').onchange = e => { P.nick = e.target.value.trim(); savePrefs(); };
  $('#pDev').onchange = e => { P.deviceName = e.target.value.trim(); savePrefs(); Live.connect(); };
  if ($('#pPw')) $('#pPw').onclick = () => Amici.passwordSheet();
  if ($('#pAv')) { $('#pAv').onclick = () => Avatar.choose(); $('#pAvDel').onclick = () => Avatar.remove(); }
  if ($('#pNotif')) $('#pNotif').onchange = async e => {
    if (e.target.checked && !(await Notif.permission())) { e.target.checked = false; toast(NATIVE ? 'Consenti le notifiche ad Armony nelle impostazioni del telefono.' : 'Il browser non ha consentito le notifiche: abilitale dal lucchetto accanto all\'indirizzo.', 7000); return; }
    P.notifOn = e.target.checked; savePrefs(); Notif.native(); toast(P.notifOn ? 'Avvisi attivi su questo dispositivo.' : 'Avvisi spenti: le notifiche restano nella campanella.');
  };
  if ($('#pShare')) $('#pShare').onchange = async e => {
    try { Presence.share = (await srvApi(srv(), '/api/live/privacy', { method: 'PUT', body: JSON.stringify({ share: e.target.checked }) })).share; toast(Presence.share ? 'Gli altri vedono cosa ascolti.' : 'Non compari più agli altri.'); }
    catch { e.target.checked = Presence.share; toast('Non riesco a salvare: riprova.'); }
  };
  view.querySelectorAll('[data-p]').forEach(el => el.onchange = () => { P[el.dataset.p] = el.value; savePrefs(); fillSelectors(); });
  view.querySelectorAll('[data-pb]').forEach(el => el.onchange = () => {
    P[el.dataset.pb] = el.checked; savePrefs();
    if (el.dataset.pb === 'night') Engine.applyNight();
    if (el.dataset.pb === 'compat') toast('Ricarica la pagina per applicare.');
    if (el.dataset.pb === 'sync' && P.sync) { PrefSync.pull(); HistSync.run(); }
    if (el.dataset.pb === 'live') Live.connect();
    if (Object.values(NKIND).includes(el.dataset.pb)) Notif.native();  // i tipi scelti valgono anche ad app chiusa
  });
  $('#cacheMB').onchange = e => { P.cacheMB = +e.target.value; savePrefs(); if (!P.cacheMB) ACache.clear().then(() => { $('#cacheUse').textContent = '0 MB usati'; }); else ACache.trim(); };
  $('#cf').oninput = e => { P.crossfade = +e.target.value; $('#cfv').textContent = P.crossfade ? P.crossfade + ' secondi' : 'spenta'; savePrefs(); };
  ['tUrl', 'tUser', 'tPass'].forEach(id => $('#' + id).onchange = () => { P.turn = { url: $('#tUrl').value.trim(), user: $('#tUser').value.trim(), pass: $('#tPass').value }; savePrefs(); });
  refreshSpazio(); refreshApk(); Disp.paint(); diagPaint();
  $('#pubSave')?.addEventListener('click', async () => {
    try {
      const r = await dlApi('/api/indirizzo', { method: 'PUT', body: JSON.stringify({ url: $('#pubUrl').value.trim() }) });
      ds.me = { ...ds.me, public: r.public }; persistServers(); toast(r.public ? `Fatto: i link useranno ${r.public}.` : 'Indirizzo tolto: i link useranno quello di ogni dispositivo.');
    } catch (e) { toast(e.message); }
  });
  if (adm) { refreshUpdate(); refreshUsers(); refreshReg(); refreshFed(); refreshYt(); }
  if (window.ARMONY_APP) { AppUpdate.paint(); NetDns.paint(); }
  Local.paint();
  $$('[name=theme]').forEach(r => r.onchange = () => { P.theme = r.value; savePrefs(); applyTheme(); });
  setTab(id); setRO(); setDots();
  // da casa a internet (o il contrario) cambia cosa si può fare sul server: lo si richiede subito
  if (adm && ds?.session) Disp.fresh(ds, true).then(() => { setRO(); setDots(); });
}
// scheda mostrata: quella dell'indirizzo; senza, sul computer l'ultima scelta (sul telefono si vede l'elenco)
function setTab(id) {
  const p = $('#view .setp'); if (!p) return;
  const tabs = [...p.querySelectorAll('.stab')], want = tabs.find(t => t.dataset.t === id);
  const on = want || tabs.find(t => t.dataset.t === store.get('setTab')) || tabs[0];
  if (want) store.set('setTab', id);
  if ($('#setQ').value) { $('#setQ').value = ''; settingsFilter(''); }
  p.classList.toggle('open', !!want);
  tabs.forEach(t => t.classList.toggle('on', t === on));
  p.querySelectorAll('.setnav a').forEach(a => { const o = a.dataset.t === on.dataset.t; a.classList.toggle('on', o); o ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
  window.scrollTo(0, 0);
}
// area Server in sola lettura: amministratore senza chiave da internet (il server rifiuterebbe comunque)
function setRO() {
  const ro = dlSrv()?.me?.srvedit === false;
  $$('#view .srvfs').forEach(f => f.disabled = ro);
  $$('#view .ro-note').forEach(n => n.hidden = !ro);
}
// puntini sulle schede: dispositivi miei in attesa, quelli degli altri (amministratore), aggiornamento del server
function setDots() {
  const m = srv()?.me || {}, n = m.pending || 0, mine = m.admin ? m.pending_mine ?? 0 : n;
  const on = { dispositivi: mine > 0, sicurezza: n - mine > 0, aggiornamenti: !!S.updAvail };
  $$('#view [data-dot]').forEach(d => d.hidden = !on[d.dataset.dot]);
}
// ricerca fra le impostazioni: in tutte le schede, e mostra solo le voci che contengono il testo, raggruppate per scheda
const fold = t => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function settingsFilter(raw) {
  const q = fold(raw.trim()), p = $('#view .setp'); if (!p) return;
  p.classList.toggle('q', !!q);
  let shown = 0;
  p.querySelectorAll('.stab').forEach(g => {
    // se qualche voce contiene il testo si mostrano solo quelle; la scheda intera solo se la nomina il titolo
    const items = [...g.querySelectorAll('.check, label.f, .list-item, .sbody > .row, .panel > .row, .seg, .tbset')];
    const match = items.filter(el => !q || fold(el.textContent).includes(q));
    const whole = !q || (!match.length && fold(g.querySelector('h2').textContent + ' ' + g.dataset.k).includes(q));
    let hits = 0;
    items.forEach(el => { const ok = whole || match.includes(el); el.classList.toggle('nohit', !ok); hits += ok; });
    g.querySelectorAll('.sbody > .sub, .panel > .small').forEach(el => el.classList.toggle('nohit', !whole));
    g.hidden = !whole && !hits; if (!g.hidden) shown++;
    p.querySelector(`.setnav a[data-t="${g.dataset.t}"]`)?.classList.toggle('dim', g.hidden);
  });
  const none = $('#setNone'); none.hidden = !q || shown > 0;
  if (q && !shown) none.innerHTML = `Nessuna impostazione contiene «${esc(raw.trim())}». Prova con una parola più corta, come «qualità» o «tema».`;
}
/* ================= spazio: disco del server in uso e memoria di questo dispositivo ================= */
// barra a segmenti: [{ v: byte, l: etichetta, c: colore }], il resto della barra è il libero
function spazioBar(total, parts, free) {
  const pc = v => Math.max(0, Math.min(100, v / total * 100)).toFixed(2) + '%';
  return `<div class="sbar" role="img" aria-label="${esc(parts.map(p => `${p.l} ${bytes(p.v)}`).join(', '))}, liberi ${bytes(free)}">${parts.map(p => `<i style="width:${pc(p.v)};background:${p.c}"></i>`).join('')}</div>
    <div class="slegend">${parts.map(p => `<span><i style="background:${p.c}"></i>${esc(p.l)} <b>${bytes(p.v)}</b></span>`).join('')}<span><i class="free"></i>Liberi <b>${bytes(free)}</b></span></div>`;
}
async function refreshSpazio() {
  const box = $('#spazioBox'); if (!box) return;
  const s = srv(), here = NATIVE ? 'Questo telefono' : 'Questo browser';
  let srvHtml = '';
  if (s?.session && s.me?.caps?.includes('spazio')) {
    try {
      const d = await srvApi(s, '/api/spazio'), m = d.music?.bytes || 0, v = d.videos?.bytes || 0;
      srvHtml = `<div><h3>Server ${esc(s.name)}</h3><p class="sub">${bytes(d.used)} occupati su ${bytes(d.total)}${d.music ? ` · ${(d.music.songs ?? d.music.files).toLocaleString('it-IT')} ${d.music.songs != null ? 'brani' : 'file di musica'}` : ''}${d.counting && !d.music ? ' · sto contando la musica…' : ''}</p>
        ${spazioBar(d.total, [{ v: m, l: 'Musica', c: 'var(--accent)' }, { v: v, l: 'Video', c: 'var(--sage)' }, { v: Math.max(0, d.used - m - v), l: 'Altro', c: 'var(--muted)' }], d.free)}</div>`;
      if (d.counting && !d.music) setTimeout(refreshSpazio, 4000);
    } catch { srvHtml = `<div><h3>Server ${esc(s.name)}</h3><p class="sub">Il server non risponde.</p></div>`; }
  } else if (s) srvHtml = `<div><h3>Server ${esc(s.name)}</h3><p class="sub">Questo server non dice quanto spazio ha${s.session ? ' (va aggiornato)' : ''}.</p></div>`;
  let devHtml = '';
  try {
    const e = await navigator.storage.estimate(), off = (await DB.all('offline').catch(() => [])).reduce((n, r) => n + (r.size || 0), 0);
    devHtml = `<div><h3>${here}</h3><p class="sub">Armony usa ${bytes(e.usage)} di ${bytes(e.quota)} concessi${NATIVE ? ' dal telefono' : ' dal browser'}.</p>
      ${spazioBar(e.quota, [{ v: Math.min(off, e.usage), l: 'Brani offline', c: 'var(--accent)' }, { v: Math.min(ACache.size(), Math.max(0, e.usage - off)), l: 'Cache dei brani', c: 'var(--sage)' }, { v: Math.max(0, e.usage - off - ACache.size()), l: 'Copertine e dati', c: 'var(--muted)' }], Math.max(0, e.quota - e.usage))}</div>`;
  } catch { devHtml = `<div><h3>${here}</h3><p class="sub">Questo browser non dice quanto spazio usa.</p></div>`; }
  if ($('#spazioBox') !== box) return;
  // amministratore: il disco del server sta in Server → Spazio del server
  const sb = $('#spazioSrvBox'); if (sb) { sb.innerHTML = srvHtml; box.innerHTML = devHtml; } else box.innerHTML = srvHtml + devHtml;
}
/* ================= aggiornamenti dell'app (dal server Armony, verso i tag GitHub) ================= */
async function refreshUpdate(force) {
  const box = $('#updBox'); if (!box) return;
  let u; try { u = await dlApi('/api/update' + (force ? '?refresh=1' : '')); } catch (e) {
    // durante l'aggiornamento il server si riavvia e non risponde: si riprova
    if (box.dataset.busy) setTimeout(() => refreshUpdate(), 5000);
    else box.innerHTML = `<p class="sub">${esc(e.message)}</p>`;
    return;
  }
  S.updAvail = !!u.available; setDots();
  const st = u.updater, busy = u.requested || st?.state === 'in corso';
  box.dataset.busy = busy ? '1' : '';
  box.innerHTML = `<p style="margin:0 0 8px">Versione installata <b>${esc(u.current)}</b>${u.latest ? ` · ultima su GitHub <b>${esc(u.latest)}</b>` : ''}</p>
    ${!u.repo ? '<p class="sub">Repository GitHub non configurato sul server (ARMONY_REPO).</p>' : u.error ? `<p class="sub">Controllo non riuscito: ${esc(u.error)}</p>` : ''}
    ${st && st.state !== 'in corso' ? `<p class="small" style="color:var(--muted)">Ultimo aggiornamento: ${esc(st.state)}${st.msg ? ' · ' + esc(st.msg) : ''} (${new Date(st.ts * 1000).toLocaleString()})</p>` : ''}
    <div class="row"><button class="btn" data-act="updcheck">Controlla ora</button>
    ${busy ? '<span class="tag">Aggiornamento in corso…</span>' : u.available ? `<button class="btn primary" data-act="updrun">Aggiorna a ${esc(u.latest)}</button>` : u.latest ? '<span class="tag ok">Aggiornato</span>' : ''}</div>`;
  if (busy) setTimeout(() => refreshUpdate(), 5000);
  return u;
}
/* ================= YouTube: cookie di un account secondario e prova di download (solo amministratori) ================= */
async function refreshYt(prova) {
  const box = $('#ytBox'); if (!box) return;
  let y; try { y = await dlApi('/api/youtube'); } catch (e) { box.innerHTML = `<p class="sub">${esc(e.message)}</p>`; return; }
  const c = y.cookies, giorno = t => new Date(t * 1000).toLocaleDateString('it-IT');
  const stato = !c.present ? '<span class="tag">Nessun cookie</span>'
    : c.expired ? '<span class="tag err">Cookie scaduti</span>'
    : !c.login ? '<span class="tag err">Cookie senza accesso</span>' : '<span class="tag ok">Cookie presenti</span>';
  const nota = !c.present ? 'Senza cookie il server scarica come ospite: di solito basta, ma se YouTube lo scambia per un robot i download si fermano.'
    : c.expired ? 'YouTube non li accetta più: esportali di nuovo e ricaricali.'
    : !c.login ? 'Nel file non c\'è un accesso a YouTube: esportali mentre sei dentro con l\'account.'
    : `Caricati il ${giorno(c.saved)}${c.expires ? `, validi fino al ${giorno(c.expires)}` : ''}. I download li usano.`;
  if ($('#ytBox') !== box) return;
  box.innerHTML = `<div class="row between"><b>Cookie di YouTube</b>${stato}</div>
    <p class="small" style="color:var(--muted);margin:0">${esc(nota)}${y.pausa ? ` YouTube ha bloccato il server: i brani da scaricare aspettano ancora ${Math.ceil(y.pausa / 60)} min.` : ''}</p>
    <p class="small" style="margin:0"><b>Usa un account secondario</b>, creato apposta: YouTube può sospendere l'account usato per scaricare. Esporta i cookie da una finestra in incognito con l'estensione «Get cookies.txt LOCALLY» mentre sei su youtube.com, poi chiudi la finestra senza uscire dall'account. Il server tiene solo i cookie di YouTube e Google.</p>
    <div class="row"><button class="btn" data-yt="up">${ic('plus')} ${c.present ? 'Sostituisci i cookie' : 'Carica cookies.txt'}</button>${c.present ? `<button class="btn" data-yt="del">${ic('trash')} Togli i cookie</button>` : ''}<button class="btn" data-yt="try">Prova YouTube</button></div>
    <p class="small" id="ytTry" style="margin:0;color:var(${prova && !prova.ok ? '--danger' : '--muted'})" aria-live="polite">${prova ? esc(prova.msg) : `yt-dlp ${esc(y.ytdlp)} · PO Token ${y.pot ? 'attivo' : 'non raggiungibile (servizio pot spento?)'}`}</p>`;
  box.querySelectorAll('[data-yt]').forEach(b => b.onclick = async () => {
    try {
      if (b.dataset.yt === 'up') {
        const f = await pickFile('.txt,text/plain'); if (!f) return;
        const r = await dlApi('/api/youtube/cookies', { method: 'PUT', body: await f.text(), headers: { 'Content-Type': 'text/plain' } });
        toast(r.cookies.expired ? 'Cookie salvati, ma sono già scaduti: esportali di nuovo.' : 'Cookie salvati: i download li useranno.'); refreshYt();
      } else if (b.dataset.yt === 'del') {
        if (!confirm('Togliere i cookie di YouTube dal server?')) return;
        await dlApi('/api/youtube/cookies', { method: 'DELETE' }); toast('Cookie tolti.'); refreshYt();
      } else {
        b.disabled = true; $('#ytTry').textContent = 'Provo a scaricare un video di 19 secondi…';
        const r = await dlApi('/api/youtube/prova', { method: 'POST' });
        refreshYt({ ok: r.ok, msg: r.ok ? `Funziona: scaricato in ${String(r.secondi).replace('.', ',')} s (yt-dlp ${r.ytdlp}, PO Token ${r.pot ? 'attivo' : 'non raggiungibile'}).` : `Non funziona: ${r.error}` });
      }
    } catch (e) { b.disabled = false; toast(e.message); }
  });
}
/* ================= registrazione degli amici (solo amministratori) ================= */
const fmtCode = c => String(c).replace(/^(.{4})(.+)$/, '$1-$2');
// indirizzo da mettere nei link per gli altri: quello scelto su questo dispositivo, poi quello che l'amministratore ha dato
// al server (vale per tutti), infine quello con cui questo dispositivo raggiunge il server
const pubBase = s => (s?.shareBase || s?.me?.public || absUrl(s?.url || location.origin)).replace(/\/+$/, '');
const inviteLink = c => `${pubBase(srv())}/#/invito/${fmtCode(c)}`;
// l'ultima app Android, scaricata direttamente da GitHub: ogni release la pubblica anche come armony.apk, così
// releases/latest/download/armony.apk (link e QR) porta sempre all'ultima senza passare dal server
const APK_REPO = window.ARMONY_APP?.repo || 'Giggi-98/Armony';
const apkUrl = () => `https://github.com/${APK_REPO}/releases/latest/download/armony.apk`;
async function refreshApk() {
  const box = $('#apkBox'); if (!box) return;
  let a = null; try { const r = await fetch(`https://api.github.com/repos/${APK_REPO}/releases/latest`); if (r.ok) a = { version: (await r.json()).tag_name?.replace(/^v/, '') }; } catch {}
  const url = apkUrl();
  if ($('#apkBox') !== box) return;
  box.innerHTML = `${window.ARMONY_APP ? '<h3 style="margin:var(--s5) 0 var(--s1)">Passala a un amico</h3>' : ''}
    <p class="sub">${window.ARMONY_APP ? 'Fagli inquadrare il codice: scarica l\'ultima versione dell\'app.' : `L'app per Android${a?.version ? ` (ultima versione: <b>${esc(a.version)}</b>)` : ''}: musica a schermo spento, comandi nella notifica, anche senza server. Il link porta sempre all'ultima versione.`}</p>
    <div class="row"><a class="btn primary" href="${esc(url)}">${ic('down')} Scarica l'app</a><button class="btn" id="apkQr">QR code</button></div>`;
  $('#apkQr').onclick = () => {
    const d = $('#dlg2');
    d.innerHTML = `<h3>App Android</h3><p class="sub">Inquadra il codice con la fotocamera del telefono: si scarica l'ultima versione. Android chiede di consentire l'installazione dal browser una volta sola.</p>
      <div id="apkQrBox" style="margin:var(--s4) 0;display:grid;place-items:center"></div><div class="code" style="font-size:.8rem">${esc(url)}</div>
      <div class="row"><button class="btn" onclick="this.closest('dialog').close()">Chiudi</button></div>`;
    closeOutside(d); d.showModal(); qrInto($('#apkQrBox'), url).catch(() => { $('#apkQrBox').innerHTML = '<p class="sub">Il QR non si è caricato (serve internet): usa il link qui sotto.</p>'; });
  };
}
// ripristino: il dispositivo torna com'era appena installato (per ricollegarsi da capo, per esempio con le chiavi).
// Prima, se si vuole, si revoca sul server: la sua chiave vecchia non deve restare valida
function resetApp() {
  const d = $('#dlg2'), mine = S.servers.filter(s => s.session && s.dev);
  d.className = '';
  d.innerHTML = `<h3>Ripristinare ${NATIVE ? 'l\'app' : 'questo browser'}?</h3>
    <p class="sub">Da questo dispositivo spariscono server, chiavi, brani salvati offline, preferenze e storico non ancora sincronizzato. La musica sui server non si tocca. Poi riparti dalla schermata di benvenuto: ricollegati con un codice di abbinamento da un dispositivo fidato, o con la password e l'approvazione.</p>
    ${mine.length ? `<label class="check"><input type="checkbox" id="rsRev" checked><span>Revoca anche questo dispositivo sul server<small>La sua chiave smette subito di valere: rientrando sarà un dispositivo nuovo.</small></span></label>` : ''}
    <div class="row"><button class="btn danger" id="rsGo">Ripristina</button><button class="btn" onclick="this.closest('dialog').close()">Annulla</button></div>`;
  $('#rsGo').onclick = async () => {
    $('#rsGo').disabled = true; $('#rsGo').textContent = 'Ripristino…';
    if ($('#rsRev')?.checked) for (const s of mine) await srvApi(s, `/api/dispositivi/${encodeURIComponent(s.dev)}/revoca`, { method: 'POST' }).catch(() => {});
    else for (const s of mine) await srvApi(s, '/api/logout', { method: 'POST' }).catch(() => {});
    try { Engine.stop(); } catch {}
    // da qui niente deve più scrivere: un evento del canale dal vivo o un rinnovo di sessione arrivato durante la pulizia
    // riscriverebbe i server di prima (è così che una voce revocata restava dopo il ripristino)
    try { Live.stop(); } catch {}
    S.servers = []; S.active = null; store.set = () => {};
    try { localStorage.clear(); sessionStorage.clear(); } catch {}
    try { DB._db && (await DB._db).close(); } catch {}
    await new Promise(r => { const q = indexedDB.deleteDatabase('armony'); q.onsuccess = q.onerror = q.onblocked = r; });
    try { for (const k of await caches.keys()) await caches.delete(k); } catch {}
    try { for (const r of await navigator.serviceWorker?.getRegistrations?.() || []) await r.unregister(); } catch {}
    location.replace(location.pathname + '#/home'); location.reload();
  };
  closeOutside(d); d.showModal();
}
// leggere un QR con la fotocamera (app e browser con HTTPS): BarcodeDetector se il browser lo ha, altrimenti jsQR
// (vendor/jsQR.js, caricato solo qui). Restituisce il testo letto, o null se si annulla
async function scanQR() {
  if (!navigator.mediaDevices?.getUserMedia) { toast(location.protocol === 'http:' && !NATIVE ? 'La fotocamera funziona solo con HTTPS: apri Armony dal suo indirizzo https.' : 'Questo dispositivo non permette di usare la fotocamera.'); return null; }
  const d = $('#dlg2'); d.className = 'qrscan';
  d.innerHTML = `<h3>Inquadra il QR</h3><div class="qrcam"><video playsinline muted></video><span class="qrframe" aria-hidden="true"></span></div>
    <p class="sub" id="qrMsg">Avvicina il codice: si legge da solo.</p><div class="row"><button class="btn" id="qrStop">Annulla</button></div>`;
  const video = d.querySelector('video'), msg = $('#qrMsg');
  let stream, done = false, timer;
  const stop = () => { done = true; clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()); };
  return new Promise(async res => {
    const end = v => { if (done) return; stop(); d.close(); res(v); };
    d.onclose = () => { d.className = ''; d.onclose = null; stop(); res(null); };
    $('#qrStop').onclick = () => end(null);
    d.showModal();
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); }
    catch (e) { msg.textContent = e.name === 'NotAllowedError' ? 'Serve il permesso della fotocamera: consentilo e riprova.' : 'Non riesco ad aprire la fotocamera.'; return; }
    if (done) return stop();
    video.srcObject = stream; await video.play().catch(() => {});
    let det = null;
    try { if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) det = new BarcodeDetector({ formats: ['qr_code'] }); } catch {}
    if (!det && !window.jsQR) await new Promise((ok, ko) => { const sc = document.createElement('script'); sc.src = 'vendor/jsQR.js'; sc.onload = ok; sc.onerror = ko; document.head.append(sc); }).catch(() => {});
    const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
    const tick = async () => {
      if (done) return;
      try {
        if (video.readyState >= 2) {
          if (det) { const r = await det.detect(video); if (r[0]?.rawValue) return end(r[0].rawValue); }
          else if (window.jsQR) {
            const w = Math.min(640, video.videoWidth), h = Math.round(video.videoHeight * w / video.videoWidth); cv.width = w; cv.height = h;
            cx.drawImage(video, 0, 0, w, h); const r = jsQR(cx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
            if (r?.data) return end(r.data);
          }
        }
      } catch {}
      timer = setTimeout(tick, 180);
    };
    tick();
  });
}
// cosa fare con un QR letto: abbinamento, invito, Jam o indirizzo di un server
async function useScan(text) {
  if (!text) return;
  const t = text.trim(), m = t.match(/^(https?:\/\/[^#\s]*?)\/?#\/(abbina|invito|benvenuto)\/([\w-]+)/i), jam = t.match(/#(\/jam\/entra\/\S+)$/);
  if (m && m[2].toLowerCase() === 'benvenuto') return vBenvenuto(m[3], m[1].replace(/\/+$/, ''));  // account creato dall'amministratore (utenti.js)
  if (m) return serverDialog(null, { url: m[1].replace(/\/+$/, ''), mode: m[2].toLowerCase() === 'abbina' ? 'codice' : 'crea', code: m[3] });
  if (jam) { location.hash = '#' + jam[1]; return; }
  if (/^https?:\/\/\S+$/i.test(t)) return serverDialog(null, { url: t.replace(/[#?].*$/, '').replace(/\/+$/, '') });
  toast('Questo QR non è di Armony.');
}
async function qrInto(box, text) {
  // stessa libreria del QR della Jam, caricata solo quando serve
  if (!window.QRCode) await new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'; sc.onload = res; sc.onerror = rej; document.head.append(sc); });
  const q = document.createElement('div'); q.className = 'qr'; box.append(q);
  new QRCode(q, { text, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.L });
}
async function refreshReg() {
  const box = $('#regBox'); if (!box) return;
  let st, inv = [];
  try { st = await dlApi('/api/register/settings'); if (st.configured) inv = await dlApi('/api/register/invites'); }
  catch (e) { box.innerHTML = `<p class="sub">${esc(e.message)}</p>`; return; }
  const modes = [['chiusa', 'Chiusa'], ['invito', 'Con invito'], ['aperta', 'Aperta']];
  const hint = { chiusa: 'Nessuno può crearsi un account: li crei tu in Navidrome.', invito: 'Si entra con un codice d\'invito monouso che crei qui (valido 7 giorni).', aperta: 'Chiunque raggiunga il server può crearsi un account.' };
  const credForm = `<div class="grid2"><label class="f">Amministratore di Navidrome<input type="text" id="regU" autocomplete="off" autocapitalize="none" value="${esc(st.adminUser || '')}"></label>
    <label class="f">Password<input type="password" id="regP" autocomplete="new-password"></label></div>
    <div class="row" style="margin-top:var(--s3)"><button class="btn primary" data-act="regcred">Salva</button></div>`;
  box.innerHTML = !st.configured ? `<div class="panel stack"><p style="margin:0">Per far creare un account agli amici serve l'amministratore di Navidrome: inseriscilo una volta, resta solo sul server.</p>${credForm}</div>`
    : `<div class="panel stack">
      <p style="margin:0">Gli account si creano come <b>${esc(st.adminUser)}</b>${st.source === 'env' ? ' (dalle variabili d\'ambiente del server)' : ''}. Chi si registra è sempre un utente normale.</p>
      <div class="seg" role="radiogroup" aria-label="Registrazione">${modes.map(([v, l]) => `<label><input type="radio" name="regmode" value="${v}" ${st.mode === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      <p class="small" style="margin:0;color:var(--muted)">${hint[st.mode]}</p>
      ${st.source === 'env' ? '' : `<details><summary class="small" style="cursor:pointer;color:var(--muted)">Cambia l'amministratore di Navidrome</summary><div style="margin-top:var(--s3)">${credForm}</div></details>`}
    </div>
    ${st.mode === 'invito' ? `<div class="row between"><h3 style="margin:var(--s3) 0">Inviti</h3><button class="btn sm primary" data-act="reginv">${ic('plus')} Crea invito</button></div>
      ${inv.length ? inv.map(i => `<div class="list-item" style="cursor:default;flex-wrap:wrap;min-height:56px">
        <span class="grow"><b style="font-variant-numeric:tabular-nums;letter-spacing:.04em">${esc(fmtCode(i.code))}</b><small>${i.state === 'usato' ? `usato da ${esc(i.usedBy)}` : i.state === 'attivo' ? `scade il ${new Date(i.expires * 1000).toLocaleDateString()}` : i.state}</small></span>
        <span class="tag ${i.state === 'attivo' ? 'ok' : ''}">${esc(i.state)}</span>
        ${i.state === 'attivo' ? `<button class="btn sm" data-act="regshow" data-code="${esc(i.code)}">Condividi</button><button class="icon-btn" data-act="regrevoke" data-code="${esc(i.code)}" aria-label="Revoca">${ic('trash')}</button>` : ''}</div>`).join('')
        : '<div class="empty">Nessun invito. Creane uno e mandalo a un amico.</div>'}` : ''}`;
  box.querySelectorAll('[name=regmode]').forEach(r => r.onchange = async () => { try { await dlApi('/api/register/settings', { method: 'PUT', body: JSON.stringify({ mode: r.value }) }); } catch (e) { toast(e.message); } refreshReg(); });
}
function inviteSheet(code) {
  const d = $('#dlg2'); d.className = ''; const link = inviteLink(code);
  d.innerHTML = `<h3>Invito per un amico</h3><p class="sub" style="margin-bottom:var(--s3)">Monouso, valido 7 giorni. Chi lo apre si crea l'account e entra subito.</p>
    <p style="font:800 2rem/1 var(--display);letter-spacing:.06em;margin:0 0 var(--s3);font-variant-numeric:tabular-nums">${esc(fmtCode(code))}</p>
    <div class="code" style="font-size:.8rem">${esc(link)}</div><div id="regQr" style="margin:var(--s3) 0"></div>
    <div class="row"><button class="btn primary" id="regCopy">${ic('share')} ${navigator.share ? 'Condividi' : 'Copia il link'}</button><button class="btn" onclick="this.closest('dialog').close()">Chiudi</button></div>`;
  $('#regCopy').onclick = async () => {
    const text = `Ti invito su Armony: apri ${link} (codice ${fmtCode(code)})`;
    if (navigator.share) { try { await navigator.share({ title: 'Armony', text, url: link }); return; } catch {} }
    if (await copyText(link)) toast('Link copiato.');
  };
  d.showModal(); qrInto($('#regQr'), link).catch(() => {});
}
/* ================= librerie collegate (federazione, solo amministratori) ================= */
const FED_STATE = { attesa: ['aspetta che accetti', ''], richiesta: ['vuole collegarsi', 'acc'], chiuso: ['chiuso dall\'altro server', 'err'] };
// l'indirizzo con cui gli altri server raggiungono questo: quello pubblico del server, se c'è
const fedBase = () => pubBase(srv());
async function refreshFed() {
  const box = $('#fedBox'); if (!box) return;
  let f; try { f = await dlApi('/api/fed'); } catch (e) { box.innerHTML = `<p class="sub">${esc(e.message)}</p>`; return; }
  if (!box.isConnected) return;  // nel frattempo si è cambiata pagina
  const st = x => x.state === 'attivo' ? (x.online ? ['in linea', 'ok'] : ['non raggiungibile', 'err']) : FED_STATE[x.state] || [x.state, ''];
  const hopsTxt = { 1: 'Solo i server collegati', 2: 'Anche gli amici degli amici', 3: 'Fino a tre passaggi' };
  box.innerHTML = `${f.ready ? '' : '<div class="panel" style="margin-bottom:var(--s3)"><p style="margin:0">Per mostrare la tua libreria agli altri server serve l\'amministratore di Navidrome: inseriscilo in Utenti → Registrazione.</p></div>'}
    <div class="panel stack">
      <p style="margin:0">Questo server è <b>${esc(f.me.nome)}</b>: ${f.me.songs} brani, ${f.me.albums} album. Impronta <code>${esc(f.me.short)}</code></p>
      <div class="grid2"><label class="f">Proprietario<input type="text" id="fedOwner" value="${esc(f.settings.owner)}" placeholder="Il tuo nome" maxlength="60"></label>
        <label class="f">Indirizzo per gli altri server<input type="url" id="fedUrl" value="${esc(f.settings.url)}" placeholder="${esc(fedBase())}" autocapitalize="none" autocomplete="off"></label></div>
      <label class="check"><input type="checkbox" id="fedTrans" ${f.settings.transitive ? 'checked' : ''}><span>Visibile agli amici degli amici<small>Chi è collegato a un tuo collegato trova e ascolta la tua libreria passando da lui. Spento: solo i server che colleghi tu.</small></span></label>
      <label class="f">Dove cercare<select id="fedHops">${[1, 2, 3].map(h => `<option value="${h}" ${f.settings.hops === h ? 'selected' : ''}>${hopsTxt[h]}</option>`).join('')}</select></label>
    </div>
    <div class="row" style="margin:var(--s4) 0 var(--s2)"><button class="btn primary" data-act="fedinv">${ic('plus')} Crea un invito</button><button class="btn" data-act="fedjoin">Incolla un invito</button></div>
    ${f.nodes.length ? f.nodes.map(x => { const [l, c] = st(x); return `<div class="list-item fednode">
      <span class="grow"><b>${esc(x.name)}${x.owner ? ` <small>di ${esc(x.owner)}</small>` : ''}</b><small>${esc(x.url)}${x.state === 'attivo' ? ` · ${x.songs} brani, ${x.albums} album` : ''}${x.app ? ' · Armony ' + esc(x.app) : ''}${x.synced ? ' · aggiornato ' + new Date(x.synced * 1000).toLocaleString() : ''}</small>
        ${x.reach === 'canale' ? `<small style="display:block">${ic('wifi')} Non si raggiunge da fuori: parla con te dal suo canale, la sua libreria arriva lo stesso</small>` : x.reach === 'uscita' ? `<small style="display:block">${ic('wifi')} Questo server non si raggiunge da fuori: resta collegato in uscita, la tua libreria passa dal canale</small>` : ''}
        ${x.error ? `<small style="display:block;color:var(--danger)">${esc(x.error)}</small>` : ''}<small style="display:block">Codice di sicurezza <span class="safety">${esc(x.safety)}</span></small></span>
      <span class="tag ${c}">${esc(l)}</span>
      ${x.state === 'richiesta' ? `<button class="btn sm primary" data-act="fedok" data-id="${esc(x.id)}" data-name="${esc(x.name)}" data-safety="${esc(x.safety)}">Accetta</button>` : ''}
      ${x.state === 'attivo' && x.dir ? `<select class="fedverso" data-id="${esc(x.id)}" aria-label="Verso del collegamento con ${esc(x.name)}" style="width:auto">${[['entrambi', 'Ci vediamo a vicenda'], ['offro', 'Solo lui vede me'], ['ricevo', 'Solo io vedo lui']].map(([v, l]) => `<option value="${v}" ${x.dir === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
      ${x.state === 'attivo' ? `<button class="icon-btn" data-act="fedsync" data-id="${esc(x.id)}" aria-label="Aggiorna ora" title="Aggiorna ora">${ic('repeat')}</button>` : ''}
      <button class="icon-btn" data-act="fedrm" data-id="${esc(x.id)}" data-name="${esc(x.name)}" aria-label="${x.state === 'richiesta' ? 'Rifiuta' : 'Scollega'}">${ic('trash')}</button></div>`; }).join('')
      : '<div class="empty">Nessun server collegato. Crea un invito e mandalo a un amico che ha Armony, oppure incolla il suo.</div>'}`;
  box.querySelectorAll('.fedverso').forEach(el => el.onchange = async () => {
    try { await dlApi(`/api/fed/nodes/${el.dataset.id}/verso`, { method: 'PUT', body: JSON.stringify({ dir: el.value }) }); toast({ entrambi: 'Le due librerie si vedono a vicenda.', offro: 'Lui vede la tua libreria, tu non cerchi più nella sua.', ricevo: 'Vedi la sua libreria, lui non vede più la tua.' }[el.value]); refreshFed(); }
    catch (e) { toast(e.message); refreshFed(); }
  });
  const save = async body => { try { await dlApi('/api/fed/settings', { method: 'PUT', body: JSON.stringify(body) }); toast('Salvato.'); } catch (e) { toast(e.message); refreshFed(); } };
  $('#fedOwner').onchange = e => save({ owner: e.target.value.trim() });
  $('#fedUrl').onchange = e => save({ url: e.target.value.trim() });
  $('#fedTrans').onchange = e => save({ transitive: e.target.checked });
  $('#fedHops').onchange = e => save({ hops: +e.target.value });
}
function fedInviteSheet(code) {
  const d = $('#dlg2'); d.className = '';
  d.innerHTML = `<h3>Invito per un altro server</h3><p class="sub" style="margin-bottom:var(--s3)">Mandalo all'amministratore dell'altro server: lo incolla in Librerie collegate → Incolla un invito. Vale una volta sola, per 24 ore. Poi qui compare la sua richiesta da accettare.</p>
    <div class="code" style="font-size:.78rem;word-break:break-all">${esc(code)}</div><div id="fedQr" style="margin:var(--s3) 0"></div>
    <div class="row"><button class="btn primary" id="fedCopy">${ic('share')} ${navigator.share ? 'Condividi' : 'Copia'}</button><button class="btn" onclick="this.closest('dialog').close()">Chiudi</button></div>`;
  $('#fedCopy').onclick = async () => {
    if (navigator.share) { try { await navigator.share({ title: 'Armony', text: code }); return; } catch {} }
    if (await copyText(code)) toast('Invito copiato.');
  };
  d.showModal(); qrInto($('#fedQr'), code).catch(() => {});
}
function fedJoinSheet() {
  const d = $('#dlg2'); d.className = '';
  d.innerHTML = `<h3>Incolla un invito</h3><p class="sub" style="margin-bottom:var(--s3)">Il codice che ti ha mandato l'amministratore dell'altro server (inizia con ARF1).</p>
    <label class="f">Invito<textarea id="fedCode" rows="4" autocapitalize="none" autocomplete="off" spellcheck="false"></textarea></label>
    <div class="row" style="margin-top:var(--s3)"><button class="btn primary" id="fedGo">Collega</button><button class="btn" onclick="this.closest('dialog').close()">Annulla</button></div>`;
  $('#fedGo').onclick = async () => {
    const code = $('#fedCode').value.trim(); if (!code) return;
    $('#fedGo').disabled = true;
    try {
      const x = await dlApi('/api/fed/join', { method: 'POST', body: JSON.stringify({ code, url: fedBase() }) });
      d.innerHTML = `<h3>Richiesta mandata a ${esc(x.name)}</h3><p class="sub" style="margin-bottom:var(--s3)">Quando l'amministratore di ${esc(x.name)} accetta, le vostre librerie si vedono in Rete e in Cerca. Confronta con lui il codice di sicurezza: se è uguale sui due schermi, nessuno si è messo in mezzo.</p>
        <p class="safety" style="margin:0 0 var(--s4)">${esc(x.safety)}</p><div class="row"><button class="btn primary" onclick="this.closest('dialog').close()">Fatto</button></div>`;
      refreshFed();
    } catch (e) { toast(e.message); $('#fedGo').disabled = false; }
  };
  d.showModal();
}
async function notifyUpdate() {
  if (!access().admin) return;
  const u = await dlApi('/api/update').catch(() => null);
  S.updAvail = !!u?.available; setDots();
  if (u?.available && store.get('updSeen') !== u.latest) { store.set('updSeen', u.latest); toast(`Armony ${u.latest} disponibile: aggiorna da Impostazioni.`, 6000); }
}
function serverDialog(s, preset = {}) {
  const editing = !!s;
  s = s || { id: uid(8), name: preset.name || '', url: preset.url || '', user: '', shareBase: '' };
  const d = $('#dlg'); d.className = '';
  d.innerHTML = `<h3>${editing ? 'Modifica server' : 'Nuovo server'}</h3><div class="stack">
    <label class="f">Indirizzo<span class="row" style="flex-wrap:nowrap;gap:var(--s2)"><input type="url" id="sUrl" value="${esc(s.url)}" placeholder="http://192.168.1.10:8080" autocapitalize="none" autocorrect="off" inputmode="url" style="flex:1;min-width:0"><button type="button" class="icon-btn" id="sScan" aria-label="Inquadra un QR" title="Inquadra un QR">${ic('qr')}</button></span></label>
    <div class="seg" id="sMode" role="radiogroup" aria-label="Accesso" hidden><label><input type="radio" name="smode" value="accedi" checked><span>Accedi</span></label><label id="sCreaL"><input type="radio" name="smode" value="crea"><span>Crea un account</span></label><label id="sCodL" hidden><input type="radio" name="smode" value="codice"><span>Con un codice</span></label></div>
    <div class="stack" id="sLogin">
      <label class="f">Utente<input type="text" id="sUser" value="${esc(s.user)}" autocomplete="username" autocapitalize="none" autocorrect="off"></label>
      <label class="f">Password<input type="password" id="sPass" value="" autocomplete="current-password" ${s.tok ? 'placeholder="Lascia vuoto per non cambiarla"' : ''}></label>
    </div>
    <div class="stack" id="sCreate" hidden>
      <label class="f">Scegli un nome utente<input type="text" id="rUser" autocomplete="username" autocapitalize="none" autocorrect="off" maxlength="32" placeholder="es. giulia"></label>
      <label class="f">Scegli una password<input type="password" id="rPass" autocomplete="new-password" placeholder="Almeno 8 caratteri"></label>
      <label class="f">Ripeti la password<input type="password" id="rPass2" autocomplete="new-password"></label>
      <label class="f" id="rCodeL">Codice d'invito<input type="text" id="rCode" value="${esc(preset.mode === 'codice' ? '' : preset.code || '')}" autocapitalize="characters" autocorrect="off" placeholder="XXXX-XXXX"></label>
    </div>
    <div class="stack" id="sPair" hidden>
      <label class="f">Codice di abbinamento<input type="text" id="pCode" value="${esc(preset.mode === 'codice' ? preset.code || '' : '')}" autocapitalize="characters" autocorrect="off" autocomplete="one-time-code" placeholder="XXXX-XXXX"></label>
      <p class="small" style="margin:0;color:var(--muted)">Crealo da un tuo dispositivo già collegato: Impostazioni → Dispositivi e sicurezza → Abbina un dispositivo. Entri senza password.</p>
    </div>
    <label class="f">Nome del server<input type="text" id="sName" value="${esc(s.name)}" placeholder="Casa di Marco"></label>
    <details><summary class="small" style="cursor:pointer;color:var(--muted)">Avanzate</summary>
      <label class="f" style="margin-top:8px">Indirizzo pubblico per i link condivisi<input type="url" id="sShare" value="${esc(s.shareBase || '')}" placeholder="https://musica.miodominio.it"></label></details>
    <p id="sMsg" class="small" style="margin:0;color:var(--muted)" role="status"></p>
    <div class="row"><button class="btn primary" id="sSave">${editing ? 'Salva' : 'Accedi'}</button><button class="btn" id="sTest">Prova</button><button class="btn" onclick="this.closest('dialog').close()">Annulla</button></div></div>`;
  const msg = t => { $('#sMsg').textContent = t; };
  const mode = () => d.querySelector('[name=smode]:checked')?.value || 'accedi';
  let reg = null;
  const paintMode = () => {
    const crea = mode() === 'crea', cod = mode() === 'codice';
    $('#sLogin').hidden = crea || cod; $('#sCreate').hidden = !crea; $('#sPair').hidden = !cod; $('#sTest').hidden = crea || cod;
    $('#sName').closest('label').hidden = cod; d.querySelector('details').hidden = cod;
    $('#rCodeL').hidden = !reg?.needsCode;
    $('#sSave').textContent = editing ? 'Salva' : crea ? 'Crea l\'account' : cod ? 'Abbina' : 'Accedi';
    msg('');
  };
  d.querySelectorAll('[name=smode]').forEach(r => r.onchange = paintMode);
  // la registrazione si offre solo se il server la permette (/api/register/info è pubblica)
  const checkReg = async () => {
    const url = $('#sUrl').value.trim().replace(/\/+$/, ''); reg = null;
    let pair = false;
    if (!editing && url && /^https?:\/\/./.test(absUrl(url))) {
      await NetDns.need(url);
      [reg, pair] = await Promise.all([fetch(absUrl(url) + '/api/register/info').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(absUrl(url) + '/api/info').then(r => r.ok ? r.json() : null).then(i => !!i?.caps?.includes('dispositivi')).catch(() => false)]);
    }
    $('#sMode').hidden = !reg?.open && !pair; $('#sCreaL').hidden = !reg?.open; $('#sCodL').hidden = !pair;
    if ((!reg?.open && mode() === 'crea') || (!pair && mode() === 'codice')) d.querySelector('[name=smode][value=accedi]').checked = true;
    if (!paintMode.done && ((reg?.open && preset.mode === 'crea') || (pair && preset.mode === 'codice'))) { d.querySelector(`[name=smode][value=${preset.mode}]`).checked = true; paintMode.done = true; }
    paintMode();
  };
  $('#sUrl').onchange = checkReg;
  const read = () => {
    const pass = $('#sPass').value, user = $('#sUser').value.trim();
    const n = { ...s, name: $('#sName').value.trim() || reg?.name || $('#sUrl').value.trim(), url: $('#sUrl').value.trim().replace(/\/+$/, ''), user, shareBase: $('#sShare').value.trim() };
    if (pass) Object.assign(n, subsonicCreds(pass));
    else if (user !== s.user) delete n.tok;  // utente cambiato senza password: credenziali vecchie non valide
    if (user !== s.user) delete n.dev;  // la chiave del dispositivo è legata all'utente di prima
    if (grant) n.grant = grant;
    return n;
  };
  let grant = null;
  $('#sTest').onclick = async () => { msg('Provo…'); try { await api('ping', {}, read()); msg('Connessione riuscita.'); } catch (e) { msg(e.message); } };
  const save = async welcome => {
    const n = read(); if (!n.url || !n.user || !n.tok) return msg('Indirizzo, utente e password sono obbligatori.');
    msg('Verifico…');
    delete n.session; delete n.armony; delete n.me; delete n.pending; delete n.revoked; delete n.tk;
    if (!n.dev) await Disp.forget(n);
    // con Armony davanti il proxy vuole un dispositivo fidato: prima l'accesso, il ping solo per i server Subsonic
    let arm = null;
    try { arm = await armonyLogin(n); } catch (e) { if (!n.pending) return msg('Armony: ' + e.message); }
    if (!arm && !n.pending) { try { await api('ping', {}, n); } catch (e) { if (welcome || !confirm(`${e.message}\nSalvare comunque?`)) return msg(e.message); } }
    const i = S.servers.findIndex(x => x.id === n.id); if (i >= 0) S.servers[i] = n; else S.servers.push(n);
    if (!S.active || welcome || S.active === Local.id) S.active = n.id;
    if (n.session && S.active === n.id) store.set('downloader', null);
    persistServers(); d.close();
    if (location.hash.startsWith('#/invito')) location.hash = '#/home'; else route();
    Live.connect?.();
    toast(n.pending ? 'Dispositivo registrato: aspetta l\'approvazione.' : welcome ? `Benvenuto in Armony, ${n.user}!` : n.me ? `Collegato a ${n.name}${n.me.admin ? ' come amministratore' : ''}.` : `Collegato a ${n.name}: solo ascolto, il server non ha Armony.`);
  };
  const create = async () => {
    const url = absUrl($('#sUrl').value.trim().replace(/\/+$/, '')), u = $('#rUser').value.trim(), p1 = $('#rPass').value, code = $('#rCode').value.trim();
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(u)) return msg('Il nome utente va da 3 a 32 caratteri: lettere, cifre, punto, trattino e trattino basso.');
    if (p1.length < 8) return msg('La password deve avere almeno 8 caratteri.');
    if (p1 !== $('#rPass2').value) return msg('Le due password non coincidono.');
    if (reg?.needsCode && !code) return msg('Serve il codice d\'invito: chiedilo a chi gestisce il server.');
    msg('Creo l\'account…'); $('#sSave').disabled = true;
    try {
      const r = await fetch(url + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p1, code }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return msg(j.error || `Errore ${r.status}`);
      // account creato: si entra come se l'avesse scritto nei campi di accesso (con l'invito, già fidato)
      $('#sUser').value = u; $('#sPass').value = p1; grant = j.grant || null;
      await save(true);
    } catch { msg('Non riesco a raggiungere il server.'); }
    finally { $('#sSave').disabled = false; }
  };
  // con il codice di un dispositivo fidato: niente password, la chiave nasce qui (dispositivi.js)
  const pairNow = async () => {
    const url = $('#sUrl').value.trim().replace(/\/+$/, ''), code = $('#pCode').value.trim();
    if (!url || !code) return msg('Indirizzo e codice sono obbligatori.');
    msg('Abbino…'); $('#sSave').disabled = true;
    try {
      const n = await Disp.pair(url, code);
      // riabbinato dopo una revoca: la voce nuova prende il posto (e l'id, così coda e offline restano validi) di quella
      // morta dello stesso server e utente, invece di restarle accanto
      const old = S.servers.find(x => !x.local && absUrl(x.url) === absUrl(n.url) && x.user === n.user && (x.revoked || x.pending || !x.tok));
      if (old) {
        const k = await DB.get('chiavi', n.id).catch(() => null);
        if (k) { await DB.put('chiavi', { ...k, k: old.id }); DB.del('chiavi', n.id).catch(() => {}); }
        n.id = old.id; S.servers[S.servers.indexOf(old)] = n;
      } else S.servers.push(n);
      S.active = n.id; persistServers(); d.close();
      location.hash = '#/home'; route(); Live.connect?.();
      toast(`Dispositivo abbinato: benvenuto, ${n.user}.`);
    } catch (e) { msg(e.message); }
    finally { $('#sSave').disabled = false; }
  };
  $('#sSave').onclick = () => mode() === 'crea' ? create() : mode() === 'codice' ? pairNow() : save(false);
  // QR di abbinamento, d'invito o di un server: si legge e si riapre questa finestra già compilata
  $('#sScan').onclick = async () => { const t = await scanQR(); if (t) { d.close(); useScan(t); } };
  d.showModal();
  checkReg();
}
function persistServers() { store.set('servers', S.servers); store.set('active', S.active); fillSelectors(); sidePlaylists(); }
function fillSelectors() {
  const name = srv()?.name || 'Nessun server', q = QUALITIES[P.quality].short;
  $('#ctxBtn').innerHTML = `<span class="grow">${esc(name)}</span><span class="pill">${esc(q)}</span>`;
  $('#ctxBtn').setAttribute('aria-label', `Server e qualità: ${name}, ${q}`);
  $('#qBadge').textContent = Offline.has(currentTrack()) ? 'Offline' : srv(currentTrack()?.serverId)?.local ? 'Telefono' : QUALITIES[activeQuality()].short + (activeQuality() !== P.quality ? ' (mobile)' : '');
}
function setQuality(q) { P.quality = q; savePrefs(); fillSelectors(); toast(`Qualità: ${QUALITIES[q].label}. Vale dal prossimo brano.`); }
// server in uso e qualità: dalla riga in fondo alla barra laterale (in alto su telefono)
// i fogli di navigazione si chiudono anche toccando fuori (su telefono non c'è Esc)
function closeOutside(d) {
  d.onclick = e => { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); };
  d.onclose = () => { d.className = ''; d.onclose = null; d.onclick = null; };
}
function ctxDialog() {
  const d = $('#dlg'); d.className = 'sheet';
  d.innerHTML = `<div class="head"><b>Server e qualità</b></div>
    <p class="sh">Server</p>${(Local.on() ? [Local.srv, ...S.servers] : S.servers).map(s => `<button class="mi ${s.id === S.active ? 'on' : ''}" data-sid="${s.id}">${ic(s.id === S.active ? 'check' : s.local ? 'phone' : 'lib')}${esc(s.name)}</button>`).join('')}
    <button class="mi" data-ctx="srv">${ic('plus')}${S.servers.length ? 'Gestisci i server' : 'Aggiungi un server'}</button>
    <p class="sh">Qualità di ascolto</p>${Object.entries(QUALITIES).map(([k, q]) => `<button class="mi ${k === P.quality ? 'on' : ''}" data-q="${k}">${ic(k === P.quality ? 'check' : 'album')}${q.label}</button>`).join('')}`;
  d.querySelectorAll('[data-sid]').forEach(el => el.onclick = () => { d.close(); if (S.active === el.dataset.sid) return; S.active = el.dataset.sid; persistServers(); route(); });
  d.querySelectorAll('[data-q]').forEach(el => el.onclick = () => { setQuality(el.dataset.q); d.close(); });
  d.querySelector('[data-ctx]').onclick = () => { d.close(); if (S.servers.length) location.hash = '#/impostazioni/server'; else serverDialog(); };
  closeOutside(d); d.showModal();
}
// barra in basso del telefono: le sezioni scelte (tabsOf). Le altre stanno nel menu del profilo, in alto a sinistra
// (come Spotify): niente più "Altro" nella barra
function paintTabs() {
  const navOf = h => NAV.find(n => n[0] === h);
  $('#tabs').innerHTML = tabsOf().map(navOf).map(([h, l, i]) => `<a href="#/${h}" data-r="${h}">${ic(i)}<span>${l}</span></a>`).join('');
  markNav(location.hash.replace(/^#\/?/, '').split('/')[0] || 'home');
  paintMe(); Presence.paint();
}
// l'avatar in alto a sinistra (telefono): l'iniziale dell'utente, con un puntino se nel menu c'è qualcosa di nuovo
function paintMe() {
  const b = $('#hMe'); if (!b) return;
  const u = srv()?.user || '?', dot = (Presence.on?.() && Presence.playingCount?.() && inMore('amici')) || (srv()?.me?.pending && inMore('impostazioni'));
  b.innerHTML = pavatar({ user: u, name: u }) + (dot ? '<i class="dot pdot" aria-hidden="true"></i>' : '');
  const hp = $('#hProf'); if (hp) { hp.hidden = !srv() || !!srv().local; hp.innerHTML = pavatar({ user: u, name: P.nick || u }); }
}
// computer: il pallino del profilo, ultimo in alto a destra, apre le impostazioni del profilo (foto, nome, privacy)
function profPop() {
  const d = $('#dlg'), s = srv(), u = s?.user || '';
  d.className = 'profpop';
  d.innerHTML = `<div class="pp-me">${pavatar({ user: u, name: P.nick || u }, 'l')}<span class="grow"><b>${esc(P.nick || u)}</b><small>${esc(u)} · ${esc(s?.name || '')}${s?.me?.admin ? ' · amministratore' : ''}</small></span></div>
    ${Avatar.ok() ? `<div class="row"><button class="btn sm" id="ppAv">${ic('image')} Cambia foto</button><button class="btn sm" id="ppAvDel">Togli la foto</button></div>` : ''}
    <label class="f">Il tuo nome per gli amici e nelle Jam<input type="text" id="ppNick" value="${esc(P.nick)}" placeholder="${esc(u)}" maxlength="30"></label>
    ${Presence.on() ? `<label class="check"><input type="checkbox" id="ppShare" ${Presence.share ? 'checked' : ''}><span>Mostra agli altri cosa ascolto</span></label>` : ''}
    <div class="dr-sep"></div>
    ${Amici.on() ? `<button class="mi" id="ppPw">${ic('lock')}<span class="grow">Cambia password</span></button>` : ''}
    <a class="mi" href="#/impostazioni/profilo">${ic('user')}<span class="grow">Tutte le impostazioni del profilo</span></a>
    <a class="mi" href="#/impostazioni">${ic('gear')}<span class="grow">Impostazioni</span></a>`;
  if ($('#ppAv')) { $('#ppAv').onclick = () => Avatar.choose(); $('#ppAvDel').onclick = () => Avatar.remove(); }
  $('#ppNick').onchange = e => { P.nick = e.target.value.trim(); savePrefs(); paintMe(); };
  if ($('#ppShare')) $('#ppShare').onchange = async e => {
    try { Presence.share = (await srvApi(srv(), '/api/live/privacy', { method: 'PUT', body: JSON.stringify({ share: e.target.checked }) })).share; toast(Presence.share ? 'Gli altri vedono cosa ascolti.' : 'Non compari più agli altri.'); }
    catch { e.target.checked = Presence.share; toast('Non riesco a salvare: riprova.'); }
  };
  if ($('#ppPw')) $('#ppPw').onclick = () => { d.close(); Amici.passwordSheet(); };
  d.querySelectorAll('a.mi').forEach(a => a.addEventListener('click', () => d.close()));
  closeOutside(d); d.showModal();
}
// menu del profilo (telefono): chi sei, server e qualità, tutte le sezioni che non stanno nella barra in basso
function drawer() {
  const d = $('#dlg'); d.className = 'drawer';
  const s = srv(), u = s?.user || 'Ospite', cur = location.hash.replace(/^#\/?/, '').split('/')[0] || 'home';
  const items = NAV.filter(([h]) => inMore(h) && (h !== 'rete' || can('rete')) && (h !== 'video' || (S.dl.url && can('download'))));
  const dot = h => h === 'amici' && Presence.on() && Presence.playingCount() ? '<i class="dot pdot" aria-label="qualcuno sta ascoltando"></i>'
    : h === 'impostazioni' && srv()?.me?.pending ? '<i class="dot pdot" aria-label="dispositivi in attesa"></i>' : '';
  d.innerHTML = `<div class="dr-me">${pavatar({ user: u, name: u }, 'm')}<span class="grow"><b>${esc(u)}</b><small>${esc(s?.name || 'Nessun server')}${s?.me?.admin ? ' · amministratore' : ''}</small></span></div>
    <button class="mi" id="drSrv">${ic('lib')}<span class="grow">Server e qualità<small>${esc(s?.name || '—')} · ${esc(QUALITIES[P.quality].short)}</small></span></button>
    ${!NATIVE ? `<button class="mi" id="drTheme">${ic(THEMES[P.theme]?.[1] || 'themeauto')}<span class="grow">Tema<small>${esc((THEMES[P.theme] || THEMES.auto)[0])}</small></span></button>` : ''}
    <div class="dr-sep"></div>
    ${items.map(([h, l, i]) => `<a class="mi ${h === cur ? 'on' : ''}" href="#/${h}" ${h === cur ? 'aria-current="page"' : ''}>${ic(i)}<span class="grow">${l}</span>${dot(h)}</a>`).join('')}
    <div class="dr-sep"></div>
    <button class="mi" id="drTabs">${ic('sliders')}<span class="grow">Barra in basso<small>Scegli le sezioni a portata di pollice</small></span></button>`;
  d.querySelectorAll('a').forEach(a => a.onclick = () => d.close());
  $('#drSrv').onclick = () => { d.close(); ctxDialog(); };
  $('#drTabs').onclick = () => { d.close(); tabsEditor(); };
  if ($('#drTheme')) $('#drTheme').onclick = () => { $('#themeBtn').click(); d.close(); };
  closeOutside(d); d.showModal();
}
// scegliere e ordinare le voci della barra: frecce (accessibili, niente trascinamento da indovinare), anteprima in cima
function tabsEditor() {
  const d = $('#dlg'); d.className = 'sheet tbed';
  d.innerHTML = `<div class="head" tabindex="-1" autofocus><span class="grow"><b style="display:block">Barra in basso</b><small style="color:var(--muted)">Fino a quattro sezioni. Le altre sono nel menu del profilo, in alto a sinistra. Vale su questo dispositivo.</small></span></div>
    <div class="tbprev" id="tbPrev" aria-hidden="true"></div>
    <p class="sh" id="tbInH">Nella barra</p><div id="tbIn" role="list" aria-labelledby="tbInH"></div>
    <p class="sh" id="tbOutH"></p><div class="tbout" id="tbOut" role="list" aria-labelledby="tbOutH"></div>
    <div class="row tbfoot"><button class="btn" id="tbReset">Ripristina</button><button class="btn primary" id="tbOk">Fatto</button></div>`;
  const navOf = h => NAV.find(n => n[0] === h), save = t => { store.set('tabs', t); paintTabs(); paint(); };
  const paint = () => {
    const t = tabsOf(), full = t.length >= 4, out = NAV.filter(([h]) => !t.includes(h));
    const sum = $('.tbset small'); if (sum) sum.textContent = t.map(h => navOf(h)[1]).join(' · ');
    $('#tbPrev').innerHTML = t.map(navOf).map(([, l, i]) => `<span>${ic(i)}<small>${l}</small></span>`).join('');
    keyed($('#tbIn'), t.map(navOf).map(([h, l, i], k) => ({ k: h, cls: 'tbrow', attrs: { role: 'listitem' }, html: `${ic(i)}<b class="grow">${l}</b>
      <button class="icon-btn" data-x="up" aria-label="Sposta ${l} a sinistra"${k ? '' : ' disabled'}>${ic('up')}</button><button class="icon-btn" data-x="dn" aria-label="Sposta ${l} a destra"${k < t.length - 1 ? '' : ' disabled'}>${ic('dn')}</button>
      <button class="icon-btn" data-x="del" aria-label="Togli ${l} dalla barra"${t.length > 1 ? '' : ' disabled'}>${ic('close')}</button>` })));
    $('#tbOutH').textContent = full ? 'Nel menu del profilo · la barra è piena: togline una per aggiungerne un\'altra' : 'Nel menu del profilo · tocca per aggiungere alla barra';
    keyed($('#tbOut'), out.map(([h, l, i]) => ({ k: h, attrs: { role: 'listitem' }, html: `<button class="chip" data-x="add" aria-label="Aggiungi ${l} alla barra"${full ? ' disabled' : ''}>${ic(i)}${l}</button>` })));
  };
  const act = e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    const h = b.closest('[data-k]').dataset.k, x = b.dataset.x, t = [...tabsOf()], k = t.indexOf(h);
    if (x === 'add') t.push(h); else if (x === 'del') t.splice(k, 1);
    else { const j = x === 'up' ? k - 1 : k + 1; [t[k], t[j]] = [t[j], t[k]]; }
    save(t);
    // il tasto premuto può essere stato ridisegnato o essersi spostato: il fuoco resta sulla stessa sezione
    if (!d.contains(document.activeElement) || document.activeElement.disabled) d.querySelector(`[data-k="${h}"] [data-x="${x}"]:not(:disabled)`)?.focus() || d.querySelector(`[data-k="${h}"] button:not(:disabled)`)?.focus();
  };
  $('#tbReset').onclick = () => { store.set('tabs', null); paintTabs(); paint(); };
  $('#tbOk').onclick = () => d.close();
  [$('#tbIn'), $('#tbOut')].forEach(b => window.autoAnimate?.(b));
  paint();
  closeOutside(d); const out = d.onclick; d.onclick = e => { out(e); act(e); };  // prima il tocco fuori: il foglio cambia misura
  d.showModal();
}
function qualityDialog() {
  const d = $('#dlg'); d.className = 'sheet';
  d.innerHTML = `<div class="head"><b>Qualità di ascolto</b></div>${Object.entries(QUALITIES).map(([k, q]) => `<button class="mi" data-q="${k}">${k === P.quality ? ic('heart', true) : ic('album')}${q.label}</button>`).join('')}`;
  d.querySelectorAll('[data-q]').forEach(el => el.onclick = () => { setQuality(el.dataset.q); d.close(); });
  d.onclose = () => { d.className = ''; d.onclose = null; }; d.showModal();
}
function eqDialog() {
  Engine.graph();
  const d = $('#dlg'); d.className = 'wide';
  const lbl = f => f >= 1000 ? f / 1000 + 'k' : f, fmt = v => (v > 0 ? '+' : '') + String(Math.round(v * 10) / 10).replace('.', ',');
  const off = P.compat ? 'In modalità compatibile l\'audio non passa dal motore del browser: equalizzatore, modalità automatica e protezione dai gracchi sono spenti.'
    : !Engine.ctx ? 'Si attiva quando parte la musica.' : '';
  d.innerHTML = `<h3>Equalizzatore</h3>${off ? `<p class="sub">${esc(off)}</p>` : ''}
    <div class="row between"><label class="check" style="align-items:center"><input type="checkbox" id="eqOn" ${P.eqOn ? 'checked' : ''}><span>Attivo</span></label>
    <select id="eqPre" style="width:auto"><option value="">Manuale</option><option value="auto">Automatico</option><optgroup label="Preimpostazioni">${Object.keys(EQ_PRESETS).map(k => `<option>${esc(k)}</option>`).join('')}</optgroup></select></div>
    <p class="sub" id="eqInfo" hidden></p>
    <div class="eq">${EQ_FREQS.map((f, i) => `<label><span id="eqv${i}"></span><input type="range" min="-12" max="12" step="1" data-b="${i}" aria-label="${lbl(f)} Hz"><span>${lbl(f)}</span></label>`).join('')}</div>
    <div class="row"><button class="btn" id="eqReset">Azzera</button><button class="btn primary" onclick="this.closest('dialog').close()">Fatto</button></div>`;
  // in automatico le barre mostrano il guadagno applicato in quel momento (scivola verso la correzione calcolata)
  const paint = () => {
    const auto = P.eqAuto, live = auto && P.eqOn && Engine.ctx;
    $('#eqPre').value = auto ? 'auto' : ''; d.querySelector('.eq').classList.toggle('auto', auto);
    EQ_FREQS.forEach((_, i) => { const r = $(`[data-b="${i}"]`), v = live ? Engine.eq[i].gain.value : auto ? 0 : P.eq[i]; r.step = auto ? 'any' : 1; r.value = v; r.tabIndex = auto ? -1 : 0; $('#eqv' + i).textContent = fmt(v); });
    const info = $('#eqInfo'); info.hidden = !auto || !!off;
    info.textContent = !P.eqOn ? 'Equalizzatore spento.' : Engine.el.paused ? 'Analizza lo spettro del brano mentre suona e corregge da solo, piano piano. In pausa.'
      : AutoEq.n < 12 ? 'Sto ascoltando il brano…' : 'Correzione su misura per questo brano.';
  };
  paint(); AutoEq.onpaint = paint;
  d.querySelectorAll('[data-b]').forEach(r => r.oninput = () => { if (P.eqAuto) return paint(); P.eq[+r.dataset.b] = +r.value; savePrefs(); Engine.applyEq(); paint(); });
  $('#eqOn').onchange = e => { P.eqOn = e.target.checked; savePrefs(); Engine.applyEq(); paint(); };
  $('#eqPre').onchange = e => {
    const v = e.target.value; P.eqAuto = v === 'auto';
    if (P.eqAuto) AutoEq.reset(); else if (v) P.eq = EQ_PRESETS[v].slice();
    savePrefs(); Engine.applyEq(); paint();
  };
  $('#eqReset').onclick = () => { P.eqAuto = false; P.eq = Array(10).fill(0); savePrefs(); Engine.applyEq(); paint(); };
  d.onclose = () => { d.className = ''; d.onclose = null; AutoEq.onpaint = null; }; d.showModal();
}
function speedDialog() {
  const d = $('#dlg'); d.className = 'sheet';
  d.innerHTML = `<div class="head"><b>Velocità di riproduzione</b></div>${[0.75, 0.9, 1, 1.1, 1.25, 1.5, 2].map(v => `<button class="mi" data-v="${v}">${v === P.speed ? ic('heart', true) : ic('speed')}${String(v).replace('.', ',')}×${v === 1 ? ' (normale)' : ''}</button>`).join('')}`;
  d.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { P.speed = +b.dataset.v; savePrefs(); Engine.decks.forEach(a => a.playbackRate = P.speed); d.close(); if (location.hash.startsWith('#/ora')) vNow(); });
  d.onclose = () => { d.className = ''; d.onclose = null; }; d.showModal();
}

/* ================= azioni (delegazione eventi) ================= */
// selezione multipla: sul computer Ctrl/⌘ + clic e Maiusc + clic sulle righe dei brani; sul telefono «Seleziona» dal menu
// di un brano (tenendolo premuto), poi ogni tocco aggiunge o toglie. Una barra in basso con le azioni del gruppo
const Sel = {
  l: null, set: new Set(), last: null,
  on() { return this.set.size > 0; },
  toggle(lid, i, range) {
    if (this.l !== lid) { this.set.clear(); this.l = lid; this.last = null; }
    if (range && this.last != null) { for (let k = Math.min(this.last, i); k <= Math.max(this.last, i); k++) this.set.add(k); }
    else if (this.set.has(i)) this.set.delete(i); else this.set.add(i);
    this.last = i; this.paint();
  },
  clear() { if (!this.set.size && this.l == null) return; this.set.clear(); this.l = null; this.last = null; this.paint(); },
  tracks() { const L = Lists.get(this.l) || []; return [...this.set].sort((a, b) => a - b).map(i => L[i]).filter(Boolean); },
  paint() {
    $$('.song.sel').forEach(r => r.classList.remove('sel'));
    if (this.l != null) this.set.forEach(i => view.querySelector(`.songs[data-l="${this.l}"] .song[data-i="${i}"]`)?.classList.add('sel'));
    let bar = $('#selBar');
    if (!this.on()) { bar?.remove(); return; }
    if (!bar) { bar = document.createElement('div'); bar.id = 'selBar'; bar.className = 'selbar'; bar.setAttribute('role', 'toolbar'); document.body.append(bar); }
    const n = this.set.size;
    bar.innerHTML = `<b>${n} ${n === 1 ? 'brano' : 'brani'}</b><span class="grow"></span>
      <button class="icon-btn" data-s="play" aria-label="Riproduci" title="Riproduci">${ic('play', true)}</button>
      <button class="icon-btn" data-s="next" aria-label="Riproduci dopo" title="Riproduci dopo">${ic('nextup')}</button>
      <button class="icon-btn" data-s="queue" aria-label="Aggiungi alla coda" title="Aggiungi alla coda">${ic('plus')}</button>
      ${can('playlist') ? `<button class="icon-btn" data-s="pl" aria-label="Aggiungi a una playlist" title="Aggiungi a una playlist">${ic('addlist')}</button>` : ''}
      ${srv()?.local ? '' : `<button class="icon-btn" data-s="off" aria-label="Salva per l'offline" title="Salva per l'offline">${ic('offline')}</button>`}
      <button class="icon-btn" data-s="x" aria-label="Annulla la selezione" title="Annulla">${ic('close')}</button>`;
    bar.onclick = e => {
      const b = e.target.closest('[data-s]'); if (!b) return; const t = this.tracks();
      ({ play: () => setQueue(t, 0), next: () => Q.add(t, true), queue: () => Q.add(t), pl: () => addToPlaylistDialog(t), off: () => Offline.save(t), x: () => {} })[b.dataset.s]();
      this.clear();
    };
  }
};
view.addEventListener('click', e => {
  const row = e.target.closest('.song[data-i]'); if (!row || !view.contains(row)) return;
  const btn = e.target.closest('button, a, [data-act]'); if (btn && btn !== row) return;  // cuore, ⋯, link: le loro azioni
  if (!(e.ctrlKey || e.metaKey || e.shiftKey || Sel.on())) return;
  const lst = row.closest('.songs[data-l]'); if (!lst) return;
  e.stopPropagation(); e.preventDefault();
  Sel.toggle(+lst.dataset.l, +row.dataset.i, e.shiftKey);
}, true);
Bus.addEventListener('route', () => Sel.clear());
document.addEventListener('keydown', e => { if (e.key === 'Escape' && Sel.on()) { Sel.clear(); e.stopPropagation(); } }, true);
view.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el || !view.contains(el)) return;
  const act = el.dataset.act, i = +el.dataset.i, id = el.dataset.id;
  const lst = el.closest('.songs[data-l]') || view.querySelector('#lList .songs[data-l]') || view.querySelector('.songs[data-l]');
  const list = (lst && Lists.get(+lst.dataset.l)) || S.lastList;
  e.stopPropagation();
  if (el.classList.contains('hmix')) Object.assign(MixPage, { want: true, at: Date.now(), name: el.querySelector('.hmix-t b')?.textContent || 'Mix', sub: el.querySelector('.hmix-t small')?.textContent || '', hue: el.style.getPropertyValue('--h1') });
  try {
    switch (act) {
      case 'album': location.hash = '#/album/' + encodeURIComponent(id); break;
      case 'playalb': { const r = (await api('getAlbum', { id })).album; setQueue(arr(r.song).map(x => norm(x)), 0); break; }
      case 'showall': sessionStorage.setItem('armony:asort', { newest: 'newest', frequent: 'frequent', random: 'random', starred: 'starred' }[el.dataset.sort] || 'newest'); location.hash = '#/libreria/album'; break;
      case 'lmore': lMore(); break;
      case 'goback': goBack(); break;
      case 'bio': {
        const d = $('#dlg2'); d.className = 'bio';
        d.innerHTML = `<h3>${esc(S.bio?.name || '')}</h3><p class="biotxt">${esc(S.bio?.text || '')}</p><div class="row"><button class="btn" onclick="this.closest('dialog').close()">Chiudi</button></div>`;
        d.onclose = () => { d.className = ''; d.onclose = null; }; closeOutside(d); d.showModal(); break;
      }
      case 'qremote': if (Live.remote()) Live.cmd('skipto', i); break;
      case 'artist': location.hash = '#/artista/' + encodeURIComponent(id); break;
      case 'dzartist': location.hash = '#/artista-dz/' + encodeURIComponent(id); break;
      case 'dzalbum': location.hash = '#/album-dz/' + encodeURIComponent(id); break;
      case 'openpl': location.hash = '#/playlist/' + encodeURIComponent(id); break;
      case 'playalbum': { const sid = el.dataset.sid || S.active, a = (await api('getAlbum', { id }, srv(sid))).album; setQueue(arr(a.song).map(x => norm(x, sid)), 0); break; }
      case 'play': setQueue(list, i); break;
      case 'play1': setQueue([list[i]], 0); break;
      case 'qplay': playIndex(i); break;
      case 'qplayoff': playIndex(S.index + 1 + i); break;
      case 'playall': setQueue(list, 0, S.shuffle); break;
      case 'shuffleall': setQueue(list, 0, true); break;
      case 'enqueueall': Q.add(list); if (Jam.role !== 'guest') flyToQueue(el); break;
      case 'offlineall': Offline.save(list); break;
      case 'offpin': { const name = id === 'preferiti' ? 'Preferiti' : JSON.parse(view.dataset.plMeta || '{}').name || 'Playlist'; await OffPin.toggle(id, name, list); el.outerHTML = pinBtn(id); break; }
      case 'addalltopl': addToPlaylistDialog(list); break;
      case 'enqueue': Q.add([list[i]]); if (Jam.role !== 'guest') flyToQueue(el); break;
      case 'more': songMenu(list[i], { pl: view.dataset.pl ? (list[i]._pi ?? i) : null }); break;
      case 'star': {
        const t = list[i]; await api(t.starred ? 'unstar' : 'star', { id: t.id }, srv(t.serverId));
        t.starred = !t.starred; el.classList.toggle('on', t.starred); el.innerHTML = ic('heart', t.starred); if (t.starred) beat(el.firstChild); break;
      }
      case 'staralbum': await api(el.dataset.on === '1' ? 'unstar' : 'star', { albumId: id }); route(); break;
      case 'shareitem': shareItem(id, el.dataset.name); break;
      case 'sv': e.preventDefault(); sessionStorage.setItem('armony:sv', el.dataset.k); vStats(); break;
      case 'spall': sessionStorage.setItem('armony:sp', 'all'); vStats(); break;
      case 'mixplay': S.ctx = { kind: 'Mix', name: MixPage.name }; store.set('qctx', S.ctx); S.queue = MixPage.tracks.slice(); playIndex(0); break;
      case 'mixshuf': S.ctx = { kind: 'Mix', name: MixPage.name }; store.set('qctx', S.ctx); S.queue = shuffleArr(MixPage.tracks); playIndex(0); break;
      case 'mixsave': { const name = await ask('Salva il mix come playlist', MixPage.name, 'Nome'); if (name) { await api('createPlaylist', { name, songId: MixPage.tracks.map(x => x.id) }); toast(`Playlist «${name}» creata.`); emitSoon('playlists'); } break; }
      case 'radio': { const r = await api('getRandomSongs', { size: 80 }); setQueue(arr(r.randomSongs.song).map(x => norm(x)), 0); break; }
      case 'mixfav': { const r = (await api('getStarred2')).starred2; const so = arr(r.song).map(x => norm(x)); if (!so.length) return toast('Non hai ancora brani preferiti.'); setQueue(so, 0, true); break; }
      case 'mixforgot': {
        const recent = new Set((await Stats.since(60)).map(x => x.key));
        const al = arr((await api('getAlbumList2', { type: 'frequent', size: 40, offset: 10 })).albumList2.album).concat(arr((await api('getAlbumList2', { type: 'random', size: 20 })).albumList2.album));
        const songs = (await Promise.all(shuffleArr(al).slice(0, 15).map(a => api('getAlbum', { id: a.id }).catch(() => null)))).flatMap(r => shuffleArr(arr(r?.album?.song)).slice(0, 3)).map(x => norm(x)).filter(t => !recent.has(key(t)));
        setQueue(songs, 0, true); toast('Brani che non senti da almeno due mesi.'); break;
      }
      case 'decademix': {
        const y = +el.dataset.y; const al = shuffleArr(arr((await api('getAlbumList2', { type: 'byYear', fromYear: y, toYear: y + 9, size: 100 })).albumList2.album)).slice(0, 20);
        const songs = (await Promise.all(al.map(a => api('getAlbum', { id: a.id }).catch(() => null)))).flatMap(r => shuffleArr(arr(r?.album?.song)).slice(0, 3)).map(x => norm(x));
        setQueue(songs, 0, true); break;
      }
      case 'artistall': {
        const a = (await api('getArtist', { id })).artist;
        const albums = await Promise.all(arr(a.album).map(al => api('getAlbum', { id: al.id })));
        setQueue(albums.flatMap(r => arr(r.album.song).map(x => norm(x))), 0, S.shuffle); break;
      }
      case 'artistradio': setQueue((await artistRadio(id)).map(x => norm(x)), 0, true); break;
      case 'dailymix': {
        // brani dell'artista e dei simili, mescolati con un seme del giorno: oggi lo stesso mix, domani un altro
        // fonti, finché non bastano: simili di Navidrome (se ha Last.fm), brani dell'artista, artisti simili secondo Deezer
        // che sono in libreria, lo stesso genere
        let seed = [...new Date().toDateString() + id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
        const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32, mixup = a => { a = a.slice(); for (let k = a.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [a[k], a[j]] = [a[j], a[k]]; } return a; };
        const seen = new Set(), all = [], add = (l, max = 99) => { for (const x of mixup(l)) { if (max <= 0) break; if (x?.id && !seen.has(x.id)) { seen.add(x.id); all.push(norm(x)); max--; } } };
        add(arr((await api('getSimilarSongs2', { id, count: 60 }).catch(() => null))?.similarSongs2?.song), 40);
        const songsOf = async (aid, albums = 3) => (await Promise.all(shuffleArr(arr((await api('getArtist', { id: aid }).catch(() => null))?.artist?.album)).slice(0, albums).map(al => api('getAlbum', { id: al.id }).catch(() => null)))).flatMap(r => arr(r?.album?.song));
        const own = await songsOf(id, 8); add(own, 14);
        if (all.length < 40 && discoOk()) {
          const [dz, names] = await Promise.all([dlApi('/api/discografia?artist=' + encodeURIComponent(el.dataset.name)).catch(() => null), libNames()]);
          const sims = (dz?.similar || []).map(x => names.get(cleanTxt(x.name))).filter(x => x && x !== id).slice(0, 6);
          for (const sid of sims) { add(await songsOf(sid), 5); if (all.length >= 50) break; }
        }
        if (all.length < 40) {
          // gli artisti che ascolti nelle stesse sessioni (entro due ore da questo): il gusto vero, anche senza metadati
          // per ore: ogni ascolto guarda solo le ore vicine invece di tutti gli ascolti dell'artista
          const h = await Stats.all(), hours = new Set(h.filter(x => x.artistId === id).map(x => Math.floor(x.ts / 3600e3))), co = new Map();
          h.forEach(x => { const k = Math.floor(x.ts / 3600e3); if (x.artistId && x.artistId !== id && (hours.has(k) || hours.has(k - 1) || hours.has(k + 1))) co.set(x.artistId, (co.get(x.artistId) || 0) + 1); });
          for (const [aid] of [...co].sort((p, q) => q[1] - p[1]).slice(0, 6)) { add(await songsOf(aid), 5); if (all.length >= 50) break; }
        }
        const genre = own.map(x => x.genre).find(Boolean);
        if (all.length < 30 && genre) add(arr((await api('getSongsByGenre', { genre, count: 60 }).catch(() => null))?.songsByGenre?.song), 50 - all.length);
        if (all.length < 5) return toast('Non trovo abbastanza brani per questo mix.');
        const q = mixup(all).slice(0, 50);
        setQueue(q, 0); toast(`Mix di ${el.dataset.name}: ${q.length} brani.`); break;
      }
      case 'rnew': Radio.create(); break;
      case 'tabsedit': tabsEditor(); break;
      case 'qup': if (i > 0) { [S.queue[i - 1], S.queue[i]] = [S.queue[i], S.queue[i - 1]]; if (S.index === i) S.index--; else if (S.index === i - 1) S.index++; persistQueue(); vQueue(); } break;
      case 'qdn': if (i < S.queue.length - 1) { [S.queue[i + 1], S.queue[i]] = [S.queue[i], S.queue[i + 1]]; if (S.index === i) S.index++; else if (S.index === i + 1) S.index--; persistQueue(); vQueue(); } break;
      case 'qrm':
        S.queue.splice(i, 1);
        if (i < S.index) S.index--;
        else if (i === S.index) {  // si toglie quello che suona: parte il successivo (come Spotify), non il silenzio
          const go = isPlaying(); Engine.stop(); S.index = Math.min(S.index, S.queue.length - 1);
          if (go && S.queue[S.index]) playIndex(S.index); else updateNowPlaying();
        }
        persistQueue(); vQueue(); emit('queue'); break;
      case 'clearqueue': if (confirm('Svuotare la coda?')) { S.queue = []; S.index = -1; Engine.stop(); persistQueue(); updateNowPlaying(); vQueue(); emit('queue'); } break;
      case 'dedupe': { const seen = new Set(), cur = S.queue[S.index]; S.queue = S.queue.filter(t => !seen.has(key(t)) && seen.add(key(t))); S.index = cur ? S.queue.findIndex(t => key(t) === key(cur)) : -1; persistQueue(); vQueue(); emit('queue'); break; }
      case 'savequeue': {
        if (!S.queue.length) return toast('La coda è vuota.');
        const name = await ask('Salva la coda come playlist', 'Coda del ' + new Date().toLocaleDateString('it-IT'), 'Nome'); if (!name) return;
        const by = {}; S.queue.forEach(t => (by[t.serverId] ||= []).push(t.id));
        for (const [sid, ids] of Object.entries(by)) await createPlaylist(name, ids, sid);
        toast(Object.keys(by).length > 1 ? 'Salvata: una playlist per ogni server.' : `Playlist "${name}" salvata.`); break;
      }
      case 'exportqueue': exportTracks('Coda', S.queue); break;
      case 'newpl': { const name = await ask('Nuova playlist', '', 'Nome'); if (name) { await api('createPlaylist', { name }); route(); } break; }
      case 'importpl': importPlaylist(); break;
      case 'libplus': libPlus(); break;
      case 'reorderpl': reorderPl(id); break;
      case 'collabpl': Amici.collabSheet(id); break;
      case 'sendpl': Amici.manda({ kind: 'playlist', id, title: el.dataset.name || '' }); break;
      case 'sendalb': Amici.manda({ kind: 'album', id, title: el.dataset.name || '', sub: el.dataset.sub || '' }); break;
      case 'exportpl': { const p = (await api('getPlaylist', { id })).playlist; exportTracks(p.name, arr(p.entry).map(x => norm(x))); break; }
      case 'editpl': {
        const m = JSON.parse(view.dataset.plMeta || '{}'); const d = $('#dlg2');
        d.innerHTML = `<h3>Modifica playlist</h3><div class="stack"><label class="f">Nome<input type="text" id="eName" value="${esc(m.name)}"></label>
          <label class="f">Descrizione<textarea id="eCom">${esc(m.comment)}</textarea></label>
          <label class="check"><input type="checkbox" id="ePub" ${m.public ? 'checked' : ''}><span>Condivisa con tutti gli utenti del server<small>Gli amici la vedono tra le loro playlist.</small></span></label>
          <div class="row"><button class="btn primary" id="eSave">Salva</button><button class="btn" onclick="this.closest('dialog').close()">Annulla</button></div></div>`;
        $('#eSave').onclick = async () => { await api('updatePlaylist', { playlistId: id, name: $('#eName').value.trim() || m.name, comment: $('#eCom').value, public: $('#ePub').checked }); d.close(); route(); };
        d.showModal(); break;
      }
      case 'dedupepl': {
        // la playlist si riscrive con i brani che esistono, ognuno una volta: spariscono anche le voci di file non più in libreria
        const p = (await api('getPlaylist', { id })).playlist, all = arr(p?.entry), seen = new Set(), keep = all.filter(x => !seen.has(x.id) && seen.add(x.id));
        const dead = Math.max(0, (p?.songCount || 0) - all.length), dup = all.length - keep.length;
        if (!dup && !dead) { toast('Nessun doppione in questa playlist.'); break; }
        if (!confirm(`Togliere ${dup} doppioni${dead ? ` e ${dead} voci di brani non più in libreria` : ''}? Restano ${keep.length} brani, nello stesso ordine.`)) break;
        const ids = keep.map(x => x.id);
        await api('createPlaylist', { playlistId: id, songId: ids.slice(0, 200) }, srv(), true);
        if (ids.length > 200) await addSongsToPlaylist(id, ids.slice(200), S.active);
        toast(`Fatto: ${keep.length} brani.`); emit('playlists'); route(); break;
      }
      case 'offerpl': {  // consenso del proprietario: una playlist pubblica va ai server collegati solo se la offre
        const on = (await srvApi(srv(), '/api/rete/offerte')).includes(id);
        if (!confirm(on ? 'Questa playlist è offerta ai server collegati: i loro utenti possono vederla e abbonarsi. Smettere di offrirla?'
          : 'Offrire questa playlist ai server collegati? I loro utenti potranno vederla e abbonarsi (senza il tuo nome utente).')) break;
        await srvApi(srv(), '/api/rete/offerta', { method: 'POST', body: JSON.stringify({ pid: id, on: !on }) });
        toast(on ? 'Non più offerta ai server collegati.' : 'Offerta ai server collegati.'); break;
      }
      case 'dirpl': { const r = $('[data-act="lmore"]')?.getBoundingClientRect(); PlDir.pick(id, r ? [r.left, r.bottom + 4] : [innerWidth / 2, innerHeight / 3]); break; }  // dal menu ⋯: vicino al suo tasto
      case 'delpl': if (confirm('Eliminare questa playlist? I brani restano in libreria.')) { await api('deletePlaylist', { id }); location.hash = '#/playlist'; } break;
      case 'upforce': { const u = Up.list[+el.dataset.i]; if (u) { u.force = true; u.status = 'in coda'; upRun(); } break; }
      case 'upclear': Up.list = Up.list.filter(u => ['in coda', 'in corso'].includes(u.status)); upRender(); break;
      case 'clearjobs': await dlApi('/api/jobs', { method: 'DELETE' }); refreshJobs(); break;
      case 'playvideo': location.hash = vHash(el.dataset.path); break;  // la sezione Video (video.js)
      case 'delvideo': if (confirm('Eliminare questo video dal server?')) { await dlApi('/api/videos/' + el.dataset.path.split('/').map(encodeURIComponent).join('/'), { method: 'DELETE' }); refreshVideos(); } break;
      case 'cacheclear': await ACache.clear(); $('#cacheUse').textContent = bytes(0) + ' usati'; toast('Cache dei brani svuotata.'); refreshSpazio(); break;
      case 'offclear': if (confirm('Eliminare tutti i brani salvati per l\'offline?')) { await DB.clear('offline'); Offline.keys.clear(); route(); } break;
      case 'histexport': { const h = await Stats.all(); saveFile('armony-storico.csv', 'Data,Titolo,Artista,Album,Durata (s)\n' + h.map(x => [new Date(x.ts).toISOString(), x.title, x.artist, x.album, x.duration].map(csvCell).join(',')).join('\n'), 'text/csv'); break; }
      case 'histclear': {
        if (!confirm('Cancellare tutto lo storico di ascolto da questo dispositivo?')) break;
        await DB.clear('history');
        const remote = S.servers.filter(syncable);
        if (remote.length && confirm('Cancellarlo anche dal server, cioè da tutti i tuoi dispositivi?')) for (const s of remote) { await srvApi(s, '/api/history', { method: 'DELETE' }).catch(() => {}); store.set('histSeq:' + s.id, 0); }
        route(); break;
      }
      case 'wrapped': makeWrapped(); break;
      case 'nowmore': songMenu(currentTrack()); break;
      case 'nowtools': nowTools(); break;
      case 'lyropen': location.hash = '#/testo'; break;
      case 'lyrclose': navStack.at(-2) ? history.back() : (location.hash = '#/ora'); break;
      case 'npclose': Scene.back ? history.back() : (location.hash = '#/home'); break;
      case 'sleep': sleepDialog(); break;
      case 'speed': speedDialog(); break;
      case 'eq': eqDialog(); break;
      case 'phone': await Local.act(el.dataset.do); break;
      case 'addsrv': serverDialog(null, { url: el.dataset.url || '', name: el.dataset.name || '' }); break;
      case 'editsrv': serverDialog(srv(id)); break;
      case 'usesrv': S.active = id; persistServers(); vSettings(); Live.connect(); break;
      case 'delsrv': if (confirm('Rimuovere questo server da Armony?')) { S.servers = S.servers.filter(s => s.id !== id); if (S.active === id) S.active = S.servers[0]?.id || (Local.on() ? Local.id : null); persistServers(); vSettings(); } break;
      case 'lanscan': {
        $('#lanRes').innerHTML = '<p class="sub">Cerco server Armony sulla rete…</p>';
        const base = S.dl.url || (NATIVE ? '' : location.origin);
        const r = await fetch(base + '/api/lan/servers').then(r => r.json()).catch(() => null);
        const list = r ? [{ name: r.self.name, url: base }, ...r.peers] : [];
        $('#lanRes').innerHTML = list.length ? list.map(s => `<div class="list-item" style="cursor:default"><span class="grow"><b>${esc(s.name)}</b><small>${esc(s.url)}</small></span>
          ${S.servers.some(x => absUrl(x.url) === absUrl(s.url)) ? '<span class="tag ok">già aggiunto</span>' : `<button class="btn sm" data-act="addsrv" data-url="${esc(s.url)}" data-name="${esc(s.name)}">Aggiungi</button>`}</div>`).join('')
          + (r && !r.self.multicast ? '<p class="small" style="color:var(--muted)">Il multicast è spento su questo server: vedrai solo lui.</p>' : '')
          : '<div class="empty">Nessun server Armony raggiungibile. Aggiungi prima un server Armony.</div>';
        break;
      }
      case 'updcheck': await refreshUpdate(true); break;
      case 'updrun': if (confirm('Aggiornare il server? Armony si riavvia e per un minuto non risponde.')) { await dlApi('/api/update', { method: 'POST' }); toast('Aggiornamento richiesto.'); refreshUpdate(); } break;
      case 'editalbum': editAlbum(); break;
      case 'delalbum': if (await deleteTracks(S.lastList.slice(), el.dataset.name)) location.hash = '#/libreria/album'; break;
      case 'regcred': {
        const u = $('#regU').value.trim(), p = $('#regP').value; if (!u || !p) { toast('Inserisci utente e password dell\'amministratore di Navidrome.'); break; }
        try { await dlApi('/api/register/settings', { method: 'PUT', body: JSON.stringify({ user: u, password: p }) }); toast('Registrazione pronta: ora puoi creare inviti.'); } catch (e) { toast(e.message); }
        refreshReg(); break;
      }
      case 'reginv': { const r = await dlApi('/api/register/invites', { method: 'POST' }); refreshReg(); inviteSheet(r.code); break; }
      case 'regshow': inviteSheet(el.dataset.code); break;
      case 'regrevoke': if (confirm(`Revocare l'invito ${fmtCode(el.dataset.code)}?`)) { await dlApi('/api/register/invites/' + encodeURIComponent(el.dataset.code), { method: 'DELETE' }); refreshReg(); } break;
      case 'fedinv': { const r = await dlApi('/api/fed/invites', { method: 'POST', body: JSON.stringify({ url: fedBase() }) }); fedInviteSheet(r.code); refreshFed(); break; }
      case 'fedjoin': fedJoinSheet(); break;
      case 'fedok': if (confirm(`Collegare ${el.dataset.name}?

Codice di sicurezza: ${el.dataset.safety}
Deve essere uguale a quello che vede l'altro amministratore.`)) { await dlApi(`/api/fed/nodes/${el.dataset.id}/accept`, { method: 'POST' }); toast('Collegato: la sua libreria arriva fra pochi secondi.'); setTimeout(refreshFed, 2500); refreshFed(); } break;
      case 'fedsync': await dlApi(`/api/fed/nodes/${el.dataset.id}/refresh`, { method: 'POST' }); refreshFed(); toast('Aggiornato.'); break;
      case 'fedrm': if (confirm(`Scollegare ${el.dataset.name}? Non vedrete più le vostre librerie; i brani già copiati restano.`)) { await dlApi(`/api/fed/nodes/${el.dataset.id}`, { method: 'DELETE' }); refreshFed(); } break;
      case 'usrrevoke': if (confirm(`${Disp.ok(srv()) ? `Revocare tutti i dispositivi di ${el.dataset.user}? Smettono subito di funzionare e per rientrare servirà un'approvazione.` : `Disconnettere ${el.dataset.user} da tutti i dispositivi? Dovrà rifare l'accesso.`}`)) { await dlApi(`/api/users/${encodeURIComponent(el.dataset.user)}/sessions`, { method: 'DELETE' }); refreshUsers(); } break;
      case 'resetapp': resetApp(); break;
      case 'scanqr': useScan(await scanQR()); break;
      case 'exportset': {
        // per un amico: niente credenziali né nome utente (entrerebbe col tuo account), niente nome e nick tuoi; per un tuo
        // dispositivo: le credenziali (token + sale, mai la password né la sessione, che è di questo dispositivo)
        const mine = confirm('Per chi è il file?\n\nOK = per un mio dispositivo (con le credenziali: conservalo al sicuro)\nAnnulla = per un amico (senza il tuo account: lui entrerà col suo)');
        const strip = ({ session, me, armony, tok, salt, dev, tk, pending, revoked, grant, user, ...rest }) => mine ? { ...rest, user, tok, salt } : rest;
        const prefs = { ...P, turn: { ...P.turn, pass: mine ? P.turn.pass : '' } }; if (!mine) { prefs.nick = ''; prefs.deviceName = ''; }
        saveFile(mine ? 'armony-impostazioni.json' : 'armony-per-un-amico.json', JSON.stringify({ app: 'armony', version: 3, prefs, servers: S.servers.map(strip) }, null, 2), 'application/json');
        break;
      }
      case 'importset': {
        const f = await pickFile('.json'); if (!f) return;
        const j = JSON.parse(await f.text());
        if (!['armony', 'cerchia'].includes(j.app)) return toast('Questo file non contiene impostazioni di Armony.');
        for (const s of migrateCreds(arr(j.servers))) {
          delete s.session; delete s.me; delete s.armony; delete s.dev; delete s.tk; delete s.pending; delete s.revoked;
          const ex = S.servers.find(x => absUrl(x.url) === absUrl(s.url) && x.user === s.user);
          if (ex) Object.assign(ex, { ...s, id: ex.id, tok: s.tok || ex.tok, salt: s.tok ? s.salt : ex.salt }); else S.servers.push({ ...s, id: uid(8) });
        }
        if (!S.active) S.active = S.servers[0]?.id;
        if (j.downloader?.token && !S.dl.token) store.set('downloader', j.downloader);  // file di Armony 0.2
        syncSessions();
        if (j.prefs) {
          const nick = P.nick, mine = Object.fromEntries(DEVICE_PREFS.map(k => [k, P[k]]));  // nome, volume, sganciato… restano di questo dispositivo
          Object.assign(P, j.prefs, mine, { nick: nick || j.prefs.nick }); savePrefs();
        }
        else if (j.quality && QUALITIES[j.quality]) { P.quality = j.quality; savePrefs(); }
        persistServers(); route();
        toast(S.servers.some(s => !s.tok) ? 'Importato. Inserisci le password mancanti con Modifica.' : 'Impostazioni importate.');
        break;
      }
      default: if (typeof Jam.action === 'function') await Jam.action(act, el);
    }
  } catch (err) { console.error(err); toast(err.message); }
  finally { MixPage.want = false; }  // un mix che non ha trovato brani non cattura la riproduzione dopo
});

/* ================= app Android: notifica, cuffie, tasto indietro, aggiornamenti dell'APK =================
   Il plugin ArmonyMedia sta in app/android (ArmonyMediaPlugin.java): la musica la suona sempre questa pagina,
   il plugin tiene viva l'app e porta i comandi del sistema qui. Tutto è spento fuori dall'app. */
const NativeMedia = {
  p: null, sent: null,
  init() {
    this.p = NATIVE ? window.Capacitor?.Plugins?.ArmonyMedia : null; if (!this.p) return;
    this.p.addListener('action', e => {
      if (e.action === 'play' && !isPlaying() || e.action === 'pause' && isPlaying()) ctlToggle();
      else if (e.action === 'next') ctlNext(false);
      else if (e.action === 'previous') ctlPrev();
      else if (e.action === 'seek') ctlSeek(e.position);
    });
  },
  // manda lo stato solo se cambia qualcosa che la notifica non può dedurre da sola (brano, play/pausa, salti)
  sync() {
    if (!this.p) return;
    // telecomando: la notifica mostra il dispositivo che suona (come Spotify Connect). Così l'app resta viva in
    // sottofondo con il servizio in primo piano, il canale dal vivo resta aperto e i comandi della notifica
    // (che passano da ctlToggle/ctlNext/ctlSeek) arrivano all'altro dispositivo
    const remote = Live.remote(), t = currentTrack();
    if (!t) { if (this.sent) { this.p.stop(); this.sent = null; } return; }
    const where = remote ? `Su ${Live.devices.get(Live.target) || 'un altro dispositivo'}` : '';
    const now = { title: t.title, artist: t.artist, album: [where, t.album].filter(Boolean).join(' · '), playing: isPlaying(), position: playPos(), duration: playDur(), rate: remote ? (Live.st()?.rate || 1) : P.speed,
      artwork: t.coverArt && srv(t.serverId) ? coverUrl(t.coverArt, 512, t.serverId) : '' };
    if (!this.sent && !now.playing) return;  // servizio e permesso delle notifiche solo dal primo play
    const s = this.sent, expected = s ? s.position + (s.playing ? (Date.now() - s.at) / 1000 * s.rate : 0) : 0;
    if (s && s.title === now.title && s.artist === now.artist && s.album === now.album && s.playing === now.playing && s.duration === now.duration && s.rate === now.rate && Math.abs(expected - now.position) < 2) return;
    this.sent = { ...now, at: Date.now() };
    this.p.update(now).catch(() => {});
  }
};
const AppUpdate = {
  // l'APK arriva dalle release GitHub, allegato dalla Action a ogni tag (.github/workflows/android.yml) insieme
  // al suo .sha256; lo scarica, lo verifica e lo passa all'installatore di Android il plugin ArmonyUpdate
  // (app/android). Android chiede sempre conferma: fuori dal Play Store non c'è installazione silenziosa.
  p: null, last: 0, later: null, pending: null, u: null, busy: false,
  init() {
    if (!window.ARMONY_APP) return;
    this.p = window.Capacitor?.Plugins?.ArmonyUpdate || null;
    this.p?.addListener('progress', e => this.state('scarico', e));
    this.p?.addListener('status', e => this.state('errore', { msg: e.status === 'annullato' ? 'Installazione annullata.' : 'Android non ha installato l\'aggiornamento' + (e.message ? `: ${e.message}` : '.') }));
    window.Capacitor?.Plugins?.App?.addListener('resume', () => this.pending ? this.retry() : this.auto());
    setTimeout(() => this.auto(), 8000);
  },
  async check() {
    const a = window.ARMONY_APP; if (!a?.repo) return null;
    try {
      const r = await fetch(`https://api.github.com/repos/${a.repo}/releases/latest`);
      if (r.status === 404) return { current: a.version, latest: null, available: false };  // nessun APK pubblicato
      if (!r.ok) return null;
      const j = await r.json(), apk = arr(j.assets).find(x => /\.apk$/.test(x.name));
      const sha = apk && arr(j.assets).find(x => x.name === apk.name + '.sha256');
      const v = s => (String(s).match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
      const [n, c] = [v(j.tag_name), v(a.version)];
      const newer = n.length === 3 && c.length === 3 && (n[0] - c[0] || n[1] - c[1] || n[2] - c[2]) > 0;
      return { current: a.version, latest: j.tag_name, url: apk?.browser_download_url, shaUrl: sha?.browser_download_url, notes: this.notes(j.body), available: newer && !!apk };
    } catch { return null; }
  },
  // le note generate da GitHub, ridotte a poche righe leggibili: senza titoli, autori e link
  notes(body) {
    return String(body || '').split('\n').map(l => l.trim()).filter(l => /^[-*] /.test(l))
      .map(l => l.replace(/^[-*] /, '').replace(/ by @\S+ in \S+$/, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')).slice(0, 5);
  },
  // al massimo un controllo ogni 6 ore; "Più tardi" vale per quella versione fino al prossimo avvio
  async auto() {
    if (Date.now() - this.last < 6 * 3600e3 || $('dialog[open]')) return;
    this.last = Date.now();
    const u = await this.check();
    if (u?.available && this.later !== u.latest) this.offer(u);
  },
  offer(u, start) {
    this.u = u;
    const d = $('#dlg'); d.className = 'sheet';
    d.innerHTML = `<div class="head"><b>Armony ${esc(u.latest.replace(/^v/, ''))} è disponibile</b></div><div id="aupd" class="stack"></div>`;
    closeOutside(d);
    const base = d.onclose; d.onclose = () => { if (!this.pending && !this.busy) this.later = u.latest; base(); };
    // contenuto prima di aprire: il focus va al primo tasto, non al foglio intero
    if (start) this.run(); else this.state('offerta');
    d.showModal();
  },
  state(kind, x = {}) {
    const box = $('#aupd'); if (!box) return;
    const btns = (main, mainLabel) => `<div class="row">${main ? `<button class="btn primary" data-up="${main}">${mainLabel}</button>` : ''}<button class="btn" data-up="dopo">Più tardi</button></div>`;
    const u = this.u || {};
    box.innerHTML = {
      offerta: `${u.notes?.length ? `<ul class="notes">${u.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '<p class="sub">Correzioni e miglioramenti.</p>'}
        <p class="small" style="color:var(--muted);margin:0">Versione installata ${esc(u.current || '')}. L'aggiornamento si installa sopra, senza perdere niente.</p>${btns('vai', 'Aggiorna ora')}`,
      scarico: `<p style="margin:0">Scarico l'aggiornamento${x.total > 0 ? ` · ${Math.round(x.received / x.total * 100)}%` : '…'}</p>
        <div class="bar"><i style="width:${x.total > 0 ? Math.round(x.received / x.total * 100) : 4}%"></i></div>`,
      permesso: `<p style="margin:0">Consenti ad Armony di installare app, poi torna qui: l'aggiornamento riparte da solo.</p>
        <p class="small" style="color:var(--muted);margin:0">Android lo chiede una volta sola, nella schermata che si è appena aperta.</p>${btns('vai', 'Apri di nuovo le impostazioni')}`,
      conferma: '<p style="margin:0">Conferma l\'installazione nella finestra di Android. Armony si riapre aggiornata.</p>',
      errore: `<p style="margin:0;color:var(--danger)">${esc(x.msg || 'Aggiornamento non riuscito.')}</p>${btns('vai', 'Riprova')}`
    }[kind];
    box.querySelector('[data-up=vai]')?.addEventListener('click', () => this.run());
    box.querySelector('[data-up=dopo]')?.addEventListener('click', () => $('#dlg').close());
  },
  async run() {
    const u = this.u; if (!u || this.busy) return;
    if (!this.p) { location.href = u.url; return; }  // senza il plugin: il link al file, come prima
    this.busy = true; this.state('scarico');
    try {
      // l'impronta pubblicata con la release: senza, non si installa niente. La legge il plugin, perché il
      // redirect di GitHub verso i file delle release non ha CORS e dalla pagina il fetch verrebbe bloccato
      if (!u.shaUrl) throw new Error('Manca l\'impronta sha256 della release: aggiornamento non installato.');
      const r = await this.p.install({ url: u.url, shaUrl: u.shaUrl });
      if (r.status === 'permesso') { this.pending = u; this.state('permesso'); }
      else { this.pending = null; this.state('conferma'); }
    } catch (e) { this.state('errore', { msg: e.message || String(e) }); }
    finally { this.busy = false; }
  },
  // di ritorno dalle impostazioni di Android: se il permesso ora c'è, si riparte senza chiedere niente
  async retry() {
    const ok = await this.p?.canInstall().then(r => r.allowed).catch(() => false);
    if (!ok) return;
    const u = this.pending; this.pending = null;
    if (!$('#aupd')) this.offer(u, true); else { this.u = u; this.run(); }
  },
  async paint() {
    const box = $('#appBox'); if (!box) return;
    const u = await this.check();
    box.innerHTML = `<p style="margin:0 0 8px">Versione dell'app <b>${esc(window.ARMONY_APP.version)}</b>${u?.latest ? ` · ultima ${esc(u.latest)}` : ''}</p>
      ${!u ? '<p class="sub">Non riesco a controllare gli aggiornamenti adesso.</p>' : !u.latest ? '<p class="sub">Su GitHub non c\'è ancora nessuna versione dell\'app.</p>' : ''}
      <div class="row">${u?.available ? `<button class="btn primary" id="appUpd">Aggiorna ora a ${esc(u.latest.replace(/^v/, ''))}</button>` : u?.latest ? '<span class="tag ok">Aggiornata</span>' : ''}</div>`;
    $('#appUpd')?.addEventListener('click', () => this.offer(u, true));
  }
};
// DNS di riserva dell'app (ArmonyNetPlugin.java): se il DNS del telefono non trova un server, l'app lo cerca con un
// DNS pubblico. Il plugin vuole sapere quali host sono server di Armony: solo quelli passano dal suo proxy
const NetDns = {
  p: undefined, hosts: new Set(), ready: null,
  host(u) { try { const x = new URL(absUrl(u)); return x.protocol === 'https:' ? x.host : ''; } catch { return ''; } },
  sync() {
    S.servers.forEach(s => { const h = this.host(s.url); if (h) this.hosts.add(h); });
    return this.ready = this.p.set({ hosts: [...this.hosts] }).catch(() => {});
  },
  // prima richiesta a un server nuovo (anche dalla finestra di accesso): aspetta che la WebView abbia la regola
  need(u) {
    if (this.p === undefined && (this.p = NATIVE ? window.Capacitor?.Plugins?.ArmonyNet || null : null)) this.sync();
    const h = this.p && this.host(u); if (!h) return;
    if (this.hosts.has(h)) return this.ready;
    this.hosts.add(h); return this.sync();
  },
  async paint() {
    const box = $('#dnsBox'); NetDns.need(''); if (!box || !this.p) return;
    const st = await this.p.get().catch(() => null); if (!st || $('#dnsBox') !== box) return;
    box.innerHTML = `<label class="check"><input type="checkbox" id="dnsOn" ${st.on && st.supported ? 'checked' : ''} ${st.supported ? '' : 'disabled'}><span>Se il DNS del telefono non trova il server, usa un DNS pubblico<small>${st.supported ? 'Utile con il «DNS privato» di Android o i filtri pubblicitari: vale solo per i tuoi server e per gli aggiornamenti da GitHub.' : 'Serve una versione più recente di «Android System WebView»: aggiornala dal Play Store.'}</small></span></label>
      <label class="f" ${st.on && st.supported ? '' : 'hidden'}>DNS pubblico<select id="dnsVia">${[['cloudflare', 'Cloudflare (1.1.1.1)'], ['google', 'Google (8.8.8.8)'], ['quad9', 'Quad9 (9.9.9.9)']].map(([v, l]) => `<option value="${v}" ${st.via === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
    $('#dnsOn').onchange = e => this.p.set({ on: e.target.checked }).then(() => this.paint());
    $('#dnsVia').onchange = e => this.p.set({ via: e.target.value });
  }
};
function nativeBack() {
  const App = window.Capacitor?.Plugins?.App; if (!App) return;
  // indietro chiude prima un foglio aperto; dalla home non chiude l'app (la musica deve continuare): la riduce
  App.addListener('backButton', ({ canGoBack }) => {
    const d = $('dialog[open]'); if (d) return d.close();
    if (canGoBack && !/^#\/(home)?$/.test(location.hash || '#/')) history.back(); else App.minimizeApp();
  });
}

/* ================= telefono: barre di sistema, tastiera, lettore che si fa piccolo, cuffie =================
   Tutto passa da attributi e variabili su <html>; le regole stanno in index.html (sezione del telefono).
   Nell'app gli spazi veri delle barre e della tastiera li misura ArmonyInsets (ArmonyInsetsPlugin.java),
   l'uscita audio la dice ArmonyMedia. Nel browser restano solo tastiera e lettore piccolo. */
const Phone = {
  out: null, nat: null, seen: false, full: 0, fullW: 0, ready: false,
  init() {
    const de = document.documentElement, plug = NATIVE ? window.Capacitor?.Plugins : null;
    const ins = plug?.ArmonyInsets;
    if (ins) {
      const set = e => { if (!e) return; this.nat = e; de.style.setProperty('--nat-sat', (e.top || 0) + 'px'); de.style.setProperty('--nat-sab', (e.bottom || 0) + 'px'); this.viewport(); };
      ins.addListener('insets', set); ins.get().then(set).catch(() => {});
    }
    const am = plug?.ArmonyMedia;
    if (am?.output) {
      am.addListener('output', o => this.output(o)); am.output().then(o => this.output(o)).catch(() => {});
      setTimeout(() => this.ready = true, 3000);  // all'avvio niente avviso: le cuffie erano già lì
    }
    // tastiera: sparisce il lettore (con la barra delle sezioni) finché si scrive
    const touch = matchMedia('(pointer:coarse)');
    addEventListener('focusin', e => { if (touch.matches && this.editable(e.target)) { this.seen = false; this.kb(true); } });
    addEventListener('focusout', () => setTimeout(() => { if (!this.editable(document.activeElement) && !this.nat?.ime) this.kb(false); }, 50));
    addEventListener('resize', () => this.viewport());
    window.visualViewport?.addEventListener('resize', () => this.viewport());
    this.viewport();
    // lettore piccolo: scendendo diventa una riga, salendo o in cima torna intero (le regole valgono solo ≤860 px)
    let y0 = scrollY;
    addEventListener('scroll', () => {
      const y = scrollY, d = y - y0;
      if (y < 40) this.mini(false); else if (d > 12) this.mini(true); else if (d < -12) this.mini(false); else return;
      y0 = y;
    }, { passive: true });
  },
  editable: el => !!el?.matches?.('input:not([type=range],[type=checkbox],[type=radio],[type=file],[type=button],[type=submit]),textarea,[contenteditable=""],[contenteditable=true]'),
  kb(on) { document.documentElement.toggleAttribute('data-kb', on); if (on) this.mini(false); },
  mini(on) { document.documentElement.toggleAttribute('data-mini', on); },
  // tastiera aperta = la pagina si è accorciata mentre si scrive (o l'app dice che c'è); --kb è lo spazio
  // da lasciare in fondo quando la tastiera copre la pagina invece di accorciarla
  viewport() {
    const vv = window.visualViewport, h = Math.min(innerHeight, vv ? vv.height : innerHeight);
    if (innerWidth !== this.fullW) { this.fullW = innerWidth; this.full = 0; }
    this.full = Math.max(this.full, h);
    const over = vv ? Math.max(0, innerHeight - vv.height - vv.offsetTop) : 0;
    document.documentElement.style.setProperty('--kb', Math.max(over, this.nat?.kb || 0) + 'px');
    const open = !!this.nat?.ime || this.full - h > 150 && this.editable(document.activeElement);
    if (open) { this.seen = true; this.kb(true); }
    else if (this.seen) { this.seen = false; this.kb(false); }  // chiusa col tasto indietro, il campo resta a fuoco
  },
  // uscita audio (solo app): { kind: bluetooth | wired | usb | speaker, name }
  output(o) {
    const was = this.out; this.out = o && o.kind !== 'speaker' ? o : null;
    if (this.out && this.ready && (!was || was.name !== this.out.name)) toast(this.out.kind === 'bluetooth' ? `Cuffie collegate: ${this.short()}` : `${this.label()}: la musica esce da lì.`, 2600);
    // cuffie staccate mentre suona qui: pausa, come ogni lettore (non deve partire dall'altoparlante)
    if (was && !this.out && !Engine.el.paused) { ctlToggle(); toast('Cuffie scollegate: musica in pausa.', 2600); }
    Live.pill();
  },
  short() { return this.out?.name || (this.out?.kind === 'usb' ? 'USB' : 'Cuffie'); },
  label() { const o = this.out; return !o ? '' : o.kind === 'bluetooth' ? `Cuffie Bluetooth${o.name ? ': ' + o.name : ''}` : o.kind === 'wired' ? 'Cuffie con filo' : `Audio USB${o.name ? ': ' + o.name : ''}`; }
};

/* ================= dal vivo: un solo dispositivo suona, gli altri sono telecomandi (/api/live) =================
   Tutti i dispositivi dello stesso utente tengono aperto un canale SSE col server. Chi suona pubblica brano,
   play/pausa e posizione; quando un dispositivo comincia a suonare gli altri si fermano e diventano telecomandi:
   il lettore mostra la sua musica e i comandi vanno a lui. "Dove suona" sposta la coda su un altro dispositivo.
   Un dispositivo "per conto suo" (P.solo) è sganciato: non si ferma per gli altri e non li ferma, ma resta
   nell'elenco e gli si può mandare la musica di proposito.
   La Jam (più persone insieme) resta separata: con una Jam aperta questo modulo non interviene. */
const Live = {
  es: null, devices: new Map(), states: new Map(), target: null, sent: null, tick: null, retry: null, dog: null, last: 0, beatAt: 0, fails: 0, want: null,
  name() { return P.deviceName || store.get('devName', null) || (NATIVE ? 'Telefono' : /Android|iPhone|iPad|Mobile/.test(navigator.userAgent) ? 'Telefono (browser)' : 'Computer'); },
  on() { const s = srv(); return P.live !== false && !!s?.session && !!s.me?.caps?.includes('live'); },
  st() { return this.target ? this.states.get(this.target) || null : null; },
  // telecomando: c'è un dispositivo di destinazione collegato e qui non sta suonando niente
  remote() { return !Jam.role && !Radio.st && !!this.target && this.devices.has(this.target) && Engine.el.paused; },
  // i brani degli altri miei dispositivi sono dello stesso server del canale (anche se lo raggiungono con un altro indirizzo)
  loc(w) { return localize(w, srv()?.local ? null : S.active); },
  track() { const s = this.st(); return s?.track ? this.loc(s.track) : null; },
  playing() { return !!this.st()?.playing; },
  pos() { const s = this.st(); if (!s) return 0; const p = (s.position || 0) + (s.playing ? (Date.now() - s.recvAt) / 1000 * (s.rate || 1) : 0); return s.duration ? Math.min(p, s.duration) : p; },
  dur() { return this.st()?.duration || 0; },
  // il server manda ping e riceve battiti (livehb): solo allora il cane da guardia ha senso
  hb() { return !!srv()?.me?.caps?.includes('livehb'); },
  stop() { clearTimeout(this.retry); clearInterval(this.dog); clearInterval(this.pollT); this.es?.close(); this.es = null; this.devices.clear(); this.states.clear(); this.target = null; this.sent = null; this.paint(); },
  connect() {
    const was = this.target; this.stop(); this.want = was;
    if (!this.on()) return Presence.clear();
    const s = srv(), hb = this.hb();
    const es = this.es = new EventSource(`${absUrl(s.url)}/api/live?device=${encodeURIComponent(S.device)}&name=${encodeURIComponent(this.name())}&${authQ(s)}${hb ? '&hb=1' : ''}`);
    this.last = Date.now();
    es.onmessage = e => { if (Date.now() - this.last > 12000) Trace.add('canale dal vivo: segnale'); this.last = Date.now(); try { this.recv(JSON.parse(e.data)); } catch {} };
    es.onopen = () => { Trace.add('canale dal vivo: aperto'); this.fails = 0; this.last = Date.now(); this.sent = null; this.publish(); };
    // EventSource si ricollega da solo dopo un errore di rete; se il server rifiuta (sessione scaduta) chiude:
    // si rifà l'accesso con tok/salt e si riprova, sempre più piano
    es.onerror = () => { Trace.add('canale dal vivo: errore, stato ' + es.readyState); if (es.readyState === EventSource.CLOSED && this.es === es) { clearInterval(this.dog); this.retry = setTimeout(() => this.relogin(), Math.min(60000, 5000 * ++this.fails)); } };
    // cane da guardia: un canale mezzo morto (app uccisa, rete cambiata, schermo spento) resta "aperto" per sempre.
    // Il battito va a tempo, non a giri: in sottofondo i timer possono scattare anche solo una volta al minuto
    if (hb) this.dog = setInterval(() => { if (Date.now() - this.last > 40000) this.connect(); else if (Date.now() - this.beatAt > 25000) this.beat(); }, 10000);
    // finché il canale non regge (si sta riaprendo, o un proxy lo trattiene), stati e comandi si chiedono ogni 5 s
    if (s.me?.caps?.includes('livecmd')) this.pollT = setInterval(() => this.poll(), 5000);
  },
  alive() { return this.es?.readyState === EventSource.OPEN && (!this.hb() || Date.now() - this.last < 20000); },
  async poll() { if (!this.alive() && !document.hidden) await this.resync(true); },
  // un comando arriva una volta sola anche se lo portano sia il canale sia il "hello" sia il controllo periodico;
  // eseguito, si conferma al server, che smette di consegnarlo
  take(m) {
    if (m.id) { if ((this.seen ||= new Set()).has(m.id)) return; this.seen.add(m.id); if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value); }
    this.exec(m);
    if (m.id) srvApi(srv(), '/api/live/ack', { method: 'POST', body: JSON.stringify({ id: m.id }) }).catch(() => {});
  },
  async relogin() { await syncSessions(); this.connect(); },
  // prima di spostare la musica: il canale dev'essere vivo, altrimenti si riapre e si aspetta il "hello" (al più 4 s).
  // È quello che faceva a mano "Risincronizza"
  async ready() {
    if (this.alive() || !this.on()) return;
    const t0 = Date.now(); this.connect();
    while (!(this.helloAt > t0) && Date.now() - t0 < 4000) await new Promise(r => setTimeout(r, 100));
  },
  // dispositivi e stati come li vede il server adesso (capacità "livestato"): dopo un canale caduto in silenzio i
  // messaggi persi non tornano, questo sì. Restituisce lo scarto fra l'orologio del server e il nostro (ms)
  async resync(mine, cmd) {
    const s = srv(); if (!s?.session || !s.me?.caps?.includes('livestato')) return null;
    let r; try { r = await srvApi(s, '/api/live/stato?' + new URLSearchParams({ ...(mine ? { device: S.device } : {}), ...(cmd ? { cmd } : {}) })); } catch { return null; }
    const now = Date.now(), off = r.now * 1000 - now;
    this.devices = new Map(arr(r.devices).filter(d => d.device !== S.device).map(d => [d.device, d.name]));
    this.states = new Map(arr(r.states).filter(x => x.device !== S.device).map(x => [x.device, { ...x, recvAt: now }]));
    if (this.target && !this.devices.has(this.target)) this.target = null;
    this.paint();
    arr(r.cmds).forEach(c => this.take(c));
    return { off, states: this.states, cmd: r.cmd };
  },
  // battito per il server; 404 = non ha più il nostro canale, 401 = sessione scaduta
  beat() {
    this.beatAt = Date.now();
    srvApi(srv(), '/api/live/beat', { method: 'POST', body: JSON.stringify({ device: S.device }) })
      .catch(e => /404/.test(e.message) ? this.connect() : /401/.test(e.message) ? this.relogin() : 0);
  },
  // ritorno in primo piano, rete di nuovo su, app riaperta: se il canale non è sicuramente vivo ci si ricollega subito
  wake(force) {
    if (P.live === false || !srv()?.me?.caps?.includes('live')) return;
    const ok = this.es?.readyState === EventSource.OPEN && (!this.hb() || Date.now() - this.last < 20000);
    if (ok && !force) return this.hb() && this.beat();
    this.es && this.es.readyState !== EventSource.CLOSED ? this.connect() : this.relogin();
  },
  recv(m) {
    const now = Date.now(), before = this.track()?.id;
    if (m.type === 'ping') return;
    if (m.type === 'kicked') return this.stop();  // un'altra scheda di questo dispositivo ha preso il canale
    if (m.type === 'revocato') return Disp.revoke(srv(), true);  // dispositivi.js: fuori subito
    if (m.type === 'rekey') { this.stop(); return Disp.fresh(srv(), true).then(() => this.connect()); }
    if (m.type === 'chiave' || m.type === 'mai') { this.stop(); return toast('Il server ora accetta solo dispositivi con chiave: aggiorna Armony o aprila con HTTPS.', 8000); }
    if (m.type === 'dispositivi') return Disp.changed();
    if (m.type === 'avatar') return Avatar.refresh(m.user);  // un utente ha cambiato la foto profilo
    if (m.type === 'riavvio') return toast('Il server si aggiorna fra poco: la musica può fermarsi per qualche secondo e riparte da sola.', 8000);
    if (m.type === 'presence' || m.type === 'activity') return Presence.recv(m);  // gli altri utenti del server
    if (m.type === 'radio') return Radio.recv(m);  // stazioni e ascoltatori della Jam Radio
    if (m.type === 'notifica') return Notif.recv(m);
    if (m.type === 'credenziali' && m.t && m.s) { const s = srv(); if (s && !s.local) { s.tok = m.t; s.salt = m.s; persistServers(); toast('Password cambiata: questo dispositivo resta collegato.'); } return; }
    if (m.type === 'libreria') { emitSoon('libreria'); if (m.playlists) emitSoon('playlists'); return; }  // brani nuovi, playlist completate dal server
    if (m.type === 'hello') {
      this.helloAt = now; Presence.hello(m); Radio.hello(m);
      this.devices = new Map(arr(m.devices).map(d => [d.device, d.name]));
      this.states = new Map(arr(m.states).map(s => [s.device, { ...s, recvAt: now }]));
      const p = arr(m.states).find(s => s.playing && !s.solo);
      // dopo un riaggancio si torna telecomando di chi suona, o di chi si comandava prima
      if (Engine.el.paused && !Jam.role && !P.solo) this.target = p ? p.device : this.devices.has(this.want) ? this.want : null;
      setTimeout(() => arr(m.cmds).forEach(c => this.take(c)), 0);  // comandi arrivati mentre il canale era chiuso
    } else if (m.type === 'join') {
      // anche dopo un fantasma: è una sessione nuova, lo stato vecchio non vale più
      this.devices.set(m.device, m.name); this.states.delete(m.device);
    } else if (m.type === 'gone') {
      const name = this.devices.get(m.device); (this.gone ||= {})[m.device] = name; this.devices.delete(m.device); this.states.delete(m.device);
      if (this.target === m.device) { this.target = null; toast(`${name || 'Il dispositivo'} si è scollegato.`); }
    } else if (m.type === 'state') {
      const s = { ...m.state, recvAt: now }; this.states.set(s.device, s); this.devices.set(s.device, s.name);
      if (s.solo && this.target === s.device) this.target = null;  // si è sganciato: non è più la nostra uscita
      if (s.playing && !s.solo && !P.solo && !Jam.role) {
        // un solo dispositivo suona: chi comincia ferma gli altri (anche la radio)
        if (Radio.st) { if (Radio.on) toast(`La musica è passata su ${s.name}.`); Radio.leave(true); }
        else if (!Engine.el.paused) { Engine.el.pause(); toast(`La musica è passata su ${s.name}.`); }
        this.target = s.device;
      }
    } else if (m.type === 'cmd') return this.take(m);
    this.paint();
    if (this.remote() && this.track()?.id !== before && location.hash.startsWith('#/ora')) vNow();
    if (this.remote() && this.track()?.id !== before && location.hash.startsWith('#/testo')) vLyrics();
    if (this.remote() && m.type === 'state' && m.state.device === this.target && location.hash.startsWith('#/coda')) vQueue();
  },
  exec(m) {
    const v = m.value;
    if (m.cmd === 'transfer' && v && Array.isArray(v.queue)) {
      this.target = null; this.pill(); S.queue = v.queue.map(w => this.loc(w)).filter(Boolean);
      // casuale e ripeti passano insieme alla musica
      if (typeof v.shuffle === 'boolean') { S.shuffle = v.shuffle; store.set('shuffle', S.shuffle); }
      if (['off', 'all', 'one'].includes(v.repeat)) { S.repeat = v.repeat; store.set('repeat', S.repeat); }
      paintButtons();
      if (S.queue.length) this.play(Math.min(v.index || 0, S.queue.length - 1), v.position || 0);
      return;
    }
    if (m.cmd === 'handoff') { if (v?.to && v.to !== S.device) this.give(v.to); return; }
    if ((m.cmd === 'enqueue' || m.cmd === 'playnext') && Array.isArray(v?.tracks) && !this.remote()) { Q.local(v.tracks.map(w => this.loc(w)).filter(Boolean), m.cmd === 'playnext'); return; }
    if (Radio.st) return ({ play: () => Radio.resume(), pause: () => Radio.pause(), toggle: ctlToggle })[m.cmd]?.();  // radio: solo play e pausa
    if (this.remote() || !S.queue[S.index]) return;  // i comandi valgono solo per chi suona
    ({ play: () => Engine.el.paused && ctlToggle(), pause: () => !Engine.el.paused && ctlToggle(), toggle: ctlToggle,
      next: () => ctlNext(false), prev: ctlPrev, skipto: () => typeof v === 'number' && S.queue[S.index + 1 + v] && playIndex(S.index + 1 + v), seek: () => typeof v === 'number' && ctlSeek(v), shuffle: ctlShuffle, repeat: ctlRepeat })[m.cmd]?.();
  },
  async play(i, pos) {
    persistQueue(); await playIndex(i, { startAt: pos });
    // il browser può bloccare l'audio partito senza un tocco su questa pagina; l'app no
    setTimeout(() => { if (Engine.el.paused && !this.target) toast('Il browser ha bloccato l\'avvio: premi play per ascoltare qui.', 6000); }, 1500);
  },
  pack(q, i, pos) { const from = Math.max(0, i - 50); return { queue: q.slice(from, from + 1000).map(wire), index: i - from, position: pos, shuffle: S.shuffle, repeat: S.repeat }; },
  // la coda di questo dispositivo va a un altro, che riparte dallo stesso punto; qui si diventa telecomando
  async give(to) {
    if (Radio.st) await Radio.leave(true);  // si passa la coda, non la radio
    if (!S.queue[S.index]) return;
    const v = this.pack(S.queue, Math.max(0, S.index), Engine.time());
    Engine.el.pause(); this.publish(); this.target = P.solo ? null : to; this.paint();
    await this.cmd('transfer', v, to);
  },
  async cmd(cmd, value, to = this.target) {
    const s = srv(); if (!s?.session || !to) return;
    // risposta immediata nel lettore; lo stato vero arriva poco dopo dal dispositivo
    const st = this.states.get(to);
    if (st && to === this.target) {
      const p = this.pos(), now = Date.now();
      if (cmd === 'pause' || cmd === 'toggle' && st.playing) Object.assign(st, { position: p, playing: false, recvAt: now });
      else if (cmd === 'play' || cmd === 'toggle') Object.assign(st, { position: p, playing: true, recvAt: now });
      else if (cmd === 'seek') Object.assign(st, { position: value, recvAt: now });
      else if (cmd === 'shuffle') st.shuffle = !st.shuffle;
      else if (cmd === 'repeat') st.repeat = { off: 'all', all: 'one', one: 'off' }[st.repeat || 'off'];
      this.paint();
    }
    const sentAt = Date.now(); let id = null;
    try { id = (await srvApi(s, '/api/live/cmd', { method: 'POST', body: JSON.stringify({ to, cmd, value, from: S.device }) })).id || null; }
    catch {
      // il server non lo vede (o non lo vediamo noi): elenco aggiornato, e la musica che stava per partire là riparte qui
      toast(`${this.devices.get(to) || 'Il dispositivo'} non è collegato${cmd === 'transfer' ? ': suono qui' : ''}.`);
      await this.resync(); this.ready();
      if (cmd === 'transfer' && value) { this.target = null; this.exec({ cmd: 'transfer', value }); }
      return;
    }
    // un dispositivo chiuso male può sembrare ancora collegato per qualche secondo: se non risponde, la musica resta qui
    if (['transfer', 'play', 'toggle'].includes(cmd)) setTimeout(() => this.check(to, sentAt, cmd === 'transfer' ? value : null, id), 5000);
  },
  async check(to, sentAt, v, id, again) {
    // ha risposto, l'uscita è passata a un altro dispositivo, o qui suona già qualcosa
    if ((this.states.get(to)?.recvAt || 0) > sentAt || (this.target && this.target !== to) || !Engine.el.paused) return;
    if (!this.target && !v) return;  // sparito mentre lo comandavamo: lo dice già "si è scollegato"
    // forse ha risposto e siamo noi a non averlo saputo (il nostro canale è caduto in silenzio): si chiede al server
    // prima di suonare anche qui, che vorrebbe dire due dispositivi che suonano insieme
    const r = await this.resync(false, id);
    const st = r?.states.get(to);
    if ((st && st.at * 1000 - r.off > sentAt - 1000) || r?.cmd?.done === 'eseguito') {
      if (v || st?.playing) this.target = to;
      this.paint(); this.connect();  // il canale che ha perso la risposta si rifà
      return;
    }
    // ancora collegato ma non l'ha preso (canale che si riapre, app che torna dallo sfondo): altri 5 s, poi si rinuncia
    // e il comando si annulla sul server, così non parte più tardi mentre qui suona già
    if (id && !again && this.devices.has(to) && r?.cmd && !r.cmd.done) return setTimeout(() => this.check(to, sentAt, v, id, true), 5000);
    if (id) { const c = await srvApi(srv(), '/api/live/cmd/' + id, { method: 'DELETE' }).catch(() => null); if (c?.done === 'eseguito') { if (v) this.target = to; this.paint(); this.connect(); return; } }
    if (!Engine.el.paused || (this.target && this.target !== to)) return;
    const name = this.devices.get(to) || this.gone?.[to] || 'Il dispositivo';
    this.devices.delete(to); this.states.delete(to); this.target = null;
    toast(`${name} non risponde: suono qui.`); window.Diag?.report('avviso', 'live', `${name} non ha risposto al comando entro 5 s`, v ? 'transfer' : '');
    if (v) this.exec({ cmd: 'transfer', value: v }); else this.paint();
  },
  publish() {
    if (!this.es || !this.on() || Jam.role === 'guest') return;
    const t = Radio.st ? Radio.track : S.queue[S.index]; if (!t) return;
    if (this.remote() && !this.sent?.playing) return;  // telecomando: niente da dire, salvo la pausa appena fatta
    const rd = Radio.st, up = rd ? Radio.next() : S.queue.slice(S.index + 1, S.index + 51);  // i prossimi 50: oltre, il telecomando vede quanti sono
    const now = { device: S.device, name: this.name(), solo: !!P.solo, playing: !Engine.el.paused, position: rd ? Radio.pos() : Engine.time(), duration: playDur(), rate: rd ? 1 : P.speed, shuffle: S.shuffle, repeat: S.repeat, track: wire(t),
      next: up.map(wire), left: rd ? up.length : Math.max(0, S.queue.length - S.index - 1), radio: rd ? { id: rd.id, name: rd.name, r: Radio.path(rd) } : null };
    now.sig = up.map(x => x.id).join() + '|' + now.left;  // solo per accorgersi che la coda è cambiata
    if (now.playing && this.target) { this.target = null; this.pill(); }
    const s = this.sent, exp = s ? s.position + (s.playing ? (Date.now() - s.at) / 1000 * s.rate : 0) : 0;
    if (s && s.track.id === now.track.id && s.playing === now.playing && s.rate === now.rate && s.solo === now.solo && s.shuffle === now.shuffle && s.repeat === now.repeat && s.sig === now.sig && Math.abs(exp - now.position) < 2) return;
    this.sent = { ...now, at: Date.now() };
    srvApi(srv(), '/api/live/state', { method: 'POST', body: JSON.stringify(now) }).catch(() => {});
  },
  pill() {
    const pill = $('#livePill'); if (!pill) return;
    const remote = this.remote();
    $('#bDev')?.classList.toggle('on', remote);  // telefono: l'icona del dispositivo nel mini lettore
    const hp = !remote && Phone.out;  // cuffie di questo telefono (solo app)
    pill.hidden = !this.devices.size && !hp;
    pill.classList.toggle('on', remote);
    pill.innerHTML = `${ic(hp ? 'headphones' : 'speaker')}<span>${esc(remote ? this.devices.get(this.target) || '…' : P.solo ? 'Per conto suo' : 'Qui')}${hp ? ` · <b class="hp">${esc(Phone.short())}</b>` : ''}</span>`;
    pill.setAttribute('aria-label', remote ? `In riproduzione su ${this.devices.get(this.target)}: scegli dove suona` : 'Dove suona');
  },
  paint() {
    this.pill();
    const remote = this.remote();
    clearInterval(this.tick); this.tick = null;
    if (remote && this.playing()) this.tick = setInterval(() => emit('time'), 500);
    updateNowPlaying(); paintTime();
  },
  sheet() {
    const d = $('#dlg'); d.className = 'sheet';
    const here = !this.remote(), mine = { track: S.queue[S.index] && wire(S.queue[S.index]), playing: !Engine.el.paused, solo: P.solo };
    const row = (id, name, st, cur) => `<button class="mi${cur ? ' on' : ''}" data-dev="${esc(id)}">${ic(id === S.device ? (NATIVE || /Android|iPhone|Mobile/.test(navigator.userAgent) ? 'phone' : 'laptop') : 'speaker')}
      <span class="grow"><b>${esc(name)}${id === S.device ? ' · questo' : ''}</b><small>${id === S.device && Phone.out ? `<b class="hp">${esc(Phone.label())}</b> · ` : ''}${st?.track ? `${st.playing ? 'Suona' : 'In pausa'}: ${esc(st.track.title)}` : 'Pronto'}${st?.solo ? ' · per conto suo' : ''}</small></span>${cur ? ic('check') : ''}</button>`;
    d.innerHTML = `<div class="head"><span style="min-width:0"><b style="display:block">Dove suona</b><small style="color:var(--muted)">La musica si sposta sul dispositivo che scegli, dallo stesso punto.</small></span></div>
      ${row(S.device, this.name(), mine, here)}${[...this.devices].map(([id, n]) => row(id, n, this.states.get(id), !here && this.target === id)).join('')}
      <label class="check" style="padding:12px 14px 6px;border-top:1px solid var(--line);margin-top:6px"><input type="checkbox" id="liveSolo" ${P.solo ? 'checked' : ''}><span>Questo dispositivo suona per conto suo<small>Sganciato: non si ferma quando suona un altro tuo dispositivo e non lo ferma. Potete ascoltare cose diverse insieme.</small></span></label>
      <button class="mi" id="liveResync">${ic('repeat')}<span class="grow"><b>Risincronizza</b><small>Ricollega subito questo dispositivo agli altri</small></span></button>`;
    $('#liveResync').onclick = () => {
      d.close();
      if (P.solo) { P.solo = false; savePrefs(); }  // risincronizzare vuol dire tornare agganciati
      this.sent = null; this.wake(true);
      // il canale si riapre in un attimo: lo dice l'elenco dei dispositivi che torna pieno
      setTimeout(() => toast(this.es?.readyState === EventSource.OPEN ? 'Ricollegato.' : 'Il server non risponde: riprovo da solo.'), 2500);
    };
    d.querySelectorAll('[data-dev]').forEach(b => b.onclick = () => { d.close(); this.choose(b.dataset.dev); });
    this.ready();  // mentre si sceglie, il canale si controlla da solo
    $('#liveSolo').onchange = e => {
      P.solo = e.target.checked; savePrefs(); this.sent = null;
      if (P.solo) this.target = null;  // sganciato: niente più telecomando
      this.publish(); this.paint(); this.sheet();
    };
    closeOutside(d); d.showModal();
  },
  async choose(id) {
    await this.ready();
    if (id === S.device) {  // la musica torna qui: il dispositivo che suona ci passa la coda
      if (!this.remote()) return;
      const src = this.target; this.target = null; this.paint();
      if (this.states.get(src)?.track) await this.cmd('handoff', { to: S.device }, src);
      return;
    }
    if (!this.remote() && S.queue[S.index] && Engine.el.getAttribute('src')) return this.give(id);  // da qui a là
    const src = this.target; this.target = id; this.paint();
    if (src && src !== id && this.states.get(src)?.track) return this.cmd('handoff', { to: id }, src);  // fra due altri dispositivi
    // altrimenti è solo la scelta dell'uscita: la prossima riproduzione partirà lì
  }
};

/* ================= chi ascolta cosa sul server: presenza e attività (capacità "presenza") =================
   Arrivano sullo stesso canale di Live (/api/live), a tutti gli utenti del server: "presence" quando qualcuno
   cambia brano, mette play o pausa o salta; "activity" per download, caricamenti, playlist pubbliche e Jam.
   Fra un messaggio e l'altro l'avanzamento si stima qui. Chi spegne la condivisione non arriva proprio (server).
   I disegni stanno dove serve: barra laterale, storie della Home, puntino su Amici, segni su righe e intestazioni. */
const pkey = e => e.user + '|' + e.device;
const pname = e => e.user === srv()?.user ? 'Tu' : e.name || e.user;
// l'iniziale su un colore, o la foto profilo se l'utente ne ha una (Avatar la carica e la dipinge su tutte le copie)
const pavatar = (e, cls = '') => { const u = String(e.user || '').toLowerCase(), bg = Avatar.bg(u);
  return `<span class="pav ${cls}${bg ? ' img' : ''}" data-u="${esc(u)}" style="--pav:${tileColor(e.user)}${bg}" aria-hidden="true">${esc(([...String(e.name || e.user || '?')][0] || '?').toUpperCase())}</span>`; };
// foto profilo (capacità "avatar"): /api/avatar/<utente> con la sessione, tenuta come blob; una sola richiesta per utente
const Avatar = {
  map: new Map(),
  ok() { return !!srv()?.me?.caps?.includes('avatar') && !!srv()?.session && !srv()?.local; },
  bg(u) {
    if (!u) return '';
    const v = this.map.get(u);
    if (v === undefined && this.ok()) { this.map.set(u, 0); setTimeout(() => this.load(u), 0); }
    return typeof v === 'string' ? `;background-image:url(${v})` : '';
  },
  async load(u, fresh) {
    try {
      const r = await netFetch(absUrl(srv().url) + '/api/avatar/' + encodeURIComponent(u), { headers: { 'X-Token': srv().session }, cache: fresh ? 'reload' : 'default' });
      if (!r.ok) { this.map.set(u, null); return; }
      this.map.set(u, URL.createObjectURL(await r.blob()));
    } catch { this.map.set(u, null); return; }
    this.paint(u);
  },
  paint(u) {
    const v = this.map.get(u);
    $$(`.pav[data-u="${CSS.escape(u)}"]`).forEach(el => { el.style.backgroundImage = typeof v === 'string' ? `url(${v})` : ''; el.classList.toggle('img', typeof v === 'string'); });
  },
  // cambiata (da questo o da un altro dispositivo, o da un amico): si ricarica
  refresh(u) { u = String(u || '').toLowerCase(); const v = this.map.get(u); if (typeof v === 'string') URL.revokeObjectURL(v); this.map.delete(u); this.map.set(u, 0); this.paint(u); this.load(u, true); },
  // una foto scelta dal dispositivo: ritagliata al centro, 256×256, JPEG
  async choose() {
    const f = await pickFile('image/*'); if (!f) return;
    try {
      const im = await createImageBitmap(f), side = Math.min(im.width, im.height), c = document.createElement('canvas'); c.width = c.height = 256;
      c.getContext('2d').drawImage(im, (im.width - side) / 2, (im.height - side) / 2, side, side, 0, 0, 256, 256);
      await srvApi(srv(), '/api/profilo/avatar', { method: 'PUT', body: JSON.stringify({ data: c.toDataURL('image/jpeg', .86) }) });
      this.refresh(srv().user); toast('Foto profilo aggiornata.');
    } catch (e) { toast(e.message || 'Questa immagine non si apre.'); }
  },
  async remove() { try { await srvApi(srv(), '/api/profilo/avatar', { method: 'DELETE' }); this.refresh(srv().user); toast('Foto tolta.'); } catch (e) { toast(e.message); } }
};
const peq = on => `<span class="peq${on ? ' on' : ''}" aria-hidden="true"></span>`;
const ago = ms => { const s = (Date.now() - ms) / 1000; return s < 60 ? 'adesso' : s < 3600 ? `${Math.floor(s / 60)} min fa` : s < 86400 ? `${Math.floor(s / 3600)} h fa` : `${Math.floor(s / 86400)} g fa`; };
// elenco con chiavi: aggiorna, aggiunge, toglie e riordina i figli senza rifare tutto, così AutoAnimate anima solo ciò che cambia
function keyed(box, items) {
  const old = new Map([...box.children].filter(c => c.dataset.k).map(c => [c.dataset.k, c]));
  let prev = null;
  for (const it of items) {
    let el = old.get(it.k); old.delete(it.k);
    if (!el) { el = document.createElement(it.tag || 'div'); el.dataset.k = it.k; }
    if (el.className !== (it.cls || '')) el.className = it.cls || '';
    if (el._h !== it.html) { el.innerHTML = it.html; el._h = it.html; }
    for (const [a, v] of Object.entries(it.attrs || {})) if (el.getAttribute(a) !== v) el.setAttribute(a, v);
    const want = prev ? prev.nextSibling : box.firstChild;
    if (el !== want) box.insertBefore(el, want);
    prev = el;
  }
  old.forEach(el => el.remove());
}
const Presence = {
  map: new Map(), acts: [], share: true, skew: 0, t: null, tick: null,
  // solo con il canale dal vivo aperto verso un server che la conosce; altrimenti restano getNowPlaying e il banner di prima
  on() { return !!Live.es && !!srv()?.me?.caps?.includes('presenza'); },
  clear() { this.map.clear(); this.acts = []; this.changed(); },
  hello(m) {
    if (!('presence' in m)) return;
    const now = Date.now();
    this.skew = m.now ? now - m.now * 1000 : 0;
    this.map = new Map(arr(m.presence).map(e => [pkey(e), { ...e, recvAt: now }]));
    this.acts = arr(m.activity); this.share = m.share !== false; this.changed();
  },
  recv(m) {
    if (m.type === 'presence') {
      if (m.gone) this.map.delete(pkey(m.gone));
      else if (m.entry) this.map.set(pkey(m.entry), { ...m.entry, recvAt: Date.now() });
    } else if (m.hide) this.acts = this.acts.filter(a => a.user !== m.hide);
    else if (m.item) this.acts = [m.item, ...this.acts.filter(a => a.id !== m.item.id)].slice(0, 50);
    this.changed();
  },
  changed() { clearTimeout(this.t); this.t = setTimeout(() => this.paint(), 50); },
  pos(e) { const p = (e.position || 0) + (e.playing ? (Date.now() - e.recvAt) / 1000 * (e.rate || 1) : 0); return e.duration ? Math.min(p, e.duration) : p; },
  // il brano come quelli della libreria; senza un server noto si assume quello in uso (la presenza arriva da lì)
  track(e) { const w = e.track || {}, s = S.servers.find(x => absUrl(x.url) === w.serverUrl) || srv(); return norm(w, s?.id); },
  // una voce per persona: il dispositivo che suona, altrimenti l'ultimo messo in pausa (da meno di 10 minuti).
  // Questo dispositivo non c'è mai; gli altri propri dispositivi solo mentre suonano
  people() {
    const me = srv()?.user, by = new Map(), now = Date.now();
    for (const e of this.map.values()) {
      if (e.user === me && (e.device === S.device || !e.playing)) continue;
      if (!e.playing && now - e.recvAt + (e.since || 0) * 1000 > 600000) continue;
      // suona ma il brano è finito da un pezzo senza notizie: dispositivo chiuso, il server lo toglierà a breve
      if (e.playing && e.duration && (e.position || 0) + (now - e.recvAt) / 1000 * (e.rate || 1) > e.duration + 20) continue;
      const k = e.user === me ? pkey(e) : e.user, c = by.get(k);
      if (!c || e.playing > c.playing || e.playing === c.playing && e.recvAt - (e.since || 0) * 1000 > c.recvAt - (c.since || 0) * 1000) by.set(k, e);
    }
    return [...by.values()].sort((a, b) => b.playing - a.playing || pname(a).localeCompare(pname(b)));
  },
  playingCount() { return this.people().filter(e => e.playing).length; },
  listen(e) {
    if (e.radio?.id) return Radio.tune(Radio.find((e.radio.r ? e.radio.r + '/' : '') + e.radio.id) || { id: e.radio.id, name: e.radio.name, on: true, path: e.radio.r ? e.radio.r.split(',') : [] });
    const t = this.track(e); if (!t?.id) return;
    // dallo stesso punto, se suona qui; come telecomando o in una Jam si parte dall'inizio
    if (Jam.role || Live.remote()) return setQueue([t], 0);
    S.queue = [t]; playIndex(0, { startAt: e.playing ? this.pos(e) : 0 });
    toast(`Ascolti con ${pname(e)}.`);
  },
  open(e) { const t = this.track(e); location.hash = t.albumId ? '#/album/' + encodeURIComponent(t.albumId) : t.artistId ? '#/artista/' + encodeURIComponent(t.artistId) : '#/amici'; },
  async openAct(a) {
    const l = a.link || {};
    if (l.playlist) location.hash = '#/playlist/' + encodeURIComponent(l.playlist);
    else if (l.amici) location.hash = '#/amici';
    else if (l.radio) location.hash = '#/radio';
    else if (l.album) {
      // l'album appena scaricato o caricato si cerca per nome: l'id lo decide Navidrome quando lo vede
      let r = []; try { r = arr((await api('search3', { query: l.album, albumCount: 10, artistCount: 0, songCount: 0 })).searchResult3?.album); } catch {}
      const x = r.find(x => cleanTxt(x.name) === cleanTxt(l.album) && (!l.artist || cleanTxt(x.artist || '').includes(cleanTxt(l.artist)))) || r[0];
      if (x) location.hash = '#/album/' + encodeURIComponent(x.id); else toast('Non è ancora in libreria: riprova fra poco.');
    }
  },
  sheet(k) {
    const e = this.map.get(k); if (!e) return;
    const t = this.track(e), d = $('#dlg'); d.className = 'sheet';
    d.innerHTML = `<div class="head">${pavatar(e, 'l')}<span class="grow" style="min-width:0"><b style="display:block">${esc(pname(e))}</b><small style="color:var(--muted)">${e.playing ? 'Sta ascoltando' : 'In pausa'}${e.radio ? ` la radio «${esc(e.radio.name)}»` : e.devName ? ' · ' + esc(e.devName) : ''}</small></span></div>
      <div class="pcard" data-pk="${esc(k)}"><span class="pic">${imgTag(t.coverArt, 120, t.serverId)}</span><span class="grow"><b>${esc(t.title)}</b><small>${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</small><span class="pbar"><i></i></span></span></div>
      <button class="mi" data-x="listen">${ic('headphones')}${e.radio ? 'Sintonizzati anche tu' : 'Ascolta anche tu'}</button>
      ${t.albumId ? `<button class="mi" data-x="album">${ic('album')}<span class="grow" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Apri l'album «${esc(t.album || t.title)}»</span></button>` : ''}
      ${t.artistId ? `<button class="mi" data-x="artist">${ic('artist')}Vai a ${esc(t.artist)}</button>` : ''}`;
    d.querySelectorAll('[data-x]').forEach(b => b.onclick = () => {
      d.close(); const x = b.dataset.x;
      if (x === 'listen') this.listen(e); else location.hash = x === 'album' ? '#/album/' + encodeURIComponent(t.albumId) : '#/artista/' + encodeURIComponent(t.artistId);
    });
    this.progress(); closeOutside(d); d.showModal();
  },
  // avanzamento e orari relativi: si muovono da soli, senza ridisegnare gli elenchi
  progress() {
    $$('[data-pk]').forEach(el => { const e = this.map.get(el.dataset.pk), b = el.querySelector('.pbar i'); if (e && b) b.style.transform = `scaleX(${e.duration ? Math.min(1, this.pos(e) / e.duration) : 0})`; });
    $$('[data-at]').forEach(el => { const s = ago(+el.dataset.at); if (el.textContent !== s) el.textContent = s; });
  },
  paint() {
    const on = this.on(), ppl = on ? this.people() : [], playing = ppl.filter(e => e.playing);
    // computer: "In ascolto ora" nella barra laterale, sopra le playlist
    const side = $('#sidePres');
    if (side) {
      side.hidden = !ppl.length;
      if (ppl.length && !side.firstElementChild) side.innerHTML = '<h3>In ascolto ora</h3><div class="plist"></div>', window.autoAnimate?.(side.lastChild);
      if (ppl.length) keyed(side.lastChild, ppl.map(e => { const t = this.track(e); return { k: pkey(e), cls: 'prow' + (e.playing ? '' : ' paused'), html:
        `<button class="pgo" data-pact="open">${pavatar(e)}<span class="grow"><b>${esc(pname(e))}${peq(e.playing)}</b><small>${e.playing ? '' : 'In pausa · '}${e.radio ? `Radio «${esc(e.radio.name)}» · ` : ''}${esc(t.title)} · ${esc(t.artist)}</small></span></button>
        <button class="icon-btn" data-pact="listen" aria-label="Ascolta anche tu" title="Ascolta anche tu">${ic('headphones')}</button>`, attrs: { 'data-pk': pkey(e) } }; }));
    }
    // puntino su Amici: nella barra laterale e, sul telefono, sulla sua voce in basso o su "Altro" se Amici sta lì
    $$(`#nav a[data-r="amici"], ${inMore('amici') ? '#tabMore' : '#tabs a[data-r="amici"]'}`).forEach(a => { const d = a.querySelector(':scope>.dot'); if (playing.length && !d) a.insertAdjacentHTML('beforeend', '<i class="dot pdot" aria-hidden="true"></i>'); else if (!playing.length && d) d.remove(); });
    this.paintView(ppl, playing);
    this.progress();
    // ogni secondo l'avanzamento; ogni 30 secondi un giro intero (chi è in pausa da troppo sparisce)
    clearInterval(this.tick); this.tick = null; let n = 0;
    if (ppl.length || this.acts.length) this.tick = setInterval(() => { if (document.visibilityState !== 'visible') return; this.progress(); if (++n % 30 === 0) this.paint(); }, 1000);
  },
  // quello che sta dentro la pagina aperta: storie in Home, pagina Amici, segni su righe e intestazioni
  paintView(ppl = this.on() ? this.people() : [], playing = ppl.filter(e => e.playing)) {
    const st = $('#presStories');
    if (st) {
      if (this.on()) $('#friendsStrip')?.replaceChildren();
      st.hidden = !ppl.length; st._aa ||= window.autoAnimate?.(st) || 1;
      keyed(st, ppl.map(e => { const t = this.track(e); return { k: pkey(e), tag: 'button', cls: 'story' + (e.playing ? ' on' : ''), attrs: { 'data-pact': 'sheet', 'data-pk': pkey(e), 'aria-label': `${pname(e)}: ${e.playing ? 'ascolta' : 'in pausa su'} ${t.title}` }, html:
        `<span class="ring">${pavatar(e, 'l')}<span class="scov">${imgTag(t.coverArt, 64, t.serverId)}</span></span><b>${esc(pname(e))}</b><small>${esc(t.title)}</small>` }; }));
    }
    const now = $('#presNow'), feed = $('#presFeed');
    [now, feed].forEach(b => { if (b) b._aa ||= window.autoAnimate?.(b) || 1; });
    if (now) keyed(now, ppl.length ? ppl.map(e => { const t = this.track(e); return { k: pkey(e), cls: 'pnow-row' + (e.playing ? '' : ' paused'), attrs: { 'data-pk': pkey(e) }, html:
      `<button class="pgo" data-pact="open">${pavatar(e, 'm')}<span class="grow"><b>${esc(pname(e))}${peq(e.playing)}<small> · ${e.playing ? '' : 'in pausa · '}${e.radio ? `ascolta la radio «${esc(e.radio.name)}»` : esc(e.devName || '')}</small></b>
        <span class="ptrack"><span class="pic">${imgTag(t.coverArt, 80, t.serverId)}</span><span class="grow"><b>${esc(t.title)}</b><small>${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</small></span></span><span class="pbar"><i></i></span></span></button>
      <button class="btn sm" data-pact="listen">${ic('headphones')} Ascolta</button>` }; })
      : [{ k: 'vuoto', cls: 'empty', html: 'Nessuno sta ascoltando in questo momento.' }]);
    if (feed) keyed(feed, this.acts.length ? this.acts.map(a => ({ k: a.id, cls: 'pact' + (a.link ? ' go' : ''), attrs: a.link ? { 'data-pact': 'act', role: 'link', tabindex: '0' } : {}, html:
      `${pavatar(a, 's')}<span class="grow"><span><b>${esc(a.user === srv()?.user ? 'Tu' : a.name || a.user)}</b> ${esc(a.text)}</span><small data-at="${Math.round(a.at * 1000 + this.skew)}"></small></span>${ic({ download: 'down', upload: 'up', playlist: 'list', jam: 'jam', radio: 'radio' }[a.kind] || 'friends')}` }))
      : [{ k: 'vuoto', cls: 'empty', html: 'Ancora niente. Qui compaiono download, caricamenti, playlist condivise e Jam degli amici.' }]);
    // segni sui contenuti: chi ascolta proprio questo brano, album o artista
    const sid = S.active, here = playing.map(e => [e, this.track(e)]).filter(([, t]) => t.serverId === sid);
    $$('#view .song[data-tid]').forEach(row => {
      const who = here.filter(([, t]) => t.id === row.dataset.tid).map(([e]) => e), sm = row.querySelector('.t small'), m = sm?.querySelector(':scope>.pmark');
      const sig = who.map(pkey).join();
      if (!sm || (m?.dataset.sig || '') === sig) return;
      m?.remove();
      if (who.length) sm.insertAdjacentHTML('afterbegin', `<span class="pmark" data-pres data-sig="${esc(sig)}">${who.slice(0, 3).map(e => pavatar(e, 'xs')).join('')}${esc(who.map(pname).join(', '))}</span>`);
    });
    const hero = $('#view .phero-txt'), [r, id] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    if (hero) {
      const who = r === 'album' ? here.filter(([, t]) => t.albumId === id) : r === 'artista' ? here.filter(([, t]) => t.artistId === id) : [];
      const sig = who.map(([e, t]) => pkey(e) + t.id).join(), m = hero.querySelector(':scope>.pmark-h');
      if ((m?.dataset.sig || '') !== sig) {
        m?.remove();
        if (who.length) {
          const [e, t] = who[0], names = who.map(([x]) => pname(x)), many = names.length > 1;
          hero.insertAdjacentHTML('beforeend', `<button class="pmark-h" data-pres data-sig="${esc(sig)}" data-pact="sheet" data-pk="${esc(pkey(e))}">${who.slice(0, 3).map(([x]) => pavatar(x, 's')).join('')}${peq(true)}<span><b>${esc(many ? names.slice(0, -1).join(', ') + ' e ' + names.at(-1) : names[0])}</b> ${names[0] === 'Tu' && !many ? 'stai' : many ? 'stanno' : 'sta'} ascoltando${many ? '' : ` «${esc(t.title)}»`}</span></button>`);
        }
      }
    }
  }
};
// le viste si ridisegnano spesso (liste dal vivo, pagine nuove): i segni si rimettono da soli, ignorando i propri cambiamenti
new MutationObserver(ms => {
  if (!Presence.map.size || ms.every(m => m.target.closest?.('[data-pres]') || [...m.addedNodes, ...m.removedNodes].every(n => n.nodeType !== 1 || n.hasAttribute('data-pres')))) return;
  cancelAnimationFrame(Presence.raf); Presence.raf = requestAnimationFrame(() => Presence.paintView());
}).observe(view, { childList: true, subtree: true });
document.addEventListener('click', e => {
  const el = e.target.closest('[data-pact]'); if (!el) return;
  const k = el.closest('[data-pk]')?.dataset.pk, p = Presence.map.get(k), act = el.dataset.pact;
  e.stopPropagation();
  if (act === 'act') { const a = Presence.acts.find(x => x.id === el.dataset.k); if (a) Presence.openAct(a); return; }
  if (!p) return;
  if (act === 'listen') Presence.listen(p); else if (act === 'open') Presence.open(p); else Presence.sheet(k);
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches?.('[data-pact="act"]')) e.target.click(); });

// mini lettore del telefono, come Spotify: scorri a sinistra o a destra per cambiare brano, in su per aprire il lettore
function miniGestures() {
  const b = $('#npBtn'), tx = b.querySelector('.t'); let x0 = null, y0 = 0, dx = 0, moved = false;
  b.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse') return; x0 = e.clientX; y0 = e.clientY; dx = 0; moved = false; });
  b.addEventListener('pointermove', e => {
    if (x0 == null) return;
    dx = e.clientX - x0; const dy = e.clientY - y0;
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) { moved = true; tx.style.transform = `translateX(${dx}px)`; tx.style.opacity = 1 - Math.min(.7, Math.abs(dx) / 220); }
    else if (dy < -36 && !moved) { moved = true; x0 = null; location.hash = '#/ora'; }
  });
  const end = () => {
    if (x0 == null) return; x0 = null;
    tx.style.transition = 'transform .22s var(--ease-out), opacity .22s'; tx.style.transform = ''; tx.style.opacity = '';
    setTimeout(() => { tx.style.transition = ''; }, 240);
    if (Math.abs(dx) > 70) dx < 0 ? ctlNext(false) : ctlPrev();
  };
  b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end);
  b.addEventListener('click', e => { if (moved) { e.stopImmediatePropagation(); e.preventDefault(); moved = false; } }, true);
}

/* ================= controlli del lettore e avvio ================= */
function wirePlayer() {
  $('#bPrev').innerHTML = ic('prev'); $('#bNext').innerHTML = ic('next'); $('#bQueue').innerHTML = ic('queue'); $('#bQm').innerHTML = ic('sliders'); $('#bLyr').innerHTML = $('#bLyrM').innerHTML = ic('lyrics');
  $('#bPlay').onclick = ctlToggle; $('#bNext').onclick = () => ctlNext(false); $('#bPrev').onclick = ctlPrev;
  $('#bQueue').onclick = () => location.hash = '#/coda';
  $('#bLyr').onclick = $('#bLyrM').onclick = () => location.hash.startsWith('#/testo') ? (navStack.at(-2) ? history.back() : location.hash = '#/ora') : location.hash = '#/testo';
  $('#npBtn').onclick = () => location.hash = '#/ora';
  $('#bQm').onclick = qualityDialog; $('#qBadge').onclick = qualityDialog;
  $('#bStar').onclick = $('#bStarM').onclick = () => currentTrack() && toggleStar(currentTrack());
  $('#bDev').innerHTML = ic('speaker'); $('#bDev').onclick = () => Live.sheet();
  $('#bQueueM').innerHTML = ic('queue'); $('#bQueueM').onclick = () => location.hash = '#/coda';
  $('#hMe').onclick = drawer;
  $('#hProf').onclick = profPop;
  $('#hBell').onclick = () => NotifPop.open(); $('#hBell').setAttribute('aria-haspopup', 'dialog');
  miniGestures();
  $('#sleepPill').onclick = sleepDialog; $('#jamPill').onclick = () => location.hash = '#/jam';
  $('#bShuf').onclick = () => {
    if (Jam.role === 'guest') return toast('Durante una Jam l\'ordine lo decide l\'host.');
    if (Radio.st) return radioNo();
    Live.remote() ? Live.cmd('shuffle') : ctlShuffle();
  };
  $('#bRep').onclick = () => Radio.st ? radioNo() : Live.remote() ? Live.cmd('repeat') : ctlRepeat();
  $('#radioPill').onclick = () => Radio.st && Radio.sheet(Radio.st);
  $('#vol').value = P.volume * 100;
  $('#vol').oninput = e => { P.volume = e.target.value / 100; savePrefs(); Engine.applyVolume(); rangeFill(e.target); };
  $('#seek').oninput = () => { seeking = true; $('#tCur').textContent = fmt($('#seek').value / 1000 * playDur()); rangeFill($('#seek')); };
  rangeFill($('#vol'));
  // ogni cursore riempie in ambra la parte a sinistra del pomello
  document.addEventListener('input', e => { if (e.target.matches?.('input[type=range]')) rangeFill(e.target); });
  // barra di stato del telefono: il colore della stanza nel tema in uso (anche quando lo si cambia a mano)
  const themeColor = () => { const m = $('#themeColor'); if (m) m.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(); };
  new MutationObserver(themeColor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', themeColor); themeColor();
  $('#seek').onchange = () => { ctlSeek($('#seek').value / 1000 * playDur()); seeking = false; };
  $('#ctxBtn').onclick = ctxDialog;
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', ctlToggle); ms.setActionHandler('pause', ctlToggle);
    ms.setActionHandler('previoustrack', ctlPrev); ms.setActionHandler('nexttrack', () => ctlNext(false));
    try { ms.setActionHandler('seekto', e => ctlSeek(e.seekTime)); ms.setActionHandler('seekbackward', () => ctlSeek(playPos() - 10)); ms.setActionHandler('seekforward', () => ctlSeek(playPos() + 10)); } catch {}
  }
  addEventListener('keydown', e => {
    if (e.target.closest('input,textarea,select') || e.ctrlKey || e.metaKey || e.altKey || $('dialog[open]')) return;
    const k = e.key;
    if (k === ' ') { e.preventDefault(); ctlToggle(); }
    else if (k === 'ArrowRight' && e.shiftKey) ctlNext(false);
    else if (k === 'ArrowLeft' && e.shiftKey) ctlPrev();
    else if (k === 'ArrowRight') ctlSeek(playPos() + 10);
    else if (k === 'ArrowLeft') ctlSeek(playPos() - 10);
    else if (k === 'ArrowUp' || k === 'ArrowDown') { e.preventDefault(); P.volume = Math.max(0, Math.min(1, P.volume + (k === 'ArrowUp' ? .05 : -.05))); $('#vol').value = P.volume * 100; savePrefs(); Engine.applyVolume(); }
    else if (k === 'm') { P._muted = P._muted ? (P.volume = P._muted, 0) : (P._muted = P.volume || 1, P.volume = 0, P._muted); Engine.applyVolume(); $('#vol').value = P.volume * 100; }
    else if (k === 'l') $('#bLyr').click();
    else if (k === 'q') location.hash = '#/coda';
    else if (k === 's') $('#bShuf').click();
    else if (k === 'r') $('#bRep').click();
    else if (k === 'f') { const t = currentTrack(); if (t) toggleStar(t); }
    else if (k === '/') { e.preventDefault(); location.hash = '#/cerca'; }
    else if (k === '?') location.hash = '#/tasti';
  });
  Bus.addEventListener('track', fillSelectors);
}
// barra laterale su schermo largo: le playlist del server attivo, sempre a portata.
// Si ridisegna da sola quando una playlist nasce, cambia o sparisce ('playlists')
async function sidePlaylists() {
  const box = $('#sidePl'); if (!box) return;
  let pls = []; try { if (srv()) pls = arr((await api('getPlaylists')).playlists?.playlist); } catch {}
  const cur = (location.hash.match(/^#\/playlist\/(.+)/) || [])[1];
  box.innerHTML = pls.length ? `<h3>Le tue playlist</h3>${pls.map(p => `<a href="#/playlist/${encodeURIComponent(p.id)}" data-pl="${esc(p.id)}"${cur && decodeURIComponent(cur) === p.id ? ' class="on"' : ''}>
    <span class="pic">${p.songCount ? imgTag(p.coverArt, 80) : ic('list')}</span><span class="grow"><b>${esc(p.name)}</b><small>Playlist · ${esc(p.owner || srv()?.user || '')}</small></span></a>`).join('')}` : '';
}
async function boot() {
  $('#nav').innerHTML = NAV.filter(([h]) => (h !== 'rete' || can('rete')) && (h !== 'video' || (S.dl.url && can('download')))).map(([h, l, i]) => `<a href="#/${h}" data-r="${h}">${ic(i)}<span class="lbl">${l}</span></a>`).join('');
  Bus.addEventListener('playlists', sidePlaylists); sidePlaylists();
  paintTabs();
  $('#tabs').oncontextmenu = e => { if (matchMedia('(pointer:fine)').matches) return; e.preventDefault(); tabsEditor(); };  // tenere premuta la barra la personalizza (col mouse c'è il menu)
  $('#hSearch').onclick = e => { if (location.hash.startsWith('#/cerca')) { e.preventDefault(); $('#q')?.focus(); } else searchFocus = true; };
  Wave.init();
  Engine.init(); wirePlayer();
  await Offline.init(); await Local.init(); ACache.init();
  try { const q = await DB.get('stato', 'queue'); if (q?.queue && q.at > store.get('queueAt', 0)) { S.queue = q.queue; S.index = q.index; } } catch {}
  if (srv()?.session && Disp.ok(srv()) && Disp.stale(srv())) await Promise.race([Disp.fresh(srv(), true), sleep(4000)]);
  if (Local.on() && !navigator.onLine && !srv()?.local) S.active = Local.id;  // senza rete suona il telefono
  fillSelectors(); updateNowPlaying(); paintTime();
  const t = S.queue[S.index];
  if (t && (srv(t.serverId) || Offline.has(t))) await Engine.load(t, Engine.cur, { autoplay: false, startAt: store.get('pos', 0), lazy: true });
  addEventListener('hashchange', route);
  addEventListener('online', () => { toast('Di nuovo online.'); fillSelectors(); });
  addEventListener('offline', () => toast('Sei offline: puoi ascoltare i brani salvati.'));
  navigator.connection?.addEventListener?.('change', fillSelectors);
  if ('serviceWorker' in navigator && /^https?:/.test(location.protocol) && !NATIVE) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // sw.js apre l'app dalla cache e intanto scarica la versione nuova: appena aperta e ferma si ricarica subito, altrimenti alla prossima apertura
    const t0 = Date.now();
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type !== 'aggiornata') return;
      if (Date.now() - t0 < 15000 && !isPlaying() && !$('dialog[open]')) location.reload();
      else toast('Armony è stata aggiornata: la versione nuova parte alla prossima apertura.', 5000);
    });
  }
  NativeMedia.init(); Phone.init(); if (NATIVE) { nativeBack(); AppUpdate.init(); NetDns.need(''); }
  Jam.init();
  route();
  setTimeout(resolvePending, 8000);
  addEventListener('online', () => { HistSync.run(); Live.wake(true); Scrob.flush(); });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && Live.wake());
  addEventListener('focus', () => Live.wake());
  // chiusura della scheda o app mandata in sottofondo: l'ultima posizione va al server
  addEventListener('pagehide', () => P.syncQueue && S.queue[S.index] && QSync.push(true));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && P.syncQueue && isPlaying() && !Live.remote() && QSync.push(true));
  $('#themeBtn').onclick = () => { P.theme = THEMES[P.theme]?.[2] || 'auto'; savePrefs(); applyTheme(); toast(`Tema ${THEMES[P.theme][0].toLowerCase()}.`); };
  paintTheme();  // sul computer: due finestre visibili, il canale va a quella che si usa
  window.Capacitor?.Plugins?.App?.addListener('resume', () => Live.wake());
  $('#livePill').onclick = () => Live.sheet();
  syncSessions().then(async () => { Live.connect(); Disp.dot(); if (srv()?.pending || srv()?.revoked) route(); notifyUpdate(); Local.auto(); await PrefSync.pull(); await HistSync.run(); OffPin.soon(20000); HistSync.repair(); Scrob.flush(); Notif.load(); Amici.load();
    window.Capacitor?.Plugins?.ArmonyFiles?.pending?.().then(r => { if (r?.link) location.hash = r.link; }).catch(() => {});
    if (/^#\/(impostazioni|scarica|statistiche|album-dz|artista-dz|rete|radio)/.test(location.hash)) route(); });
}
