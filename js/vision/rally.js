// Dagli eventi della palla (tocchi, rimbalzi) agli scambi e ai codici di scouting.
// Due modalità:
//  - 3D: calibrazione con il bordo della rete -> traiettorie balistiche 3D (precisa)
//  - 2D: solo omografia del pavimento -> tocchi dai cambi di traiettoria nell'immagine
import { buildTracks, buildChains, detectRallies as detect2D } from './tracker.js';
import { segmentFlights, posAt, velAt, project } from './ballistic.js';
import { applyH, xy2zone, xy2subzone, xy2serveZone, flipXY } from '../lib/court.js';
import { ATTACK_TABLE, SIMPLIFIED_ATTACKS, ATTACK_EVAL_FROM_DIG, SERVE_EVAL_FROM_RECEPTION, other } from '../lib/constants.js';

const NET_Y = 9;
const sideOf = (X) => (X[1] < NET_Y ? 'near' : 'far');

// ---------- estrazione degli scambi ----------
// Riquadro (normalizzato 0..1) del giocatore che tocca: la sagoma i cui piedi sono più vicini
// alla proiezione a terra del punto di contatto (o che contiene la palla)
function frameAt(frames, t) {
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (frames[m].t < t) lo = m + 1; else hi = m; }
  return frames[lo];
}
export function playerBoxFor(frames, feetPx, W, H, t) {
  let best = null, bd = 1e9;
  for (const dt of [-0.15, -0.08, 0]) {
    const f = frameAt(frames, t + dt);
    if (!f) continue;
    for (const b of f.players) {
      const d = Math.hypot((b.x0 + b.x1) / 2 - feetPx[0], (b.y1 - feetPx[1]) * 0.7);
      if (d < bd) { bd = d; best = b; }
    }
  }
  if (!best || bd > W * 0.08) return null;
  return [best.x0 / W, best.y0 / H, best.x1 / W, best.y1 / H].map((v) => +v.toFixed(4));
}

