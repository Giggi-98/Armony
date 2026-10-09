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
function saveFile(name, data, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
function pickFile(accept, multiple = false) {
  return new Promise(res => { const f = $('#filePick'); f.accept = accept; f.multiple = multiple; f.value = ''; f.onchange = () => res(multiple ? [...f.files] : f.files[0] || null); f.click(); });
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
  speaker: '<rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="14" r="4"/><path d="M12 6h.01"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  laptop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/>',
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  lib: '<path d="M4 4v16M9 4v16M14 5l5 15"/>',
  artist: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  list: '<path d="M4 6h12M4 12h12M4 18h8"/><circle cx="19" cy="17" r="2"/><path d="M21 17V8"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  queue: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  down: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
  pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z" fill="currentColor"/>',
  prev: '<path d="M18 5L9 12l9 7zM6 5v14"/>',
  next: '<path d="M6 5l9 7-9 7zM18 5v14"/>',
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
  eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], eqOn: true, compat: false, lyricsOnline: true, syncQueue: true,
  nick: '', stun: true, turn: { url: '', user: '', pass: '' }, theme: 'auto', volume: 1, visualizer: true, sync: true, live: true, deviceName: '', solo: false
};
const P = Object.assign({}, DEFAULT_PREFS, store.get('prefs', {}));
// restano su questo dispositivo anche con la sincronizzazione attiva
const DEVICE_PREFS = ['compat', 'volume', 'sync', 'live', 'deviceName', 'solo'];
const savePrefs = () => { store.set('prefs', P); store.set('prefsAt', Date.now()); PrefSync.schedule(); };
const S = {
  servers: store.get('servers', []),
  active: store.get('active', null),
  queue: store.get('queue', []),
  index: store.get('index', -1),
  shuffle: store.get('shuffle', false),
  repeat: store.get('repeat', 'off'),
  device: store.get('device', null) || (() => { const d = 'armony-' + uid(5).toLowerCase(); store.set('device', d); return d; })(),
  lastList: [], me: {}
};
if (!S.servers.find(s => s.id === S.active)) S.active = S.servers[0]?.id || null;
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
    const s = srv(); if (s?.session) return { url: absUrl(s.url), token: s.session };
    const l = store.get('downloader', null); return l?.url && l?.token ? l : { url: '', token: '' };
  }
});
const access = () => srv()?.session ? srv().me || {} : S.dl.token ? { admin: true, upload: true, download: true } : {};
if (P.theme !== 'auto') document.documentElement.dataset.theme = P.theme;
const srv = id => S.servers.find(s => s.id === (id || S.active));
const key = t => t.serverId + ':' + t.id;
const hex = s => [...new TextEncoder().encode(s)].map(b => b.toString(16).padStart(2, '0')).join('');
const onMobileData = () => { const c = navigator.connection; return !!c && (c.type === 'cellular' || c.saveData); };
const activeQuality = () => (onMobileData() && P.qualityMobile !== 'same') ? P.qualityMobile : P.quality;

/* ================= API Subsonic / OpenSubsonic ================= */
function absUrl(u) { try { return new URL(u, location.href).toString().replace(/\/+$/, ''); } catch { return u; } }
function apiParams(s, params = {}) {
  const p = new URLSearchParams();
  const auth = s.tok ? { t: s.tok, s: s.salt } : { p: 'enc:' + hex(s.pass || '') };
  const all = { u: s.user, ...auth, v: '1.16.1', c: S.device, f: 'json', ...params };
  for (const [k, v] of Object.entries(all)) {
    if (Array.isArray(v)) v.forEach(x => p.append(k, x)); else if (v !== undefined && v !== null && v !== '') p.set(k, v);
  }
  return p;
}
const apiBase = (s, method) => absUrl(s.url) + '/rest/' + method;
const apiUrl = (s, method, params) => apiBase(s, method) + '?' + apiParams(s, params);
async function api(method, params, s = srv(), post = false) {
  if (!s) throw new Error('Nessun server configurato. Aggiungine uno in Impostazioni.');
  let r;
  try {
    r = post ? await fetch(apiBase(s, method), { method: 'POST', body: apiParams(s, params) })
      : await fetch(apiUrl(s, method, params));
  } catch { throw new Error(`Non riesco a raggiungere ${s.name}. Controlla indirizzo e connessione.`); }
  if (!r.ok) throw new Error(`${s.name} ha risposto con errore ${r.status}.`);
  const sr = (await r.json())['subsonic-response'];
  if (sr.status !== 'ok') throw new Error(sr.error?.code === 40 ? 'Utente o password errati.' : sr.error?.message || 'Il server ha rifiutato la richiesta.');
  if (/^(create|update|delete)Playlist$/.test(method)) { emitSoon('playlists'); emitSoon('libreria'); }
  // Navidrome scansiona in differita: un avviso dopo pochi secondi e uno di sicurezza dopo 15
  if (method === 'startScan') { setTimeout(() => emit('libreria'), 4000); setTimeout(() => emit('libreria'), 15000); }
  return sr;
}
const norm = (x, sid = S.active) => ({
  id: x.id, title: x.title || 'Senza titolo', artist: x.displayArtist || x.artist || 'Artista sconosciuto',
  artistId: x.artistId, album: x.album || '', albumId: x.albumId, duration: x.duration || 0, track: x.track,
  coverArt: x.coverArt, starred: !!x.starred, suffix: x.suffix, bitRate: x.bitRate, genre: x.genre, year: x.year,
  rg: x.replayGain ? { trackGain: x.replayGain.trackGain, albumGain: x.replayGain.albumGain, trackPeak: x.replayGain.trackPeak, albumPeak: x.replayGain.albumPeak } : null,
  serverId: sid
});
// coverBust: dopo aver cambiato una copertina, l'indirizzo cambia e il browser non mostra quella vecchia dalla cache
let coverBust = 0;
const coverUrl = (coverArt, size = 300, sid) => { const s = srv(sid); return coverArt && s ? apiUrl(s, 'getCoverArt', { id: coverArt, size, ...(coverBust ? { v: coverBust } : {}) }) : ''; };
const streamUrl = (t, q = activeQuality()) => apiUrl(srv(t.serverId), 'stream', { id: t.id, ...QUALITIES[q].params });
const imgTag = (coverArt, size, sid) => { const u = coverUrl(coverArt, size, sid); return u ? `<img src="${esc(u)}" alt="" loading="lazy" onerror="this.remove()">` : ''; };

/* ================= accesso ad Armony (sessione per utente, permessi dal ruolo Navidrome) ================= */
async function armonyLogin(s) {
  const base = absUrl(s.url);
  const info = await fetch(base + '/api/info').then(r => r.ok ? r.json() : null).catch(() => undefined);
  if (info === undefined) return null;  // irraggiungibile: si riprova al prossimo avvio
  if (!info?.armony) { s.armony = false; delete s.session; delete s.me; return null; }  // Subsonic senza Armony, o Armony 0.2
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ u: s.user, t: s.tok, s: s.salt, device: S.device }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Errore ${r.status}`);
  s.armony = true; s.session = j.session; delete j.session; s.me = j;
  return j;
}
async function syncSessions() {
  for (const s of S.servers) {
    if (!s.tok) continue;  // anche i server "senza Armony": potrebbero averlo installato nel frattempo
    if (s.session) {
      const r = await fetch(absUrl(s.url) + '/api/me', { headers: { 'X-Token': s.session } }).catch(() => null);
      if (r?.ok) { s.me = await r.json(); continue; }
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
// play/pausa: le due metà del triangolo diventano le due barre (stessa sequenza di punti, la forma si trasforma)
const PP = { play: ['M7 4L13.5 8L13.5 16L7 20Z', 'M13.5 8L20 12L20 12L13.5 16Z'], pause: ['M7 4L11 4L11 20L7 20Z', 'M13 4L17 4L17 20L13 20Z'] };

/* ================= router ================= */
const NAV = [
  ['home', 'Home', 'home'], ['cerca', 'Cerca', 'search'], ['libreria', 'Libreria', 'lib'], ['playlist', 'Playlist', 'list'],
  ['preferiti', 'Preferiti', 'heart'], ['jam', 'Jam', 'jam'], ['amici', 'Amici', 'friends'], ['offline', 'Offline', 'offline'],
  ['statistiche', 'Statistiche', 'stats'], ['scarica', 'Scarica', 'down'], ['impostazioni', 'Impostazioni', 'gear']
];
const view = $('#view');
const ROUTE_PARENT = { album: 'libreria', artista: 'libreria', 'album-dz': 'libreria', 'artista-dz': 'libreria', genere: 'libreria', decennio: 'libreria' };
// su telefono: quattro sezioni nella barra in basso, le altre nel foglio "Altro"
const TABS = ['home', 'cerca', 'libreria', 'jam'];
const MORE = [...NAV.map(n => n[0]).filter(h => !TABS.includes(h)), 'tasti'];
let viewTimers = [];
const viewInterval = (fn, ms) => viewTimers.push(setInterval(fn, ms));
async function route() {
  viewTimers.forEach(clearInterval); viewTimers = [];
  emit('route');
  const [r = 'home', ...rest] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const id = rest.join('/');
  $$('#nav a, #tabs a').forEach(a => { const on = a.dataset.r === r || ROUTE_PARENT[r] === a.dataset.r; a.classList.toggle('on', on); on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
  $('#tabMore')?.classList.toggle('on', MORE.includes(ROUTE_PARENT[r] || r));
  $$('#sidePl a').forEach(a => a.classList.toggle('on', r === 'playlist' && a.dataset.pl === id));
  const fn = {
    home: vHome, cerca: vSearch, libreria: vLibrary, artista: vArtist, album: vAlbum, 'artista-dz': vArtistDz, 'album-dz': vAlbumDz, genere: vGenre, decennio: vDecade,
    playlist: id ? vPlaylist : vPlaylists, preferiti: vStarred, coda: vQueue, ora: vNow, amici: vFriends, offline: vOffline,
    statistiche: vStats, scarica: vDownload, impostazioni: vSettings, jam: vJam, tasti: vKeys, invito: vInvite
  }[r] || vHome;
  const changed = location.hash !== Scene.hash, from = Scene.r, n = ++Scene.nav; Scene.hash = location.hash; Scene.r = r;
  const run = async () => {
    if (stale(n)) return;
    delete view.dataset.pl;
    view.innerHTML = skeleton(r, id);
    if (changed && r !== 'ora') window.scrollTo(0, 0);
    return fn(id);
  };
  try { await (changed ? Scene.go(run, from, r) : run()); }
  catch (e) {
    console.error(e);
    if (stale(n)) return;
    view.innerHTML = `<div class="empty"><h3>Qualcosa non ha funzionato</h3><p>${esc(e.message)}</p>
      <div class="row" style="justify-content:center"><button class="btn" onclick="route()">Riprova</button><a class="btn" href="#/impostazioni">Impostazioni</a>${Offline.keys.size ? '<a class="btn" href="#/offline">Ascolta offline</a>' : ''}</div></div>`;
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
      <button class="card-go" data-act="album" data-id="${esc(a.id)}"><b>${esc(a.name || a.title)}</b></button>
      <small>${esc(a.artist || '')}${a.year ? ' · ' + a.year : ''}</small>
    </div>`).join('')}</div>`;
}
// elenco di brani (.tracklist): su schermo largo a colonne con intestazione (#, titolo, album, durata),
// su telefono miniatura, titolo e artista. Le righe restano .song: albumGaps vi inserisce le tracce mancanti
function songList(tracks, opts = {}) {
  S.lastList = tracks;
  if (!tracks.length) return `<div class="empty">${opts.empty || 'Nessun brano.'}</div>`;
  const cur = currentTrack();
  const art = opts.art !== false, alb = opts.showAlbum !== false;
  return `<div class="songs tracklist${alb ? '' : ' noalb'}${opts.queue ? ' q' : ''}">
    <div class="th${art ? '' : ' noart'}" aria-hidden="true"><span class="n">#</span><span class="tt">Titolo</span>${alb ? '<span class="al">Album</span>' : ''}<span class="d">${ic('clock')}</span><span></span></div>${tracks.map((t, i) => `
    <div class="song ${art ? '' : 'noart'} ${cur && key(cur) === key(t) ? 'now' : ''}" data-act="${opts.queue ? 'qplay' : 'play'}" data-i="${i}">
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
  view.innerHTML = `<h1>Benvenuto in Armony</h1><p class="sub">La musica della vostra compagnia, dai vostri server.</p>
  <div class="empty"><h3>Collega il primo server</h3><p>Accedi con il tuo utente del server musicale, oppure creane uno se chi lo gestisce ti ha dato un invito.</p>
  <div class="row" style="justify-content:center">
    <button class="btn primary" data-act="addsrv" ${local ? `data-url="${esc(location.origin)}"` : ''}>Aggiungi server</button>
    <button class="btn" data-act="importset">Importa impostazioni da un amico</button>
    <a class="btn" href="#/jam">Entra in una Jam</a>
  </div></div>`;
}

// link d'invito (<server>/#/invito/<codice>): apre "Crea un account" con indirizzo e codice già compilati
function vInvite(code) {
  noServer();
  serverDialog(null, { url: NATIVE ? '' : location.origin, mode: 'crea', code: code || '' });
}

