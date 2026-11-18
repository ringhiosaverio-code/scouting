// Generatore di video sintetici di pallavolo con verità di base nota.
// Telecamera fissa dietro il fondo campo, giocatori come sagome, palla con
// traiettorie balistiche reali (gravità), rimbalzi a terra.
// Usato dai test del modulo di analisi automatica e per produrre video di prova.

import { DIGITS } from '../js/vision/digits.js';

const G = -9.81;

export function makeCamera(W = 640, H = 360, view = 'end') {
  // posizione e orientamento: dietro il fondo "vicino" (Y=0), rialzata;
  // 'side': di lato, oltre la laterale X = 9 (sistema destrorso: Y cresce verso destra nell'immagine)
  const C = view === 'side' ? [9 + 13, 9, 7] : [4.5, -13, 8];
  const target = view === 'side' ? [4.5, 9, 0] : [4.5, 8, 0];
  const f = norm(sub(target, C));
  const r = norm(cross(f, [0, 0, 1]));
  const u = cross(r, f);
  const focal = W * 1.0;
  const project = ([X, Y, Z]) => {
    const d = sub([X, Y, Z], C);
    const zc = dot(d, f);
    return { x: W / 2 + focal * dot(d, r) / zc, y: H / 2 - focal * dot(d, u) / zc, depth: zc };
  };
  return { W, H, project, focal };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };

// punti di calibrazione normalizzati (come li cliccherebbe l'utente)
export function calibrationPoints(cam) {
  const p = (X, Y) => { const q = cam.project([X, Y, 0]); return { x: q.x / cam.W, y: q.y / cam.H }; };
  const q3 = (X, Y, Z) => { const q = cam.project([X, Y, Z]); return { x: q.x / cam.W, y: q.y / cam.H }; };
  return { nl: p(0, 0), nr: p(9, 0), fr: p(9, 18), fl: p(0, 18), n3l: p(0, 6), n3r: p(9, 6), f3l: p(0, 12), f3r: p(9, 12), ntl: q3(0, 9, 2.43), ntr: q3(9, 9, 2.43) };
}

// Generatore pseudo-casuale deterministico
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Copione di uno scambio: elenco di tocchi in metri (X 0..9, Y 0..18; squadra "near" = Y<9)
// skill e squadra sono la verità di base.
export function scriptRally(kind = 'long', t0 = 1, server = 'near') {
  const r = scriptRallyNear(kind, t0);
  if (server === 'near') return r;
  // battuta dall'altra metà: specchia posizioni e lati
  const flip = (s) => (s === 'near' ? 'far' : 'near');
  const m = (p) => [9 - p[0], 18 - p[1], p[2]];
  return { touches: r.touches.map((x) => ({ ...x, side: flip(x.side), pos: m(x.pos) })), landing: { ...r.landing, pos: m(r.landing.pos) }, winner: flip(r.winner) };
}

function scriptRallyNear(kind, t0) {
  const T = [];
  let t = t0;
  const add = (dt, side, skill, X, Y, Z, extra = {}) => { t += dt; T.push({ t, side, skill, pos: [X, Y, Z], ...extra }); };
  // battuta dalla squadra vicina (P1, destra, dietro la linea di fondo)
  add(0, 'near', 'S', 7.6, -1.2, 2.9);
  if (kind === 'ace') {
    return { touches: T, landing: { t: t + 1.25, pos: [2.2, 16.5, 0] }, winner: 'near' };
  }
  if (kind === 'serr') {
    return { touches: T, landing: { t: t + 1.3, pos: [4.0, 18.9, 0] }, winner: 'far' };
  }
  add(1.25, 'far', 'R', 2.8, 15.5, 0.8);       // ricezione
  add(1.05, 'far', 'E', 2.8, 10.2, 2.6);       // alzata (vicino a rete, tra zona 2 e 3 di chi è lontano)
  add(1.15, 'far', 'A', 7.8, 10.4, 3.1);       // attacco dalla zona 4 di chi è lontano
  if (kind === 'kill') return { touches: T, landing: { t: t + 0.55, pos: [2.0, 3.0, 0] }, winner: 'far' };
  if (kind === 'out') return { touches: T, landing: { t: t + 0.6, pos: [9.8, 1.0, 0] }, winner: 'near' };
  add(0.55, 'near', 'D', 2.2, 3.4, 0.7);       // difesa
  add(1.0, 'near', 'E', 6.3, 8.1, 2.6);        // alzata
  add(1.1, 'near', 'A', 0.9, 7.8, 3.1);        // attacco
  return { touches: T, landing: { t: t + 0.5, pos: [6.5, 14.5, 0] }, winner: 'near' };
}

