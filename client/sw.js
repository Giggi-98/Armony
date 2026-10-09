/* Armony: rende l'app apribile anche senza rete. Musica e API non passano di qui. */
const V = 'armony-v4';
const SHELL = ['./', 'index.html', 'armony.js', 'jam.js', 'telefono.js', 'manifest.json', 'icon.svg', 'vendor/auto-animate.min.js'];
self.addEventListener('install', e => e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())));
const put = (req, res) => { if (res.ok) { const c = res.clone(); caches.open(V).then(x => x.put(req, c)); } return res; };
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.origin === location.origin && !/^\/(rest|api|share)\//.test(u.pathname)) {
    e.respondWith(fetch(e.request).then(r => put(e.request, r)).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
  } else if (u.host === 'fonts.gstatic.com' || u.host === 'fonts.googleapis.com') {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => put(e.request, res))));
  }
});