export function extractRallies3D(frames, P, opts = {}) {
  const chains = buildChains(buildTracks(frames, opts), opts);
  const out = [];
  // battuta: contatto alto vicino/dietro la linea di fondo, palla veloce verso la rete (il lancio è lento)
  const isServeFlight = (q, vel) => !!vel && q[2] > 1.6 && Math.hypot(vel[0], vel[1]) > 8 && (q[1] < 2.0 ? vel[1] > 4 : q[1] > 16.0 ? vel[1] < -4 : false);
  const findLanding = (ev, segs) => {
    // un "rimbalzo" seguito a breve da altri tocchi nella stessa traiettoria era un tocco basso
    // (ricezione/difesa): dopo che la palla tocca terra lo scambio è finito
    for (let i = 0; i < ev.length; i++) {
      if (ev[i].kind !== 'bounce') continue;
      const later = ev.slice(i + 1).filter((e) => e.kind === 'touch' && e.t - ev[i].t < 1.6);
      if (later.length >= 1 && later.some((e) => e.X[2] > 1.5)) ev[i] = { ...ev[i], kind: 'touch', X: [ev[i].X[0], ev[i].X[1], Math.max(ev[i].X[2], 0.6)], conf: 0.5 };
    }
    const bi = ev.findIndex((e) => e.kind === 'bounce');
    if (bi >= 0) { const l = { t: ev[bi].t, X: ev[bi].X }; ev.length = bi; return l; }
    // estrapola l'atterraggio dell'ultimo volo se avviene poco dopo l'ultima osservazione
    const L = segs[segs.length - 1];
    for (let t = L.t1; t < L.t1 + 0.6; t += 0.01) {
      const q = posAt(L.fit, t);
      if (q[2] <= 0.11) return { t, X: q, extrapolated: true };
    }
    return null;
  };
  const pathOf = (ch, from, to) => ch.pts.filter((q, i) => i % 2 === 0 && q.t >= from && q.t <= to).map((q) => [+q.t.toFixed(3), +q.x.toFixed(1), +q.y.toFixed(1)]);
  let prev = null; // ultimo scambio, per riattaccare catene interrotte
  for (const ch of chains) {
    const { segs, events } = segmentFlights(P, ch.pts, opts);
    if (!segs.length) continue;
    const ev = events.map((e) => ({ ...e, side: sideOf(e.X) }));
    const s0 = segs[0];
    const v = velAt(s0.fit, s0.t0), p = posAt(s0.fit, s0.t0);
    let firstServe = ev.findIndex((e) => e.kind === 'touch' && isServeFlight(e.X, e.vout));
    // battuta all'inizio di uno dei primi voli (prima ci possono essere frammenti spuri o il lancio)
    let virt = null;
    if (firstServe > 3) firstServe = -1; // la battuta è all'inizio della catena
    for (const sg of firstServe >= 0 ? [] : segs.slice(0, 3)) {
      const vv = velAt(sg.fit, sg.t0), pp = posAt(sg.fit, sg.t0);
      if (!(isServeFlight(pp, vv) && pp[2] > 2.2 && Math.hypot(...vv) > 12)) {
        // si può guardare oltre solo un frammento spurio o un lancio di battuta (quasi verticale)
        const nearBase = pp[1] < 1.5 || pp[1] > 16.5;
        const junk = sg.j - sg.i < 8 || Math.hypot(vv[0], vv[1]) < 3 || (nearBase && sg.t1 - sg.t0 < 1.2);
        if (!junk) break;
        continue;
      }
      { virt = { t: sg.t0 - 0.02, X: pp, vin: null, vout: vv, kind: 'touch', side: sideOf(pp), speedOut: Math.hypot(...vv), conf: 0.6, virtual: true }; break; }
    }
    if (virt) {
      const k = ev.findIndex((e) => e.t > virt.t + 0.05);
      ev.splice(0, k < 0 ? ev.length : k, virt);
      firstServe = 0;
    } else if (firstServe > 0) ev.splice(0, firstServe);
    if (firstServe < 0) {
      // nessuna battuta: se riprende poco dopo uno scambio di cui non si è visto l'atterraggio,
      // è la continuazione dello stesso scambio (palla persa per qualche istante)
      // (anche se prima si era visto un "rimbalzo": se il gioco riprende subito con un volo alto
      // era un tocco basso, es. una ricezione)
      const quickResume = prev && prev.landing && !prev.landing.extrapolated && ch.pts[0].t - prev.landing.t < 1.2 && p[2] > 1.5;
      if (quickResume) {
        const L = prev.landing;
        prev.touches.push(roundTouch({ t: L.t, X: [L.X[0], L.X[1], 0.6], kind: 'touch', side: sideOf(L.X), conf: 0.4 }));
        prev.landing = null;
      }
      if (prev && ch.pts[0].t - prev.obsEnd < (opts.resumeGap ?? 2.0) && (!prev.landing || prev.landing.extrapolated)) {
        const resume = { t: s0.t0 - 0.02, X: p, vin: null, vout: v, kind: 'touch', side: sideOf(p), speedOut: Math.hypot(...v), conf: 0.35, virtual: true, missing: true };
        const more = [resume, ...ev.filter((e) => e.t > s0.t0 + 0.05)];
        if (opts.W) for (const e of more) { const q = project(P, [e.X[0], e.X[1], 0]); e.box = playerBoxFor(frames, q, opts.W, opts.H, e.t); }
        const landing = findLanding(more, segs);
        prev.touches.push(...more.map(roundTouch));
        prev.landing = landing;
        prev.end = landing ? landing.t : segs[segs.length - 1].t1;
        prev.path.push(...pathOf(ch, s0.t0, landing ? landing.t + 0.3 : prev.end));
        prev.obsEnd = segs[segs.length - 1].t1;
      }
      continue; // altrimenti: palleggi, riscaldamento, palla raccolta
    }
    const landing = findLanding(ev, segs);
    if (opts.W) for (const e of ev) { const q = project(P, [e.X[0], e.X[1], 0]); e.box = playerBoxFor(frames, q, opts.W, opts.H, e.t); }
    const t1 = landing ? landing.t + 0.3 : segs[segs.length - 1].t1;
    prev = { start: ev[0].t, end: landing ? landing.t : segs[segs.length - 1].t1, touches: ev.map(roundTouch), landing, mode: '3d', path: pathOf(ch, ev[0].t - 1, t1), obsEnd: segs[segs.length - 1].t1 };
    out.push(prev);
  }
  for (const r of out) delete r.obsEnd;
  return mergeOverlapping(out);
}