/* ================= L: intestazioni di pagina, barra azioni, schede artista, riquadri colorati ================= */
function lPhero({ kind, title, art = '', round = false, meta = '', tile = '', ph }) {
  const url = ph ? coverUrl(ph, 300) : '';
  if (url) Glow.colors(url).then(c => { const el = $('#view .phero'); if (el && Glow.usable(c)) el.style.setProperty('--ph', Glow.tone(c.c1, .55, c.neutral)); });
  return `<header class="phero${round ? ' round' : ''}"${tile.startsWith('#') ? ` style="--ph:${tile}"` : ''}><div class="phero-art${tile ? ' tile' : ''}"${tile ? ` style="--tile:${tile}"` : ''}>${art}</div>
    <div class="phero-txt"><span class="phero-kind">${kind}</span><h1 class="phero-title">${esc(title)}</h1>${meta ? `<p class="phero-meta">${meta}</p>` : ''}</div></header>`;
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
    ${offline ? `<button class="icon-btn ab" data-act="offlineall" aria-label="Salva per l'offline" title="Offline">${ic('offline')}</button>` : ''}
    ${addpl ? `<button class="icon-btn ab" data-act="addalltopl" aria-label="Aggiungi a una playlist" title="Aggiungi a playlist">${ic('addlist')}</button>` : ''}
    ${extra}${lMoreItems.length ? `<button class="icon-btn ab" data-act="lmore" aria-label="Altre azioni" title="Altro">${ic('more')}</button>` : ''}
  </div>`;
}
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
// tempo reale: mentre una playlist o un album sono aperti, i brani nuovi entrano al loro posto e quelli tolti escono,
// senza ridisegnare la pagina (ogni 20 s, e subito all'evento 'libreria' di Bus)
function lLive(n, fetch, opts, after) {
  const check = async () => {
    if (stale(n)) return Bus.removeEventListener('libreria', check);
    let songs; try { songs = await fetch(); } catch { return; }
    if (stale(n)) return;
    if (S.lastList.map(t => t.id).join() === songs.map(t => t.id).join()) return;
    lMerge(songs, opts); after?.(songs);
  };
  viewInterval(check, 20000); Bus.addEventListener('libreria', check);
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
    if (el) { el.dataset.i = i; el.querySelectorAll('[data-i]').forEach(b => b.dataset.i = i); const nn = el.querySelector('.n'); if (nn) nn.textContent = nu.querySelector('.n')?.textContent || ''; }
    else { el = nu; el.classList.add('arrivato'); }
    box.append(el);
  });
  keep.forEach(list => list.forEach(el => el.remove()));
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
  if (!navigator.onLine) { location.hash = '#/offline'; return; }
  const n = Scene.nav;
  const [nw, rnd, freq, recent] = await Promise.all([
    api('getAlbumList2', { type: 'newest', size: 18 }),
    api('getAlbumList2', { type: 'random', size: 18 }),
    api('getAlbumList2', { type: 'frequent', size: 18 }).catch(() => null),
    api('getAlbumList2', { type: 'recent', size: 18 }).catch(() => null)
  ]);
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
  view.innerHTML = `<h1 class="hhello">${hello}, ${esc(P.nick || s.user)}</h1>
    <div id="resume"></div><div id="friendsStrip"></div>
    ${quick.length ? `<div class="quick">${quick.map(a => `<div class="qk" data-act="album" data-id="${esc(a.id)}" role="link" tabindex="0">
      <span class="qk-art">${imgTag(a.coverArt, 160)}</span><b>${esc(a.name)}</b>
      <button class="qk-play" data-act="playalb" data-id="${esc(a.id)}" aria-label="Riproduci ${esc(a.name)}">${ic('play', true)}</button></div>`).join('')}</div>` : ''}
    ${secHead('Fatti per te')}
    <div class="hgrid shelf">
      ${mix('radio', 'Mix casuale', 'Ottanta brani a caso da tutta la libreria', 'shuffle', '#d1345b')}
      ${mix('mixfav', 'I tuoi preferiti', 'I brani col cuore, mescolati', 'heart', '#8d4fc2')}
      ${mix('mixforgot', 'Riscoperte', 'Quello che non senti da almeno due mesi', 'radio', '#16825d')}
      ${dec ? mix('decademix', `Anni ${String(dec).slice(2)}`, 'Il decennio che ascolti di più', 'album', '#c2560a', `data-y="${dec}"`) : ''}
      <a class="hmix" href="#/jam" style="--h1:#2d46b9"><span class="hmix-art">${ic('jam')}<b>Jam</b></span><span class="hmix-t"><b>Avvia una Jam</b><small>Ascoltate insieme, ognuno dal suo telefono</small></span></a>
    </div>
    ${L(recent).length ? secHead('Ascoltati di recente') + albumGrid(L(recent), { strip: true }) : ''}
    ${secHead('Aggiunti di recente', 'newest')}${albumGrid(L(nw), { strip: true })}
    ${L(freq).length ? secHead('I più ascoltati', 'frequent') + albumGrid(L(freq), { strip: true }) : ''}
    ${secHead('Da riscoprire', 'random')}${albumGrid(L(rnd), { strip: true })}`;
  QSync.check().then(q => {
    if (!q || !$('#resume')) return;
    $('#resume').innerHTML = `<div class="hbanner">${q.current.coverArt ? `<span class="hb-art">${imgTag(q.current.coverArt, 96, q.current.serverId)}</span>` : ''}
      <span class="grow"><small>Su un altro dispositivo${q.by ? ` (${esc(q.by)})` : ''}</small><b>${esc(q.current.title)}</b></span>
      <button class="btn sm primary" id="resumeBtn">${ic('play', true)} Riprendi da ${fmt(q.position)}</button></div>`;
    $('#resumeBtn').onclick = () => { S.queue = q.tracks; playIndex(q.index, { startAt: q.position }); $('#resume').innerHTML = ''; };
  });
  friendsNow().then(list => {
    const box = $('#friendsStrip'); if (!box || !list.length) return;
    box.innerHTML = `<a class="hbanner" href="#/amici">${ic('friends')}<span class="grow"><small>Amici in ascolto</small><b>${list.slice(0, 2).map(f => `${esc(f.username)}: ${esc(f.title)}`).join(' · ')}${list.length > 2 ? ` e altri ${list.length - 2}` : ''}</b></span>${ic('chevr')}</a>`;
  });
}
async function vLibrary(tab = 'artisti') {
  if (!srv()) return noServer();
  tab = tab || 'artisti';
  const n = Scene.nav;
  const tabs = `<h1>Libreria</h1><div class="lpills" role="navigation" aria-label="Sezioni della libreria">${[['artisti', 'Artisti'], ['album', 'Album'], ['generi', 'Generi'], ['brani', 'Brani a caso']].map(([k, l]) => `<a href="#/libreria/${k}" class="${k === tab ? 'on' : ''}"${k === tab ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</div>`;
  if (tab === 'artisti') {
    const idx = arr((await api('getArtists')).artists.index);
    if (stale(n)) return;
    const tot = idx.reduce((k, x) => k + arr(x.artist).length, 0);
    view.innerHTML = tabs + `<p class="sub">${tot} artisti</p>` + (tot ? `<div class="lcards">` +
      idx.map(x => `<div class="lletter">${esc(x.name)}</div>` + arr(x.artist).map(lArtistCard).join('')).join('') + '</div>' : '<div class="empty">Nessun artista. Aggiungi musica alla cartella del server.</div>');
  } else if (tab === 'album') {
    let offset = 0, sort = sessionStorage.getItem('armony:asort') || 'alphabeticalByName';
    view.innerHTML = tabs + `<div class="lbar"><label class="lsort">${ic('sliders')}<select id="aSort" aria-label="Ordina gli album">
      ${[['alphabeticalByName', 'Per titolo'], ['alphabeticalByArtist', 'Per artista'], ['newest', 'Aggiunti di recente'], ['frequent', 'Più ascoltati'], ['starred', 'Preferiti'], ['random', 'A caso']].map(([v, l]) => `<option value="${v}"${v === sort ? ' selected' : ''}>${l}</option>`).join('')}
      </select></label></div><div id="aGrid"></div><div class="row" style="justify-content:center;margin-top:20px"><button class="btn" id="aMore">Carica altri</button></div>`;
    const load = async (reset) => {
      if (reset) { offset = 0; $('#aGrid').innerHTML = ''; }
      const al = arr((await api('getAlbumList2', { type: sort, size: 60, offset })).albumList2.album);
      if (stale(n)) return;
      $('#aGrid').insertAdjacentHTML('beforeend', albumGrid(al, { empty: offset ? 'Non ci sono altri album.' : 'Nessun album.' }));
      offset += al.length; $('#aMore').hidden = al.length < 60;
    };
    $('#aSort').onchange = e => { sort = e.target.value; sessionStorage.setItem('armony:asort', sort); load(true); };
    $('#aMore').onclick = () => load(false);
    await load(true);
  } else if (tab === 'generi') {
    const g = arr((await api('getGenres')).genres.genre).sort((a, b) => a.value.localeCompare(b.value));
    if (stale(n)) return;
    view.innerHTML = tabs + (g.length ? `<div class="ltiles">${g.map(x => `<a class="ltile" style="--tile:${tileColor(x.value)}" href="#/genere/${encodeURIComponent(x.value)}"><b>${esc(x.value)}</b><small>${x.songCount} ${x.songCount === 1 ? 'brano' : 'brani'} · ${x.albumCount} album</small></a>`).join('')}</div>` : '<div class="empty">Nessun genere nei metadati dei brani.</div>');
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
  let info = null; try { info = (await api('getArtistInfo2', { id, count: 12 })).artistInfo2; } catch {}
  let top = []; try { top = arr((await api('getTopSongs', { artist: a.name, count: 10 })).topSongs?.song).map(x => norm(x)); } catch {}
  const early = dzP && await Promise.race([dzP, new Promise(r => setTimeout(r, 3000))]);
  if (stale(n)) return;
  const bio = (info?.biography || '').replace(/<a[^>]*>.*?<\/a>/g, '').replace(/<[^>]+>/g, '').trim();
  // luce dalla copertina sul server (stessa origine): l'immagine grande dell'artista spesso è di un altro dominio
  Glow.show(coverUrl(a.coverArt || arr(a.album)[0]?.coverArt, 300), 'album');
  const albums = arr(a.album), sim = arr(info?.similarArtist).filter(x => x.id);
  const img = info?.largeImageUrl ? `<img src="${esc(info.largeImageUrl)}" alt="" onerror="this.remove()">` : imgTag(a.coverArt, 500);
  view.innerHTML = lPhero({ kind: 'Artista', title: a.name, ph: a.coverArt, art: img, round: true, meta: `${albums.length} album${top.length ? ` · ${top.length} brani popolari` : ''}` }) +
    lActionBar({ play: { act: 'artistall', data: { id }, label: 'Riproduci tutto' }, shuffle: { act: 'artistradio', data: { id, name: a.name }, icon: 'radio', label: 'Radio dell\'artista' }, offline: false, addpl: false }) +
    (top.length ? `<h2>Popolari</h2><div class="ltop" id="lTop">${songList(top)}</div>${top.length > 5 ? `<button class="lmorebtn" id="lTopMore">Mostra altri</button>` : ''}` : '') +
    `<div id="lDisco">${discoHtml(albums, early?.[0])}</div><div id="lSim">${simHtml(sim, early?.[0], early?.[1])}</div>` +
    (bio ? `<h2>Informazioni</h2><p class="lbio">${esc(bio.slice(0, 700))}${bio.length > 700 ? '…' : ''}</p>` : '');
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
  const tot = songs.reduce((n, t) => n + t.duration, 0);
  const discs = new Set(songs.map(s => s.disc)).size;
  const opts = { showAlbum: false, art: false, numbers: true };
  Glow.show(coverUrl(a.coverArt, 300), 'album');
  view.innerHTML = lPhero({ kind: 'Album', title: a.name, ph: a.coverArt, art: imgTag(a.coverArt, 500),
      meta: `<a href="#/artista/${encodeURIComponent(a.artistId || '')}"><b>${esc(a.artist)}</b></a>${a.year ? ' · ' + a.year : ''}${a.genre ? ' · ' + esc(a.genre) : ''} · ${songs.length} ${songs.length === 1 ? 'brano' : 'brani'}, ${fmtLong(tot)}${discs > 1 ? ' · ' + discs + ' dischi' : ''}` }) +
    lActionBar({ star: { act: 'staralbum', on: a.starred, data: { id, on: a.starred ? 1 : 0 } }, more: [
      { act: 'enqueueall', label: 'Aggiungi alla coda', icon: 'queue' },
      { act: 'shareitem', label: 'Condividi un link', icon: 'share', data: { id, name: a.name } },
      canEdit() && { act: 'editalbum', label: 'Modifica album', icon: 'pen' },
      canDelete() && { act: 'delalbum', label: 'Elimina album dal server', icon: 'trash', danger: true, data: { name: a.name } }] }) +
    `<div id="gapsNote"></div><div id="lList">${songList(songs, opts)}</div>`;
  albumGaps(a, songs, n);
  // tempo reale: le tracce scaricate entrano nell'album appena Navidrome le vede, le grigie si ricalcolano
  let raw = a;
  lLive(n, async () => { raw = (await api('getAlbum', { id })).album; return arr(raw.song).map(x => norm(x)); }, opts,
    fresh => { $('#gapsNote').innerHTML = ''; albumGaps(raw, fresh, n); });
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
  gapButtons(box, miss, { album: a.name, albumartist: a.artist || sc.albumartist, date: sc.date || (a.year ? String(a.year) : ''), cover: sc.cover });
}
// tasti "Scarica" delle righe fantasma ([data-gap] = indice in miss) e "Scarica tutte" (#gapsAll): /api/import, stessa cartella
function gapButtons(box, miss, alb) {
  const send = async ks => {
    const tracks = ks.map(k => { const t = miss[k]; return { title: t.title, artists: t.artists, ...alb, duration: t.duration, track: t.track, disc: t.disc, isrc: t.isrc }; });
    try {
      const r = await dlApi('/api/import', { method: 'POST', body: JSON.stringify({ tracks, folder: store.get('impDir', 'Spotify') }) });
      ks.forEach(k => { const b = box.querySelector(`[data-gap="${k}"]`); if (b) b.outerHTML = '<span class="tag">in coda</span>'; });
      if (!box.querySelector('[data-gap]')) $('#gapsAll')?.remove();
      toast(r.added ? `${r.added} ${r.added === 1 ? 'traccia in coda' : 'tracce in coda'}: arrivano nell'album appena scaricate.` : 'Già in coda.');
    } catch (e) { toast(e.message); }
  };
  box.querySelectorAll('[data-gap]').forEach(b => b.onclick = e => { e.stopPropagation(); send([+b.dataset.gap]); });
  $('#gapsAll').onclick = () => send([...box.querySelectorAll('[data-gap]')].map(b => +b.dataset.gap));
}
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
async function vSearch() {
  if (!srv()) return noServer();
  const n = Scene.nav;
  view.innerHTML = `<h1 class="hhello">Cerca</h1>
    <label class="hsearch">${ic('search')}<input type="search" id="q" placeholder="Cosa vuoi ascoltare?" aria-label="Cerca brani, artisti, album" enterkeyhint="search" autocomplete="off"></label>
    <div id="res"></div>`;
  let t;
  const q = $('#q'); q.value = sessionStorage.getItem('armony:q') || '';
  if (!NATIVE && matchMedia('(pointer:fine)').matches) q.focus();
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
          <a class="btn primary" href="#/scarica/cerca/${encodeURIComponent(v)}">${ic('down')} Cerca "${esc(v)}" online</a></div>`;
        return;
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
        ${al.length ? `<div class="hsec"><h2>Album</h2></div>${albumGrid(al, { strip: true })}` : ''}</div>`;
     
      $('#allSongs')?.addEventListener('click', e => { $('#songsBox').innerHTML = listActions() + songList(so); e.target.remove(); $('#res .hbest-wrap').classList.add('open'); });
    } catch (e) { $('#res').innerHTML = `<p class="sub">${esc(e.message)}</p>`; }
  };
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 260); });
  q.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(t); run(); } });
  run();
}
async function vPlaylists() {
  if (!srv()) return noServer();
  const n = Scene.nav;
  const pls = arr((await api('getPlaylists')).playlists.playlist);
  if (stale(n)) return;
  view.innerHTML = `<h1>Playlist</h1><p class="sub">Le playlist condivise si vedono da tutti gli utenti del server.</p>
    <div class="lcards">
      <button class="lcard special" data-act="newpl"><div class="lcover">${ic('plus')}</div><b>Nuova playlist</b><small>Vuota, da riempire</small></button>
      <button class="lcard special alt" data-act="importpl"><div class="lcover">${ic('down')}</div><b>Importa da Spotify</b><small>CSV di Exportify, M3U, JSON</small></button>
      ${pls.map(lPlCard).join('')}
    </div>`;
}

