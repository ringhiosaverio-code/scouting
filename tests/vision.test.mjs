// Test dell'analisi automatica su video sintetico con verità di base nota.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatchClip } from '../tools/synth.mjs';
import { toGray, medianImage, processFrame } from '../js/vision/cv.js';
import { cameraMatrix, reprojError } from '../js/vision/ballistic.js';
import { extractRallies3D, extractRallies2D, interpretRally } from '../js/vision/rally.js';
import { computeHomography } from '../js/lib/court.js';

const clip = makeMatchClip();
const W = 480, H = 270, fps = 30, sx = W / clip.W;
const gray = (t) => toGray(clip.frameAt(t), clip.W, clip.H, 3, W, H);
const bg = medianImage(Array.from({ length: 25 }, (_, k) => gray((k + 0.5) * clip.duration / 25)));
const frames = [];
{
  let prev = null, cur = gray(0);
  const state = {};
  for (let i = 1; i < clip.duration * fps; i++) {
    const next = gray(i / fps);
    frames.push({ t: (i - 1) / fps, ...processFrame({ prev, cur, next, bg, w: W, h: H, state }) });
    prev = cur; cur = next;
  }
}
const P3 = [[0, 0, 0], [9, 0, 0], [9, 18, 0], [0, 18, 0], [0, 6, 0], [9, 6, 0], [0, 12, 0], [9, 12, 0], [0, 9, 2.43], [9, 9, 2.43]];
const P2 = P3.map((X) => { const q = clip.cam.project(X); return [q.x * sx, q.y * sx]; });

test('calibrazione 3D della telecamera (DLT)', () => {
  const P = cameraMatrix(P3, P2);
  assert.ok(reprojError(P, P3, P2) < 0.01);
});

test('3D: scambi, fondamentali, valutazioni e vincitori come nella verità', () => {
  const P = cameraMatrix(P3, P2);
  const rallies = extractRallies3D(frames, P);
  assert.equal(rallies.length, clip.rallies.length);
  let serving = '*';
  rallies.forEach((r, k) => {
    const truth = clip.rallies[k];
    const out = interpretRally(r, { homeNear: true, serving, p1: { '*': 1, a: 3 }, setter: { '*': 1, a: 3 }, rank: () => 9 });
    const skills = out.events.filter((e) => e.kind === 'skill' && !(e.skill === 'R' && e.ev === '=' && truth.touches.length === 1));
    const got = skills.map((e) => e.team + e.skill).join(' ');
    const exp = truth.touches.map((x) => (x.side === 'near' ? '*' : 'a') + x.skill).join(' ');
    assert.equal(got, exp, `scambio ${k + 1} (${truth.kind})`);
    const win = truth.winner === 'near' ? '*' : 'a';
    assert.equal(out.winner, win, `vincitore scambio ${k + 1}`);
    // tempi dei tocchi entro 0,1 s
    skills.forEach((e, i) => assert.ok(Math.abs(e.vt - truth.touches[i].t) < 0.1, `tempo tocco ${i + 1} scambio ${k + 1}`));
    serving = win;
  });
});

test('3D: robusto a errori di calibrazione di ±1,5 px', () => {
  let s = 3;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; };
  const P = cameraMatrix(P3, P2.map(([x, y]) => [x + rnd() * 3, y + rnd() * 3]));
  const rallies = extractRallies3D(frames, P);
  assert.equal(rallies.length, clip.rallies.length);
  const wins = rallies.map((r) => interpretRally(r, { homeNear: true }).winner);
  assert.deepEqual(wins, clip.rallies.map((r) => (r.winner === 'near' ? '*' : 'a')));
});

test('2D (solo pavimento): trova gli scambi', () => {
  const floor = P3.slice(0, 8);
  const Hpx = computeHomography(floor.map((X, i) => ({ x: P2[i][0], y: P2[i][1] })), floor.map((X) => ({ x: X[0], y: X[1] })));
  const rallies = extractRallies2D(frames, Hpx);
  assert.ok(rallies.length >= 3, `scambi 2D: ${rallies.length}`);
});

