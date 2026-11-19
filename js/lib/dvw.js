// Import / export nel formato DataVolley (.dvw), compatibile con datavolley (R),
// ovscout2, DataVolley 4, VolleyStation e gli strumenti di analisi che leggono dvw.
import { ATTACK_TABLE, SETTER_CALLS, DV_WINNING_SYMBOLS, ROLES, DV_ROLE_TO_ROLE, other } from './constants.js';
import { skillCode, parseSkillCode, pad2 } from './codes.js';
import { xy2index, index2xy } from './court.js';
import { replay, rotate, setterPosition, newMatch, newPlayer, uid } from './engine.js';

const pad4 = (n) => (n == null ? '' : String(n).padStart(4, '0'));

function dvDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}
function hexToInt(hex) {
  const h = (hex || '#ffffff').replace('#', '');
  // DataVolley usa BGR
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (b << 16) + (g << 8) + r;
}
function intToHex(v) {
  const n = Number(v) || 0;
  const r = n & 255, g = (n >> 8) & 255, b = (n >> 16) & 255;
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function clockFor(match, e) {
  if (e.t) return e.t;
  const base = (match.meta.time || '00:00').split(':').map(Number);
  let secs = (base[0] || 0) * 3600 + (base[1] || 0) * 60 + (base[2] || 0) + Math.round((e.vt || 0) - (match.video.offset || 0));
  secs = ((secs % 86400) + 86400) % 86400;
  return [Math.floor(secs / 3600), Math.floor(secs / 60) % 60, secs % 60].map(pad2).join('.');
}

export function toDVW(match, rp = replay(match)) {
  const L = [];
  const now = new Date();
  const stamp = `${pad2(now.getMonth() + 1)}/${pad2(now.getDate())}/${now.getFullYear()} ${pad2(now.getHours())}.${pad2(now.getMinutes())}.${pad2(now.getSeconds())}`;
  const m = match.meta;
  L.push('[3DATAVOLLEYSCOUT]', 'FILEFORMAT: 2.0', `GENERATOR-DAY: ${stamp}`, 'GENERATOR-IDP: DVW', 'GENERATOR-PRG: VolleyScout Pro',
    'GENERATOR-REL: 1.0', 'GENERATOR-VER: web', `GENERATOR-NAM: ${m.scout || ''}`, `LASTCHANGE-DAY: ${stamp}`, 'LASTCHANGE-IDP: DVW',
    'LASTCHANGE-PRG: VolleyScout Pro', 'LASTCHANGE-REL: 1.0', 'LASTCHANGE-VER: web', `LASTCHANGE-NAM: ${m.scout || ''}`);
  L.push('[3MATCH]', `${dvDate(m.date)};${(m.time || '').replace(/:/g, '.')};${m.season || ''};${m.league || ''};${m.phase || ''};;;${m.matchNumber || ''};1;1;Z;0;`, ';;;;;;;;');
  L.push('[3TEAMS]');
  for (const t of ['*', 'a']) {
    const T = match.teams[t];
    L.push(`${T.code || ''};${T.name || ''};${rp.setsWon[t]};${T.coach || ''};${T.assistant || ''};${hexToInt(T.colour)};`);
  }
  L.push('[3MORE]', `${m.referees || ''};;;${m.city || ''};${m.venue || ''};${m.scout || ''};`, ';;;');
  L.push('[3COMMENTS]', (m.comments || '').replace(/[\r\n]+/g, ' '));
  L.push('[3SET]');
  for (let k = 0; k < 5; k++) {
    const s = rp.sets[k];
    if (!s) { L.push('True;;;;;;'); continue; }
    const pp = (p) => (p ? `${String(p['*']).padStart(2)}-${p.a}` : '');
    const dur = s.startVt != null && s.endVt != null ? Math.round((s.endVt - s.startVt) / 60) : '';
    L.push(`True;${pp(s.partials[8])};${pp(s.partials[16])};${pp(s.partials[21])};${pp(s.score)};${dur};`);
  }
  for (const [t, sec, side] of [['*', '[3PLAYERS-H]', 0], ['a', '[3PLAYERS-V]', 1]]) {
    L.push(sec);
    match.teams[t].players.forEach((p, idx) => {
      const num = Number(p.number);
      const starts = [0, 1, 2, 3, 4].map((k) => {
        const s = rp.sets[k];
        if (!s) return '';
        const j = s.startLineup[t].indexOf(num);
        if (j >= 0) return String(j + 1);
        if (s.subsIn[t].has(num) || (p.role === 'L' && s.libero[t].includes(num))) return '*';
        if (p.role === 'L') return '*';
        return '';
      });
      const special = p.role === 'L' ? 'L' : (p.captain ? 'C' : '');
      L.push(`${side};${num};${idx + 1};${starts.join(';')};${p.dvId || (match.teams[t].code || 'P') + num};${p.lastName || ''};${p.firstName || ''};;${special};${ROLES[p.role]?.dv ?? 6};${p.foreign ? 'True' : 'False'};;;`);
    });
  }
  L.push('[3ATTACKCOMBINATION]');
  for (const a of match.settings.attackTable || ATTACK_TABLE) L.push(`${a.code};${a.zone};${a.side};${a.type};${a.description};;${a.colour};${a.startCoord};${a.setType};;;`);
  L.push('[3SETTERCALL]');
  for (const c of SETTER_CALLS) L.push(`${c.code};;${c.description};;${c.colour};${pad4(c.start)};${pad4(c.mid)};${pad4(c.end)};${c.path ? c.path + ',' : ''};${c.pathColour};;`);
  L.push('[3WINNINGSYMBOLS]', DV_WINNING_SYMBOLS, '[3RESERVE]', '[3VIDEO]');
  if (match.video.name) L.push(`Camera0=${match.video.name}`);
  L.push('[3SCOUT]');

  const line = (code, row, extra = {}) => {
    const e = row.e;
    const pos = extra.pos || row.pos;
    const sp = extra.setterPos || row.setterPos;
    const coord = (p) => (p ? pad4(xy2index(p.x, p.y)) : '');
    const isSkill = e.kind === 'skill';
    return [
      code,
      isSkill ? row.phase || '' : '',
      isSkill ? row.aphase || '' : '',
      '',
      isSkill ? coord(e.start) : '',
      isSkill ? coord(e.mid) : '',
      isSkill ? coord(e.end) : '',
      clockFor(match, e.vt != null ? e : { vt: extra.vt ?? 0 }),
      row.set ?? '',
      sp?.['*'] ?? '',
      sp?.a ?? '',
      match.video.name ? 1 : '',
      e.vt != null ? Math.round(e.vt) : (extra.vt != null ? Math.round(extra.vt) : ''),
      '',
      ...(pos ? pos['*'] : ['', '', '', '', '', '']),
      ...(pos ? pos.a : ['', '', '', '', '', '']),
      '',
    ].join(';');
  };

  let lastVt = 0;
  for (const row of rp.rows) {
    const e = row.e;
    if (e.vt != null) lastVt = e.vt;
    const x = { vt: lastVt };
    switch (e.kind) {
      case 'lineup': {
        const pos = { '*': e.h, a: e.v };
        const sp = { '*': setterPosition(e.h, e.hSetter), a: setterPosition(e.v, e.vSetter) };
        const r2 = { ...row, set: e.set };
        L.push(line(`*P${pad2(e.hSetter)}>LUp`, r2, { ...x, pos, setterPos: sp }));
        L.push(line(`*z${sp['*']}>LUp`, r2, { ...x, pos, setterPos: sp }));
        L.push(line(`aP${pad2(e.vSetter)}>LUp`, r2, { ...x, pos, setterPos: sp }));
        L.push(line(`az${sp.a}>LUp`, r2, { ...x, pos, setterPos: sp }));
        break;
      }
      case 'skill':
        L.push(line(skillCode(e), row));
        break;
      case 'green':
        L.push(line(`${e.team}$$&${e.type || 'H'}${e.ev}`, row, x));
        break;
      case 'point': {
        L.push(line(`${e.team}p${pad2(row.scoreAfter['*'])}:${pad2(row.scoreAfter.a)}`, row, x));
        if (row.won !== row.serving) {
          const pos = { ...row.pos, [row.won]: rotate(row.pos[row.won]) };
          const sp = { ...row.setterPos, [row.won]: setterPosition(pos[row.won], row.setter[row.won]) };
          L.push(line(`${row.won}z${sp[row.won]}`, row, { ...x, pos, setterPos: sp }));
        }
        break;
      }
      case 'timeout':
        L.push(line(`${e.team}T`, row, x));
        break;
      case 'sub': {
        L.push(line(`${e.team}c${pad2(e.out)}:${pad2(e.in)}`, row, x));
        break;
      }
      case 'setter':
        L.push(line(`${e.team}P${pad2(e.num)}`, row, x));
        break;
      case 'rot':
      case 'rotset': {
        const nxt = rp.rows[row.i + 1];
        if (nxt) L.push(line(`${e.team}z${nxt.setterPos?.[e.team] ?? ''}`, nxt, x));
        break;
      }
      case 'endset':
        L.push(line(`**${row.set}set`, row, x));
        break;
      default:
    }
  }
  return L.join('\r\n') + '\r\n';
}

// ---------------- import ----------------
export function decodeBytes(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}

export function fromDVW(text) {
  const lines = text.split(/\r?\n/);
  const sec = {};
  let cur = null;
  for (const l of lines) {
    const m = l.match(/^\[3([A-Z-]+)\]/);
    if (m) { cur = m[1]; if (!sec[cur]) sec[cur] = []; continue; }
    if (cur && l.trim() !== '') sec[cur].push(l);
  }
  const match = newMatch();
  const mm = (sec.MATCH?.[0] || '').split(';');
  if (mm[0]) {
    const d = mm[0].match(/(\d+)\/(\d+)\/(\d+)/);
    if (d) {
      let [, a, b, y] = d;
      // MM/DD/YYYY (DV) — se il primo campo > 12 è DD/MM
      let mo = +a, da = +b;
      if (mo > 12) [mo, da] = [da, mo];
      match.meta.date = `${y.length === 2 ? '20' + y : y}-${pad2(mo)}-${pad2(da)}`;
    }
  }
  match.meta.time = (mm[1] || '').replace(/\./g, ':');
  match.meta.season = mm[2] || '';
  match.meta.league = mm[3] || '';
  match.meta.phase = mm[4] || '';
  match.meta.matchNumber = mm[7] || '';
  const more = (sec.MORE?.[0] || '').split(';');
  match.meta.referees = more[0] || '';
  match.meta.city = more[3] || '';
  match.meta.venue = more[4] || '';
  match.meta.scout = more[5] || '';
  match.meta.comments = (sec.COMMENTS || []).join(' ');
  (sec.TEAMS || []).slice(0, 2).forEach((l, k) => {
    const c = l.split(';');
    const T = match.teams[k === 0 ? '*' : 'a'];
    Object.assign(T, { code: c[0] || '', name: c[1] || '', coach: c[3] || '', assistant: c[4] || '', colour: c[5] ? intToHex(c[5]) : T.colour });
  });
  for (const [t, key] of [['*', 'PLAYERS-H'], ['a', 'PLAYERS-V']]) {
    match.teams[t].players = (sec[key] || []).map((l) => {
      const c = l.split(';');
      const special = (c[12] || '').trim();
      const role = special === 'L' ? 'L' : (DV_ROLE_TO_ROLE[+c[13]] || 'U');
      return newPlayer({ number: +c[1], dvId: c[8] || '', lastName: c[9] || '', firstName: c[10] || '', role, captain: special === 'C', foreign: c[14] === 'True' });
    });
  }
  const vid = (sec.VIDEO || []).find((l) => /^Camera0=/.test(l));
  if (vid) {
    const v = vid.slice(vid.indexOf('=') + 1).trim();
    match.video.name = v.split(/[\\/]/).pop().split('?')[0] || v;
    if (/^https?:\/\//i.test(v)) match.video.url = v; // video online indicato nel file
  }
  // file VolleyMetrics: convenzioni di valutazione proprie (lette come DataVolley standard)
  if (/volleymetric/i.test(text)) { match.meta.scout ||= 'VolleyMetrics'; match.meta.source = 'volleymetrics'; }

  const events = [];
  let pendingLineup = null;
  let setters = { '*': null, a: null };
  let setNo = 0;
  let homeNear = true;
  for (const l of sec.SCOUT || []) {
    const c = l.split(';');
    const code = c[0];
    if (!code) continue;
    const vt = c[12] !== '' && c[12] != null ? Number(c[12]) : null;
    const t = c[7] || null;
    const pos = (a, b) => c.slice(a, b).map(Number);
    let m;
    if ((m = code.match(/^([*a])P(\d+)>LUp/))) {
      setters[m[1]] = +m[2];
      if (!pendingLineup) {
        setNo++;
        pendingLineup = { kind: 'lineup', id: uid(), set: setNo, h: pos(14, 20), v: pos(20, 26), hSetter: null, vSetter: null, serve: null, homeNear };
        homeNear = !homeNear;
        events.push(pendingLineup);
      }
      pendingLineup[m[1] === '*' ? 'hSetter' : 'vSetter'] = +m[2];
      continue;
    }
    if (/^[*a]z\d>LUp/.test(code)) continue;
    if (/^[*a]z\d/.test(code)) continue; // rotazioni ricavate dal motore
    if ((m = code.match(/^\*\*(\d)set/))) { events.push({ kind: 'endset', id: uid() }); pendingLineup = null; continue; }
    if ((m = code.match(/^([*a])p(\d+):(\d+)/))) {
      if (pendingLineup && !pendingLineup.serve) pendingLineup.serve = m[1];
      events.push({ kind: 'point', id: uid(), team: m[1], vt });
      continue;
    }
    if ((m = code.match(/^([*a])c(\d+):(\d+)/))) { events.push({ kind: 'sub', id: uid(), team: m[1], out: +m[2], in: +m[3], vt }); continue; }
    if ((m = code.match(/^([*a])T/))) { events.push({ kind: 'timeout', id: uid(), team: m[1], vt }); continue; }
    if ((m = code.match(/^([*a])P(\d+)/))) { events.push({ kind: 'setter', id: uid(), team: m[1], num: +m[2], vt }); continue; }
    if ((m = code.match(/^([*a])\$\$&(.)(.)?/))) { events.push({ kind: 'green', id: uid(), team: m[1], type: m[2], ev: m[3] || '#', vt }); continue; }
    if (/^[*a]\d\d[SREABDF]/.test(code)) {
      const e = parseSkillCode(code);
      e.id = uid();
      e.vt = vt;
      e.t = t;
      const co = (s) => (s && +s > 0 ? index2xy(+s) : null);
      e.start = co(c[4]);
      e.mid = co(c[5]);
      e.end = co(c[6]);
      if (!e.start) delete e.start;
      if (!e.mid) delete e.mid;
      if (!e.end) delete e.end;
      if (e.skill === 'S' && pendingLineup && !pendingLineup.serve) pendingLineup.serve = e.team;
      events.push(e);
    }
  }
  for (const e of events) if (e.kind === 'lineup' && !e.serve) e.serve = '*';
  match.events = events;
  return match;
}

export { other };
