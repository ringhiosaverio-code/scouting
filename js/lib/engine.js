// Motore della partita: tutto lo stato (punteggio, rotazioni, servizio, fasi) è
// ricavato rigiocando la lista di eventi. Questo rende sicure modifiche,
// inserimenti e cancellazioni in qualunque punto della partita.
import { DEFAULT_SETTINGS, other } from './constants.js';
import { rallyWinner, ballOwnerAfter } from './codes.js';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function newPlayer(p = {}) {
  return { id: uid(), number: null, lastName: '', firstName: '', role: 'U', captain: false, foreign: false, dvId: '', ...p };
}

export function newMatch(init = {}) {
  return {
    format: 'volleyscout-1',
    id: uid(),
    created: new Date().toISOString(),
    meta: {
      date: new Date().toISOString().slice(0, 10), time: '', season: '', league: '', phase: '', matchNumber: '',
      venue: '', city: '', referees: '', scout: '', comments: '', ...init.meta,
    },
    teams: {
      '*': { code: 'CAS', name: 'Casa', coach: '', assistant: '', colour: '#1f6feb', players: [], ...(init.teams?.['*'] || {}) },
      a: { code: 'OSP', name: 'Ospiti', coach: '', assistant: '', colour: '#d1242f', players: [], ...(init.teams?.a || {}) },
    },
    settings: structuredClone({ ...DEFAULT_SETTINGS, ...(init.settings || {}) }),
    video: { name: '', url: '', offset: 0, ...(init.video || {}) },
    calibration: { points: {}, ...(init.calibration || {}) },
    events: init.events || [],
  };
}

export const rotate = (pos, dir = 1) => (dir > 0 ? [...pos.slice(1), pos[0]] : [pos[5], ...pos.slice(0, 5)]);

export function setterPosition(pos, setterNum) {
  const i = pos.indexOf(setterNum);
  return i < 0 ? null : i + 1;
}

export function setTarget(match, setNum) {
  const f = match.settings?.format || DEFAULT_SETTINGS.format;
  return setNum === f.setsToWin * 2 - 1 ? f.tiebreakPoints : f.points;
}

export function isSetOver(match, setNum, h, v) {
  const t = setTarget(match, setNum);
  return (h >= t || v >= t) && Math.abs(h - v) >= 2;
}