test('maglia: preelaborazione isola e normalizza le cifre', async () => {
  const { prepareJersey } = await import('../js/vision/jersey.js');
  const { DIGITS } = await import('../js/vision/digits.js');
  for (const [num, sc] of [[7, 2], [14, 3], [21, 1]]) {
    const W = 60, H = 40;
    const img = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) { img[i * 3] = 30; img[i * 3 + 1] = 90; img[i * 3 + 2] = 220; }
    let x0 = 8;
    for (const ch of String(num)) {
      const g = DIGITS[ch];
      for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) if (g[gy][gx] === '1') for (let yy = 0; yy < sc; yy++) for (let xx = 0; xx < sc; xx++) { const i = ((10 + gy * sc + yy) * W + x0 + gx * sc + xx) * 3; img[i] = img[i + 1] = img[i + 2] = 245; }
      x0 += 6 * sc;
    }
    const p = prepareJersey(img, W, H, 3, 40);
    assert.ok(p, `cifre trovate per ${num}`);
    assert.equal(p.nDigits, String(num).length, `numero di cifre per ${num}`);
    assert.ok(p.h >= 40 && p.gray.some((v) => v === 0));
  }
});

test('calibrazione automatica dalle linee (campo sintetico) + telecamera 3D senza rete', async () => {
  const { autoCalibrate } = await import('../js/vision/autocourt.js');
  const { cameraFromHomography } = await import('../js/vision/camera.js');
  const { makeCamera, makeRenderer, calibrationPoints } = await import('../tools/synth.mjs');
  const cam = makeCamera(960, 540);
  const img = makeRenderer(cam)(0, [], null);
  const r = autoCalibrate(img, 960, 540, 3);
  assert.ok(r.ok, r.reason);
  const truth = calibrationPoints(cam);
  for (const k of ['nl', 'nr', 'fr', 'fl', 'n3l', 'n3r', 'f3l', 'f3r']) {
    const e = Math.hypot((r.points[k].x - truth[k].x) * 960, (r.points[k].y - truth[k].y) * 540);
    assert.ok(e < 3, `${k}: errore ${e.toFixed(1)} px`);
  }
  // bordo della rete previsto dalla sola omografia del pavimento
  const c = cameraFromHomography(r.H, 960, 540);
  const { project } = await import('../js/vision/ballistic.js');
  const q = project(c.P, [0, 9, 2.43]);
  const e = Math.hypot(q[0] - truth.ntl.x * 960, q[1] - truth.ntl.y * 540);
  assert.ok(e < 6, `rete: errore ${e.toFixed(1)} px`);
});

test('battuta ricostruita all\'indietro dalla ricezione (fondo lontano)', async () => {
  const { reconstructServe } = await import('../js/vision/rally.js');
  const { fitFlight } = await import('../js/vision/ballistic.js');
  const P = cameraMatrix(P3, P2);
  const tr = clip.rallies.find((r) => r.kind === 'out'); // battuta dal fondo lontano, ricezione vicina
  const serveT = tr.touches[0].t, recT = tr.touches[1].t;
  let k = 7;
  const noise = () => { k = (k * 1103515245 + 12345) % 2147483648; return (k / 2147483648 - 0.5); };
  const obsAt = (t) => { const b = tr.path.at(t); const q = clip.cam.project(b); return { t, x: q.x * sx + noise(), y: q.y * sx + noise() }; };
  // il volo della battuta si vede solo da metà in poi (all'inizio la palla lontana sfugge)
  const pts = [];
  for (let t = serveT + 0.45; t < recT - 0.02; t += 1 / 30) pts.push(obsAt(t));
  const after = [];
  for (let t = recT + 0.04; t < recT + 0.9; t += 1 / 30) after.push(obsAt(t));
  const s0 = { ...fitFlight(P, after), t0: after[0].t };
  s0.fit = fitFlight(P, after);
  const rec = reconstructServe(P, [...pts, ...after], s0);
  assert.ok(rec, 'battuta ricostruita');
  assert.ok(Math.abs(rec.reception.t - recT) < 0.1, `istante ricezione ${rec.reception.t.toFixed(2)} (vero ${recT})`);
  assert.ok(Math.abs(rec.serve.t - serveT) < 0.2, `istante battuta ${rec.serve.t.toFixed(2)} (vero ${serveT})`);
  assert.ok(Math.abs(rec.serve.X[0] - tr.touches[0].pos[0]) < 1.0 && rec.serve.X[1] > 17.5, `punto di battuta ${rec.serve.X.map((v) => v.toFixed(1))} (vero ${tr.touches[0].pos})`);
});
