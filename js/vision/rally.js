// Dagli eventi della palla (tocchi, rimbalzi) agli scambi e ai codici di scouting.
// Due modalità:
//  - 3D: calibrazione con il bordo della rete -> traiettorie balistiche 3D (precisa)
//  - 2D: solo omografia del pavimento -> tocchi dai cambi di traiettoria nell'immagine
import { buildTracks, buildChains, detectRallies as detect2D } from './tracker.js';
import { segmentFlights, segmentFlights3D, posAt, velAt, project, fitFlightThrough } from './ballistic.js';
import { applyH, xy2zone, xy2subzone, xy2serveZone, flipXY, receptionEvalAt } from '../lib/court.js';
import { ATTACK_TABLE, SIMPLIFIED_ATTACKS, ATTACK_EVAL_FROM_DIG, SERVE_EVAL_FROM_RECEPTION, other } from '../lib/constants.js';

const NET_Y = 9;
const sideOf = (X) => (X[1] < NET_Y ? 'near' : 'far');

// ---------- battuta ricostruita all'indietro ----------
// La palla della battuta dal fondo lontano è piccola e va verso la telecamera: il suo volo è mal
// condizionato. Ma termina nella ricezione, ben visibile: vincolando il volo a passare per il punto
// di ricezione si stima la velocità d'arrivo e lo si percorre all'indietro fino a dietro la linea di fondo.
export function reconstructServe(P, pts, s0) {
  const pre = pts.filter((q) => q.t < s0.t0 - 0.02);
  if (pre.length < 8) return null;
  let best = null;
  for (let ta = s0.t0 - 0.16; ta <= s0.t0 + 1e-6; ta += 0.02) {
    const A = posAt(s0.fit, ta);
    if (A[2] < -0.3 || A[2] > 3.6) continue;
    for (const n of [8, 12, 16, 20, 25, pre.length]) {
      const obs = pre.slice(-n);
      if (obs.length < 8) continue;
      const f = fitFlightThrough(P, obs, ta, A);
      if (f && (!best || f.rms < best.f.rms)) best = { f, ta, A, obs };
    }
  }
  if (!best || best.f.rms > 2.6) return null;
  const { f, ta, A, obs } = best;
  const far = A[1] < NET_Y; // ricezione nel campo vicino -> battuta dal fondo lontano
  // all'indietro fino a dietro la linea di fondo della metà opposta
  let tb = null;
  for (let t = obs[0].t; t > obs[0].t - 1.6; t -= 0.01) {
    const q = posAt(f, t);
    if (far ? q[1] >= 18.5 : q[1] <= -0.5) { tb = t; break; }
  }
  if (tb == null) return null;
  const X = posAt(f, tb), v = velAt(f, tb);
  const speed = Math.hypot(...v);
  if (X[2] < 1.5 || X[2] > 4.2 || speed < 7 || speed > 40 || (far ? v[1] > -4 : v[1] < 4)) return null;
  return {
    serve: { t: tb, X, vin: null, vout: v, kind: 'touch', side: sideOf(X), speedOut: speed, conf: 0.45, virtual: true, reconstructed: true },
    reception: { t: ta, X: A, vin: velAt(f, ta), vout: velAt(s0.fit, ta), kind: 'touch', side: sideOf(A), conf: 0.6 },
    rms: f.rms,
  };
}

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
    let { segs, events } = segmentFlights(P, ch.pts, opts);
    // seconda passata 3D sulle sole osservazioni dei voli buoni: tocchi e profondità decisi
    // insieme (corregge i voli che si allontanano dalla telecamera, spezzati per errore)
    if (opts.seg3d !== false && segs.length) {
      const clean = ch.pts.filter((q, i) => segs.some((g) => i >= g.i && i < g.j));
      const r = segmentFlights3D(P, clean, opts);
      if (r && r.segs.length && r.rms < (opts.seg3dMaxRms ?? 2.2)) events = reconcile3D(events, r, segs);
    }
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
      if (!(isServeFlight(pp, vv) && pp[2] > 2.0)) {
        // si può guardare oltre solo un frammento spurio o un lancio di battuta (quasi verticale)
        const nearBase = pp[1] < 1.5 || pp[1] > 16.5;
        const junk = sg.j - sg.i < 8 || Math.hypot(vv[0], vv[1]) < 3 || (nearBase && sg.t1 - sg.t0 < 1.2);
        if (!junk) break;
        continue;
      }
      { virt = { t: sg.t0 - 0.02, X: pp, vin: null, vout: vv, kind: 'touch', side: sideOf(pp), speedOut: Math.hypot(...vv), conf: 0.6, virtual: true }; break; }
    }
    // nessuna battuta visibile: si prova a ricostruirla all'indietro dalla ricezione
    if (!virt && firstServe < 0) {
      const rec = reconstructServe(P, ch.pts, s0);
      if (rec) {
        const k = ev.findIndex((e) => e.t > rec.reception.t + 0.05);
        ev.splice(0, k < 0 ? ev.length : k, rec.serve, rec.reception);
        firstServe = 0;
      }
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
      const quickResume = prev && prev.landing && !prev.landing.extrapolated && ch.pts[0].t - prev.landing.t < 1.2 && ch.pts[0].t > prev.landing.t - 0.1 && p[2] > 1.5;
      if (quickResume) {
        const L = prev.landing;
        prev.touches.push(roundTouch({ t: L.t, X: [L.X[0], L.X[1], 0.6], kind: 'touch', side: sideOf(L.X), conf: 0.4 }));
        prev.landing = null;
      }
      const gapT = prev ? ch.pts[0].t - prev.obsEnd : null;
      if (prev && gapT > -0.1 && gapT < (opts.resumeGap ?? 2.0) && (!prev.landing || prev.landing.extrapolated)) {
        const resume = { t: s0.t0 - 0.02, X: p, vin: null, vout: v, kind: 'touch', side: sideOf(p), speedOut: Math.hypot(...v), conf: 0.35, virtual: true, missing: true };
        const more = [resume, ...ev.filter((e) => e.t > s0.t0 + 0.05)];
        if (opts.W) for (const e of more) { const q = project(P, [e.X[0], e.X[1], 0]); e.box = playerBoxFor(frames, q, opts.W, opts.H, e.t); e.foot = [+(q[0] / opts.W).toFixed(4), +(q[1] / opts.H).toFixed(4)]; }
        const landing = findLanding(more, segs);
        prev.touches.push(...more.map(roundTouch));
        prev.landing = landing;
        prev.end = landing ? landing.t : segs[segs.length - 1].t1;
        prev.path.push(...pathOf(ch, s0.t0, landing ? landing.t + 0.3 : prev.end));
        prev.obsEnd = segs[segs.length - 1].t1;
      }
      // gioco vero senza battuta riconosciuta (battuta fuori dall'inquadratura o ricostruita
      // male, video che comincia a scambio iniziato): si tiene lo scambio se ha più voli lunghi
      // e almeno due tocchi, segnalando la battuta mancante
      const realPlay = segs.length >= 3 && segs[segs.length - 1].t1 - segs[0].t0 >= 2.5 && ev.filter((e) => e.kind === 'touch').length >= 2;
      if (!realPlay || opts.requireServe) continue; // altrimenti: palleggi, riscaldamento, palla raccolta
      const first = { t: s0.t0 - 0.02, X: p, vin: null, vout: v, kind: 'touch', side: sideOf(p), speedOut: Math.hypot(...v), conf: 0.3, virtual: true, missing: true, noServe: true };
      ev.splice(0, 0, first);
    }
    const landing = findLanding(ev, segs);
    if (opts.W) for (const e of ev) { const q = project(P, [e.X[0], e.X[1], 0]); e.box = playerBoxFor(frames, q, opts.W, opts.H, e.t); e.foot = [+(q[0] / opts.W).toFixed(4), +(q[1] / opts.H).toFixed(4)]; }
    const t1 = landing ? landing.t + 0.3 : segs[segs.length - 1].t1;
    prev = { start: ev[0].t, end: landing ? landing.t : segs[segs.length - 1].t1, touches: ev.map(roundTouch), landing, mode: '3d', path: pathOf(ch, ev[0].t - 1, t1), obsEnd: segs[segs.length - 1].t1 };
    out.push(prev);
  }
  for (const r of out) delete r.obsEnd;
  return mergeOverlapping(out);
}

