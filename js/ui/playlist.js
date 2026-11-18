// Video analisi: filtri sui tocchi e riproduzione automatica delle clip.
import { h, clear, toast, fmtTime } from './dom.js';
import { describe, skillCode } from '../lib/codes.js';
import { SKILLS, EVALS, EVAL_TEXT } from '../lib/constants.js';
import { download } from '../lib/store.js';

export function createPlaylist(app) {
  const root = h('div', { class: 'playlist-grid' });
  const videoBox = h('div', { class: 'video-wrap pl-video' });
  const nowPlaying = h('div', { class: 'now-playing muted' }, 'Nessuna clip in riproduzione');
  const filtersBox = h('div', { class: 'card pl-filters' });
  const listBox = h('div', { class: 'pl-list' });
  root.append(h('div', { class: 'left-col' }, videoBox, nowPlaying, h('div', { class: 'pl-controls row gap' },
    h('button', { class: 'btn', onclick: () => step(-1) }, '⏮ Prec.'),
    h('button', { class: 'btn primary', onclick: () => playAll() }, '▶ Riproduci tutte'),
    h('button', { class: 'btn', onclick: () => stop() }, '⏹ Stop'),
    h('button', { class: 'btn', onclick: () => step(1) }, 'Succ. ⏭'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn', onclick: () => exportList() }, '⬇ Esporta elenco'))),
  h('div', { class: 'right-col' }, filtersBox, listBox));

  const f = { team: '', num: '', skill: 'A', evals: [], set: '', phase: '', combo: '', sz: '', ez: '' };
  let clips = [];
  let playing = -1;
  let endAt = null;
  const video = app.video;

  video.addEventListener('timeupdate', () => {
    if (playing < 0 || endAt == null || app.tab !== 'playlist') return;
    if (video.currentTime >= endAt) {
      if (playing + 1 < clips.length) playClip(playing + 1);
      else stop();
    }
  });

  function filtered() {
    return app.rp.rows.filter((r) => {
      const e = r.e;
      if (e.kind !== 'skill' || e.vt == null) return false;
      if (f.team && e.team !== f.team) return false;
      if (f.num !== '' && Number(e.num) !== Number(f.num)) return false;
      if (f.skill && e.skill !== f.skill) return false;
      if (f.evals.length && !f.evals.includes(e.ev)) return false;
      if (f.set && r.set !== Number(f.set)) return false;
      if (f.phase === 'r' && r.aphase !== 'r') return false;
      if (f.phase === 't' && !(r.aphase === 's' || r.aphase === 'p')) return false;
      if (f.phase === 'so' && r.serving === e.team) return false;
      if (f.phase === 'bp' && r.serving !== e.team) return false;
      if (f.combo && e.combo !== f.combo) return false;
      if (f.sz && Number(e.sz) !== Number(f.sz)) return false;
      if (f.ez && Number(e.ez) !== Number(f.ez)) return false;
      return true;
    });
  }

  function playClip(i) {
    if (!video.currentSrc) { toast('Nessun video caricato', 'warn'); return; }
    playing = i;
    const r = clips[i];
    const st = app.match.settings;
    video.currentTime = Math.max(0, r.e.vt - (st.clipPre ?? 4));
    endAt = r.e.vt + (st.clipPost ?? 4);
    video.play();
    clear(nowPlaying).append(h('b', {}, `${i + 1}/${clips.length} `), describe(r.e, app.lookup), h('span', { class: 'muted' }, `  · set ${r.set} ${r.score['*']}-${r.score.a}`));
    renderList();
  }
  function playAll() { if (clips.length) playClip(0); }
  function stop() { playing = -1; endAt = null; video.pause(); renderList(); }
  function step(d) { if (!clips.length) return; playClip(Math.max(0, Math.min(clips.length - 1, (playing < 0 ? 0 : playing + d)))); }
  function exportList() {
    const lines = ['n;set;punteggio;squadra;numero;codice;descrizione;inizio;fine'];
    const st = app.match.settings;
    clips.forEach((r, i) => lines.push([i + 1, r.set, `${r.score['*']}-${r.score.a}`, app.match.teams[r.e.team].name, r.e.num, skillCode(r.e), `"${describe(r.e, app.lookup).replace(/"/g, '""')}"`, Math.max(0, r.e.vt - st.clipPre).toFixed(1), (r.e.vt + st.clipPost).toFixed(1)].join(';')));
    download('playlist.csv', '﻿' + lines.join('\r\n'), 'text/csv');
  }

  function renderFilters() {
    clear(filtersBox);
    const m = app.match;
    const sel = (label, key, opts) => h('label', { class: 'field' }, h('span', {}, label), h('select', { onchange: (e) => { f[key] = e.target.value; if (key === 'team') f.num = ''; render(); } },
      opts.map(([v, l]) => h('option', { value: v, selected: String(f[key]) === String(v) }, l))));
    const players = f.team ? m.teams[f.team].players : [...m.teams['*'].players, ...m.teams.a.players];
    const combos = [...new Set(app.rp.rows.filter((r) => r.e.combo && r.e.skill === (f.skill || r.e.skill)).map((r) => r.e.combo))].sort();
    filtersBox.append(
      h('h3', {}, 'Filtri'),
      h('div', { class: 'grid2' },
        sel('Squadra', 'team', [['', 'Entrambe'], ['*', m.teams['*'].name], ['a', m.teams.a.name]]),
        sel('Giocatore', 'num', [['', 'Tutti'], ...players.slice().sort((a, b) => a.number - b.number).map((p) => [p.number, `${p.number} ${p.lastName}`])]),
        sel('Fondamentale', 'skill', [['', 'Tutti'], ...Object.entries(SKILLS)]),
        sel('Set', 'set', [['', 'Tutti'], ...app.rp.sets.map((s) => [s.set, `${s.set}°`])]),
        sel('Fase', 'phase', [['', 'Tutte'], ['so', 'Cambio palla (side-out)'], ['bp', 'Break-point'], ['r', 'Attacco da ricezione'], ['t', 'Attacco in transizione']]),
        sel('Combinazione', 'combo', [['', 'Tutte'], ...combos.map((c) => [c, c])]),
        sel('Zona inizio', 'sz', [['', 'Tutte'], ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((z) => [z, z])]),
        sel('Zona fine', 'ez', [['', 'Tutte'], ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((z) => [z, z])])),
      h('div', { class: 'chips' }, EVALS.map((ev) => h('button', {
        class: `chip small ${f.evals.includes(ev) ? 'sel' : ''}`, title: f.skill ? EVAL_TEXT[f.skill][ev] : '',
        onclick: () => { f.evals = f.evals.includes(ev) ? f.evals.filter((x) => x !== ev) : [...f.evals, ev]; render(); },
      }, ev, f.skill ? h('span', {}, ' ' + EVAL_TEXT[f.skill][ev]) : null))),
      h('div', { class: 'row gap' },
        h('label', { class: 'field inline' }, h('span', {}, 'Prima (s)'), h('input', { type: 'number', min: 0, step: 0.5, value: app.match.settings.clipPre, onchange: (e) => { app.match.settings.clipPre = +e.target.value; app.save(); } })),
        h('label', { class: 'field inline' }, h('span', {}, 'Dopo (s)'), h('input', { type: 'number', min: 0, step: 0.5, value: app.match.settings.clipPost, onchange: (e) => { app.match.settings.clipPost = +e.target.value; app.save(); } }))));
  }

  function renderList() {
    clear(listBox);
    const noVt = app.rp.rows.filter((r) => r.e.kind === 'skill' && r.e.vt == null).length;
    listBox.append(h('div', { class: 'muted' }, `${clips.length} clip`, noVt ? ` · ${noVt} tocchi senza tempo video esclusi` : ''));
    listBox.append(h('ol', { class: 'clips' }, clips.map((r, i) => h('li', { class: i === playing ? 'playing' : '', onclick: () => playClip(i) },
      h('span', { class: 'mono' }, fmtTime(r.e.vt)), ' ',
      h('span', { class: 'team-dot', style: { background: app.match.teams[r.e.team].colour } }), ' ',
      describe(r.e, app.lookup), h('span', { class: 'muted' }, ` · ${r.set}° ${r.score['*']}-${r.score.a}`)))));
    listBox.querySelector('.playing')?.scrollIntoView({ block: 'nearest' });
  }

  function render() {
    clips = filtered();
    if (playing >= clips.length) playing = -1;
    renderFilters();
    renderList();
    if (!video.currentSrc && !videoBox.querySelector('.video-empty')) videoBox.append(h('div', { class: 'video-empty' }, h('p', {}, 'Carica il video della partita per vedere le clip.'), h('div', { class: 'row gap wrap' }, h('button', { class: 'btn primary', onclick: () => app.openVideo() }, '📂 File dal PC'), h('button', { class: 'btn', onclick: () => app.openVideoLink() }, '🔗 Link video'))));
    if (video.currentSrc) videoBox.querySelector('.video-empty')?.remove();
  }

  function onKey(ev) {
    const tag = (ev.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag)) return;
    if (ev.key === ' ') { ev.preventDefault(); if (video.paused) video.play(); else video.pause(); }
    if (ev.key === 'ArrowRight') step(1);
    if (ev.key === 'ArrowLeft') step(-1);
  }

  return {
    el: root, render, onKey,
    attachVideo: () => { videoBox.prepend(video); video.controls = true; },
  };
}