// Traiettoria della palla: posizione 3D al tempo t (null se fuori dallo scambio)
export function ballPath(rally) {
  const segs = [];
  const pts = [...rally.touches.map((x) => ({ t: x.t, pos: x.pos })), { t: rally.landing.t, pos: rally.landing.pos }];
  // lancio di battuta: dalla mano (z 1.3) alla posizione di contatto
  const s0 = rally.touches[0];
  const toss = { t: s0.t - 0.9, pos: [s0.pos[0], s0.pos[1] + 0.15, 1.4] };
  segs.push(ballistic(toss, { t: s0.t, pos: s0.pos }));
  for (let i = 0; i + 1 < pts.length; i++) segs.push(ballistic(pts[i], pts[i + 1]));
  // rimbalzo dopo l'atterraggio
  const last = segs[segs.length - 1];
  const vIn = last.vel(rally.landing.t);
  const b0 = { t: rally.landing.t, pos: rally.landing.pos };
  const vb = [vIn[0] * 0.6, vIn[1] * 0.6, -vIn[2] * 0.45];
  segs.push({ t0: b0.t, t1: b0.t + 0.7, at: (tt) => { const d = tt - b0.t; return [b0.pos[0] + vb[0] * d, b0.pos[1] + vb[1] * d, Math.max(0.11, 0.11 + vb[2] * d + 0.5 * G * d * d)]; } });
  return {
    start: toss.t, end: b0.t + 0.7,
    at(tt) { const s = segs.find((x) => tt >= x.t0 && tt <= x.t1); return s ? s.at(tt) : null; },
  };
}

function ballistic(a, b) {
  const T = b.t - a.t;
  const v0 = [0, 1, 2].map((k) => (b.pos[k] - a.pos[k] - (k === 2 ? 0.5 * G * T * T : 0)) / T);
  return {
    t0: a.t, t1: b.t,
    at: (t) => { const d = t - a.t; return [a.pos[0] + v0[0] * d, a.pos[1] + v0[1] * d, a.pos[2] + v0[2] * d + (0) + 0.5 * G * d * d * 1]; },
    vel: (t) => { const d = t - a.t; return [v0[0], v0[1], v0[2] + G * d]; },
  };
}

// Giocatori: 6 per lato, si spostano verso il punto di contatto quando toccano
export function makePlayers(rally, rand) {
  const base = {
    near: [[7, 1.5], [7.2, 7.5], [4.5, 7.5], [1.8, 7.5], [1.8, 2], [4.5, 2.5]],
    far: [[2, 16.5], [1.8, 10.5], [4.5, 10.5], [7.2, 10.5], [7.2, 16], [4.5, 15.5]],
  };
  const players = [];
  for (const side of ['near', 'far']) {
    base[side].forEach(([x, y], i) => {
      const jx = (rand() - 0.5) * 1.6, jy = (rand() - 0.5) * 1.6;
      players.push({ side, i, home: [x + jx, y + jy], phase: rand() * 6, number: side === 'near' ? [1, 4, 7, 9, 11, 14][i] : [3, 6, 8, 10, 13, 15][i] });
    });
  }
  // assegna ogni tocco al giocatore più vicino del lato giusto
  for (const tc of rally.touches) {
    const cands = players.filter((p) => p.side === tc.side);
    let best = cands[0], bd = 1e9;
    for (const p of cands) { const d = Math.hypot(p.home[0] - tc.pos[0], p.home[1] - tc.pos[1]); if (d < bd && !(p.touches || []).some((x) => Math.abs(x.t - tc.t) < 1.6)) { bd = d; best = p; } }
    (best.touches ||= []).push(tc);
    tc.player = best.number;
  }
  return players;
}

export function playerPos(p, t) {
  // si muove verso il punto di contatto nei 0.8 s precedenti, poi torna
  let [x, y] = [p.home[0] + 0.35 * Math.sin(t * 0.9 + p.phase), p.home[1] + 0.35 * Math.cos(t * 0.7 + p.phase)];
  for (const tc of p.touches || []) {
    const dt = tc.t - t;
    const w = dt >= 0 ? Math.max(0, 1 - dt / 0.9) : Math.max(0, 1 + dt / 1.2);
    // i piedi stanno sotto/poco dietro il contatto
    const back = tc.side === 'near' ? -0.25 : 0.25;
    x = x * (1 - w) + tc.pos[0] * w;
    y = y * (1 - w) + (tc.pos[1] + back) * w;
  }
  return [x, y];
}

