// Predizione del giocatore più probabile per un tocco.
// Combina un "prior" basato su ruoli e posizioni in campo con le frequenze
// apprese dai dati già scoutizzati (modello di Dirichlet). Funziona con qualsiasi
// sistema di gioco (non solo 5-1 con libero) perché si basa sui ruoli dichiarati.
import { other } from './constants.js';

const FRONT = [2, 3, 4]; // posizioni di prima linea (1-based)
const COLUMN_OF_POS = { 1: 'R', 2: 'R', 3: 'C', 6: 'C', 4: 'L', 5: 'L' };
const COLUMN_OF_ZONE = { 1: 'R', 2: 'R', 9: 'R', 3: 'C', 6: 'C', 8: 'C', 4: 'L', 5: 'L', 7: 'L' };
const POS_OF_ZONE = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 5, 8: 6, 9: 1 };

export function buildLearner(rows) {
  const counts = new Map();
  const serveTypes = new Map();
  for (const r of rows) {
    const e = r.e;
    if (e.kind !== 'skill' || e.num == null) continue;
    const sp = r.setterPos?.[e.team];
    const zone = e.skill === 'R' || e.skill === 'D' ? e.ez : e.sz;
    for (const key of [`${e.team}|${e.skill}|${sp}|${zone}`, `${e.team}|${e.skill}|*|${zone}`]) {
      let m = counts.get(key);
      if (!m) counts.set(key, (m = new Map()));
      m.set(e.num, (m.get(e.num) || 0) + 1);
    }
    if (e.skill === 'S' && e.type) {
      const k = `${e.team}|${e.num}`;
      let m = serveTypes.get(k);
      if (!m) serveTypes.set(k, (m = new Map()));
      m.set(e.type, (m.get(e.type) || 0) + 1);
    }
  }
  return {
    counts,
    serveType(team, num) {
      const m = serveTypes.get(`${team}|${num}`);
      if (!m) return null;
      return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
    },
  };
}

function roleOf(match, team, num) {
  const p = match.teams[team].players.find((x) => Number(x.number) === Number(num));
  return p?.role || 'U';
}

// prior: punteggio per ciascun giocatore candidato
function prior(match, state, team, skill, zone, opts = {}) {
  const pos = state.pos[team];
  const libs = match.teams[team].players.filter((p) => p.role === 'L').map((p) => Number(p.number));
  const setter = state.setter[team];
  const scores = new Map();
  const add = (num, w) => { if (num != null) scores.set(num, (scores.get(num) || 0) + w); };
  const serving = state.serving === team;
  const posOf = (n) => pos.indexOf(n) + 1; // 1..6
  const zcol = COLUMN_OF_ZONE[zone];

  switch (skill) {
    case 'S':
      add(pos[0], 10);
      break;
    case 'E':
      add(setter, 10);
      pos.forEach((n) => { if (roleOf(match, team, n) === 'O') add(n, 1); });
      libs.forEach((n) => add(n, 1.5));
      break;
    case 'R': {
      // ricevitori tipici: schiacciatori + libero (in seconda linea il libero sostituisce il centrale)
      pos.forEach((n, i) => {
        const role = roleOf(match, team, n);
        const p = i + 1;
        let w = 0.2;
        if (role === 'H') w = 2;
        else if (role === 'O' || role === 'S') w = 0.15;
        else if (role === 'M') w = libs.length ? 0 : (FRONT.includes(p) ? 0.1 : 1.2);
        else if (role === 'U') w = 0.8;
        if (zcol && COLUMN_OF_POS[p] === zcol) w *= 2.5;
        add(n, w);
      });
      libs.forEach((n) => add(n, zcol === 'C' ? 4 : 2.2));
      break;
    }
    case 'A': {
      const front = pos.filter((_, i) => FRONT.includes(i + 1));
      const back = pos.filter((_, i) => !FRONT.includes(i + 1));
      const pick = (cands, roles, w) => cands.forEach((n) => { if (roles.includes(roleOf(match, team, n))) add(n, w); });
      if (zone === 4 || zone === 5) { pick(front, ['H'], 4); pick(front, ['O'], 1.5); }
      else if (zone === 3 || zone === 6) { pick(front, ['M'], 4); pick(front, ['S'], 1); }
      else if (zone === 2 || zone === 1) { pick(front, ['O'], 4); pick(front, ['H'], 1.2); pick(front, ['S'], 1); }
      else if (zone === 8) { pick(back, ['H'], 4); pick(back, ['O'], 0.8); }
      else if (zone === 9) { pick(back, ['O'], 4); pick(back, ['H'], 1); }
      else if (zone === 7) { pick(back, ['H', 'O'], 2); }
      // fallback per posizione
      const p = POS_OF_ZONE[zone];
      if (p) add(pos[p - 1], 1);
      pos.forEach((n) => add(n, roleOf(match, team, n) === 'L' ? 0 : 0.05));
      break;
    }
    case 'B': {
      // il muro si gioca in prima linea; zona = zona di partenza dell'attacco avversario, specchiata
      const mirror = { 4: 2, 3: 3, 2: 4, 7: 2, 8: 3, 9: 4, 5: 2, 6: 3, 1: 4 }[opts.attackZone ?? zone] || 3;
      pos.forEach((n, i) => {
        const p = i + 1;
        if (!FRONT.includes(p)) return;
        add(n, p === mirror ? 4 : 1);
        if (roleOf(match, team, n) === 'M') add(n, 1);
      });
      break;
    }
    case 'D':
    case 'F': {
      const p = POS_OF_ZONE[zone];
      pos.forEach((n, i) => {
        let w = 0.3;
        if (p && i + 1 === p) w = 3;
        else if (zcol && COLUMN_OF_POS[i + 1] === zcol) w = 1;
        if (!FRONT.includes(i + 1)) w *= 1.4;
        if (roleOf(match, team, n) === 'M' && !FRONT.includes(i + 1) && libs.length && !serving) w = 0;
        add(n, w);
      });
      libs.forEach((n) => add(n, (zone === 5 || zone === 6 || zone === 7 || zone === 8) ? 3.5 : 1.2));
      break;
    }
    default:
      pos.forEach((n) => add(n, 1));
  }
  return { scores, posOf };
}

