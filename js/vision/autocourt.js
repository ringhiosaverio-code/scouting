// Calibrazione automatica del campo dalle linee (telecamera dietro una linea di fondo).
// 1) creste chiare e sottili (le linee) sull'immagine di sfondo
// 2) trasformata di Hough -> linee candidate (trasversali e laterali)
// 3) ipotesi "queste due trasversali sono le linee a Y=a e Y=b, queste sono le laterali":
//    omografia, proiezione del modello completo del campo, punteggio = linee spiegate
// 4) rifinitura: ogni linea del modello viene riadattata ai pixel vicini, punti = intersezioni
import { computeHomography, applyH } from '../lib/court.js';

const TRANSVERSE_Y = [0, 6, 9, 12, 18]; // metri: fondo vicino, 3 m, centrale, 3 m lontano, fondo lontano

export function ridgeMaps(rgb, W, H, channels = 3) {
  const lum = new Float32Array(W * H), sat = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = rgb[i * channels], g = rgb[i * channels + 1], b = rgb[i * channels + 2];
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    sat[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  const k = Math.max(2, Math.round(W / 400));
  const thr = 12;
  const rh = new Uint8Array(W * H), rv = new Uint8Array(W * H);
  for (let y = k; y < H - k; y++) {
    for (let x = k; x < W - k; x++) {
      const i = y * W + x, v = lum[i];
      if (sat[i] > 90) continue;
      // due scale: linee sottili (k) e più spesse (2k)
      for (const kk of [k, 2 * k]) {
        if (y >= kk && y < H - kk && v - Math.max(lum[i - kk * W], lum[i + kk * W]) > thr) rh[i] = 1; // linea quasi orizzontale
        if (x >= kk && x < W - kk && v - Math.max(lum[i - kk], lum[i + kk]) > thr) rv[i] = 1; // linea inclinata/verticale
      }
    }
  }
  const any = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) any[i] = rh[i] | rv[i];
  return { rh, rv, any, W, H };
}

// Hough: restituisce linee { theta, rho, votes } (normale (cos, sin), x cos + y sin = rho)
export function hough(mask, W, H, { thetaStep = 0.5, maxLines = 40, minVotes = null } = {}) {
  const nT = Math.round(180 / thetaStep);
  const diag = Math.ceil(Math.hypot(W, H));
  const nR = 2 * diag + 1;
  const acc = new Uint32Array(nT * nR);
  const cs = new Float32Array(nT), sn = new Float32Array(nT);
  for (let t = 0; t < nT; t++) { const a = (t * thetaStep) * Math.PI / 180; cs[t] = Math.cos(a); sn[t] = Math.sin(a); }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      for (let t = 0; t < nT; t++) acc[t * nR + Math.round(x * cs[t] + y * sn[t]) + diag]++;
    }
  }
  const min = minVotes ?? Math.round(Math.min(W, H) * 0.12);
  const peaks = [];
  for (let t = 0; t < nT; t++) for (let r = 0; r < nR; r++) { const v = acc[t * nR + r]; if (v >= min) peaks.push([v, t, r]); }
  peaks.sort((a, b) => b[0] - a[0]);
  const out = [];
  const dT = Math.round(3 / thetaStep), dR = Math.max(6, Math.round(W / 120));
  for (const [v, t, r] of peaks) {
    if (out.some((o) => Math.abs(o.t - t) <= dT && Math.abs(o.r - r) <= dR)) continue;
    out.push({ t, r, theta: t * thetaStep, rho: r - diag, votes: v });
    if (out.length >= maxLines) break;
  }
  return out;
}

// linea di Hough -> forma utile; angolo dell'orientamento della linea in gradi (0 = orizzontale)
function lineInfo(l) {
  const a = l.theta * Math.PI / 180;
  const n = [Math.cos(a), Math.sin(a)];
  const dir = [-n[1], n[0]];
  let ang = Math.atan2(dir[1], dir[0]) * 180 / Math.PI;
  if (ang < -90) ang += 180; if (ang > 90) ang -= 180;
  return { ...l, n, ang };
}
function intersect(a, b) {
  const det = a.n[0] * b.n[1] - a.n[1] * b.n[0];
  if (Math.abs(det) < 1e-9) return null;
  return { x: (a.rho * b.n[1] - b.rho * a.n[1]) / det, y: (a.n[0] * b.rho - b.n[0] * a.rho) / det };
}

function dilate(mask, W, H, r) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!mask[y * W + x]) continue;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < H && xx >= 0 && xx < W) out[yy * W + xx] = 1;
    }
  }
  return out;
}

// segmenti del modello del campo (metri) usati per il punteggio
function modelSamples() {
  const S = [[[0, 0], [0, 18], 's'], [[9, 0], [9, 18], 's']];
  for (const Y of TRANSVERSE_Y) S.push([[0, Y], [9, Y], Y]);
  return S;
}

