/* Armony - Jam Radio: stazioni che suonano senza fermarsi sul server (server/radio.py).

   La stazione vive sul server: elenco dei brani con le durate e un istante d'inizio. Cosa è in onda e a che
   punto lo dice il server, con il suo orologio; qui lo si porta sull'orologio del dispositivo con SrvClock
   (lo stesso della Jam, jam.js) e si suona allo stesso punto degli altri: piccoli scarti si recuperano
   cambiando appena la velocità, quelli oltre mezzo secondo con un salto. Il brano successivo lo decide il
   server, non il client. Le stazioni dei server collegati arrivano da /api/rete/radio con gli istanti già
   portati sull'orologio del mio server, e l'audio passa dal proxy della rete come gli altri brani.
   Mentre si ascolta niente avanti, indietro o salti: play e pausa sono "rientra" ed "esci" dal punto attuale. */
'use strict';

const Radio = {
  list: new Map(), net: null, netAt: 0, qn: 0, st: null, on: false, items: [], track: null, tickT: null, beatT: null, fetchAt: 0, jumpAt: 0, pos0: 0, rough: 0,
  ok() { const s = dlSrv(); return !!s?.session && !!s.me?.caps?.includes('radio'); },
  // scarto server − dispositivo in ms: l'orologio della Jam se ha già misurato, altrimenti l'ora dell'ultima risposta
  off() { return SrvClock.ready() ? SrvClock.off : this.rough; },
  clock() { if (!SrvClock.t || SrvClock.base !== S.dl.url) return SrvClock.start(S.dl.url); },
  ref(x) { return (x.path?.length ? x.path.join(',') + '/' : '') + x.id; },
  // un brano della stazione come brano della coda; da un altro server passa dal mio (streamUrl, coverUrl)
  toTrack(w, r, node) {
    const t = norm(w, dlSrv()?.id); t.duration = w.duration;
    if (!r) return t;
    return { ...t, id: 'rete:' + r.split(',').at(-1) + ':' + w.id, artistId: undefined, albumId: undefined, coverArt: w.coverArt ? `rete|${r}|${w.id}` : undefined,
      fed: { id: w.id, r, node: node?.name || 'Server', owner: node?.owner || '', via: [], off: false } };
  },
  path(st) { return st?.path?.length ? st.path.join(',') : ''; },
  url(st, tail = '') { const r = this.path(st); return r ? `/api/rete/radio/${encodeURIComponent(st.id)}${tail}?r=${encodeURIComponent(r)}` : `/api/radio/${encodeURIComponent(st.id)}${tail}`; },
  // ------------------------------------------------ elenco: dal canale dal vivo (questo server) e dalla rete
  hello(m) {
    if (!('radio' in m)) return;
    this.list = new Map(arr(m.radio).map(x => [x.id, x])); this.rough = (m.now || 0) * 1000 - now(); this.changed();
    if (this.st && this.on) this.join(true).catch(() => {});  // canale riaperto (anche dopo un riavvio del server): di nuovo fra gli ascoltatori
  },
  recv(m) {
    if (m.gone) { this.list.delete(m.gone); if (this.st && !this.path(this.st) && this.st.id === m.gone) { toast('La radio è stata tolta.'); this.leave(); } }
    else if (m.station) {
      this.list.set(m.station.id, m.station);
      if (this.st && !this.path(this.st) && this.st.id === m.station.id) {
        Object.assign(this.st, m.station); this.pill();
        if (!m.station.on && this.on) { toast('La radio è stata fermata.'); this.leave(); }
      }
    }
    this.changed();
  },
  async load() { try { const j = await dlApi('/api/radio'); this.rough = j.now * 1000 - now(); this.list = new Map(j.stations.map(x => [x.id, x])); } catch {} this.changed(); },
  async loadNet() {
    if (!netOk()) { this.net = []; return; }
    try { const j = await dlApi('/api/rete/radio'); this.net = j.stations; this.netAt = Date.now(); } catch { this.net ||= []; }
    this.changed();
  },
  changed() { clearTimeout(this.ct); this.ct = setTimeout(() => this.paintAll(), 30); },
  // la stazione è passata al brano dopo: l'elenco va richiesto (il successivo lo sa solo il server)
  stale() { const t = now() + this.off(); return [...this.list.values(), ...(this.net || [])].some(x => x.on && x.now && (x.now.start + x.now.duration) * 1000 < t - 500); },
  // ------------------------------------------------ ascolto
  async tune(st) {
    if (Jam.role) return toast('Sei in una Jam: esci prima dalla Jam per ascoltare una radio.');
    if (!st?.on) return toast('Questa radio è ferma.');
    if (this.st && this.ref(this.st) === this.ref(st)) { if (!this.on) this.resume(); return; }
    if (this.st) await this.leave(true);
    else this.pos0 = Engine.time();
    Engine.decks.forEach(d => d.pause());
    this.st = { ...st }; this.on = true; this.items = []; this.track = null;
    Engine.graph();  // dentro il tocco: dopo il browser potrebbe bloccare l'audio
    this.paint();
    try { await this.clock(); await this.join(true); }
    catch (e) { toast(e.message); return this.leave(); }
    clearInterval(this.tickT); this.tickT = setInterval(() => this.tick(), 250);
    clearInterval(this.beatT); this.beatT = setInterval(() => this.on && this.join(true).catch(() => {}), 60000);
    toast(`Sintonizzato su «${st.name}».`);
    this.tick();
  },
  // entra o esce (per il conteggio degli ascoltatori) e riceve cosa è in onda
  async join(on) {
    const j = await dlApi(this.url(this.st, '/ascolta'), { method: 'POST', body: JSON.stringify({ device: S.device, on }) });
    if (on) this.apply(j);
    return j;
  },
  apply(j) {
    if (!this.st || !j?.items) return;
    const r = this.path(this.st), off = this.off();
    Object.assign(this.st, j.station, { path: this.st.path, node: this.st.node });
    this.items = j.items.map(x => ({ t: this.toTrack(x.track, r, this.st.node), at: x.start * 1000 - off, dur: x.duration }));
    if (!r) this.list.set(j.station.id, j.station); else { const n = this.net?.find(x => this.ref(x) === this.ref(this.st)); if (n) Object.assign(n, j.station); }
    this.pill(); this.changed();
  },
  async fetch() {
    if (!this.st || Date.now() - this.fetchAt < 3000) return;
    this.fetchAt = Date.now();
    try { this.apply(await dlApi(this.url(this.st))); } catch (e) { if (/non c'è più|non è in onda/.test(e.message)) { toast('La radio non è più in onda.'); this.leave(); } }
  },
  cur() { const t = now(); return this.items.find(x => t >= x.at && t < x.at + x.dur * 1000) || null; },
  pos() { const c = this.cur(); return c ? Math.max(0, (now() - c.at) / 1000) : 0; },
  dur() { return this.cur()?.dur || 0; },
  next() { const c = this.cur(); return this.items.slice(this.items.indexOf(c) + 1).map(x => x.t); },
  async tick() {
    if (!this.st) return;
    if (Jam.role) return this.leave(true);  // una Jam comanda il lettore
    const c = this.cur(), i = this.items.indexOf(c);
    if (!c || i >= this.items.length - 2) this.fetch();
    if (!c) return;
    if (!this.track || key(this.track) !== key(c.t)) {
      this.track = c.t;
      if (!this.on) { updateNowPlaying(); emit('time'); }
    }
    if (!this.on) return emit('time');  // in pausa la stazione va avanti lo stesso: lo dice la barra
    if (this.busy) return;
    const a = Engine.el, want = (now() - c.at) / 1000;
    if (a.dataset.key !== key(c.t)) {
      if (c.dur - want < 1) return;  // all'ultimo secondo non vale la pena: si aspetta il prossimo
      this.busy = true;
      const idle = Engine.idle, st = this.st;
      try {
        if (idle.dataset.key === key(c.t) && idle.readyState >= 2 && want < 3) { Engine.swap(c.t); try { Engine.el.currentTime = want + .05; } catch {} }
        else { idle.pause(); await Engine.load(c.t, Engine.cur, { autoplay: true, startAt: want + .4 }); }
      } finally { this.busy = false; }
      if (this.st !== st) return;  // uscito mentre il brano si caricava
      this.jumpAt = Date.now(); trackChanged(c.t); this.fetch();
      return;
    }
    if (a.error || a.ended) return;  // non si può ascoltare, o finito prima dell'orario: silenzio fino al prossimo
    if (a.paused) { Engine.graph(); a.play().catch(() => {}); return; }
    if (a.readyState < 3 || a.seeking) return;
    const diff = a.currentTime - want;
    // indietro o avanti di più di mezzo secondo (rete lenta, schermo spento): un salto; per il resto la velocità
    if (Math.abs(diff) > .5 && Date.now() - this.jumpAt > 1500) { a.currentTime = want + .1; a.playbackRate = 1; this.jumpAt = Date.now(); }
    else if (Math.abs(diff) > .03) a.playbackRate = 1 - Math.max(-.05, Math.min(.05, diff * .5));
    else if (a.playbackRate !== 1) a.playbackRate = 1;
    const n = this.items[i + 1];
    if (n && c.at + c.dur * 1000 - now() < 20000 && Engine.idle.dataset.key !== key(n.t)) Engine.load(n.t, 1 - Engine.cur, { autoplay: false });
  },
  // play/pausa: esci dal conteggio e fermati, oppure rientra al punto attuale
  pause() { if (!this.st || !this.on) return; this.on = false; Engine.decks.forEach(d => d.pause()); this.join(false).catch(() => {}); this.paint(); },
  async resume() {
    if (!this.st || this.on) return;
    if (!this.st.on) return toast('Questa radio è ferma.');
    this.on = true; this.paint(); Engine.graph();
    try { await this.join(true); } catch (e) { toast(e.message); this.on = false; this.paint(); return; }
    this.tick();
  },
  // esci: la stazione lascia il lettore; quiet = subito dopo suona altro (coda, Jam, un'altra radio)
  async leave(quiet) {
    if (!this.st) return;
    const st = this.st, was = this.on;
    clearInterval(this.tickT); clearInterval(this.beatT);
    this.st = null; this.on = false; this.items = []; this.track = null;
    Engine.stop(); Engine.decks.forEach(d => d.playbackRate = P.speed);
    if (was) dlApi(this.url(st, '/ascolta'), { method: 'POST', body: JSON.stringify({ device: S.device, on: false }) }).catch(() => {});
    if (!quiet) {
      const t = S.queue[S.index];  // torna la propria coda, ferma dov'era
      if (t && (srv(t.serverId) || Offline.has(t))) Engine.load(t, Engine.cur, { autoplay: false, startAt: this.pos0 });
    }
    this.paint();
  },
  // ------------------------------------------------ disegni: lettore, pagina Radio, riga della Home
  paint() {
    $('#player').toggleAttribute('data-radio', !!this.st);
    this.pill();
    clearTimeout(this.pt); this.pt = setTimeout(() => { updateNowPlaying(); paintTime(); this.paintAll(); }, 0);
  },
  // "Radio · nome" e chi ascolta, nel lettore; si aggiorna da solo quando qualcuno entra o esce
  pill() {
    const p = $('#radioPill'), st = this.st; if (!p) return;
    p.hidden = !st; if (!st) return;
    const who = arr(st.listeners), more = (st.n || 0) - Math.min(3, who.length);
    p.innerHTML = `<i class="rdot${this.on ? ' on' : ''}" aria-hidden="true"></i><span><b>Radio</b> · ${esc(st.name)}</span>${who.length ? `<span class="rav">${who.slice(0, 3).map(x => pavatar(x, 'xs')).join('')}</span>` : ''}${more > 0 ? `<span>+${more}</span>` : ''}`;
    p.setAttribute('aria-label', `Radio ${st.name}: ${st.n || 0} in ascolto`);
  },
  avatars(st, max = 5) {
    const who = arr(st.listeners), more = (st.n || 0) - Math.min(who.length, max);
    return `<span class="rwho" aria-label="${st.n || 0} in ascolto">${who.slice(0, max).map(x => pavatar(x, 's')).join('')}${more > 0 ? `<span class="pav s rmore">+${more}</span>` : ''}</span>`;
  },
  row(st) {
    const k = this.ref(st), tuned = this.st && this.ref(this.st) === k, r = this.path(st), t = st.now ? this.toTrack(st.now.track, r, st.node) : null;
    const mine = !r && (st.owner === dlSrv()?.user || access().admin);
    const where = r ? `${esc(st.node?.name || 'Server')}${st.node?.owner ? ` di ${esc(st.node.owner)}` : ''}` : '';
    return { k, cls: 'rrow' + (st.on ? '' : ' off') + (tuned ? ' tuned' : ''), attrs: { 'data-rk': k }, html:
      `<button class="rgo" data-ract="sheet"><span class="rart">${t ? imgTag(t.coverArt, 120, t.serverId) : ''}${st.on ? `<i class="rlive">${peq(true)}</i>` : ''}</span>
        <span class="grow"><b>${esc(st.name)}</b>
          <small class="rnow">${st.on && t ? `<span>In onda</span> ${esc(t.title)} — ${esc(t.artist)}` : 'Ferma'}</small>
          <small>di ${esc(st.ownerName || st.owner)}${where ? ` · su ${where}` : ''}</small>${st.on ? '<span class="pbar"><i></i></span>' : ''}</span></button>
      ${st.n ? this.avatars(st) : ''}
      ${st.on ? (tuned && this.on ? `<button class="btn sm" data-ract="leave">Esci</button>` : `<button class="btn sm primary" data-ract="tune">${ic('headphones')} Sintonizzati</button>`) : mine ? `<button class="btn sm" data-ract="resume">Riaccendi</button>` : ''}` };
  },
  find(k) { return [...this.list.values(), ...(this.net || [])].find(x => this.ref(x) === k) || (this.st && this.ref(this.st) === k ? this.st : null); },
  progress() {
    const t = now() + this.off();
    $$('[data-rk]').forEach(el => { const st = this.find(el.dataset.rk), b = el.querySelector('.pbar i'); if (st?.now && b) b.style.transform = `scaleX(${Math.max(0, Math.min(1, (t / 1000 - st.now.start) / st.now.duration))})`; });
  },
  paintAll() {
    const here = $('#rHere'), net = $('#rNet'), home = $('#radioRow');
    if (here) {
      const l = [...this.list.values()].filter(x => x.on || x.owner === dlSrv()?.user || access().admin);
      keyed(here, l.length ? l.sort((a, b) => b.on - a.on || (b.n || 0) - (a.n || 0) || b.created - a.created).map(x => this.row(x))
        : [{ k: 'vuoto', cls: 'rempty', html: 'Nessuna radio accesa su questo server. Creane una: suonerà per tutti finché non la fermi.' }]);
    }
    if (net) keyed(net, this.net === null ? [{ k: 'cerco', cls: 'rempty', html: 'Cerco nelle librerie collegate…' }]
      : this.net.length ? this.net.map(x => this.row(x)) : [{ k: 'vuoto', cls: 'rempty', html: 'Nessuna radio in onda sui server collegati.' }]);
    if (home) {
      // Home: una riga sola, la stazione che stai ascoltando o quella con più ascoltatori
      const on = [...this.list.values()].filter(x => x.on), top = this.st || on.sort((a, b) => (b.n || 0) - (a.n || 0))[0];
      home.hidden = !top;
      if (top) {
        const t = top.now ? this.toTrack(top.now.track, this.path(top), top.node) : null, tuned = this.st && this.on, more = on.filter(x => x.id !== top.id).length;
        keyed(home, [{ k: this.ref(top), cls: 'hradio', attrs: { 'data-rk': this.ref(top) }, html:
          `<button class="rgo" data-ract="sheet"><span class="rart">${t ? imgTag(t.coverArt, 96, t.serverId) : ''}<i class="rlive">${peq(true)}</i></span>
            <span class="grow"><small><b class="rtag">Radio</b>${esc(top.name)}${more ? ` · e altre ${more}` : ''}</small><b>${t ? `${esc(t.title)} — ${esc(t.artist)}` : ''}</b><span class="pbar"><i></i></span></span></button>
          ${top.n ? this.avatars(top, 3) : ''}${tuned ? `<a class="btn sm" href="#/radio">Radio</a>` : `<button class="btn sm primary" data-ract="tune">${ic('headphones')} Sintonizzati</button>`}` }]);
      }
    }
    this.progress();
    clearInterval(this.pT); this.pT = null;
    if (here || net || (home && !home.hidden)) this.pT = setInterval(() => {
      if (!$('#rHere') && !$('#rNet') && !$('#radioRow')) { clearInterval(this.pT); return; }
      if (document.visibilityState === 'visible') { this.progress(); if (this.stale()) { this.load(); if (this.net?.length) this.loadNet(); } }
    }, 1000);
  },
  // ------------------------------------------------ fogli: la stazione, e "Crea una radio"
  sheet(st) {
    const d = $('#dlg'); d.className = 'sheet';
    const r = this.path(st), t = st.now ? this.toTrack(st.now.track, r, st.node) : null, tuned = this.st && this.ref(this.st) === this.ref(st);
    const mine = !r && (st.owner === dlSrv()?.user || access().admin), who = arr(st.listeners);
    d.innerHTML = `<div class="head"><span class="pic">${t ? imgTag(t.coverArt, 120, t.serverId) : ''}</span><span class="grow" style="min-width:0"><b style="display:block">${esc(st.name)}</b>
        <small style="color:var(--muted)">di ${esc(st.ownerName || st.owner)}${r ? ` · su ${esc(st.node?.name || 'Server')}` : ''} · ${st.count} ${st.count === 1 ? 'brano' : 'brani'}, ${fmtLong(st.total || 0)}</small></span></div>
      ${t && st.on ? `<div class="pcard" data-rk="${esc(this.ref(st))}"><span class="grow"><small>In onda</small><b>${esc(t.title)}</b><small>${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</small><span class="pbar"><i></i></span></span></div>` : ''}
      <p class="sh">${st.n ? `In ascolto (${st.n})` : 'Nessuno in ascolto'}</p>
      ${who.length ? `<div class="rlisten">${who.map(x => `<span>${pavatar(x, 's')}<b>${esc(x.user === dlSrv()?.user && !x.server ? 'Tu' : x.name)}</b>${x.server ? `<small>${esc(x.server)}</small>` : ''}</span>`).join('')}</div>` : ''}
      ${st.on ? (tuned && this.on ? `<button class="mi" data-x="leave">${ic('close')}Esci dalla radio</button>` : `<button class="mi" data-x="tune">${ic('headphones')}Sintonizzati</button>`) : ''}
      ${mine ? `<button class="mi" data-x="rename">${ic('pen')}Cambia nome</button>
        <button class="mi" data-x="${st.on ? 'stop' : 'resume'}">${ic(st.on ? 'pause' : 'play')}${st.on ? 'Ferma la radio' : 'Riaccendi la radio'}</button>
        <button class="mi danger" data-x="del">${ic('trash')}Togli la radio</button>` : ''}`;
    d.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { d.close(); this.act(b.dataset.x, st); });
    this.progress(); closeOutside(d); d.showModal();
  },
  async act(x, st) {
    try {
      if (x === 'tune') return this.tune(st);
      if (x === 'leave') return this.leave();
      if (x === 'sheet') return this.sheet(st);
      if (x === 'rename') { const n = await ask('Nome della radio', st.name); if (n?.trim()) await dlApi(this.url(st), { method: 'PUT', body: JSON.stringify({ name: n.trim() }) }); }
      else if (x === 'stop' || x === 'resume') { await dlApi(this.url(st), { method: 'PUT', body: JSON.stringify({ on: x === 'resume' }) }); toast(x === 'stop' ? 'Radio fermata: riprenderà da questo punto.' : 'Radio di nuovo in onda.'); }
      else if (x === 'del') { if (!confirm(`Togliere «${st.name}»? Chi la ascolta smette di sentirla.`)) return; await dlApi(this.url(st), { method: 'DELETE' }); toast('Radio tolta.'); }
      if (!Live.es) this.load();  // senza canale dal vivo l'aggiornamento non arriva da solo
    } catch (e) { toast(e.message); }
  },
  SOURCES: [['libreria', 'Tutta la libreria', 'Brani a caso, rimescolati a ogni giro', 'shuffle'], ['playlist', 'Una playlist', 'I suoi brani, uno dopo l\'altro', 'list'],
    ['album', 'Un album', 'Dall\'inizio alla fine, poi in ordine sparso', 'album'], ['genere', 'Un genere', 'Fino a 500 brani del genere', 'radio'],
    ['artista', 'Radio di un artista', 'I suoi brani e quelli simili', 'artist']],
  create(kind) {
    if (!this.ok()) return toast('Questo server non ha ancora la Jam Radio: serve una versione più nuova di Armony.');
    if (srv()?.local) return toast('La radio si crea con la musica del server: scegli il server al posto di "Questo telefono".');
    const d = $('#dlg'); d.className = 'sheet rnew';
    const name = $('#rName')?.value || '';
    if (!kind) {
      d.innerHTML = `<div class="head"><span class="grow"><b style="display:block">Crea una radio</b><small style="color:var(--muted)">Suona per tutti, senza fermarsi, finché non la fermi.</small></span></div>
        <label class="f rname">Nome<input type="text" id="rName" maxlength="60" value="${esc(name)}" placeholder="Si sceglie da solo, se lo lasci vuoto"></label>
        <p class="sh">Cosa suona</p>${this.SOURCES.map(([k, l, s, i]) => `<button class="mi" data-k="${k}">${ic(i)}<span class="grow"><b>${l}</b><small>${s}</small></span>${ic('chevr')}</button>`).join('')}`;
      d.querySelectorAll('[data-k]').forEach(b => b.onclick = e => { e.stopPropagation(); b.dataset.k === 'libreria' ? this.make('libreria', null, 'Tutta la libreria') : this.create(b.dataset.k); });
      if (!d.open) { closeOutside(d); d.showModal(); }
      return;
    }
    const [, label] = this.SOURCES.find(x => x[0] === kind), search = kind === 'album' || kind === 'artista';
    d.innerHTML = `<div class="head"><button class="icon-btn" id="rBack" aria-label="Indietro">${ic('chevl')}</button><span class="grow"><b>${label}</b></span></div>
      <input type="hidden" id="rName" value="${esc(name)}">
      ${search ? `<div class="rfind"><input type="search" id="rQ" placeholder="${kind === 'album' ? 'Cerca un album' : 'Cerca un artista'}" autocomplete="off"></div>` : ''}<div id="rPick"><p class="sh">Carico…</p></div>`;
    $('#rBack').onclick = e => { e.stopPropagation(); this.create(); };  // il foglio cambia misura: il clic non deve sembrare fuori
    const pick = $('#rPick'), show = items => {
      pick.innerHTML = items.length ? items.map((x, i) => `<button class="mi" data-i="${i}">${x.art !== undefined ? `<span class="pic rpic">${x.art}</span>` : ''}<span class="grow"><b>${esc(x.name)}</b>${x.sub ? `<small>${esc(x.sub)}</small>` : ''}</span></button>`).join('') : '<p class="sh">Niente da mostrare.</p>';
      pick.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { const x = items[+b.dataset.i]; this.make(kind, x.id, x.name); });
    };
    if (kind === 'playlist') api('getPlaylists').then(r => show(arr(r.playlists?.playlist).filter(p => p.songCount).map(p => ({ id: p.id, name: p.name, sub: `${p.songCount} brani`, art: imgTag(p.coverArt, 80) })))).catch(e => toast(e.message));
    else if (kind === 'genere') api('getGenres').then(r => show(arr(r.genres?.genre).filter(g => g.songCount).sort((a, b) => b.songCount - a.songCount).map(g => ({ id: g.value, name: g.value, sub: `${g.songCount} brani` })))).catch(e => toast(e.message));
    else {
      const q = $('#rQ'), go = async () => {
        const v = q.value.trim(), n = ++this.qn;
        const r = (await api('search3', { query: v, albumCount: kind === 'album' ? 20 : 0, artistCount: kind === 'artista' ? 20 : 0, songCount: 0 }).catch(() => null))?.searchResult3;
        if (n !== this.qn || !d.open) return;
        show(kind === 'album' ? arr(r?.album).map(a => ({ id: a.id, name: a.name, sub: a.artist, art: imgTag(a.coverArt, 80) })) : arr(r?.artist).map(a => ({ id: a.id, name: a.name, sub: a.albumCount ? `${a.albumCount} album` : '', art: imgTag(a.coverArt, 80) })));
      };
      this.qn = 0; q.oninput = () => { clearTimeout(this.qt); this.qt = setTimeout(go, 250); }; go();
      if (matchMedia('(pointer:fine)').matches) q.focus();
    }
  },
  // l'elenco lo prepara il client, con le stesse radio dell'app; il server lo mette in orario
  async make(kind, id, label) {
    const d = $('#dlg'), name = ($('#rName')?.value || '').trim();
    d.close(); toast('Preparo la radio…');
    try {
      let songs = [];
      if (kind === 'libreria') songs = arr((await api('getRandomSongs', { size: 500 })).randomSongs?.song);
      else if (kind === 'playlist') songs = arr((await api('getPlaylist', { id })).playlist?.entry);
      else if (kind === 'album') songs = arr((await api('getAlbum', { id })).album?.song);
      else if (kind === 'genere') songs = shuffleArr(arr((await api('getSongsByGenre', { genre: id, count: 500 })).songsByGenre?.song));
      else songs = shuffleArr(await artistRadio(id));
      const seen = new Set(), tracks = songs.filter(x => x.duration > 0 && !seen.has(x.id) && seen.add(x.id)).slice(0, 1000)
        .map(x => ({ id: x.id, title: x.title, artist: x.displayArtist || x.artist, album: x.album, albumId: x.albumId, artistId: x.artistId, coverArt: x.coverArt, genre: x.genre, year: x.year, duration: x.duration }));
      if (!tracks.length) return toast('Non ci sono brani da mettere in onda.');
      const j = await dlApi('/api/radio', { method: 'POST', body: JSON.stringify({ name: name || (kind === 'libreria' ? '' : 'Radio ' + label), source: { kind, label }, tracks }) });
      this.list.set(j.station.id, j.station); this.changed();
      if (!location.hash.startsWith('#/radio')) location.hash = '#/radio';
      await this.tune(j.station);
    } catch (e) { toast(e.message); }
  }
};

// azioni sulle righe delle stazioni (pagina Radio e Home)
document.addEventListener('click', e => {
  const el = e.target.closest('[data-ract]'); if (!el) return;
  const st = Radio.find(el.closest('[data-rk]')?.dataset.rk); if (!st) return;
  e.stopPropagation(); Radio.act(el.dataset.ract, st);
}, true);

async function vRadio() {
  if (!srv()) return noServer();
  view.innerHTML = `<div class="rhead"><div><h1>Radio</h1><p class="sub">Stazioni che suonano senza fermarsi sul server. Ti sintonizzi e senti lo stesso punto degli altri, come in diretta.</p></div>
      <button class="btn primary" data-act="rnew">${ic('plus')} Crea una radio</button></div>
    <div class="hsec"><h2>Su questo server</h2></div><div class="rlist" id="rHere"></div>
    ${netOk() ? `<div class="hsec"><h2>Dalla rete</h2><small class="netms">dai server collegati</small></div><div class="rlist" id="rNet"></div>` : ''}`;
  [$('#rHere'), $('#rNet')].forEach(b => b && window.autoAnimate?.(b));
  // senza "me" l'accesso non è ancora finito: la pagina si ridisegna dopo (boot)
  if (!Radio.ok()) { if (dlSrv()?.me) $('#rHere').innerHTML = '<p class="rempty">Questo server non ha ancora la Jam Radio: serve una versione più nuova di Armony.</p>'; return; }
  Radio.clock();
  Radio.paintAll(); Radio.load();
  if (netOk()) { if (Date.now() - Radio.netAt > 30000) Radio.net = null; Radio.loadNet(); viewInterval(() => document.visibilityState === 'visible' && Radio.loadNet(), 30000); }
}
