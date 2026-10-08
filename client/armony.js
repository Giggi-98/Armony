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
function pickFile(accept) {
  return new Promise(res => { const f = $('#filePick'); f.accept = accept; f.value = ''; f.onchange = () => res(f.files[0] || null); f.click(); });
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
  nick: '', stun: true, turn: { url: '', user: '', pass: '' }, theme: 'auto', volume: 1, visualizer: true, sync: true
};
const P = Object.assign({}, DEFAULT_PREFS, store.get('prefs', {}));
// restano su questo dispositivo anche con la sincronizzazione attiva
const DEVICE_PREFS = ['compat', 'volume', 'sync'];
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
  return sr;
}
const norm = (x, sid = S.active) => ({
  id: x.id, title: x.title || 'Senza titolo', artist: x.displayArtist || x.artist || 'Artista sconosciuto',
  artistId: x.artistId, album: x.album || '', albumId: x.albumId, duration: x.duration || 0, track: x.track,
  coverArt: x.coverArt, starred: !!x.starred, suffix: x.suffix, bitRate: x.bitRate, genre: x.genre, year: x.year,
  rg: x.replayGain ? { trackGain: x.replayGain.trackGain, albumGain: x.replayGain.albumGain, trackPeak: x.replayGain.trackPeak, albumPeak: x.replayGain.albumPeak } : null,
  serverId: sid
});
const coverUrl = (coverArt, size = 300, sid) => { const s = srv(sid); return coverArt && s ? apiUrl(s, 'getCoverArt', { id: coverArt, size }) : ''; };
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

/* ================= router ================= */
const NAV = [
  ['home', 'Home', 'home'], ['cerca', 'Cerca', 'search'], ['libreria', 'Libreria', 'lib'], ['playlist', 'Playlist', 'list'],
  ['preferiti', 'Preferiti', 'heart'], ['jam', 'Jam', 'jam'], ['amici', 'Amici', 'friends'], ['offline', 'Offline', 'offline'],
  ['statistiche', 'Statistiche', 'stats'], ['scarica', 'Scarica', 'down'], ['impostazioni', 'Impostazioni', 'gear']
];
const view = $('#view');
const ROUTE_PARENT = { album: 'libreria', artista: 'libreria', genere: 'libreria', decennio: 'libreria' };
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
  const fn = {
    home: vHome, cerca: vSearch, libreria: vLibrary, artista: vArtist, album: vAlbum, genere: vGenre, decennio: vDecade,
    playlist: id ? vPlaylist : vPlaylists, preferiti: vStarred, coda: vQueue, ora: vNow, amici: vFriends, offline: vOffline,
    statistiche: vStats, scarica: vDownload, impostazioni: vSettings, jam: vJam, tasti: vKeys
  }[r] || vHome;
  delete view.dataset.pl;
  view.innerHTML = '<p class="sub">Caricamento…</p>';
  try { await fn(id); }
  catch (e) {
    console.error(e);
    view.innerHTML = `<div class="empty"><h3>Qualcosa non ha funzionato</h3><p>${esc(e.message)}</p>
      <div class="row" style="justify-content:center"><button class="btn" onclick="route()">Riprova</button><a class="btn" href="#/impostazioni">Impostazioni</a>${Offline.keys.size ? '<a class="btn" href="#/offline">Ascolta offline</a>' : ''}</div></div>`;
  }
  if (!['ora'].includes(r)) window.scrollTo(0, 0);
}

