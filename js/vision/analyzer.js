// Estrazione dei fotogrammi da un video nel browser e analisi nel Web Worker.
import { cameraMatrix } from './ballistic.js';
import { cameraFromHomography } from './camera.js';
import { autoCalibrate } from './autocourt.js';
import { extractRallies3D, extractRallies2D } from './rally.js';
import { calibrationPairs3D, computeHomography } from '../lib/court.js';

const once = (el, ev) => new Promise((res, rej) => {
  const ok = () => { el.removeEventListener('error', ko); res(); };
  const ko = () => { el.removeEventListener(ev, ok); rej(new Error('Errore nel video')); };
  el.addEventListener(ev, ok, { once: true });
  el.addEventListener('error', ko, { once: true });
});

// i video da link esterno vanno letti in modalità CORS, altrimenti il canvas è "contaminato"
export function corsFor(video, src) {
  try { if (new URL(src, location.href).origin !== location.origin && /^https?:/.test(src)) video.crossOrigin = 'anonymous'; } catch { /* src relativo */ }
}

// opzioni: { src, start, end, rate, maxWidth, bgSamples, onProgress(frac, msg), signal }
export async function captureAndProcess(o) {
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  corsFor(video, o.src);
  video.src = o.src;
  await once(video, 'loadedmetadata');
  const vw = video.videoWidth, vh = video.videoHeight;
  const W = Math.min(o.maxWidth || 480, vw), H = Math.round(vh * W / vw);
  const start = Math.max(0, o.start || 0);
  const end = Math.min(video.duration || o.end, o.end ?? video.duration);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const results = [];
  let pending = 0;
  let resolveDone, resolveBg;
  const done = new Promise((r) => { resolveDone = r; });
  const bgReady = new Promise((r) => { resolveBg = r; });
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'result') { pending--; if (m.t != null) results.push({ t: m.t, balls: m.balls, players: m.players }); }
    else if (m.type === 'bgready') resolveBg();
    else if (m.type === 'done') resolveDone();
  };
  const grab = () => { ctx.drawImage(video, 0, 0, W, H); return ctx.getImageData(0, 0, W, H).data.buffer; };
  const aborted = () => o.signal?.aborted;
  try {
    worker.postMessage({ type: 'init', w: W, h: H, opts: o.cvOpts || {} });
    // 1) sfondo: mediana di fotogrammi sparsi nell'intervallo (i giocatori si muovono, il campo no)
    const N = o.bgSamples || 25;
    for (let k = 0; k < N; k++) {
      if (aborted()) throw new DOMException('Annullato', 'AbortError');
      video.currentTime = start + (k + 0.5) * (end - start) / N;
      await once(video, 'seeked');
      const buf = grab();
      worker.postMessage({ type: 'bg', rgba: buf }, [buf]);
      o.onProgress?.(0.05 * (k + 1) / N, 'Stima dello sfondo…');
    }
    worker.postMessage({ type: 'bgdone' });
    await bgReady;
    // 2) passata principale
    video.currentTime = start;
    await once(video, 'seeked');
    worker.postMessage({ type: 'reset' });
    const useRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype && !o.forceSeek;
    if (useRVFC) {
      video.playbackRate = o.rate || 2;
      await new Promise((resolve, reject) => {
        let lastT = -1, lastPresented = null, seen = 0, missed = 0;
        const onFrame = (_, meta) => {
          // velocità adattiva: se il browser salta fotogrammi (decodifica lenta), rallenta
          if (lastPresented != null && meta.presentedFrames != null) {
            const jump = meta.presentedFrames - lastPresented;
            seen += 1; if (jump > 1) missed += jump - 1;
            if (seen >= 30) {
              if (missed / (seen + missed) > 0.04 && video.playbackRate > 0.5) video.playbackRate = Math.max(0.5, video.playbackRate * 0.75);
              seen = 0; missed = 0;
            }
          }
          lastPresented = meta.presentedFrames;
          if (aborted()) { video.pause(); reject(new DOMException('Annullato', 'AbortError')); return; }
          const t = meta.mediaTime;
          if (t >= end || video.ended) { video.pause(); resolve(); return; }
          if (t > lastT + 1e-4) {
            lastT = t;
            const buf = grab();
            pending++;
            worker.postMessage({ type: 'frame', t, rgba: buf }, [buf]);
            o.onProgress?.(0.05 + 0.9 * (t - start) / (end - start), 'Analisi dei fotogrammi…');
            // contropressione: se il worker resta indietro, pausa
            if (pending > 10 && !video.paused) {
              video.pause();
              const wait = () => { if (pending < 3) video.play().catch(reject); else setTimeout(wait, 20); };
              setTimeout(wait, 20);
            }
          }
          video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
        video.addEventListener('ended', () => resolve(), { once: true });
        video.play().catch(reject);
      });
    } else {
      const step = 1 / (o.fps || 25);
      for (let t = start; t < end; t += step) {
        if (aborted()) throw new DOMException('Annullato', 'AbortError');
        video.currentTime = t;
        await once(video, 'seeked');
        const buf = grab();
        pending++;
        worker.postMessage({ type: 'frame', t, rgba: buf }, [buf]);
        o.onProgress?.(0.05 + 0.9 * (t - start) / (end - start), 'Analisi dei fotogrammi…');
        while (pending > 10) await new Promise((r) => setTimeout(r, 10));
      }
    }
    worker.postMessage({ type: 'end' });
    await done;
  } finally {
    worker.terminate();
    video.removeAttribute('src'); video.load();
  }
  results.sort((a, b) => a.t - b.t);
  return { frames: results, W, H, start, end };
}

