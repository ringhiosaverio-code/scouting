// Crea un video sintetico di prova (richiede ffmpeg): node tools/synth-video.mjs out.webm [calib.json]
import { makeMatchClip } from './synth.mjs';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const out = process.argv[2] || 'synth.webm';
const [vw, vh] = (process.env.SIZE || '640x360').split('x').map(Number);
const clip = makeMatchClip({ W: vw, H: vh });
const fps = 30;
const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${clip.W}x${clip.H}`, '-r', String(fps), '-i', '-',
  '-c:v', 'libvpx-vp9', '-b:v', '1500k', '-deadline', 'realtime', '-cpu-used', '8', out], { stdio: ['pipe', 'inherit', 'inherit'] });
const n = Math.ceil(clip.duration * fps);
for (let i = 0; i < n; i++) {
  const f = clip.frameAt(i / fps);
  if (!ff.stdin.write(Buffer.from(f.buffer))) await new Promise((r) => ff.stdin.once('drain', r));
}
ff.stdin.end();
await new Promise((r) => ff.on('close', r));
const truth = clip.rallies.map((r) => ({ kind: r.kind, winner: r.winner === 'near' ? '*' : 'a', touches: r.touches.map((x) => ({ t: x.t, skill: x.skill, team: x.side === 'near' ? '*' : 'a', player: x.player })), landing: r.landing.t }));
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify({ calibration: clip.calibration, truth }, null, 1));
console.log(`${out}: ${n} fotogrammi, ${clip.duration.toFixed(1)} s, ${clip.rallies.length} scambi`);