async function vPlaylist(id) {
  const n = Scene.nav;
  const p = (await api('getPlaylist', { id })).playlist;
  if (stale(n)) return;
  const songs = arr(p.entry).map(x => norm(x));
  const count = q => { const k = arr(q.entry).length; return `${k} ${k === 1 ? 'brano' : 'brani'}, ${fmtLong(q.duration || 0)}`; };
  const empty = { empty: 'Playlist vuota. Aggiungi brani dal menu ⋯ accanto a ogni canzone.' };
  Glow.show(coverUrl(p.coverArt, 300), 'album');
  view.innerHTML = lPhero({ kind: p.public ? 'Playlist condivisa' : 'Playlist', title: p.name, ph: p.coverArt, art: p.songCount ? imgTag(p.coverArt, 500) : ic('list'),
      meta: `${p.comment ? `<span class="phero-desc">${esc(p.comment)}</span>` : ''}${p.owner ? `<b>${esc(p.owner)}</b> · ` : ''}<span id="lCount">${count(p)}</span>` }) +
    lActionBar({ more: [
      { act: 'enqueueall', label: 'Aggiungi alla coda', icon: 'queue' },
      { act: 'shareitem', label: 'Condividi un link', icon: 'share', data: { id, name: p.name } },
      { act: 'exportpl', label: 'Esporta (M3U, JSON, CSV)', icon: 'down', data: { id } },
      { act: 'editpl', label: 'Modifica nome e descrizione', icon: 'pen', data: { id } },
      { act: 'delpl', label: 'Elimina playlist', icon: 'trash', danger: true, data: { id } }] }) +
    `<div id="lList">${songList(songs, empty)}</div>`;
  view.dataset.pl = id;
  view.dataset.plMeta = JSON.stringify({ name: p.name, comment: p.comment || '', public: !!p.public });
  // tempo reale: brani aggiunti da altri dispositivi o arrivati dai download entrano senza ricaricare
  lLive(n, async () => { const q = (await api('getPlaylist', { id })).playlist; const c = $('#lCount'); if (c) c.textContent = count(q); return arr(q.entry).map(x => norm(x)); }, empty);
}

async function vStarred() {
  if (!srv()) return noServer();
  const n = Scene.nav;
  const r = (await api('getStarred2')).starred2;
  if (stale(n)) return;
  const songs = arr(r.song).map(x => norm(x)), ar = arr(r.artist), al = arr(r.album);
  view.innerHTML = lPhero({ kind: 'Raccolta', title: 'Preferiti', tile: 'linear-gradient(135deg,#4a2fbd,#c7a0ff)', art: ic('heart', true),
      meta: `${songs.length} brani · ${al.length} album · ${ar.length} artisti` }) +
    lActionBar({ more: [{ act: 'enqueueall', label: 'Aggiungi alla coda', icon: 'queue' }] }) +
    `<div id="lList">${songList(songs, { empty: 'Tocca il cuore accanto a un brano per ritrovarlo qui.' })}</div>` +
    (al.length ? `<h2>Album</h2>${albumGrid(al, { strip: true })}` : '') +
    (ar.length ? `<h2>Artisti</h2><div class="lcards shelfish">${ar.map(lArtistCard).join('')}</div>` : '');
}

