// Dati ufficiali della partita (Legavolley: tabellino + punto a punto) dentro l'app:
// - caricamento dall'archivio incluso (data/legavolley/) o da una pagina salvata dal sito;
// - per ogni scambio proposto dall'analisi, lo scambio ufficiale corrispondente (set e punteggio);
// - correzione della proposta: chi batte e con che esito, attaccanti e attacco decisivo, muro
//   punto, ricezione errata sull'ace, chi vince il punto;
// - verifica: quanto l'analisi del video (prima delle correzioni) era giusta.
import { h, clear, toast, modal } from './dom.js';
import { parsePbp, parseMatch, packMatch, unpackMatch, nameScore, lineupFromBox } from '../lib/legavolley.js';
import { other } from '../lib/constants.js';

const DATA = new URL('../../data/legavolley/', import.meta.url);
let index = null;
const cache = new WeakMap();

export function officialOf(match) {
  const o = match.official;
  if (!o?.data) return null;
  let u = cache.get(o);
  if (!u) { u = unpackMatch(o.data); cache.set(o, u); }
  return u;
}
const homeIs = (match) => match.official?.homeIs ?? 0;
export const teamOf = (match, t) => (t == null ? null : t === homeIs(match) ? '*' : 'a');
export const idxOf = (match, team) => (team === '*' ? homeIs(match) : 1 - homeIs(match));

// scambio ufficiale che corrisponde allo stato attuale: k-esimo scambio del set, k = punti giocati
export function officialRally(match, cur) {
  const off = officialOf(match);
  if (!off || !cur) return null;
  const L = off.rallies.filter((r) => r.set === cur.set);
  const k = cur.score['*'] + cur.score.a;
  const r = L[k];
  if (!r) return null;
  const hi = idxOf(match, '*');
  return { r, k, ok: r.scoreBefore[hi] === cur.score['*'] && r.scoreBefore[1 - hi] === cur.score.a, before: [r.scoreBefore[hi], r.scoreBefore[1 - hi]] };
}

const ATT = new Set(['att', 'att_pt', 'att_err', 'att_blocked']);
const playerName = (off, match, team, num) => {
  const p = off.players[idxOf(match, team)]?.find((x) => x.number === num);
  return p ? `#${num} ${p.name.split(' ')[0]}` : `#${num}`;
};
export function describeOfficial(off, match, r) {
  const T = (t) => teamOf(match, t), nm = (t) => match.teams[T(t)]?.code || match.teams[T(t)]?.name;
  const parts = [`batte ${nm(r.serveTeam)} ${playerName(off, match, T(r.serveTeam), r.server)}`];
  const lab = { ace: 'ace', serve_err: 'errore in battuta', att_pt: 'attacco punto', att_err: 'errore in attacco', att_blocked: 'attacco murato', block_pt: 'muro punto', rec_err: 'ricezione errata', 'att_pt?': 'attacco (punto)', fault: 'fallo' };
  const atts = r.actions.filter((a) => ATT.has(a.kind));
  if (atts.length) parts.push(`${atts.length} attacc${atts.length === 1 ? 'o' : 'hi'}`);
  if (r.end && lab[r.end.kind]) parts.push(`${lab[r.end.kind]} ${nm(r.end.team)} ${playerName(off, match, T(r.end.team), r.end.num)}`);
  parts.push(`punto ${nm(r.winner)}`);
  return parts.join(' · ');
}