// Dalla calibrazione dell'utente alle trasformazioni nei pixel di lavoro
export function geometryFor(calibPoints, W, H, netHeight) {
  const { p3, p2, has3D } = calibrationPairs3D(calibPoints, netHeight);
  const px = p2.map((q) => [q[0] * W, q[1] * H]);
  let P = null, Hpx = null;
  if (has3D && p3.length >= 6) { try { P = cameraMatrix(p3, px); } catch { P = null; } }
  const floor = p3.map((X, i) => ({ X, q: px[i] })).filter((o) => o.X[2] === 0);
  let auto3d = false;
  if (floor.length >= 4) {
    Hpx = computeHomography(floor.map((o) => ({ x: o.q[0], y: o.q[1] })), floor.map((o) => ({ x: o.X[0], y: o.X[1] })));
    // senza i punti della rete: telecamera completa stimata dalla sola omografia del pavimento
    if (!P) {
      const Hm = computeHomography(floor.map((o) => ({ x: o.X[0], y: o.X[1] })), floor.map((o) => ({ x: o.q[0], y: o.q[1] })));
      const cam = cameraFromHomography(Hm, W, H);
      if (cam) { P = cam.P; auto3d = true; }
    }
  }
  return { P, Hpx, W, H, auto3d, mode: P ? '3d' : Hpx ? '2d' : null };
}

export function ralliesFromFrames(frames, geo, opts = {}) {
  if (geo.mode === '3d') return extractRallies3D(frames, geo.P, { W: geo.W, H: geo.H, ...opts });
  if (geo.mode === '2d') return extractRallies2D(frames, geo.Hpx, opts);
  return [];
}

// Sfondo (mediana per canale) di fotogrammi sparsi del video, in RGB
export async function backgroundFromVideo(src, { width = 960, samples = 30, start = 0, end = null, onProgress } = {}) {
  const video = document.createElement('video');
  video.muted = true; video.preload = 'auto'; corsFor(video, src); video.src = src;
  await once(video, 'loadedmetadata');
  const W = Math.min(width, video.videoWidth), H = Math.round(video.videoHeight * W / video.videoWidth);
  const t1 = Math.min(end ?? video.duration, video.duration), t0 = Math.max(0, start);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  const frames = [];
  for (let k = 0; k < samples; k++) {
    video.currentTime = t0 + (k + 0.5) * (t1 - t0) / samples;
    await once(video, 'seeked');
    ctx.drawImage(video, 0, 0, W, H);
    frames.push(ctx.getImageData(0, 0, W, H).data);
    onProgress?.((k + 1) / samples);
  }
  video.removeAttribute('src'); video.load();
  const out = new Uint8Array(W * H * 3), buf = new Uint8Array(frames.length);
  for (let i = 0; i < W * H; i++) for (let ch = 0; ch < 3; ch++) {
    for (let k = 0; k < frames.length; k++) buf[k] = frames[k][i * 4 + ch];
    buf.sort();
    out[i * 3 + ch] = buf[buf.length >> 1];
  }
  return { rgb: out, W, H };
}

export async function autoCalibrateVideo(src, opts = {}) {
  const bg = await backgroundFromVideo(src, opts);
  return autoCalibrate(bg.rgb, bg.W, bg.H, 3);
}
