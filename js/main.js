// VolleyScout Pro — avvio applicazione, stato globale, file, annulla/ripeti.
import { h, $, $$, clear, toast, modal, confirmDialog } from './ui/dom.js';
import { newMatch, newPlayer, replay, playerLookup, defaultSetter, liberos, uid, setterPosition } from './lib/engine.js';
import { buildLearner } from './lib/predict.js';
import { validate } from './lib/validate.js';
import { toDVW, fromDVW, decodeBytes, clockFor } from './lib/dvw.js';
import { skillCode } from './lib/codes.js';
import { saveMatch, loadMatch, lastMatchId, listMatches, deleteMatch, download, putHandle, getHandle } from './lib/store.js';
import { createScout } from './ui/scout.js';
import { createSetup } from './ui/setup.js';
import { createReport } from './ui/report.js';
import { createPlaylist } from './ui/playlist.js';
import { createSettings } from './ui/settings.js';
import { createAuto } from './ui/auto.js';
import { officialLineup } from './ui/official.js';
import { SKILLS, DEFAULT_SETTINGS } from './lib/constants.js';
import { classifyVideoUrl, bookmarkletHref, teamsFromTitle } from './lib/videosrc.js';
import { resolveMega, megaStreamUrl } from './lib/mega.js';
import { createYouTubeBinding } from './ui/ytplayer.js';

const app = {
  match: null,
  rp: null,
  learner: null,
  issues: [],
  undoStack: [],
  redoStack: [],
  video: h('video', { id: 'video', playsinline: true, preload: 'auto' }),
  tab: 'scout',
};
window.vsp = app; // utile per debug e test

let saveTimer = null;
app.save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!saveMatch(app.match)) toast('Salvataggio locale non riuscito (spazio esaurito?) — esporta il file!', 'error', 6000);
    $('#save-state').textContent = 'Salvato ' + new Date().toLocaleTimeString().slice(0, 5);
  }, 400);
  $('#save-state').textContent = 'Modifiche…';
};
app.touch = () => { app.save(); };

app.refresh = () => {
  app.rp = replay(app.match);
  app.learner = buildLearner(app.rp.rows);
  app.issues = validate(app.match, app.rp);
  app.lookup = playerLookup(app.match);
  updateHeader();
};

app.commit = (label, fn) => {
  app.undoStack.push({ label, events: structuredClone(app.match.events) });
  if (app.undoStack.length > 200) app.undoStack.shift();
  app.redoStack = [];
  fn(app.match);
  app.refresh();
  app.save();
};
app.undo = () => {
  const s = app.undoStack.pop();
  if (!s) { toast('Niente da annullare'); return; }
  app.redoStack.push({ label: s.label, events: structuredClone(app.match.events) });
  app.match.events = s.events;
  app.refresh(); app.save(); renderActive();
  toast(`Annullato: ${s.label}`);
};
app.redo = () => {
  const s = app.redoStack.pop();
  if (!s) { toast('Niente da ripetere'); return; }
  app.undoStack.push({ label: s.label, events: structuredClone(app.match.events) });
  app.match.events = s.events;
  app.refresh(); app.save(); renderActive();
  toast(`Ripetuto: ${s.label}`);
};

app.setMatch = (m) => {
  // migrazione/compatibilità impostazioni
  m.settings = { ...structuredClone(DEFAULT_SETTINGS), ...(m.settings || {}) };
  m.settings.format = { ...DEFAULT_SETTINGS.format, ...(m.settings.format || {}) };
  m.calibration = m.calibration || { points: {} };
  m.video = m.video || { name: '', offset: 0 };
  app.match = m;
  app.undoStack = []; app.redoStack = [];
  app.refresh();
  app.save();
  modules.scout?.clearPending();
  renderActive();
  offerVideoReopen();
};

// ---------- moduli ----------
const modules = {};
function mountModules() {
  modules.scout = createScout(app);
  modules.setup = createSetup(app);
  modules.report = createReport(app);
  modules.playlist = createPlaylist(app);
  modules.settings = createSettings(app);
  modules.auto = createAuto(app);
  for (const [k, m] of Object.entries(modules)) $(`#tab-${k}`).appendChild(m.el);
}
app.showTab = (t) => {
  app.tab = t;
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === t));
  for (const s of $$('main > section')) s.classList.toggle('active', s.id === `tab-${t}`);
  // il video vive nella scheda in cui serve
  if (t === 'playlist') modules.playlist.attachVideo();
  else if (t === 'auto') modules.auto.attachVideo();
  else if (t === 'scout') { modules.scout.el.querySelector('.video-wrap').prepend(app.video); app.video.controls = false; }
  renderActive();
};
function renderActive() { modules[app.tab]?.render(); }