// punteggio: campiona ogni linea proiettata a passi di 1 px (le linee lunghe valgono di più,
// un modello "collassato" in pochi pixel non può vincere)
function scoreH(Hm, evid, W, H, segs) {
  let inside = 0, hit = 0;
  for (const [[x0, y0], [x1, y1]] of segs) {
    const w0 = Hm[6] * x0 + Hm[7] * y0 + Hm[8], w1 = Hm[6] * x1 + Hm[7] * y1 + Hm[8];
    if (w0 <= 0 || w1 <= 0) return { score: -1e9, inside: 0, hit: 0 };
    const a = applyH(Hm, { x: x0, y: y0 }), b = applyH(Hm, { x: x1, y: y1 });
    const n = Math.min(4000, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
    for (let k = 0; k <= n; k++) {
      const x = Math.round(a.x + (b.x - a.x) * k / Math.max(1, n)), y = Math.round(a.y + (b.y - a.y) * k / Math.max(1, n));
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      inside++;
      if (evid[y * W + x]) hit++;
    }
  }
  return { score: hit - 0.5 * (inside - hit), inside, hit };
}

// immagine di sfondo RGB -> { points (normalizzati 0..1, chiavi REF_POINTS), H (metri->pixel), quality }
export function autoCalibrate(rgb, W, H, channels = 3, opts = {}) {
  const maps = ridgeMaps(rgb, W, H, channels);
  const lines = hough(maps.any, W, H, { maxLines: opts.maxLines ?? 40 }).map(lineInfo);
  const horiz = lines.filter((l) => Math.abs(l.ang) < 20).slice(0, opts.nTrans ?? 9);
  const steep = lines.filter((l) => Math.abs(l.ang) >= 20).slice(0, opts.nSteep ?? 10);
  if (horiz.length < 2 || steep.length < 2) return { ok: false, reason: 'linee del campo non trovate', lines: lines.length };
  const evid = dilate(maps.any, W, H, Math.max(1, Math.round(W / 480)));
  const samples = modelSamples();
  const views = opts.view && opts.view !== 'auto' ? [opts.view] : ['end', 'side'];
  let best = null;
  const tryModel = (src, dst, extra) => {
    let Hm;
    try { Hm = computeHomography(src, dst); } catch { return; }
    const sc = scoreH(Hm, evid, W, H, samples);
    if (!best || sc.score > best.s.score) best = { Hm, s: sc, ...extra };
  };
  const pairs = (arr) => { const o = []; for (let i = 0; i < arr.length; i++) for (let j = 0; j < arr.length; j++) if (i !== j) o.push([arr[i], arr[j]]); return o; };
  if (views.includes('end')) {
    // telecamera dietro una linea di fondo: trasversali orizzontali, laterali inclinate
    const left = steep.filter((l) => l.ang <= -20 && l.ang >= -85), right = steep.filter((l) => l.ang >= 20 && l.ang <= 85);
    for (const L of left) for (const R of right) for (const [tNear, tFar] of pairs(horiz)) {
      const a = intersect(tNear, L), b = intersect(tNear, R), c = intersect(tFar, R), d = intersect(tFar, L);
      if (!a || !b || !c || !d) continue;
      if (!(a.y > d.y + 5 && b.y > c.y + 5)) continue; // la trasversale "vicina" sta più in basso
      if (!(b.x - a.x > c.x - d.x)) continue; // prospettiva: il lato vicino appare più largo
      for (let p = 0; p < TRANSVERSE_Y.length; p++) for (let q = p + 1; q < TRANSVERSE_Y.length; q++) {
        const y0 = TRANSVERSE_Y[p], y1 = TRANSVERSE_Y[q];
        tryModel([{ x: 0, y: y0 }, { x: 9, y: y0 }, { x: 9, y: y1 }, { x: 0, y: y1 }], [a, b, c, d], { view: 'end' });
      }
    }
  }
  if (views.includes('side')) {
    // telecamera laterale: linee laterali (lunghe) orizzontali, trasversali inclinate.
    // Sistema destrorso: X = 0 laterale lontana (in alto), X = 9 laterale vicina; Y = 0 fondo a sinistra
    for (const [near, far] of pairs(horiz)) for (const [tL, tR] of pairs(steep)) {
      const a = intersect(far, tL), b = intersect(near, tL), c = intersect(near, tR), d = intersect(far, tR);
      if (!a || !b || !c || !d) continue;
      if (!(b.y > a.y + 5 && c.y > d.y + 5)) continue; // la laterale vicina sta più in basso
      if (!(a.x < d.x - 5 && b.x < c.x - 5)) continue; // trasversale sinistra a sinistra
      if (!(c.x - b.x > d.x - a.x)) continue; // prospettiva: il lato vicino appare più lungo
      for (let p = 0; p < TRANSVERSE_Y.length; p++) for (let q = p + 1; q < TRANSVERSE_Y.length; q++) {
        const y0 = TRANSVERSE_Y[p], y1 = TRANSVERSE_Y[q];
        tryModel([{ x: 0, y: y0 }, { x: 9, y: y0 }, { x: 9, y: y1 }, { x: 0, y: y1 }], [a, b, c, d], { view: 'side' });
      }
    }
  }
  if (!best || best.s.hit < Math.min(W, H) * 0.8) return { ok: false, reason: 'modello del campo non riconosciuto', best: best?.s };
  // rifinitura: ogni linea del modello riadattata ai pixel di cresta vicini
  const Hr = refine(best.Hm, maps, W, H);
  const pts = {};
  const ids = { nl: [0, 0], nr: [9, 0], fr: [9, 18], fl: [0, 18], n3l: [0, 6], n3r: [9, 6], cl: [0, 9], cr: [9, 9], f3l: [0, 12], f3r: [9, 12] };
  for (const [k, [x, y]] of Object.entries(ids)) {
    const q = applyH(Hr, { x, y });
    pts[k] = { x: +(q.x / W).toFixed(5), y: +(q.y / H).toFixed(5) };
  }
  const fin = scoreH(Hr, evid, W, H, samples);
  return { ok: true, view: best.view, points: pts, H: Hr, quality: +(fin.hit / Math.max(1, fin.inside)).toFixed(2), support: fin.hit, inside: fin.inside };
}

// riadatta le linee del modello ai pixel e ricalcola l'omografia dalle intersezioni
// (funziona per qualunque orientamento: rette ai minimi quadrati totali)
export function refine(Hm, maps, W, H, iters = 2) {
  let Hc = Hm;
  for (let it = 0; it < iters; it++) {
    const band = it === 0 ? Math.max(4, Math.round(W / 160)) : Math.max(2, Math.round(W / 320));
    const fitted = {};
    const defs = [['X0', 0, 'side'], ['X9', 9, 'side'], ...TRANSVERSE_Y.map((Y) => [`Y${Y}`, Y, 'trans'])];
    for (const [id, v, kind] of defs) {
      const a = kind === 'side' ? applyH(Hc, { x: v, y: 0 }) : applyH(Hc, { x: 0, y: v });
      const b = kind === 'side' ? applyH(Hc, { x: v, y: 18 }) : applyH(Hc, { x: 9, y: v });
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (!(len > 10)) continue;
      // linea quasi orizzontale -> creste orizzontali, altrimenti verticali
      const mask = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? maps.rh : maps.rv;
      const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      const P = [];
      const n = Math.ceil(len);
      for (let k = 0; k <= n; k++) {
        const px = a.x + (b.x - a.x) * k / n, py = a.y + (b.y - a.y) * k / n;
        let bestD = null;
        for (let d = -band; d <= band; d++) {
          const qx = Math.round(px + nx * d), qy = Math.round(py + ny * d);
          if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
          if (mask[qy * W + qx] && (bestD === null || Math.abs(d) < Math.abs(bestD))) bestD = d;
        }
        if (bestD !== null) P.push([px + nx * bestD, py + ny * bestD]);
      }
      let pts = P;
      let line = null;
      for (let r = 0; r < 3 && pts.length >= 10; r++) {
        line = tls(pts);
        const res = pts.map(([x, y]) => Math.abs(line.n[0] * x + line.n[1] * y - line.rho));
        const sd = Math.sqrt(res.reduce((s2, v2) => s2 + v2 * v2, 0) / res.length);
        pts = pts.filter((_, k) => res[k] <= Math.max(1.2, 2 * sd));
      }
      if (line && pts.length >= 10) fitted[id] = tls(pts);
    }
    const src = [], dst = [];
    for (const xs of ['X0', 'X9']) for (const Yv of TRANSVERSE_Y) {
      const sL = fitted[xs], tL = fitted[`Y${Yv}`];
      if (!sL || !tL) continue;
      const q = intersect(sL, tL);
      if (!q) continue;
      src.push({ x: xs === 'X0' ? 0 : 9, y: Yv }); dst.push(q);
    }
    if (src.length < 4) break;
    try { Hc = computeHomography(src, dst); } catch { break; }
  }
  return Hc;
}

// retta ai minimi quadrati totali: { n (normale unitaria), rho } con n·p = rho
function tls(pts) {
  const m = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) { sxx += (x - m[0]) ** 2; sxy += (x - m[0]) * (y - m[1]); syy += (y - m[1]) ** 2; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); // direzione principale
  const n = [-Math.sin(th), Math.cos(th)];
  return { n, rho: n[0] * m[0] + n[1] * m[1] };
}