// Confronto tra i tocchi dei voli liberi e quelli della segmentazione 3D (prudente):
//  - un tocco senza corrispondente 3D entro 0,4 s era un volo spezzato a metà → tolto
//  - un tocco 3D senza corrispondente, ben sostenuto (voli adiacenti lunghi, cambio netto di
//    direzione), era stato perso → aggiunto con la posizione 3D
//  - i tocchi confermati restano come sono (la stima libera è più precisa quando c'è)
export function reconcile3D(events, r, segs = null) {
  // senza tocchi già visti (solo battuta o lancio) non si cambia nulla
  if (!events.some((e) => e.kind === 'touch')) return events;
  const ev3 = r.events, segs3 = r.segs;
  // i tocchi aggiunti devono stare dentro i voli già visti (non all'inizio: la battuta e il
  // lancio sono gestiti a parte)
  const tMin = segs?.length ? segs[0].t0 + 0.3 : -Infinity, tMax = segs?.length ? segs[segs.length - 1].t1 - 0.1 : Infinity;
  const strong = (k) => segs3[k] && segs3[k + 1] && segs3[k].j - segs3[k].i >= 10 && segs3[k + 1].j - segs3[k + 1].i >= 10;
  // posizione impossibile per un tocco (troppo alto, fuori dal palazzetto)
  const implausible = (X) => X[2] > 3.9 || X[0] < -2.5 || X[0] > 11.5 || X[1] < -8 || X[1] > 26;
  // per ogni tocco 3D, il tocco libero più vicino nel tempo (entro 0,4 s)
  const owner = new Map();
  ev3.forEach((m, k) => {
    let best = null;
    for (const e of events) if (Math.abs(e.t - m.t) <= 0.4 && (!best || Math.abs(e.t - m.t) < Math.abs(best.t - m.t))) best = e;
    if (best) owner.set(best, k);
  });
  const kept = [];
  for (const e of events) {
    const k = owner.get(e);
    if (k == null) {
      // senza corrispondente 3D: tolto se cade dentro un volo 3D ben sostenuto (era un volo
      // spezzato a metà), oppure se è un doppione di un tocco già associato
      const inside = segs3.find((g) => e.t > g.t0 + 0.1 && e.t < g.t1 - 0.1 && g.j - g.i >= 10);
      const dup = events.some((o) => o !== e && owner.has(o) && Math.abs(o.t - e.t) < 0.3);
      if (e.kind !== 'bounce' && (inside || dup)) continue;
      kept.push(e); continue;
    }
    const m = ev3[k];
    // stesso tocco ma dall'altra parte della rete, o in posizione impossibile, secondo la
    // ricostruzione 3D (coerente con tutti i voli): si usa la posizione 3D
    const otherSide = sideOf(m.X) !== sideOf(e.X) && Math.abs(m.X[1] - 9) > 2 && strong(k);
    if (e.kind === 'touch' && m.kind === 'touch' && (otherSide || (implausible(e.X) && !implausible(m.X) && strong(k)))) kept.push({ ...e, X: m.X, vin: m.vin, vout: m.vout, speedOut: m.speedOut, depth3d: true });
    else kept.push(e);
  }
  for (let k = 0; k < ev3.length; k++) {
    const e = ev3[k];
    if ([...owner.values()].includes(k) || e.t < tMin || e.t > tMax || events.some((o) => Math.abs(o.t - e.t) < 0.3)) continue;
    const A = segs3[k], B = segs3[k + 1];
    const support = A && B && A.j - A.i >= 8 && B.j - B.i >= 6 && e.angle > 30;
    if (support) kept.push({ ...e, conf: Math.min(e.conf, 0.6), added3d: true });
  }
  kept.sort((a, b) => a.t - b.t);
  return kept;
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
  return { t: r3(e.t), X: e.X.map(r3), kind: e.kind, side: e.side, conf: r3(e.conf ?? 0.5), speedOut: r3(e.speedOut ?? null), virtual: !!e.virtual, missing: !!e.missing, reconstructed: !!e.reconstructed, vout: e.vout ? e.vout.map(r3) : null, box: e.box || null, foot: e.foot || null };
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
    // tempi di gioco: una palla che passa la rete vola al massimo ~1,7 s (battuta) o ~1,1 s
    // (attacco, free ball); se il primo tocco visto di là arriva molto dopo, ed è alto vicino a
    // rete, prima ci sono stati tocchi non visti: ricezione/difesa (e l'alzata, se il tempo basta
    // per entrambe: questo tocco è allora l'attacco)
    if (i > 0 && prev && tm !== possTeam && tc.X[2] != null && tc.X[2] > 2.0 && Math.abs(tc.X[1] - NET_Y) < 3.5) {
      const flight = prev.skill === 'S' ? 1.7 : 1.1;
      const extra = tc.t - prev.tc.t - flight;
      if (tc.missing || extra > 0.4) {
        const lost = prev.skill === 'S' ? 'R' : 'D';
        const back = tc.side === 'near' ? [4.5, 3] : [4.5, 15];
        const both = extra > 1.2 && tc.X[2] > 2.3;
        const tLost = both ? prev.tc.t + Math.min(flight * 0.75, (tc.t - prev.tc.t) * 0.36) : tc.t - Math.min(1.0, (tc.t - prev.tc.t) * 0.45);
        seq.push({ tc: { t: tLost, X: [back[0], back[1], 0.8], side: tc.side, conf: 0.25, virtual: true }, team: tm, skill: lost, inferred: true, why: lost === 'R' ? 'Ricezione' : 'Difesa' });
        possTeam = tm; k = 1;
        if (both) {
          const sp = setterSpot(tc.side);
          seq.push({ tc: { t: tc.t - (tc.t - tLost) * 0.48, X: [sp[0], sp[1], 2.6], side: tc.side, conf: 0.25, virtual: true }, team: tm, skill: 'E', inferred: true, why: 'Alzata' });
          k = 2;
        }
      }
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
    else if (s.skill === 'R' || s.skill === 'D') {
      // dinamica di gioco: una palla rigiocata direttamente di là (ricezione o difesa "sbagliata")
      // vola in circa 1 s; se il tocco dopo (o l'atterraggio dall'altra parte) arriva molto più
      // tardi, in mezzo ci sono state alzata e attacco che il video non ha visto: si deducono
      const tNext = n ? n.tc.t : rally.landing?.t;
      const gap = tNext != null ? tNext - s.tc.t : 0;
      if (gap >= (ctx.minAttackGap ?? 1.9)) {
        const sp = setterSpot(s.tc.side), side = s.tc.side;
        const tE = s.tc.t + gap * 0.5, tA = s.tc.t + gap * 0.82;
        const ax = side === 'near' ? 1.2 : 7.8, ay = side === 'near' ? 8.0 : 10.0; // zona 4 vicino a rete
        seq.splice(i + 1, 0,
          { tc: { t: tE, X: [sp[0], sp[1], 2.6], side, conf: 0.25, virtual: true }, team: s.team, skill: 'E', inferred: true, why: 'Alzata' },
          { tc: { t: tA, X: [ax, ay, 3.0], side, conf: 0.25, virtual: true }, team: s.team, skill: 'A', inferred: true, why: 'Attacco' });
        i += 2;
        continue;
      }
      s.overpass = true;
    }
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
  } else if (!ctx.forceWinner) notes.push('Atterraggio non visto: assegnare il punto manualmente');
  // vincitore noto da fuori (dati ufficiali, cambio palla): le valutazioni si adeguano
  if (ctx.forceWinner) winner = ctx.forceWinner;

  // 3) valutazioni
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i], n = seq[i + 1];
    if (s.skill === 'R' || s.skill === 'D' || (s.skill === 'F' && i > 0 && seq[i - 1].team !== s.team)) {
      if (s.overpass) s.ev = '/';
      else if (!n) s.ev = winner && winner !== s.team ? '=' : '-';
      else if (n.team !== s.team) s.ev = '/';
      else if (n.inferred || s.inferred) s.ev = '+'; // tocco dedotto: qualità non nota
      else {
        // zone di valutazione: dove il palleggiatore gioca la palla (e a che altezza)
        s.ev = receptionEvalAt(n.tc.X[0], n.tc.X[1], s.tc.side === 'near', n.tc.X[2]);
        if (s.ev === '/') s.ev = '-';
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
    e.tk = T.indexOf(s.tc); // tocco rilevato corrispondente (-1 = dedotto)
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
  if (T[0]?.reconstructed) notes.push(`Battuta non vista, ricostruita all'indietro dalla traiettoria (${T[0].t.toFixed(1)} s): verificare`);
  for (const s of seq) if (s.inferred) { const o = s.why === 'Attacco' ? 'o' : 'a'; notes.push(`${s.why || 'Alzata'} non vist${o}, dedott${o} dai tempi di gioco (${s.tc.t.toFixed(1)} s): verificare`); }
  for (const s of seq) if (s.tc.missing) notes.push(`Possibile tocco non visto prima di ${s.e.skill} (${s.tc.t.toFixed(1)} s)`);
  const conf = seq.reduce((a, s) => a * Math.max(0.3, s.tc.conf ?? 0.5), 1) ** (1 / seq.length);
  return { events, notes, conf: +conf.toFixed(2), winner, serveTeam };
}