function updateHeader() {
  const m = app.match;
  const cur = app.rp.current;
  $('#match-title').textContent = `${m.teams['*'].name} – ${m.teams.a.name}`;
  $('#match-sub').textContent = cur ? `Set ${cur.set} · ${cur.score['*']}-${cur.score.a} · set ${app.rp.setsWon['*']}-${app.rp.setsWon.a}` : 'Partita non iniziata';
  const nErr = app.issues.filter((i) => i.level === 'error').length;
  const b = $('#issues-badge');
  b.textContent = nErr ? `⚠ ${nErr}` : '';
  b.hidden = !nErr;
}

// ---------- formazioni ----------
app.openLineup = (editIndex = null) => {
  const m = app.match;
  const rp = app.rp;
  const editing = editIndex != null ? m.events[editIndex] : null;
  const setNo = editing ? editing.set : rp.nextSet;
  const prevLineup = [...m.events].reverse().find((e) => e.kind === 'lineup');
  const firstLineup = m.events.find((e) => e.kind === 'lineup');
  const isTiebreak = setNo === m.settings.format.setsToWin * 2 - 1;
  const draft = editing ? structuredClone(editing) : {
    kind: 'lineup', set: setNo,
    h: prevLineup ? [...prevLineup.h] : [null, null, null, null, null, null],
    v: prevLineup ? [...prevLineup.v] : [null, null, null, null, null, null],
    hSetter: prevLineup?.hSetter ?? null, vSetter: prevLineup?.vSetter ?? null,
    // i set dispari li inizia chi ha battuto per primo nel 1° set, i pari l'altra
    serve: firstLineup ? (setNo % 2 === 1 ? firstLineup.serve : (firstLineup.serve === '*' ? 'a' : '*')) : '*',
    homeNear: prevLineup ? !prevLineup.homeNear : true,
  };
  // dati ufficiali caricati: formazioni di partenza dal tabellino (solo giocatori in rosa)
  const offLu = !editing ? officialLineup(m, setNo) : null;
  let fromOfficial = false;
  if (offLu) {
    const inRoster = (t, arr) => arr && arr.every((n) => m.teams[t].players.some((p) => Number(p.number) === n));
    if (inRoster('*', offLu.h)) { draft.h = [...offLu.h]; draft.hSetter = defaultSetter(m, '*', draft.h); fromOfficial = true; }
    if (inRoster('a', offLu.v)) { draft.v = [...offLu.v]; draft.vSetter = defaultSetter(m, 'a', draft.v); fromOfficial = true; }
    if (offLu.serve) draft.serve = offLu.serve;
  }
  const body = h('div');
  const draw = () => {
    clear(body);
    const team = (t, key, setterKey) => {
      const players = m.teams[t].players.filter((p) => p.role !== 'L').sort((a, b) => a.number - b.number);
      const sel = (i) => h('select', {
        'aria-label': `P${i + 1}`,
        onchange: (e) => {
          draft[key][i] = e.target.value === '' ? null : +e.target.value;
          if (!draft[key].includes(draft[setterKey])) draft[setterKey] = defaultSetter(m, t, draft[key].filter((x) => x != null));
          draw();
        },
      }, h('option', { value: '' }, '—'), players.map((p) => h('option', { value: p.number, selected: Number(draft[key][i]) === Number(p.number) }, `${p.number} ${p.lastName}`)));
      // disposizione come in campo: 4 3 2 / 5 6 1
      const cell = (i) => h('div', { class: 'lu-cell' }, h('span', { class: 'muted' }, `P${i + 1}`), sel(i));
      const libs = liberos(m, t);
      return h('div', { class: 'card lineup-card', style: { borderTopColor: m.teams[t].colour } },
        h('h3', {}, m.teams[t].name),
        m.teams[t].players.length < 6 ? h('p', { class: 'warn' }, 'Servono almeno 6 giocatori in rosa (scheda Partita).') : null,
        h('div', { class: 'lu-grid' }, [3, 2, 1, 4, 5, 0].map(cell)),
        h('label', { class: 'field' }, h('span', {}, 'Palleggiatore'), h('select', { onchange: (e) => { draft[setterKey] = +e.target.value; } },
          draft[key].filter((x) => x != null).map((n) => h('option', { value: n, selected: n === draft[setterKey] }, `${n} ${app.lookup(t, n)?.lastName || ''}`)))),
        libs.length ? h('p', { class: 'muted' }, `Libero: ${libs.join(', ')}`) : null);
    };
    body.append(
      h('div', { class: 'grid2' }, team('*', 'h', 'hSetter'), team('a', 'v', 'vSetter')),
      h('div', { class: 'row gap wrap' },
        h('label', { class: 'field' }, h('span', {}, 'Batte per prima'), h('select', { onchange: (e) => { draft.serve = e.target.value; } },
          ['*', 'a'].map((t) => h('option', { value: t, selected: draft.serve === t }, m.teams[t].name)))),
        h('label', { class: 'field' }, h('span', {}, m.settings.cameraView === 'side' ? 'Squadra a sinistra nel video' : 'Lato vicino alla telecamera'), h('select', { onchange: (e) => { draft.homeNear = e.target.value === '1'; } },
          h('option', { value: '1', selected: draft.homeNear }, m.teams['*'].name),
          h('option', { value: '0', selected: !draft.homeNear }, m.teams.a.name)))),
      fromOfficial ? h('p', { class: 'ok small' }, '📋 Formazioni e servizio dal tabellino ufficiale Legavolley: controlla il lato del campo.') : null,
      isTiebreak && !editing ? h('p', { class: 'muted' }, 'Set decisivo: ricorda il sorteggio per il servizio e il cambio campo a 8 punti (alla richiesta, o con il pulsante ⇅ Campo).') : null);
  };
  draw();
  modal(editing ? `Formazioni set ${setNo}` : `Formazioni — set ${setNo}`, body, {
    wide: true,
    actions: [{ label: 'Annulla' }, {
      label: 'Conferma', primary: true, onClick: () => {
        for (const [t, k] of [['*', 'h'], ['a', 'v']]) {
          if (draft[k].some((x) => x == null) || new Set(draft[k]).size !== 6) { toast(`Formazione ${m.teams[t].name} incompleta o con doppioni`, 'error'); return false; }
        }
        draft.hSetter ??= defaultSetter(m, '*', draft.h);
        draft.vSetter ??= defaultSetter(m, 'a', draft.v);
        draft.hLib = liberos(m, '*'); draft.vLib = liberos(m, 'a');
        app.commit(editing ? 'Modifica formazioni' : 'Formazioni', (mm) => {
          if (editing) mm.events[editIndex] = { ...draft, id: editing.id || uid() };
          else mm.events.push({ ...draft, id: uid() });
        });
        modules.scout.resetLiveClock();
        renderActive();
        return true;
      },
    }],
  });
};

