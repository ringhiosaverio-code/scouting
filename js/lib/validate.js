// Controlli di coerenza dei dati scoutizzati (ispirato a "dvalidate").
import { SKILLS } from './constants.js';
import { rallies } from './stats.js';

// abbinamenti ammessi (le convenzioni variano leggermente tra scout)
const SERVE_REC_OK = { '#': ['='], '/': ['/'], '!': ['!', '+'], '-': ['#', '+'], '+': ['-', '!'] };

export function validate(match, rp) {
  const issues = [];
  const add = (row, level, msg) => issues.push({ i: row?.i ?? null, level, msg });
  const roster = {
    '*': new Map(match.teams['*'].players.map((p) => [Number(p.number), p])),
    a: new Map(match.teams.a.players.map((p) => [Number(p.number), p])),
  };
  let lastVt = null;
  for (const r of rp.rows) {
    const e = r.e;
    if (r.orphan) add(r, 'error', 'Evento prima della formazione del set');
    if (r.invalid) add(r, 'error', r.invalid);
    if (e.kind === 'lineup') {
      for (const [t, six] of [['*', e.h], ['a', e.v]]) {
        if (new Set(six).size !== 6) add(r, 'error', `Formazione ${t === '*' ? 'casa' : 'ospiti'} con giocatori duplicati`);
        for (const n of six) {
          if (!roster[t].has(Number(n))) add(r, 'warn', `Giocatore ${n} non in rosa`);
          else if (roster[t].get(Number(n)).role === 'L') add(r, 'error', `Il libero ${n} non può essere in formazione`);
        }
      }
    }
    if (e.kind !== 'skill') continue;
    if (e.vt != null) {
      if (lastVt != null && e.vt + 0.5 < lastVt) add(r, 'warn', 'Il tempo video torna indietro');
      lastVt = e.vt;
    }
    if (e.num == null) { add(r, 'error', `${SKILLS[e.skill]} senza giocatore`); continue; }
    const p = roster[e.team].get(Number(e.num));
    if (!p) { add(r, 'warn', `Giocatore ${e.num} non in rosa`); continue; }
    const onCourt = r.pos?.[e.team]?.includes(Number(e.num));
    if (p.role === 'L') {
      if (e.skill === 'S' || e.skill === 'B') add(r, 'error', `Il libero ${e.num} non può ${e.skill === 'S' ? 'battere' : 'murare'}`);
      if (e.skill === 'A' && e.ev === '#') add(r, 'warn', `Attacco punto del libero ${e.num}: verificare`);
    } else if (r.pos && !onCourt) add(r, 'warn', `Il giocatore ${e.num} non risulta in campo`);
    if (e.skill === 'S' && r.pos && r.pos[e.team][0] !== Number(e.num)) add(r, 'warn', `Batte ${e.num} ma in P1 c'è ${r.pos[e.team][0]}`);
    if (e.skill === 'S' && r.serving && e.team !== r.serving) add(r, 'error', 'Batte la squadra sbagliata');
    if (e.skill === 'B' && r.pos) {
      const k = r.pos[e.team].indexOf(Number(e.num));
      if (k >= 0 && ![1, 2, 3].includes(k)) add(r, 'error', `Muro di un giocatore in seconda linea (${e.num})`);
    }
  }
  // controlli per rally
  const rl = rallies(rp.rows);
  for (const ra of rl) {
    const rs = ra.rows;
    for (let k = 0; k < rs.length; k++) {
      const e = rs[k].e;
      const n = rs[k + 1]?.e;
      if (e.skill === 'S' && k > 0) add(rs[k], 'error', 'Nuova battuta senza assegnazione del punto precedente');
      if (e.skill === 'S' && !['#', '='].includes(e.ev) && n && n.skill !== 'R') add(rs[k], 'warn', 'Battuta in gioco senza ricezione');
      if (e.skill === 'S' && n && n.skill === 'R') {
        const ok = SERVE_REC_OK[e.ev];
        if (ok && !ok.includes(n.ev)) add(rs[k + 1], 'warn', `Valutazione battuta ${e.ev} incoerente con ricezione ${n.ev}`);
      }
      if (e.skill === 'A' && e.ev === '/' && !(n && n.skill === 'B' && n.ev === '#')) add(rs[k], 'info', 'Attacco murato senza riga di muro punto');
      if (e.skill === 'A' && k > 0 && rs[k - 1].e.skill !== 'E' && !['PP', 'P2', 'PR'].includes(e.combo)) add(rs[k], 'info', 'Attacco senza alzata');
      if (n && e.skill === 'E' && n.skill === 'A' && e.team !== n.team) add(rs[k + 1], 'warn', 'Attacco di squadra diversa da quella che ha alzato');
    }
    if (ra.won == null && ra !== rl.at(-1)) add(rs[rs.length - 1], 'error', 'Rally senza assegnazione del punto');
    const term = rs.find((r) => r.phase);
    if (ra.won && rs.length && !term) add(rs[rs.length - 1], 'info', 'Punto senza azione conclusiva');
  }
  return issues.sort((a, b) => (a.i ?? 0) - (b.i ?? 0));
}