// ------------------------------------------------------------ correzione della proposta
// events: eventi proposti dall'analisi (skill + point); r: scambio ufficiale.
// Restituisce { events, notes (avvisi che fermano l'accettazione in serie), info (correzioni) }.
export function applyOfficial(events, r, match) {
  const T = (t) => teamOf(match, t);
  const notes = [], info = [];
  let ev = events.map((e) => ({ ...e }));
  const nm = (t) => match.teams[t]?.name || t;
  const srvTeam = T(r.serveTeam), winTeam = T(r.winner);
  const iS = ev.findIndex((e) => e.kind === 'skill' && e.skill === 'S');
  const S = ev[iS];
  const lastVt = () => ev.filter((e) => e.vt != null).reduce((a, e) => Math.max(a, e.vt), S?.vt ?? 0);
  const virt = (e) => ({ type: S?.type || 'H', combo: null, target: null, sz: null, ez: null, esz: null, stype: null, nb: null, special: null, custom: '', ...e, kind: 'skill', auto: { conf: 0.3, virtual: true, official: true } });
  if (!S || S.team !== srvTeam) {
    notes.push(`Secondo il punto a punto ufficiale batte ${nm(srvTeam)} (#${r.server}): controlla il lato del campo (⇅ Campo) o se questo è davvero uno scambio`);
    return { events: ev, notes, info, applied: false };
  }
  if (r.server != null) {
    if (S.num !== r.server) info.push(`battitore #${r.server}${S.num != null ? ` (proposto #${S.num})` : ''}`);
    S.num = r.server; S.official = true;
  }
  const cut = (i) => { ev = ev.slice(0, i + 1); };
  if (r.serve === 'serve_err') {
    if (S.ev !== '=') info.push('errore in battuta');
    S.ev = '='; cut(iS);
  } else if (r.serve === 'ace') {
    if (S.ev !== '#') info.push('ace');
    S.ev = '#';
    const re = r.actions.find((a) => a.kind === 'rec_err');
    let R = ev[iS + 1]?.kind === 'skill' && ev[iS + 1].skill === 'R' ? ev[iS + 1] : null;
    if (!R) R = virt({ team: other(srvTeam), skill: 'R', ev: '=', type: S.type, sz: S.sz, vt: +(S.vt + 1).toFixed(2) });
    R.ev = '=';
    if (re?.num != null) { R.num = re.num; R.official = true; }
    ev = [...ev.slice(0, iS + 1), R];
  } else {
    if (S.ev === '#' || S.ev === '=') { info.push('la battuta non ha chiuso lo scambio: ci sono tocchi non visti'); S.ev = '+'; }
    // attacchi: abbinati per squadra e in ordine a quelli rilevati (sottosequenza comune)
    const OA = r.actions.filter((a) => ATT.has(a.kind));
    const DA = ev.map((e, i) => [e, i]).filter(([e]) => e.kind === 'skill' && (e.skill === 'A' || e.skill === 'F'));
    const n = OA.length, m = DA.length;
    const L = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = T(OA[i].team) === DA[j][0].team ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const pairs = [];
    for (let i = 0, j = 0; i < n && j < m;) {
      if (T(OA[i].team) === DA[j][0].team && L[i][j] === L[i + 1][j + 1] + 1) { pairs.push([i, j]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
    }
    const changed = [];
    for (const [i, j] of pairs) {
      const e = DA[j][0];
      if (e.skill === 'F') e.skill = 'A';
      if (OA[i].num != null && e.num !== OA[i].num) changed.push(`#${OA[i].num}`);
      if (OA[i].num != null) { e.num = OA[i].num; e.official = true; }
    }
    if (changed.length) info.push(`attaccant${changed.length === 1 ? 'e' : 'i'} ${changed.join(', ')}`);
    if (n !== m) info.push(`il punto a punto riporta ${n} attacc${n === 1 ? 'o' : 'hi'}, il video ne ha ${m === 1 ? 'visto 1' : `visti ${m}`}`);
    // azione decisiva
    const end = r.end;
    const lastOA = n - 1;
    // attacco murato + muro punto: l'azione decisiva è l'attacco murato
    const dk = end?.kind === 'block_pt' && OA[lastOA]?.kind === 'att_blocked' ? 'att_blocked' : end?.kind;
    const pairOfLast = pairs.find(([i]) => i === lastOA);
    let iA = pairOfLast ? DA[pairOfLast[1]][1] : -1;
    if (end && ['att_pt', 'att_err', 'att_blocked'].includes(dk) && OA[lastOA]?.kind === dk) {
      const oa = OA[lastOA];
      if (iA < 0) {
        // attacco decisivo non visto: si aggiunge in coda (tempo stimato)
        const a = virt({ team: T(oa.team), skill: 'A', num: oa.num, ev: '+', vt: +(lastVt() + 0.6).toFixed(2) });
        ev = ev.filter((e) => e.kind !== 'point');
        ev.push(a); iA = ev.length - 1;
        info.push(`aggiunto l'attacco decisivo non visto (#${oa.num})`);
      }
      const A = ev[iA];
      A.official = true;
      if (dk === 'att_pt') {
        A.ev = '#';
        // dopo un attacco punto può restare solo il tocco (sbagliato) di muro o difesa avversario
        const nx = ev[iA + 1];
        if (nx?.kind === 'skill' && nx.team !== A.team && (nx.skill === 'B' || nx.skill === 'D')) { nx.ev = '='; cut(iA + 1); } else cut(iA);
      } else if (dk === 'att_err') { A.ev = '='; cut(iA); }
      else {
        A.ev = '/';
        const bp = r.actions.find((a) => a.kind === 'block_pt');
        let B = ev[iA + 1]?.kind === 'skill' && ev[iA + 1].skill === 'B' && ev[iA + 1].team !== A.team ? ev[iA + 1] : null;
        if (!B) { B = virt({ team: other(A.team), skill: 'B', ev: '#', type: A.type, vt: +(A.vt + 0.2).toFixed(2) }); ev.splice(iA + 1, 0, B); }
        B.ev = '#';
        if (bp?.num != null) { B.num = bp.num; B.official = true; }
        cut(iA + 1);
      }
    } else if (end && end.kind === 'rec_err') {
      const R = ev.find((e) => e.kind === 'skill' && e.skill === 'R');
      if (R) { R.ev = '='; if (end.num != null) R.num = end.num; R.official = true; cut(ev.indexOf(R)); }
    }
  }
  // punto
  const detWin = ev.find((e) => e.kind === 'point')?.team ?? events.find((e) => e.kind === 'point')?.team;
  ev = ev.filter((e) => e.kind !== 'point');
  if (winTeam) {
    if (detWin && detWin !== winTeam) info.push(`punto a ${nm(winTeam)} (il video indicava ${nm(detWin)})`);
    else if (!detWin) info.push(`punto a ${nm(winTeam)}`);
    ev.push({ kind: 'point', team: winTeam, vt: +(lastVt() + 0.5).toFixed(2) });
  }
  return { events: ev, notes, info, applied: true };
}

// ------------------------------------------------------------ verifica (scambi accettati)
// Per ogni scambio accettato si conserva ciò che il video aveva letto da solo (prima delle
// correzioni ufficiali) e lo si confronta con il punto a punto.
export function rawReading(events) {
  const sk = events.filter((e) => e.kind === 'skill');
  const S = sk.find((e) => e.skill === 'S');
  return {
    serveTeam: S?.team ?? null, server: S?.num ?? null, serveEv: S?.ev ?? null,
    winner: events.find((e) => e.kind === 'point')?.team ?? null,
    attacks: sk.filter((e) => e.skill === 'A').map((e) => [e.team, e.num ?? null]),
    lastAtt: (() => { const a = sk.filter((e) => e.skill === 'A').pop(); return a ? [a.team, a.num ?? null, a.ev] : null; })(),
  };
}
export function verifyReport(match, rallies) {
  const off = officialOf(match);
  if (!off) return null;
  const T = (t) => teamOf(match, t);
  const c = { n: 0, serve: [0, 0], server: [0, 0], winner: [0, 0], outcome: [0, 0], attacks: [0, 0], attackers: [0, 0], endPlayer: [0, 0] };
  const add = (k, ok) => { c[k][1]++; if (ok) c[k][0]++; };
  for (const ra of rallies) {
    if (ra.status !== 'accepted' || !ra.raw || !ra.off) continue;
    const r = off.rallies.filter((x) => x.set === ra.off.set)[ra.off.k];
    if (!r) continue;
    c.n++;
    const d = ra.raw;
    add('serve', d.serveTeam === T(r.serveTeam));
    if (d.serveTeam !== T(r.serveTeam)) continue;
    if (r.server != null) add('server', d.server === r.server);
    if (d.winner) add('winner', d.winner === T(r.winner));
    const outc = r.serve === 'ace' ? '#' : r.serve === 'serve_err' ? '=' : 'x';
    add('outcome', outc === 'x' ? d.serveEv !== '#' && d.serveEv !== '=' : d.serveEv === outc);
    const OA = r.actions.filter((a) => ATT.has(a.kind));
    add('attacks', OA.length === d.attacks.length);
    if (OA.length === d.attacks.length) OA.forEach((a, i) => { if (a.num != null && d.attacks[i][0] === T(a.team)) add('attackers', d.attacks[i][1] === a.num); });
    const la = OA[OA.length - 1];
    if (la && la.num != null && ['att_pt', 'att_err', 'att_blocked'].includes(la.kind) && r.actions[r.actions.length - 1] && d.lastAtt && d.lastAtt[0] === T(la.team)) add('endPlayer', d.lastAtt[1] === la.num);
  }
  return c;
}

// ------------------------------------------------------------ caricamento
async function loadIndex() {
  if (!index) {
    const r = await fetch(new URL('index.json', DATA));
    if (!r.ok) throw new Error('archivio Legavolley non disponibile');
    index = await r.json();
  }
  return index;
}
function setOfficial(app, pack, source) {
  const m = app.match;
  const s0 = nameScore(m.teams['*'].name, pack.teams[0]?.name) + nameScore(m.teams.a.name, pack.teams[1]?.name);
  const s1 = nameScore(m.teams['*'].name, pack.teams[1]?.name) + nameScore(m.teams.a.name, pack.teams[0]?.name);
  m.official = { id: pack.id, source, homeIs: s1 > s0 ? 1 : 0, data: pack, loaded: new Date().toISOString() };
  app.touch?.();
  app.save();
  const off = officialOf(m);
  toast(`Dati ufficiali caricati: ${pack.teams.map((t) => t.name).join(' – ')} · ${off.rallies.length} scambi nel punto a punto`, 'ok', 5000);
}
// pagine salvate dal sito (il browser non può scaricarle direttamente: il sito non lo consente)
async function fromFiles(app, files) {
  let m = null, rallies = null, id = null;
  for (const f of files) {
    const html = await f.text();
    if (html.includes('id="DIV_PbP"')) { rallies = parsePbp(html); id ||= +(html.match(/gara_(\d+)/)?.[1] || f.name.match(/(\d{4,})/)?.[1] || 0) || null; }
    else if (html.includes('Statistiche Squadra') || html.includes('DarkCol')) { m = parseMatch(html); id ||= +(html.match(/match\/(\d+)/)?.[1] || 0) || null; }
  }
  if (!rallies) throw new Error('nessuna pagina "Punto a Punto" tra i file scelti');
  m ||= { teams: [{ name: app.match.teams['*'].name }, { name: app.match.teams.a.name }], sets: [], players: [[], []] };
  setOfficial(app, packMatch(id, m, rallies), 'file');
}

export function openOfficialDialog(app, onDone) {
  const body = h('div', { class: 'col gap' });
  const list = h('div', { class: 'lega-list' });
  const search = h('input', { type: 'search', placeholder: 'Cerca squadra…', class: 'grow' });
  const file = h('input', { type: 'file', accept: '.html,.htm,text/html', multiple: true, onchange: async (e) => {
    try { await fromFiles(app, [...e.target.files]); dlg.close(); onDone?.(); } catch (err) { toast(err.message, 'error', 6000); }
  } });
  const draw = async () => {
    clear(list);
    let idx;
    try { idx = await loadIndex(); } catch (e) { list.append(h('p', { class: 'warn' }, e.message)); return; }
    const m = app.match, q = search.value.trim().toLowerCase();
    const score = (x) => Math.max(nameScore(m.teams['*'].name, x.home) + nameScore(m.teams.a.name, x.guest), nameScore(m.teams['*'].name, x.guest) + nameScore(m.teams.a.name, x.home));
    let rows = idx.matches.filter((x) => x.rallies > 0);
    rows = q ? rows.filter((x) => `${x.home} ${x.guest}`.toLowerCase().includes(q)) : rows.map((x) => ({ ...x, sc: score(x) })).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc || b.id - a.id);
    if (!rows.length) list.append(h('p', { class: 'muted' }, q ? 'Nessuna partita trovata.' : 'Nessuna partita dell\'archivio con queste squadre: cerca per nome o carica la pagina salvata.'));
    for (const x of rows.slice(0, 40)) {
      list.append(h('button', { class: 'btn lega-team', onclick: async () => {
        try {
          const r = await fetch(new URL(`${x.id}.json`, DATA));
          setOfficial(app, await r.json(), 'archivio');
          dlg.close(); onDone?.();
        } catch (e) { toast('Partita non disponibile: ' + e.message, 'error'); }
      } }, h('b', {}, `${x.home} – ${x.guest}`), h('span', { class: 'muted small' }, ` ${x.date} · ${x.sets.join('-')} · ${x.rallies} scambi${x.checked ? '' : ' · punto a punto incompleto'}`)));
    }
  };
  search.addEventListener('input', draw);
  body.append(
    h('p', {}, 'Il punto a punto ufficiale dice, per ogni scambio, chi batte, come finisce e chi fa punto. L\'analisi del video lo usa per correggersi e per misurare i propri errori; il riconoscimento dei giocatori impara dai numeri ufficiali.'),
    h('div', { class: 'row gap' }, search), list,
    h('details', {}, h('summary', {}, 'Partita non in archivio?'),
      h('p', { class: 'small' }, 'Apri sul sito Legavolley la pagina della partita e il suo "Punto a Punto" (ww2.legavolley.it/tabellini_online/gara_NUMERO.html), salvale con Ctrl+S (pagina HTML) e caricale qui:'), file),
    index?.updated ? h('p', { class: 'muted small' }, `Archivio aggiornato al ${index.updated}`) : null);
  const dlg = modal('Dati ufficiali Legavolley', body, { wide: true });
  draw();
}

// formazione di un set dal tabellino (posizioni di partenza) per la finestra delle formazioni
export function officialLineup(match, set) {
  const off = officialOf(match);
  if (!off) return null;
  const hi = idxOf(match, '*');
  const h0 = lineupFromBox(off.players[hi] || [], set), v0 = lineupFromBox(off.players[1 - hi] || [], set);
  const first = off.rallies.find((r) => r.set === set);
  return { h: h0, v: v0, serve: first ? teamOf(match, first.serveTeam) : null };
}

// riquadro nella scheda dell'analisi
export function officialCard(app, rerender) {
  const m = app.match, off = officialOf(m);
  const card = h('div', { class: 'card official-card' }, h('h3', {}, '📋 Dati ufficiali (Legavolley)'));
  if (!off) {
    card.append(h('p', { class: 'muted small' }, 'Carica il tabellino e il punto a punto della partita: l\'analisi si corregge con i dati ufficiali e misura quanto sbaglia.'),
      h('button', { class: 'btn', onclick: () => openOfficialDialog(app, rerender) }, '📋 Carica dati ufficiali'));
    return card;
  }
  const T = m.teams;
  const hi = homeIs(m);
  card.append(
    h('p', { class: 'small' }, `${off.teams[0]?.name} – ${off.teams[1]?.name}${off.date ? ` · ${off.date}` : ''} · ${off.sets.map((s) => s.score.join('-')).join(' ')} · ${off.rallies.length} scambi`),
    h('p', { class: 'small' }, `Casa nell'app (${T['*'].name}) = `, h('b', {}, off.teams[hi]?.name || '?'), ' ',
      h('button', { class: 'btn small', onclick: () => { m.official.homeIs = 1 - hi; app.save(); rerender(); } }, '⇄ Inverti squadre')),
    h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: m.official.apply !== false, onchange: (e) => { m.official.apply = e.target.checked; app.save(); rerender(); } }), ' Correggi le proposte con il punto a punto'),
  );
  const rep = verifyReport(m, m.analysis?.rallies || []);
  if (rep?.n) {
    const pc = ([a, b]) => (b ? `${a}/${b} (${Math.round((100 * a) / b)}%)` : '—');
    card.append(h('h4', {}, `Verifica del video su ${rep.n} scambi accettati`), h('table', { class: 'mini-table' },
      [['Squadra al servizio', rep.serve], ['Battitore', rep.server], ['Esito della battuta', rep.outcome], ['Chi vince il punto', rep.winner], ['Numero di attacchi', rep.attacks], ['Attaccanti', rep.attackers], ['Autore dell\'attacco decisivo', rep.endPlayer]]
        .map(([l, v]) => h('tr', {}, h('td', {}, l), h('td', { class: 'mono' }, pc(v))))),
    h('p', { class: 'muted small' }, 'Letture del video prima delle correzioni ufficiali. Il riconoscimento dei giocatori impara dai numeri ufficiali a ogni scambio accettato.'));
  }
  card.append(h('div', { class: 'row gap wrap' },
    h('button', { class: 'btn small', onclick: () => openOfficialDialog(app, rerender) }, 'Cambia partita'),
    h('button', { class: 'btn small', onclick: () => { delete m.official; app.save(); rerender(); } }, 'Rimuovi')));
  return card;
}
