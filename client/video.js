/* Armony - sezione Video (#/video, #/video/<percorso>) e lettore video integrato (VPlayer).

   - #/video: «Continua a guardare» (i video lasciati a metà su questo dispositivo), le cartelle come filtri, ricerca,
     ordine (recenti, nome, durata) e la griglia con anteprima, durata e avanzamento. Dati da /api/videos (durata misurata
     dal server una volta) e anteprime da /api/videos-mini (copertina del download o un fotogramma).
   - #/video/<percorso>: il video in grande, i suoi dati, «Altri video» (prima quelli della stessa cartella).
   - VPlayer: un solo elemento <video>, fuori dalle pagine. Sulla pagina del video sta dentro la pagina; cambiando sezione
     torna in <body> come finestrella in basso a destra e continua (spostarlo nel DOM non lo ferma). Riprende da dove si era
     rimasti (posizione per dispositivo, localStorage 'vpos'); se parte la musica si ferma, e viceversa. */
'use strict';

const vMini = p => `${S.dl.url.replace(/\/+$/, '')}/api/videos-mini?p=${encodeURIComponent(p)}&${authQ(dlSrv(), S.dl.token)}`;
const vHash = p => '#/video/' + encodeURIComponent(p);

// dove si era arrivati, per video: { percorso: [secondi, durata, quando] }; i finiti e i vecchi se ne vanno
const VPos = {
  all() { return store.get('vpos', {}); },
  get(p) { return this.all()[p] || null; },
  set(p, t, d) {
    const m = this.all();
    if (!d || t < 10 || t > d * .95) delete m[p]; else m[p] = [Math.round(t), Math.round(d), Date.now()];
    const keys = Object.keys(m).sort((a, b) => m[b][2] - m[a][2]); keys.slice(100).forEach(k => delete m[k]);
    store.set('vpos', m);
  }
};

const Videos = {
  list: null, at: 0,
  async load(force) {
    if (force || !this.list || Date.now() - this.at > 30000) { this.list = await dlApi('/api/videos'); this.at = Date.now(); }
    return this.list;
  },
  by(p) { return (this.list || []).find(x => x.path === p); }
};

const VPlayer = {
  el: null, v: null, cur: null, saved: 0,
  init() {
    if (this.el) return;
    const el = this.el = document.createElement('div'); el.id = 'vdock'; el.className = 'vdock'; el.hidden = true;
    el.innerHTML = `<div class="vd-media"><video playsinline controls preload="metadata"></video></div>
      <div class="vd-bar"><button class="vd-t" data-vd="open"><b></b><small>Video</small></button>
        <button class="icon-btn" data-vd="open" aria-label="Apri il video in grande" title="Apri in grande">${ic('chevr')}</button>
        <button class="icon-btn" data-vd="close" aria-label="Chiudi il video" title="Chiudi">${ic('close')}</button></div>`;
    document.body.append(el);
    const v = this.v = el.querySelector('video');
    v.addEventListener('timeupdate', () => { if (Date.now() - this.saved > 5000) this.save(); });
    v.addEventListener('pause', () => this.save());
    v.addEventListener('ended', () => { if (this.cur) VPos.set(this.cur.path, 0, 0); });
    // un solo suono alla volta: il video ferma la musica, la musica ferma il video
    v.addEventListener('play', () => { if (isPlaying() && !Live.remote()) ctlToggle(); });
    Bus.addEventListener('play', () => { if (!v.paused) v.pause(); });
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-vd]'); if (!b) return;
      if (b.dataset.vd === 'close') this.close(); else if (this.cur) location.hash = vHash(this.cur.path);
    });
  },
  save() { this.saved = Date.now(); if (this.cur && this.v.duration) VPos.set(this.cur.path, this.v.currentTime, this.v.duration); },
  play(x) {
    this.init();
    if (this.cur?.path !== x.path) {
      this.save(); this.cur = x;
      this.v.src = videoUrl(x.path);
      const at = VPos.get(x.path); if (at) this.v.currentTime = at[0];
      this.el.querySelector('.vd-t b').textContent = x.name;
    }
    this.el.hidden = false; this.v.play().catch(() => {});
  },
  // sulla pagina del video: il lettore entra nella pagina
  slot(box) { this.init(); box.append(this.el); this.el.classList.remove('mini'); this.el.hidden = !this.cur; },
  // cambio di pagina: il lettore torna fuori, piccolo, prima che la pagina vecchia sparisca
  dock() {
    if (!this.el || this.el.parentElement === document.body) return;
    document.body.append(this.el); this.el.classList.add('mini');
    this.el.hidden = !this.cur || (this.v.paused && !this.v.currentTime);
  },
  close() {
    this.save(); this.cur = null; this.v.pause(); this.v.removeAttribute('src'); this.v.load(); this.el.hidden = true;
  }
};