// ---- rendering RGB ----
export function makeRenderer(cam) {
  const { W, H } = cam;
  const bg = new Uint8ClampedArray(W * H * 3);
  // pavimento esterno
  fill(bg, W, H, [40, 70, 110]);
  const quad = (pts, col) => fillPoly(bg, W, H, pts.map((p) => cam.project(p)), col);
  quad([[0, 0, 0], [9, 0, 0], [9, 18, 0], [0, 18, 0]], [205, 140, 75]);
  const line = (a, b, col, w = 2) => drawLine(bg, W, H, cam.project(a), cam.project(b), col, w);
  for (const [a, b] of [[[0, 0, 0], [9, 0, 0]], [[9, 0, 0], [9, 18, 0]], [[9, 18, 0], [0, 18, 0]], [[0, 18, 0], [0, 0, 0]], [[0, 6, 0], [9, 6, 0]], [[0, 12, 0], [9, 12, 0]], [[0, 9, 0], [9, 9, 0]]]) line(a, b, [245, 245, 245], 2);
  // rete e pali
  quad([[-0.5, 9, 2.24], [9.5, 9, 2.24], [9.5, 9, 2.43], [-0.5, 9, 2.43]], [30, 30, 30]);
  line([-0.5, 9, 0], [-0.5, 9, 2.43], [200, 200, 200], 3);
  line([9.5, 9, 0], [9.5, 9, 2.43], [200, 200, 200], 3);

  // o.swapped: squadre scambiate di campo (colori invertiti); o.posOf(p, t): posizioni fuori dallo scambio
  return function render(t, players, ball, o = {}) {
    const img = new Uint8ClampedArray(bg);
    // giocatori dal più lontano al più vicino
    const ps = players.map((p) => ({ p, pos: o.posOf ? o.posOf(p, t) : playerPos(p, t) })).sort((a, b) => b.pos[1] - a.pos[1]);
    for (const { p, pos } of ps) {
      const feet = cam.project([pos[0], pos[1], 0]);
      const head = cam.project([pos[0], pos[1], 1.9]);
      const hw = cam.focal * 0.25 / feet.depth;
      const col = (p.side === 'near') !== !!o.swapped ? [30, 90, 220] : [210, 40, 40];
      fillRect(img, W, H, feet.x - hw, head.y, feet.x + hw, feet.y, col);
      fillRect(img, W, H, feet.x - hw * 0.6, head.y - hw * 0.9, feet.x + hw * 0.6, head.y, [230, 190, 160]);
      // numero di maglia (bianco) sul busto, con font bitmap a scala intera
      const sc = Math.max(1, Math.floor((feet.y - head.y) * 0.13 / 7));
      const str = String(p.number);
      let nx = Math.round(feet.x - (str.length * 6 - 1) * sc / 2);
      const ny = Math.round(head.y + (feet.y - head.y) * 0.18);
      for (const ch of str) {
        const g = DIGITS[ch];
        for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) if (g[gy][gx] === '1') fillRect(img, W, H, nx + gx * sc, ny + gy * sc, nx + gx * sc + sc - 1, ny + gy * sc + sc - 1, [245, 245, 245]);
        nx += 6 * sc;
      }
    }
    if (ball) {
      const c = cam.project(ball);
      const r = Math.max(1.6, cam.focal * 0.105 / c.depth);
      fillCircle(img, W, H, c.x, c.y, r, [250, 230, 40]);
    }
    return img;
  };
}

function fill(img, W, H, col) { for (let i = 0; i < W * H; i++) { img[i * 3] = col[0]; img[i * 3 + 1] = col[1]; img[i * 3 + 2] = col[2]; } }
function put(img, W, H, x, y, col) { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 3; img[i] = col[0]; img[i + 1] = col[1]; img[i + 2] = col[2]; }
function fillRect(img, W, H, x0, y0, x1, y1, col) { for (let y = Math.max(0, Math.round(y0)); y <= Math.min(H - 1, Math.round(y1)); y++) for (let x = Math.max(0, Math.round(x0)); x <= Math.min(W - 1, Math.round(x1)); x++) put(img, W, H, x, y, col); }
function fillCircle(img, W, H, cx, cy, r, col) { for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) put(img, W, H, x, y, col); }
function drawLine(img, W, H, a, b, col, w) { const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)); for (let k = 0; k <= n; k++) { const x = a.x + (b.x - a.x) * k / n, y = a.y + (b.y - a.y) * k / n; fillRect(img, W, H, x - w / 2, y - w / 2, x + w / 2, y + w / 2, col); } }
function fillPoly(img, W, H, pts, col) {
  const ys = pts.map((p) => p.y);
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(H - 1, Math.ceil(Math.max(...ys))); y++) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) xs.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(W - 1, Math.floor(xs[k + 1])); x++) put(img, W, H, x, y, col);
  }
}

