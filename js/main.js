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
import { SKILLS, DEFAULT_SETTINGS } from './lib/constants.js';

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
        h('label', { class: 'field' }, h('span', {}, 'Lato vicino alla telecamera'), h('select', { onchange: (e) => { draft.homeNear = e.target.value === '1'; } },
          h('option', { value: '1', selected: draft.homeNear }, m.teams['*'].name),
          h('option', { value: '0', selected: !draft.homeNear }, m.teams.a.name)))),
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
app.openVideoUrl = (url) => {
  app.video.src = url;
  app.match.video.name = url;
  app.match.video.url = url;
  app.save();
};
function loadVideoFile(file) {
  if (app.video.dataset.objurl) URL.revokeObjectURL(app.video.dataset.objurl);
  const url = URL.createObjectURL(file);
  app.video.dataset.objurl = url;
  app.video.src = url;
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
  if (v.url && /^https?:/.test(v.url)) { app.video.src = v.url; return; }
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
  app.video.removeAttribute('src'); app.video.load();
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

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