const vCard = x => {
  const at = VPos.get(x.path), p = at ? Math.min(100, at[0] / at[1] * 100) : 0;
  return `<div class="vcard" data-vp="${esc(x.path)}" role="button" tabindex="0">
    <div class="vthumb"><img loading="lazy" decoding="async" src="${esc(vMini(x.path))}" alt="" onerror="this.remove()">${ic('film')}
      ${x.duration ? `<span class="vdur">${fmt(x.duration)}</span>` : ''}${p ? `<i class="vprog" style="--p:${p.toFixed(1)}%"></i>` : ''}</div>
    <span class="vtxt"><b>${esc(x.name)}</b><small>${esc(x.folder === '.' ? 'Video' : x.folder)} · ${bytes(x.size)} · ${ago(x.mtime * 1000)}</small></span>
    <button class="icon-btn vmore" data-vmore="${esc(x.path)}" aria-label="Altre azioni per ${esc(x.name)}">${ic('more')}</button></div>`;
};
function vMenu(p, at) {
  const x = Videos.by(p); if (!x) return;
  ctxMenuOrPick(at, [
    ['play', 'Guarda', () => location.hash = vHash(p)],
    ['down', 'Scarica sul dispositivo', () => { const a = document.createElement('a'); a.href = videoUrl(p, true); if (NATIVE) a.target = '_blank'; a.click(); }],
    ['trash', 'Elimina dal server', async () => {
      if (!confirm(`Eliminare «${x.name}» dal server?`)) return;
      try { await dlApi('/api/videos/' + p.split('/').map(encodeURIComponent).join('/'), { method: 'DELETE' }); } catch (e) { return toast(e.message); }
      if (VPlayer.cur?.path === p) VPlayer.close();
      VPos.set(p, 0, 0); await Videos.load(true); toast('Video eliminato.');
      location.hash.startsWith(vHash(p)) ? location.hash = '#/video' : route();
    }, 'danger']], x.name);
}
// clic e tasti sulle schede, in qualsiasi elenco della sezione
function vWire(box) {
  box.onclick = e => {
    const m = e.target.closest('[data-vmore]'); if (m) { e.stopPropagation(); const r = m.getBoundingClientRect(); return vMenu(m.dataset.vmore, [r.left, r.bottom + 4]); }
    const c = e.target.closest('[data-vp]'); if (c) location.hash = vHash(c.dataset.vp);
  };
  box.onkeydown = e => { const c = e.target.closest('[data-vp]'); if (c && e.target === c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); location.hash = vHash(c.dataset.vp); } };
  box.oncontextmenu = e => { const c = e.target.closest('[data-vp]'); if (c && matchMedia('(pointer:fine)').matches) { e.preventDefault(); vMenu(c.dataset.vp, [e.clientX, e.clientY]); } };
}

async function vVideo(id) {
  if (!S.dl.url || !can('download')) { view.innerHTML = '<h1>Video</h1><div class="empty"><h3>Video non disponibili</h3><p>Servono un server Armony e il permesso di scaricare.</p></div>'; return; }
  const n = Scene.nav;
  let list; try { list = await Videos.load(); } catch (e) { view.innerHTML = `<h1>Video</h1><div class="empty"><h3>Il server non risponde</h3><p>${esc(e.message)}</p></div>`; return; }
  if (stale(n)) return;
  return id ? vVideoPage(decodeURIComponent(id), list) : vVideoList(list);
}