// ---------- video ----------
let videoHandleKey = null;
app.openVideo = async () => {
  if (window.showOpenFilePicker) {
    try {
      const [fh] = await window.showOpenFilePicker({ types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.webm', '.mov', '.mkv', '.m4v', '.ogv'] } }] });
      const file = await fh.getFile();
      videoHandleKey = 'video:' + app.match.id;
      await putHandle(videoHandleKey, fh);
      loadVideoFile(file);
      return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  const inp = h('input', { type: 'file', accept: 'video/*' });
  inp.onchange = () => { if (inp.files[0]) loadVideoFile(inp.files[0]); };
  inp.click();
};
// ---------- video da link esterno (streaming, nessun download) ----------
const yt = createYouTubeBinding(app.video);
app.yt = yt;
app.video.addEventListener('yterror', (e) => toast(e.detail.message, 'error', 7000));
let hls = null;
function resetVideo() {
  yt.close();
  hls?.destroy(); hls = null;
  if (app.video.dataset.objurl) { URL.revokeObjectURL(app.video.dataset.objurl); delete app.video.dataset.objurl; }
  app.video.removeAttribute('src');
  app.video.removeAttribute('crossorigin');
  app.video.load();
  app.videoInfo = { kind: 'none', pixels: false };
  app.videoFile = null;
}
app.resetVideo = resetVideo;
app.videoInfo = { kind: 'none', pixels: false };
const HLS_JS = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js';
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Impossibile caricare ' + src)); document.head.appendChild(s); });
}
// carica un link: prova con CORS (serve all'analisi automatica, che legge i pixel),
// se il server non lo consente riproduce comunque il video senza analisi
app.openVideoUrl = async (raw, { quiet = false } = {}) => {
  const c = classifyVideoUrl(raw);
  if (c.kind === 'invalid') { toast(c.reason, 'error', 5000); return false; }
  if (c.kind === 'volleymetrics') { if (!quiet) app.openVolleyMetricsHelp(c); return false; }
  if (c.temporary && c.expires && new Date(c.expires) < new Date()) {
    toast(`Questo link video è scaduto il ${new Date(c.expires).toLocaleString()}: riaprilo dalla pagina della partita con il collegamento rapido 🏐`, 'error', 9000);
    if (!quiet) app.openVolleyMetricsHelp(null);
    return false;
  }
  if (window.VSP_NO_SW) { toast('Nell\'anteprima su claude.ai i video da link esterni sono bloccati dal browser. Apri l\'app da GitHub Pages o sul PC (npm start).', 'error', 9000); return false; }
  resetVideo();
  const remember = (url) => {
    app.match.settings.clickSurface = 'video';
    if (app.match.video.name && app.match.video.name !== url && app.match.video.url !== url && !quiet) toast('Video diverso da quello registrato nella partita', 'warn', 4000);
    const file = (() => { try { return decodeURIComponent(new URL(c.url).pathname.split('/').pop()); } catch { return ''; } })();
    app.match.video.name = c.kind === 'youtube' ? `YouTube ${c.id}` : c.provider === 'drive' ? 'Video Google Drive' : (file || url).slice(0, 80);
    app.match.video.url = url;
    if (c.temporary) app.match.video.expires = c.expires || 'temp'; else delete app.match.video.expires;
    app.save();
    clear($('#video-reopen'));
  };
  if (c.kind === 'youtube') {
    remember(c.url);
    app.videoInfo = { kind: 'youtube', pixels: false };
    try { await yt.open(c.id, c.start); } catch (e) { toast(e.message, 'error', 7000); return false; }
    renderActive();
    if (!quiet) toast('Video YouTube collegato: scouting a clic disponibile. Analisi e calibrazione automatiche richiedono un file o un link diretto.', 'info', 7000);
    return true;
  }
  const v = app.video;
  if (c.kind === 'mega') {
    if (!quiet) toast('Collegamento a MEGA…', 'info', 3000);
    const ok = await openMega(c.url);
    if (!ok) return false;
    remember(c.url);
    app.match.video.name = ok.name;
    app.save();
    renderActive();
    if (!quiet) toast(`MEGA: ${ok.name} in streaming (decifrato a pezzi, non scaricato).`, 'ok', 6000);
    return true;
  }
  const tryLoad = (cors) => new Promise((res) => {
    if (cors) v.crossOrigin = 'anonymous'; else v.removeAttribute('crossorigin');
    const ok = () => { off(); res(true); };
    const ko = () => { off(); res(false); };
    const off = () => { v.removeEventListener('loadedmetadata', ok); v.removeEventListener('error', ko); clearTimeout(tm); };
    const tm = setTimeout(ko, 20000);
    v.addEventListener('loadedmetadata', ok);
    v.addEventListener('error', ko);
    if (c.kind === 'hls' && !v.canPlayType('application/vnd.apple.mpegurl')) {
      hls?.destroy();
      hls = new window.Hls({ xhrSetup: (x) => { x.withCredentials = false; } });
      hls.on(window.Hls.Events.ERROR, (_, d) => { if (d.fatal) ko(); });
      hls.loadSource(c.url);
      hls.attachMedia(v);
    } else v.src = c.url;
  });
  if (c.kind === 'hls' && !v.canPlayType('application/vnd.apple.mpegurl') && !window.Hls) {
    try { await loadScript(HLS_JS); } catch (e) { toast(e.message, 'error', 6000); return false; }
  }
  if (!quiet) toast('Collegamento al video…', 'info', 3000);
  let pixels = true;
  let ok = await tryLoad(true);
  if (!ok) { pixels = false; ok = await tryLoad(false); }
  if (!ok) {
    const hint = c.provider === 'drive' ? ' Google Drive non sempre permette lo streaming dei file grandi: prova Dropbox o un link diretto al file.' : ' Verifica che il link punti direttamente al file video e sia pubblico.';
    toast('Impossibile riprodurre il video dal link.' + hint, 'error', 9000);
    return false;
  }
  app.videoInfo = { kind: c.kind, pixels: pixels && c.kind !== 'hls' };
  remember(c.kind === 'direct' && c.original ? c.original : c.url);
  renderActive();
  if (!quiet) toast(pixels ? 'Video in streaming dal link (non scaricato).' : 'Video in streaming. Il server non consente la lettura dei fotogrammi (CORS): analisi automatica non disponibile, scouting a clic sì.', pixels ? 'ok' : 'warn', 7000);
  if (!quiet && c.temporary) toast(`Link temporaneo${c.expires ? ` (valido fino al ${new Date(c.expires).toLocaleString()})` : ''}: per riaprire la partita più avanti usa di nuovo il collegamento rapido dalla pagina del video, oppure scarica il video.`, 'info', 9000);
  return true;
};

// ---------- VolleyMetrics / Hudl ----------
// La pagina della partita su VolleyMetrics non è il video: il video è protetto dall'accesso
// all'account. Il collegamento rapido (preferito del browser) prende l'indirizzo del video dalla
// pagina aperta e lo passa a VolleyScout; in alternativa si scaricano video e DVW.
app.openVolleyMetricsHelp = (c) => {
  const appUrl = location.origin + location.pathname;
  const href = bookmarkletHref(appUrl);
  const bm = h('a', { class: 'btn primary bookmarklet', href, draggable: 'true', title: 'Trascinami nella barra dei preferiti', onclick: (e) => { e.preventDefault(); toast('Trascina il pulsante nella barra dei preferiti del browser (non cliccarlo qui)', 'info', 5000); } }, '🏐 Apri in VolleyScout');
  const copy = h('button', { class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(decodeURIComponent(href)); toast('Codice copiato: crea un nuovo preferito e incollalo come indirizzo', 'ok', 6000); } catch { toast('Copia non riuscita', 'error'); } } }, '📋 Copia il codice (tablet / Safari)');
  const inp = h('input', { type: 'url', class: 'grow', placeholder: 'https://…/video.mp4 oppure …/master.m3u8' });
  const dlg = modal('Video da VolleyMetrics / Hudl', h('div', { class: 'col gap' },
    c ? h('p', { class: 'warn-box' }, 'Il link incollato è la pagina della partita su ', h('b', {}, c.host), ', non il file video: il video è protetto dall\'accesso al tuo account e VolleyScout non può aprirlo da solo. Usa uno di questi modi:') : null,
    h('h4', {}, '1 · Collegamento rapido (consigliato)'),
    h('ol', { class: 'small link-help' },
      h('li', {}, 'Trascina questo pulsante nella barra dei preferiti: ', bm, ' ', copy),
      h('li', {}, 'Apri la partita su VolleyMetrics (o Hudl) con il tuo account e avvia il video.'),
      h('li', {}, 'Clicca il preferito ', h('b', {}, '🏐 Apri in VolleyScout'), ': si apre VolleyScout con quel video in streaming (scegli se in una nuova partita o in quella aperta, ad esempio dopo aver aperto il DVW).')),
    h('p', { class: 'muted small' }, 'Il collegamento legge solo l\'indirizzo del video che la pagina sta già riproducendo (niente password né cookie). Questi indirizzi sono di solito temporanei (alcune ore) e personali: non condividerli. Se il video è protetto (DRM) o il sito non permette ad altri di leggerlo, non si potrà riprodurre: usa il modo 2.'),
    h('h4', {}, '2 · Video e scout scaricati'),
    h('p', { class: 'small' }, 'Se il tuo account permette di scaricare la partita: apri il file ', h('b', {}, '.dvw'), ' con ', h('b', {}, 'Apri'), ' (codici, formazioni e tempi del video) e poi il ', h('b', {}, 'video MP4'), ' come file: Video analisi e report sono subito utilizzabili, e anche l\'analisi automatica.'),
    h('div', { class: 'row gap wrap' }, h('button', { class: 'btn', onclick: () => { dlg.close(); $('#btn-open')?.click(); } }, '📂 Apri DVW'), h('button', { class: 'btn', onclick: () => { dlg.close(); app.openVideo(); } }, '🎬 Apri video MP4')),
    h('h4', {}, '3 · Indirizzo diretto del video'),
    h('div', { class: 'row gap' }, inp, h('button', { class: 'btn', onclick: async () => { const u = inp.value.trim(); if (!u) return; dlg.close(); await app.openVideoUrl(u); } }, 'Apri')),
  ), { wide: true });
};

// VolleyScout aperto dal collegamento rapido: #video=…&titolo=…&da=…
// (dopo il #: l'indirizzo non arriva al server che ospita l'app)
async function openFromHash() {
  const hp = new URLSearchParams(location.hash.slice(1));
  const url = hp.get('video');
  if (!url) return;
  history.replaceState(null, '', location.pathname + location.search);
  const title = (hp.get('titolo') || '').slice(0, 120), from = hp.get('da') || '';
  const cur = app.match;
  const empty = !cur.events.length && !cur.video.url && !cur.video.name;
  let target = 'new';
  if (!empty) {
    target = await new Promise((res) => {
      modal('Video da ' + (from || 'link'), h('div', {}, h('p', {}, h('b', {}, title || 'Video'), ` (${from})`), h('p', {}, `Aprirlo in una nuova partita o nella partita aperta (${cur.teams['*'].name} – ${cur.teams.a.name}, ${cur.events.filter((e) => e.kind === 'skill').length} codici)?`), h('p', { class: 'muted small' }, 'Se hai appena aperto il DVW della stessa partita scegli "Nella partita aperta": i codici si collegano al video con i loro tempi.')), {
        actions: [{ label: 'Nella partita aperta', onClick: () => { res('current'); return true; } }, { label: 'Nuova partita', primary: true, onClick: () => { res('new'); return true; } }],
        onClose: () => res(null),
      });
    });
    if (!target) return;
  }
  if (target === 'new') {
    const m = newMatch();
    const tt = teamsFromTitle(title);
    if (tt) { m.teams['*'].name = tt[0].slice(0, 40); m.teams.a.name = tt[1].slice(0, 40); }
    app.setMatch(m);
  }
  const ok = await app.openVideoUrl(url);
  if (ok && title) { app.match.video.name = title; app.save(); }
  if (ok) app.showTab(target === 'new' ? 'setup' : 'playlist');
}
// MEGA: il service worker scarica e decifra solo i tratti richiesti dal lettore
async function swReady() {
  if (!('serviceWorker' in navigator) || window.VSP_NO_SW || !location.protocol.startsWith('http')) return false;
  if (navigator.serviceWorker.controller) return true;
  await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 5000))]);
  if (!navigator.serviceWorker.controller) await new Promise((r) => { navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }); setTimeout(r, 3000); });
  return !!navigator.serviceWorker.controller;
}
async function openMega(link, resumeAt = null, retried = false) {
  if (!(await swReady())) { toast('I video MEGA richiedono l\'app aperta da un indirizzo http(s) con il service worker attivo (non disponibile in questa anteprima). Ricarica la pagina e riprova.', 'error', 9000); return false; }
  let r;
  try { r = await resolveMega(link, { api: window.VSP_MEGA_API }); } catch (e) { toast(e.message, 'error', 8000); return false; }
  const v = app.video;
  v.removeAttribute('crossorigin');
  const loaded = new Promise((res) => {
    const ok = () => { off(); res(true); }, ko = () => { off(); res(false); };
    const off = () => { v.removeEventListener('loadedmetadata', ok); v.removeEventListener('error', ko); };
    v.addEventListener('loadedmetadata', ok); v.addEventListener('error', ko);
  });
  v.src = megaStreamUrl(r);
  if (!(await loaded) && !retried) return openMega(link, resumeAt, true); // indirizzo appena scaduto: un nuovo tentativo
  if (v.error || v.readyState === 0) { toast('MEGA: il video non si riproduce (formato non supportato dal browser o limite di traffico).', 'error', 8000); return false; }
  if (resumeAt != null) v.currentTime = resumeAt;
  app.videoInfo = { kind: 'mega', pixels: true, link };
  return r;
}
// l'indirizzo di download MEGA scade dopo alcune ore: in caso di errore si rinnova
app.video.addEventListener('error', async () => {
  const vi = app.videoInfo;
  if (vi?.kind !== 'mega' || vi.renewing) return;
  vi.renewing = true;
  const t = app.video.currentTime;
  if (await openMega(vi.link, t)) toast('Collegamento MEGA rinnovato', 'info');
});
app.openVideoLink = () => {
  const inp = h('input', { type: 'url', class: 'grow', placeholder: 'https://… (YouTube, MEGA, Google Drive, Dropbox, VolleyMetrics, MP4, .m3u8)', value: /^https?:/.test(app.match.video.url || '') ? app.match.video.url : '' });
  const go = async () => { const u = inp.value; dlg.close(); await app.openVideoUrl(u); };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  const dlg = modal('Video da link', h('div', { class: 'col gap' },
    window.VSP_NO_SW ? h('p', { class: 'warn-box' }, '⚠ Questa è l\'anteprima su claude.ai: qui il browser blocca YouTube, MEGA e i video di altri siti. I link funzionano nell\'app vera: ', h('a', { href: 'https://ringhiosaverio-code.github.io/scouting/', target: '_blank', rel: 'noopener' }, 'ringhiosaverio-code.github.io/scouting'), ' (dopo aver attivato GitHub Pages) oppure avviata sul PC con npm start.') : null,
    h('label', { class: 'field' }, h('span', {}, 'Link del video'), inp),
    h('p', { class: 'muted small' }, 'Il video non viene scaricato né caricato: il browser lo riproduce in streaming dal link. Il link viene salvato con la partita.'),
    h('ul', { class: 'small link-help' },
      h('li', {}, h('b', {}, 'YouTube'), ' — scouting a clic, playlist e tempi dei tocchi. Analisi e calibrazione automatiche non disponibili (YouTube non permette di leggere i fotogrammi): calibra a mano.'),
      h('li', {}, h('b', {}, 'Link diretto'), ' a un file MP4/WebM/MOV, ', h('b', {}, 'Dropbox'), ' o ', h('b', {}, 'Google Drive'), ' (condiviso "chiunque abbia il link") — tutto, compresa l\'analisi automatica se il server lo consente.'),
      h('li', {}, h('b', {}, 'MEGA'), ' (link del singolo file, con la chiave dopo #) — tutto, compresa l\'analisi automatica: il video viene decifrato a pezzi mentre lo guardi.'),
      h('li', {}, h('b', {}, 'Flussi HLS'), ' (.m3u8) — scouting a clic.'),
      h('li', {}, h('b', {}, 'VolleyMetrics / Hudl'), ' — il link della pagina è protetto dal tuo account: usa il ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); dlg.close(); app.openVolleyMetricsHelp(null); } }, 'collegamento rapido 🏐'), ' o scarica video e DVW.'))),
  { actions: [{ label: 'Annulla' }, { label: 'Apri link', primary: true, onClick: () => { go(); return false; } }] });
};
function loadVideoFile(file) {
  resetVideo();
  app.videoInfo = { kind: 'file', pixels: true };
  app.videoFile = file; // per l'analisi veloce (lettura diretta del file)
  const url = URL.createObjectURL(file);
  app.video.dataset.objurl = url;
  app.video.src = url;
  app.match.video.url = '';
  app.match.settings.clickSurface = 'video';
  if (app.match.video.name && app.match.video.name !== file.name) toast(`Video diverso da quello della partita (${app.match.video.name})`, 'warn', 4000);
  app.match.video.name = file.name;
  app.save();
  app.video.addEventListener('loadedmetadata', () => renderActive(), { once: true });
  toast(`Video: ${file.name}`);
}
async function offerVideoReopen() {
  const box = $('#video-reopen');
  clear(box);
  const v = app.match.video;
  if (!v.name || app.video.currentSrc) return;
  if (/^https?:/.test(v.url || '')) {
    if (v.expires && v.expires !== 'temp' && new Date(v.expires) < new Date()) {
      box.append(h('button', { class: 'btn small', title: 'Il link temporaneo del video è scaduto', onclick: () => app.openVolleyMetricsHelp(null) }, '🏐 Link scaduto: riapri il video'));
      return;
    }
    app.openVideoUrl(v.url, { quiet: true });
    return;
  }
  if (v.url && !/^blob:/.test(v.url)) { app.video.src = v.url; app.videoInfo = { kind: 'file', pixels: true }; return; }
  const fh = await getHandle('video:' + app.match.id);
  box.append(h('button', {
    class: 'btn small primary', onclick: async () => {
      if (fh && (await fh.requestPermission?.({ mode: 'read' })) === 'granted') { loadVideoFile(await fh.getFile()); clear(box); }
      else app.openVideo();
    },
  }, `🎬 Riapri ${v.name.length > 28 ? v.name.slice(0, 26) + '…' : v.name}`));
}

// ---------- file ----------
const safeName = () => `${app.match.meta.date || ''}_${app.match.teams['*'].code || 'CAS'}-${app.match.teams.a.code || 'OSP'}`.replace(/[^\w.-]+/g, '_');
function exportCSV() {
  const rows = app.rp.rows.filter((r) => r.e.kind === 'skill');
  const head = ['riga', 'set', 'rally', 'punteggio_casa', 'punteggio_ospiti', 'squadra', 'squadra_nome', 'numero', 'giocatore', 'fondamentale', 'tipo', 'valutazione', 'combinazione', 'target', 'zona_inizio', 'zona_fine', 'sottozona', 'sottotipo', 'n_muri', 'speciale', 'fase_punto', 'fase_attacco', 'serve', 'pal_casa', 'pal_ospiti', 'x_inizio', 'y_inizio', 'x_fine', 'y_fine', 'tempo_video', 'ora', 'codice'];
  const q = (v) => (v == null ? '' : /[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [head.join(';')];
  for (const r of rows) {
    const e = r.e;
    const p = app.lookup(e.team, e.num);
    lines.push([r.i + 1, r.set, r.rally, r.score['*'], r.score.a, e.team, app.match.teams[e.team].name, e.num, p ? `${p.lastName} ${p.firstName}`.trim() : '', SKILLS[e.skill], e.type, e.ev, e.combo, e.target, e.sz, e.ez, e.esz, e.stype, e.nb, e.special, r.phase, r.aphase, r.serving, r.setterPos['*'], r.setterPos.a,
      e.start?.x, e.start?.y, e.end?.x, e.end?.y, e.vt != null ? e.vt.toFixed(2) : '', clockFor(app.match, e), skillCode(e)].map(q).join(';'));
  }
  download(safeName() + '.csv', '﻿' + lines.join('\r\n'), 'text/csv');
}

async function openFile() {
  const saved = listMatches();
  const inp = h('input', { type: 'file', accept: '.dvw,.vsj,.json' });
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    const txt = decodeBytes(await f.arrayBuffer());
    try {
      const m = /\.dvw$/i.test(f.name) ? fromDVW(txt) : JSON.parse(txt);
      if (!m.events || !m.teams) throw new Error('formato non riconosciuto');
      if (/\.dvw$/i.test(f.name)) m.id = uid();
      app.setMatch(m);
      dlg.close();
      toast(`Aperto ${f.name}`, 'ok');
      const withVt = m.events.filter((e) => e.kind === 'skill' && e.vt != null).length;
      if (/\.dvw$/i.test(f.name) && withVt) toast(`${m.meta.source === 'volleymetrics' ? 'Scout VolleyMetrics: ' : ''}${withVt} codici con il tempo del video. Apri il video della partita (file, link o collegamento rapido 🏐) per la Video analisi.`, 'info', 9000);
    } catch (e) { toast('Errore apertura: ' + e.message, 'error', 5000); }
  };
  const list = h('div', { class: 'saved-list' }, saved.length ? saved.map((s) => h('div', { class: 'saved-item' },
    h('button', { class: 'btn link', onclick: () => { const m = loadMatch(s.id); if (m) { app.setMatch(m); dlg.close(); } } }, h('b', {}, s.title), h('span', { class: 'muted' }, ` ${s.date || ''} · salvata ${new Date(s.saved).toLocaleString()}`)),
    h('button', { class: 'icon-btn danger', title: 'Elimina', onclick: async () => { if (await confirmDialog('Elimina partita', `Eliminare "${s.title}" dal browser?`, 'Elimina')) { deleteMatch(s.id); dlg.close(); openFile(); } } }, '🗑'))) : h('p', { class: 'muted' }, 'Nessuna partita salvata nel browser.'));
  const dlg = modal('Apri partita', h('div', {},
    h('div', { class: 'row gap wrap' },
      h('button', { class: 'btn primary', onclick: () => inp.click() }, '📂 Da file (.dvw / .vsj)'),
      h('button', { class: 'btn', onclick: async () => { const r = await fetch('samples/esempio.dvw'); const m = fromDVW(decodeBytes(await r.arrayBuffer())); m.id = uid(); app.setMatch(m); dlg.close(); app.showTab('report'); } }, '🧪 Partita di esempio')),
    h('h3', {}, 'Salvate nel browser'), list), { wide: true });
}

async function newMatchFlow() {
  if (app.match.events.length && !(await confirmDialog('Nuova partita', 'La partita corrente resta salvata nel browser (Apri per ritrovarla). Iniziare una nuova partita?', 'Nuova'))) return;
  const m = newMatch();
  m.settings = structuredClone(app.match.settings);
  app.setMatch(m);
  resetVideo();
  app.showTab('setup');
}

function demoTeams() {
  const m = newMatch();
  const mk = (names) => names.map(([n, ln, fn, r]) => newPlayer({ number: n, lastName: ln, firstName: fn, role: r }));
  m.teams['*'] = { ...m.teams['*'], name: 'Volley Aquile', code: 'AQU', colour: '#1f6feb', coach: 'Bianchi',
    players: mk([[1, 'Rossi', 'Marco', 'S'], [4, 'Verdi', 'Luca', 'H'], [7, 'Neri', 'Paolo', 'M'], [9, 'Gialli', 'Andrea', 'O'], [11, 'Blu', 'Simone', 'H'], [14, 'Viola', 'Matteo', 'M'], [2, 'Bruno', 'Davide', 'L'], [5, 'Costa', 'Pietro', 'H'], [12, 'Galli', 'Enrico', 'S']]) };
  m.teams.a = { ...m.teams.a, name: 'Pallavolo Falchi', code: 'FAL', colour: '#d1242f', coach: 'Ferri',
    players: mk([[3, 'Ricci', 'Giorgio', 'S'], [6, 'Marino', 'Fabio', 'H'], [8, 'Greco', 'Nicola', 'M'], [10, 'Conti', 'Stefano', 'O'], [13, 'Lombardi', 'Alessio', 'H'], [15, 'Moretti', 'Dario', 'M'], [1, 'Fontana', 'Ivan', 'L'], [17, 'Rinaldi', 'Elia', 'H']]) };
  m.events.push({ kind: 'lineup', id: uid(), set: 1, h: [1, 4, 7, 9, 11, 14], v: [3, 6, 8, 10, 13, 15], hSetter: 1, vSetter: 3, serve: '*', homeNear: true, hLib: [2], vLib: [1] });
  m.settings.clickSurface = 'court';
  return m;
}

// ---------- tastiera globale ----------
document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); download(safeName() + '.vsj', JSON.stringify(app.match), 'application/json'); return; }
  if (ev.key === 'F1') { ev.preventDefault(); app.showTab('settings'); return; }
  const mod = modules[app.tab];
  if (mod?.onKey) mod.onKey(ev);
});