// Rigioca tutti gli eventi; restituisce righe arricchite e stato corrente.
export function replay(match) {
  const events = match.events;
  const rows = [];
  const sets = [];
  let st = null; // stato del set in corso
  let setsWon = { '*': 0, a: 0 };
  let rallyId = 0;
  let rally = null; // { rows: [], serving, terminal: false, touches }

  const startRally = () => {
    rallyId++;
    rally = { id: rallyId, rows: [], serving: st.serving, terminalIdx: -1, firstAttackDone: { '*': false, a: false } };
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const row = { i, e, set: st?.set ?? null };
    if (e.kind === 'lineup') {
      st = {
        set: e.set,
        pos: { '*': [...e.h], a: [...e.v] },
        setter: { '*': e.hSetter, a: e.vSetter },
        serving: e.serve,
        score: { '*': 0, a: 0 },
        homeNear: e.homeNear ?? true,
        timeouts: { '*': 0, a: 0 },
        subs: { '*': 0, a: 0 },
        over: false,
        startVt: null,
        endVt: null,
        partials: {},
        libero: { '*': e.hLib || [], a: e.vLib || [] },
        played: { '*': new Set(e.h), a: new Set(e.v) },
        subsIn: { '*': new Set(), a: new Set() },
        startLineup: { '*': [...e.h], a: [...e.v] },
      };
      sets.push(st);
      rally = null;
      Object.assign(row, snap(st, setsWon));
      rows.push(row);
      continue;
    }
    if (!st) { row.orphan = true; rows.push(row); continue; }
    switch (e.kind) {
      case 'skill': {
        if (st.over) { row.afterSetEnd = true; }
        if (!rally) startRally();
        if (st.startVt == null && e.vt != null) st.startVt = e.vt;
        if (e.vt != null) st.endVt = e.vt;
        Object.assign(row, snap(st, setsWon));
        row.rally = rally.id;
        row.touch = rally.rows.length + 1;
        if (e.skill === 'A') {
          const recv = other(rally.serving);
          if (e.team === recv && !rally.firstAttackDone[recv] && rally.rows.some((r) => r.e.skill === 'R')) row.aphase = 'r';
          else row.aphase = e.team === rally.serving ? 'p' : 's';
          rally.firstAttackDone[e.team] = true;
        }
        if (rally.terminalIdx < 0 && rallyWinner(e)) rally.terminalIdx = rally.rows.length;
        rally.rows.push(row);
        rows.push(row);
        break;
      }
      case 'point': {
        if (!rally) startRally();
        const won = e.team;
        const serving = st.serving;
        Object.assign(row, snap(st, setsWon));
        row.rally = rally.id;
        st.score[won]++;
        for (const k of [8, 16, 21]) if (st.partials[k] == null && (st.score['*'] >= k || st.score.a >= k)) st.partials[k] = { ...st.score };
        if (won !== serving) {
          st.pos[won] = rotate(st.pos[won]);
          st.serving = won;
        }
        const phase = won === rally.serving ? 'p' : 's';
        // marca le righe terminali del rally con la fase del punto
        const startIdx = rally.terminalIdx >= 0 ? rally.terminalIdx : Math.max(0, rally.rows.length - 1);
        rally.rows.slice(startIdx).forEach((r) => { r.phase = phase; });
        row.phase = phase;
        row.won = won;
        row.rallyServing = rally.serving;
        row.scoreAfter = { ...st.score };
        rally = null;
        if (isSetOver(match, st.set, st.score['*'], st.score.a)) st.pendingEnd = true;
        rows.push(row);
        break;
      }
      case 'endset': {
        Object.assign(row, snap(st, setsWon));
        if (!st.over) {
          st.over = true;
          st.pendingEnd = false;
          const w = st.score['*'] > st.score.a ? '*' : 'a';
          st.winner = w;
          setsWon[w]++;
        }
        rally = null;
        rows.push(row);
        break;
      }
      case 'sub': {
        Object.assign(row, snap(st, setsWon));
        const p = st.pos[e.team];
        const k = p.indexOf(e.out);
        if (k >= 0) {
          p[k] = e.in;
          st.subs[e.team]++;
          st.played[e.team].add(e.in);
          st.subsIn[e.team].add(e.in);
          if (st.setter[e.team] === e.out) st.setter[e.team] = e.newSetter ?? e.in;
        } else row.invalid = `Il giocatore ${e.out} non è in campo`;
        if (e.newSetter != null) st.setter[e.team] = e.newSetter;
        rows.push(row);
        break;
      }
      case 'setter': {
        Object.assign(row, snap(st, setsWon));
        st.setter[e.team] = e.num;
        rows.push(row);
        break;
      }
      case 'rot': {
        Object.assign(row, snap(st, setsWon));
        st.pos[e.team] = rotate(st.pos[e.team], e.dir || 1);
        rows.push(row);
        break;
      }
      case 'rotset': {
        Object.assign(row, snap(st, setsWon));
        for (let k = 0; k < 6 && setterPosition(st.pos[e.team], st.setter[e.team]) !== e.pos; k++) st.pos[e.team] = rotate(st.pos[e.team]);
        rows.push(row);
        break;
      }
      case 'segment': {
        // nuova sequenza in un video montato: chi batte (ed eventualmente lato) cambia senza punti
        Object.assign(row, snap(st, setsWon));
        rally = null;
        if (e.serve) st.serving = e.serve;
        if (e.homeNear != null) st.homeNear = e.homeNear;
        rows.push(row);
        break;
      }
      case 'side': {
        Object.assign(row, snap(st, setsWon));
        st.homeNear = !st.homeNear;
        rows.push(row);
        break;
      }
      case 'timeout': {
        Object.assign(row, snap(st, setsWon));
        st.timeouts[e.team]++;
        rows.push(row);
        break;
      }
      default: {
        Object.assign(row, snap(st, setsWon));
        if (rally) row.rally = rally.id;
        rows.push(row);
      }
    }
  }

  // stato corrente
  const current = st ? {
    ...snap(st, setsWon),
    over: st.over,
    pendingEnd: !!st.pendingEnd && !st.over,
    inRally: !!rally && rally.rows.length > 0,
    rallyRows: rally ? rally.rows.map((r) => r.e) : [],
    timeouts: { ...st.timeouts },
    subs: { ...st.subs },
    libero: st.libero,
    homeNear: st.homeNear,
  } : null;
  if (current) {
    current.lastSkill = current.rallyRows.length ? current.rallyRows[current.rallyRows.length - 1] : null;
    current.ballOwner = ballOwnerFromRally(current.rallyRows, current.serving);
  }
  const matchOver = setsWon['*'] >= (match.settings?.format?.setsToWin || 3) || setsWon.a >= (match.settings?.format?.setsToWin || 3);
  return { rows, sets, current, setsWon, matchOver, nextSet: (st ? st.set + 1 : 1) };
}

function snap(st, setsWon) {
  return {
    set: st.set,
    score: { ...st.score },
    pos: { '*': [...st.pos['*']], a: [...st.pos.a] },
    setter: { ...st.setter },
    setterPos: { '*': setterPosition(st.pos['*'], st.setter['*']), a: setterPosition(st.pos.a, st.setter.a) },
    serving: st.serving,
    homeNear: st.homeNear,
    setsWon: { ...setsWon },
  };
}

export function ballOwnerFromRally(rallyRows, serving) {
  let owner = serving;
  let prev = null;
  for (const e of rallyRows) { owner = ballOwnerAfter(e, prev); prev = e; }
  return owner;
}

// Lookup giocatori
export function playerLookup(match) {
  const maps = { '*': new Map(), a: new Map() };
  for (const t of ['*', 'a']) for (const p of match.teams[t].players) maps[t].set(Number(p.number), p);
  const fn = (team, num) => maps[team]?.get(Number(num)) || null;
  fn.names = { '*': match.teams['*'].name, a: match.teams.a.name };
  return fn;
}

export function liberos(match, team) {
  return match.teams[team].players.filter((p) => p.role === 'L').map((p) => Number(p.number));
}

export function defaultSetter(match, team, six) {
  const ps = match.teams[team].players;
  const s = six.find((n) => ps.find((p) => Number(p.number) === Number(n) && p.role === 'S'));
  return s ?? six[0];
}