// Modalità 2D: H = omografia immagine(pixel di lavoro) -> metri sul pavimento
export function extractRallies2D(frames, Hpx, opts = {}) {
  const { rallies } = detect2D(frames, opts);
  const toFloor = (p) => { const q = applyH(Hpx, p); return [q.x, q.y, 0]; };
  const out = [];
  for (const r of rallies) {
    if (r.end - r.start < 1.5) continue;
    const ev = [];
    for (const e of r.events) {
      // senza altezza: posizione dai piedi del giocatore, altrimenti dalla palla proiettata a terra (approssimata)
      const X = e.kind === 'bounce' ? toFloor(e.img) : (e.feet ? toFloor(e.feet) : toFloor(e.img));
      ev.push({ t: e.t, X: [X[0], X[1], e.kind === 'bounce' ? 0 : null], kind: e.kind === 'bounce' ? 'bounce' : 'touch', side: sideOf(X), conf: (e.feet ? 0.45 : 0.25) });
    }
    const first = ev.findIndex((e) => e.kind === 'touch');
    if (first < 0) continue;
    ev.splice(0, first);
    const bi = ev.findIndex((e) => e.kind === 'bounce');
    let landing = null;
    if (bi >= 0) { landing = { t: ev[bi].t, X: ev[bi].X }; ev.length = bi; }
    if (!ev.length) continue;
    const path = r.path.filter((q, i) => i % 2 === 0 && q.t >= ev[0].t - 1).map((q) => [+q.t.toFixed(3), +q.x.toFixed(1), +q.y.toFixed(1)]);
    out.push({ start: ev[0].t, end: landing ? landing.t : r.end, touches: ev.map(roundTouch), landing, mode: '2d', path });
  }
  return mergeOverlapping(out);
}

const r3 = (v) => (v == null ? v : +v.toFixed(3));
function roundTouch(e) {
  return { t: r3(e.t), X: e.X.map(r3), kind: e.kind, side: e.side, conf: r3(e.conf ?? 0.5), speedOut: r3(e.speedOut ?? null), virtual: !!e.virtual, missing: !!e.missing, vout: e.vout ? e.vout.map(r3) : null, box: e.box || null };
}

function mergeOverlapping(rallies) {
  rallies.sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of rallies) {
    const last = out[out.length - 1];
    if (last && r.start < last.end - 0.2) { if (r.touches.length > last.touches.length) out[out.length - 1] = r; continue; }
    out.push(r);
  }
  // uno "scambio" di un solo tocco seguito subito da una battuta è il lancio di quella battuta
  // (la palla ricade nella metà di chi batte)
  return out.filter((r, i) => !(r.touches.length === 1 && out[i + 1] && out[i + 1].start - r.end < 1.0 &&
    r.landing && sideOf(r.landing.X) === r.touches[0].side));
}

// ---------- interpretazione: tocchi -> codici ----------
const inCourt = (X, tol = 0.05) => X[0] >= -tol && X[0] <= 9 + tol && X[1] >= -tol && X[1] <= 18 + tol;
const nearLine = (X, d = 0.4) => Math.min(Math.abs(X[0]), Math.abs(X[0] - 9), Math.abs(X[1]), Math.abs(X[1] - 18)) < d;

// metri (sistema telecamera) -> coordinate DataVolley canoniche (casa in basso)
export function toDV(X, homeNear) {
  const p = { x: +(0.5 + X[0] / 3).toFixed(3), y: +(0.5 + X[1] / 3).toFixed(3) };
  return homeNear ? p : flipXY(p);
}

// punto ideale di alzata per la squadra (tra zona 2 e 3, 1,5 m dalla rete), in metri
const setterSpot = (side) => (side === 'near' ? [6.0, 7.5] : [3.0, 10.5]);

