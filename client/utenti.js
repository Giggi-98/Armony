/* Armony - utenti, permessi, benvenuto e accesso (server con le capacità "permessi": server/utenti.py).

   - can(k): un permesso dell'utente di questo server (l'amministratore li ha tutti). Il server li applica comunque:
     qui servono a non mostrare tasti che darebbero solo un errore.
   - Impostazioni → Server → Utenti: elenco di tutti gli utenti, foglio con i permessi di ognuno, «Nuovo utente».
     Un utente nuovo ha una password provvisoria che non vede nessuno e un link di benvenuto (QR per l'app, link per il
     browser) che vale una volta, per 24 ore.
   - #/benvenuto/<codice>: chi apre il link sceglie la sua password, che prende il posto di quella provvisoria; il
     dispositivo entra fidato e si salva le credenziali (token + sale, mai la password).
   - La schermata di accesso, per chi apre Armony dal browser senza server configurati. */
'use strict';

I.userplus = '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6"/>';

const can = k => { const a = access(); return !!a.admin || (a.perm ? a.perm[k] !== false : true); };

// entrare in un server con utente e credenziali (token + sale) già calcolate: login di Armony, poi il server diventa quello in uso
async function enterServer(n) {
  ['session', 'armony', 'me', 'pending', 'revoked', 'tk'].forEach(k => delete n[k]);
  if (!n.dev) await Disp.forget(n);
  let arm = null;
  try { arm = await armonyLogin(n); } catch (e) { if (!n.pending) throw e; }
  if (!arm && !n.pending) await api('ping', {}, n);
  n.name ||= arm?.name || new URL(absUrl(n.url)).host;
  const i = S.servers.findIndex(x => x.id === n.id); if (i >= 0) S.servers[i] = n; else S.servers.push(n);
  S.active = n.id; if (n.session) store.set('downloader', null);
  persistServers(); location.hash = '#/home'; route(); Live.connect?.();
  return n;
}

/* ---------------- schermata di accesso (browser, nessun server ancora) ---------------- */
I.eye = '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>';
I.eyeoff = '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>';
// a tutta pagina, senza barra laterale né lettore (data-login su <html>, index.html): chi non è entrato non ha niente da ascoltare
function loginCard() {
  return `<div class="lgpage"><form class="login" id="loginForm" autocomplete="on">
    <div class="lg-brand"><span class="login-logo" aria-hidden="true"></span><span>armony</span></div>
    <div><h1>Entra<span id="lgSrv"></span></h1><p class="sub">Con l'utente e la password che ti ha dato chi gestisce il server, o quella che hai scelto con il link di benvenuto.</p></div>
    <label class="f">Utente<input type="text" id="lgU" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next" required></label>
    <label class="f">Password<span class="lg-pw"><input type="password" id="lgP" autocomplete="current-password" enterkeyhint="go" required>
      <button type="button" class="icon-btn" id="lgEye" aria-label="Mostra la password" aria-pressed="false">${ic('eye')}</button></span></label>
    <p class="lg-msg" id="lgMsg" role="alert"></p>
    <button class="btn primary lg-go" id="lgGo">Entra</button>
    <p class="lg-or"><span>oppure</span></p>
    <div class="lg-alt">
      <button type="button" class="mi" data-act="scanqr">${ic('qr')}<span class="grow">Ho un QR<small>Inquadra quello che ti hanno mandato</small></span>${ic('chevr')}</button>
      <button type="button" class="mi" data-act="addsrv" data-url="${esc(location.origin)}">${ic('send')}<span class="grow">Ho un invito o un codice<small>Il codice a 8 cifre o il link di invito</small></span>${ic('chevr')}</button>
      <button type="button" class="mi" data-act="addsrv">${ic('globe')}<span class="grow">Un altro server<small>Navidrome o Armony di qualcun altro</small></span>${ic('chevr')}</button>
    </div></form>
    <p class="lg-foot"><a href="${esc(apkUrl())}">${ic('down')} App Android</a><span aria-hidden="true">·</span><button type="button" id="welQr">QR dell'app</button></p></div>`;
}
function wireLogin() {
  const f = $('#loginForm'); if (!f) return;
  document.documentElement.dataset.login = '';
  fetch(location.origin + '/api/info').then(r => r.json()).then(j => { if (j.name && $('#lgSrv')) $('#lgSrv').innerHTML = ` su <b>${esc(j.name)}</b>`; }).catch(() => {});
  $('#lgEye').onclick = e => { const p = $('#lgP'), b = e.currentTarget, show = p.type === 'password'; p.type = show ? 'text' : 'password'; b.innerHTML = ic(show ? 'eyeoff' : 'eye'); b.setAttribute('aria-pressed', show); b.setAttribute('aria-label', show ? 'Nascondi la password' : 'Mostra la password'); p.focus(); };
  if (matchMedia('(pointer:fine)').matches) setTimeout(() => $('#lgU')?.focus(), 50);
  f.onsubmit = async e => {
    e.preventDefault();
    const user = $('#lgU').value.trim(), pass = $('#lgP').value, msg = t => { $('#lgMsg').textContent = t; };
    if (!user || !pass) return msg('Scrivi utente e password.');
    $('#lgGo').disabled = true; msg('');
    try {
      const n = await enterServer({ id: uid(8), name: '', url: location.origin, user, shareBase: '', ...subsonicCreds(pass) });
      toast(n.pending ? 'Dispositivo registrato: aspetta che lo approvi chi gestisce il server.' : `Benvenuto, ${n.user}!`, 5000);
    } catch (er) { msg(/errati|40\b|401/.test(er.message) ? 'Utente o password errati.' : er.message); $('#lgGo').disabled = false; }
  };
}

