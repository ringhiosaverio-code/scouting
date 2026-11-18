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
