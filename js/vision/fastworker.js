// Worker di analisi veloce: legge il file video a blocchi, decodifica con WebCodecs
// (VideoDecoder, accelerato in hardware dove disponibile) senza riprodurlo e analizza ogni
// fotogramma. Più worker lavorano in parallelo su tratti diversi della partita.
import { openContainer, fileReader, urlReader, keyBefore } from './demux.js';
import { toGray, medianImage } from './cv.js';
import { createPipe } from './framepipe.js';

let idx = null, reader = null, W = 0, H = 0, opts = {}, bg = null, aborted = false, canvas = null, ctx = null;

const post = (m, tr) => self.postMessage(m, tr || []);

async function makeDecoder(onFrame, onError) {
  const cfg = { codec: idx.codec, codedWidth: idx.width, codedHeight: idx.height };
  if (idx.description) cfg.description = idx.description;
  const sup = await VideoDecoder.isConfigSupported(cfg);
  if (!sup.supported) throw new Error(`il browser non decodifica ${idx.codec}`);
  const dec = new VideoDecoder({ output: onFrame, error: onError });
  dec.configure(cfg);
  return dec;
}

// lettura dei campioni a blocchi contigui
function sampleSource() {
  let bufStart = -1, buf = null;
  return async (i) => {
    const o = idx.off[i], n = idx.size[i];
    if (!buf || o < bufStart || o + n > bufStart + buf.length) {
      buf = await reader.read(o, Math.max(n, 4 << 20));
      bufStart = o;
    }
    return buf.subarray(o - bufStart, o - bufStart + n);
  };
}

function rgbaOf(frame) {
  ctx.drawImage(frame, 0, 0, W, H);
  return ctx.getImageData(0, 0, W, H).data;
}

// sfondo: mediana di fotogrammi chiave distribuiti nell'intervallo (decodificabili da soli)
async function background(start, end, samples = 25) {
  const keys = [];
  for (let i = 0; i < idx.n; i++) if (idx.key[i] && idx.t[i] >= start - 0.01 && idx.t[i] <= end) keys.push(i);
  const pick = keys.length <= samples ? keys : Array.from({ length: samples }, (_, k) => keys[Math.floor((k + 0.5) * keys.length / samples)]);
  const grays = [];
  const read = sampleSource();
  if (pick.length >= 12) {
    for (const i of pick) {
      let got = null;
      const dec = await makeDecoder((f) => { if (!got) got = toGray(rgbaOf(f), W, H, 4, W, H); f.close(); }, () => {});
      dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: Math.round(idx.t[i] * 1e6), data: await read(i) }));
      await dec.flush();
      dec.close();
      if (got) grays.push(got);
    }
  } else {
    // pochi fotogrammi chiave: decodifica in sequenza e prende fotogrammi a intervalli regolari
    const step = (end - start) / samples;
    let next = start + step / 2;
    const dec = await makeDecoder((f) => { const t = f.timestamp / 1e6; if (t >= next && grays.length < samples) { grays.push(toGray(rgbaOf(f), W, H, 4, W, H)); next += step; } f.close(); }, () => {});
    const k0 = keyBefore(idx, start);
    for (let i = k0; i < idx.n && idx.t[i] <= end + 1; i++) {
      if (aborted) break;
      dec.decode(new EncodedVideoChunk({ type: idx.key[i] ? 'key' : 'delta', timestamp: Math.round(idx.t[i] * 1e6), data: await read(i) }));
      if (dec.decodeQueueSize > 16) await new Promise((r) => dec.addEventListener('dequeue', r, { once: true }));
    }
    await dec.flush();
    dec.close();
  }
  if (!grays.length) throw new Error('impossibile decodificare i fotogrammi dello sfondo');
  return medianImage(grays);
}

async function run(start, end, warm) {
  const pipe = createPipe(W, H, opts);
  pipe.setBg(bg);
  const read = sampleSource();
  const every = idx.fps > 40 ? Math.round(idx.fps / 30) : 1; // 50/60 fps: si analizza ~1 fotogramma su 2
  let nOut = 0, batch = [], cuts = [], lastT = -1, err = null, done = 0;
  const from = start - warm;
  const dec = await makeDecoder((f) => {
    const t = f.timestamp / 1e6;
    if (t < from - 1e-6 || t > end + 1e-6 || t <= lastT || (nOut++ % every)) { f.close(); return; }
    lastT = t;
    const rgba = rgbaOf(f);
    f.close();
    const { result, cut } = pipe.push(rgba, t);
    if (cut != null && t >= start) cuts.push(cut);
    if (result && result.t >= start) batch.push(result);
    if (batch.length >= 60) { post({ type: 'results', frames: batch, t }); batch = []; }
  }, (e) => { err = e; });
  const k0 = keyBefore(idx, from);
  for (let i = k0; i < idx.n; i++) {
    if (aborted || err) break;
    if (idx.t[i] > end + 0.6 && idx.key[i]) break;
    if (idx.t[i] > end + 2) break;
    dec.decode(new EncodedVideoChunk({ type: idx.key[i] ? 'key' : 'delta', timestamp: Math.round(idx.t[i] * 1e6), data: await read(i) }));
    if (dec.decodeQueueSize > 12) await new Promise((r) => dec.addEventListener('dequeue', r, { once: true }));
    if (++done % 30 === 0) post({ type: 'progress', t: idx.t[i] });
  }
  if (!aborted && !err) await dec.flush().catch((e) => { err = e; });
  dec.close();
  if (err && !aborted) throw err;
  if (batch.length) post({ type: 'results', frames: batch, t: end });
  post({ type: 'done', cuts });
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'open') {
      if (typeof VideoDecoder === 'undefined' || typeof OffscreenCanvas === 'undefined') throw new Error('WebCodecs non disponibile in questo browser');
      reader = m.file ? fileReader(m.file) : await urlReader(m.url);
      idx = await openContainer(reader);
      const vw = idx.width, vh = idx.height;
      W = Math.min(m.maxWidth || 480, vw); H = Math.round(vh * W / vw);
      opts = m.opts || {};
      canvas = new OffscreenCanvas(W, H);
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      await makeDecoder(() => {}, () => {}).then((d) => d.close()); // verifica del codec
      post({ type: 'opened', info: { codec: idx.codec, width: vw, height: vh, W, H, duration: idx.duration, fps: idx.fps, n: idx.n } });
    } else if (m.type === 'bg') {
      bg = await background(m.start, m.end, m.samples);
      post({ type: 'bg', bg });
    } else if (m.type === 'setbg') {
      bg = m.bg;
    } else if (m.type === 'run') {
      await run(m.start, m.end, m.warm ?? 1);
    } else if (m.type === 'abort') {
      aborted = true;
    }
  } catch (e) {
    post({ type: 'error', message: e.message || String(e) });
  }
};
