/* Armony - diagnosi (server con la capacità "diagnosi": server/diagnosi.py).

   Diag raccoglie gli errori di questo dispositivo (JavaScript, promesse rifiutate, console.error, audio che non parte,
   server che non risponde) e li manda al registro eventi del server a lotti; senza rete restano in coda (al più 100).
   Lo stesso errore ripetuto entro 30 secondi si manda una volta sola: il server poi somma i ripetuti in una riga.
   Per l'amministratore, in Impostazioni → Server: "Stato del server" (risorse, ascolti in corso, dispositivi collegati,
   aggiornato ogni 5 secondi mentre la scheda è aperta) e "Registro eventi" (filtri, dettagli, copia per chi ripara). */
'use strict';

I.pulse = '<path d="M3 12h4l3-8 4 16 3-8h4"/>';
I.bug = '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M12 6V3M8 11H4M20 11h-4M8 16H4M20 16h-4M9 3l1.5 2M15 3l-1.5 2"/>';

const Diag = {
  q: store.get('diagQ', []), t: null, seen: new Map(),
  ok(s = srv()) { return !!s?.session && !!s.me?.caps?.includes('diagnosi'); },
  report(level, area, msg, detail = '', extra = {}) {
    msg = String(msg || '').slice(0, 500); if (!msg) return;
    const sig = level + area + msg, now = Date.now();
    if (now - (this.seen.get(sig) || 0) < 30000) return;
    this.seen.set(sig, now); if (this.seen.size > 300) this.seen.clear();
    // solo la rotta: il link di una Jam porta il segreto della stanza dopo #/jam/entra/, e non deve arrivare al server
    const url = location.hash.replace(/^(#\/(jam\/entra|abbina|invito)\/).*/, '$1…').slice(0, 120);
    this.q.push({ level, area, msg, detail: String(detail || '').slice(0, area === 'sessione' ? 7000 : 1500), url, at: now, ...extra, app: window.ARMONY_APP?.version || '', ua: navigator.userAgent.slice(0, 160) });
    if (this.q.length > 100) this.q.splice(0, this.q.length - 100);
    store.set('diagQ', this.q);
    clearTimeout(this.t); this.t = setTimeout(() => this.flush(), level === 'errore' ? 3000 : 15000);
  },
  // keepalive solo quando la pagina si chiude: lì il limite è 64 kB, quindi lotti piccoli
  async flush(leaving = false) {
    const s = srv(); if (!this.q.length || !this.ok(s)) return;
    const batch = this.q.splice(0, leaving ? 8 : 25); store.set('diagQ', this.q);
    try { await srvApi(s, '/api/log', { method: 'POST', keepalive: leaving, body: JSON.stringify({ events: batch.map(x => ({ ...x, device: S.device })) }) }); }
    catch { this.q.unshift(...batch); store.set('diagQ', this.q.slice(-100)); return; }
    if (this.q.length) this.t = setTimeout(() => this.flush(), 5000);
  }
};
window.Diag = Diag;  // const non finisce in window: armony.js lo chiama come window.Diag?.report (file caricato dopo)
addEventListener('error', e => { if (e.target && e.target !== window) return; Diag.report('errore', 'js', e.message, `${e.filename || ''}:${e.lineno || 0}:${e.colno || 0}\n${e.error?.stack || ''}`); });
addEventListener('unhandledrejection', e => { const r = e.reason; if (r?.name === 'AbortError') return; Diag.report('errore', 'promessa', r?.message || String(r), r?.stack || ''); });
{
  const ce = console.error.bind(console), cw = console.warn.bind(console), txt = a => a.map(x => x?.message || (typeof x === 'object' ? (() => { try { return JSON.stringify(x); } catch { return String(x); } })() : String(x))).join(' ');
  console.error = (...a) => { ce(...a); Diag.report('errore', 'console', txt(a), a.find(x => x?.stack)?.stack || ''); };
  console.warn = (...a) => { cw(...a); Diag.report('avviso', 'console', txt(a), a.find(x => x?.stack)?.stack || ''); };
}
addEventListener('pagehide', () => Diag.flush(true));
addEventListener('online', () => setTimeout(() => Diag.flush(), 3000));

/* ---------------- Stato del server ---------------- */
const kb = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' MB/s' : Math.round(n / 1e3) + ' kB/s';
const dur = s => s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min` : `${Math.floor(s / 86400)} g ${Math.floor(s % 86400 / 3600)} h`;
// linea dell'andamento: valori da sinistra (vecchi) a destra (nuovi), scala 0..max
function spark(vals, max) {
  if (vals.length < 2) return '';
  const m = max || Math.max(1, ...vals), w = 100, h = 28, step = w / (vals.length - 1);
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - Math.min(1, v / m) * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="0,${h} ${pts} ${w},${h}" class="area"/><polyline points="${pts}"/></svg>`;
}
const Stato = {
  span: 'fast', busy: false,
  async paint() {
    const box = $('#statoBox'); if (!box || this.busy) return;
    if (!box.closest('.stab')?.classList.contains('on') && box.dataset.done) return;  // scheda nascosta: niente richieste
    this.busy = true;
    let d; try { d = await srvApi(dlSrv(), '/api/stato'); } catch (e) { box.innerHTML = `<p class="sub">Il server non risponde (${esc(e.message)}).</p>`; this.busy = false; return; }
    this.busy = false; if ($('#statoBox') !== box) return;
    box.dataset.done = 1;
    const ser = d[this.span] || [], last = d.fast.at(-1) || {}, col = k => ser.map(x => x[k] || 0);
    const memUsed = d.mem.total - d.mem.available, thr = Math.round((last.req || 0) / d.threads * 100);
    const tile = (label, value, sub, vals, max, warn) => `<div class="sttile${warn ? ' warn' : ''}"><small>${label}</small><b>${value}</b>${sub ? `<span>${sub}</span>` : ''}${vals ? spark(vals, max) : ''}</div>`;
    const streams = d.streams.sort((a, b) => a.since - b.since);
    box.innerHTML = `<div class="row between" style="margin-bottom:var(--s3)"><p class="sub" style="margin:0">Armony ${esc(d.version)} · acceso da ${dur(d.now - d.started)} · server acceso da ${dur(d.uptime)}</p>
      <div class="seg" role="radiogroup" aria-label="Periodo"><label><input type="radio" name="stSpan" value="fast" ${this.span === 'fast' ? 'checked' : ''}><span>Ultima ora</span></label><label><input type="radio" name="stSpan" value="slow" ${this.span === 'slow' ? 'checked' : ''}><span>24 ore</span></label></div></div>
      ${ser.length < 2 ? '<p class="small" style="color:var(--muted)">Gli andamenti compaiono dopo qualche secondo di misure.</p>' : ''}
      <div class="stgrid">
        ${tile('Processore', `${Math.round(last.cpu || 0)}%`, `${d.cores} core · Armony ${String(last.app ?? 0).replace('.', ',')}%`, col('cpu'), 100, last.cpu > 85)}
        ${tile('Memoria', `${Math.round(last.mem || 0)}%`, `${bytes(memUsed)} di ${bytes(d.mem.total)} · Armony ${bytes(last.rss || 0)}`, col('mem'), 100, last.mem > 90)}
        ${tile('Carico', String(last.load ?? 0).replace('.', ','), `su ${d.cores} core`, col('load'), Math.max(d.cores, ...col('load')), last.load > d.cores * 1.5)}
        ${tile('Rete', `↓ ${kb(last.rx || 0)}`, `↑ ${kb(last.tx || 0)}`, col('tx'), 0)}
        ${tile('Ascolti in corso', streams.length, streams.length ? `${[...new Set(streams.map(s => s.user))].length} utenti` : 'nessuno', col('audio'), 0)}
        ${tile('Dispositivi collegati', d.live.length, `${[...new Set(d.live.map(x => x.user))].length} utenti`, col('live'), 0)}
        ${tile('Richieste aperte', `${last.req || 0} / ${d.threads}`, `${thr}% dei thread`, col('req'), d.threads, thr > 80)}
        ${tile('Coda download', d.jobs.queue, d.jobs.ytPause ? `YouTube in pausa ${Math.ceil(d.jobs.ytPause / 60)} min` : `${d.jobs.byStatus['in corso'] || 0} in corso`, col('jobs'), 0, d.jobs.ytPause > 0)}
        ${tile('Navidrome', d.navidrome_ms == null ? 'non risponde' : `${d.navidrome_ms} ms`, 'tempo di risposta', null, 0, d.navidrome_ms == null || d.navidrome_ms > 1000)}
        ${tile('Disco', `${Math.round(d.disk.used / d.disk.total * 100)}%`, `liberi ${bytes(d.disk.free)}`, null, 0, d.disk.free < d.disk.total * .05)}
      </div>
      <h3>Ascolti in corso</h3>${streams.length ? `<div class="stlist">${streams.map(s => `<div class="list-item" style="cursor:default"><span class="pav" style="--pav:${tileColor(s.user || '?')}" aria-hidden="true">${esc((s.user || '?')[0].toUpperCase())}</span>
        <span class="grow"><b>${esc(s.title || 'Brano')}${s.artist ? ` <small>· ${esc(s.artist)}</small>` : ''}</b><small>${esc(s.user || '?')} · ${s.fmt === 'raw' ? 'originale' : esc(s.fmt)} · ${s.kbps} kbps · da ${dur(s.since)} · ${bytes(s.bytes)}</small></span></div>`).join('')}</div>`
        : '<p class="sub">Nessuno sta scaricando audio dal server in questo momento. Un brano occupa la rete solo finché il telefono non ne ha abbastanza in memoria.</p>'}
      <h3>Dispositivi collegati</h3>${d.live.length ? `<div class="stlist">${d.live.sort((a, b) => a.user.localeCompare(b.user)).map(x => `<div class="list-item" style="cursor:default"><span class="grow"><b>${esc(x.name)}</b><small>${esc(x.user)} · ${x.net === 'locale' ? 'da casa' : x.net === 'tailscale' ? 'da Tailscale' : 'da internet'} · collegato da ${dur(x.since)}</small></span></div>`).join('')}</div>` : '<p class="sub">Nessun dispositivo collegato.</p>'}
      <p class="small" style="color:var(--muted)">Ogni dispositivo collegato e ogni brano che sta scaricando tengono occupato un thread del server (sono ${d.threads}). Sopra l'80% conviene aumentarli o capire chi ne tiene tanti; gli avvisi finiscono anche nel registro eventi.</p>`;
    box.querySelectorAll('[name=stSpan]').forEach(r => r.onchange = () => { this.span = r.value; this.paint(); });
  }
};

/* ---------------- Registro eventi ---------------- */
const LOG_LV = { errore: ['Errore', 'err'], avviso: ['Avviso', 'acc'], info: ['Info', ''] };
const Registro = {
  f: { level: '', q: '', src: '' }, open: new Set(), busy: false,
  qs() { return new URLSearchParams(Object.entries(this.f).filter(([, v]) => v)).toString(); },
  async paint() {
    const box = $('#logBox'); if (!box || this.busy) return;
    if (!box.closest('.stab')?.classList.contains('on') && box.dataset.done) return;
    this.busy = true;
    let d; try { d = await srvApi(dlSrv(), '/api/log?limit=300&' + this.qs()); } catch (e) { box.innerHTML = `<p class="sub">${esc(e.message)}</p>`; this.busy = false; return; }
    this.busy = false; if ($('#logBox') !== box) return;
    const first = !box.dataset.done; box.dataset.done = 1;
    const day = d.day || {}, n = k => (day[k] || 0).toLocaleString('it-IT');
    if (first) {
      box.innerHTML = `<p class="sub">Errori e situazioni incerte del server e dei dispositivi, i ripetuti sommati in una riga. Nelle ultime 24 ore: <b id="lgDay"></b>.</p>
        <div class="row" style="margin-bottom:var(--s3)"><div class="seg" role="radiogroup" aria-label="Gravità">${[['', 'Tutti'], ['errore', 'Errori'], ['avviso', 'Avvisi'], ['info', 'Info']].map(([v, l]) => `<label><input type="radio" name="lgLv" value="${v}" ${this.f.level === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
          <select id="lgSrc" style="width:auto" aria-label="Provenienza"><option value="">Server e dispositivi</option><option value="server">Solo server</option><option value="client">Solo dispositivi</option></select></div>
        <label class="setsearch" style="margin-bottom:var(--s3)">${ic('search')}<input type="search" id="lgQ" placeholder="Cerca nel registro" aria-label="Cerca nel registro" value="${esc(this.f.q)}"></label>
        <div class="row" style="margin-bottom:var(--s3)"><button class="btn sm" data-lg="copy">${ic('share')} Copia per chi ripara</button><button class="btn sm" data-lg="save">${ic('down')} Scarica</button><button class="btn sm danger" data-lg="clear">${ic('trash')} Svuota</button></div>
        <div id="lgList"></div>`;
      box.querySelectorAll('[name=lgLv]').forEach(r => r.onchange = () => { this.f.level = r.value; this.paint(); });
      $('#lgSrc').value = this.f.src; $('#lgSrc').onchange = e => { this.f.src = e.target.value; this.paint(); };
      let t; $('#lgQ').oninput = e => { clearTimeout(t); t = setTimeout(() => { this.f.q = e.target.value.trim(); this.paint(); }, 300); };
      box.querySelectorAll('[data-lg]').forEach(b => b.onclick = () => this.act(b.dataset.lg));
    }
    $('#lgDay').textContent = `${n('errore')} errori, ${n('avviso')} avvisi, ${n('info')} informazioni`;
    const list = $('#lgList');
    keyed(list, d.items.length ? d.items.map(r => {
      const [l, c] = LOG_LV[r.level] || LOG_LV.info, who = [r.user, r.dev && r.src === 'client' ? 'dispositivo ' + r.dev.slice(-6) : ''].filter(Boolean).join(' · ');
      let det = r.detail || '';
      if (r.src === 'client') { try { const j = JSON.parse(det); det = [j.detail, j.stack, j.url && 'Pagina: ' + j.url, j.app && 'App ' + j.app, j.ua].filter(Boolean).join('\n'); } catch {} }
      return { k: String(r.id), cls: 'logrow' + (this.open.has(r.id) ? ' open' : ''), html: `<button class="logsum" data-id="${r.id}" aria-expanded="${this.open.has(r.id)}"><span class="tag ${c}">${l}</span>
        <span class="grow"><b>${esc(r.msg)}</b><small>${esc(r.area)}${r.n > 1 ? ` · ${r.n.toLocaleString('it-IT')} volte` : ''}${who ? ' · ' + esc(who) : ''}</small></span><small class="logat">${ago(r.last * 1000)}</small></button>
        ${det ? `<pre class="logdet">${esc(det)}</pre>` : ''}` };
    }) : [{ k: 'vuoto', cls: 'empty', html: this.f.level || this.f.q || this.f.src ? 'Nessun evento con questi filtri.' : 'Il registro è vuoto: finora niente è andato storto.' }]);
    list.querySelectorAll('.logsum').forEach(b => b.onclick = () => { const id = +b.dataset.id; this.open.has(id) ? this.open.delete(id) : this.open.add(id); b.parentElement.classList.toggle('open'); b.setAttribute('aria-expanded', this.open.has(id)); });
  },
  async text() { const r = await fetch(absUrl(dlSrv().url) + '/api/log/testo?' + this.qs(), { headers: { 'X-Token': dlSrv().session } }); if (!r.ok) throw new Error(`Errore ${r.status}`); return r.text(); },
  async act(a) {
    try {
      if (a === 'copy') { if (await copyText(await this.text())) toast('Registro copiato: incollalo a chi deve ripararlo.'); }
      else if (a === 'save') saveFile(`armony-registro-${new Date().toISOString().slice(0, 10)}.txt`, await this.text());
      else if (a === 'clear' && confirm('Svuotare il registro eventi?')) { await srvApi(dlSrv(), '/api/log', { method: 'DELETE' }); toast('Registro svuotato.'); this.paint(); }
    } catch (e) { toast(e.message); }
  }
};
function diagPaint() {
  if (!$('#statoBox') && !$('#logBox')) return;
  Stato.paint(); Registro.paint();
  viewInterval(() => { Stato.paint(); }, 5000);
  viewInterval(() => { Registro.paint(); }, 15000);
}