function attackComboFor(zone, type, table) {
  const pref = SIMPLIFIED_ATTACKS;
  const c = table.filter((a) => a.zone === zone && a.type === type).sort((a, b) => (pref.indexOf(a.code) + 99) % 99 - (pref.indexOf(b.code) + 99) % 99);
  return c[0]?.code || null;
}

// ctx: { homeNear, serving (squadra al servizio prevista), rank(team, skill, zone) -> num,
//        p1: {'*','a'}, setter: {'*','a'}, attackTable, vtOffset }
export function interpretRally(rally, ctx) {
  const notes = [];
  const team = (side) => ((side === 'near') === ctx.homeNear ? '*' : 'a');
  const dv = (X) => toDV(X, ctx.homeNear);
  const T = rally.touches;
  if (!T.length) return { events: [], notes: ['nessun tocco'], conf: 0 };
  const serveTeam = team(T[0].side);
  if (ctx.serving && serveTeam !== ctx.serving) notes.push(`Batte ${serveTeam === '*' ? 'casa' : 'ospiti'} ma il servizio previsto era dell'altra squadra: verificare rotazione o lato campo`);
  // 1) fondamentali dalla sequenza dei possessi
  const seq = [];
  let possTeam = null, k = 0;
  for (let i = 0; i < T.length; i++) {
    const tc = T[i];
    const tm = team(tc.side);
    const prev = seq[seq.length - 1];
    let skill;
    // dopo un buco nella traccia, primo tocco alto e vicino a rete = alzata: prima c'è stato
    // un tocco non visto (ricezione o difesa) che si deduce
    if (i > 0 && tm !== possTeam && tc.missing && tc.X[2] != null && tc.X[2] > 2.0 && Math.abs(tc.X[1] - NET_Y) < 3.5) {
      const lost = prev && prev.skill === 'S' ? 'R' : 'D';
      const back = tc.side === 'near' ? [4.5, 3] : [4.5, 15];
      seq.push({ tc: { t: tc.t - 1.0, X: [back[0], back[1], 0.8], side: tc.side, conf: 0.25, virtual: true }, team: tm, skill: lost, inferred: true });
      possTeam = tm; k = 1;
    }
    if (i === 0) skill = 'S';
    else if (tm !== possTeam) {
      k = 1;
      const nearNet = Math.abs(tc.X[1] - NET_Y) < 1.0 && (tc.X[2] == null || tc.X[2] > 2.1);
      if (prev && prev.skill === 'A' && nearNet && tc.t - prev.tc.t < 0.45) { skill = 'B'; k = 0; }
      else if (prev && prev.skill === 'S') skill = 'R';
      else if (prev && prev.skill === 'F') skill = 'F';
      else skill = 'D';
    } else {
      k++;
      if (prev && prev.skill === 'B') skill = 'D'; // ricopertura dopo muro (squadra che attacca) — gestita sotto
      else skill = k === 2 ? 'E' : 'A';
      if (k > 3) notes.push('Più di tre tocchi consecutivi: probabile tocco spurio');
    }
    // dopo un muro: se tocca la squadra che ha attaccato è ricopertura, se tocca chi mura è difesa (k riparte)
    if (prev && prev.skill === 'B') {
      skill = 'D';
      k = 1;
    }
    possTeam = tm;
    seq.push({ tc, team: tm, skill });
  }
  // l'ultimo tocco di un possesso che passa la rete è un attacco (o free ball)
  for (let i = 1; i < seq.length; i++) {
    const s = seq[i], n = seq[i + 1];
    const crosses = n ? n.team !== s.team : (rally.landing ? sideOf(rally.landing.X) !== s.tc.side : false);
    if (!crosses || s.skill === 'S' || s.skill === 'B') continue;
    if (s.skill === 'E') {
      s.skill = 'A';
      const pr = seq[i - 1];
      // tra ricezione/difesa e attacco passa troppo tempo per un attacco di seconda:
      // c'è stata un'alzata non vista -> la si deduce (palleggiatore in campo)
      if (pr && pr.team === s.team && s.tc.t - pr.tc.t > (ctx.minSetGap ?? 1.4)) {
        const tm = pr.tc.t + (s.tc.t - pr.tc.t) * 0.48;
        const sp = setterSpot(s.tc.side);
        seq.splice(i, 0, { tc: { t: tm, X: [sp[0], sp[1], 2.6], side: s.tc.side, conf: 0.3, virtual: true }, team: s.team, skill: 'E', inferred: true });
        i++;
      } else s.secondBall = true;
    }
    else if (s.skill === 'A') { /* ok */ }
    else if (s.skill === 'R' || s.skill === 'D') s.overpass = true;
    if (s.skill === 'A' && s.tc.speedOut != null && s.tc.speedOut < 8 && (s.tc.X[2] ?? 3) < 2.4) s.skill = 'F';
  }
  // 2) vincitore dal punto di atterraggio
  let winner = null;
  const last = seq[seq.length - 1];
  if (rally.landing) {
    const L = rally.landing.X;
    if (inCourt(L)) winner = other(team(sideOf(L)));
    else winner = other(last.team);
    if (nearLine(L)) notes.push(`Palla vicino alla linea (${L[0].toFixed(1)}, ${L[1].toFixed(1)} m): verificare dentro/fuori`);
  } else notes.push('Atterraggio non visto: assegnare il punto manualmente');

  // 3) valutazioni
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i], n = seq[i + 1];
    if (s.skill === 'R' || s.skill === 'D' || (s.skill === 'F' && i > 0 && seq[i - 1].team !== s.team)) {
      if (s.overpass) s.ev = '/';
      else if (!n) s.ev = winner && winner !== s.team ? '=' : '-';
      else if (n.team !== s.team) s.ev = '/';
      else {
        const tgt = setterSpot(s.tc.side);
        const d = Math.hypot(n.tc.X[0] - tgt[0], n.tc.X[1] - tgt[1]);
        s.ev = d < 1.2 ? '#' : d < 2.2 ? '+' : d < 3.5 ? '!' : '-';
        s.dist = d;
      }
    }
  }
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i], n = seq[i + 1];
    if (s.skill === 'S') {
      if (n && n.skill === 'R') s.ev = SERVE_EVAL_FROM_RECEPTION[n.ev] || '+';
      else if (!n) s.ev = winner === s.team ? '#' : winner ? '=' : '+';
      else s.ev = '+';
    } else if (s.skill === 'E') {
      s.ev = n && n.skill === 'A' && n.team === s.team ? '+' : (!n && winner && winner !== s.team ? '=' : '-');
    } else if (s.skill === 'A') {
      if (!n) s.ev = winner === s.team ? '#' : winner ? '=' : '+';
      else if (n.skill === 'B') {
        const nn = seq[i + 2];
        if (!nn) s.ev = winner === s.team ? '#' : '/';
        else if (nn.team === s.team) s.ev = '!';
        else s.ev = nn.ev ? ATTACK_EVAL_FROM_DIG[nn.ev] || '+' : '+';
      } else if (n.skill === 'D') s.ev = ATTACK_EVAL_FROM_DIG[n.ev] || '+';
      else s.ev = '+';
    } else if (s.skill === 'B') {
      const nn = seq[i + 1];
      if (!nn) s.ev = winner === s.team ? '#' : '=';
      else s.ev = nn.team === s.team ? '+' : '!';
    } else if (s.skill === 'F' && !s.ev) s.ev = '+';
  }

  // 4) dettagli: zone, tempi, tipo di battuta e combinazione, giocatori
  const events = [];
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i], n = seq[i + 1];
    const p = dv(s.tc.X);
    const endX = n ? n.tc.X : rally.landing?.X;
    const e = { kind: 'skill', team: s.team, skill: s.skill, ev: s.ev || '+', type: 'H', combo: null, target: null, sz: null, ez: null, esz: null, stype: null, nb: null, special: null, custom: '' };
    e.start = p;
    if (endX) { e.end = dv(endX); e.ez = xy2zone(e.end.x, e.end.y); e.esz = xy2subzone(e.end.x, e.end.y); }
    e.sz = s.skill === 'S' ? xy2serveZone(p.x, p.y) : xy2zone(p.x, p.y);
    if (s.skill === 'S') {
      const z = s.tc.X[2], v = (s.tc.speedOut || 0) * 3.6;
      e.type = z == null ? 'H' : z > 2.95 && v > 68 ? 'Q' : z > 2.6 ? 'M' : 'H';
      if (v) e.custom = '';
    }
    if (s.skill === 'A') {
      const prevSet = seq[i - 1] && seq[i - 1].skill === 'E' && seq[i - 1].team === s.team ? seq[i - 1] : null;
      const dt = prevSet ? s.tc.t - prevSet.tc.t : null;
      e.type = dt == null ? 'H' : dt < 0.55 ? 'Q' : dt < 0.95 ? 'T' : 'H';
      e.combo = s.secondBall ? 'P2' : attackComboFor(e.sz, e.type, ctx.attackTable || ATTACK_TABLE);
      e.stype = s.tc.speedOut != null && s.tc.speedOut < 9 ? 'T' : 'H';
      if (prevSet) prevSet.type = e.type;
    }
    if (s.skill === 'R' || s.skill === 'D') { e.ez = e.sz; e.esz = xy2subzone(p.x, p.y); }
    s.e = e;
    events.push(e);
  }
  // tempo dell'alzata = tempo dell'attacco; ricezione = tipo battuta
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i];
    if (s.skill === 'E' && s.type) s.e.type = s.type;
    if ((s.skill === 'R') && seq[i - 1]) { s.e.type = seq[i - 1].e.type; s.e.sz = seq[i - 1].e.sz; }
    if ((s.skill === 'D' || s.skill === 'B') && seq[i - 1]?.skill === 'A') s.e.type = seq[i - 1].e.type;
  }
  // giocatori
  for (const s of seq) {
    const e = s.e;
    if (s.skill === 'S') e.num = ctx.p1?.[s.team] ?? null;
    else if (s.skill === 'E') e.num = ctx.setter?.[s.team] ?? null;
    else {
      const zone = s.skill === 'B' ? xy2zone(e.start.x, e.start.y) : e.sz;
      e.num = ctx.rank ? ctx.rank(s.team, s.skill, zone) : null;
    }
    e.vt = +(s.tc.t + (ctx.vtOffset || 0)).toFixed(2);
    e.auto = { conf: +(s.tc.conf ?? 0.5).toFixed(2), virtual: !!s.tc.virtual, speed: s.tc.speedOut ? Math.round(s.tc.speedOut * 3.6) : null, height: s.tc.X[2] != null ? +s.tc.X[2].toFixed(2) : null };
  }
  // asso: ricezione errata del giocatore più vicino all'atterraggio
  if (seq.length === 1 && seq[0].e.ev === '#' && rally.landing) {
    const L = dv(rally.landing.X);
    const rt = other(seq[0].team);
    const z = xy2zone(L.x, L.y);
    events.push({ kind: 'skill', team: rt, num: ctx.rank ? ctx.rank(rt, 'R', z) : null, skill: 'R', ev: '=', type: seq[0].e.type, combo: null, target: null, sz: seq[0].e.sz, ez: z, esz: xy2subzone(L.x, L.y), stype: null, nb: null, special: null, custom: '', end: L, vt: +(rally.landing.t + (ctx.vtOffset || 0)).toFixed(2), auto: { conf: 0.5 } });
  }
  if (winner) events.push({ kind: 'point', team: winner, vt: +((rally.landing?.t ?? rally.end) + (ctx.vtOffset || 0)).toFixed(2) });
  for (const s of seq) if (s.inferred) notes.push(`Alzata non vista, dedotta (${s.tc.t.toFixed(1)} s): verificare`);
  for (const s of seq) if (s.tc.missing) notes.push(`Possibile tocco non visto prima di ${s.e.skill} (${s.tc.t.toFixed(1)} s)`);
  const conf = seq.reduce((a, s) => a * Math.max(0.3, s.tc.conf ?? 0.5), 1) ** (1 / seq.length);
  return { events, notes, conf: +conf.toFixed(2), winner, serveTeam };
}