/* ================= componenti ================= */
function albumGrid(albums, opts = {}) {
  if (!albums.length) return `<div class="empty">${opts.empty || 'Nessun album.'}</div>`;
  return `<div class="albums ${opts.strip ? 'strip' : ''}">${albums.map(a => `
    <button class="alb" data-act="album" data-id="${esc(a.id)}">
      <div class="art">${imgTag(a.coverArt, 300, opts.sid)}</div>
      <b>${esc(a.name || a.title)}</b><small>${esc(a.artist || '')}${a.year ? ' (' + a.year + ')' : ''}</small>
    </button>`).join('')}</div>`;
}
function songList(tracks, opts = {}) {
  S.lastList = tracks;
  if (!tracks.length) return `<div class="empty">${opts.empty || 'Nessun brano.'}</div>`;
  const cur = currentTrack();
  const art = opts.art !== false;
  return `<div class="songs">${tracks.map((t, i) => `
    <div class="song ${art ? '' : 'noart'} ${cur && key(cur) === key(t) ? 'now' : ''}" data-act="${opts.queue ? 'qplay' : 'play'}" data-i="${i}">
      <span class="n">${opts.queue ? i + 1 : (opts.numbers ? (t.track || i + 1) : i + 1)}</span>
      <span class="thumb">${art ? imgTag(t.coverArt, 84, t.serverId) : ''}</span>
      <span class="t"><b>${Offline.has(t) ? '<span class="badge-off" title="Disponibile offline"></span>' : ''}${esc(t.title)}</b><small>${esc(t.artist)}${opts.showAlbum !== false && t.album ? ' · ' + esc(t.album) : ''}</small></span>
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
const listActions = (extra = '') => `<div class="row" style="margin-bottom:16px">
  <button class="btn primary" data-act="playall">${ic('play')} Riproduci</button>
  <button class="btn" data-act="shuffleall">${ic('shuffle')} Mescola</button>
  <button class="btn" data-act="enqueueall">${ic('plus')} In coda</button>
  <button class="btn" data-act="offlineall">${ic('offline')} Offline</button>${extra}</div>`;
function noServer() {
  const local = /^https?:/.test(location.protocol) && !NATIVE;
  view.innerHTML = `<h1>Benvenuto in Armony</h1><p class="sub">La musica della vostra compagnia, dai vostri server.</p>
  <div class="empty"><h3>Collega il primo server</h3><p>Ti servono un nome utente e una password del server musicale.</p>
  <div class="row" style="justify-content:center">
    <button class="btn primary" data-act="addsrv" ${local ? `data-url="${esc(location.origin)}"` : ''}>Aggiungi server</button>
    <button class="btn" data-act="importset">Importa impostazioni da un amico</button>
    <a class="btn" href="#/jam">Entra in una Jam</a>
  </div></div>`;
}

/* ================= viste: libreria ================= */
async function vHome() {
  if (!srv()) return noServer();
  const s = srv();
  if (!navigator.onLine) { location.hash = '#/offline'; return; }
  const [nw, rnd, freq, recent, genres] = await Promise.all([
    api('getAlbumList2', { type: 'newest', size: 18 }),
    api('getAlbumList2', { type: 'random', size: 12 }),
    api('getAlbumList2', { type: 'frequent', size: 14 }).catch(() => null),
    api('getAlbumList2', { type: 'recent', size: 14 }).catch(() => null),
    api('getGenres').catch(() => null)
  ]);
  const g = arr(genres?.genres?.genre).sort((a, b) => b.songCount - a.songCount).slice(0, 18);
  const hour = new Date().getHours();
  const hello = hour < 6 ? 'Buonanotte' : hour < 13 ? 'Buongiorno' : hour < 18 ? 'Buon pomeriggio' : 'Buonasera';
  view.innerHTML = `<h1>${hello}, ${esc(P.nick || s.user)}</h1><p class="sub">Stai ascoltando da ${esc(s.name)}.</p>
    <div id="resume"></div><div id="friendsStrip"></div>
    <div class="row" style="margin-bottom:6px">
      <button class="btn primary" data-act="radio">${ic('shuffle')} Mix casuale</button>
      <button class="btn" data-act="mixfav">${ic('heart')} Mix preferiti</button>
      <button class="btn" data-act="mixforgot">${ic('radio')} Riscoperte</button>
      <a class="btn" href="#/jam">${ic('jam')} Avvia una Jam</a>
    </div>
    ${arr(recent?.albumList2?.album).length ? `<h2>Ascoltati di recente</h2>${albumGrid(arr(recent.albumList2.album), { strip: true })}` : ''}
    <h2>Aggiunti di recente</h2>${albumGrid(arr(nw.albumList2.album), { strip: true })}
    ${arr(freq?.albumList2?.album).length ? `<h2>I più ascoltati</h2>${albumGrid(arr(freq.albumList2.album), { strip: true })}` : ''}
    ${g.length ? `<h2>Generi</h2><div class="chips">${g.map(x => `<a class="chip" href="#/genere/${encodeURIComponent(x.value)}">${esc(x.value)} <small>${x.songCount}</small></a>`).join('')}</div>` : ''}
    <h2>Per decennio</h2><div class="chips">${[1960, 1970, 1980, 1990, 2000, 2010, 2020].map(d => `<a class="chip" href="#/decennio/${d}">Anni ${String(d).slice(2)}</a>`).join('')}</div>
    <h2>Da riscoprire</h2>${albumGrid(arr(rnd.albumList2.album))}`;
  QSync.check().then(q => {
    if (!q || !$('#resume')) return;
    $('#resume').innerHTML = `<div class="banner"><span class="grow">Stavi ascoltando <b>${esc(q.current.title)}</b> su un altro dispositivo${q.by ? ` (${esc(q.by)})` : ''}.</span>
      <button class="btn primary" data-act="resumeq">Riprendi da ${fmt(q.position)}</button></div>`;
    $('#resume').querySelector('button').onclick = () => { S.queue = q.tracks; playIndex(q.index, { startAt: q.position }); $('#resume').innerHTML = ''; };
  });
  friendsNow().then(list => {
    const box = $('#friendsStrip'); if (!box || !list.length) return;
    box.innerHTML = `<div class="banner"><span class="grow">${list.slice(0, 3).map(f => `<b>${esc(f.username)}</b> sta ascoltando ${esc(f.title)}`).join(', ')}${list.length > 3 ? ` e altri ${list.length - 3}` : ''}.</span><a class="btn sm" href="#/amici">Vedi</a></div>`;
  });
}
async function vLibrary(tab = 'artisti') {
  if (!srv()) return noServer();
  tab = tab || 'artisti';
  const tabs = `<h1>Libreria</h1><div class="tabs">${[['artisti', 'Artisti'], ['album', 'Album'], ['generi', 'Generi'], ['brani', 'Brani a caso']].map(([k, l]) => `<a href="#/libreria/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</div>`;
  if (tab === 'artisti') {
    const idx = arr((await api('getArtists')).artists.index);
    view.innerHTML = tabs + `<p class="sub">${idx.reduce((n, x) => n + arr(x.artist).length, 0)} artisti.</p>` +
      idx.map(x => `<div class="letter">${esc(x.name)}</div>` + arr(x.artist).map(a =>
        `<div class="list-item" data-act="artist" data-id="${esc(a.id)}"><span class="pic" style="border-radius:50%">${imgTag(a.coverArt, 100)}</span><span class="grow"><b>${esc(a.name)}</b></span><small>${a.albumCount || 0} album</small></div>`).join('')).join('');
  } else if (tab === 'album') {
    let offset = 0, sort = sessionStorage.getItem('armony:asort') || 'alphabeticalByName';
    view.innerHTML = tabs + `<div class="row" style="margin-bottom:16px"><select id="aSort" style="width:auto">
      ${[['alphabeticalByName', 'Per titolo'], ['alphabeticalByArtist', 'Per artista'], ['newest', 'Aggiunti di recente'], ['frequent', 'Più ascoltati'], ['starred', 'Preferiti'], ['random', 'A caso']].map(([v, l]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div><div id="aGrid"></div><div class="row" style="justify-content:center;margin-top:20px"><button class="btn" id="aMore">Carica altri</button></div>`;
    const load = async (reset) => {
      if (reset) { offset = 0; $('#aGrid').innerHTML = ''; }
      const al = arr((await api('getAlbumList2', { type: sort, size: 60, offset })).albumList2.album);
      $('#aGrid').insertAdjacentHTML('beforeend', albumGrid(al, { empty: offset ? 'Non ci sono altri album.' : 'Nessun album.' }));
      offset += al.length; $('#aMore').hidden = al.length < 60;
    };
    $('#aSort').onchange = e => { sort = e.target.value; sessionStorage.setItem('armony:asort', sort); load(true); };
    $('#aMore').onclick = () => load(false);
    await load(true);
  } else if (tab === 'generi') {
    const g = arr((await api('getGenres')).genres.genre).sort((a, b) => a.value.localeCompare(b.value));
    view.innerHTML = tabs + (g.length ? `<div class="chips">${g.map(x => `<a class="chip" href="#/genere/${encodeURIComponent(x.value)}">${esc(x.value)} <small>${x.songCount} brani, ${x.albumCount} album</small></a>`).join('')}</div>` : '<div class="empty">Nessun genere nei metadati dei brani.</div>');
  } else {
    const r = await api('getRandomSongs', { size: 80 });
    view.innerHTML = tabs + listActions(`<button class="btn" onclick="route()">${ic('shuffle')} Altri</button>`) + songList(arr(r.randomSongs.song).map(x => norm(x)));
  }
}
async function vArtist(id) {
  const a = (await api('getArtist', { id })).artist;
  let info = null; try { info = (await api('getArtistInfo2', { id, count: 8 })).artistInfo2; } catch {}
  let top = []; try { top = arr((await api('getTopSongs', { artist: a.name, count: 10 })).topSongs?.song).map(x => norm(x)); } catch {}
  const bio = (info?.biography || '').replace(/<a[^>]*>.*?<\/a>/g, '').replace(/<[^>]+>/g, '').trim();
  view.innerHTML = `<div class="hero"><div class="art" style="border-radius:50%">${info?.largeImageUrl ? `<img src="${esc(info.largeImageUrl)}" alt="" onerror="this.remove()">` : imgTag(a.coverArt, 400)}</div>
    <div><h1>${esc(a.name)}</h1><p class="sub">${a.albumCount || 0} album</p>
    <div class="row"><button class="btn primary" data-act="artistall" data-id="${esc(id)}">${ic('play')} Riproduci tutto</button>
    <button class="btn" data-act="artistradio" data-name="${esc(a.name)}" data-id="${esc(id)}">${ic('radio')} Radio artista</button></div></div></div>
    ${bio ? `<p style="max-width:70ch;color:var(--muted)">${esc(bio.slice(0, 600))}${bio.length > 600 ? '…' : ''}</p>` : ''}
    ${top.length ? `<h2>Brani più popolari</h2>${songList(top)}` : ''}
    <h2>Album</h2>${albumGrid(arr(a.album))}
    ${arr(info?.similarArtist).length ? `<h2>Artisti simili</h2><div class="chips">${arr(info.similarArtist).map(x => x.id ? `<a class="chip" href="#/artista/${encodeURIComponent(x.id)}">${esc(x.name)}</a>` : `<span class="chip">${esc(x.name)}</span>`).join('')}</div>` : ''}`;
}
async function vAlbum(id) {
  const a = (await api('getAlbum', { id })).album;
  const songs = arr(a.song).map(x => norm(x));
  const tot = songs.reduce((n, t) => n + t.duration, 0);
  const discs = new Set(songs.map(s => s.disc)).size;
  view.innerHTML = `<div class="hero"><div class="art">${imgTag(a.coverArt, 500)}</div>
    <div><h1>${esc(a.name)}</h1><p class="sub"><a href="#/artista/${encodeURIComponent(a.artistId || '')}">${esc(a.artist)}</a>${a.year ? ', ' + a.year : ''}${a.genre ? ', ' + esc(a.genre) : ''}. ${songs.length} brani, ${fmtLong(tot)}${discs > 1 ? ', ' + discs + ' dischi' : ''}.</p></div></div>
    ${listActions(`<button class="btn ${a.starred ? 'primary' : ''}" data-act="staralbum" data-id="${esc(id)}" data-on="${a.starred ? 1 : 0}">${ic('heart', a.starred)} ${a.starred ? 'Nei preferiti' : 'Preferito'}</button>
      <button class="btn" data-act="shareitem" data-id="${esc(id)}" data-name="${esc(a.name)}">${ic('share')} Condividi</button>
      <button class="btn" data-act="addalltopl">${ic('addlist')} In playlist</button>`)}
    ${songList(songs, { showAlbum: false, art: false, numbers: true })}`;
}
async function vGenre(name) {
  const [songs, albums] = await Promise.all([
    api('getSongsByGenre', { genre: name, count: 200 }),
    api('getAlbumList2', { type: 'byGenre', genre: name, size: 30 }).catch(() => null)
  ]);
  const so = arr(songs.songsByGenre.song).map(x => norm(x));
  view.innerHTML = `<h1>${esc(name)}</h1><p class="sub">${so.length} brani.</p>
    ${arr(albums?.albumList2?.album).length ? `<h2>Album</h2>${albumGrid(arr(albums.albumList2.album), { strip: true })}<h2>Brani</h2>` : ''}
    ${listActions()}${songList(so)}`;
}
async function vDecade(y) {
  y = +y;
  const al = arr((await api('getAlbumList2', { type: 'byYear', fromYear: y, toYear: y + 9, size: 120 })).albumList2.album);
  view.innerHTML = `<h1>Anni ${String(y).slice(2)}</h1><p class="sub">${al.length} album dal ${y} al ${y + 9}.</p>
    <div class="row" style="margin-bottom:18px"><button class="btn primary" data-act="decademix" data-y="${y}">${ic('shuffle')} Mix del decennio</button></div>${albumGrid(al)}`;
}
async function vSearch() {
  if (!srv()) return noServer();
  view.innerHTML = `<h1>Cerca</h1><p class="sub">Su ${esc(srv().name)}. Se un brano non c'è, puoi cercarlo online e scaricarlo.</p>
    <input type="search" id="q" placeholder="Titolo, artista, album" autofocus aria-label="Cerca"><div id="res"></div>`;
  let t;
  const q = $('#q'); q.value = sessionStorage.getItem('armony:q') || '';
  const run = async () => {
    const v = q.value.trim(); sessionStorage.setItem('armony:q', v);
    if (v.length < 2) { $('#res').innerHTML = ''; return; }
    try {
      const r = (await api('search3', { query: v, songCount: 60, albumCount: 18, artistCount: 12 })).searchResult3;
      const ar = arr(r.artist), al = arr(r.album), so = arr(r.song).map(x => norm(x));
      $('#res').innerHTML =
        (ar.length ? `<h2>Artisti</h2><div class="chips">` + ar.map(a => `<a class="chip" href="#/artista/${encodeURIComponent(a.id)}">${esc(a.name)}</a>`).join('') + '</div>' : '') +
        (al.length ? `<h2>Album</h2>${albumGrid(al, { strip: true })}` : '') +
        `<h2>Brani</h2>${so.length ? listActions() : ''}${songList(so, { empty: `Nessun brano trovato. <a href="#/scarica/cerca/${encodeURIComponent(v)}">Cerca "${esc(v)}" online</a>` })}`;
    } catch (e) { $('#res').innerHTML = `<p class="sub">${esc(e.message)}</p>`; }
  };
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 280); });
  run();
}
async function vPlaylists() {
  if (!srv()) return noServer();
  const pls = arr((await api('getPlaylists')).playlists.playlist);
  view.innerHTML = `<h1>Playlist</h1><p class="sub">Le playlist pubbliche sono condivise con tutti gli utenti del server.</p>
    <div class="row" style="margin-bottom:18px">
      <button class="btn primary" data-act="newpl">${ic('plus')} Nuova playlist</button>
      <button class="btn" data-act="importpl">Importa (M3U, JSON, CSV di Spotify)</button>
    </div>
    ${pls.length ? pls.map(p => `<div class="list-item" data-act="openpl" data-id="${esc(p.id)}">
      <span class="pic">${imgTag(p.coverArt, 100)}</span>
      <span class="grow"><b>${esc(p.name)}</b><small>${p.songCount} brani, ${fmtLong(p.duration || 0)}${p.owner ? ', di ' + esc(p.owner) : ''}</small></span>
      ${p.public ? '<span class="tag acc">condivisa</span>' : ''}</div>`).join('')
      : '<div class="empty"><h3>Ancora nessuna playlist</h3><p>Creane una o importala da Spotify, da un\'altra app o da un amico.</p></div>'}`;
}
async function vPlaylist(id) {
  const p = (await api('getPlaylist', { id })).playlist;
  const songs = arr(p.entry).map(x => norm(x));
  view.innerHTML = `<div class="hero"><div class="art">${imgTag(p.coverArt, 500)}</div><div>
    <h1>${esc(p.name)}</h1><p class="sub">${songs.length} brani, ${fmtLong(p.duration || 0)}${p.owner ? '. Creata da ' + esc(p.owner) : ''}${p.public ? '. Condivisa con tutti' : ''}.</p>
    ${p.comment ? `<p>${esc(p.comment)}</p>` : ''}</div></div>
    ${listActions(`
      <button class="btn" data-act="exportpl" data-id="${esc(id)}">Esporta</button>
      <button class="btn" data-act="shareitem" data-id="${esc(id)}" data-name="${esc(p.name)}">${ic('share')} Link</button>
      <button class="btn" data-act="editpl" data-id="${esc(id)}">Modifica</button>
      <button class="btn danger" data-act="delpl" data-id="${esc(id)}">Elimina</button>`)}
    ${songList(songs, { empty: 'Playlist vuota. Aggiungi brani dal menu ⋯ accanto a ogni canzone.' })}`;
  view.dataset.pl = id;
  view.dataset.plMeta = JSON.stringify({ name: p.name, comment: p.comment || '', public: !!p.public });
}
async function vStarred() {
  if (!srv()) return noServer();
  const r = (await api('getStarred2')).starred2;
  const songs = arr(r.song).map(x => norm(x));
  view.innerHTML = `<h1>Preferiti</h1><p class="sub">${songs.length} brani, ${arr(r.album).length} album, ${arr(r.artist).length} artisti.</p>
    ${arr(r.artist).length ? `<h2>Artisti</h2><div class="chips">${arr(r.artist).map(a => `<a class="chip" href="#/artista/${encodeURIComponent(a.id)}">${esc(a.name)}</a>`).join('')}</div>` : ''}
    ${arr(r.album).length ? `<h2>Album</h2>${albumGrid(arr(r.album), { strip: true })}` : ''}
    <h2>Brani</h2>${listActions()}${songList(songs, { empty: 'Tocca il cuore accanto a un brano per ritrovarlo qui.' })}`;
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
function currentTrack() { return Jam.role === 'guest' ? Jam.track : S.queue[S.index]; }
const broadcastGuest = () => Jam.role === 'guest' && Jam.mode === 'broadcast';
function isPlaying() { return broadcastGuest() ? Jam.playing : !Engine.el.paused; }
function playPos() { return broadcastGuest() ? Jam.estPos() : Engine.time(); }
function playDur() { return broadcastGuest() ? (Jam.track?.duration || 0) : Engine.duration(); }
function persistQueue() { store.set('queue', S.queue.slice(0, 3000)); store.set('index', S.index); }
function setQueue(tracks, start = 0, shuffle = false) {
  if (Jam.role === 'guest') { tracks[start] && Jam.suggest(tracks[start]); return; }
  if (!tracks.length) return toast('Non ci sono brani da riprodurre.');
  let q = tracks.slice();
  if (shuffle) { q = shuffleArr(q); start = 0; }
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
  const a = Engine.el;
  if (!a.getAttribute('src')) { if (S.queue.length) playIndex(Math.max(0, S.index)); return; }
  Engine.graph(); a.paused ? a.play().catch(() => {}) : a.pause();
}
function ctlNext(auto) {
  if (Jam.role === 'guest') return Jam.guestControl('next');
  const n = S.index < S.queue.length - 1 ? S.index + 1 : (S.repeat === 'all' ? 0 : null);
  if (n != null) playIndex(n); else if (auto) Engine.el.pause();
}
function ctlPrev() {
  if (Jam.role === 'guest') return Jam.guestControl('prev');
  if (Engine.time() > 4 || S.index <= 0) ctlSeek(0); else playIndex(S.index - 1);
}
function ctlSeek(sec) {
  if (Jam.role === 'guest') return Jam.guestControl('seek', sec);
  try { Engine.el.currentTime = Math.max(0, sec); } catch {}
  emit('seek');
}
function updateNowPlaying() {
  const t = currentTrack();
  $('#npT').textContent = t ? t.title : 'Niente in riproduzione';
  $('#npA').textContent = t ? t.artist + (t.album ? ' · ' + t.album : '') : (Jam.role === 'guest' ? 'In attesa dell\'host della Jam' : 'Scegli un album o una playlist');
  $('#disc').innerHTML = t && t.coverArt && srv(t.serverId) ? `<img src="${esc(coverUrl(t.coverArt, 80, t.serverId))}" alt="" onerror="this.outerHTML='<div class=lbl></div>'">` : '<div class="lbl"></div>';
  document.title = t ? `${t.title} · ${t.artist}` : 'Armony';
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = t ? new MediaMetadata({ title: t.title, artist: t.artist, album: t.album,
      artwork: t.coverArt && srv(t.serverId) ? [{ src: coverUrl(t.coverArt, 512, t.serverId), sizes: '512x512' }] : [] }) : null;
  }
  paintButtons();
}
function paintButtons() {
  const playing = isPlaying();
  $('#bPlay').innerHTML = ic(playing ? 'pause' : 'play');
  $('#bPlay').setAttribute('aria-label', playing ? 'Pausa' : 'Riproduci');
  $('#disc').classList.toggle('spin', playing);
  $('#bigdisc')?.classList.toggle('spin', playing);
  $('#bShuf').innerHTML = ic('shuffle'); $('#bShuf').classList.toggle('on', S.shuffle);
  $('#bRep').innerHTML = ic('repeat') + (S.repeat === 'one' ? '<span class="mini">1</span>' : '');
  $('#bRep').classList.toggle('on', S.repeat !== 'off');
  $('#bRep').title = { off: 'Ripeti: no', all: 'Ripeti: tutta la coda', one: 'Ripeti: questo brano' }[S.repeat];
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}
let seeking = false;
function paintTime() {
  const d = playDur(), p = playPos();
  if (!seeking) { $('#seek').value = d ? p / d * 1000 : 0; $('#tCur').textContent = fmt(p); }
  $('#tDur').textContent = fmt(d);
  if ('mediaSession' in navigator && d && navigator.mediaSession.setPositionState) {
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(p, d), playbackRate: P.speed }); } catch {}
  }
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
  await paint(); viewInterval(paint, 15000);
  Jam.nearby().then(js => { const b = $('#fj'); if (b) b.innerHTML = js.length ? js.map(j => `<div class="list-item" data-act="jamknock" data-id="${esc(j.id)}" data-base="${esc(j.base || '')}"><span class="pic" style="display:grid;place-items:center">${ic('jam')}</span><span class="grow"><b>${esc(j.name)}</b><small>di ${esc(j.hostName || '?')}${j.server ? ', sul server ' + esc(j.server) : ''}</small></span><span class="btn sm">Chiedi di entrare</span></div>`).join('') : '<div class="empty">Nessuna Jam aperta sulla tua rete.</div>'; });
}

