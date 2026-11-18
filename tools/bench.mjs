// Banco di prova dell'analisi automatica su più video sintetici.
// node tools/bench.mjs ['{"opzioni":...}'] [nVideo]
import { makeMatchClip } from './synth.mjs';
import { toGray, medianImage, processFrame } from '../js/vision/cv.js';
import { cameraMatrix } from '../js/vision/ballistic.js';
import { extractRallies3D, interpretRally } from '../js/vision/rally.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const opts = JSON.parse(process.argv[2] || '{}');
const nClips = +(process.argv[3] || 4);
const W = 480, H = 270, fps = 30;
const KINDS = ['long', 'kill', 'ace', 'out', 'serr'];
const cacheDir = new URL('../.bench-cache/', import.meta.url).pathname;
mkdirSync(cacheDir, { recursive: true });

let tot = 0, seqOk = 0, winOk = 0, found = 0;
for (let c = 0; c < nClips; c++) {
  const kinds = [...KINDS.slice(c % 5), ...KINDS.slice(0, c % 5), ...KINDS.slice((c * 2) % 5, (c * 2) % 5 + 2)];
  const clip = makeMatchClip({ seed: 11 + c * 7, kinds });
  const cache = `${cacheDir}clip${c}.json`;
  let frames;
  if (existsSync(cache)) frames = JSON.parse(readFileSync(cache, 'utf8'));
  else {
    const gray = (t) => toGray(clip.frameAt(t), clip.W, clip.H, 3, W, H);
    const bg = medianImage(Array.from({ length: 25 }, (_, k) => gray((k + 0.5) * clip.duration / 25)));
    frames = []; let prev = null, cur = gray(0); const state = {};
    for (let i = 1; i < clip.duration * fps; i++) { const next = gray(i / fps); frames.push({ t: (i - 1) / fps, ...processFrame({ prev, cur, next, bg, w: W, h: H, state }) }); prev = cur; cur = next; }
    writeFileSync(cache, JSON.stringify(frames));
  }
  const sx = W / clip.W;
  const P3 = [[0, 0, 0], [9, 0, 0], [9, 18, 0], [0, 18, 0], [0, 6, 0], [9, 6, 0], [0, 12, 0], [9, 12, 0], [0, 9, 2.43], [9, 9, 2.43]];
  const P = cameraMatrix(P3, P3.map((X) => { const q = clip.cam.project(X); return [q.x * sx, q.y * sx]; }));
  const rs = extractRallies3D(frames, P, opts);
  for (const tr of clip.rallies) {
    tot++;
    const r = rs.find((x) => Math.abs(x.start - tr.touches[0].t) < 0.4);
    const exp = tr.touches.map((x) => (x.side === 'near' ? '*' : 'a') + x.skill).join(' ');
    const win = tr.winner === 'near' ? '*' : 'a';
    if (!r) { if (opts.v) console.log(`clip${c} ${tr.kind}: NON TROVATO`); continue; }
    found++;
    const o = interpretRally(r, { homeNear: true });
    const got = o.events.filter((e) => e.kind === 'skill' && !(e.skill === 'R' && e.ev === '=' && tr.touches.length === 1)).map((e) => e.team + e.skill).join(' ');
    if (got === exp) seqOk++;
    if (o.winner === win) winOk++;
    if (opts.v && (got !== exp || o.winner !== win)) console.log(`clip${c} ${tr.kind}: atteso ${exp} → ${win} | trovato ${got} → ${o.winner}`);
  }
}
console.log(`scambi ${tot} · trovati ${found} · sequenza esatta ${seqOk} (${Math.round(100 * seqOk / tot)}%) · vincitore giusto ${winOk} (${Math.round(100 * winOk / tot)}%)`);
