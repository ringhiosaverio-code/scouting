// Raccolta auto-supervisionata di esempi per il riconoscitore della palla: la fisica fa da
// maestro. I candidati che appartengono a voli balistici lunghi e ben stimati sono la palla
// (positivi); quelli lontani da ogni volo, sulle sagome dei giocatori o fermi, no (negativi).
// Uso: node collect.mjs fotogrammi.rgba larghezza altezza fps calibrazione.json out.json [colore]
import { readFileSync, writeFileSync } from 'node:fs';
import { toGray, medianImage } from '../../js/vision/cv.js';
import { createPipe } from '../../js/vision/framepipe.js';
import { geometryFor } from '../../js/vision/analyzer.js';
import { buildTracks, buildChains } from '../../js/vision/tracker.js';
import { segmentFlights } from '../../js/vision/ballistic.js';
import { patchFeatures, PATCH } from '../../js/vision/ballnet.js';

const [file, W, H, fps, calFile, out, col = 'yellow'] = process.argv.slice(2);
const w = +W, h = +H, FS = w * h * 4;
const raw = readFileSync(file); const N = Math.floor(raw.length / FS);
const fr = (k) => new Uint8ClampedArray(raw.buffer, raw.byteOffset + k * FS, FS);
const grays = []; for (let k = 0; k < N; k++) grays.push(toGray(fr(k), w, h, 4, w, h));
const bg = medianImage(Array.from({ length: 25 }, (_, i) => grays[Math.floor((i + 0.5) * N / 25)]));
const pipe = createPipe(w, h, { ballColor: col }); pipe.setBg(bg);
const frames = [];
for (let k = 0; k < N; k++) { const r = pipe.push(fr(k), k / +fps); if (r.result) frames.push({ ...r.result, k: k - 1 }); }
const cal = JSON.parse(readFileSync(calFile));
const geo = geometryFor(cal, w, h, 2.43);
// voli balistici sicuri
const chains = buildChains(buildTracks(frames, {}), {});
const sure = new Map(); // fotogramma → [{x,y}]
for (const ch of chains) {
  const { segs } = segmentFlights(geo.P, ch.pts, {});
  for (const g of segs) {
    if (g.j - g.i < (+process.env.MINPTS || 8) || g.fit.rms > (+process.env.MAXRMS || 1.6)) continue;
    for (let i = g.i; i < g.j; i++) { const q = ch.pts[i]; const key = Math.round(q.t * +fps); (sure.get(key) || sure.set(key, []).get(key)).push(q); }
  }
}
const allChainPts = new Map();
for (const ch of chains) for (const q of ch.pts) { const key = Math.round(q.t * +fps); (allChainPts.get(key) || allChainPts.set(key, []).get(key)).push(q); }
// secondo maestro, locale: 5 fotogrammi consecutivi su una parabola liscia nell'immagine,
// lontano dai giocatori e in movimento (la palla in volo)
const byK = new Map(frames.map((f) => [Math.round(f.t * +fps), f]));
function smoothTrack(k, b) {
  if (b.inP) return false;
  const seq = [b];
  for (const dk of [-1, 1, -2, 2]) {
    const f = byK.get(k + dk); if (!f) return false;
    const ref = dk === -2 ? seq[1] : dk === 2 ? seq[2] : b;
    const pred = dk === -2 || dk === 2 ? { x: 2 * ref.x - b.x, y: 2 * ref.y - b.y } : b;
    const tol = dk === -1 || dk === 1 ? 25 : 4;
    let best = null, bd = tol;
    for (const c of f.balls) { const d = Math.hypot(c.x - pred.x, c.y - pred.y); if (d < bd) { bd = d; best = c; } }
    if (!best) return false;
    seq.push(best);
  }
  // seq: [k, k-1, k+1, k-2, k+2] → ordine temporale
  const P = [seq[3], seq[1], seq[0], seq[2], seq[4]];
  const v = Math.hypot(P[3].x - P[1].x, P[3].y - P[1].y) / 2;
  if (v < 1.5) return false;
  for (let i = 1; i < 4; i++) { const ax = P[i - 1].x - 2 * P[i].x + P[i + 1].x, ay = P[i - 1].y - 2 * P[i].y + P[i + 1].y; if (Math.hypot(ax, ay) > 2.2) return false; }
  return true;
}
const samples = [];
let pos = 0, neg = 0;
for (const f of frames) {
  const key = Math.round(f.t * +fps), k = key;
  if (k < 1 || k + 1 >= N) continue;
  const S = sure.get(key) || [], A = allChainPts.get(key) || [];
  for (const b of f.balls) {
    const isPos = S.some((q) => Math.hypot(q.x - b.x, q.y - b.y) < 1.5) || smoothTrack(key, b);
    const nearChain = A.some((q) => Math.hypot(q.x - b.x, q.y - b.y) < 6);
    let label = null;
    if (isPos) label = 1;
    else if (!nearChain && (b.inP || S.length)) label = 0; // c'è già una palla sicura altrove, oppure è su un giocatore
    if (label == null) continue;
    if (label === 0 && Math.random() > 0.35) continue; // meno negativi
    samples.push({ y: label, f: Array.from(patchFeatures(fr(k), grays[k - 1], grays[k], grays[k + 1], w, h, b)), m: [b.a, b.inP, b.col ? 1 : 0] });
    label ? pos++ : neg++;
  }
}
writeFileSync(out, JSON.stringify(samples));
console.log(file.split('/').pop(), 'fotogrammi', N, 'positivi', pos, 'negativi', neg);
