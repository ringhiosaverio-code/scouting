// Report partita: tabellini, rotazioni, side-out/break-point, distribuzione
// alzatore, mappe direzionali, controllo qualità dei dati. Stampabile.
import { h, clear } from './dom.js';
import { courtSVG, arrow, dot } from './courtsvg.js';
import { computeStats, touchesWithCoords, fmtPct } from '../lib/stats.js';
import { SKILLS, EVAL_TEXT, other } from '../lib/constants.js';
import { flipXY } from '../lib/court.js';

export function createReport(app) {
  const root = h('div', { class: 'report' });
  let setFilter = 0;
  let map = { team: '*', skill: 'A', num: '', evals: [] };
  let issuesOpen = false;

  const effCls = (v) => (v == null ? '' : v >= 0.4 ? 'good' : v <= 0.1 ? 'bad' : '');
  const pctCell = (v, cls = '') => h('td', { class: `num ${cls}` }, fmtPct(v));

  function scoreTable() {
    const sets = app.rp.sets;
    const m = app.match;
    return h('table', { class: 'tbl score-tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Squadra'), h('th', {}, 'Set'), sets.map((s) => h('th', {}, `${s.set}°`)))),
      h('tbody', {}, ['*', 'a'].map((t) => h('tr', {},
        h('td', {}, h('span', { class: 'swatch', style: { background: m.teams[t].colour } }), m.teams[t].name),
        h('td', { class: 'num big' }, app.rp.setsWon[t]),
        sets.map((s) => h('td', { class: `num ${s.winner === t ? 'win' : ''}` }, s.score[t]))))));
  }

  function compareTable(st) {
    const m = app.match;
    const r = (label, f, fmt = (x) => x) => h('tr', {}, h('th', {}, label), ['*', 'a'].map((t) => h('td', { class: 'num' }, fmt(f(t)))));
    const T = st.team, D = st.teamD;
    return h('table', { class: 'tbl compare' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), ['*', 'a'].map((t) => h('th', {}, m.teams[t].name)))),
      h('tbody', {},
        r('Punti fatti (ace+attacco+muro)', (t) => D[t].points),
        r('Punti da errori avversari', (t) => st.oppErrors[t]),
        r('Battute (ace / errori)', (t) => `${T[t].S.n} (${T[t].S['#']} / ${T[t].S['=']})`),
        r('Efficienza battuta', (t) => D[t].serveEff, fmtPct),
        r('Ricezione positiva (#+)', (t) => D[t].recPos, fmtPct),
        r('Ricezione perfetta (#)', (t) => D[t].recPerf, fmtPct),
        r('Attacchi (punti / err / murati)', (t) => `${T[t].A.n} (${T[t].A['#']} / ${T[t].A['=']} / ${T[t].A['/']})`),
        r('% punto attacco', (t) => D[t].atkKill, fmtPct),
        r('Efficienza attacco', (t) => D[t].atkEff, fmtPct),
        r('Attacco dopo ricezione (% punto)', (t) => (st.phaseAtk[t].r.n ? st.phaseAtk[t].r.k / st.phaseAtk[t].r.n : null), fmtPct),
        r('Attacco in transizione (% punto)', (t) => (st.phaseAtk[t].t.n ? st.phaseAtk[t].t.k / st.phaseAtk[t].t.n : null), fmtPct),
        r('Muri punto', (t) => T[t].B['#']),
        r('Side-out', (t) => (st.sideout[t].n ? `${fmtPct(st.sideout[t].w / st.sideout[t].n)} (${st.sideout[t].w}/${st.sideout[t].n})` : '–')),
        r('Break-point', (t) => (st.breakpoint[t].n ? `${fmtPct(st.breakpoint[t].w / st.breakpoint[t].n)} (${st.breakpoint[t].w}/${st.breakpoint[t].n})` : '–')),
        r('Errori totali', (t) => D[t].errors)));
  }

  function playerTable(st, t) {
    const T = app.match.teams[t];
    const rows = st.byPlayer[t].filter((x) => [...'SREABDF'].some((k) => x.line[k].n) || x.line.sets.size);
    const tot = { line: st.team[t], d: st.teamD[t] };
    const line = (label, num, l, d, sets, cls = '') => h('tr', { class: cls },
      h('td', { class: 'num' }, num ?? ''), h('td', {}, label), h('td', { class: 'num' }, sets),
      h('td', { class: 'num strong' }, d.points), h('td', { class: 'num' }, d.errors),
      h('td', { class: 'num' }, l.S.n), h('td', { class: 'num' }, l.S['=']), h('td', { class: 'num' }, l.S['#']), pctCell(d.serveEff),
      h('td', { class: 'num' }, l.R.n), h('td', { class: 'num' }, l.R['=']), pctCell(d.recPos), pctCell(d.recPerf),
      h('td', { class: 'num' }, l.A.n), h('td', { class: 'num' }, l.A['=']), h('td', { class: 'num' }, l.A['/']), h('td', { class: 'num' }, l.A['#']), pctCell(d.atkKill), pctCell(d.atkEff, effCls(d.atkEff)),
      h('td', { class: 'num' }, l.B['#']), h('td', { class: 'num' }, l.D.n), pctCell(d.digPos));
    return h('div', { class: 'card' },
      h('h3', {}, h('span', { class: 'swatch', style: { background: T.colour } }), T.name),
      h('div', { class: 'tbl-scroll' }, h('table', { class: 'tbl players' },
        h('thead', {},
          h('tr', {}, h('th', { colspan: 3 }, ''), h('th', { colspan: 2 }, 'Punti'), h('th', { colspan: 4 }, 'Battuta'), h('th', { colspan: 4 }, 'Ricezione'), h('th', { colspan: 6 }, 'Attacco'), h('th', {}, 'Muro'), h('th', { colspan: 2 }, 'Difesa')),
          h('tr', {}, ['N°', 'Giocatore', 'Set', 'Tot', 'Err', 'Tot', 'Err', 'Ace', 'Eff', 'Tot', 'Err', 'Pos', 'Prf', 'Tot', 'Err', 'Mur', 'Pt', '%Pt', 'Eff', 'Pt', 'Tot', 'Pos'].map((x) => h('th', {}, x)))),
        h('tbody', {}, rows.map((x) => line(x.player ? `${x.player.lastName} ${x.player.firstName?.[0] ? x.player.firstName[0] + '.' : ''}${x.player.role === 'L' ? ' (L)' : ''}` : '?', x.num, x.line, x.d, [...x.line.sets].filter(Boolean).sort().join(','))),
          line('Totale squadra', '', tot.line, tot.d, '', 'total')))));
  }

  function rotationTable(st, t) {
    const R = st.rotations[t];
    const T = app.match.teams[t];
    return h('div', { class: 'card' },
      h('h3', {}, `Rotazioni — ${T.name}`),
      h('p', { class: 'muted' }, 'P = posizione del palleggiatore. Side-out: punti vinti in ricezione; break: punti vinti al servizio.'),
      h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), [1, 6, 5, 4, 3, 2].map((p) => h('th', {}, `P${p}`)))),
        h('tbody', {},
          h('tr', {}, h('th', {}, 'Side-out'), [1, 6, 5, 4, 3, 2].map((p) => { const x = R[p]?.so; return h('td', { class: `num ${effCls(x?.n ? x.w / x.n - 0.2 : null)}` }, x?.n ? `${fmtPct(x.w / x.n)} (${x.w}/${x.n})` : '–'); })),
          h('tr', {}, h('th', {}, 'Break'), [1, 6, 5, 4, 3, 2].map((p) => { const x = R[p]?.bp; return h('td', { class: 'num' }, x?.n ? `${fmtPct(x.w / x.n)} (${x.w}/${x.n})` : '–'); })),
          h('tr', {}, h('th', {}, 'Saldo'), [1, 6, 5, 4, 3, 2].map((p) => { const x = R[p]; if (!x) return h('td', {}, '–'); const won = x.so.w + x.bp.w, lost = x.so.n - x.so.w + x.bp.n - x.bp.w; const d = won - lost; return h('td', { class: `num ${d > 0 ? 'good' : d < 0 ? 'bad' : ''}` }, d > 0 ? `+${d}` : d); })))));
  }

  function receptionAttackTable(st, t) {
    const F = st.firstAtkByRec[t];
    const D = st.distribution[t];
    const zones = [4, 3, 2, 8, 9, 7, 6, 1, 5].filter((z) => Object.values(D).some((d) => d[z]));
    return h('div', { class: 'card' },
      h('h3', {}, `Primo attacco e distribuzione — ${app.match.teams[t].name}`),
      h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Ricezione'), h('th', {}, 'Attacchi'), h('th', {}, '% punto'), h('th', {}, '% errori'))),
        h('tbody', {}, ['#', '+', '!', '-', '/'].map((q) => {
          const x = F[q];
          return h('tr', {}, h('th', {}, `${q} ${EVAL_TEXT.R[q]}`), h('td', { class: 'num' }, x?.n || 0), pctCell(x?.n ? x.k / x.n : null), pctCell(x?.n ? x.e / x.n : null));
        }))),
      zones.length ? h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Rotazione'), zones.map((z) => h('th', {}, `Z${z}`)))),
        h('tbody', {}, [1, 6, 5, 4, 3, 2].filter((p) => D[p]).map((p) => {
          const tot = Object.values(D[p]).reduce((a, b) => a + b, 0);
          return h('tr', {}, h('th', {}, `P${p} (${tot})`), zones.map((z) => h('td', { class: 'num heat', style: { '--h': (D[p][z] || 0) / tot } }, D[p][z] ? fmtPct(D[p][z] / tot) : '')));
        }))) : null);
  }

  function mapCard() {
    const m = app.match;
    const svg = courtSVG({ cls: 'court-svg report-court', zones: true });
    const layer = svg.querySelector('.court-layer');
    const touches = touchesWithCoords(app.rp, { team: map.team, skill: map.skill, num: map.num, set: setFilter || null, evals: map.evals });
    const colourFor = (ev) => ({ '#': 'var(--ok)', '=': 'var(--bad)', '/': 'var(--bad)', '+': 'var(--accent)', '-': 'var(--warn)', '!': 'var(--muted)' }[ev] || 'var(--muted)');
    // normalizza: la squadra selezionata attacca sempre verso l'alto (dal basso)
    const norm = (p) => (map.team === 'a' ? flipXY(p) : p);
    for (const r of touches) {
      const e = r.e;
      const title = `#${e.num} ${SKILLS[e.skill]} ${e.combo || ''} ${e.ev} (set ${r.set}, ${r.score['*']}-${r.score.a})`;
      if (e.start && e.end) arrow(layer, norm(e.start), norm(e.end), { colour: colourFor(e.ev), width: 0.025, title });
      else dot(layer, norm(e.end || e.start), { colour: colourFor(e.ev), r: 0.06, title });
    }
    const players = m.teams[map.team].players.slice().sort((a, b) => a.number - b.number);
    const sel = (label, value, opts, onchange) => h('label', { class: 'field inline' }, h('span', {}, label), h('select', { onchange: (e) => { onchange(e.target.value); render(); } }, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l))));
    return h('div', { class: 'card map-card' },
      h('h3', {}, 'Mappa direzionale'),
      h('div', { class: 'row gap wrap no-print' },
        sel('Squadra', map.team, [['*', m.teams['*'].name], ['a', m.teams.a.name]], (v) => { map.team = v; map.num = ''; }),
        sel('Fondamentale', map.skill, Object.entries(SKILLS), (v) => { map.skill = v; }),
        sel('Giocatore', map.num, [['', 'Tutti'], ...players.map((p) => [p.number, `${p.number} ${p.lastName}`])], (v) => { map.num = v; }),
        h('div', { class: 'chips' }, ['#', '+', '!', '-', '/', '='].map((ev) => h('button', {
          class: `chip small ${map.evals.includes(ev) ? 'sel' : ''}`, title: EVAL_TEXT[map.skill]?.[ev],
          onclick: () => { map.evals = map.evals.includes(ev) ? map.evals.filter((x) => x !== ev) : [...map.evals, ev]; render(); },
        }, ev)))),
      h('div', { class: 'map-wrap' }, svg,
        h('div', { class: 'map-legend' },
          h('p', {}, `${touches.length} tocchi con coordinate`),
          h('p', {}, h('span', { class: 'lg', style: { background: 'var(--ok)' } }), ' # punto/perfetto'),
          h('p', {}, h('span', { class: 'lg', style: { background: 'var(--accent)' } }), ' + positivo'),
          h('p', {}, h('span', { class: 'lg', style: { background: 'var(--warn)' } }), ' - negativo'),
          h('p', {}, h('span', { class: 'lg', style: { background: 'var(--bad)' } }), ' = / errore, murato'),
          h('p', { class: 'muted' }, 'La squadra selezionata è sempre rappresentata in basso.'))));
  }

  function issuesCard() {
    const list = app.issues;
    return h('div', { class: 'card issues', id: 'issues-card' },
      h('h3', {}, `Controllo dati (${list.length})`),
      list.length ? h('details', { open: issuesOpen, ontoggle: (e) => { issuesOpen = e.target.open; } },
        h('summary', {}, `${list.filter((i) => i.level === 'error').length} errori, ${list.filter((i) => i.level === 'warn').length} avvisi, ${list.filter((i) => i.level === 'info').length} note`),
        h('ul', {}, list.slice(0, 400).map((i) => h('li', { class: i.level }, h('b', {}, i.i != null ? `Riga ${i.i + 1}: ` : ''), i.msg)))) : h('p', { class: 'ok' }, 'Nessun problema rilevato ✓'));
  }

  function render() {
    clear(root);
    const st = computeStats(app.match, app.rp, { set: setFilter || null });
    const m = app.match;
    root.append(
      h('div', { class: 'report-head' },
        h('div', {},
          h('h1', {}, `${m.teams['*'].name} – ${m.teams.a.name}  ${app.rp.setsWon['*']}-${app.rp.setsWon.a}`),
          h('p', { class: 'muted' }, [m.meta.date, m.meta.league, m.meta.phase, m.meta.venue].filter(Boolean).join(' · '))),
        h('div', { class: 'row gap no-print' },
          h('label', { class: 'field inline' }, h('span', {}, 'Set'), h('select', { onchange: (e) => { setFilter = +e.target.value; render(); } },
            h('option', { value: 0 }, 'Tutti'), app.rp.sets.map((s) => h('option', { value: s.set, selected: setFilter === s.set }, `${s.set}° set`)))),
          h('button', { class: 'btn', onclick: () => window.print() }, '🖨 Stampa / PDF'))),
      h('div', { class: 'grid2' }, h('div', { class: 'card' }, h('h3', {}, 'Risultato'), scoreTable()), h('div', { class: 'card' }, h('h3', {}, 'Confronto squadre'), compareTable(st))),
      playerTable(st, '*'), playerTable(st, 'a'),
      h('div', { class: 'grid2' }, rotationTable(st, '*'), rotationTable(st, 'a')),
      h('div', { class: 'grid2' }, receptionAttackTable(st, '*'), receptionAttackTable(st, 'a')),
      mapCard(),
      issuesCard(),
    );
  }

  return {
    el: root, render,
    showIssues: () => { issuesOpen = true; render(); root.querySelector('#issues-card')?.scrollIntoView({ behavior: 'smooth' }); },
  };
}

export { other };