// Restituisce i candidati ordinati [{num, p}] (p = probabilità stimata)
export function rankPlayers(match, state, learner, team, skill, zone, opts = {}) {
  if (!state) return [];
  const { scores } = prior(match, state, team, skill, zone, opts);
  const total = [...scores.values()].reduce((a, b) => a + b, 0) || 1;
  const alpha = 3; // peso del prior (in "osservazioni equivalenti")
  const sp = state.setterPos?.[team];
  const learned = learner?.counts.get(`${team}|${skill}|${sp}|${zone}`) || learner?.counts.get(`${team}|${skill}|*|${zone}`);
  const res = new Map();
  for (const [n, s] of scores) res.set(n, alpha * s / total);
  if (learned) {
    const onCourt = new Set([...state.pos[team], ...match.teams[team].players.filter((p) => p.role === 'L').map((p) => Number(p.number))]);
    for (const [n, c] of learned) if (onCourt.has(n)) res.set(n, (res.get(n) || 0) + c);
  }
  // include sempre tutti i giocatori in campo
  for (const n of state.pos[team]) if (!res.has(n)) res.set(n, 0);
  const sum = [...res.values()].reduce((a, b) => a + b, 0) || 1;
  return [...res.entries()].map(([num, v]) => ({ num, p: v / sum })).sort((a, b) => b.p - a.p);
}

export function predictPlayer(match, state, learner, team, skill, zone, opts) {
  const r = rankPlayers(match, state, learner, team, skill, zone, opts);
  return r.length ? r[0].num : null;
}

// Combinazioni d'attacco suggerite per zona di partenza, ordinate per frequenza appresa
export function rankCombos(rows, team, zone, table, num = null) {
  const freq = new Map();
  for (const r of rows) {
    const e = r.e;
    if (e.kind === 'skill' && e.skill === 'A' && e.team === team && e.combo) {
      const w = (e.num === num ? 3 : 1) * (e.sz === zone ? 1 : 0.15);
      freq.set(e.combo, (freq.get(e.combo) || 0) + w);
    }
  }
  return table
    .map((a) => ({ ...a, score: (freq.get(a.code) || 0) + (a.zone === zone ? 0.5 : 0) + (a.type === 'H' && a.zone === zone ? 0.1 : 0) }))
    .filter((a) => a.zone === zone || freq.get(a.code))
    .sort((a, b) => b.score - a.score);
}

export { other };