/* ---------------- benvenuto: il link o il QR creato dall'amministratore ---------------- */
// base: il server del link (nell'app arriva dal QR, nel browser è questa pagina)
async function vBenvenuto(code, base = NATIVE ? '' : location.origin) {
  if (!base) { noServer(); return toast('Inquadra il QR di benvenuto con «Inquadra un QR».'); }
  await NetDns.need(base);
  let info; try { const r = await fetch(absUrl(base) + '/api/benvenuto/' + encodeURIComponent(code)); info = await r.json(); if (!r.ok) throw new Error(info.error || `Errore ${r.status}`); }
  catch (e) { view.innerHTML = `<div class="login"><span class="login-logo" aria-hidden="true"></span><h1>Link non valido</h1><p class="sub">${esc(e.message)}</p>${S.servers.length ? '<a class="btn" href="#/home">Vai alla home</a>' : ''}</div>`; return; }
  view.innerHTML = `<form class="login" id="welForm"><span class="login-logo" aria-hidden="true"></span>
    <h1>Ciao ${esc(info.user)}!</h1><p class="sub">Ti hanno creato un account su <b>${esc(info.name)}</b>. Scegli la tua password: con lei rientri da altri dispositivi o da altre app. Questo telefono o browser la ricorda da solo.</p>
    <input type="text" autocomplete="username" value="${esc(info.user)}" hidden>
    <label class="f">La tua password<input type="password" id="welP" autocomplete="new-password" minlength="8" required placeholder="Almeno 8 caratteri"></label>
    <label class="f">Ripetila<input type="password" id="welP2" autocomplete="new-password" required></label>
    <p class="small" id="welMsg" role="status" style="margin:0;color:var(--danger)"></p>
    <button class="btn primary" id="welGo">Entra in Armony</button></form>`;
  $('#welForm').onsubmit = async e => {
    e.preventDefault();
    const p1 = $('#welP').value, msg = t => { $('#welMsg').textContent = t; };
    if (p1.length < 8) return msg('La password deve avere almeno 8 caratteri.');
    if (p1 !== $('#welP2').value) return msg('Le due password non coincidono.');
    $('#welGo').disabled = true; msg('');
    try {
      const r = await fetch(absUrl(base) + '/api/benvenuto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, password: p1 }) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `Errore ${r.status}`);
      // con il grant il primo accesso entra fidato, senza aspettare l'approvazione
      await enterServer({ id: uid(8), name: j.name || '', url: base.replace(/\/+$/, ''), user: j.user, shareBase: '', grant: j.grant, ...subsonicCreds(p1) });
      toast(`Benvenuto in Armony, ${j.user}!`, 5000);
    } catch (er) { msg(er.message); $('#welGo').disabled = false; }
  };
}

/* ---------------- Impostazioni → Server → Utenti ---------------- */
async function refreshUsers() {
  const box = $('#usrBox'); if (!box) return;
  let r; try { r = await dlApi('/api/users'); } catch (e) { box.innerHTML = `<p class="sub">${esc(e.message)}</p>`; return; }
  if (Array.isArray(r)) return oldUsers(box, r);  // server senza "permessi": l'elenco di prima
  Users.defs = r.perms; Users.list = r.users;
  const sum = u => {
    if (u.admin) return 'Amministratore: può tutto';
    const off = r.perms.filter(p => !u.perms[p.k]).map(p => p.label.toLowerCase());
    return [u.devices ? `${u.devices} ${u.devices === 1 ? 'dispositivo' : 'dispositivi'}` : 'nessun dispositivo', u.seen ? 'visto ' + ago(u.seen * 1000) : '',
      off.length ? `senza: ${off.slice(0, 2).join(', ')}${off.length > 2 ? ` e altri ${off.length - 2}` : ''}` : 'tutti i permessi'].filter(Boolean).join(' · ');
  };
  box.innerHTML = `${r.error ? `<p class="small" style="color:var(--danger)">Navidrome non risponde (${esc(r.error)}): vedi solo chi è già entrato da Armony. Controlla Registrazione qui sotto.</p>` : ''}
    <div class="row" style="margin-bottom:var(--s3)"><button class="btn primary" data-uact="new">${ic('userplus')} Nuovo utente</button></div>
    <div class="usrlist">${r.users.map((u, i) => `<button class="list-item usr" data-uact="open" data-i="${i}">${pavatar({ user: u.user, name: u.user }, 'm')}
      <span class="grow"><b>${esc(u.user)}${u.me ? ' <small>(tu)</small>' : ''}</b><small>${esc(sum(u))}</small></span>${ic('chevr')}</button>`).join('')}</div>`;
  box.onclick = e => { const b = e.target.closest('[data-uact]'); if (!b) return; b.dataset.uact === 'new' ? Users.create() : Users.sheet(r.users[+b.dataset.i]); };
}
function oldUsers(box, list) {
  box.innerHTML = list.length ? list.map(u => `<div class="list-item" style="cursor:default;flex-wrap:wrap">
    <span class="grow"><b>${esc(u.user)}</b><small>${u.admin ? 'amministratore' : 'utente'}${u.seen ? ', ultimo accesso ' + new Date(u.seen * 1000).toLocaleDateString() : ''}</small></span>
    ${['upload', 'download', 'delete'].map(p => `<label class="check box" style="margin:0"><input type="checkbox" data-usr="${esc(u.user)}" data-perm="${p}" ${u[p] || u.admin ? 'checked' : ''} ${u.admin ? 'disabled' : ''}><span>${{ upload: 'Caricamento', download: 'Download', delete: 'Modifica ed eliminazione' }[p]}</span></label>`).join('')}
    ${u.sessions ? `<button class="btn sm" data-act="usrrevoke" data-user="${esc(u.user)}">${Disp.ok(srv()) ? 'Revoca i dispositivi' : 'Disconnetti'}</button>` : ''}</div>`).join('')
    : '<div class="empty">Nessun utente ha ancora fatto accesso da Armony.</div>';
  box.querySelectorAll('[data-usr]').forEach(el => el.onchange = async () => {
    const name = el.dataset.usr, v = p => box.querySelector(`[data-usr="${CSS.escape(name)}"][data-perm="${p}"]`).checked;
    try { await dlApi('/api/users/' + encodeURIComponent(name), { method: 'PUT', body: JSON.stringify({ upload: v('upload'), download: v('download'), delete: v('delete') }) }); toast('Permessi aggiornati.'); }
    catch (e) { toast(e.message); refreshUsers(); }
  });
}
const Users = {
  defs: [], list: [],
  toggles(perms, dis = false) {
    return this.defs.map(p => `<label class="check"><input type="checkbox" data-perm="${p.k}" ${perms[p.k] ? 'checked' : ''} ${dis ? 'disabled' : ''}><span>${esc(p.label)}<small>${esc(p.hint)}</small></span></label>`).join('');
  },
  read: box => Object.fromEntries([...box.querySelectorAll('[data-perm]')].map(x => [x.dataset.perm, x.checked])),
  sheet(u) {
    const d = $('#dlg'); d.className = 'sheet usrsheet';
    d.innerHTML = `<div class="head">${pavatar({ user: u.user, name: u.user }, 'l')}<span class="grow" style="min-width:0"><b style="display:block">${esc(u.user)}</b>
      <small style="color:var(--muted)">${u.admin ? 'Amministratore: può tutto, sempre.' : `${u.devices} ${u.devices === 1 ? 'dispositivo' : 'dispositivi'}${u.seen ? ' · visto ' + ago(u.seen * 1000) : ''}`}</small></span></div>
      ${u.admin ? '' : `<p class="sh">Cosa può fare</p><div class="usrperms" id="usrPerms">${this.toggles(u.perms)}</div>
      <p class="sh">Accesso</p>
      <button class="mi" data-u="link">${ic('qr')}<span class="grow"><b>Nuovo link di benvenuto</b><small style="color:var(--muted)">Telefono nuovo o password dimenticata: con il link sceglie una password nuova</small></span></button>
      <button class="mi" data-u="revoke">${ic('lock')}<span class="grow"><b>Revoca i dispositivi</b><small style="color:var(--muted)">Escono subito; per rientrare servono password e approvazione</small></span></button>
      <button class="mi danger" data-u="del">${ic('trash')}<span class="grow"><b>Elimina l'utente</b><small>Anche le sue playlist e il suo storico. La musica resta.</small></span></button>`}`;
    const box = $('#usrPerms');
    box?.addEventListener('change', async () => {
      try { await dlApi('/api/users/' + encodeURIComponent(u.user), { method: 'PUT', body: JSON.stringify({ perms: this.read(box) }) }); u.perms = this.read(box); toast('Permessi di ' + u.user + ' aggiornati.'); refreshUsers(); }
      catch (e) { toast(e.message); }
    });
    d.querySelectorAll('[data-u]').forEach(b => b.onclick = async () => {
      const a = b.dataset.u, name = encodeURIComponent(u.user);
      try {
        if (a === 'link') {
          // per un telefono perso o rubato i dispositivi di prima vanno revocati: con la chiave continuerebbero a entrare
          const revoca = confirm(`Revocare anche i dispositivi attuali di ${u.user}?\n\nOK se ha perso il telefono o non vuoi che quelli di prima funzionino ancora; Annulla per tenerli.`);
          d.close(); this.welcome(await dlApi(`/api/users/${name}/accesso`, { method: 'POST', body: JSON.stringify({ revoca }) }), false);
          if (revoca) toast(`Dispositivi di ${u.user} revocati.`);
        }
        else if (a === 'revoke' && confirm(`Revocare tutti i dispositivi di ${u.user}? Smettono subito di funzionare.`)) { await dlApi(`/api/users/${name}/sessions`, { method: 'DELETE' }); d.close(); toast('Dispositivi revocati.'); refreshUsers(); }
        else if (a === 'del' && prompt(`Per eliminare ${u.user}, le sue playlist e il suo storico scrivi il suo nome:`) === u.user) { await dlApi(`/api/users/${name}`, { method: 'DELETE' }); d.close(); toast(`${u.user} eliminato.`); refreshUsers(); }
      } catch (e) { toast(e.message); }
    });
    closeOutside(d); d.showModal();
  },
  create() {
    const d = $('#dlg'); d.className = 'sheet usrsheet';
    const dflt = Object.fromEntries(this.defs.map(p => [p.k, !['vedipl', 'delete'].includes(p.k)]));
    d.innerHTML = `<div class="head"><span class="grow"><b style="display:block">Nuovo utente</b><small style="color:var(--muted)">La password la sceglie lui al primo ingresso, con il link o il QR che ti do dopo.</small></span></div>
      <div style="padding:0 14px"><label class="f">Nome utente<input type="text" id="nuName" autocapitalize="none" autocorrect="off" maxlength="32" placeholder="es. giulia"></label></div>
      <p class="sh">Cosa può fare</p><div class="usrperms" id="nuPerms">${this.toggles(dflt)}</div>
      <div class="row" style="padding:var(--s3) 14px 4px"><button class="btn primary" id="nuGo">Crea l'utente</button><button class="btn" onclick="this.closest('dialog').close()">Annulla</button></div>`;
    $('#nuGo').onclick = async () => {
      const name = $('#nuName').value.trim();
      if (!/^[A-Za-z0-9._-]{3,32}$/.test(name)) return toast('Il nome utente va da 3 a 32 caratteri: lettere, cifre, punto, trattino e trattino basso.');
      $('#nuGo').disabled = true;
      try { const r = await dlApi('/api/users', { method: 'POST', body: JSON.stringify({ username: name, perms: this.read($('#nuPerms')) }) }); d.close(); refreshUsers(); this.welcome(r, true); }
      catch (e) { toast(e.message); $('#nuGo').disabled = false; }
    };
    closeOutside(d); d.showModal(); $('#nuName').focus();
  },
  // il link (browser) e il QR (app): valgono una volta, per 24 ore
  welcome(r, isNew) {
    const d = $('#dlg2'); d.className = '';
    const until = new Date(r.expires * 1000).toLocaleString('it-IT', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
    const text = `Ciao ${r.user}! ${isNew ? 'Ti ho creato un account' : 'Ecco il tuo nuovo accesso'} su Armony: apri ${r.link} (o inquadra il QR con l'app) e scegli la tua password. Vale una volta sola, fino a ${until}.`;
    d.innerHTML = `<h3>${isNew ? `Account di ${esc(r.user)} pronto` : `Nuovo accesso per ${esc(r.user)}`}</h3>
      <p class="sub" style="margin-bottom:var(--s3)">Mandagli il link o fagli inquadrare il QR con l'app Android (Inquadra un QR). Al primo ingresso sceglie la sua password e il dispositivo entra subito. Vale una volta sola, fino a ${esc(until)}.</p>
      <div id="welQr" style="display:grid;place-items:center;margin:var(--s3) 0"></div>
      <div class="code" style="font-size:.8rem;word-break:break-all">${esc(r.link)}</div>
      <div class="row" style="margin-top:var(--s3)"><button class="btn primary" id="welShare">${ic('share')} ${navigator.share ? 'Manda il link' : 'Copia il messaggio'}</button><button class="btn" onclick="this.closest('dialog').close()">Fatto</button></div>`;
    $('#welShare').onclick = async () => {
      if (navigator.share) { try { await navigator.share({ title: 'Armony', text, url: r.link }); return; } catch {} }
      if (await copyText(text)) toast('Messaggio copiato: incollalo in una chat.');
    };
    closeOutside(d); d.showModal(); qrInto($('#welQr'), r.link).catch(() => { $('#welQr').innerHTML = '<p class="sub">Il QR non si è caricato: usa il link.</p>'; });
  }
};