/* ================= in riproduzione: testi e visualizzatore ================= */
async function vNow() {
  const t = currentTrack();
  if (!t) { view.innerHTML = '<div class="empty"><h3>Niente in riproduzione</h3><p>Scegli qualcosa da ascoltare.</p><a class="btn primary" href="#/home">Vai alla home</a></div>'; return; }
  const tab = sessionStorage.getItem('armony:nowtab') || 'lyr';
  view.innerHTML = `<div class="now"><div>
      <div class="bigdisc ${isPlaying() ? 'spin' : ''}" id="bigdisc"><canvas id="viz" width="640" height="640"></canvas>
        <div class="rec">${t.coverArt && srv(t.serverId) ? `<img src="${esc(coverUrl(t.coverArt, 600, t.serverId))}" alt="">` : '<div class="lbl"></div>'}</div></div>
      <h1 style="margin-top:18px">${esc(t.title)}</h1>
      <p class="sub">${t.artistId ? `<a href="#/artista/${encodeURIComponent(t.artistId)}">${esc(t.artist)}</a>` : esc(t.artist)}${t.album ? ` · ${t.albumId ? `<a href="#/album/${encodeURIComponent(t.albumId)}">${esc(t.album)}</a>` : esc(t.album)}` : ''}</p>
      <div class="row">
        <button class="btn sm" data-act="nowmore">${ic('more')} Azioni</button>
        <button class="btn sm" data-act="sleep">${ic('moon')} Timer</button>
        <button class="btn sm" data-act="speed">${ic('speed')} ${P.speed}×</button>
        <button class="btn sm" data-act="eq">${ic('sliders')} Equalizzatore</button>
        ${Jam.role ? `<a class="btn sm" href="#/jam">${ic('jam')} Jam</a>` : ''}
      </div>
    </div>
    <div><div class="tabs">${[['lyr', 'Testi'], ['next', 'Prossimi'], ['info', 'Dettagli']].map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div><div id="nowPane"></div></div></div>`;
  view.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { sessionStorage.setItem('armony:nowtab', b.dataset.tab); vNow(); });
  const pane = $('#nowPane');
  let lyr = null;
  if (tab === 'lyr') {
    pane.innerHTML = '<p class="sub">Cerco il testo…</p>';
    lyr = await Lyrics.get(t);
    if (currentTrack() !== t || !$('#nowPane')) return;
    if (!lyr) pane.innerHTML = `<div class="empty">Testo non trovato.${P.lyricsOnline ? '' : ' Attiva la ricerca online dei testi nelle impostazioni.'}</div>`;
    else if (lyr.instrumental) pane.innerHTML = '<div class="empty">Brano strumentale.</div>';
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
  const recs = (await DB.all('offline').catch(() => [])).sort((a, b) => b.added - a.added);
  const tot = recs.reduce((n, r) => n + r.size, 0);
  let est = ''; try { const e = await navigator.storage.estimate(); est = `, spazio disponibile ${bytes(e.quota - e.usage)}`; } catch {}
  const tracks = recs.map(r => r.track);
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
  const all = await Stats.all();
  const from = period === 'all' ? 0 : period === 'year' ? new Date(new Date().getFullYear(), 0, 1).getTime() : Date.now() - (+period) * 864e5;
  const h = all.filter(x => x.ts >= from);
  const secs = h.reduce((n, x) => n + x.duration, 0);
  const count = (f) => { const m = new Map(); h.forEach(x => { const k = f(x); if (!k) return; const e = m.get(k) || { n: 0, x }; e.n++; m.set(k, e); }); return [...m.values()].sort((a, b) => b.n - a.n); };
  const songs = count(x => x.key), artists = count(x => x.artist), albums = count(x => x.albumId), genres = count(x => x.genre);
  const hours = Array(24).fill(0); h.forEach(x => hours[new Date(x.ts).getHours()]++);
  const maxH = Math.max(1, ...hours);
  const days = new Set(all.map(x => new Date(x.ts).toDateString()));
  let streak = 0; for (let d = new Date(); days.has(d.toDateString()); d.setDate(d.getDate() - 1)) streak++;
  const top = (list, label) => list.length ? `<ol class="rank">${list.slice(0, 10).map(e => `<li><span class="grow"><b>${label(e.x)}</b></span><small>${e.n} ascolti</small></li>`).join('')}</ol>` : '<p class="sub">Ancora nessun dato.</p>';
  view.innerHTML = `<h1>Statistiche</h1><p class="sub">${syncable(srv()) ? `Calcolate sui tuoi ascolti da tutti i tuoi dispositivi collegati a ${esc(srv().name)}.` : 'Calcolate sui tuoi ascolti da questo dispositivo. Restano qui, non vengono inviate a nessuno.'}</p>
    <div class="row" style="margin-bottom:18px"><div class="seg">${[['7', '7 giorni'], ['30', '30 giorni'], ['year', 'Quest\'anno'], ['all', 'Sempre']].map(([v, l]) => `<label><input type="radio" name="sp" value="${v}" ${v === period ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      <button class="btn" data-act="wrapped">${ic('image')} Crea immagine da condividere</button></div>
    <div class="bigstat"><div><b>${Math.round(secs / 60).toLocaleString('it-IT')}</b><small>minuti di musica</small></div><div><b>${h.length.toLocaleString('it-IT')}</b><small>ascolti</small></div>
      <div><b>${songs.length.toLocaleString('it-IT')}</b><small>brani diversi</small></div><div><b>${artists.length.toLocaleString('it-IT')}</b><small>artisti</small></div><div><b>${streak}</b><small>giorni di fila</small></div></div>
    <h2>Quando ascolti</h2><div class="panel"><div class="hours">${hours.map((v, i) => `<i style="height:${v / maxH * 100}%" title="${i}:00, ${v} ascolti"></i>`).join('')}</div>
      <div class="hours-l">${hours.map((_, i) => `<span>${i % 3 === 0 ? i : ''}</span>`).join('')}</div></div>
    <div class="grid2"><div><h2>Artisti</h2>${top(artists, x => esc(x.artist))}</div><div><h2>Brani</h2>${top(songs, x => `${esc(x.title)}<small style="display:block">${esc(x.artist)}</small>`)}</div></div>
    <div class="grid2"><div><h2>Album</h2>${top(albums, x => `${esc(x.album)}<small style="display:block">${esc(x.artist)}</small>`)}</div><div><h2>Generi</h2>${top(genres, x => esc(x.genre))}</div></div>
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
  <div class="row between"><h2>Download</h2><button class="btn sm" data-act="clearjobs">Rimuovi conclusi</button></div>
  <div id="jobs"><p class="sub">Caricamento…</p></div>
  <h2>Video</h2><div id="vids"></div>`;
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
    const rows = parseCSV(text); const h = rows.shift().map(x => x.toLowerCase());
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
const cleanTxt = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\(.*?\)|\[.*?\]|- .*remaster.*$|feat\..*$/g, '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
async function matchTrack(it, s = srv()) {
  const r = (await api('search3', { query: cleanTxt(it.title), songCount: 20, artistCount: 0, albumCount: 0 }, s)).searchResult3;
  const songs = arr(r.song), T = cleanTxt(it.title), A = cleanTxt(it.artist);
  const art = x => !A || cleanTxt(x.artist).includes(A) || A.includes(cleanTxt(x.artist));
  return songs.find(x => cleanTxt(x.title) === T && art(x)) || songs.find(x => cleanTxt(x.title).startsWith(T) && art(x)) || (A ? null : songs[0]);
}
async function addSongsToPlaylist(pid, ids, sid) { for (let i = 0; i < ids.length; i += 200) await api('updatePlaylist', { playlistId: pid, songIdToAdd: ids.slice(i, i + 200) }, srv(sid), true); }
async function createPlaylist(name, ids, sid = S.active) {
  const r = await api('createPlaylist', { name, songId: ids.slice(0, 200) }, srv(sid), true);
  const pid = r.playlist?.id; if (pid && ids.length > 200) await addSongsToPlaylist(pid, ids.slice(200), sid);
  return pid;
}
async function importPlaylist() {
  if (!srv()) return toast('Prima aggiungi un server.');
  const file = await pickFile('.m3u,.m3u8,.json,.csv,.txt'); if (!file) return;
  let parsed; try { parsed = parsePlaylistFile(file.name, await file.text()); } catch (e) { return toast(e.message || 'File non valido.'); }
  const { title, items } = parsed; if (!items.length) return toast('Nessun brano trovato nel file.');
  const d = $('#dlg');
  d.innerHTML = `<h3>Importo "${esc(title)}"</h3><p class="sub" id="impMsg">0 di ${items.length}</p><div class="bar"><i id="impBar" style="width:0"></i></div>`; d.showModal();
  const found = [], missing = [];
  for (let i = 0; i < items.length; i++) {
    try { const m = await matchTrack(items[i]); m ? found.push(m.id) : missing.push(items[i]); } catch { missing.push(items[i]); }
    if ($('#impMsg')) { $('#impMsg').textContent = `${i + 1} di ${items.length}`; $('#impBar').style.width = ((i + 1) / items.length * 100) + '%'; }
  }
  const pid = await createPlaylist(title, found);
  d.innerHTML = `<h3>Importazione conclusa</h3><p>${found.length} brani trovati su ${items.length}.</p>
    ${missing.length ? `<p class="sub" style="margin-bottom:6px">Mancano sul server:</p><div class="code" style="font-family:inherit;font-size:.88rem">${missing.map(m => esc((m.artist ? m.artist + ' - ' : '') + m.title)).join('<br>')}</div>
    <p class="small" style="color:var(--muted)">Armony può cercarli online, scaricarli e aggiungerli alla playlist appena la libreria si aggiorna.</p>` : ''}
    <div class="row">${missing.length ? '<button class="btn primary" id="getMissing">Scarica i mancanti</button>' : ''}<button class="btn" onclick="this.closest('dialog').close()">Chiudi</button></div>`;
  if (missing.length) $('#getMissing').onclick = async () => {
    try {
      for (const m of missing) await dlApi('/api/download', { method: 'POST', body: JSON.stringify({ url: `ytsearch1:${m.artist || ''} ${m.title} audio`, mode: 'audio', format: 'mp3', quality: 'best', folder: store.get('dlDir', 'Scaricati'), sponsorblock: true, meta: { artist: m.artist || '', title: m.title, album: m.album || '' } }) });
      const pend = store.get('pending', []); pend.push({ pid, sid: S.active, name: title, items: missing, created: Date.now() }); store.set('pending', pend);
      d.close(); toast(`${missing.length} download avviati. Li aggiungo alla playlist quando sono pronti.`); location.hash = '#/scarica';
    } catch (e) { toast(e.message); }
  };
  if (location.hash.startsWith('#/playlist')) route();
}
async function resolvePending() {
  let pend = store.get('pending', []); if (!pend.length) return;
  let added = 0;
  for (const p of pend) {
    const s = srv(p.sid); if (!s) continue;
    const still = [], ids = [];
    for (const it of p.items) { try { const m = await matchTrack(it, s); m ? ids.push(m.id) : still.push(it); } catch { still.push(it); } }
    if (ids.length) { try { await addSongsToPlaylist(p.pid, ids, p.sid); added += ids.length; } catch { still.push(...p.items.filter((_, i) => i < ids.length)); } }
    p.items = still;
  }
  pend = pend.filter(p => p.items.length && Date.now() - p.created < 7 * 864e5); store.set('pending', pend);
  if (added) toast(`${added} brani scaricati aggiunti alle playlist.`);
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
    ctx.pl != null ? ['trash', 'Togli dalla playlist', async () => { await api('updatePlaylist', { playlistId: view.dataset.pl, songIndexToRemove: ctx.pl }); route(); }] : null
  ].filter(Boolean);
  d.innerHTML = `<div class="head"><span class="pic">${imgTag(t.coverArt, 100, t.serverId)}</span><span style="min-width:0"><b style="display:block">${esc(t.title)}</b><small style="color:var(--muted)">${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</small></span></div>
    ${items.map(([i, l], n) => `<button class="mi" data-n="${n}">${ic(i)}${l}</button>`).join('')}`;
  d.querySelectorAll('[data-n]').forEach(b => b.onclick = () => { d.close(); items[+b.dataset.n][2](); });
  d.onclose = () => { d.className = ''; d.onclose = null; };
  d.showModal();
}

/* ================= impostazioni ================= */
function vSettings() {
  const opt = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${String(k) === String(cur) ? 'selected' : ''}>${v}</option>`).join('');
  const qOpts = Object.fromEntries(Object.entries(QUALITIES).map(([k, q]) => [k, q.label]));
  view.innerHTML = `<h1>Impostazioni</h1><p class="sub">Tutto resta su questo dispositivo, salvo ciò che sta sui server.</p>
  <h2>Profilo</h2><div class="panel stack"><label class="f">Il tuo nome nelle Jam<input type="text" id="pNick" value="${esc(P.nick)}" placeholder="Es. Giulia" maxlength="30"></label>
    <label class="check"><input type="checkbox" data-pb="sync" ${P.sync ? 'checked' : ''}><span>Stesse statistiche e impostazioni su tutti i dispositivi<small>Storico d'ascolto e preferenze vengono salvati sul server, legati al tuo utente. Chi gestisce il server può vederli. Volume e modalità compatibile restano di ogni dispositivo.</small></span></label></div>

  <h2>Server musicali</h2><p class="sub">Qualsiasi server compatibile Subsonic: Navidrome, Gonic, Airsonic, Ampache.</p>
  <div>${S.servers.map(s => `<div class="list-item" style="cursor:default">
    <span class="grow"><b>${esc(s.name)} ${s.id === S.active ? '<span class="tag ok">in uso</span>' : ''}</b><small>${esc(s.url)}, utente ${esc(s.user)}${s.me ? (s.me.admin ? ', amministratore' : '') + ` · Armony ${esc(s.me.version || '')}` : s.armony === false ? ' · solo ascolto (server senza Armony)' : ''}</small></span>
    ${s.id !== S.active ? `<button class="btn sm" data-act="usesrv" data-id="${s.id}">Usa</button>` : ''}
    <button class="btn sm" data-act="editsrv" data-id="${s.id}">Modifica</button>
    <button class="icon-btn" data-act="delsrv" data-id="${s.id}" aria-label="Rimuovi">${ic('trash')}</button></div>`).join('') || '<p class="sub">Nessun server.</p>'}</div>
  <div class="row" style="margin-top:12px"><button class="btn primary" data-act="addsrv">${ic('plus')} Aggiungi server</button><button class="btn" data-act="lanscan">${ic('wifi')} Cerca sulla rete</button></div>
  <div id="lanRes"></div>

  <h2>Ascolto</h2><div class="panel stack">
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
  </div>

  <h2>Testi e sincronizzazione</h2><div class="panel stack">
    <label class="check"><input type="checkbox" data-pb="lyricsOnline" ${P.lyricsOnline ? 'checked' : ''}><span>Cerca i testi online se il server non li ha<small>Usa LRCLIB, un archivio libero di testi sincronizzati. Invia solo titolo, artista e durata del brano.</small></span></label>
    <label class="check"><input type="checkbox" data-pb="syncQueue" ${P.syncQueue ? 'checked' : ''}><span>Continua su altri dispositivi<small>Salva la coda sul server: apri Armony sul PC e riprendi da dove eri al telefono.</small></span></label>
  </div>

  <h2>Jam</h2><div class="panel stack">
    <label class="check"><input type="checkbox" data-pb="stun" ${P.stun ? 'checked' : ''}><span>Permetti Jam via internet (5G)<small>Usa server STUN pubblici per scoprire l'indirizzo esterno. Non passa musica né chiavi da quei server.</small></span></label>
    <p class="small" style="color:var(--muted);margin:0">Server TURN (facoltativo). Serve quando operatori mobili o reti aziendali impediscono il collegamento diretto. Il traffico che vi passa resta cifrato.</p>
    <div class="grid2">
      <label class="f">Indirizzo TURN<input type="text" id="tUrl" value="${esc(P.turn.url)}" placeholder="turn:mio-server.it:3478"></label>
      <label class="f">Utente<input type="text" id="tUser" value="${esc(P.turn.user)}"></label>
      <label class="f">Password<input type="password" id="tPass" value="${esc(P.turn.pass)}"></label>
    </div>
  </div>

  ${access().admin ? `${srv()?.session ? '<h2>Utenti</h2><p class="sub">Chi ha fatto accesso a questo server da Armony. Gli amministratori di Navidrome possono sempre tutto.</p><div id="usrBox"><p class="sub">Caricamento…</p></div>' : ''}
  <h2>Aggiornamenti</h2><div class="panel" id="updBox"><p class="sub">Controllo…</p></div>` : ''}

  <h2>Aspetto</h2>
  <div class="seg">${[['auto', 'Automatico'], ['light', 'Chiaro'], ['dark', 'Scuro']].map(([v, l]) => `<label><input type="radio" name="theme" value="${v}" ${P.theme === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>

  <h2>Backup e trasferimento</h2>
  <p class="sub">Sposta tutto su un altro telefono, o passa la configurazione a un amico in dieci secondi.</p>
  <div class="row"><button class="btn" data-act="exportset">Esporta impostazioni</button><button class="btn" data-act="importset">Importa impostazioni</button><a class="btn" href="#/tasti">Scorciatoie da tastiera</a></div>
  <p class="small" style="color:var(--muted);margin-top:24px">Armony, dispositivo ${esc(S.device)}.</p>`;
  $('#pNick').onchange = e => { P.nick = e.target.value.trim(); savePrefs(); };
  view.querySelectorAll('[data-p]').forEach(el => el.onchange = () => { P[el.dataset.p] = el.value; savePrefs(); fillSelectors(); });
  view.querySelectorAll('[data-pb]').forEach(el => el.onchange = () => {
    P[el.dataset.pb] = el.checked; savePrefs();
    if (el.dataset.pb === 'night') Engine.applyNight();
    if (el.dataset.pb === 'compat') toast('Ricarica la pagina per applicare.');
    if (el.dataset.pb === 'sync' && P.sync) { PrefSync.pull(); HistSync.run(); }
  });
  $('#cf').oninput = e => { P.crossfade = +e.target.value; $('#cfv').textContent = P.crossfade ? P.crossfade + ' secondi' : 'spenta'; savePrefs(); };
  ['tUrl', 'tUser', 'tPass'].forEach(id => $('#' + id).onchange = () => { P.turn = { url: $('#tUrl').value.trim(), user: $('#tUser').value.trim(), pass: $('#tPass').value }; savePrefs(); });
  if (access().admin) { refreshUpdate(); refreshUsers(); }
  $$('[name=theme]').forEach(r => r.onchange = () => { P.theme = r.value; savePrefs(); if (r.value === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = r.value; });
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
async function refreshUsers() {
  const box = $('#usrBox'); if (!box) return;
  let list; try { list = await dlApi('/api/users'); } catch (e) { box.innerHTML = `<p class="sub">${esc(e.message)}</p>`; return; }
  box.innerHTML = list.length ? list.map(u => `<div class="list-item" style="cursor:default;flex-wrap:wrap">
    <span class="grow"><b>${esc(u.user)}</b><small>${u.admin ? 'amministratore' : 'utente'}${u.seen ? ', ultimo accesso ' + new Date(u.seen * 1000).toLocaleDateString() : ''}</small></span>
    <label class="check" style="margin:0"><input type="checkbox" data-usr="${esc(u.user)}" data-perm="upload" ${u.upload || u.admin ? 'checked' : ''} ${u.admin ? 'disabled' : ''}><span>Caricamento</span></label>
    <label class="check" style="margin:0"><input type="checkbox" data-usr="${esc(u.user)}" data-perm="download" ${u.download || u.admin ? 'checked' : ''} ${u.admin ? 'disabled' : ''}><span>Download</span></label>
    ${u.sessions ? `<button class="btn sm" data-act="usrrevoke" data-user="${esc(u.user)}">Disconnetti</button>` : ''}</div>`).join('')
    : '<div class="empty">Nessun utente ha ancora fatto accesso da Armony.</div>';
  box.querySelectorAll('[data-usr]').forEach(el => el.onchange = async () => {
    const name = el.dataset.usr, v = p => box.querySelector(`[data-usr="${CSS.escape(name)}"][data-perm="${p}"]`).checked;
    try { await dlApi('/api/users/' + encodeURIComponent(name), { method: 'PUT', body: JSON.stringify({ upload: v('upload'), download: v('download') }) }); toast('Permessi aggiornati.'); }
    catch (e) { toast(e.message); refreshUsers(); }
  });
}
async function notifyUpdate() {
  if (!access().admin) return;
  const u = await dlApi('/api/update').catch(() => null);
  if (u?.available && store.get('updSeen') !== u.latest) { store.set('updSeen', u.latest); toast(`Armony ${u.latest} disponibile: aggiorna da Impostazioni.`, 6000); }
}
function serverDialog(s, preset = {}) {
  s = s || { id: uid(8), name: preset.name || '', url: preset.url || '', user: '', shareBase: '' };
  const d = $('#dlg'); d.className = '';
  d.innerHTML = `<h3>${s.user ? 'Modifica server' : 'Nuovo server'}</h3><div class="stack">
    <label class="f">Nome<input type="text" id="sName" value="${esc(s.name)}" placeholder="Casa di Marco"></label>
    <label class="f">Indirizzo<input type="url" id="sUrl" value="${esc(s.url)}" placeholder="http://192.168.1.10:8080"></label>
    <label class="f">Utente<input type="text" id="sUser" value="${esc(s.user)}" autocomplete="username"></label>
    <label class="f">Password<input type="password" id="sPass" value="" autocomplete="current-password" ${s.tok ? 'placeholder="Lascia vuoto per non cambiarla"' : ''}></label>
    <details><summary class="small" style="cursor:pointer;color:var(--muted)">Avanzate</summary>
      <label class="f" style="margin-top:8px">Indirizzo pubblico per i link condivisi<input type="url" id="sShare" value="${esc(s.shareBase || '')}" placeholder="https://musica.miodominio.it"></label></details>
    <p id="sMsg" class="small" style="margin:0;color:var(--muted)"></p>
    <div class="row"><button class="btn primary" id="sSave">Salva</button><button class="btn" id="sTest">Prova</button><button class="btn" onclick="this.closest('dialog').close()">Annulla</button></div></div>`;
  const read = () => {
    const pass = $('#sPass').value, user = $('#sUser').value.trim();
    const n = { ...s, name: $('#sName').value.trim() || $('#sUrl').value.trim(), url: $('#sUrl').value.trim().replace(/\/+$/, ''), user, shareBase: $('#sShare').value.trim() };
    if (pass) Object.assign(n, subsonicCreds(pass));
    else if (user !== s.user) delete n.tok;  // utente cambiato senza password: credenziali vecchie non valide
    return n;
  };
  $('#sTest').onclick = async () => { $('#sMsg').textContent = 'Provo…'; try { await api('ping', {}, read()); $('#sMsg').textContent = 'Connessione riuscita.'; } catch (e) { $('#sMsg').textContent = e.message; } };
  $('#sSave').onclick = async () => {
    const n = read(); if (!n.url || !n.user || !n.tok) { $('#sMsg').textContent = 'Indirizzo, utente e password sono obbligatori.'; return; }
    $('#sMsg').textContent = 'Verifico…';
    try { await api('ping', {}, n); } catch (e) { if (!confirm(`${e.message}\nSalvare comunque?`)) { $('#sMsg').textContent = e.message; return; } }
    delete n.session; delete n.armony; delete n.me;
    try { await armonyLogin(n); } catch (e) { $('#sMsg').textContent = 'Armony: ' + e.message; return; }
    const i = S.servers.findIndex(x => x.id === n.id); if (i >= 0) S.servers[i] = n; else S.servers.push(n);
    if (!S.active) S.active = n.id;
    if (n.session && S.active === n.id) store.set('downloader', null);
    persistServers(); d.close(); route();
    toast(n.me ? `Collegato a ${n.name}${n.me.admin ? ' come amministratore' : ''}.` : `Collegato a ${n.name}: solo ascolto, il server non ha Armony.`);
  };
  d.showModal();
}
function persistServers() { store.set('servers', S.servers); store.set('active', S.active); fillSelectors(); }
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
      case 'artist': location.hash = '#/artista/' + encodeURIComponent(id); break;
      case 'openpl': location.hash = '#/playlist/' + encodeURIComponent(id); break;
      case 'play': setQueue(list, i); break;
      case 'play1': setQueue([list[i]], 0); break;
      case 'qplay': playIndex(i); break;
      case 'qplayoff': playIndex(S.index + 1 + i); break;
      case 'playall': setQueue(list, 0, S.shuffle); break;
      case 'shuffleall': setQueue(list, 0, true); break;
      case 'enqueueall': if (Jam.role === 'guest') { list.slice(0, 10).forEach(t => Jam.suggest(t)); break; } S.queue.push(...list); persistQueue(); toast(`${list.length} brani aggiunti alla coda.`); break;
      case 'offlineall': Offline.save(list); break;
      case 'addalltopl': addToPlaylistDialog(list); break;
      case 'enqueue': if (Jam.role === 'guest') { Jam.suggest(list[i]); break; } S.queue.push(list[i]); persistQueue(); toast('Aggiunto alla coda.'); break;
      case 'more': songMenu(list[i], { pl: view.dataset.pl ? i : null }); break;
      case 'star': {
        const t = list[i]; await api(t.starred ? 'unstar' : 'star', { id: t.id }, srv(t.serverId));
        t.starred = !t.starred; el.classList.toggle('on', t.starred); el.innerHTML = ic('heart', t.starred); break;
      }
      case 'staralbum': await api(el.dataset.on === '1' ? 'unstar' : 'star', { albumId: id }); route(); break;
      case 'shareitem': shareItem(id, el.dataset.name); break;
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
      case 'usesrv': S.active = id; persistServers(); vSettings(); break;
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
    S.shuffle = !S.shuffle; store.set('shuffle', S.shuffle);
    if (S.shuffle && S.queue.length > S.index + 2) { S.queue = [...S.queue.slice(0, S.index + 1), ...shuffleArr(S.queue.slice(S.index + 1))]; persistQueue(); emit('queue'); if (location.hash.startsWith('#/coda')) vQueue(); }
    paintButtons();
  };
  $('#bRep').onclick = () => { S.repeat = { off: 'all', all: 'one', one: 'off' }[S.repeat]; store.set('repeat', S.repeat); paintButtons(); };
  $('#vol').value = P.volume * 100;
  $('#vol').oninput = e => { P.volume = e.target.value / 100; savePrefs(); Engine.applyVolume(); };
  $('#seek').oninput = () => { seeking = true; $('#tCur').textContent = fmt($('#seek').value / 1000 * playDur()); };
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
async function boot() {
  $('#nav').innerHTML = NAV.map(([h, l, i]) => `<a href="#/${h}" data-r="${h}">${ic(i)}<span class="lbl">${l}</span></a>`).join('');
  $('#tabs').innerHTML = NAV.filter(([h]) => TABS.includes(h)).map(([h, l, i]) => `<a href="#/${h}" data-r="${h}">${ic(i)}<span>${l}</span></a>`).join('')
    + `<button type="button" id="tabMore" aria-haspopup="dialog">${ic('more')}<span>Altro</span></button>`;
  $('#tabMore').onclick = moreSheet;
  Engine.init(); wirePlayer();
  await Offline.init();
  fillSelectors(); updateNowPlaying(); paintTime();
  const t = S.queue[S.index];
  if (t && (srv(t.serverId) || Offline.has(t))) await Engine.load(t, Engine.cur, { autoplay: false, startAt: store.get('pos', 0) });
  addEventListener('hashchange', route);
  addEventListener('online', () => { toast('Di nuovo online.'); fillSelectors(); });
  addEventListener('offline', () => toast('Sei offline: puoi ascoltare i brani salvati.'));
  navigator.connection?.addEventListener?.('change', fillSelectors);
  if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
  Jam.init();
  route();
  setTimeout(resolvePending, 8000);
  addEventListener('online', () => HistSync.run());
  syncSessions().then(async () => { notifyUpdate(); await PrefSync.pull(); await HistSync.run(); if (/^#\/(impostazioni|scarica|statistiche)/.test(location.hash)) route(); });
}
