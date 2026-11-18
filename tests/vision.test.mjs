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

test('telecamera laterale: calibrazione automatica e analisi degli scambi', async () => {
  const { autoCalibrate } = await import('../js/vision/autocourt.js');
  const { geometryFor } = await import('../js/vision/analyzer.js');
  const sclip = makeMatchClip({ view: 'side' });
  const g = (t) => toGray(sclip.frameAt(t), sclip.W, sclip.H, 3, W, H);
  const sbg = medianImage(Array.from({ length: 25 }, (_, k) => g((k + 0.5) * sclip.duration / 25)));
  const fr = [];
  let prev = null, cur = g(0);
  const state = {};
  for (let i = 1; i < sclip.duration * fps; i++) { const next = g(i / fps); fr.push({ t: (i - 1) / fps, ...processFrame({ prev, cur, next, bg: sbg, w: W, h: H, state }) }); prev = cur; cur = next; }
  const ac = autoCalibrate(sclip.frameAt(0), sclip.W, sclip.H, 3);
  assert.ok(ac.ok, ac.reason);
  assert.equal(ac.view, 'side');
  const geo = geometryFor(ac.points, W, H, 2.43); // senza i punti della rete
  const rs = extractRallies3D(fr, geo.P);
  assert.equal(rs.length, sclip.rallies.length);
  let serving = '*';
  rs.forEach((r, k) => {
    const o = interpretRally(r, { homeNear: true, serving });
    const tr = sclip.rallies[k];
    const got = o.events.filter((e) => e.kind === 'skill' && !(e.skill === 'R' && e.ev === '=' && tr.touches.length === 1)).map((e) => e.team + e.skill).join(' ');
    assert.equal(got, tr.touches.map((x) => (x.side === 'near' ? '*' : 'a') + x.skill).join(' '), `scambio ${k + 1}`);
    assert.equal(o.winner, tr.winner === 'near' ? '*' : 'a');
    serving = o.winner;
  });
});

test('giocatori: galleria registrata a mano, riconoscimento e apprendimento dalle correzioni', async () => {
  const { describe, identify, emptyGallery, learn, splitSilhouette } = await import('../js/vision/playerid.js');
  const { playerPos } = await import('../tools/synth.mjs');
  const W2 = 1280, H2 = 720, w = 640, h = 360;
  const c2 = makeMatchClip({ W: W2, H: H2 });
  const bg2 = medianImage(Array.from({ length: 20 }, (_, k) => toGray(c2.frameAt((k + 0.5) * c2.duration / 20), W2, H2, 3, w, h)));
  const truthAt = (t) => { let R = c2.rallies[0]; for (const r of c2.rallies) if (t >= r.path.start - 2) R = r; return R.players.map((p) => { const pos = playerPos(p, t); const f = c2.cam.project([pos[0], pos[1], 0]); return { num: p.number, side: p.side, cx: f.x, y1: f.y }; }); };
  const sil = (t) => {
    const img = c2.frameAt(t), cur = toGray(img, W2, H2, 3, w, h);
    const r = processFrame({ cur, bg: bg2, w, h, opts: { playerMinArea: Math.round(w * h * 0.0008) } });
    const isFg = (x, y) => { const i = Math.min(h - 1, Math.floor(y / 2)) * w + Math.min(w - 1, Math.floor(x / 2)); return Math.abs(cur[i] - bg2[i]) > 30; };
    return { img, boxes: r.players.map((p) => [p.x0 * 2, p.y0 * 2, (p.x1 + 1) * 2, (p.y1 + 1) * 2]).flatMap((b) => splitSilhouette(img, W2, H2, 3, b, isFg)) };
  };
  const owner = (b, tr) => { const cx = (b[0] + b[2]) / 2; const m = tr.filter((q) => Math.abs(q.cx - cx) < (b[2] - b[0]) / 2 + 4 && Math.abs(q.y1 - b[3]) < 20); return m.length === 1 ? m[0] : null; };
  // le sagome fuse vengono separate: al fotogramma iniziale si trovano almeno 8 giocatori singoli
  const g = { near: emptyGallery(), far: emptyGallery() };
  const s0 = sil(1), tr0 = truthAt(1);
  let reg = 0;
  for (const b of s0.boxes) { const o = owner(b, tr0); if (o) { learn(g[o.side], null, o.num, describe(s0.img, W2, H2, 3, b), { source: 'manual' }); reg++; } }
  assert.ok(reg >= 6, `registrati ${reg}`);
  // poi: riconoscimento con correzioni dello scout; un errore corretto non si ripete
  const wrongBy = new Map();
  let ok = 0, ko = 0;
  for (let t = 12; t < c2.duration; t += 2.9) {
    const { img, boxes } = sil(t), tr = truthAt(t);
    for (const b of boxes) {
      const o = owner(b, tr); if (!o) continue;
      const d = describe(img, W2, H2, 3, b);
      const r = identify(g[o.side], d, tr.filter((q) => q.side === o.side).map((q) => q.num));
      if (r[0].p >= 0.5) { if (r[0].num === o.num) ok++; else { ko++; wrongBy.set(o.num, (wrongBy.get(o.num) || 0) + 1); } }
      learn(g[o.side], r, o.num, d, { source: r[0].num === o.num ? 'auto' : 'manual' });
    }
  }
  assert.ok(ok >= 30, `riconosciuti ${ok}`);
  assert.ok(ko <= 3, `errori ${ko}`);
  for (const [n, k] of wrongBy) assert.ok(k <= 1, `#${n} sbagliato ${k} volte dopo la correzione`);
});

