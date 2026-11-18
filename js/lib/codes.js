// Costruzione e interpretazione dei codici di scouting (formato DataVolley).
import {
  ATTACK_TABLE, SKILLS, EVALS, TYPES, COMPOUND, EVAL_TEXT, TYPE_TEXT, SKILL_SUBTYPES,
  SPECIAL, SET_TARGETS, other,
} from './constants.js';

const ATTACK_CODES = new Map(ATTACK_TABLE.map((a) => [a.code, a]));
const SKILL_SET = new Set(Object.keys(SKILLS));
const EVAL_SET = new Set(EVALS);
const TYPE_SET = new Set(TYPES);
const COMBO_RE = /^[CGIJLPVWXYZ][0-9A-Z]$/;
const CALL_RE = /^K[0-9A-Z]$/;

const STYPE = { A: 'HPT', B: 'AT', R: 'LRWOM', E: '12345', D: 'SCBE' };
const SPECIAL_CHARS = { A: 'SOFXNCIAZ', B: 'SOFXNCIAPTZ', R: 'UXPEZ', S: 'OLRNZ', E: 'UIZ', D: 'UXPZFOE', F: 'UXPZ' };

export const pad2 = (n) => String(n ?? 0).padStart(2, '0');

export function attackInfo(code, table = ATTACK_TABLE) {
  if (table === ATTACK_TABLE) return ATTACK_CODES.get(code) || null;
  return table.find((a) => a.code === code) || null;
}

// --------- codice completo di una riga skill ---------
export function skillCode(e) {
  const t = (v, w = 1) => (v == null || v === '' ? '~'.repeat(w) : String(v).padEnd(w, '~').slice(0, w));
  let c = (e.team || '*') + pad2(e.num) + e.skill + t(e.type) + t(e.ev) + t(e.combo, 2) + t(e.target) +
    t(e.sz) + t(e.ez) + t(e.esz) + t(e.stype) + t(e.nb) + t(e.special) + (e.custom || '');
  return c.replace(/~+$/, '');
}

// Interpreta un codice DataVolley completo (posizionale)
export function parseSkillCode(code) {
  const c = code.padEnd(20, '~');
  const g = (a, b) => {
    const v = c.slice(a, b);
    return /^~+$/.test(v) ? null : v.replace(/~/g, '');
  };
  const e = {
    kind: 'skill',
    team: c[0] === 'a' ? 'a' : '*',
    num: parseInt(c.slice(1, 3), 10),
    skill: c[3],
    type: g(4, 5),
    ev: g(5, 6),
    combo: g(6, 8),
    target: g(8, 9),
    sz: g(9, 10) ? +g(9, 10) : null,
    ez: g(10, 11) ? +g(10, 11) : null,
    esz: g(11, 12),
    stype: g(12, 13),
    nb: g(13, 14) != null ? +g(13, 14) : null,
    special: g(14, 15),
    custom: code.length > 15 ? code.slice(15).replace(/~+$/, '') : '',
  };
  if (Number.isNaN(e.num)) e.num = null;
  return e;
}

// --------- interprete dei codici digitati (sintassi flessibile) ---------
// ctx: { serving, ballOwner, setter: {'*':n,'a':n}, p1: {'*':n,'a':n}, prevSkill (ultima riga skill del rally),
//        defaults: {eval:{}, type}, predict(team, skill, zone) -> num, serveType(team,num) -> type }
export function interpretTyped(input, ctx = {}) {
  const out = { events: [], errors: [] };
  const parts = String(input).trim().split(/\s+/).filter(Boolean);
  let local = { ...ctx };
  for (const p of parts) {
    try {
      const evs = interpretOne(p, local);
      for (const e of evs) {
        out.events.push(e);
        if (e.kind === 'skill') local = advanceContext(local, e);
      }
    } catch (err) {
      out.errors.push(`${p}: ${err.message}`);
    }
  }
  return out;
}

// aggiorna il contesto dopo un tocco (per inferire squadra/giocatore del tocco successivo)
export function advanceContext(ctx, e) {
  return { ...ctx, ballOwner: ballOwnerAfter(e, ctx.prevSkill), prevSkill: e };
}