function vQueue() {
  if (Jam.role === 'guest') {
    view.innerHTML = `<h1>Coda della Jam</h1><p class="sub">La coda la gestisce l'host. Puoi proporre brani e votare dalla pagina Jam.</p><a class="btn primary" href="#/jam">Apri la Jam</a>`; return;
  }
  const tot = S.queue.slice(Math.max(0, S.index)).reduce((n, t) => n + t.duration, 0);
  view.innerHTML = `<h1>Coda</h1><p class="sub">${S.queue.length} brani, ${fmtLong(tot)} rimanenti. Può contenere brani di server diversi.</p>
    <div class="row" style="margin-bottom:16px">
      <button class="btn" data-act="savequeue">Salva come playlist</button>
      <button class="btn" data-act="exportqueue">Esporta</button>
      <button class="btn" data-act="dedupe">Togli doppioni</button>
      <button class="btn danger" data-act="clearqueue">Svuota</button>
    </div>${songList(S.queue, { queue: true, empty: 'La coda è vuota.' })}`;
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
      const r = indexedDB.open('armony', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('offline', { keyPath: 'key' });
        d.createObjectStore('history', { keyPath: 'n', autoIncrement: true }).createIndex('ts', 'ts');
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
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
  keys: st => DB.run(st, 'readonly', s => s.getAllKeys()),
  clear: st => DB.run(st, 'readwrite', s => s.clear()),
  putMany: (st, list) => DB.run(st, 'readwrite', s => { list.forEach(v => s.put(v)); })
};

/* ================= offline ================= */
const Offline = {
  keys: new Set(), busy: false,
  async init() { try { (await DB.keys('offline')).forEach(k => this.keys.add(k)); } catch {} },
  has(t) { return !!t && this.keys.has(key(t)); },
  async url(t) { try { const r = await DB.get('offline', key(t)); return r ? URL.createObjectURL(r.blob) : null; } catch { return null; } },
  async save(tracks) {
    const todo = tracks.filter(t => !this.has(t));
    if (!todo.length) return toast('Questi brani sono già disponibili offline.');
    if (this.busy) return toast('Sto già salvando altri brani, attendi.');
    this.busy = true; navigator.storage?.persist?.();
    let done = 0, fail = 0;
    for (const t of todo) {
      toast(`Salvo per l'offline ${done + 1} di ${todo.length}…`, 60000);
      try {
        const r = await fetch(streamUrl(t, P.offlineQ)); if (!r.ok) throw 0;
        const blob = await r.blob();
        let cover = null;
        if (t.coverArt) { try { const c = await fetch(coverUrl(t.coverArt, 300, t.serverId)); if (c.ok) cover = await c.blob(); } catch {} }
        await DB.put('offline', { key: key(t), track: t, blob, cover, size: blob.size, q: P.offlineQ, added: Date.now() });
        this.keys.add(key(t)); done++;
      } catch { fail++; }
    }
    this.busy = false;
    toast(fail ? `${done} brani salvati, ${fail} non riusciti.` : `${done} brani disponibili offline.`);
    if (location.hash.startsWith('#/offline')) route();
  },
  async remove(k) { await DB.del('offline', k); this.keys.delete(k); }
};

/* ================= storico e statistiche ================= */
const Stats = {
  async add(t) {
    const ts = Date.now();
    try { await DB.put('history', { ts, hid: `${S.device}:${ts}`, synced: false, key: key(t), id: t.id, serverId: t.serverId, title: t.title, artist: t.artist, artistId: t.artistId, album: t.album, albumId: t.albumId, coverArt: t.coverArt, duration: t.duration || 0, genre: t.genre || '' }); } catch {}
    HistSync.schedule();
  },
  all() { return DB.all('history').catch(() => []); }
};

/* ================= storico e preferenze condivisi fra i dispositivi (sul server, per utente) ================= */
const syncable = s => P.sync && s?.session && s.me?.caps?.includes('history');
async function srvApi(s, path, opts = {}) {
  const r = await fetch(absUrl(s.url) + path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Token': s.session, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`Errore ${r.status}`);
  return r.json();
}
const HistSync = {
  busy: false, t: null,
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
      if (P.theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = P.theme;
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
    let res = null; const s = srv(t.serverId);
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
        const u = new URL('https://lrclib.net/api/get');
        u.search = new URLSearchParams({ artist_name: t.artist, track_name: t.title, album_name: t.album || '', duration: Math.round(t.duration || 0) });
        let r = await fetch(u);
        if (r.status === 404) { const s2 = new URL('https://lrclib.net/api/search'); s2.search = new URLSearchParams({ artist_name: t.artist, track_name: t.title }); r = await fetch(s2); }
        if (r.ok) {
          let j = await r.json(); if (Array.isArray(j)) j = j.find(x => x.syncedLyrics) || j[0];
          if (j?.instrumental) res = { instrumental: true };
          else if (j?.syncedLyrics) res = { ...parseLrc(j.syncedLyrics), src: 'LRCLIB' };
          else if (j?.plainLyrics) res = { synced: false, lines: j.plainLyrics.split('\n').map(v => ({ t: null, v })), src: 'LRCLIB' };
        }
      } catch {}
    }
    this.cache.set(k, res); return res;
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
   Catena: piatto → guadagno (normalizzazione + dissolvenza) → EQ 10 bande → compressore (volume notte) → volume → uscita
   L'uscita viene anche resa disponibile come flusso, usato dalla Jam in modalità trasmissione. */
const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  'Piatto': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'Bassi potenti': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0], 'Acuti brillanti': [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  'Voce': [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1], 'Rock': [4, 3, 1, -1, -2, -1, 1, 3, 4, 4], 'Elettronica': [5, 4, 1, 0, -2, 1, 0, 2, 4, 5],
  'Acustica': [3, 2, 1, 1, 2, 2, 3, 3, 2, 1], 'Classica': [3, 2, 1, 0, 0, 0, -1, 1, 2, 3], 'Cuffiette piccole': [5, 4, 3, 1, 0, 0, 1, 2, 2, 1],
  'Altoparlante del telefono': [-6, -4, -1, 2, 3, 3, 2, 1, 0, -2]
};
const Engine = {
  decks: [], gains: [], cur: 0, ctx: null, master: null, eq: [], comp: null, analyser: null, dest: null, fading: false, blobUrls: [null, null], scrobbled: null,
  init() {
    for (let i = 0; i < 2; i++) {
      const a = document.createElement('audio'); a.preload = 'auto';
      if (!P.compat) a.crossOrigin = 'anonymous';
      a.preservesPitch = true;
      document.body.append(a); this.decks.push(a);
      for (const ev of ['timeupdate', 'play', 'pause', 'ended', 'error', 'loadedmetadata', 'playing']) a.addEventListener(ev, e => this.on(ev, i, e));
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
      this.eq = EQ_FREQS.map((f, i) => { const b = ctx.createBiquadFilter(); b.type = i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking'; b.frequency.value = f; b.Q.value = 1.1; return b; });
      this.decks.forEach((a, i) => { const src = ctx.createMediaElementSource(a); const g = ctx.createGain(); g.gain.value = i === this.cur ? this.rg(currentTrack()) : 0; src.connect(g); g.connect(this.eq[0]); this.gains[i] = g; });
      this.eq.reduce((p, n) => { p.connect(n); return n; });
      this.comp = ctx.createDynamicsCompressor(); this.master = ctx.createGain();
      this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 512; this.analyser.smoothingTimeConstant = .8;
      this.eq[9].connect(this.comp); this.comp.connect(this.master); this.master.connect(this.analyser); this.analyser.connect(ctx.destination);
      this.dest = ctx.createMediaStreamDestination(); this.master.connect(this.dest);
      this.applyEq(); this.applyNight(); this.applyVolume();
    } catch (e) { console.warn('Web Audio non disponibile', e); this.ctx = null; }
  },
  applyEq() { this.eq.forEach((b, i) => { b.gain.value = P.eqOn ? (P.eq[i] || 0) : 0; }); },
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
  async load(t, i, { autoplay = true, startAt = 0 } = {}) {
    const a = this.decks[i], k = key(t);
    a.dataset.key = k; a.dataset.q = activeQuality();
    const blob = Offline.has(t) ? await Offline.url(t) : null;
    if (a.dataset.key !== k) { if (blob) URL.revokeObjectURL(blob); return false; }
    if (this.blobUrls[i]) URL.revokeObjectURL(this.blobUrls[i]);
    this.blobUrls[i] = blob;
    a.src = blob || streamUrl(t); a.playbackRate = P.speed;
    if (startAt) a.addEventListener('loadedmetadata', () => { try { a.currentTime = startAt; } catch {} }, { once: true });
    this.setGain(i, i === this.cur ? this.rg(t) : 0);
    if (autoplay) { this.graph(); try { await a.play(); } catch (e) { if (e.name === 'NotAllowedError') toast('Tocca play per iniziare.'); } }
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
      const off = !navigator.onLine;
      toast(off ? 'Sei offline e questo brano non è salvato sul dispositivo.' : 'Impossibile riprodurre questo brano, passo al successivo.');
      if (Jam.role !== 'guest') setTimeout(() => ctlNext(true), 1500);
      return;
    }
    if (ev === 'timeupdate') { this.tick(); emit('time'); }
    else if (ev === 'play' || ev === 'playing') { paintButtons(); emit('play'); }
    else if (ev === 'pause') { paintButtons(); emit('pause'); QSync.schedule(); }
    else if (ev === 'ended') this.ended();
    else if (ev === 'loadedmetadata') emit('time');
  },
  tick() {
    const a = this.el, t = currentTrack(); if (!t) return;
    if (this.scrobbled !== key(t) + '@' + S.index && a.currentTime > Math.min(240, (t.duration || 60) / 2)) {
      this.scrobbled = key(t) + '@' + S.index;
      if (srv(t.serverId)) api('scrobble', { id: t.id, submission: true }, srv(t.serverId)).catch(() => {});
      Stats.add(t);
    }
    if (Math.floor(a.currentTime) % 5 === 0) store.set('pos', a.currentTime);
    if (Jam.role === 'guest') return;
    const rem = a.duration - a.currentTime; if (!isFinite(rem)) return;
    const n = this.nextIndex(); if (n == null || S.repeat === 'one' || Sleep.eot) return;
    const nt = S.queue[n];
    if (rem < 30 && this.idle.dataset.key !== key(nt) && !this.fading) this.load(nt, 1 - this.cur, { autoplay: false });
    if (P.crossfade > 0 && this.ctx && !this.fading && rem <= P.crossfade && rem > .3) this.crossfade(n, rem);
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
    if (Jam.role === 'guest') return;
    if (Sleep.eot) { Sleep.clear(); toast('Fine brano: buonanotte.'); paintButtons(); return; }
    if (S.repeat === 'one') { this.el.currentTime = 0; this.el.play(); return; }
    const n = this.nextIndex();
    if (n == null) { paintButtons(); emit('pause'); return; }
    playIndex(n);
  },
  time() { return this.el.currentTime || 0; },
  duration() { const d = this.el.duration; return isFinite(d) && d > 0 ? d : (currentTrack()?.duration || 0); },
  stop() { this.decks.forEach(d => { d.pause(); d.removeAttribute('src'); d.dataset.key = ''; d.load(); }); }
};

/* ================= riproduzione ================= */
function currentTrack() { return Jam.role === 'guest' ? Jam.track : Live.remote() ? Live.track() : S.queue[S.index]; }
const broadcastGuest = () => Jam.role === 'guest' && Jam.mode === 'broadcast';
function isPlaying() { return broadcastGuest() ? Jam.playing : Live.remote() ? Live.playing() : !Engine.el.paused; }
function playPos() { return broadcastGuest() ? Jam.estPos() : Live.remote() ? Live.pos() : Engine.time(); }
function playDur() { return broadcastGuest() ? (Jam.track?.duration || 0) : Live.remote() ? Live.dur() : Engine.duration(); }
function persistQueue() { store.set('queue', S.queue.slice(0, 3000)); store.set('index', S.index); }
function setQueue(tracks, start = 0, shuffle = false) {
  if (Jam.role === 'guest') { tracks[start] && Jam.suggest(tracks[start]); return; }
  if (!tracks.length) return toast('Non ci sono brani da riprodurre.');
  let q = tracks.slice();
  if (shuffle) { q = shuffleArr(q); start = 0; }
  if (Live.remote()) return Live.cmd('transfer', Live.pack(q, start, 0));  // l'uscita scelta è un altro dispositivo
  S.queue = q; playIndex(start);
}
async function playIndex(i, o = {}) {
  if (Jam.role === 'guest') return Jam.guestControl('jump', i);
  if (i < 0 || i >= S.queue.length) return;
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
  if (t && srv(t.serverId) && Jam.role !== 'guest') api('scrobble', { id: t.id, submission: false }, srv(t.serverId)).catch(() => {});
  QSync.schedule(); emit('track', t);
  if (location.hash.startsWith('#/ora')) vNow();
  else if (location.hash.startsWith('#/coda')) vQueue();
}
function ctlToggle() {
  if (Jam.role === 'guest') return Jam.guestControl(isPlaying() ? 'pause' : 'play');
  if (Live.remote()) return Live.cmd('toggle');
  const a = Engine.el;
  if (!a.getAttribute('src')) { if (S.queue.length) playIndex(Math.max(0, S.index)); return; }
  Engine.graph(); a.paused ? a.play().catch(() => {}) : a.pause();
}
function ctlNext(auto) {
  if (Jam.role === 'guest') return Jam.guestControl('next');
  if (Live.remote()) return auto ? undefined : Live.cmd('next');
  const n = S.index < S.queue.length - 1 ? S.index + 1 : (S.repeat === 'all' ? 0 : null);
  if (n != null) playIndex(n); else if (auto) Engine.el.pause();
}
function ctlPrev() {
  if (Jam.role === 'guest') return Jam.guestControl('prev');
  if (Live.remote()) return Live.cmd('prev');
  if (Engine.time() > 4 || S.index <= 0) ctlSeek(0); else playIndex(S.index - 1);
}
function ctlSeek(sec) {
  if (Jam.role === 'guest') return Jam.guestControl('seek', sec);
  if (Live.remote()) return Live.cmd('seek', Math.max(0, sec));
  try { Engine.el.currentTime = Math.max(0, sec); } catch {}
  emit('seek');
}
function ctlShuffle() {
  S.shuffle = !S.shuffle; store.set('shuffle', S.shuffle);
  if (S.shuffle && S.queue.length > S.index + 2) { S.queue = [...S.queue.slice(0, S.index + 1), ...shuffleArr(S.queue.slice(S.index + 1))]; persistQueue(); emit('queue'); if (location.hash.startsWith('#/coda')) vQueue(); }
  paintButtons();
}
function ctlRepeat() { S.repeat = { off: 'all', all: 'one', one: 'off' }[S.repeat]; store.set('repeat', S.repeat); paintButtons(); }
function updateNowPlaying() {
  const t = currentTrack();
  $('#npT').textContent = t ? t.title : 'Niente in riproduzione';
  $('#npA').textContent = t ? t.artist + (t.album ? ' · ' + t.album : '') : (Jam.role === 'guest' ? 'In attesa dell\'host della Jam' : 'Scegli un album o una playlist');
  $('#disc').innerHTML = t && t.coverArt && srv(t.serverId) ? `<img src="${esc(coverUrl(t.coverArt, 80, t.serverId))}" alt="" onerror="this.outerHTML='<div class=lbl></div>'">` : '<div class="lbl"></div>';
  document.title = t ? `${t.title} · ${t.artist}` : 'Armony';
  Glow.track(t);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = t ? new MediaMetadata({ title: t.title, artist: t.artist, album: t.album,
      artwork: t.coverArt && srv(t.serverId) ? [{ src: coverUrl(t.coverArt, 512, t.serverId), sizes: '512x512' }] : [] }) : null;
  }
  paintButtons(); NativeMedia.sync(); Live.publish();
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
  Turntable.set($('#disc'), playing); Turntable.set($('#bigdisc .rec'), playing); Wave.set(playing);
  const rs = Live.remote() ? Live.st() : null, shuf = rs ? !!rs.shuffle : S.shuffle, rep = rs ? rs.repeat || 'off' : S.repeat;
  $('#bShuf').innerHTML = ic('shuffle'); $('#bShuf').classList.toggle('on', shuf);
  $('#bRep').innerHTML = ic('repeat') + (rep === 'one' ? '<span class="mini">1</span>' : '');
  $('#bRep').classList.toggle('on', rep !== 'off');
  $('#bRep').title = { off: 'Ripeti: no', all: 'Ripeti: tutta la coda', one: 'Ripeti: questo brano' }[rep];
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  NativeMedia.sync(); Live.publish();
}
let seeking = false;
const rangeFill = el => { if (!el) return; el.style.setProperty('--p', ((el.value - (el.min || 0)) / ((el.max || 100) - (el.min || 0)) * 100) + '%'); if (el.id === 'seek') Wave.draw(); };
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
  schedule() { if (!P.syncQueue || Jam.role === 'guest') return; clearTimeout(this.t); this.t = setTimeout(() => this.push(), 4000); },
  async push() {
    const cur = S.queue[S.index]; if (!cur || !srv(cur.serverId)) return;
    const ids = S.queue.filter(x => x.serverId === cur.serverId).slice(0, 1000).map(x => x.id);
    try { await api('savePlayQueue', { id: ids, current: cur.id, position: Math.floor(Engine.time() * 1000) }, srv(cur.serverId), true); store.set('qsyncSaved', Date.now()); } catch {}
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
  const n = Scene.nav;
  view.innerHTML = `<h1>Amici</h1><p class="sub">Chi sta ascoltando cosa su ${esc(srv().name)}, in tempo reale.</p><div id="fl"></div>
    <h2>Jam vicine</h2><div id="fj"><p class="sub">Cerco…</p></div>`;
  const paint = async () => {
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
    const c = await this.colors(url), seek = $('#seekWave'); if (!seek || currentTrack() !== t) return;
    if (this.usable(c)) seek.style.setProperty('--tint', this.tone(c.c1, .9, c.neutral)); else seek.style.removeProperty('--tint');
  }
};
addEventListener('hashchange', () => { if (!/^#\/(ora|album|artista)/.test(location.hash)) Glow.off(); });

/* ================= in riproduzione: testi e visualizzatore ================= */
async function vNow() {
  const t = currentTrack();
  if (!t) { Glow.off(); view.innerHTML = '<div class="empty"><h3>Niente in riproduzione</h3><p>Scegli qualcosa da ascoltare.</p><a class="btn primary" href="#/home">Vai alla home</a></div>'; return; }
  Glow.show(t.coverArt && srv(t.serverId) ? coverUrl(t.coverArt, 300, t.serverId) : '', 'ora');
  const tab = sessionStorage.getItem('armony:nowtab') || 'lyr';
  view.innerHTML = `<div class="now"><div>
      <div class="bigdisc ${isPlaying() ? 'spin' : ''}" id="bigdisc"><canvas id="viz" width="640" height="640"></canvas>
        <div class="rec">${t.coverArt && srv(t.serverId) ? `<img src="${esc(coverUrl(t.coverArt, 600, t.serverId))}" alt="">` : '<div class="lbl"></div>'}</div></div>
      <h1 style="margin-top:18px">${esc(t.title)}</h1>
      <p class="sub">${t.artistId ? `<a href="#/artista/${encodeURIComponent(t.artistId)}">${esc(t.artist)}</a>` : esc(t.artist)}${t.album ? ` · ${t.albumId ? `<a href="#/album/${encodeURIComponent(t.albumId)}">${esc(t.album)}</a>` : esc(t.album)}` : ''}</p>
      <div class="row now-acts">
        <button class="btn sm" data-act="nowmore">${ic('more')} Azioni</button>
        <button class="btn sm" data-act="sleep">${ic('moon')} Timer</button>
        <button class="btn sm" data-act="speed">${ic('speed')} ${P.speed}×</button>
        <button class="btn sm" data-act="eq">${ic('sliders')} Equalizzatore</button>
        ${Jam.role ? `<a class="btn sm" href="#/jam">${ic('jam')} Jam</a>` : ''}
      </div>
    </div>
    <div><div class="tabs">${[['lyr', 'Testi'], ['next', 'Prossimi'], ['info', 'Dettagli']].map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div><div id="nowPane"></div></div></div>`;
  view.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { sessionStorage.setItem('armony:nowtab', b.dataset.tab); vNow(); });
  Turntable.set($('#bigdisc .rec'), isPlaying(), true);  // il disco grande nasce già alla velocità del piccolo
  const pane = $('#nowPane');
  let lyr = null;
  if (tab === 'lyr') {
    pane.innerHTML = '<p class="sub">Cerco il testo…</p>';
    lyr = await Lyrics.get(t);
    if (currentTrack() !== t || !$('#nowPane')) return;
    if (!lyr || lyr.instrumental) {
      // senza testo, al suo posto i prossimi brani: niente mezzo schermo vuoto
      const up = Jam.role === 'guest' ? Jam.queue.slice(0, 12) : S.queue.slice(S.index + 1, S.index + 13);
      pane.innerHTML = `<p class="sub">${lyr ? 'Brano strumentale.' : `Nessun testo per questo brano.${P.lyricsOnline ? '' : ' Attiva la ricerca online dei testi nelle impostazioni.'}`}</p>
        ${up.length ? `<h2 style="margin-top:8px">Prossimi</h2>${songList(up)}` : ''}`;
      if (up.length && Jam.role !== 'guest') { S.lastList = up; pane.querySelectorAll('.song').forEach(el => el.dataset.act = 'qplayoff'); }
    }
    else {
      const off = store.get('lyrOff:' + key(t), 0);
      pane.innerHTML = `<div class="lyrics ${lyr.synced ? '' : 'plain'}" id="lyr">${lyr.lines.map((l, i) => `<p data-i="${i}">${esc(l.v) || '&nbsp;'}</p>`).join('')}</div>
        <div class="row between small" style="color:var(--muted)"><span>Fonte: ${esc(lyr.src || '')}</span>${lyr.synced ? `<span class="row">Sincronia <button class="btn sm" data-off="-0.5">−0,5 s</button><span id="offv">${off.toFixed(1)} s</span><button class="btn sm" data-off="0.5">+0,5 s</button></span>` : ''}</div>`;
      if (lyr.synced) {
        $('#lyr').onclick = e => { const p = e.target.closest('p'); if (p) ctlSeek(lyr.lines[+p.dataset.i].t - store.get('lyrOff:' + key(t), 0) + .05); };
        pane.querySelectorAll('[data-off]').forEach(b => b.onclick = () => { const v = +(store.get('lyrOff:' + key(t), 0) + +b.dataset.off).toFixed(1); store.set('lyrOff:' + key(t), v); $('#offv').textContent = v.toFixed(1) + ' s'; });
      }
    }
  } else if (tab === 'next') {
    const up = Jam.role === 'guest' ? Jam.queue.slice(0, 25) : S.queue.slice(S.index + 1, S.index + 26);
    pane.innerHTML = up.length ? songList(up) : '<div class="empty">Non c\'è altro in coda.</div>';
    if (Jam.role !== 'guest') S.lastList = up, pane.querySelectorAll('.song').forEach(el => el.dataset.act = 'qplayoff');
  } else {
    const s = srv(t.serverId);
    let raw = null; try { raw = s && (await api('getSong', { id: t.id }, s)).song; } catch {}
    const rows = [['Server', s?.name || 'non configurato'], ['Formato originale', raw ? `${(raw.suffix || '').toUpperCase()}, ${raw.bitRate || '?'} kbps${raw.samplingRate ? ', ' + (raw.samplingRate / 1000) + ' kHz' : ''}${raw.bitDepth ? ', ' + raw.bitDepth + ' bit' : ''}` : '?'],
      ['Ascolto attuale', Offline.has(t) ? 'Dal dispositivo (offline)' : QUALITIES[activeQuality()].label], ['Genere', t.genre || raw?.genre || '—'], ['Anno', t.year || raw?.year || '—'],
      ['Normalizzazione', t.rg ? `brano ${t.rg.trackGain ?? '—'} dB, album ${t.rg.albumGain ?? '—'} dB` : 'nessun dato ReplayGain'],
      ['Ascolti', raw?.playCount ?? '—'], ['File', raw?.path || '—']];
    pane.innerHTML = `<div class="panel">${rows.map(([a, b]) => `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line);flex-wrap:nowrap;gap:16px"><span style="color:var(--muted)">${a}</span><span style="text-align:right;word-break:break-word">${esc(b)}</span></div>`).join('')}</div>`;
  }
  const canvas = $('#viz'), c2 = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const buf = Engine.analyser ? new Uint8Array(Engine.analyser.frequencyBinCount) : null;
  let lastLine = -1;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const loop = () => {
    if (!document.contains(canvas)) return;
    c2.clearRect(0, 0, 640, 640);
    if (P.visualizer && buf && !reduce && isPlaying() && Jam.mode !== 'broadcast') {
      Engine.analyser.getByteFrequencyData(buf);
      const N = 96; c2.strokeStyle = accent; c2.lineWidth = 4; c2.lineCap = 'round';
      for (let i = 0; i < N; i++) {
        const v = buf[Math.floor(Math.pow(i / N, 1.6) * buf.length * .75)] / 255;
        const ang = i / N * Math.PI * 2 - Math.PI / 2, r1 = 255, r2 = r1 + 8 + v * 52;
        c2.globalAlpha = .35 + v * .65;
        c2.beginPath(); c2.moveTo(320 + Math.cos(ang) * r1, 320 + Math.sin(ang) * r1); c2.lineTo(320 + Math.cos(ang) * r2, 320 + Math.sin(ang) * r2); c2.stroke();
      }
      c2.globalAlpha = 1;
    }
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
    view.innerHTML = `<h1>Statistiche</h1><p class="sub">${sub}</p>
      <div class="stats-empty"><div class="vinyl" aria-hidden="true"></div><div>
        <h3>Il primo ascolto apre le statistiche</h3>
        <p>Ogni brano che ascolti finisce qui: quanti minuti, gli artisti che torni a cercare, le ore in cui suoni di più.</p>
        <div class="row"><button class="btn primary" data-act="radio">${ic('shuffle')} Fai partire un mix casuale</button><a class="btn" href="#/libreria">Sfoglia la libreria</a></div>
      </div></div>`;
    return;
  }
  const label = { '7': 'negli ultimi 7 giorni', '30': 'negli ultimi 30 giorni', year: 'quest\'anno', all: 'da quando usi Armony' }[period];
  view.innerHTML = `<h1>Statistiche</h1><p class="sub">${sub}</p>
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
  view._wrapped = { secs, h, artists, songs, period };
}
async function makeWrapped() {
  const w = view._wrapped; if (!w) return;
  await document.fonts.ready;
  const c = document.createElement('canvas'); c.width = 1080; c.height = 1350; const x = c.getContext('2d');
  x.fillStyle = '#1b1e36'; x.fillRect(0, 0, 1080, 1350);
  const ring = (cx, cy, r) => { for (let i = 0; i < 40; i++) { x.strokeStyle = i % 2 ? '#23264a' : '#191b30'; x.lineWidth = 3; x.beginPath(); x.arc(cx, cy, r - i * 3, 0, Math.PI * 2); x.stroke(); } x.fillStyle = '#f2a541'; x.beginPath(); x.arc(cx, cy, r * .38, 0, Math.PI * 2); x.fill(); x.fillStyle = '#1b1e36'; x.beginPath(); x.arc(cx, cy, 10, 0, Math.PI * 2); x.fill(); };
  ring(900, 200, 240);
  const label = { '7': 'Ultimi 7 giorni', '30': 'Ultimi 30 giorni', year: 'Il mio ' + new Date().getFullYear(), all: 'Da sempre' }[w.period];
  x.fillStyle = '#ece8dd'; x.font = '800 64px "Bricolage Grotesque", sans-serif'; x.fillText('armony', 80, 130);
  x.fillStyle = '#a3a8c8'; x.font = '500 40px Figtree, sans-serif'; x.fillText(label, 80, 190);
  x.fillStyle = '#f2a541'; x.font = '800 190px "Bricolage Grotesque", sans-serif'; x.fillText(Math.round(w.secs / 60).toLocaleString('it-IT'), 80, 470);
  x.fillStyle = '#ece8dd'; x.font = '500 44px Figtree, sans-serif'; x.fillText('minuti di musica', 86, 535);
  const col = (title, items, y0, X) => { x.fillStyle = '#a3a8c8'; x.font = '600 36px Figtree, sans-serif'; x.fillText(title, X, y0); items.slice(0, 5).forEach((t, i) => { x.fillStyle = '#ece8dd'; x.font = '600 38px Figtree, sans-serif'; let s = `${i + 1}  ${t}`; while (x.measureText(s).width > 440 && s.length > 4) s = s.slice(0, -2); if (s !== `${i + 1}  ${t}`) s += '…'; x.fillText(s, X, y0 + 70 + i * 64); }); };
  col('Artisti', w.artists.map(e => e.x.artist), 680, 80);
  col('Brani', w.songs.map(e => e.x.title), 680, 560);
  x.fillStyle = '#a3a8c8'; x.font = '500 30px Figtree, sans-serif'; x.fillText(`${w.h.length} ascolti, ${w.artists.length} artisti`, 80, 1260);
  c.toBlob(async b => {
    const f = new File([b], 'armony.png', { type: 'image/png' });
    if (navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f], title: 'Il mio Armony' }); return; } catch {} }
    saveFile('armony.png', b);
  });
}

/* ================= download ================= */
async function dlApi(path, opts = {}, retry = true) {
  if (!S.dl.url) throw new Error(srv() ? 'Questo server non ha Armony: download, caricamenti e aggiornamenti non sono disponibili.' : 'Aggiungi un server in Impostazioni.');
  const r = await fetch(S.dl.url.replace(/\/+$/, '') + path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Token': S.dl.token, ...(opts.headers || {}) } });
  if (r.status === 401) {
    const s = srv();
    if (retry && s?.session) { delete s.session; await armonyLogin(s).catch(() => {}); persistServers(); if (s.session) return dlApi(path, opts, false); }
    throw new Error('Accesso scaduto: in Impostazioni modifica il server e reinserisci la password.');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Errore ${r.status}`);
  return j;
}
const scanned = new Set(store.get('scanned', []));
const videoUrl = (p, dl) => `${S.dl.url.replace(/\/+$/, '')}/api/videos/${p.split('/').map(encodeURIComponent).join('/')}?token=${encodeURIComponent(S.dl.token)}${dl ? '&dl=1' : ''}`;
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
  ${tabs}
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
          try { await dlApi('/api/download', { method: 'POST', body: JSON.stringify({ ...dlOptions(), playlist: false, url: results[+b.dataset.yi].url }) }); b.disabled = true; b.textContent = 'Avviato'; refreshJobs(); } catch (e) { toast(e.message); }
        });
      } catch (e) { $('#yRes').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    };
    $('#yGo').onclick = go; $('#ySearch').onkeydown = e => { if (e.key === 'Enter') go(); };
    if (q0) go();
  }
  refreshJobs(); refreshVideos(); viewInterval(refreshJobs, 2000);
}
async function refreshJobs() {
  const box = $('#jobs');
  try {
    const jobs = await dlApi('/api/jobs');
    if (box) box.innerHTML = jobs.length ? jobs.map(j => {
      const done = j.status.startsWith('completato'), err = j.status === 'errore';
      return `<div class="panel" style="padding:14px">
        <div class="row between" style="flex-wrap:nowrap"><b style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(j.title || j.url)}</b>
        <span class="tag ${done ? 'ok' : err ? 'err' : ''}">${esc(j.status)}${j.items ? ` ${j.item || 0}/${j.items}` : ''}</span></div>
        <small style="color:var(--muted)">${j.mode === 'audio' ? 'Audio ' + esc(j.format.toUpperCase()) : 'Video'}, ${esc(j.quality === 'best' ? 'qualità massima' : j.quality)}</small>
        ${err ? `<p style="color:var(--danger);margin:6px 0 0;font-size:.88rem">${esc(j.error)}</p>` : done ? '' : `<div class="bar"><i style="width:${j.progress || 0}%"></i></div>`}
      </div>`;
    }).join('') : '<div class="empty">Nessun download.</div>';
    let audioDone = false, changed = false;
    for (const j of jobs) if (j.status.startsWith('completato') && !scanned.has(j.id)) { scanned.add(j.id); changed = true; if (j.mode === 'audio') audioDone = true; else refreshVideos(); }
    if (changed) store.set('scanned', [...scanned].slice(-400));
    if (audioDone) {
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
      <a class="icon-btn" href="${esc(videoUrl(x.path, true))}" aria-label="Scarica sul dispositivo" onclick="event.stopPropagation()">${ic('down')}</a>
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
      u.status = r.status; if (r.status === 'caricato') added++;
    } catch (e) { u.status = 'errore'; u.error = e.message; }
    upRender();
  }
  Up.busy = false;
  if (added) api('startScan').then(() => toast(`${added} file caricati: la libreria si aggiorna tra poco.`)).catch(() => {});
}
function upSend(u) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();  // fetch non dà l'avanzamento dell'invio
    x.open('PUT', `${S.dl.url.replace(/\/+$/, '')}/api/upload?folder=${encodeURIComponent(u.folder)}&path=${encodeURIComponent(u.path)}`);
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
      const r = await dlApi('/api/import', { method: 'POST', body: JSON.stringify({ tracks: [...missing.values()], folder: store.get('impDir', 'Spotify') }) });
      // in attesa: solo ciò che serve a riconoscerli quando arrivano in libreria
      const slim = it => ({ title: it.title, artist: it.artist, artists: it.artists, album: it.album, duration: it.duration, isrc: it.isrc });
      const pend = store.get('pending', []);
      for (const rp of report) if (rp.pid && rp.miss.length) pend.push({ pid: rp.pid, sid: S.active, name: rp.title, items: rp.miss.map(slim), created: Date.now() });
      store.set('pending', pend);
      d.close(); toast(`${r.added} download in coda${r.skipped ? `, ${r.skipped} già in coda` : ''}. Li aggiungo alle playlist quando sono pronti.`); location.hash = '#/scarica';
    } catch (e) { toast(e.message); }
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
    if (ids.length) { try { await addSongsToPlaylist(p.pid, ids, p.sid); added += ids.length; } catch { still.push(...p.items.filter((_, i) => i < ids.length)); } }
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
    const pls = arr((await api('getPlaylists', {}, srv(sid))).playlists.playlist);
    d.innerHTML = `<h3>Aggiungi ${tracks.length > 1 ? tracks.length + ' brani' : 'a playlist'}</h3>
      <div style="max-height:45vh;overflow:auto">${pls.map(p => `<div class="list-item" data-pl="${esc(p.id)}"><span class="grow"><b>${esc(p.name)}</b></span><small>${p.songCount}</small></div>`).join('')}</div>
      <div class="row" style="margin-top:12px;flex-wrap:nowrap"><input type="text" id="npName" placeholder="Nuova playlist"><button class="btn primary" id="npGo">Crea</button></div>
      <div class="row" style="margin-top:10px"><button class="btn" onclick="this.closest('dialog').close()">Chiudi</button></div>`;
    const ids = tracks.map(t => t.id);
    d.querySelectorAll('[data-pl]').forEach(el => el.onclick = async () => { try { await addSongsToPlaylist(el.dataset.pl, ids, sid); d.close(); toast('Aggiunto alla playlist.'); } catch (e) { toast(e.message); } });
    $('#npGo').onclick = async () => { const name = $('#npName').value.trim(); if (!name) return; try { await createPlaylist(name, ids, sid); d.close(); toast(`Playlist "${name}" creata.`); } catch (e) { toast(e.message); } };
  } catch (e) { d.innerHTML = `<h3>Errore</h3><p>${esc(e.message)}</p><button class="btn" onclick="this.closest('dialog').close()">Chiudi</button>`; }
}
async function shareItem(id, name, sid = S.active) {
  const s = srv(sid);
  try {
    const r = await api('createShare', { id, description: name, expires: Date.now() + 30 * 864e5 }, s);
    let url = arr(r.shares?.share)[0]?.url; if (!url) throw new Error('Il server non ha creato il link.');
    if (s.shareBase) { const u = new URL(url); url = s.shareBase.replace(/\/+$/, '') + u.pathname + u.search; }
    if (navigator.share) { try { await navigator.share({ title: name, text: `Ascolta "${name}" su Armony`, url }); return; } catch {} }
    await copyText(url); toast('Link copiato. Funziona per 30 giorni, anche per chi non ha un account.');
  } catch (e) { toast(e.message.includes('sharing') || e.message.includes('70') ? 'Le condivisioni non sono attive sul server (ND_ENABLESHARING).' : e.message); }
}
async function radioFrom(t) {
  toast('Preparo la radio…');
  const s = srv(t.serverId); let songs = [];
  try { songs = arr((await api('getSimilarSongs', { id: t.id, count: 60 }, s)).similarSongs?.song); } catch {}
  if (songs.length < 15) { try { songs = songs.concat(arr((await api('getTopSongs', { artist: t.artist, count: 15 }, s)).topSongs?.song)); } catch {} }
  if (songs.length < 25 && t.genre) { try { songs = songs.concat(arr((await api('getSongsByGenre', { genre: t.genre, count: 60 }, s)).songsByGenre?.song)); } catch {} }
  if (songs.length < 25) { try { songs = songs.concat(arr((await api('getRandomSongs', { size: 40 }, s)).randomSongs?.song)); } catch {} }
  const seen = new Set([t.id]); const list = shuffleArr(songs.filter(x => !seen.has(x.id) && seen.add(x.id))).map(x => norm(x, t.serverId)).slice(0, 80);
  setQueue([t, ...list], 0);
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
  const d = $('#dlg'); d.className = 'sheet';
  const items = [
    ['nextup', 'Riproduci dopo', () => { if (Jam.role === 'guest') return Jam.suggest(t); S.queue.splice(S.index + 1, 0, t); persistQueue(); toast('Verrà riprodotto dopo il brano attuale.'); }],
    ['plus', 'Aggiungi alla coda', () => { if (Jam.role === 'guest') return Jam.suggest(t); S.queue.push(t); persistQueue(); toast('Aggiunto alla coda.'); }],
    Jam.role ? ['jam', Jam.role === 'host' ? 'Aggiungi alla coda della Jam' : 'Proponi alla Jam', () => Jam.suggest(t)] : null,
    ['addlist', 'Aggiungi a playlist', () => addToPlaylistDialog([t])],
    ['radio', 'Avvia una radio da qui', () => radioFrom(t)],
    t.albumId ? ['album', 'Vai all\'album', () => location.hash = '#/album/' + encodeURIComponent(t.albumId)] : null,
    t.artistId ? ['artist', 'Vai all\'artista', () => location.hash = '#/artista/' + encodeURIComponent(t.artistId)] : null,
    ['share', 'Condividi un link', () => shareItem(t.id, `${t.title} - ${t.artist}`, t.serverId)],
    Offline.has(t) ? ['trash', 'Togli dall\'offline', async () => { await Offline.remove(key(t)); toast('Rimosso dall\'offline.'); if (location.hash.startsWith('#/offline')) route(); }]
      : ['offline', 'Salva per l\'offline', () => Offline.save([t])],
    ['down', 'Scarica il file originale', () => { const a = document.createElement('a'); a.href = apiUrl(srv(t.serverId), 'download', { id: t.id }); a.download = ''; a.click(); }],
    ['lyrics', 'Testo', () => { if (key(currentTrack() || {}) !== key(t)) return toast('Il testo si apre per il brano in riproduzione.'); sessionStorage.setItem('armony:nowtab', 'lyr'); location.hash = '#/ora'; }],
    ctx.pl != null ? ['trash', 'Togli dalla playlist', async () => { await api('updatePlaylist', { playlistId: view.dataset.pl, songIndexToRemove: ctx.pl }); route(); }] : null,
    canEdit(t.serverId) ? ['pen', 'Modifica informazioni', () => editTrack(t)] : null,
    canDelete(t.serverId) ? ['trash', 'Elimina dal server', () => deleteTracks([t], t.title), 'danger'] : null
  ].filter(Boolean);
  d.innerHTML = `<div class="head"><span class="pic">${imgTag(t.coverArt, 100, t.serverId)}</span><span style="min-width:0"><b style="display:block">${esc(t.title)}</b><small style="color:var(--muted)">${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</small></span></div>
    ${items.map(([i, l, , cls], n) => `<button class="mi${cls ? ' ' + cls : ''}" data-n="${n}">${ic(i)}${l}</button>`).join('')}`;
  d.querySelectorAll('[data-n]').forEach(b => b.onclick = () => { d.close(); items[+b.dataset.n][2](); });
  d.onclose = () => { d.className = ''; d.onclose = null; };
  d.showModal();
}