test('pause: time-out, video check con replay, intervallo con cambio campo, scambio tagliato', async () => {
  const { analyzeBreaks } = await import('../js/vision/breaks.js');
  const { ballColorMask } = await import('../js/vision/cv.js');
  const { geometryFor } = await import('../js/vision/analyzer.js');
  const bc = makeMatchClip({ kinds: ['long', 'kill', 'ace', 'out', 'serr', 'kill'], t0: 6, breaks: { 0: { type: 'timeout', dur: 36 }, 1: { type: 'videocheck', dur: 55, replay: true }, 2: { type: 'setbreak', dur: 130 }, 4: { type: 'cutend' } } });
  const g = (img) => toGray(img, bc.W, bc.H, 3, W, H);
  const bgb = medianImage(Array.from({ length: 25 }, (_, k) => g(bc.frameAt((k + 0.5) * bc.duration / 25))));
  const fr = [];
  let prev = null, curRgb = bc.frameAt(0), cur = g(curRgb);
  const state = {};
  for (let i = 1; i < bc.duration * fps; i++) {
    const rgb = bc.frameAt(i / fps), next = g(rgb);
    fr.push({ t: (i - 1) / fps, ...processFrame({ prev, cur, next, bg: bgb, w: W, h: H, state, color: ballColorMask(curRgb, bc.W, bc.H, 3, W, H, 'yellow'), rgb: curRgb, rw: bc.W, rh: bc.H, ch: 3 }) });
    prev = cur; cur = next; curRgb = rgb;
  }
  const geo = geometryFor(bc.calibration, W, H, 2.43);
  const rs = extractRallies3D(fr, geo.P, { W, H });
  assert.equal(rs.length, bc.rallies.length);
  const an = analyzeBreaks(fr, rs, geo.Hpx, {});
  assert.deepEqual(an.breaks.map((b) => `${b.after}:${b.kind}`), ['0:timeout', '1:videocheck', '2:setbreak']);
  assert.ok(an.breaks[1].offF > 0.2, 'replay visto durante il video check');
  assert.deepEqual(an.rallies.map((r) => !!r.cutEnd), [false, false, false, false, true, false]);
});
