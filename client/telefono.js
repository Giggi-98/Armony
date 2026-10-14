/* Armony - "Questo telefono": la musica nella memoria del telefono come un server in più (solo nell'app Android).
   Il plugin ArmonyLibrary (app/android, ArmonyLibraryPlugin.java) legge MediaStore e serve audio e copertine
   all'indirizzo dell'app (/_armony_/audio/<id>, /_armony_/cover/<id>). Qui Local.api risponde alle stesse
   chiamate Subsonic di un server vero, così Home, Cerca, Libreria, album, artisti e playlist restano quelle.
   Nella libreria ci sono anche i brani salvati offline dai server (id "o:<server>:<id>", suonano dal blob).
   Preferiti, playlist e ascolti del telefono stanno nell'IndexedDB (magazzino 'telefono'); le statistiche
   restano quelle di sempre (Stats). Backup: con un server Armony e il permesso "upload" carica i brani che
   il server non ha (/api/upload, letti a pezzi dal plugin) e le playlist del telefono. Fuori dall'app è spento. */
const hash2 = s => { let a = 7, b = 11; for (const c of s) { const n = c.codePointAt(0); a = (a * 31 + n) >>> 0; b = (b * 131 + n) >>> 0; } return a.toString(36) + b.toString(36); };
// senza artista dell'album (prima di Android 11) l'album va all'artista principale: "X feat. Y" resta con X
const mainArt = a => String(a || '').replace(/\s+(feat\.?|ft\.|featuring)\s.*$/i, '') || a;
const pool = async (list, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) await fn(list[i++]); })); };
const LOCAL_NO = 'Sul telefono questa funzione non c\'è: serve un server.';
const Local = {
  id: 'telefono', p: null, ready: null, scanning: null, granted: null, bk: null,
  srv: { id: 'telefono', name: 'Questo telefono', url: '', user: '', local: true },
  raw: [], sig: '', songs: [], byId: new Map(), albums: new Map(), artists: new Map(), blobs: new Map(), offN: -1,
  pls: new Map(), stars: {}, plays: {},
  on() { return !!this.p && store.get('phoneLib', false); },
  init() {
    this.p = NATIVE ? window.Capacitor?.Plugins?.ArmonyLibrary || null : null;
    if (!this.p) return;
    this.p.addListener('change', () => this.on() && this.refresh().then(ch => ch && this.auto(true)));
    this.p.addListener('upload', e => { if (this.bk?.mid === e.id) { this.bk.sent = e.sent; this.bk.size = e.total; this.paintLive(); } });
    addEventListener('online', () => this.auto());
    navigator.connection?.addEventListener?.('change', () => this.auto());
    return this.ready = this.load();
  },
  async load() {
    for (const r of await DB.all('telefono').catch(() => [])) {
      if (r.k === 'index') { this.raw = r.raw; this.sig = r.sig; }
      else if (r.k === 'stars') this.stars = r.m; else if (r.k === 'plays') this.plays = r.m;
      else if (r.k.startsWith('pl:')) this.pls.set(r.id, r);
    }
    await this.build();
    if (this.on()) this.refresh();  // l'indice salvato basta per partire, MediaStore si rilegge dietro
  },
  // attivazione (primo avvio o Impostazioni): il permesso si chiede solo qui
  async enable(use) {
    store.set('phoneLib', true);
    try { if (!(await this.p.access()).granted) await this.p.requestAccess(); } catch {}
    if (use || !srv()) S.active = this.id;
    persistServers(); await this.refresh(); await this.ready;
    route(); this.paint();
    if (this.granted && !store.get('phoneDirsVisto', false)) this.cartelle(true);  // la prima volta: quali cartelle
    if (this.granted === false) toast('Senza il permesso Armony vede solo i brani salvati offline. Se Android non lo chiede più: Impostazioni di Android, App, Armony, Autorizzazioni.', 7000);
  },
  // all'avvio dell'app: se il server in uso non risponde lo dice e chiede se passare al telefono (modalità senza server).
  // Una volta per apertura: «Resta» non la ripropone finché l'app non riparte
  async prova(s) {
    // raggiungibile = risponde, anche con un errore (password, dispositivo in attesa): quelli li dice già il resto dell'app
    const ok = navigator.onLine && await Promise.race([(async () => { await NetDns.need(s.url); await netFetch(absUrl(s.url) + '/rest/ping.view'); })().then(() => true, () => false), sleep(6000).then(() => false)]);
    if (ok || S.active !== s.id || $('dialog[open]')) return;
    const d = $('#dlg'); d.className = 'sheet smart';
    d.innerHTML = `<div class="head"><span class="grow"><b style="display:block">📡 Non riesco a raggiungere ${esc(s.name)}</b><small style="color:var(--muted)">${navigator.onLine ? 'Il server non risponde: è spento, o da qui non si raggiunge.' : 'Il telefono è senza rete.'}</small></span></div>
      <div class="smbody"><p class="sub" style="margin:0">Senza server Armony suona la musica che hai sul telefono e quella salvata offline, e puoi scaricare nuova musica sul telefono. ${esc(s.name)} torna quando lo scegli dal pulsante dei server.</p>
      <button class="btn primary" id="lpTel" style="width:100%">📱 Usa la musica del telefono</button><div class="row"><button class="btn" id="lpRiprova">Riprova</button><button class="btn" id="lpResta">Resta su ${esc(s.name)}</button></div></div>`;
    $('#lpTel').onclick = () => { d.close(); this.on() ? (S.active = this.id, persistServers(), route(), this.paint()) : this.enable(true); };
    $('#lpResta').onclick = () => d.close();
    $('#lpRiprova').onclick = async () => { const b = $('#lpRiprova'); b.disabled = true; b.textContent = 'Provo…'; d.close(); this.prova(s).then(() => S.active === s.id && !$('dialog[open]') && toast(`✅ ${s.name} risponde.`)); };
    closeOutside(d); d.showModal();
  },
  // cartelle escluse ('phoneEscluse', prefissi come «WhatsApp/»): si salvano quelle tolte, così una cartella nuova
  // (Music/Armony dei download) entra da sola. Un indice di prima, senza cartelle, le ha tutte
  dirOk(d) { return !d || !(store.get('phoneEscluse', [])).some(e => d.startsWith(e)); },
  // l'albero delle cartelle con la musica: [{ path, nome, n (brani, sottocartelle comprese), figli }]
  albero() {
    const radice = { path: '', figli: new Map(), n: 0 };
    for (const r of this.raw) {
      let nodo = radice; radice.n++;
      for (const pezzo of (r.dir || '').split('/').filter(Boolean)) {
        const path = nodo.path + pezzo + '/';
        nodo = nodo.figli.get(pezzo) || nodo.figli.set(pezzo, { path, nome: pezzo, figli: new Map(), n: 0 }).get(pezzo);
        nodo.n++;
      }
    }
    // una catena di cartelle con un solo figlio e nessun brano proprio si mostra come una riga sola («Android/media/…»)
    const piega = n => { while (n.figli.size === 1 && [...n.figli.values()][0].n === n.n && n.path) { const f = [...n.figli.values()][0]; n = { ...f, nome: n.nome + '/' + f.nome }; } return { ...n, figli: [...n.figli.values()].map(piega).sort((a, b) => b.n - a.n) }; };
    return [...radice.figli.values()].map(piega).sort((a, b) => b.n - a.n);
  },
  // scegliere le cartelle: spunta tolta = esclusa con tutte le sue sottocartelle
  async cartelle(prima) {
    if (!this.raw.length) await this.refresh();
    let escluse = [...store.get('phoneEscluse', [])];
    const fuori = p => escluse.some(e => p.startsWith(e)), sotto = p => escluse.some(e => p.startsWith(e) && e !== p);
    const d = $('#dlg'); d.className = 'sheet smart';
    const riga = (n, liv) => `<div class="dirr" style="--liv:${liv}">
        ${n.figli.length ? `<button type="button" class="icon-btn dirx" data-dx="${esc(n.path)}" aria-expanded="false" aria-label="Apri ${esc(n.nome)}">${ic('chevr')}</button>` : '<span class="dirx"></span>'}
        <label class="dirl"><input type="checkbox" data-dp="${esc(n.path)}"><span class="grow"><b>📁 ${esc(n.nome.split('/').pop())}</b><small>${n.nome.includes('/') ? esc(n.nome.split('/').slice(0, -1).join('/')) + ' · ' : ''}${n.n} ${n.n === 1 ? 'brano' : 'brani'}</small></span></label></div>
      ${n.figli.length ? `<div class="dirf" data-df="${esc(n.path)}" hidden>${n.figli.map(f => riga(f, liv + 1)).join('')}</div>` : ''}`;
    const tree = this.albero();
    d.innerHTML = `<div class="head"><span class="grow"><b style="display:block">📁 Cartelle della musica</b><small style="color:var(--muted)">${prima ? 'Scegli da quali cartelle Armony prende la musica. Puoi cambiarlo quando vuoi da Impostazioni → Questo telefono.' : 'Togli la spunta alle cartelle da non usare: vale anche per le sottocartelle.'}</small></span></div>
      <div class="smbody">${tree.length ? `<div class="dirs">${tree.map(n => riga(n, 0)).join('')}</div>` : `<p class="sub">${this.granted === false ? 'Armony non ha il permesso di leggere la musica del telefono.' : 'Nessuna musica trovata nella memoria del telefono.'}</p>`}
      <p class="small" id="dirTot" style="color:var(--muted);margin:0"></p>
      <div class="row"><button class="btn primary" id="dirOk">${ic('check')} ${prima ? 'Va bene' : 'Salva'}</button>${prima ? '' : '<button class="btn" id="dirNo">Annulla</button>'}</div></div>`;
    const dipingi = () => {
      d.querySelectorAll('[data-dp]').forEach(i => { const p = i.dataset.dp; i.checked = !fuori(p); i.disabled = sotto(p); });
      const tot = this.raw.length, si = this.raw.filter(r => !r.dir || !escluse.some(e => r.dir.startsWith(e))).length;
      $('#dirTot').textContent = `${si} brani di ${tot}${escluse.length ? ` · ${escluse.length} ${escluse.length === 1 ? 'cartella esclusa' : 'cartelle escluse'}` : ' · tutte le cartelle'}`;
    };
    d.querySelectorAll('[data-dp]').forEach(i => i.onchange = () => {
      const p = i.dataset.dp;
      escluse = escluse.filter(e => !e.startsWith(p));  // dentro questa: non serve più ricordarle una per una
      if (!i.checked) escluse.push(p);
      dipingi();
    });
    d.querySelectorAll('[data-dx]').forEach(b => b.onclick = () => { const f = d.querySelector(`[data-df="${CSS.escape(b.dataset.dx)}"]`), on = f.hidden; f.hidden = !on; b.setAttribute('aria-expanded', on); });
    $('#dirNo')?.addEventListener('click', () => d.close());
    $('#dirOk').onclick = async () => {
      store.set('phoneEscluse', escluse); store.set('phoneDirsVisto', true); d.close();
      await this.build(); emit('libreria'); emitSoon('playlists'); this.paint(); route();
      toast(`📱 ${this.songs.length} brani dal telefono.`);
    };
    dipingi(); closeOutside(d); d.showModal();
  },
  disable() { store.set('phoneLib', false); if (S.active === this.id) S.active = S.servers[0]?.id || null; persistServers(); this.paint(); },
  // rilegge MediaStore; true se qualcosa è cambiato
  refresh() {
    if (!this.p) return Promise.resolve(false);
    return this.scanning ||= (async () => {
      try {
        this.granted = !!(await this.p.access()).granted;
        if (!this.granted) return false;
        const all = [];
        for (let off = 0; ;) { const r = await this.p.scan({ offset: off, limit: 500 }); all.push(...r.tracks); off += r.tracks.length; if (!r.tracks.length || off >= r.total) break; }
        const sig = hash2(all.map(x => x.id + '.' + x.modified).join());
        if (sig === this.sig && this.raw.every(x => 'dir' in x)) return false;  // un indice di prima delle cartelle si rilegge
        this.raw = all; this.sig = sig;
        await DB.put('telefono', { k: 'index', raw: all, sig }).catch(() => {});
        await this.build(); emit('libreria'); emitSoon('playlists'); this.paint();
        return true;
      } catch (e) { console.error(e); return false; } finally { this.scanning = null; }
    })();
  },
  // indice in memoria: brani del telefono, poi quelli salvati offline che il telefono non ha già
  async build() {
    const recs = await DB.all('offline').catch(() => []);
    this.offN = Offline.keys.size;
    this.blobs.forEach(u => URL.revokeObjectURL(u)); this.blobs.clear();
    const songs = [], byId = new Map(), albums = new Map(), artists = new Map(), seen = new Map();
    const dk = x => cleanTxt(x.artist) + '|' + cleanTxt(x.title);
    const add = x => {
      const alId = 'al' + hash2(fold(x.aa) + '|' + fold(x.album)), arId = 'ar' + hash2(fold(x.aa));
      const al = albums.get(alId) || albums.set(alId, { id: alId, name: x.album, artist: x.aa, artistId: arId, coverArt: '', songs: [], created: 0 }).get(alId);
      al.songs.push(x); al.coverArt ||= x.coverArt; al.year ||= x.year; al.genre ||= x.genre; al.created = Math.max(al.created, x.created || 0);
      (artists.get(arId) || artists.set(arId, { id: arId, name: x.aa, albums: new Set() }).get(arId)).albums.add(alId);
      Object.assign(x, { albumId: alId, artistId: arId }); songs.push(x); byId.set(x.id, x);
      (seen.get(dk(x)) || seen.set(dk(x), []).get(dk(x))).push(x.duration);
    };
    for (const r of this.raw) {
      if (!this.dirOk(r.dir)) continue;  // cartella esclusa (Local.cartelle)
      const artist = r.artist || 'Artista sconosciuto', name = r.name || '';
      add({ id: 'p' + r.id, mid: String(r.id), title: r.title || name.replace(/\.[^.]+$/, ''), artist, aa: r.albumArtist || mainArt(artist), album: r.album || 'Senza album',
        track: r.track % 1000 || undefined, discNumber: Math.floor(r.track / 1000) || 1, year: r.year || undefined, genre: r.genre || '',
        duration: Math.round((r.duration || 0) / 1000), coverArt: 'p' + r.id, suffix: (name.match(/\.(\w+)$/)?.[1] || '').toLowerCase(), size: r.size, created: (r.modified || 0) * 1000, name });
    }
    for (const rec of recs) {
      const t = rec.track; if (!t) continue;
      if (seen.get(dk(t))?.some(d => Math.abs(d - (t.duration || 0)) <= 3)) continue;  // c'è già sul telefono
      const c = rec.cover ? 'o:' + rec.key : '';
      if (c) this.blobs.set(c, URL.createObjectURL(rec.cover));
      add({ id: 'o:' + rec.key, title: t.title, artist: t.artist, aa: mainArt(t.artist), album: t.album || 'Senza album', track: t.track, year: t.year, genre: t.genre || '',
        duration: t.duration || 0, coverArt: c, suffix: t.suffix, replayGain: t.rg || undefined, created: rec.added, _t: t });
    }
    albums.forEach(a => a.songs.sort((x, y) => (x.discNumber || 1) - (y.discNumber || 1) || (x.track || 0) - (y.track || 0) || x.title.localeCompare(y.title)));
    Object.assign(this, { songs, byId, albums, artists });
  },
  // il brano salvato offline da un server, com'era sul server (per le statistiche)
  orig(t) { const x = t?.serverId === this.id && this.byId.get(t.id); return x?._t || t; },
  cover(c, size) { c = String(c); return c[0] === 'p' ? absUrl(`/_armony_/cover/${c.slice(1)}?s=${size <= 160 ? 160 : 512}`) : this.blobs.get(c) || ''; },
  stream(id) { return /^p\d+$/.test(id) ? absUrl('/_armony_/audio/' + id.slice(1)) : ''; },
  // ---- le risposte Subsonic ----
  iso: ts => ts ? new Date(ts).toISOString() : undefined,
  song(x) {
    const pl = this.plays[x.id];
    return { id: x.id, title: x.title, artist: x.artist, album: x.album, albumId: x.albumId, artistId: x.artistId, track: x.track, discNumber: x.discNumber,
      year: x.year, genre: x.genre, duration: x.duration, coverArt: x.coverArt, suffix: x.suffix, size: x.size, replayGain: x.replayGain,
      starred: this.iso(this.stars[x.id]), playCount: pl?.[0] || 0, created: this.iso(x.created) };
  },
  alPlays(a) { let n = 0, last = 0; a.songs.forEach(x => { const p = this.plays[x.id]; if (p) { n += p[0]; last = Math.max(last, p[1]); } }); return [n, last]; },
  album(a) {
    return { id: a.id, name: a.name, artist: a.artist, artistId: a.artistId, coverArt: a.coverArt, songCount: a.songs.length, duration: a.songs.reduce((n, x) => n + x.duration, 0),
      year: a.year, genre: a.genre, starred: this.iso(this.stars[a.id]), playCount: this.alPlays(a)[0], created: this.iso(a.created) };
  },
  artist(r) { const al = [...r.albums].map(id => this.albums.get(id)); return { id: r.id, name: r.name, albumCount: al.length, coverArt: al[0]?.coverArt, starred: this.iso(this.stars[r.id]) }; },
  pl(p, entries) {
    const so = p.songs.map(id => this.byId.get(id)).filter(Boolean);
    return { id: p.id, name: p.name, comment: p.comment || '', owner: '', public: false, songCount: so.length, duration: so.reduce((n, x) => n + x.duration, 0),
      coverArt: so[0]?.coverArt, created: this.iso(p.created), changed: this.iso(p.changed), ...(entries ? { entry: so.map(x => this.song(x)) } : {}) };
  },
  savePl(p) { p.changed = Date.now(); this.pls.set(p.id, p); return DB.put('telefono', { ...p, k: 'pl:' + p.id }); },
  async api(method, q = {}) {
    await this.ready;
    if (Offline.keys.size !== this.offN) await this.build();  // salvati o tolti brani offline nel frattempo
    const page = (l, n = 10, off = 0) => l.slice(+off || 0, (+off || 0) + (+n || 10));
    const need = (x, what) => { if (!x) throw new Error(`${what} non è più sul telefono.`); return x; };
    const words = s => fold(String(s || '')).split(/\s+/).filter(Boolean);
    const hit = (w, ...f) => { const h = fold(f.join(' ')); return w.every(x => h.includes(x)); };
    const albums = () => [...this.albums.values()], A = a => this.album(a), Sg = x => this.song(x);
    const M = {
      ping: () => ({}),
      getArtists: () => {
        const idx = new Map();
        [...this.artists.values()].sort((a, b) => a.name.localeCompare(b.name, 'it')).forEach(r => { const l = fold(r.name)[0]?.toUpperCase(); const k = /[A-Z]/.test(l) ? l : '#'; (idx.get(k) || idx.set(k, []).get(k)).push(this.artist(r)); });
        return { artists: { index: [...idx].map(([name, artist]) => ({ name, artist })) } };
      },
      getArtist: () => { const r = need(this.artists.get(q.id), 'L\'artista'); return { artist: { ...this.artist(r), album: [...r.albums].map(id => A(this.albums.get(id))).sort((a, b) => (b.year || 0) - (a.year || 0)) } }; },
      getAlbum: () => { const a = need(this.albums.get(q.id), 'L\'album'); return { album: { ...A(a), song: a.songs.map(Sg) } }; },
      getSong: () => ({ song: Sg(need(this.byId.get(q.id), 'Il brano')) }),
      getAlbumList2: () => {
        let l = albums(); const t = q.type;
        if (t === 'newest') l.sort((a, b) => b.created - a.created);
        else if (t === 'recent') l = l.map(a => [a, this.alPlays(a)[1]]).filter(x => x[1]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
        else if (t === 'frequent' || t === 'highest') l = l.map(a => [a, this.alPlays(a)[0]]).filter(x => x[1]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
        else if (t === 'alphabeticalByName') l.sort((a, b) => a.name.localeCompare(b.name, 'it'));
        else if (t === 'alphabeticalByArtist') l.sort((a, b) => a.artist.localeCompare(b.artist, 'it') || a.name.localeCompare(b.name, 'it'));
        else if (t === 'starred') l = l.filter(a => this.stars[a.id]);
        else if (t === 'byYear') { const f = +q.fromYear, to = +q.toYear, lo = Math.min(f, to), hi = Math.max(f, to); l = l.filter(a => a.year >= lo && a.year <= hi).sort((a, b) => f > to ? b.year - a.year : a.year - b.year); }
        else if (t === 'byGenre') l = l.filter(a => a.songs.some(x => x.genre === q.genre));
        else l = shuffleArr(l);
        return { albumList2: { album: page(l, q.size, q.offset).map(A) } };
      },
      getGenres: () => {
        const g = new Map();
        this.songs.forEach(x => { if (!x.genre) return; const v = g.get(x.genre) || g.set(x.genre, { value: x.genre, songCount: 0, al: new Set() }).get(x.genre); v.songCount++; v.al.add(x.albumId); });
        return { genres: { genre: [...g.values()].map(({ al, ...v }) => ({ ...v, albumCount: al.size })) } };
      },
      getSongsByGenre: () => ({ songsByGenre: { song: page(this.songs.filter(x => x.genre === q.genre), q.count, q.offset).map(Sg) } }),
      getRandomSongs: () => ({ randomSongs: { song: shuffleArr(this.songs.filter(x => !q.genre || x.genre === q.genre)).slice(0, +q.size || 10).map(Sg) } }),
      getTopSongs: () => ({ topSongs: { song: this.songs.filter(x => fold(x.artist) === fold(q.artist) && this.plays[x.id]).sort((a, b) => this.plays[b.id][0] - this.plays[a.id][0]).slice(0, +q.count || 50).map(Sg) } }),
      search3: () => {
        const w = words(q.query);
        return { searchResult3: {
          artist: page([...this.artists.values()].filter(r => hit(w, r.name)), q.artistCount ?? 20, q.artistOffset).map(r => this.artist(r)),
          album: page(albums().filter(a => hit(w, a.name, a.artist)), q.albumCount ?? 20, q.albumOffset).map(A),
          song: page(this.songs.filter(x => hit(w, x.title, x.artist, x.album)), q.songCount ?? 20, q.songOffset).map(Sg) } };
      },
      getStarred2: () => ({ starred2: {
        song: this.songs.filter(x => this.stars[x.id]).map(Sg), album: albums().filter(a => this.stars[a.id]).map(A),
        artist: [...this.artists.values()].filter(r => this.stars[r.id]).map(r => this.artist(r)) } }),
      star: () => this.star(q, true), unstar: () => this.star(q, false),
      scrobble: () => {
        if (String(q.submission) !== 'false') arr(q.id).forEach(id => { const p = this.plays[id] || [0, 0]; this.plays[id] = [p[0] + 1, Date.now()]; });
        return DB.put('telefono', { k: 'plays', m: this.plays }).catch(() => {}).then(() => ({}));
      },
      getPlaylists: () => ({ playlists: { playlist: [...this.pls.values()].sort((a, b) => b.changed - a.changed).map(p => this.pl(p)) } }),
      getPlaylist: () => ({ playlist: this.pl(need(this.pls.get(q.id), 'La playlist'), true) }),
      createPlaylist: async () => {
        const p = q.playlistId ? need(this.pls.get(q.playlistId), 'La playlist') : { id: 'pl' + uid(8), name: q.name || 'Playlist', comment: '', created: Date.now() };
        p.songs = arr(q.songId).map(String); await this.savePl(p);
        return { playlist: this.pl(p, true) };
      },
      updatePlaylist: async () => {
        const p = need(this.pls.get(q.playlistId), 'La playlist');
        if (q.name != null) p.name = q.name; if (q.comment != null) p.comment = q.comment;
        const rm = new Set(arr(q.songIndexToRemove).map(Number)); p.songs = p.songs.filter((_, i) => !rm.has(i)).concat(arr(q.songIdToAdd).map(String));
        await this.savePl(p); return {};
      },
      deletePlaylist: async () => { this.pls.delete(q.id); await DB.del('telefono', 'pl:' + q.id); return {}; },
      startScan: () => { this.refresh(); return { scanStatus: { scanning: true, count: this.songs.length } }; },
      getScanStatus: () => ({ scanStatus: { scanning: !!this.scanning, count: this.songs.length } }),
      getPlayQueue: () => ({}), savePlayQueue: () => ({}), getNowPlaying: () => ({ nowPlaying: {} })
    };
    if (!M[method]) throw new Error(LOCAL_NO);
    const r = await M[method]();
    if (/^(create|update|delete)Playlist$/.test(method)) { emitSoon('playlists'); emitSoon('libreria'); }
    return { status: 'ok', ...r };
  },
  star(q, on) {
    [...arr(q.id), ...arr(q.albumId), ...arr(q.artistId)].forEach(id => on ? this.stars[id] = Date.now() : delete this.stars[id]);
    return DB.put('telefono', { k: 'stars', m: this.stars }).catch(() => {}).then(() => ({}));
  },
  // pagina Home senza brani: niente permesso o telefono vuoto
  emptyHome() {
    const no = this.granted === false;
    view.innerHTML = `<h1 class="hhello">Questo telefono</h1><div class="empty"><h3>${no ? 'Armony non può leggere la tua musica' : 'Nessun brano sul telefono'}</h3>
      <p>${no ? 'Consenti l\'accesso a musica e audio: Armony legge i file e basta, non li sposta né li modifica.' : 'Copia dei file audio nella memoria del telefono, per esempio nella cartella Music, oppure salva per l\'offline album e playlist da un server.'}</p>
      <div class="row" style="justify-content:center"><button class="btn primary" data-act="phone" data-do="${no ? 'on' : 'scan'}">${no ? 'Consenti l\'accesso' : 'Cerca di nuovo'}</button><button class="btn" data-act="addsrv">Collegati a un server</button></div></div>`;
  },
  act(what) {
    if (what === 'on') return this.enable(true);
    if (what === 'use') { S.active = this.id; persistServers(); location.hash = '#/home'; return route(); }
    if (what === 'scan') return this.refresh().then(ch => { toast(ch ? 'Musica del telefono aggiornata.' : 'Nessun brano nuovo.'); route(); });
  },

  /* ---- backup sul server: brani mancanti e playlist del telefono ----
     Confronto con matchTrack (titolo, artisti, durata entro pochi secondi). Ciò che è già stato abbinato o caricato
     resta in 'bk:<server>' (IndexedDB): una corsa interrotta riparte da lì, e il server salta comunque i doppioni. */
  targets() { return S.servers.filter(s => s.session && s.me?.upload && s.me.caps?.includes('upload')); },
  target() { const t = this.targets(); return t.find(s => s.id === store.get('phoneBkSrv')) || t[0] || null; },
  wifiOnly: () => store.get('phoneBkWifi', true),
  auto(changed) {
    const last = store.get('phoneBkLast', {});
    if (!this.on() || !store.get('phoneBkAuto', false) || this.bk || (!changed && !last.err && Date.now() - (last.at || 0) < 36e5)) return;
    this.backup(false);
  },
  async backup(manual) {
    const s = this.target(); if (!s || this.bk || !this.on()) return;
    if (this.wifiOnly() && onMobileData()) { if (manual) toast('Il backup aspetta il Wi-Fi. Puoi cambiarlo qui sotto.'); return; }
    const bk = this.bk = { s: s.name, phase: 'cmp', n: 0, tot: 0, up: 0, same: 0, fail: 0, pl: 0 };
    const done = (await DB.get('telefono', 'bk:' + s.id).catch(() => null))?.m || {};
    const save = () => DB.put('telefono', { k: 'bk:' + s.id, m: done }).catch(() => {});
    const look = x => matchTrack({ title: x.title, artist: x.artist, duration: x.duration, album: x.album }, s);
    this.paint();
    try {
      // 1. cosa ha già il server
      const mine = this.songs.filter(x => x.mid && !done[x.id]), miss = [];
      bk.tot = mine.length;
      await pool(mine, 4, async x => { const m = await look(x); if (m) { done[x.id] = m.id; bk.same++; } else miss.push(x); bk.n++; this.paintLive(); });
      await save();
      // 2. un file per volta, dal content:// del telefono
      Object.assign(bk, { phase: 'up', n: 0, tot: miss.length });
      for (const x of miss) {
        if (this.wifiOnly() && onMobileData()) throw new Error('rete mobile: riprende con il Wi-Fi');
        Object.assign(bk, { cur: x.title, mid: x.mid, sent: 0, size: x.size || 0 }); this.paintLive();
        try { const st = await this.send(s, x); done[x.id] = 'up'; await save(); st === 'caricato' ? bk.up++ : bk.same++; }
        catch (e) { bk.fail++; bk.err = e.message; if (/raggiung|connect|timeout|failed/i.test(e.message)) throw e; }
        bk.n++;
      }
      // 3. playlist del telefono, con lo stesso nome (si aggiungono solo i brani che mancano)
      if (this.pls.size) {
        if (bk.up) { bk.phase = 'scan'; this.paintLive(); await api('startScan', {}, s).catch(() => {}); await this.scanWait(s); }
        bk.phase = 'pl'; this.paintLive();
        const theirs = arr((await api('getPlaylists', {}, s)).playlists?.playlist);
        for (const p of this.pls.values()) {
          const ids = [];
          for (const sid of p.songs) {
            const x = this.byId.get(sid); if (!x) continue;
            let id = x._t ? (x._t.serverId === s.id ? x._t.id : null) : done[x.id];
            if (!id || id === 'up') { id = (await look(x).catch(() => null))?.id; if (id && x.mid) done[x.id] = id; }
            if (id && !ids.includes(id)) ids.push(id);
          }
          if (!ids.length) continue;
          const ex = theirs.find(t => t.name === p.name && (!t.owner || t.owner === s.user));
          if (!ex) await createPlaylist(p.name, ids, s.id);
          else { const have = new Set(arr((await api('getPlaylist', { id: ex.id }, s)).playlist?.entry).map(e => e.id)), add = ids.filter(i => !have.has(i)); if (add.length) await addSongsToPlaylist(ex.id, add, s.id); }
          bk.pl++;
        }
        await save();
      }
      store.set('phoneBkLast', { at: Date.now(), s: s.name, up: bk.up, same: bk.same, fail: bk.fail, pl: bk.pl, err: bk.fail ? bk.err : '' });
      if (!manual && bk.up) toast(`Backup: ${bk.up} ${bk.up === 1 ? 'brano salvato' : 'brani salvati'} su ${s.name}.`);
    } catch (e) {
      store.set('phoneBkLast', { at: Date.now(), s: s.name, up: bk.up, same: bk.same, fail: bk.fail, pl: bk.pl, err: e.message, stop: true });
    } finally { this.bk = null; this.paint(); }
  },
  async send(s, x, retry = true) {
    const path = [x.aa, x.album, x.name || x.title].map(v => safeName(v).slice(0, 120)).join('/');
    const r = await this.p.upload({ id: x.mid, token: s.session, url: `${absUrl(s.url)}/api/upload?folder=${encodeURIComponent('Dal telefono')}&path=${encodeURIComponent(path)}` });
    if (r.code === 401 && retry) { delete s.session; await armonyLogin(s).catch(() => {}); persistServers(); if (s.session) return this.send(s, x, false); }
    let j = {}; try { j = JSON.parse(r.body); } catch {}
    if (r.code >= 400) throw new Error(j.error || `errore ${r.code}`);
    return j.status;
  },
  // Navidrome indicizza in differita: le playlist aspettano i brani appena caricati (al massimo due minuti)
  async scanWait(s) {
    for (let i = 0; i < 40; i++) { await sleep(3000); const r = await api('getScanStatus', {}, s).catch(() => null); if (r && !r.scanStatus?.scanning) return; }
  },

  /* ---- Impostazioni → Questo telefono ---- */
  paint() {
    const box = $('#phoneBox'); if (!box) return;
    const on = this.on(), nOff = this.songs.filter(x => x._t).length, ts = this.targets(), t = this.target();
    box.innerHTML = `<label class="check"><input type="checkbox" id="phOn" ${on ? 'checked' : ''}><span>Musica del telefono<small>Armony suona i brani che hai nella memoria del telefono e quelli salvati offline, anche senza server e senza rete. La trovi come «Questo telefono» fra i server.</small></span></label>
      ${on ? `<div class="row between" style="flex-wrap:nowrap"><span class="small" style="color:var(--muted)">${this.granted === false ? 'Armony non ha il permesso di leggere la musica: vedi solo i brani salvati offline.'
        : `${this.songs.length} ${this.songs.length === 1 ? 'brano' : 'brani'} in ${this.albums.size} album${nOff ? `, ${nOff} salvati offline dai server` : ''}.`}</span>
        <button class="btn sm${this.granted === false ? ' primary' : ''}" data-ph="${this.granted === false ? 'perm' : 'scan'}">${this.granted === false ? 'Consenti' : 'Aggiorna'}</button></div>
      ${this.granted === false ? '' : `<div class="row between" style="flex-wrap:nowrap"><span class="small" style="color:var(--muted)">📁 ${store.get('phoneEscluse', []).length ? `${store.get('phoneEscluse', []).length} ${store.get('phoneEscluse', []).length === 1 ? 'cartella esclusa' : 'cartelle escluse'}` : 'Tutte le cartelle'}</span><button class="btn sm" id="phDirs">Scegli le cartelle</button></div>`}
      <h3>Copia sul server</h3>
      ${!t ? `<p class="small" style="color:var(--muted);margin:0">Collega un server Armony dove puoi caricare musica: Armony ci salverà una copia dei brani e delle playlist del telefono, e da lì potrai salvare per l'offline quelli che vuoi.</p>`
        : `${ts.length > 1 ? `<label class="f">Server per il backup<select id="bkSrv">${ts.map(x => `<option value="${esc(x.id)}" ${x === t ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : ''}
        <label class="check"><input type="checkbox" id="bkAuto" ${store.get('phoneBkAuto', false) ? 'checked' : ''}><span>Salva sul server la musica del telefono<small>Carica su ${esc(t.name)} i brani che non ha e le playlist del telefono, da solo quando il server è raggiungibile. I file restano anche sul telefono.</small></span></label>
        <label class="check"><input type="checkbox" id="bkWifi" ${this.wifiOnly() ? 'checked' : ''}><span>Solo con il Wi-Fi</span></label>
        <div id="bkLive"></div>`}` : ''}`;
    box.querySelector('#phOn').onchange = e => e.target.checked ? this.enable(false) : this.disable();
    box.querySelector('[data-ph]')?.addEventListener('click', e => e.currentTarget.dataset.ph === 'perm' ? this.enable(false) : this.act('scan'));
    box.querySelector('#phDirs')?.addEventListener('click', () => this.cartelle(false));
    if (!on || !t) return;  // con la musica del telefono spenta i comandi del backup non ci sono
    box.querySelector('#bkSrv')?.addEventListener('change', e => { store.set('phoneBkSrv', e.target.value); this.paint(); });
    box.querySelector('#bkAuto').onchange = e => { store.set('phoneBkAuto', e.target.checked); if (e.target.checked) this.auto(true); };
    box.querySelector('#bkWifi').onchange = e => store.set('phoneBkWifi', e.target.checked);
    this.paintLive();
  },
  // solo la riga dell'avanzamento: durante il caricamento si ridisegna due volte al secondo
  paintLive() {
    const box = $('#bkLive'); if (!box) return;
    const bk = this.bk, l = store.get('phoneBkLast', null);
    const pct = !bk ? 0 : bk.phase === 'up' ? (bk.n + (bk.size ? Math.min(1, bk.sent / bk.size) : 0)) / Math.max(1, bk.tot) * 100 : bk.phase === 'cmp' ? bk.n / Math.max(1, bk.tot) * 100 : 100;
    const msg = bk ? { cmp: `Confronto con ${esc(bk.s)}: ${bk.n} di ${bk.tot}`, up: `Carico ${bk.n + 1} di ${bk.tot}: ${esc(bk.cur || '')}`, scan: `${esc(bk.s)} sta leggendo i brani nuovi…`, pl: 'Salvo le playlist…' }[bk.phase]
      : l?.at ? `Ultimo backup ${new Date(l.at).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}: ${l.up} ${l.up === 1 ? 'caricato' : 'caricati'}, ${l.same} già sul server${l.fail ? `, ${l.fail} non riusciti` : ''}${l.pl ? `, ${l.pl} playlist` : ''}.${l.err ? ` ${l.stop ? 'Interrotto' : 'Ultimo errore'}: ${esc(l.err)}.` : ''}`
      : 'Nessun backup ancora.';
    box.innerHTML = `<div class="row between" style="flex-wrap:nowrap"><span class="small" style="color:var(--muted)" role="status">${msg}</span><button class="btn sm" id="bkNow" ${bk ? 'disabled' : ''}>Salva ora</button></div>${bk ? `<div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}`;
    box.querySelector('#bkNow').onclick = () => this.backup(true);
  }
};

/* Armony - scaricare sul telefono, senza server (fase 2 di docs/PIANO-TELEFONO.md). Il plugin ArmonyDownload
   (ArmonyDownloadPlugin.java, Scaricatore.java) cerca su YouTube Music, scarica l'audio, lo completa con i dati di
   Deezer e lo mette in Music/Armony: da lì «Questo telefono» lo trova da solo. Qui solo la pagina Scarica quando è
   attivo il telefono; con un server collegato si può scegliere di scaricare lì (store 'dlDove'). */
const PhoneDl = {
  p: null, lavori: [],
  init() {
    this.p = NATIVE ? window.Capacitor?.Plugins?.ArmonyDownload || null : null;
    this.p?.addListener('lavoro', l => { const i = this.lavori.findIndex(x => x.id === l.id); i < 0 ? this.lavori.push(l) : this.lavori[i] = l; this.paint(); });
  },
  // la pagina Scarica è quella del telefono: telefono in uso, e niente server scelto al suo posto
  on: () => !!PhoneDl.p && !!srv()?.local && (!dlSrv() || store.get('dlDove', 'telefono') === 'telefono'),
  async view(sub = '') {
    const [tab, ...rest] = (sub || '').split('/'), q0 = rest.join('/'), t = tab === 'cerca' ? 'cerca' : 'link', s = dlSrv();
    view.innerHTML = `<h1>Scarica</h1><p class="sub">📱 Sul telefono, senza server: da YouTube e YouTube Music, con titolo, album e copertina. I brani vanno nella cartella <b>Music/Armony</b> e restano anche senza Armony.</p>
      ${s && access().download ? `<p class="small" style="margin:0 0 var(--s3)"><a href="#" id="pdServer">🖥️ Scarica invece su ${esc(s.name)}</a></p>` : ''}
      <div class="lpills dltabs" role="navigation" aria-label="Da dove scaricare">${[['link', '', 'link', 'Da un link'], ['cerca', '/cerca', 'search', 'Cerca online']]
        .map(([k, h, i, l]) => `<a href="#/scarica${h}" class="${t === k ? 'on' : ''}"${t === k ? ' aria-current="page"' : ''}>${ic(i)}${l}</a>`).join('')}</div>
      <div class="dlgrid"><div class="dlmain"><section class="panel dlcard">
        ${t === 'link' ? `<label class="dl-in"><span class="dl-in-h">${ic('link')}Incolla uno o più link<small>un brano o una playlist, uno per riga</small></span>
          <textarea id="pdUrl" rows="3" placeholder="https://music.youtube.com/watch?v=…" spellcheck="false" autocapitalize="none"></textarea></label>
          <button class="btn primary dl-go" id="pdGo">${ic('down')} Scarica sul telefono</button>`
        : `<div class="dl-search"><label class="ordq">${ic('search')}<input type="search" id="pdQ" placeholder="Artista e titolo" value="${esc(q0)}" aria-label="Cerca online" enterkeyhint="search"></label><button class="btn primary" id="pdCerca">${ic('search')} Cerca</button></div>`}
      </section>${t === 'cerca' ? '<div id="pdRes"></div>' : ''}</div>
      <div class="dlside"><div class="dl-sh"><h2>Attività</h2><button class="btn sm" id="pdPulisci">Rimuovi conclusi</button></div><div id="jobs"></div></div></div>`;
    $('#pdServer')?.addEventListener('click', e => { e.preventDefault(); store.set('dlDove', 'server'); route(); });
    $('#pdPulisci').onclick = async () => { this.lavori = (await this.p.pulisci()).lavori; this.paint(); };
    const scarica = async (opz, b) => {
      if (b) b.disabled = true;
      try { const r = await this.p.scarica(opz); toast(r.aggiunti > 1 ? `⬇️ ${r.aggiunti} brani in coda sul telefono.` : '⬇️ In coda sul telefono.'); if (b && opz.brano) b.innerHTML = ic('check'); return true; }
      catch (e) { toast(e.message || String(e)); if (b) b.disabled = false; return false; }
    };
    if (t === 'link') $('#pdGo').onclick = async e => {
      const links = $('#pdUrl').value.split(/\s+/).filter(x => /^https?:\/\//.test(x));
      if (!links.length) return toast('Incolla almeno un link di YouTube o YouTube Music.');
      for (const link of links) if (!(await scarica({ link }, e.currentTarget))) return;
      $('#pdUrl').value = ''; e.currentTarget.disabled = false;
    };
    else {
      const go = async () => {
        const q = $('#pdQ').value.trim(); if (!q) return;
        const box = $('#pdRes'); box.innerHTML = '<p class="sub">Cerco su YouTube Music…</p>';
        try {
          const brani = (await this.p.cerca({ q, n: 15 })).brani;
          box.innerHTML = brani.length ? brani.map((b, i) => `<div class="list-item" style="cursor:default">
            <span class="pic">${b.copertina ? `<img src="${esc(b.copertina)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>
            <span class="grow"><b>${esc(b.titolo)}</b><small>${esc(b.artista || '')}${b.durata ? ' · ' + fmt(b.durata) : ''}</small></span>
            <button class="btn sm primary" data-pd="${i}" aria-label="Scarica ${esc(b.titolo)}">${ic('down')}</button></div>`).join('') : '<div class="empty">Nessun risultato.</div>';
          box.querySelectorAll('[data-pd]').forEach(b => b.onclick = () => scarica({ brano: brani[+b.dataset.pd] }, b));
        } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message || String(e))}</div>`; }
      };
      $('#pdCerca').onclick = go; $('#pdQ').onkeydown = e => { if (e.key === 'Enter') go(); };
      if (q0) go();
    }
    try { this.lavori = (await this.p.lavori()).lavori; } catch {}
    this.paint();
  },
  paint() {
    const box = $('#jobs'); if (!box || !$('#pdPulisci')) return;
    const fatto = { fatto: 'ok', "c'era già": 'ok', errore: 'err' };
    box.innerHTML = this.lavori.length ? [...this.lavori].reverse().map(l => `<div class="panel" style="padding:14px">
      <div class="row between" style="flex-wrap:nowrap"><b style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.titolo || l.url)}</b>
      <span class="tag ${fatto[l.stato] || ''}">${esc(l.stato)}</span></div>
      <small style="color:var(--muted)">${esc([l.artista, l.album].filter(Boolean).join(' · ') || 'YouTube')}</small>
      ${l.stato === 'errore' ? `<p style="color:var(--danger);margin:6px 0 0;font-size:.88rem">${esc(l.errore || '')}</p>` : fatto[l.stato] ? '' : `<div class="bar"><i style="width:${l.progresso || 0}%"></i></div>`}</div>`).join('')
      : `<div class="dl-empty">${ic('down')}<b>Nessun download sul telefono</b><small>Quello che scarichi compare qui, con l'avanzamento. Continua anche a schermo spento.</small></div>`;
  }
};