/* ================= impostazioni ================= */
function vSettings() {
  const opt = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${String(k) === String(cur) ? 'selected' : ''}>${v}</option>`).join('');
  const qOpts = Object.fromEntries(Object.entries(QUALITIES).map(([k, q]) => [k, q.label]));
  // gruppi richiudibili: lo stato aperto/chiuso resta su questo dispositivo
  const closed = new Set(store.get('setClosed', SET_CLOSED));
  const grp = (id, title, keys, body) => `<details class="sgroup" data-g="${id}" data-k="${esc(keys)}" ${closed.has(id) ? '' : 'open'}><summary><h2>${title}</h2>${ic('chevr')}</summary><div class="sbody">${body}</div></details>`;
  view.innerHTML = `<h1>Impostazioni</h1><p class="sub">Tutto resta su questo dispositivo, salvo ciò che sta sui server.</p>
  <label class="setsearch">${ic('search')}<input type="search" id="setQ" placeholder="Cerca nelle impostazioni" aria-label="Cerca nelle impostazioni" autocomplete="off"></label>
  <div id="setNone" class="empty" hidden></div>
  ${grp('profilo', 'Profilo', 'nome nick sincronizzazione dispositivi', `<div class="panel stack"><label class="f">Il tuo nome nelle Jam<input type="text" id="pNick" value="${esc(P.nick)}" placeholder="Es. Giulia" maxlength="30"></label>
    <label class="check"><input type="checkbox" data-pb="sync" ${P.sync ? 'checked' : ''}><span>Stesse statistiche e impostazioni su tutti i dispositivi<small>Storico d'ascolto e preferenze vengono salvati sul server, legati al tuo utente. Chi gestisce il server può vederli. Volume e modalità compatibile restano di ogni dispositivo.</small></span></label>
    <label class="check"><input type="checkbox" data-pb="live" ${P.live !== false ? 'checked' : ''}><span>Un solo dispositivo suona, gli altri lo comandano<small>Se avvii la musica qui, sugli altri tuoi dispositivi si ferma e il lettore mostra cosa suona qui. Da "Dove suona" nel lettore la sposti dove vuoi.</small></span></label>
    <label class="f">Nome di questo dispositivo<input type="text" id="pDev" value="${esc(P.deviceName)}" placeholder="${esc(Live.name())}" maxlength="30"></label></div>`)}

  ${grp('server', 'Server musicali', 'navidrome subsonic account accesso password indirizzo rete lan', `<p class="sub">Qualsiasi server compatibile Subsonic: Navidrome, Gonic, Airsonic, Ampache.</p>
  <div>${S.servers.map(s => `<div class="list-item" style="cursor:default">
    <span class="grow"><b>${esc(s.name)} ${s.id === S.active ? '<span class="tag ok">in uso</span>' : ''}</b><small>${esc(s.url)}, utente ${esc(s.user)}${s.me ? (s.me.admin ? ', amministratore' : '') + ` · Armony ${esc(s.me.version || '')}` : s.armony === false ? ' · solo ascolto (server senza Armony)' : ''}</small></span>
    ${s.id !== S.active ? `<button class="btn sm" data-act="usesrv" data-id="${s.id}">Usa</button>` : ''}
    <button class="btn sm" data-act="editsrv" data-id="${s.id}">Modifica</button>
    <button class="icon-btn" data-act="delsrv" data-id="${s.id}" aria-label="Rimuovi">${ic('trash')}</button></div>`).join('') || '<p class="sub">Nessun server.</p>'}</div>
  <div class="row" style="margin-top:12px"><button class="btn primary" data-act="addsrv">${ic('plus')} Aggiungi server</button><button class="btn" data-act="lanscan">${ic('wifi')} Cerca sulla rete</button></div>
  <div id="lanRes"></div>`)}

  ${grp('ascolto', 'Ascolto', 'audio qualità bitrate equalizzatore eq dissolvenza crossfade velocità volume notte replaygain normalizzazione visualizzatore iphone', `<div class="panel stack">
    <div class="grid2">
      <label class="f">Qualità<select data-p="quality">${opt(qOpts, P.quality)}</select></label>
      <label class="f">Qualità con rete mobile<select data-p="qualityMobile">${opt({ same: 'Uguale', ...qOpts }, P.qualityMobile)}</select></label>
      <label class="f">Qualità per l'offline<select data-p="offlineQ">${opt(qOpts, P.offlineQ)}</select></label>
      <label class="f">Normalizzazione volume<select data-p="rg">${opt({ off: 'Spenta', track: 'Per brano', album: 'Per album' }, P.rg)}</select></label>
    </div>
    <label class="f">Dissolvenza tra i brani: <span id="cfv">${P.crossfade ? P.crossfade + ' secondi' : 'spenta'}</span><input type="range" min="0" max="12" step="1" value="${P.crossfade}" id="cf"></label>
    <label class="check"><input type="checkbox" data-pb="night" ${P.night ? 'checked' : ''}><span>Volume notte<small>Comprime la dinamica: i passaggi forti si abbassano, quelli piano si sentono. Utile di sera o in auto.</small></span></label>
    <label class="check"><input type="checkbox" data-pb="visualizer" ${P.visualizer ? 'checked' : ''}><span>Visualizzatore nella schermata In riproduzione</span></label>
    <label class="check"><input type="checkbox" data-pb="compat" ${P.compat ? 'checked' : ''}><span>Modalità compatibile<small>Disattiva equalizzatore, dissolvenza e trasmissione nelle Jam. Attivala se su iPhone la musica si ferma a schermo bloccato. Richiede di ricaricare la pagina.</small></span></label>
    <div class="row"><button class="btn" data-act="eq">${ic('sliders')} Equalizzatore</button><button class="btn" data-act="speed">${ic('speed')} Velocità: ${P.speed}×</button></div>
  </div>`)}

  ${grp('testi', 'Testi e sincronizzazione', 'lyrics lrclib coda continua dispositivi', `<div class="panel stack">
    <label class="check"><input type="checkbox" data-pb="lyricsOnline" ${P.lyricsOnline ? 'checked' : ''}><span>Cerca i testi online se il server non li ha<small>Usa LRCLIB, un archivio libero di testi sincronizzati. Invia solo titolo, artista e durata del brano.</small></span></label>
    <label class="check"><input type="checkbox" data-pb="syncQueue" ${P.syncQueue ? 'checked' : ''}><span>Continua su altri dispositivi<small>Salva la coda sul server: apri Armony sul PC e riprendi da dove eri al telefono.</small></span></label>
  </div>`)}

  ${grp('jam', 'Jam', 'stun turn 5g internet nat ascoltare insieme', `<div class="panel stack">
    <label class="check"><input type="checkbox" data-pb="stun" ${P.stun ? 'checked' : ''}><span>Permetti Jam via internet (5G)<small>Usa server STUN pubblici per scoprire l'indirizzo esterno. Non passa musica né chiavi da quei server.</small></span></label>
    <p class="small" style="color:var(--muted);margin:0">Server TURN (facoltativo). Serve quando operatori mobili o reti aziendali impediscono il collegamento diretto. Il traffico che vi passa resta cifrato.</p>
    <div class="grid2">
      <label class="f">Indirizzo TURN<input type="text" id="tUrl" value="${esc(P.turn.url)}" placeholder="turn:mio-server.it:3478"></label>
      <label class="f">Utente<input type="text" id="tUser" value="${esc(P.turn.user)}"></label>
      <label class="f">Password<input type="password" id="tPass" value="${esc(P.turn.pass)}"></label>
    </div>
  </div>`)}

  ${access().admin && srv()?.session ? grp('utenti', 'Utenti', 'permessi caricamento download disconnetti amministratore', '<p class="sub">Chi ha fatto accesso a questo server da Armony. Gli amministratori di Navidrome possono sempre tutto.</p><div id="usrBox"><p class="sub">Caricamento…</p></div><h3 style="margin-top:var(--s5)">Registrazione</h3><div id="regBox"><p class="sub">Caricamento…</p></div>') : ''}
  ${window.ARMONY_APP ? grp('app', 'App Android', 'apk aggiornamento versione telefono android', '<div class="panel" id="appBox"><p class="sub">Controllo…</p></div>') : ''}
  ${access().admin ? grp('aggiornamenti', 'Aggiornamenti', 'versione github aggiorna', '<div class="panel" id="updBox"><p class="sub">Controllo…</p></div>') : ''}

  ${grp('aspetto', 'Aspetto', 'tema chiaro scuro automatico colori', `<div class="seg">${[['auto', 'Automatico'], ['light', 'Chiaro'], ['dark', 'Scuro']].map(([v, l]) => `<label><input type="radio" name="theme" value="${v}" ${P.theme === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>`)}

  ${grp('backup', 'Backup e trasferimento', 'esporta importa file amico scorciatoie tastiera', `<p class="sub">Sposta tutto su un altro telefono, o passa la configurazione a un amico in dieci secondi.</p>
  <div class="row"><button class="btn" data-act="exportset">Esporta impostazioni</button><button class="btn" data-act="importset">Importa impostazioni</button><a class="btn" href="#/tasti">Scorciatoie da tastiera</a></div>`)}
  <p class="small" style="color:var(--muted);margin-top:24px">Armony, dispositivo ${esc(S.device)}.</p>`;
  view.querySelectorAll('.sgroup').forEach(d => d.ontoggle = () => {
    if ($('#setQ').value) return;  // durante la ricerca i gruppi si aprono da soli: non è una scelta da ricordare
    d.open ? closed.delete(d.dataset.g) : closed.add(d.dataset.g); store.set('setClosed', [...closed]);
  });
  $('#setQ').oninput = e => settingsFilter(e.target.value);
  $('#pNick').onchange = e => { P.nick = e.target.value.trim(); savePrefs(); };
  $('#pDev').onchange = e => { P.deviceName = e.target.value.trim(); savePrefs(); Live.connect(); };
  view.querySelectorAll('[data-p]').forEach(el => el.onchange = () => { P[el.dataset.p] = el.value; savePrefs(); fillSelectors(); });
  view.querySelectorAll('[data-pb]').forEach(el => el.onchange = () => {
    P[el.dataset.pb] = el.checked; savePrefs();
    if (el.dataset.pb === 'night') Engine.applyNight();
    if (el.dataset.pb === 'compat') toast('Ricarica la pagina per applicare.');
    if (el.dataset.pb === 'sync' && P.sync) { PrefSync.pull(); HistSync.run(); }
    if (el.dataset.pb === 'live') Live.connect();
  });
  $('#cf').oninput = e => { P.crossfade = +e.target.value; $('#cfv').textContent = P.crossfade ? P.crossfade + ' secondi' : 'spenta'; savePrefs(); };
  ['tUrl', 'tUser', 'tPass'].forEach(id => $('#' + id).onchange = () => { P.turn = { url: $('#tUrl').value.trim(), user: $('#tUser').value.trim(), pass: $('#tPass').value }; savePrefs(); });
  if (access().admin) { refreshUpdate(); refreshUsers(); refreshReg(); }
  if (window.ARMONY_APP) AppUpdate.paint();
  $$('[name=theme]').forEach(r => r.onchange = () => { P.theme = r.value; savePrefs(); if (r.value === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = r.value; });
}
// ricerca fra le impostazioni: mostra solo le voci che contengono il testo, e apre i gruppi che ne hanno
const SET_CLOSED = ['testi', 'jam', 'utenti', 'aspetto', 'backup'];
const fold = t => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function settingsFilter(raw) {
  const q = fold(raw.trim());
  let shown = 0;
  view.querySelectorAll('.sgroup').forEach(g => {
    // se qualche voce contiene il testo si mostrano solo quelle; il gruppo intero solo se lo nomina il titolo
    const items = [...g.querySelectorAll('.check, label.f, .list-item, .sbody > .row, .panel > .row, .seg')];
    const match = items.filter(el => !q || fold(el.textContent).includes(q));
    const whole = !q || (!match.length && fold(g.querySelector('summary').textContent + ' ' + g.dataset.k).includes(q));
    let hits = 0;
    items.forEach(el => { const ok = whole || match.includes(el); el.classList.toggle('nohit', !ok); hits += ok; });
    g.querySelectorAll('.sbody > .sub, .panel > .small').forEach(el => el.classList.toggle('nohit', !whole));
    g.hidden = !whole && !hits; if (!g.hidden) shown++;
    if (q) g.open = !g.hidden; else g.open = !store.get('setClosed', SET_CLOSED).includes(g.dataset.g);
  });
  const none = $('#setNone'); none.hidden = !q || shown > 0;
  if (q && !shown) none.innerHTML = `Nessuna impostazione contiene «${esc(raw.trim())}». Prova con una parola più corta, come «qualità» o «tema».`;
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
/* ================= registrazione degli amici (solo amministratori) ================= */
const fmtCode = c => String(c).replace(/^(.{4})(.+)$/, '$1-$2');
const inviteLink = c => `${absUrl(srv()?.shareBase || srv()?.url || location.origin)}/#/invito/${fmtCode(c)}`;
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
async function refreshUsers() {
  const box = $('#usrBox'); if (!box) return;
  let list; try { list = await dlApi('/api/users'); } catch (e) { box.innerHTML = `<p class="sub">${esc(e.message)}</p>`; return; }
  box.innerHTML = list.length ? list.map(u => `<div class="list-item" style="cursor:default;flex-wrap:wrap">
    <span class="grow"><b>${esc(u.user)}</b><small>${u.admin ? 'amministratore' : 'utente'}${u.seen ? ', ultimo accesso ' + new Date(u.seen * 1000).toLocaleDateString() : ''}</small></span>
    <label class="check box" style="margin:0"><input type="checkbox" data-usr="${esc(u.user)}" data-perm="upload" ${u.upload || u.admin ? 'checked' : ''} ${u.admin ? 'disabled' : ''}><span>Caricamento</span></label>
    <label class="check box" style="margin:0"><input type="checkbox" data-usr="${esc(u.user)}" data-perm="download" ${u.download || u.admin ? 'checked' : ''} ${u.admin ? 'disabled' : ''}><span>Download</span></label>
    <label class="check box" style="margin:0"><input type="checkbox" data-usr="${esc(u.user)}" data-perm="delete" ${u.delete || u.admin ? 'checked' : ''} ${u.admin ? 'disabled' : ''}><span>Modifica ed eliminazione</span></label>
    ${u.sessions ? `<button class="btn sm" data-act="usrrevoke" data-user="${esc(u.user)}">Disconnetti</button>` : ''}</div>`).join('')
    : '<div class="empty">Nessun utente ha ancora fatto accesso da Armony.</div>';
  box.querySelectorAll('[data-usr]').forEach(el => el.onchange = async () => {
    const name = el.dataset.usr, v = p => box.querySelector(`[data-usr="${CSS.escape(name)}"][data-perm="${p}"]`).checked;
    try { await dlApi('/api/users/' + encodeURIComponent(name), { method: 'PUT', body: JSON.stringify({ upload: v('upload'), download: v('download'), delete: v('delete') }) }); toast('Permessi aggiornati.'); }
    catch (e) { toast(e.message); refreshUsers(); }
  });
}
async function notifyUpdate() {
  if (!access().admin) return;
  const u = await dlApi('/api/update').catch(() => null);
  if (u?.available && store.get('updSeen') !== u.latest) { store.set('updSeen', u.latest); toast(`Armony ${u.latest} disponibile: aggiorna da Impostazioni.`, 6000); }
}
function serverDialog(s, preset = {}) {
  const editing = !!s;
  s = s || { id: uid(8), name: preset.name || '', url: preset.url || '', user: '', shareBase: '' };
  const d = $('#dlg'); d.className = '';
  d.innerHTML = `<h3>${editing ? 'Modifica server' : 'Nuovo server'}</h3><div class="stack">
    <label class="f">Indirizzo<input type="url" id="sUrl" value="${esc(s.url)}" placeholder="http://192.168.1.10:8080" autocapitalize="none" autocorrect="off" inputmode="url"></label>
    <div class="seg" id="sMode" role="radiogroup" aria-label="Accesso" hidden><label><input type="radio" name="smode" value="accedi" checked><span>Accedi</span></label><label><input type="radio" name="smode" value="crea"><span>Crea un account</span></label></div>
    <div class="stack" id="sLogin">
      <label class="f">Utente<input type="text" id="sUser" value="${esc(s.user)}" autocomplete="username" autocapitalize="none" autocorrect="off"></label>
      <label class="f">Password<input type="password" id="sPass" value="" autocomplete="current-password" ${s.tok ? 'placeholder="Lascia vuoto per non cambiarla"' : ''}></label>
    </div>
    <div class="stack" id="sCreate" hidden>
      <label class="f">Scegli un nome utente<input type="text" id="rUser" autocomplete="username" autocapitalize="none" autocorrect="off" maxlength="32" placeholder="es. giulia"></label>
      <label class="f">Scegli una password<input type="password" id="rPass" autocomplete="new-password" placeholder="Almeno 8 caratteri"></label>
      <label class="f">Ripeti la password<input type="password" id="rPass2" autocomplete="new-password"></label>
      <label class="f" id="rCodeL">Codice d'invito<input type="text" id="rCode" value="${esc(preset.code || '')}" autocapitalize="characters" autocorrect="off" placeholder="XXXX-XXXX"></label>
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
    const crea = mode() === 'crea';
    $('#sLogin').hidden = crea; $('#sCreate').hidden = !crea; $('#sTest').hidden = crea;
    $('#rCodeL').hidden = !reg?.needsCode;
    $('#sSave').textContent = editing ? 'Salva' : crea ? 'Crea l\'account' : 'Accedi';
    msg('');
  };
  d.querySelectorAll('[name=smode]').forEach(r => r.onchange = paintMode);
  // la registrazione si offre solo se il server la permette (/api/register/info è pubblica)
  const checkReg = async () => {
    const url = $('#sUrl').value.trim().replace(/\/+$/, ''); reg = null;
    if (!editing && url && /^https?:\/\/./.test(absUrl(url))) reg = await fetch(absUrl(url) + '/api/register/info').then(r => r.ok ? r.json() : null).catch(() => null);
    $('#sMode').hidden = !reg?.open;
    if (!reg?.open && mode() === 'crea') d.querySelector('[name=smode][value=accedi]').checked = true;
    if (reg?.open && preset.mode === 'crea' && !paintMode.done) { d.querySelector('[name=smode][value=crea]').checked = true; paintMode.done = true; }
    paintMode();
  };
  $('#sUrl').onchange = checkReg;
  const read = () => {
    const pass = $('#sPass').value, user = $('#sUser').value.trim();
    const n = { ...s, name: $('#sName').value.trim() || reg?.name || $('#sUrl').value.trim(), url: $('#sUrl').value.trim().replace(/\/+$/, ''), user, shareBase: $('#sShare').value.trim() };
    if (pass) Object.assign(n, subsonicCreds(pass));
    else if (user !== s.user) delete n.tok;  // utente cambiato senza password: credenziali vecchie non valide
    return n;
  };
  $('#sTest').onclick = async () => { msg('Provo…'); try { await api('ping', {}, read()); msg('Connessione riuscita.'); } catch (e) { msg(e.message); } };
  const save = async welcome => {
    const n = read(); if (!n.url || !n.user || !n.tok) return msg('Indirizzo, utente e password sono obbligatori.');
    msg('Verifico…');
    try { await api('ping', {}, n); } catch (e) { if (welcome || !confirm(`${e.message}\nSalvare comunque?`)) return msg(e.message); }
    delete n.session; delete n.armony; delete n.me;
    try { await armonyLogin(n); } catch (e) { return msg('Armony: ' + e.message); }
    const i = S.servers.findIndex(x => x.id === n.id); if (i >= 0) S.servers[i] = n; else S.servers.push(n);
    if (!S.active || welcome) S.active = n.id;
    if (n.session && S.active === n.id) store.set('downloader', null);
    persistServers(); d.close();
    if (location.hash.startsWith('#/invito')) location.hash = '#/home'; else route();
    Live.connect?.();
    toast(welcome ? `Benvenuto in Armony, ${n.user}!` : n.me ? `Collegato a ${n.name}${n.me.admin ? ' come amministratore' : ''}.` : `Collegato a ${n.name}: solo ascolto, il server non ha Armony.`);
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
      // account creato: si entra come se l'avesse scritto nei campi di accesso
      $('#sUser').value = u; $('#sPass').value = p1;
      await save(true);
    } catch { msg('Non riesco a raggiungere il server.'); }
    finally { $('#sSave').disabled = false; }
  };
  $('#sSave').onclick = () => mode() === 'crea' ? create() : save(false);
  d.showModal();
  checkReg();
}
function persistServers() { store.set('servers', S.servers); store.set('active', S.active); fillSelectors(); sidePlaylists(); }
function fillSelectors() {
  const name = srv()?.name || 'Nessun server', q = QUALITIES[P.quality].short;
  $('#ctxBtn').innerHTML = `<span class="grow">${esc(name)}</span><span class="pill">${esc(q)}</span>`;
  $('#ctxBtn').setAttribute('aria-label', `Server e qualità: ${name}, ${q}`);
  $('#qBadge').textContent = Offline.has(currentTrack()) ? 'Offline' : QUALITIES[activeQuality()].short + (activeQuality() !== P.quality ? ' (mobile)' : '');
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
    <p class="sh">Server</p>${S.servers.map(s => `<button class="mi ${s.id === S.active ? 'on' : ''}" data-sid="${s.id}">${ic(s.id === S.active ? 'check' : 'lib')}${esc(s.name)}</button>`).join('')}
    <button class="mi" data-ctx="srv">${ic('plus')}${S.servers.length ? 'Gestisci i server' : 'Aggiungi un server'}</button>
    <p class="sh">Qualità di ascolto</p>${Object.entries(QUALITIES).map(([k, q]) => `<button class="mi ${k === P.quality ? 'on' : ''}" data-q="${k}">${ic(k === P.quality ? 'check' : 'album')}${q.label}</button>`).join('')}`;
  d.querySelectorAll('[data-sid]').forEach(el => el.onclick = () => { d.close(); if (S.active === el.dataset.sid) return; S.active = el.dataset.sid; persistServers(); route(); });
  d.querySelectorAll('[data-q]').forEach(el => el.onclick = () => { setQuality(el.dataset.q); d.close(); });
  d.querySelector('[data-ctx]').onclick = () => { d.close(); if (S.servers.length) location.hash = '#/impostazioni'; else serverDialog(); };
  closeOutside(d); d.showModal();
}
function moreSheet() {
  const d = $('#dlg'); d.className = 'sheet';
  const cur = location.hash.replace(/^#\/?/, '').split('/')[0] || 'home';
  const items = NAV.filter(([h]) => !TABS.includes(h));
  if (matchMedia('(any-hover:hover)').matches) items.push(['tasti', 'Scorciatoie da tastiera', 'more']);
  d.innerHTML = `<div class="head"><b>Altre sezioni</b></div>${items.map(([h, l, i]) => `<a class="mi ${h === cur ? 'on' : ''}" href="#/${h}" ${h === cur ? 'aria-current="page"' : ''}>${ic(i)}${l}</a>`).join('')}`;
  d.querySelectorAll('a').forEach(a => a.onclick = () => d.close());
  closeOutside(d); d.showModal();
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
  const lbl = f => f >= 1000 ? f / 1000 + 'k' : f;
  d.innerHTML = `<h3>Equalizzatore</h3>${P.compat || !Engine.ctx ? '<p class="sub">Non disponibile in modalità compatibile, o finché non parte la musica.</p>' : ''}
    <div class="row between"><label class="check" style="align-items:center"><input type="checkbox" id="eqOn" ${P.eqOn ? 'checked' : ''}><span>Attivo</span></label>
    <select id="eqPre" style="width:auto"><option value="">Preimpostazioni…</option>${Object.keys(EQ_PRESETS).map(k => `<option>${k}</option>`).join('')}</select></div>
    <div class="eq">${EQ_FREQS.map((f, i) => `<label><span id="eqv${i}">${P.eq[i] > 0 ? '+' : ''}${P.eq[i]}</span><input type="range" min="-12" max="12" step="1" value="${P.eq[i]}" data-b="${i}" aria-label="${lbl(f)} Hz"><span>${lbl(f)}</span></label>`).join('')}</div>
    <div class="row"><button class="btn" id="eqReset">Azzera</button><button class="btn primary" onclick="this.closest('dialog').close()">Fatto</button></div>`;
  const paint = () => EQ_FREQS.forEach((_, i) => { $(`[data-b="${i}"]`).value = P.eq[i]; $('#eqv' + i).textContent = (P.eq[i] > 0 ? '+' : '') + P.eq[i]; });
  d.querySelectorAll('[data-b]').forEach(r => r.oninput = () => { P.eq[+r.dataset.b] = +r.value; savePrefs(); Engine.applyEq(); paint(); });
  $('#eqOn').onchange = e => { P.eqOn = e.target.checked; savePrefs(); Engine.applyEq(); };
  $('#eqPre').onchange = e => { if (!e.target.value) return; P.eq = EQ_PRESETS[e.target.value].slice(); savePrefs(); Engine.applyEq(); paint(); };
  $('#eqReset').onclick = () => { P.eq = Array(10).fill(0); savePrefs(); Engine.applyEq(); paint(); };
  d.onclose = () => { d.className = ''; d.onclose = null; }; d.showModal();
}
function speedDialog() {
  const d = $('#dlg'); d.className = 'sheet';
  d.innerHTML = `<div class="head"><b>Velocità di riproduzione</b></div>${[0.75, 0.9, 1, 1.1, 1.25, 1.5, 2].map(v => `<button class="mi" data-v="${v}">${v === P.speed ? ic('heart', true) : ic('speed')}${String(v).replace('.', ',')}×${v === 1 ? ' (normale)' : ''}</button>`).join('')}`;
  d.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { P.speed = +b.dataset.v; savePrefs(); Engine.decks.forEach(a => a.playbackRate = P.speed); d.close(); if (location.hash.startsWith('#/ora')) vNow(); });
  d.onclose = () => { d.className = ''; d.onclose = null; }; d.showModal();
}

/* ================= azioni (delegazione eventi) ================= */
view.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el || !view.contains(el)) return;
  const act = el.dataset.act, i = +el.dataset.i, id = el.dataset.id, list = S.lastList;
  e.stopPropagation();
  try {
    switch (act) {
      case 'album': location.hash = '#/album/' + encodeURIComponent(id); break;
      case 'playalb': { const r = (await api('getAlbum', { id })).album; setQueue(arr(r.song).map(x => norm(x)), 0); break; }
      case 'showall': sessionStorage.setItem('armony:asort', { newest: 'newest', frequent: 'frequent', random: 'random', starred: 'starred' }[el.dataset.sort] || 'newest'); location.hash = '#/libreria/album'; break;
      case 'lmore': lMore(); break;
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
      case 'enqueueall': if (Jam.role === 'guest') { list.slice(0, 10).forEach(t => Jam.suggest(t)); break; } S.queue.push(...list); persistQueue(); flyToQueue(el); toast(`${list.length} brani aggiunti alla coda.`); break;
      case 'offlineall': Offline.save(list); break;
      case 'addalltopl': addToPlaylistDialog(list); break;
      case 'enqueue': if (Jam.role === 'guest') { Jam.suggest(list[i]); break; } S.queue.push(list[i]); persistQueue(); flyToQueue(el); toast('Aggiunto alla coda.'); break;
      case 'more': songMenu(list[i], { pl: view.dataset.pl ? i : null }); break;
      case 'star': {
        const t = list[i]; await api(t.starred ? 'unstar' : 'star', { id: t.id }, srv(t.serverId));
        t.starred = !t.starred; el.classList.toggle('on', t.starred); el.innerHTML = ic('heart', t.starred); if (t.starred) beat(el.firstChild); break;
      }
      case 'staralbum': await api(el.dataset.on === '1' ? 'unstar' : 'star', { albumId: id }); route(); break;
      case 'shareitem': shareItem(id, el.dataset.name); break;
      case 'spall': sessionStorage.setItem('armony:sp', 'all'); vStats(); break;
      case 'radio': { const r = await api('getRandomSongs', { size: 80 }); setQueue(arr(r.randomSongs.song).map(x => norm(x)), 0); break; }
      case 'mixfav': { const r = (await api('getStarred2')).starred2; const so = arr(r.song).map(x => norm(x)); if (!so.length) return toast('Non hai ancora brani preferiti.'); setQueue(so, 0, true); break; }
      case 'mixforgot': {
        const recent = new Set((await Stats.all()).filter(x => x.ts > Date.now() - 60 * 864e5).map(x => x.key));
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
      case 'artistradio': { let songs = []; try { songs = arr((await api('getSimilarSongs2', { id, count: 80 })).similarSongs2?.song); } catch {} if (!songs.length) { const a = (await api('getArtist', { id })).artist; const albums = await Promise.all(arr(a.album).map(al => api('getAlbum', { id: al.id }))); songs = albums.flatMap(r => arr(r.album.song)); } setQueue(songs.map(x => norm(x)), 0, true); break; }
      case 'qup': if (i > 0) { [S.queue[i - 1], S.queue[i]] = [S.queue[i], S.queue[i - 1]]; if (S.index === i) S.index--; else if (S.index === i - 1) S.index++; persistQueue(); vQueue(); } break;
      case 'qdn': if (i < S.queue.length - 1) { [S.queue[i + 1], S.queue[i]] = [S.queue[i], S.queue[i + 1]]; if (S.index === i) S.index++; else if (S.index === i + 1) S.index--; persistQueue(); vQueue(); } break;
      case 'qrm':
        S.queue.splice(i, 1);
        if (i < S.index) S.index--; else if (i === S.index) { Engine.stop(); S.index = Math.min(S.index, S.queue.length - 1); updateNowPlaying(); }
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
      case 'delpl': if (confirm('Eliminare questa playlist? I brani restano in libreria.')) { await api('deletePlaylist', { id }); location.hash = '#/playlist'; } break;
      case 'upclear': Up.list = Up.list.filter(u => ['in coda', 'in corso'].includes(u.status)); upRender(); break;
      case 'clearjobs': await dlApi('/api/jobs', { method: 'DELETE' }); refreshJobs(); break;
      case 'playvideo': {
        const d = $('#dlg'); d.className = 'wide';
        d.innerHTML = `<h3>${esc(el.dataset.name)}</h3><video controls autoplay playsinline src="${esc(videoUrl(el.dataset.path))}"></video><div class="row" style="margin-top:12px"><button class="btn" onclick="this.closest('dialog').close()">Chiudi</button></div>`;
        Engine.el.pause(); d.onclose = () => { d.className = ''; d.innerHTML = ''; d.onclose = null; }; d.showModal(); break;
      }
      case 'delvideo': if (confirm('Eliminare questo video dal server?')) { await dlApi('/api/videos/' + el.dataset.path.split('/').map(encodeURIComponent).join('/'), { method: 'DELETE' }); refreshVideos(); } break;
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
      case 'sleep': sleepDialog(); break;
      case 'speed': speedDialog(); break;
      case 'eq': eqDialog(); break;
      case 'addsrv': serverDialog(null, { url: el.dataset.url || '', name: el.dataset.name || '' }); break;
      case 'editsrv': serverDialog(srv(id)); break;
      case 'usesrv': S.active = id; persistServers(); vSettings(); Live.connect(); break;
      case 'delsrv': if (confirm('Rimuovere questo server da Armony?')) { S.servers = S.servers.filter(s => s.id !== id); if (S.active === id) S.active = S.servers[0]?.id || null; persistServers(); vSettings(); } break;
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
      case 'usrrevoke': if (confirm(`Disconnettere ${el.dataset.user} da tutti i dispositivi? Dovrà rifare l'accesso.`)) { await dlApi(`/api/users/${encodeURIComponent(el.dataset.user)}/sessions`, { method: 'DELETE' }); refreshUsers(); } break;
      case 'exportset': {
        const withPw = confirm('Includere le credenziali nel file?\nOK = sì (conservalo al sicuro), Annulla = no');
        // mai la sessione: è di questo dispositivo. Le credenziali sono token + sale, non la password
        const strip = ({ session, me, armony, tok, salt, ...rest }) => withPw ? { ...rest, tok, salt } : rest;
        saveFile('armony-impostazioni.json', JSON.stringify({ app: 'armony', version: 3, prefs: { ...P, turn: { ...P.turn, pass: withPw ? P.turn.pass : '' } },
          servers: S.servers.map(strip) }, null, 2), 'application/json');
        break;
      }
      case 'importset': {
        const f = await pickFile('.json'); if (!f) return;
        const j = JSON.parse(await f.text());
        if (!['armony', 'cerchia'].includes(j.app)) return toast('Questo file non contiene impostazioni di Armony.');
        for (const s of migrateCreds(arr(j.servers))) {
          delete s.session; delete s.me; delete s.armony;
          const ex = S.servers.find(x => absUrl(x.url) === absUrl(s.url) && x.user === s.user);
          if (ex) Object.assign(ex, { ...s, id: ex.id, tok: s.tok || ex.tok, salt: s.tok ? s.salt : ex.salt }); else S.servers.push({ ...s, id: uid(8) });
        }
        if (!S.active) S.active = S.servers[0]?.id;
        if (j.downloader?.token && !S.dl.token) store.set('downloader', j.downloader);  // file di Armony 0.2
        syncSessions();
        if (j.prefs) { const nick = P.nick; Object.assign(P, j.prefs, { nick: nick || j.prefs.nick }); savePrefs(); }
        else if (j.quality && QUALITIES[j.quality]) { P.quality = j.quality; savePrefs(); }
        persistServers(); route();
        toast(S.servers.some(s => !s.tok) ? 'Importato. Inserisci le password mancanti con Modifica.' : 'Impostazioni importate.');
        break;
      }
      default: if (typeof Jam.action === 'function') await Jam.action(act, el);
    }
  } catch (err) { console.error(err); toast(err.message); }
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
function nativeBack() {
  const App = window.Capacitor?.Plugins?.App; if (!App) return;
  // indietro chiude prima un foglio aperto; dalla home non chiude l'app (la musica deve continuare): la riduce
  App.addListener('backButton', ({ canGoBack }) => {
    const d = $('dialog[open]'); if (d) return d.close();
    if (canGoBack && !/^#\/(home)?$/.test(location.hash || '#/')) history.back(); else App.minimizeApp();
  });
}

/* ================= dal vivo: un solo dispositivo suona, gli altri sono telecomandi (/api/live) =================
   Tutti i dispositivi dello stesso utente tengono aperto un canale SSE col server. Chi suona pubblica brano,
   play/pausa e posizione; quando un dispositivo comincia a suonare gli altri si fermano e diventano telecomandi:
   il lettore mostra la sua musica e i comandi vanno a lui. "Dove suona" sposta la coda su un altro dispositivo.
   Un dispositivo "per conto suo" (P.solo) è sganciato: non si ferma per gli altri e non li ferma, ma resta
   nell'elenco e gli si può mandare la musica di proposito.
   La Jam (più persone insieme) resta separata: con una Jam aperta questo modulo non interviene. */
const Live = {
  es: null, devices: new Map(), states: new Map(), target: null, sent: null, tick: null, retry: null, dog: null, last: 0, beatAt: 0, fails: 0, want: null,
  name() { return P.deviceName || (NATIVE ? 'Telefono' : /Android|iPhone|iPad|Mobile/.test(navigator.userAgent) ? 'Telefono (browser)' : 'Computer'); },
  on() { const s = srv(); return P.live !== false && !!s?.session && !!s.me?.caps?.includes('live'); },
  st() { return this.target ? this.states.get(this.target) || null : null; },
  // telecomando: c'è un dispositivo di destinazione collegato e qui non sta suonando niente
  remote() { return !Jam.role && !!this.target && this.devices.has(this.target) && Engine.el.paused; },
  track() { const s = this.st(); return s?.track ? localize(s.track) : null; },
  playing() { return !!this.st()?.playing; },
  pos() { const s = this.st(); if (!s) return 0; const p = (s.position || 0) + (s.playing ? (Date.now() - s.recvAt) / 1000 * (s.rate || 1) : 0); return s.duration ? Math.min(p, s.duration) : p; },
  dur() { return this.st()?.duration || 0; },
  // il server manda ping e riceve battiti (livehb): solo allora il cane da guardia ha senso
  hb() { return !!srv()?.me?.caps?.includes('livehb'); },
  stop() { clearTimeout(this.retry); clearInterval(this.dog); this.es?.close(); this.es = null; this.devices.clear(); this.states.clear(); this.target = null; this.sent = null; this.paint(); },
  connect() {
    const was = this.target; this.stop(); this.want = was;
    if (!this.on()) return;
    const s = srv(), hb = this.hb();
    const es = this.es = new EventSource(`${absUrl(s.url)}/api/live?device=${encodeURIComponent(S.device)}&name=${encodeURIComponent(this.name())}&token=${encodeURIComponent(s.session)}${hb ? '&hb=1' : ''}`);
    this.last = Date.now();
    es.onmessage = e => { this.last = Date.now(); try { this.recv(JSON.parse(e.data)); } catch {} };
    es.onopen = () => { this.fails = 0; this.last = Date.now(); this.sent = null; this.publish(); };
    // EventSource si ricollega da solo dopo un errore di rete; se il server rifiuta (sessione scaduta) chiude:
    // si rifà l'accesso con tok/salt e si riprova, sempre più piano
    es.onerror = () => { if (es.readyState === EventSource.CLOSED && this.es === es) { clearInterval(this.dog); this.retry = setTimeout(() => this.relogin(), Math.min(60000, 5000 * ++this.fails)); } };
    // cane da guardia: un canale mezzo morto (app uccisa, rete cambiata, schermo spento) resta "aperto" per sempre.
    // Il battito va a tempo, non a giri: in sottofondo i timer possono scattare anche solo una volta al minuto
    if (hb) this.dog = setInterval(() => { if (Date.now() - this.last > 40000) this.connect(); else if (Date.now() - this.beatAt > 25000) this.beat(); }, 10000);
  },
  async relogin() { await syncSessions(); this.connect(); },
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
    if (m.type === 'hello') {
      this.devices = new Map(arr(m.devices).map(d => [d.device, d.name]));
      this.states = new Map(arr(m.states).map(s => [s.device, { ...s, recvAt: now }]));
      const p = arr(m.states).find(s => s.playing && !s.solo);
      // dopo un riaggancio si torna telecomando di chi suona, o di chi si comandava prima
      if (Engine.el.paused && !Jam.role && !P.solo) this.target = p ? p.device : this.devices.has(this.want) ? this.want : null;
    } else if (m.type === 'join') {
      // anche dopo un fantasma: è una sessione nuova, lo stato vecchio non vale più
      this.devices.set(m.device, m.name); this.states.delete(m.device);
    } else if (m.type === 'gone') {
      const name = this.devices.get(m.device); this.devices.delete(m.device); this.states.delete(m.device);
      if (this.target === m.device) { this.target = null; toast(`${name || 'Il dispositivo'} si è scollegato.`); }
    } else if (m.type === 'state') {
      const s = { ...m.state, recvAt: now }; this.states.set(s.device, s); this.devices.set(s.device, s.name);
      if (s.solo && this.target === s.device) this.target = null;  // si è sganciato: non è più la nostra uscita
      if (s.playing && !s.solo && !P.solo && !Jam.role) {
        // un solo dispositivo suona: chi comincia ferma gli altri
        if (!Engine.el.paused) { Engine.el.pause(); toast(`La musica è passata su ${s.name}.`); }
        this.target = s.device;
      }
    } else if (m.type === 'cmd') return this.exec(m);
    this.paint();
    if (this.remote() && this.track()?.id !== before && location.hash.startsWith('#/ora')) vNow();
  },
  exec(m) {
    const v = m.value;
    if (m.cmd === 'transfer' && v && Array.isArray(v.queue)) {
      this.target = null; this.pill(); S.queue = v.queue.map(localize).filter(Boolean);
      if (S.queue.length) this.play(Math.min(v.index || 0, S.queue.length - 1), v.position || 0);
      return;
    }
    if (m.cmd === 'handoff') { if (v?.to && v.to !== S.device) this.give(v.to); return; }
    if (this.remote() || !S.queue[S.index]) return;  // i comandi valgono solo per chi suona
    ({ play: () => Engine.el.paused && ctlToggle(), pause: () => !Engine.el.paused && ctlToggle(), toggle: ctlToggle,
      next: () => ctlNext(false), prev: ctlPrev, seek: () => typeof v === 'number' && ctlSeek(v), shuffle: ctlShuffle, repeat: ctlRepeat })[m.cmd]?.();
  },
  async play(i, pos) {
    persistQueue(); await playIndex(i, { startAt: pos });
    // il browser può bloccare l'audio partito senza un tocco su questa pagina; l'app no
    setTimeout(() => { if (Engine.el.paused && !this.target) toast('Il browser ha bloccato l\'avvio: premi play per ascoltare qui.', 6000); }, 1500);
  },
  pack(q, i, pos) { const from = Math.max(0, i - 50); return { queue: q.slice(from, from + 300).map(wire), index: i - from, position: pos }; },
  // la coda di questo dispositivo va a un altro, che riparte dallo stesso punto; qui si diventa telecomando
  async give(to) {
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
    try { await srvApi(s, '/api/live/cmd', { method: 'POST', body: JSON.stringify({ to, cmd, value, from: S.device }) }); }
    catch { toast(`${this.devices.get(to) || 'Il dispositivo'} non risponde.`); }
  },
  publish() {
    if (!this.es || !this.on() || Jam.role === 'guest') return;
    const t = S.queue[S.index]; if (!t) return;
    if (this.remote() && !this.sent?.playing) return;  // telecomando: niente da dire, salvo la pausa appena fatta
    const now = { device: S.device, name: this.name(), solo: !!P.solo, playing: !Engine.el.paused, position: Engine.time(), duration: Engine.duration(), rate: P.speed, shuffle: S.shuffle, repeat: S.repeat, track: wire(t) };
    if (now.playing && this.target) { this.target = null; this.pill(); }
    const s = this.sent, exp = s ? s.position + (s.playing ? (Date.now() - s.at) / 1000 * s.rate : 0) : 0;
    if (s && s.track.id === now.track.id && s.playing === now.playing && s.rate === now.rate && s.solo === now.solo && s.shuffle === now.shuffle && s.repeat === now.repeat && Math.abs(exp - now.position) < 2) return;
    this.sent = { ...now, at: Date.now() };
    srvApi(srv(), '/api/live/state', { method: 'POST', body: JSON.stringify(now) }).catch(() => {});
  },
  pill() {
    const pill = $('#livePill'); if (!pill) return;
    const remote = this.remote();
    pill.hidden = !this.devices.size;
    pill.classList.toggle('on', remote);
    pill.innerHTML = `${ic('speaker')}<span>${esc(remote ? this.devices.get(this.target) || '…' : P.solo ? 'Per conto suo' : 'Qui')}</span>`;
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
      <span class="grow"><b>${esc(name)}${id === S.device ? ' · questo' : ''}</b><small>${st?.track ? `${st.playing ? 'Suona' : 'In pausa'}: ${esc(st.track.title)}` : 'Pronto'}${st?.solo ? ' · per conto suo' : ''}</small></span>${cur ? ic('check') : ''}</button>`;
    d.innerHTML = `<div class="head"><span style="min-width:0"><b style="display:block">Dove suona</b><small style="color:var(--muted)">La musica si sposta sul dispositivo che scegli, dallo stesso punto.</small></span></div>
      ${row(S.device, this.name(), mine, here)}${[...this.devices].map(([id, n]) => row(id, n, this.states.get(id), !here && this.target === id)).join('')}
      <label class="check" style="padding:12px 14px 6px;border-top:1px solid var(--line);margin-top:6px"><input type="checkbox" id="liveSolo" ${P.solo ? 'checked' : ''}><span>Questo dispositivo suona per conto suo<small>Sganciato: non si ferma quando suona un altro tuo dispositivo e non lo ferma. Potete ascoltare cose diverse insieme.</small></span></label>`;
    d.querySelectorAll('[data-dev]').forEach(b => b.onclick = () => { d.close(); this.choose(b.dataset.dev); });
    $('#liveSolo').onchange = e => {
      P.solo = e.target.checked; savePrefs(); this.sent = null;
      if (P.solo) this.target = null;  // sganciato: niente più telecomando
      this.publish(); this.paint(); this.sheet();
    };
    closeOutside(d); d.showModal();
  },
  async choose(id) {
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

/* ================= controlli del lettore e avvio ================= */
function wirePlayer() {
  $('#bPrev').innerHTML = ic('prev'); $('#bNext').innerHTML = ic('next'); $('#bQueue').innerHTML = ic('queue'); $('#bQm').innerHTML = ic('sliders'); $('#bLyr').innerHTML = ic('lyrics');
  $('#bPlay').onclick = ctlToggle; $('#bNext').onclick = () => ctlNext(false); $('#bPrev').onclick = ctlPrev;
  $('#bQueue').onclick = () => location.hash = '#/coda';
  $('#bLyr').onclick = () => { sessionStorage.setItem('armony:nowtab', 'lyr'); location.hash = '#/ora'; };
  $('#npBtn').onclick = () => location.hash = '#/ora';
  $('#bQm').onclick = qualityDialog; $('#qBadge').onclick = qualityDialog;
  $('#sleepPill').onclick = sleepDialog; $('#jamPill').onclick = () => location.hash = '#/jam';
  $('#bShuf').onclick = () => {
    if (Jam.role === 'guest') return toast('Durante una Jam l\'ordine lo decide l\'host.');
    Live.remote() ? Live.cmd('shuffle') : ctlShuffle();
  };
  $('#bRep').onclick = () => Live.remote() ? Live.cmd('repeat') : ctlRepeat();
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
    else if (k === 'f') { const t = currentTrack(); if (t) api(t.starred ? 'unstar' : 'star', { id: t.id }, srv(t.serverId)).then(() => { t.starred = !t.starred; toast(t.starred ? 'Aggiunto ai preferiti.' : 'Tolto dai preferiti.'); }); }
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
  $('#nav').innerHTML = NAV.map(([h, l, i]) => `<a href="#/${h}" data-r="${h}">${ic(i)}<span class="lbl">${l}</span></a>`).join('');
  Bus.addEventListener('playlists', sidePlaylists); sidePlaylists();
  $('#tabs').innerHTML = NAV.filter(([h]) => TABS.includes(h)).map(([h, l, i]) => `<a href="#/${h}" data-r="${h}">${ic(i)}<span>${l}</span></a>`).join('')
    + `<button type="button" id="tabMore" aria-haspopup="dialog">${ic('more')}<span>Altro</span></button>`;
  $('#tabMore').onclick = moreSheet;
  Wave.init();
  Engine.init(); wirePlayer();
  await Offline.init();
  fillSelectors(); updateNowPlaying(); paintTime();
  const t = S.queue[S.index];
  if (t && (srv(t.serverId) || Offline.has(t))) await Engine.load(t, Engine.cur, { autoplay: false, startAt: store.get('pos', 0) });
  addEventListener('hashchange', route);
  addEventListener('online', () => { toast('Di nuovo online.'); fillSelectors(); });
  addEventListener('offline', () => toast('Sei offline: puoi ascoltare i brani salvati.'));
  navigator.connection?.addEventListener?.('change', fillSelectors);
  if ('serviceWorker' in navigator && /^https?:/.test(location.protocol) && !NATIVE) navigator.serviceWorker.register('sw.js').catch(() => {});
  NativeMedia.init(); if (NATIVE) { nativeBack(); AppUpdate.init(); }
  Jam.init();
  route();
  setTimeout(resolvePending, 8000);
  addEventListener('online', () => { HistSync.run(); Live.wake(true); });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && Live.wake());
  window.Capacitor?.Plugins?.App?.addListener('resume', () => Live.wake());
  $('#livePill').onclick = () => Live.sheet();
  syncSessions().then(async () => { Live.connect(); notifyUpdate(); await PrefSync.pull(); await HistSync.run(); if (/^#\/(impostazioni|scarica|statistiche|album-dz|artista-dz)/.test(location.hash)) route(); });
}
