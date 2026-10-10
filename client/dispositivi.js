/* Armony - dispositivi e sicurezza (server con la capacità "dispositivi": server/dispositivi.py).

   Questo dispositivo si crea una coppia di chiavi ECDSA P-256 per ogni server: la privata non è esportabile e
   resta in IndexedDB ('chiavi'), il server conosce solo la pubblica. La sessione si ottiene firmando una sfida e
   dura 24 ore; la si rinnova da soli, senza password. Audio e copertine portano nella query un gettone (s.tk,
   parametro k) che il server ricontrolla a ogni richiesta: revocato il dispositivo, smette subito di valere.
   Un dispositivo nuovo entra con utente e password ma resta in attesa finché un dispositivo fidato o
   l'amministratore lo approva; con un codice di abbinamento creato da un dispositivo fidato entra subito.
   Senza HTTPS (crypto.subtle assente) niente chiave: il dispositivo resta "senza chiave" e il server decide se
   accettarlo (da casa e Tailscale, sempre o mai). */
'use strict';

I.key = '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2"/>';
I.shield = '<path d="M12 3 4 6v6c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V6Z"/><path d="m9 12 2 2 4-4"/>';

const Disp = {
  busy: new Map(), seen: 0,
  ok(s) { return !!s?.me?.caps?.includes('dispositivi'); },
  can: () => !!window.crypto?.subtle,
  kind: () => NATIVE ? 'app' : /Android|iPhone|iPad|Mobile/.test(navigator.userAgent) ? 'telefono' : 'computer',
  // il nome con cui il dispositivo compare nell'elenco: si cambia da lì
  name() {
    if (P.deviceName) return P.deviceName;
    if (NATIVE) return 'App Android';
    const u = navigator.userAgent, b = /Edg\//.test(u) ? 'Edge' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : 'Browser';
    const o = /Android/.test(u) ? 'Android' : /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Windows/.test(u) ? 'Windows' : /Mac OS/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : '';
    return o ? `${b} su ${o}` : b;
  },
  // ------------------------------------------------ chiavi
  b64: buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  async gen() {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    return { priv: kp.privateKey, pub: this.b64(await crypto.subtle.exportKey('raw', kp.publicKey)) };
  },
  async key(s, create) {
    const k = await DB.get('chiavi', s.id).catch(() => null);
    if (k || !create) return k || null;
    const n = { k: s.id, ...await this.gen() }; await DB.put('chiavi', n); return n;
  },
  forget(s) { return DB.del('chiavi', s.id).catch(() => {}); },
  // chiave e primo accesso uno alla volta fra le schede dello stesso browser: due schede che partono insieme
  // si creavano due chiavi diverse, e la seconda diventava un dispositivo nuovo in attesa
  lock(s, fn) { return navigator.locks?.request ? navigator.locks.request('armony-chiave:' + s.id, fn) : fn(); },
  async sign(priv, msg) { return this.b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, new TextEncoder().encode(msg))); },
  async fp(pub) {
    const raw = Uint8Array.from(atob(pub.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 8).toUpperCase();
    return h.slice(0, 4) + '-' + h.slice(4);
  },
  async nonce(base) {
    const r = await fetch(base + '/api/chiave/sfida', { method: 'POST' });
    if (!r.ok) throw new Error(`Errore ${r.status}`);
    return (await r.json()).nonce;
  },
  async post(url, body, tok) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { 'X-Token': tok } : {}) }, body: JSON.stringify(body) });
    return [r, await r.json().catch(() => ({}))];
  },
  // ------------------------------------------------ accesso
  // risposta del server: sessione, in attesa, revocato o errore
  take(s, r, j) {
    if (r.ok && j.session) {
      s.armony = true; s.session = j.session; s.dev = j.dev; s.tk = j.ticket; delete s.pending; delete s.revoked;
      delete j.session; delete j.t; delete j.s; s.me = j; return j;
    }
    if (j.code === 'attesa') { s.armony = true; s.dev = j.dev; s.pending = j.fp || '—'; delete s.session; delete s.tk; }
    if (j.code === 'revocato') this.revoke(s, false);
    const e = new Error(j.error || `Errore ${r.status}`); e.code = j.code; throw e;
  },
  // con la chiave: sessione nuova firmando la sfida. null = la chiave qui non vale più, si passa alla password
  async signIn(s, k) {
    const base = absUrl(s.url), n = await this.nonce(base);
    let [r, j] = await this.post(base + '/api/chiave/accedi', { dev: s.dev, nonce: n, sig: await this.sign(k.priv, `armony1|accedi|${n}|${s.dev}`) });
    if (j.code === 'rekey') {
      // l'amministratore o un altro mio dispositivo ha chiesto una chiave nuova: la vecchia firma, la nuova subentra
      const nk = await this.gen(), n2 = await this.nonce(base);
      [r, j] = await this.post(base + '/api/chiave/accedi', { dev: s.dev, nonce: n2, sig: await this.sign(k.priv, `armony1|accedi|${n2}|${s.dev}`), newPub: nk.pub, newSig: await this.sign(nk.priv, `armony1|chiave|${n2}|${s.dev}`) });
      if (r.ok) await DB.put('chiavi', { k: s.id, ...nk });
    }
    if (j.code === 'sconosciuto' || j.code === 'firma') { delete s.dev; await this.forget(s); return null; }
    return this.take(s, r, j);
  },
  login(s) { return this.lock(s, () => this.login1(s)); },
  async login1(s) {
    const base = absUrl(s.url);
    if (s.dev && this.can()) { const k = await this.key(s, false); if (k) { const j = await this.signIn(s, k); if (j) return j; } }
    if (!s.tok) throw new Error('Serve la password: modifica il server e reinseriscila.');
    const body = { u: s.user, t: s.tok, s: s.salt, device: S.device, name: this.name(), kind: this.kind() };
    if (s.grant) { body.grant = s.grant; delete s.grant; }
    if (this.can()) {
      const k = await this.key(s, true), n = await this.nonce(base);
      Object.assign(body, { pub: k.pub, nonce: n, sig: await this.sign(k.priv, `armony1|login|${n}|${s.user}`) });
    }
    let [r, j] = await this.post(base + '/api/login', body);
    if (j.code === 'chiave_altrui') { await this.forget(s); delete s.dev; return this.login1(s); }
    if (j.code === 'revocato' && body.pub) { await this.forget(s); delete s.dev; [r, j] = await this.post(base + '/api/login', { ...body, ...await this.relogBody(s, base) }); }
    return this.take(s, r, j);
  },
  // chiave revocata ma password giusta: si chiede di nuovo l'accesso con una chiave nuova (resta in attesa)
  async relogBody(s, base) {
    const k = await this.key(s, true), n = await this.nonce(base);
    return { pub: k.pub, nonce: n, sig: await this.sign(k.priv, `armony1|login|${n}|${s.user}`) };
  },
  // prima chiave di un dispositivo che entrava senza (client aggiornato) o chiave nuova scelta da qui
  setKey(s, fresh) { return this.lock(s, () => this.setKey1(s, fresh)); },
  async setKey1(s, fresh) {
    if (!this.can() || !s.session || !s.dev) return;
    // un'altra scheda l'ha appena registrata: si usa quella (salvo una chiave nuova chiesta apposta)
    if (!fresh && await this.key(s, false)) return;
    const base = absUrl(s.url), nk = await this.gen(), n = await this.nonce(base);
    const [r, j] = await this.post(base + '/api/dispositivi/chiave', { pub: nk.pub, nonce: n, sig: await this.sign(nk.priv, `armony1|chiave|${n}|${s.dev}`), name: this.name(), kind: this.kind() }, s.session);
    if (r.ok) await DB.put('chiavi', { k: s.id, ...nk });
    return this.take(s, r, j);
  },
  // un dispositivo nuovo entra con il codice creato da uno fidato: niente password, arrivano le credenziali Subsonic
  async pair(url, code) {
    if (!this.can()) throw new Error('Per abbinare serve l\'app o Armony aperta con HTTPS.');
    const base = absUrl(url), c = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
    const info = await fetch(base + '/api/info').then(r => r.ok ? r.json() : null).catch(() => null);
    if (!info?.caps?.includes('dispositivi')) throw new Error(info ? 'Questo server non conosce gli abbinamenti: accedi con utente e password.' : 'Non riesco a raggiungere il server.');
    const s = { id: uid(8), name: info.name || url, url: url.replace(/\/+$/, ''), user: '', shareBase: '' }, k = await this.gen(), n = await this.nonce(base);
    const [r, j] = await this.post(base + '/api/chiave/abbina', { code: c, pub: k.pub, nonce: n, sig: await this.sign(k.priv, `armony1|abbina|${n}|${c}`), name: this.name(), kind: this.kind(), device: S.device });
    if (r.ok) { Object.assign(s, { user: j.user, tok: j.t, salt: j.s }); await DB.put('chiavi', { k: s.id, ...k }); }
    this.take(s, r, j);
    return s;
  },
  // ------------------------------------------------ gettone e rinnovo
  win: () => Math.floor(Date.now() / 1000 / 43200),
  stale(s) { const w = +String(s?.tk || '').split('.')[1]; return !w || Date.now() / 1000 > (w + 2) * 43200 - 900; },
  // sessione e gettone freschi; un solo rinnovo alla volta per server
  fresh(s, force) {
    if (!s || s.local || !s.armony || s.revoked) return Promise.resolve();
    if (!force && s.session && +String(s.tk || '').split('.')[1] === this.win()) return Promise.resolve();
    if (this.busy.has(s.id)) return this.busy.get(s.id);
    const p = (async () => {
      if (s.session) {
        const r = await fetch(absUrl(s.url) + '/api/me', { headers: { 'X-Token': s.session } }).catch(() => null);
        if (r?.ok) { s.me = await r.json(); s.tk = s.me.ticket; s.dev = s.me.dev || s.dev; persistServers(); return; }
        if (r?.status !== 401) return;
        delete s.session;
      }
      await armonyLogin(s).catch(() => {}); persistServers();
    })().finally(() => this.busy.delete(s.id));
    this.busy.set(s.id, p); return p;
  },
  // ------------------------------------------------ revoca e attesa
  revoke(s, live) {
    const was = !!s.session;
    s.revoked = true; delete s.session; delete s.tk; delete s.dev; delete s.pending; delete s.tok; delete s.salt;
    this.forget(s); persistServers();
    if (s.id !== S.active) return;
    if (live || was) { Engine.el.pause(); Live.stop(); toast('Questo dispositivo è stato revocato.', 6000); }
    route();
  },
  gate(r) {
    const s = srv();
    if (!s || s.local || r === 'impostazioni' || r === 'abbina' || (!s.pending && !s.revoked)) return null;
    return () => this.gateView(s);
  },
  gateView(s) {
    view.innerHTML = s.revoked ? `<div class="gate"><span class="gate-ic">${ic('lock')}</span><h1>Questo dispositivo è stato revocato</h1>
      <p class="sub">L'accesso a ${esc(s.name)} è stato tolto da un tuo dispositivo o dall'amministratore. Per rientrare accedi di nuovo con la password: il dispositivo dovrà essere approvato.</p>
      <div class="row"><button class="btn primary" data-dg="relog">Accedi di nuovo</button><a class="btn" href="#/impostazioni">Impostazioni</a></div></div>`
      : `<div class="gate"><span class="gate-ic">${ic('shield')}</span><h1>In attesa di approvazione</h1>
      <p class="sub">Questo dispositivo è nuovo per ${esc(s.name)}. Chiedi l'approvazione da un tuo dispositivo fidato (Impostazioni → Dispositivi e sicurezza) o all'amministratore.</p>
      ${s.pending === '—' ? '<p class="small gate-wait">Senza HTTPS questo dispositivo non ha una chiave: chi approva lo riconosce dal nome e dall\'indirizzo.</p>'
        : `<p class="gate-fp"><small>Codice del dispositivo</small><b>${esc(s.pending)}</b><small>Deve essere lo stesso sullo schermo di chi approva.</small></p>`}
      <p class="small gate-wait" role="status">Entri da solo appena approvato.</p>
      <div class="row"><button class="btn" data-dg="code">Ho un codice di abbinamento</button><a class="btn" href="#/impostazioni">Impostazioni</a></div></div>`;
    view.querySelector('[data-dg=relog]')?.addEventListener('click', () => serverDialog(s));
    view.querySelector('[data-dg=code]')?.addEventListener('click', () => serverDialog(null, { url: s.url, mode: 'codice' }));
    if (s.pending) viewInterval(() => this.poll(s), 5000);
  },
  async poll(s) {
    if (this.polling || !s.pending) return; this.polling = true;
    try { await armonyLogin(s); } catch {} finally { this.polling = false; }
    persistServers();
    if (s.session) { toast(`Approvato: benvenuto su ${s.name}.`); Live.connect(); route(); PrefSync.pull(); }
    else if (s.revoked) route();
  },
  // ------------------------------------------------ avvisi: dispositivi in attesa
  async changed() {
    const s = srv(); if (!s?.session) return;
    await this.fresh(s, true);
    this.dot();
    if ($('#devBox')) this.paint();
  },
  dot() {
    const n = srv()?.me?.pending || 0;
    $$(`#nav a[data-r="impostazioni"], ${inMore('impostazioni') ? '#tabMore' : '#tabs a[data-r="impostazioni"]'}`).forEach(a => {
      const d = a.querySelector(':scope>.dot.ddot'); if (n && !d) a.insertAdjacentHTML('beforeend', '<i class="dot pdot ddot" aria-hidden="true"></i>'); else if (!n && d) d.remove();
    });
    if (n > this.seen) toast(n === 1 ? 'Un dispositivo aspetta l\'approvazione: Impostazioni → Dispositivi e sicurezza.' : `${n} dispositivi aspettano l'approvazione: Impostazioni → Dispositivi e sicurezza.`, 6000);
    this.seen = n;
  },
  // ------------------------------------------------ Impostazioni → Dispositivi e sicurezza
  api(path, opts = {}) { return dlApi(path, opts); },
  ago(t) {
    if (!t) return 'mai';
    const d = Date.now() / 1000 - t;
    return d < 90 ? 'adesso' : d < 3600 ? `${Math.round(d / 60)} min fa` : d < 86400 ? `${Math.round(d / 3600)} ore fa` : new Date(t * 1000).toLocaleDateString();
  },
  icon: k => ic(k === 'computer' ? 'laptop' : k ? 'phone' : 'shield'),
  row(d, mine) {
    const tags = [d.me ? '<span class="tag acc">questo</span>' : '', !d.keyed && d.state !== 'revocato' ? '<span class="tag">senza chiave</span>' : '', d.rekey ? '<span class="tag">chiave nuova richiesta</span>' : ''].join('');
    const where = d.ip ? ` · ${d.net === 'internet' ? 'da internet' : 'da casa'} ${esc(d.ip)}` : '';
    const sub = d.state === 'attesa' ? `chiesto ${this.ago(d.created)}${where}${d.fp ? ` · codice <b class="fp">${esc(d.fp)}</b>` : ''}`
      : d.state === 'revocato' ? `revocato ${this.ago(d.revoked)}` : `ultimo accesso ${this.ago(d.seen)}${where}<br>dal ${new Date((d.approved || d.created) * 1000).toLocaleDateString()}${d.by ? ', ' + esc(d.by) : ''}`;
    const acts = d.state === 'attesa' ? `<button class="btn sm primary" data-dv="approva" data-id="${esc(d.id)}">Approva</button><button class="btn sm" data-dv="revoca" data-id="${esc(d.id)}">Rifiuta</button>`
      : d.state === 'fidato' ? `<button class="icon-btn" data-dv="menu" data-id="${esc(d.id)}" aria-label="Azioni per ${esc(d.name)}">${ic('more')}</button>` : '';
    return `<div class="list-item dv${d.state === 'attesa' ? ' wait' : ''}"><span class="dv-ic">${this.icon(d.kind)}</span>
      <span class="grow"><b>${mine ? '' : esc(d.user) + ' · '}${esc(d.name)}</b><small>${sub}</small>${tags ? `<span class="dv-tags">${tags}</span>` : ''}</span>${acts}</div>`;
  },
  async paint() {
    const box = $('#devBox'); if (!box) return;
    const s = srv(), admin = !!s?.me?.admin;
    let x, log = null;
    try { x = await this.api('/api/dispositivi' + (admin ? '?tutti=1' : '')); if (admin) log = await this.api('/api/sicurezza'); }
    catch (e) { box.innerHTML = `<p class="sub">${esc(e.message)}</p>`; return; }
    this.list = x.devices;
    const me = x.devices.find(d => d.me), user = s.user;
    const mine = x.devices.filter(d => d.user === user && !d.me), others = x.devices.filter(d => d.user !== user);
    const wait = [...mine, ...others].filter(d => d.state === 'attesa');
    const ok = mine.filter(d => d.state === 'fidato'), gone = x.devices.filter(d => d.state === 'revocato');
    const lg = x.legacy || log?.legacy, modes = [['sempre', 'Sempre'], ['locale', 'Da casa e Tailscale'], ['mai', 'Mai']];
    const hint = { sempre: 'Entrano anche da internet, come prima dell\'aggiornamento. Un client vecchio con la password giusta resta un buco aperto.', locale: 'Da internet (Funnel, indirizzi pubblici) entrano solo i dispositivi con chiave; da casa e da Tailscale anche gli altri.', mai: 'Solo dispositivi con chiave: chi apre Armony senza HTTPS (es. http://192.168…) non entra più.' };
    const usersOf = [...new Set(others.filter(d => d.state === 'fidato').map(d => d.user))];
    box.innerHTML = `${me ? `<div class="dv-me"><span class="dv-ic">${this.icon(me.kind)}</span><span class="grow"><b>${esc(me.name)}</b>
        <small>Questo dispositivo · ${me.keyed ? `con chiave <b class="fp">${esc(me.fp)}</b>` : 'senza chiave'}</small></span></div>
      ${me.keyed ? '' : `<p class="small dv-note">${this.can() ? 'La chiave si crea da sola al prossimo avvio.' : 'Senza HTTPS il browser non crea chiavi: apri Armony con l\'indirizzo https o dall\'app. Da internet questo dispositivo potrebbe non entrare.'}</p>`}
      <div class="row"><button class="btn primary" data-dv="pair">${ic('plus')} Abbina un dispositivo</button><button class="btn" data-dv="rename" data-id="${esc(me.id)}">Rinomina</button>${me.keyed || this.can() ? `<button class="btn" data-dv="selfkey">${ic('key')} ${me.keyed ? 'Rigenera la chiave' : 'Crea la chiave'}</button>` : ''}</div>` : ''}
      ${wait.length ? `<h3 class="dv-h">In attesa</h3>${wait.map(d => this.row(d, d.user === user)).join('')}` : ''}
      <h3 class="dv-h">I tuoi dispositivi fidati</h3>${ok.length ? ok.map(d => this.row(d, true)).join('') : '<p class="small dv-note">Solo questo. Con "Abbina un dispositivo" ne aggiungi un altro senza password.</p>'}
      ${usersOf.length ? `<h3 class="dv-h">Gli altri utenti</h3>${usersOf.map(u => others.filter(d => d.user === u && d.state === 'fidato').map(d => this.row(d, false)).join('')).join('')}` : ''}
      ${gone.length ? `<details class="dv-more"><summary>Revocati (${gone.length})</summary>${gone.map(d => this.row(d, d.user === user)).join('')}</details>` : ''}
      ${lg ? `<h3 class="dv-h">Client senza chiave</h3><p class="small dv-note">App vecchie e pagine aperte senza HTTPS non hanno una chiave: possono entrare solo con utente e password.</p>
        <div class="seg" role="radiogroup" aria-label="Client senza chiave">${modes.map(([v, l]) => `<label><input type="radio" name="dvlegacy" value="${v}" ${lg.mode === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
        <p class="small dv-note">${hint[lg.mode]}${!lg.chosen && lg.grace && lg.grace * 1000 > Date.now() ? ` Periodo di transizione dopo l'aggiornamento: fino al ${new Date(lg.grace * 1000).toLocaleDateString()}, poi «Da casa e Tailscale».` : ''}</p>` : ''}
      ${log ? `<details class="dv-more"><summary>Registro degli accessi</summary>${log.events.length ? `<ul class="dv-log">${log.events.map(e => `<li><b>${esc(this.ev[e.kind] || e.kind)}</b> <span>${esc([e.user, e.dev].filter(Boolean).join(' · '))}${e.detail && !(e.dev && e.detail.startsWith(e.dev)) ? ' · ' + esc(e.detail) : ''}</span><small>${new Date(e.ts * 1000).toLocaleString()} · ${e.net === 'internet' ? 'internet' : 'casa'} ${esc(e.ip || '')}</small></li>`).join('')}</ul>` : '<p class="small dv-note">Ancora niente.</p>'}</details>` : ''}`;
    box.querySelectorAll('[name=dvlegacy]').forEach(r => r.onchange = async () => {
      if (r.value === 'mai' && !confirm('Solo dispositivi con chiave: chi usa Armony senza HTTPS o con un\'app vecchia resterà fuori. Continuare?')) return this.paint();
      try { await this.api('/api/sicurezza', { method: 'PUT', body: JSON.stringify({ legacy: r.value }) }); toast('Salvato.'); } catch (e) { toast(e.message); }
      this.paint();
    });
    box.querySelectorAll('[data-dv]').forEach(b => b.onclick = () => this.act(b.dataset.dv, b.dataset.id));
  },
  ev: { accesso: 'Accesso', accesso_fallito: 'Password sbagliata', attesa: 'Dispositivo in attesa', nuovo: 'Dispositivo nuovo, fidato', approvato: 'Approvato', revocato: 'Revocato', abbinato: 'Abbinato con codice', abbinamento_fallito: 'Codice di abbinamento sbagliato', codice: 'Codice di abbinamento creato', rigenera: 'Chiave nuova richiesta', rigenerato: 'Chiave rigenerata', chiave: 'Prima chiave', bloccato: 'Troppi tentativi: attesa', emergenza: 'Codice di emergenza', senza_chiave: 'Rifiutato: senza chiave', impostazione: 'Impostazione' },
  async act(a, id) {
    const s = srv(), d = (this.list || []).find(x => x.id === id), base = `/api/dispositivi/${encodeURIComponent(id || '')}`;
    try {
      if (a === 'pair') return this.pairSheet();
      if (a === 'menu') return this.menu(d);
      if (a === 'selfkey') { await this.setKey(s, true); persistServers(); toast('Chiave nuova pronta: la vecchia non vale più.'); return this.paint(); }
      if (a === 'rename') {
        const name = await ask('Nome del dispositivo', d?.name || '', 'Es. Telefono di Giulia'); if (!name) return;
        await this.api(base, { method: 'PUT', body: JSON.stringify({ name }) });
        if (d?.me) { P.deviceName = name; savePrefs(); }
      } else if (a === 'revoca') {
        const self = d?.me, last = s.me?.admin && d?.user === s.user && (this.list || []).filter(x => x.user === s.user && x.state === 'fidato').length <= 1;
        if (!confirm(d?.state === 'attesa' ? `Rifiutare «${d.name}»?` : self ? 'Revocare questo dispositivo? Esci subito e per rientrare servirà un\'approvazione.'
          : `Revocare «${d?.name}»? Smette subito di ascoltare e di usare Armony.${last ? '\nÈ il tuo ultimo dispositivo fidato: per rientrare servirà la rete di casa.' : ''}`)) return;
        await this.api(base + '/revoca', { method: 'POST' });
        if (self) return this.revoke(s, true);
      } else if (a === 'approva') await this.api(base + '/approva', { method: 'POST' });
      else if (a === 'rigenera') {
        if (!confirm(`Chiedere a «${d?.name}» una chiave nuova? La vecchia smette di valere; il dispositivo resta fidato e ne crea una da solo al prossimo accesso.`)) return;
        await this.api(base + '/rigenera', { method: 'POST' });
      }
      toast({ approva: 'Approvato: entra subito.', revoca: d?.state === 'attesa' ? 'Rifiutato.' : 'Revocato.', rename: 'Nome salvato.', rigenera: 'Chiesta una chiave nuova.' }[a] || 'Fatto.');
    } catch (e) { toast(e.message); }
    this.paint(); this.fresh(s, true).then(() => this.dot());
  },
  menu(d) {
    if (!d) return;
    const dl = $('#dlg'); dl.className = 'sheet';
    const items = [['pen', 'Rinomina', 'rename'], d.keyed ? ['key', 'Chiedi una chiave nuova', 'rigenera'] : null, ['trash', 'Revoca', 'revoca', 'danger']].filter(Boolean);
    dl.innerHTML = `<div class="head"><b>${esc(d.name)}</b></div>${items.map(([i, l, a, c]) => `<button class="mi${c ? ' ' + c : ''}" data-a="${a}">${ic(i)}<span>${l}</span></button>`).join('')}`;
    dl.querySelectorAll('[data-a]').forEach(b => b.onclick = () => { dl.close(); this.act(b.dataset.a, d.id); });
    closeOutside(dl); dl.showModal();
  },
  async pairSheet() {
    const s = srv(); let x;
    try { x = await this.api('/api/dispositivi/abbina', { method: 'POST', body: JSON.stringify({ t: s.tok, s: s.salt }) }); } catch (e) { return toast(e.message); }
    const d = $('#dlg2'); d.className = ''; const link = pubBase(s) + '/#/abbina/' + x.code;
    d.innerHTML = `<h3>Abbina un dispositivo</h3><p class="sub" style="margin-bottom:var(--s3)">Sul dispositivo nuovo: Aggiungi server → «Con un codice», oppure inquadra il QR. Vale una volta sola, per 10 minuti, ed entra subito come tuo dispositivo fidato.</p>
      <p class="pair-code">${esc(fmtCode(x.code))}</p><div id="pairQr" style="margin:var(--s3) 0"></div>
      <div class="row"><button class="btn primary" id="pairCopy">${ic('share')} Copia il link</button><button class="btn" onclick="this.closest('dialog').close()">Fatto</button></div>`;
    $('#pairCopy').onclick = async () => { if (await copyText(link)) toast('Link copiato: aprilo solo sul tuo dispositivo.'); };
    d.showModal(); qrInto($('#pairQr'), link).catch(() => {});
  }
};
// link di abbinamento (<server>/#/abbina/<codice>): apre "Con un codice" con indirizzo e codice già compilati
function vAbbina(code) {
  if (!S.servers.length) noServer(); else view.innerHTML = '';
  serverDialog(null, { url: NATIVE ? '' : location.origin, mode: 'codice', code: code || '' });
}
// il gettone scade in 12-24 ore: lo si rinnova prima, e subito se l'app torna in primo piano dopo tanto
setInterval(() => { const s = srv(); if (s?.session && !document.hidden) Disp.fresh(s); }, 10 * 60000);
