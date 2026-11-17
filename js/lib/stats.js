// Statistiche e report a partire dalle righe rigiocate.
import { other } from './constants.js';
import { rallyWinner } from './codes.js';

const pct = (a, b) => (b ? a / b : null);

function emptyLine() {
  return {
    S: { n: 0, '#': 0, '+': 0, '!': 0, '-': 0, '/': 0, '=': 0 },
    R: { n: 0, '#': 0, '+': 0, '!': 0, '-': 0, '/': 0, '=': 0 },
    E: { n: 0, '#': 0, '+': 0, '!': 0, '-': 0, '/': 0, '=': 0 },
    A: { n: 0, '#': 0, '+': 0, '!': 0, '-': 0, '/': 0, '=': 0 },
    B: { n: 0, '#': 0, '+': 0, '!': 0, '-': 0, '/': 0, '=': 0 },
    D: { n: 0, '#': 0, '+': 0, '!': 0, '-': 0, '/': 0, '=': 0 },
    F: { n: 0, '#': 0, '+': 0, '!': 0, '-': 0, '/': 0, '=': 0 },
    sets: new Set(),
  };
}

export function derived(l) {
  const S = l.S, R = l.R, A = l.A, B = l.B;
  return {
    points: S['#'] + A['#'] + B['#'],
    errors: S['='] + R['='] + A['='] + A['/'] + B['='] + B['/'] + l.E['='] + l.D['='] + l.F['='],
    serveEff: pct(S['#'] - S['='], S.n),
    recPos: pct(R['#'] + R['+'], R.n),
    recPerf: pct(R['#'], R.n),
    recEff: pct(R['#'] + R['+'] - R['='] - R['/'], R.n),
    atkKill: pct(A['#'], A.n),
    atkEff: pct(A['#'] - A['='] - A['/'], A.n),
    digPos: pct(l.D['#'] + l.D['+'], l.D.n),
  };
}

// Raggruppa le righe in rally: [{ id, set, serving, won, rows: [rowSkill], setterPos, score }]
export function rallies(rows) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    if (r.e.kind === 'skill') {
      if (!cur || cur.id !== r.rally) {
        cur = { id: r.rally, set: r.set, serving: r.serving, setterPos: { ...r.setterPos }, score: { ...r.score }, rows: [], won: null };
        out.push(cur);
      }
      cur.rows.push(r);
    } else if (r.e.kind === 'point') {
      if (!cur || cur.id !== r.rally) {
        cur = { id: r.rally, set: r.set, serving: r.serving, setterPos: { ...r.setterPos }, score: { ...r.score }, rows: [], won: null };
        out.push(cur);
      }
      cur.won = r.won;
      cur = null;
    }
  }
  return out;
}

export function computeStats(match, rp, filter = {}) {
  const rows = rp.rows.filter((r) => (filter.set ? r.set === filter.set : true));
  const players = { '*': new Map(), a: new Map() };
  const team = { '*': emptyLine(), a: emptyLine() };
  const getP = (t, n) => {
    let p = players[t].get(n);
    if (!p) players[t].set(n, (p = emptyLine()));
    return p;
  };
  for (const r of rows) {
    const e = r.e;
    if (e.kind !== 'skill' || !e.skill || !team[e.team]) continue;
    const ev = e.ev || '+';
    for (const l of [team[e.team], getP(e.team, e.num)]) {
      l[e.skill].n++;
      l[e.skill][ev] = (l[e.skill][ev] || 0) + 1;
      l.sets.add(r.set);
    }
  }
  // giocatori in campo per set (anche se senza tocchi)
  for (const s of rp.sets) for (const t of ['*', 'a']) for (const n of s.played[t]) getP(t, n).sets.add(s.set);

  const rl = rallies(rows);
  const rot = { '*': {}, a: {} };
  const so = { '*': { n: 0, w: 0 }, a: { n: 0, w: 0 } };
  const bp = { '*': { n: 0, w: 0 }, a: { n: 0, w: 0 } };
  const oppErrors = { '*': 0, a: 0 };
  const phaseAtk = { '*': { r: { n: 0, k: 0, e: 0 }, t: { n: 0, k: 0, e: 0 } }, a: { r: { n: 0, k: 0, e: 0 }, t: { n: 0, k: 0, e: 0 } } };
  const firstAtkByRec = { '*': {}, a: {} };
  const distribution = { '*': {}, a: {} };
  for (const ra of rl) {
    if (!ra.won) continue;
    const recv = other(ra.serving);
    so[recv].n++; if (ra.won === recv) so[recv].w++;
    bp[ra.serving].n++; if (ra.won === ra.serving) bp[ra.serving].w++;
    for (const t of ['*', 'a']) {
      const sp = ra.setterPos[t] || '?';
      const k = rot[t][sp] || (rot[t][sp] = { so: { n: 0, w: 0 }, bp: { n: 0, w: 0 } });
      if (t === recv) { k.so.n++; if (ra.won === t) k.so.w++; } else { k.bp.n++; if (ra.won === t) k.bp.w++; }
    }
    // punti da errori avversari
    const term = ra.rows.find((r) => rallyWinner(r.e));
    if (term && term.e.team !== ra.won) oppErrors[ra.won]++;
    // attacchi per fase; primo attacco dopo ricezione per qualità ricezione
    const rec = ra.rows.find((r) => r.e.skill === 'R');
    for (const r of ra.rows) {
      const e = r.e;
      if (e.skill !== 'A') continue;
      const ph = r.aphase === 'r' ? 'r' : 't';
      const pa = phaseAtk[e.team][ph];
      pa.n++; if (e.ev === '#') pa.k++; if (e.ev === '=' || e.ev === '/') pa.e++;
      if (r.aphase === 'r' && rec) {
        const q = rec.e.ev;
        const f = firstAtkByRec[e.team][q] || (firstAtkByRec[e.team][q] = { n: 0, k: 0, e: 0 });
        f.n++; if (e.ev === '#') f.k++; if (e.ev === '=' || e.ev === '/') f.e++;
        const sp = r.setterPos[e.team] || '?';
        const d = distribution[e.team][sp] || (distribution[e.team][sp] = {});
        const z = e.sz || '?';
        d[z] = (d[z] || 0) + 1;
      }
    }
  }
  const byPlayer = {};
  for (const t of ['*', 'a']) {
    byPlayer[t] = [...players[t].entries()]
      .filter(([n]) => n != null)
      .map(([num, l]) => ({ num, line: l, d: derived(l), player: match.teams[t].players.find((p) => Number(p.number) === Number(num)) }))
      .sort((a, b) => a.num - b.num);
  }
  return {
    team, teamD: { '*': derived(team['*']), a: derived(team.a) }, byPlayer, rotations: rot, sideout: so, breakpoint: bp,
    oppErrors, phaseAtk, firstAtkByRec, distribution, rallies: rl,
  };
}

// Dati per mappe: elenco tocchi con coordinate
export function touchesWithCoords(rp, f = {}) {
  return rp.rows.filter((r) => {
    const e = r.e;
    if (e.kind !== 'skill') return false;
    if (f.team && e.team !== f.team) return false;
    if (f.skill && e.skill !== f.skill) return false;
    if (f.num != null && f.num !== '' && Number(e.num) !== Number(f.num)) return false;
    if (f.set && r.set !== Number(f.set)) return false;
    if (f.evals && f.evals.length && !f.evals.includes(e.ev)) return false;
    return !!(e.start || e.end);
  });
}

export const fmtPct = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);