// ---------- avvio ----------
function init() {
  const tabs = [['setup', 'Partita'], ['scout', 'Scouting'], ['report', 'Report'], ['auto', 'Analisi auto'], ['playlist', 'Video analisi'], ['settings', 'Impostazioni']];
  const nav = $('.tabs');
  for (const [k, l] of tabs) nav.append(h('button', { role: 'tab', 'data-tab': k, 'aria-selected': 'false', onclick: () => app.showTab(k) }, l));
  $('#btn-new').onclick = newMatchFlow;
  $('#btn-open').onclick = openFile;
  $('#btn-save').onclick = () => download(safeName() + '.vsj', JSON.stringify(app.match), 'application/json');
  $('#btn-dvw').onclick = () => { download(safeName() + '.dvw', toDVW(app.match, app.rp), 'text/plain;charset=utf-8'); toast('File DVW esportato', 'ok'); };
  $('#btn-csv').onclick = exportCSV;
  $('#btn-undo').onclick = () => { modules.scout.clearPending(); app.undo(); };
  $('#btn-redo').onclick = () => app.redo();
  $('#btn-demo').onclick = async () => {
    if (app.match.events.length && !(await confirmDialog('Squadre demo', 'Creare una nuova partita con squadre dimostrative?', 'Crea'))) return;
    app.setMatch(demoTeams()); app.showTab('scout');
  };
  $('#issues-badge').onclick = () => { app.showTab('report'); modules.report.showIssues(); };

  const id = lastMatchId();
  const m = (id && loadMatch(id)) || newMatch();
  app.match = m;
  mountModules();
  app.setMatch(m);
  app.showTab(m.events.length ? 'scout' : 'setup');
  // partita preparata (?partita=file.vsj oppure window.VSP_PRELOAD): caricata se non è già salvata nel browser
  const pre = new URLSearchParams(location.search).get('partita') || window.VSP_PRELOAD;
  if (pre) {
    fetch(pre).then((r) => r.json()).then((pm) => {
      const saved = loadMatch(pm.id);
      app.setMatch(saved || pm);
      app.showTab(window.VSP_PRELOAD_TAB || 'scout');
    }).catch(() => toast('Impossibile caricare la partita preparata', 'error'));
  }

  openFromHash();
  window.addEventListener('hashchange', openFromHash);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !window.VSP_NO_SW) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
