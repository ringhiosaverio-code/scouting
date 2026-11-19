// Cronaca in diretta durante l'analisi automatica: mentre i fotogrammi arrivano dai worker,
// gli scambi completati vengono riconosciuti subito e scritti con i codici di scouting, il
// punteggio e un piccolo report (battuta, ricezione, attacco, muro). I tratti della partita
// analizzati in parallelo producono scambi in ordine sparso: la cronaca li ordina per tempo.
import { h, clear, fmtTime } from './dom.js';
import { ralliesFromFrames } from '../vision/analyzer.js';
import { interpretRally } from '../vision/rally.js';
import { skillCode } from '../lib/codes.js';

const MARGIN = 2.5; // s: uno scambio è "completo" se finisce almeno così prima dell'ultimo fotogramma

export function createLiveFeed({ app, geo, ctx, el }) {
  const segs = new Map();
  const entries = [];
  let dirty = false, timer = null, finished = false;

  function seg(i) {
    if (!segs.has(i)) segs.set(i, { frames: [], cut: -Infinity, lastProc: -Infinity, serving: null });
    return segs.get(i);
  }
  function finalize(sg, r, i) {
    if (entries.some((e) => Math.abs(e.start - r.start) < 0.5)) return;
    const c = ctx();
    const out = interpretRally(r, { ...c, serving: sg.serving ?? c.serving });
    sg.serving = out.winner || sg.serving;
    entries.push({ start: r.start, end: r.end, seg: i, events: out.events, notes: out.notes, winner: out.winner, conf: out.conf, codes: out.events.map((e) => (e.kind === 'skill' ? skillCode(e) : `${e.team}p`)).join(' ') });
    entries.sort((a, b) => a.start - b.start);
    dirty = true;
  }
  function process(i, final = false) {
    const sg = seg(i);
    const fr = sg.frames;
    if (fr.length < 30) return;
    const tNow = fr[fr.length - 1].t;
    sg.lastProc = tNow;
    let rs;
    try { rs = ralliesFromFrames(fr, geo); } catch { return; }
    let cut = sg.cut;
    for (const r of rs) {
      if (r.start < sg.cut - 0.2) continue;
      if (!final && r.end > tNow - MARGIN) break; // ancora in corso
      finalize(sg, r, i);
      cut = Math.max(cut, r.end + 0.4);
    }
    // finestra scorrevole: si tengono solo i fotogrammi dopo l'ultimo scambio chiuso
    if (cut === sg.cut && tNow - (fr[0]?.t ?? tNow) > 40) cut = tNow - 15;
    if (cut > sg.cut) { sg.cut = cut; sg.frames = fr.filter((f) => f.t >= cut - 0.3); }
  }
  function push(i, frames) {
    const sg = seg(i);
    sg.frames.push(...frames);
    const t = frames.length ? frames[frames.length - 1].t : 0;
    if (t - sg.lastProc > 2) process(i);
    if (dirty && !timer) timer = setTimeout(() => { timer = null; render(); }, 250);
  }
  function finish() {
    for (const i of segs.keys()) process(i, true);
    finished = true;
    render();
  }

  // ---- report ----
  function stats() {
    const T = { '*': {}, a: {} };
    const inc = (t, k) => { T[t][k] = (T[t][k] || 0) + 1; };
    const score = { '*': 0, a: 0 };
    for (const e of entries) {
      if (e.winner) score[e.winner]++;
      for (const ev of e.events) {
        if (ev.kind !== 'skill') continue;
        inc(ev.team, ev.skill);
        inc(ev.team, ev.skill + ev.ev);
      }
    }
    return { T, score };
  }
  const SK = { S: 'Battuta', R: 'Ricezione', E: 'Alzata', A: 'Attacco', B: 'Muro', D: 'Difesa', F: 'Free ball' };
  const readable = (e) => e.events.filter((ev) => ev.kind === 'skill').map((ev) => `${app.match.teams[ev.team].code || (ev.team === '*' ? 'C' : 'O')}${ev.num != null ? ' #' + ev.num : ''} ${SK[ev.skill] || ev.skill} ${ev.ev}`).join(' · ');
  function render() {
    dirty = false;
    clear(el);
    const { T, score } = stats();
    const tn = (t) => app.match.teams[t].name;
    const pct = (a, b) => (b ? `${Math.round(100 * a / b)}%` : '–');
    const row = (label, f) => h('tr', {}, h('td', {}, label), h('td', { class: 'num' }, f('*')), h('td', { class: 'num' }, f('a')));
    const g = (t, k) => T[t][k] || 0;
    el.append(
      h('h3', {}, finished ? '📝 Cronaca dell\'analisi' : '📝 Cronaca in diretta'),
      h('div', { class: 'live-score' }, h('span', {}, tn('*')), h('b', { class: 'mono' }, ` ${score['*']} – ${score.a} `), h('span', {}, tn('a'))),
      h('p', { class: 'muted small' }, finished ? `${entries.length} scambi. L'elenco qui sotto ha le proposte da rivedere e accettare.` : `${entries.length} scambi riconosciuti finora · gli scambi compaiono appena finiscono${segs.size > 1 ? ` (${segs.size} tratti analizzati in parallelo)` : ''}`),
      h('table', { class: 'live-stats' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, app.match.teams['*'].code || 'Casa'), h('th', {}, app.match.teams.a.code || 'Osp.'))),
        h('tbody', {},
          row('Battute (ace / errori)', (t) => `${g(t, 'S')} (${g(t, 'S#')}/${g(t, 'S=')})`),
          row('Ricezione positiva', (t) => `${pct(g(t, 'R#') + g(t, 'R+'), g(t, 'R'))} di ${g(t, 'R')}`),
          row('Attacchi (punti / errori)', (t) => `${g(t, 'A')} (${g(t, 'A#')}/${g(t, 'A=') + g(t, 'A/')})`),
          row('Muri punto', (t) => g(t, 'B#')),
          row('Difese', (t) => g(t, 'D')))),
      h('ol', { class: 'live-list', reversed: true }, [...entries].reverse().slice(0, 60).map((e) => h('li', { class: e.notes.length ? 'warn-row' : '' },
        h('span', { class: 'mono' }, fmtTime(e.start)), ' ',
        h('span', { title: e.codes }, readable(e)), ' ',
        e.winner ? h('b', {}, `→ ${tn(e.winner)}`) : h('span', { class: 'muted' }, '→ ?'),
        e.notes.length ? h('span', { class: 'muted small', title: e.notes.join('\n') }, ' ⚠') : null))));
    el.querySelector('.live-list')?.scrollTo?.(0, 0);
  }
  render();
  return { push, finish, entries };
}
