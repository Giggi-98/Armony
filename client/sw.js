/* Armony: rende l'app apribile anche senza rete. Musica e API non passano di qui.
   Prima la cache: l'app si apre subito anche in 5G. In sottofondo (al più ogni minuto) si chiede al server se i file
   sono cambiati (ETag: una risposta 304 costa pochi byte); se sì si scaricano tutti e si sostituiscono insieme,
   mai metà vecchi e metà nuovi. La versione nuova vale dalla prossima apertura, e la pagina riceve "aggiornata". */
const V = 'armony-v8';
const SHELL = ['./', 'index.html', 'armony.js', 'jam.js', 'radio.js', 'telefono.js', 'dispositivi.js', 'diagnosi.js', 'utenti.js', 'manifest.json', 'icon.svg', 'vendor/auto-animate.min.js'];
self.addEventListener('install', e => e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())));
const put = (req, res) => { if (res.ok) { const c = res.clone(); caches.open(V).then(x => x.put(req, c)); } return res; };
let checked = 0;
async function refresh() {
  if (Date.now() - checked < 60000) return;
  checked = Date.now();
  const c = await caches.open(V);
  try {
    const got = await Promise.all(SHELL.map(async p => {
      const old = await c.match(p), r = await fetch(p, { cache: 'no-cache' });
      if (!r.ok) throw new Error(p);
      return { p, r, changed: !old || (old.headers.get('ETag') || old.headers.get('Last-Modified')) !== (r.headers.get('ETag') || r.headers.get('Last-Modified')) };
    }));
    if (!got.some(x => x.changed)) return;
    await Promise.all(got.map(x => c.put(x.p, x.r)));
    for (const cl of await self.clients.matchAll()) cl.postMessage({ type: 'aggiornata' });
  } catch {}  // rete assente o un file non arrivato: si tiene la versione intera di prima
}
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.origin === location.origin && !/^\/(rest|api|share)\//.test(u.pathname)) {
    const nav = e.request.mode === 'navigate', key = nav ? 'index.html' : e.request;
    e.respondWith(caches.match(key, { ignoreSearch: nav }).then(hit => {
      if (hit) { e.waitUntil(refresh()); return hit; }
      return fetch(e.request).then(r => put(e.request, r)).catch(() => caches.match('index.html'));
    }));
  } else if (u.host === 'fonts.gstatic.com' || u.host === 'fonts.googleapis.com') {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => put(e.request, res))));
  }
});