function vVideoList(list) {
  if (!list.length) {
    view.innerHTML = `<h1>Video</h1><div class="empty"><h3>Ancora nessun video</h3><p>In Scarica scegli «Video» e incolla un link: il video arriva qui, con anteprima e durata, e lo guardi da qualsiasi dispositivo.</p><a class="btn primary" href="#/scarica">${ic('down')} Scarica un video</a></div>`;
    return;
  }
  const o = { by: 'recent', dir: '', q: '', ...JSON.parse(sessionStorage.getItem('armony:vord') || '{}') };
  const folders = [...new Set(list.map(x => x.folder))].sort((a, b) => a.localeCompare(b, 'it'));
  const pos = VPos.all(), cont = list.filter(x => pos[x.path]).sort((a, b) => pos[b.path][2] - pos[a.path][2]);
  const SORT = [['recent', 'Recenti'], ['name', 'Nome'], ['duration', 'Durata']];
  view.innerHTML = `<div class="lhead"><h1>Video</h1></div>
    <div class="ordbar"><label class="ordq">${ic('search')}<input type="search" id="vQ" placeholder="Cerca nei video" aria-label="Cerca nei video" autocomplete="off" value="${esc(o.q)}"></label>
      <button class="ordby" id="vOrd"><span>${esc(SORT.find(s => s[0] === o.by)[1])}</span>${ic('sliders')}</button></div>
    ${folders.length > 1 ? `<div class="lpills vchips" role="navigation" aria-label="Cartelle">${[['', 'Tutti', list.length], ...folders.map(f => [f, f === '.' ? 'Senza cartella' : f, list.filter(x => x.folder === f).length])]
      .map(([f, l, c]) => `<a href="#/video" data-vf="${esc(f)}" class="${f === o.dir ? 'on' : ''}">${esc(l)} <small>${c}</small></a>`).join('')}</div>` : ''}
    <div id="vCont"></div><div id="vAll"></div>`;
  const paint = () => {
    const Q = cleanTxt(o.q), cmp = { recent: (a, b) => b.mtime - a.mtime, name: (a, b) => a.name.localeCompare(b.name, 'it'), duration: (a, b) => b.duration - a.duration }[o.by];
    const l = list.filter(x => (!o.dir || x.folder === o.dir) && (!Q || cleanTxt(`${x.name} ${x.folder}`).includes(Q))).sort(cmp);
    $('#vCont').innerHTML = cont.length && !Q && !o.dir ? `<h2>Continua a guardare</h2><div class="vgrid strip">${cont.slice(0, 12).map(vCard).join('')}</div>` : '';
    const tot = l.reduce((s, x) => s + (x.duration || 0), 0);
    $('#vAll').innerHTML = `<h2>${o.dir ? esc(o.dir === '.' ? 'Senza cartella' : o.dir) : Q ? 'Risultati' : 'Tutti i video'} <small class="vcount">${l.length} ${l.length === 1 ? 'video' : 'video'}${tot ? ' · ' + fmtLong(tot) : ''}</small></h2>
      ${l.length ? `<div class="vgrid">${l.map(vCard).join('')}</div>` : `<p class="sub">Nessun video con «${esc(o.q)}».</p>`}`;
    sessionStorage.setItem('armony:vord', JSON.stringify(o));
  };
  paint(); vWire(view);
  $('#vQ').oninput = e => { o.q = e.target.value; paint(); };
  $('#vOrd').onclick = e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); ctxMenuOrPick([r.left, r.bottom + 4], SORT.map(([v, l]) => [v === o.by ? 'check' : 'more', l, () => { o.by = v; $('#vOrd span').textContent = l; paint(); }]), 'Ordina per'); };
  view.querySelectorAll('[data-vf]').forEach(a => a.onclick = e => { e.preventDefault(); e.stopPropagation(); o.dir = a.dataset.vf; view.querySelectorAll('[data-vf]').forEach(b => b.classList.toggle('on', b === a)); paint(); });
}

function vVideoPage(p, list) {
  const x = list.find(v => v.path === p);
  if (!x) { view.innerHTML = '<h1>Video</h1><div class="empty"><h3>Questo video non c\'è più</h3><p>Forse è stato eliminato dal server.</p><a class="btn" href="#/video">Tutti i video</a></div>'; return; }
  const altri = [...list.filter(v => v.folder === x.folder && v.path !== p), ...list.filter(v => v.folder !== x.folder)].slice(0, 24);
  view.innerHTML = `<div class="vpage"><div class="vstage" id="vSlot"></div>
    <div class="vinfo"><h1>${esc(x.name)}</h1>
      <p class="sub">${esc(x.folder === '.' ? 'Video' : x.folder)}${x.duration ? ' · ' + fmt(x.duration) : ''} · ${bytes(x.size)} · scaricato ${ago(x.mtime * 1000)}</p>
      <div class="row"><a class="btn sm" href="#/video">${ic('chevl')} Tutti i video</a><button class="btn sm" id="vDl">${ic('down')} Scarica sul dispositivo</button><button class="btn sm" id="vMore">${ic('more')} Altro</button></div></div>
    ${altri.length ? `<h2>Altri video</h2><div class="vgrid">${altri.map(vCard).join('')}</div>` : ''}</div>`;
  VPlayer.play(x); VPlayer.slot($('#vSlot'));
  vWire(view);
  $('#vDl').onclick = () => { const a = document.createElement('a'); a.href = videoUrl(p, true); if (NATIVE) a.target = '_blank'; a.click(); };
  $('#vMore').onclick = e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); vMenu(p, [r.left, r.bottom + 4]); };
}