// Sequenza di scambi con pause; restituisce { duration, frameAt(t) -> RGB, truth }
// breaks: { [indice scambio]: { type, dur } } pausa DOPO quello scambio:
//   'timeout'    giocatori alle panchine (fuori dalla laterale X = 0) e ritorno
//   'videocheck' giocatori fermi in campo; con replay: true, a metà pausa un replay (inquadratura diversa)
//   'setbreak'   giocatori fuori, poi le squadre rientrano scambiate di campo
//   'cutend'     montaggio: lo scambio è tagliato prima dell'atterraggio (primo piano per 3 s)
export function makeMatchClip({ W = 640, H = 360, kinds = ['long', 'kill', 'ace', 'out', 'serr'], seed = 7, gap = 4, view = 'end', breaks = {}, t0 = 2 } = {}) {
  const cam = makeCamera(W, H, view);
  const rand = rng(seed);
  const render = makeRenderer(cam);
  const close = makeCloseup(W, H);
  const rallies = [];
  const windows = [];
  let t = t0;
  let server = 'near', swapped = false;
  kinds.forEach((k, idx) => {
    const r = scriptRally(k, t, server);
    server = r.winner;
    const players = makePlayers(r, rand);
    const path = ballPath(r);
    rallies.push({ kind: k, ...r, players, path, swapped });
    const br = breaks[idx];
    const g = br && br.type !== 'cutend' ? br.dur : gap;
    if (br) windows.push({ ...br, after: idx, t0: br.type === 'cutend' ? r.landing.t - 0.35 : path.end, t1: br.type === 'cutend' ? r.landing.t + 3 : path.end + g, swappedBefore: swapped });
    if (br?.type === 'setbreak') { swapped = !swapped; server = 'near'; }
    t = path.end + g;
  });
  const duration = t;
  const bench = (p) => [-2.2 - 0.6 * (p.i % 2), (p.side === 'near' ? 2 : 11) + p.i];
  const frameAt = (tt) => {
    const w = windows.find((x) => tt >= x.t0 && tt <= x.t1);
    let cur = rallies[0];
    for (const r of rallies) if (tt >= r.path.start - (w ? 0.5 : gap / 2)) cur = r;
    if (w && w.type === 'cutend') return close(tt);
    if (w) {
      const prevR = rallies[w.after];
      const u = (tt - w.t0) / (w.t1 - w.t0);
      if (w.type === 'videocheck' && w.replay && u > 0.3 && u < 0.6) return close(tt);
      if (w.type === 'videocheck') return render(tt, prevR.players, null, { swapped: w.swappedBefore });
      // fuori campo: andata (8 s), sosta, ritorno (8 s)
      const walk = Math.min(1, (tt - w.t0) / 8, (w.t1 - tt) / 8);
      const nextR = rallies[w.after + 1] || prevR;
      const second = u > 0.5 && w.type === 'setbreak';
      const ps = second ? nextR.players : prevR.players;
      return render(tt, ps, null, {
        swapped: second ? !w.swappedBefore : w.swappedBefore,
        posOf: (p, t2) => { const a = playerPos(p, t2), b = bench(p); return [a[0] + (b[0] - a[0]) * walk, a[1] + (b[1] - a[1]) * walk]; },
      });
    }
    const b = cur.path.at(tt);
    return render(tt, cur.players, b, { swapped: cur.swapped });
  };
  return { cam, W, H, duration, frameAt, rallies, windows, calibration: calibrationPoints(cam) };
}

// inquadratura diversa (replay/primo piano): grandi forme che cambiano nel tempo
function makeCloseup(W, H) {
  return (t) => {
    const img = new Uint8ClampedArray(W * H * 3);
    fill(img, W, H, [120, 85, 50]);
    const k = Math.floor(t * 2);
    fillRect(img, W, H, W * 0.2 + 30 * Math.sin(k), H * 0.1, W * 0.55 + 30 * Math.sin(k), H, [30, 90, 220]);
    fillRect(img, W, H, W * 0.6, H * 0.25, W * 0.85, H, [230, 190, 160]);
    fillCircle(img, W, H, W * 0.75, H * 0.3, H * 0.15, [250, 230, 40]);
    return img;
  };
}