export function ballOwnerAfter(e, prev) {
  switch (e.skill) {
    case 'S': return other(e.team);
    case 'A': return other(e.team);
    case 'B': return (e.ev === '!' ? other(e.team) : e.team);
    case 'F':
      // freeball inviata (terzo tocco) oppure ricevuta
      if (prev && prev.team === e.team && 'RDEF'.includes(prev.skill)) return other(e.team);
      if (prev && prev.team !== e.team) return e.team;
      return other(e.team);
    default: return e.team;
  }
}

function interpretOne(raw, ctx) {
  let s = raw;
  let m;
  if ((m = s.match(/^\*\*(\d)set$/i))) return [{ kind: 'endset' }];
  if ((m = s.match(/^([*a])p$/))) return [{ kind: 'point', team: m[1] }];
  if ((m = s.match(/^([*a])[tT]$/))) return [{ kind: 'timeout', team: m[1] }];
  if ((m = s.match(/^([*a])c(\d{1,2})[:.,](\d{1,2})$/))) return [{ kind: 'sub', team: m[1], out: +m[2], in: +m[3] }];
  if ((m = s.match(/^([*a])P(\d{1,2})$/))) return [{ kind: 'setter', team: m[1], num: +m[2] }];
  if ((m = s.match(/^([*a])z([1-6])$/))) return [{ kind: 'rotset', team: m[1], pos: +m[2] }];
  if ((m = s.match(/^([*a])\$\$&(.*)$/))) {
    const rest = m[2].toUpperCase();
    const ev = [...rest].reverse().find((ch) => EVAL_SET.has(ch)) || '#';
    return [{ kind: 'green', team: m[1], ev, type: rest[0] && TYPE_SET.has(rest[0]) ? rest[0] : 'H' }];
  }
  if (s.includes('.')) {
    const [a, b] = s.split('.', 2);
    const e1 = parseSkill(a, ctx);
    const ctx2 = advanceContext(ctx, e1);
    const comp = COMPOUND[e1.skill];
    if (!comp) throw new Error(`Compound non valido per ${SKILLS[e1.skill]}`);
    const team2 = other(e1.team);
    const prefix = b.startsWith('a') || b.startsWith('*') ? '' : (team2 === 'a' ? 'a' : '*');
    const hasSkill = /^[*a]?\d{0,2}[SREABDF]/i.test(b);
    const b2 = hasSkill ? prefix + b : (prefix + b).replace(/^([*a]?\d{0,2})/, `$1${comp.skill}`);
    const e2 = parseSkill(b2, { ...ctx2, compoundOf: e1 });
    if (!/[#+!\-/=]/.test(b) && comp.map[e1.ev] !== undefined && comp.map[e1.ev] !== null) e2.ev = comp.map[e1.ev];
    if (e2.skill === 'R' || e2.skill === 'B' || e2.skill === 'D') {
      if (!/[#+!\-/=]/.test(a) && comp.map) {
        // valutazione del primo codice ricavata dal secondo se non specificata
        const inv = Object.entries(comp.map).find(([, v]) => v === e2.ev);
        if (inv && /[#+!\-/=]/.test(b)) e1.ev = inv[0];
      }
    }
    return [e1, e2];
  }
  return [parseSkill(s, ctx)];
}

export function parseSkill(raw, ctx = {}) {
  let s = raw;
  let team = null;
  if (s[0] === 'a' || s[0] === '*') { team = s[0]; s = s.slice(1); }
  let num = null;
  let m = s.match(/^(\d{1,2})/);
  if (m) { num = +m[1]; s = s.slice(m[1].length); }
  let r = s.toUpperCase();
  if (!/[A-Z]/.test(r)) throw new Error('codice senza fondamentale');
  // valutazione: ultima occorrenza di un simbolo di valutazione
  let ev = null;
  for (let i = r.length - 1; i >= 0; i--) {
    if (EVAL_SET.has(r[i])) { ev = r[i]; r = r.slice(0, i) + r.slice(i + 1); break; }
  }
  let skill = null;
  if (SKILL_SET.has(r[0])) { skill = r[0]; r = r.slice(1); }
  const e = { kind: 'skill', team, num, skill, type: null, ev, combo: null, target: null, sz: null, ez: null, esz: null, stype: null, nb: null, special: null, custom: '' };
  let i = 0;
  const peek = () => r[i];
  const take = (n = 1) => { const v = r.slice(i, i + n); i += n; return v; };
  const tilde = () => { if (peek() === '~') { i++; return true; } return false; };
  // tipo
  if (!tilde() && TYPE_SET.has(peek()) && !(COMBO_RE.test(r.slice(i, i + 2)) && !skill)) e.type = take();
  // combinazione / chiamata
  if (!tilde()) {
    const two = r.slice(i, i + 2);
    if ((skill == null || skill === 'A') && (ATTACK_CODES.has(two) || (COMBO_RE.test(two) && skill === 'A'))) { e.combo = take(2); if (!skill) skill = 'A'; }
    else if ((skill == null || skill === 'E') && CALL_RE.test(two)) { e.combo = take(2); if (!skill) skill = 'E'; }
  } else if (peek() === '~') i++;
  if (!skill) skill = 'D';
  e.skill = skill;
  // target alzata
  if (!tilde() && skill === 'E' && 'FCBPS'.includes(peek() || '#')) e.target = take();
  // zone
  const digits = [];
  const zoneSlots = () => {
    for (let k = 0; k < 2; k++) {
      if (tilde()) { digits.push(null); continue; }
      if (/[1-9]/.test(peek() || '')) digits.push(+take()); else break;
    }
  };
  zoneSlots();
  if (digits.length === 1 && digits[0] != null && ((skill === 'A' && e.combo) || skill === 'E')) { e.ez = digits[0]; }
  else { e.sz = digits[0] ?? null; e.ez = digits[1] ?? null; }
  if (digits.length > 0 || i > 0) {
    if (!tilde() && /[A-D]/.test(peek() || '') && (e.ez != null) && !(skill === 'B' && !e.ez)) e.esz = take();
  }
  // sottotipo (13)
  if (!tilde() && STYPE[skill] && STYPE[skill].includes(peek() || '#')) e.stype = take();
  // numero muri / giocatori (14)
  if (!tilde() && /[0-9]/.test(peek() || '')) e.nb = +take();
  // speciale (15)
  if (!tilde() && SPECIAL_CHARS[skill] && SPECIAL_CHARS[skill].includes(peek() || '#')) e.special = take();
  if (i < r.length) e.custom = r.slice(i).replace(/~+$/, '').slice(0, 5);

  completeSkill(e, ctx);
  return e;
}

// Completa i campi mancanti usando il contesto (squadra, giocatore, tipo, zone)
export function completeSkill(e, ctx = {}) {
  const prev = ctx.compoundOf || ctx.prevSkill || null;
  if (!e.team) {
    if (e.skill === 'S') e.team = ctx.serving || '*';
    else if (e.skill === 'R') e.team = ctx.serving ? other(ctx.serving) : 'a';
    else e.team = ctx.ballOwner || ctx.serving || '*';
  }
  const atk = e.skill === 'A' && e.combo ? attackInfo(e.combo, ctx.attackTable) : null;
  if (atk) {
    if (!e.type) e.type = atk.type;
    if (e.sz == null) e.sz = atk.zone;
  }
  if (!e.type) {
    if (e.skill === 'S' && ctx.serveType) e.type = ctx.serveType(e.team, e.num ?? ctx.p1?.[e.team]) || null;
    if (!e.type && prev && ((e.skill === 'R' && prev.skill === 'S') || ((e.skill === 'B' || e.skill === 'D') && prev.skill === 'A') || (e.skill === 'D' && prev.skill === 'B'))) e.type = prev.type;
    if (!e.type) e.type = ctx.defaults?.type || 'H';
  }
  if (prev && e.skill === 'R' && prev.skill === 'S') {
    if (e.sz == null) e.sz = prev.sz;
    if (e.ez == null) e.ez = prev.ez;
    if (e.esz == null) e.esz = prev.esz;
  }
  if (prev && e.skill === 'D' && prev.skill === 'A' && prev.team !== e.team) {
    if (e.sz == null) e.sz = prev.sz;
    if (e.ez == null) e.ez = prev.ez;
    if (e.esz == null) e.esz = prev.esz;
  }
  if (!e.ev) e.ev = ctx.defaults?.eval?.[e.skill] || '+';
  if (e.skill === 'A' && !e.stype) e.stype = 'H';
  if (e.num == null) {
    if (e.skill === 'S') e.num = ctx.p1?.[e.team] ?? null;
    else if (e.skill === 'E') e.num = ctx.setter?.[e.team] ?? null;
    if (e.num == null && ctx.predict) {
      const zone = e.skill === 'R' || e.skill === 'D' ? e.ez : e.sz;
      e.num = ctx.predict(e.team, e.skill, zone) ?? null;
    }
    e.inferredPlayer = true;
  }
  return e;
}

// --------- descrizioni leggibili ---------
export function describe(e, lookup = () => null) {
  if (!e) return '';
  const tn = (t) => lookup?.names?.[t] || (t === '*' ? 'Casa' : 'Ospiti');
  switch (e.kind) {
    case 'point': return `Punto ${tn(e.team)}`;
    case 'timeout': return `Time-out ${tn(e.team)}`;
    case 'sub': return `Cambio ${tn(e.team)}: esce ${e.out}, entra ${e.in}`;
    case 'setter': return `Palleggiatore ${tn(e.team)}: ${e.num}`;
    case 'rotset': return `Rotazione ${tn(e.team)}: P${e.pos}`;
    case 'rot': return `Correzione rotazione ${tn(e.team)} (${e.dir > 0 ? 'avanti' : 'indietro'})`;
    case 'lineup': return `Formazioni set ${e.set}`;
    case 'endset': return 'Fine set';
    case 'side': return 'Cambio campo';
    case 'segment': return `Nuova sequenza (montaggio)${e.serve ? ` — batte ${tn(e.serve)}` : ''}${e.label ? `: ${e.label}` : ''}`;
    case 'green': return `Codice verde ${tn(e.team)} ${e.ev}`;
    case 'comment': return `Nota: ${e.text}`;
    case 'skill': {
      const p = lookup(e.team, e.num);
      const who = `${tn(e.team)} ${e.num != null ? '#' + e.num : '??'}${p ? ' ' + p.lastName : ''}`;
      const parts = [who, SKILLS[e.skill]];
      const tt = (TYPE_TEXT[e.skill] || TYPE_TEXT.default)[e.type];
      if (tt && e.skill !== 'D') parts.push(tt.toLowerCase());
      if (e.combo) {
        const a = attackInfo(e.combo);
        parts.push(e.combo + (a ? ` (${a.description})` : ''));
      }
      if (e.target) parts.push('→ ' + (SET_TARGETS[e.target] || e.target));
      if (e.sz || e.ez) parts.push(`z${e.sz ?? '-'}→${e.ez ?? '-'}${e.esz || ''}`);
      const st = SKILL_SUBTYPES[e.skill]?.[e.stype];
      if (st && e.skill !== 'A') parts.push(st.toLowerCase());
      if (st && e.skill === 'A' && e.stype !== 'H') parts.push(st.toLowerCase());
      if (e.nb != null && (e.skill === 'A' || e.skill === 'B')) parts.push(`${e.nb} a muro`);
      parts.push('— ' + (EVAL_TEXT[e.skill]?.[e.ev] || e.ev));
      const sp = SPECIAL[e.skill]?.[e.ev]?.[e.special];
      if (sp) parts.push(`(${sp})`);
      return parts.join(' ');
    }
    default: return '';
  }
}

// Esito del rally implicato da una riga: squadra che vince il punto o null
export function rallyWinner(e) {
  if (!e || e.kind !== 'skill') return null;
  if (e.ev === '#' && (e.skill === 'S' || e.skill === 'A' || e.skill === 'B')) return e.team;
  if (e.ev === '=') return other(e.team);
  if (e.ev === '/' && (e.skill === 'A' || e.skill === 'B')) return other(e.team);
  return null;
}
