// Worker della rete neurale di rilevamento (onnxruntime-web, caricato da CDN al primo uso).
import { tilesFor, toTensor, decode, nms, COCO_PERSON, COCO_BALL } from './detector.js';

const ORT_VERSION = '1.23.2';
let ort = null, session = null, size = 416, canvas = null, ctx = null, backend = null;

async function init(m) {
  const base = m.ortBase || `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
  ort = await import(/* @vite-ignore */ base + 'ort.all.min.mjs');
  ort.env.wasm.wasmPaths = base;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  size = m.size;
  const model = new Uint8Array(await (await fetch(m.modelUrl)).arrayBuffer());
  const eps = [];
  if (self.navigator?.gpu) eps.push('webgpu');
  eps.push('wasm');
  let lastErr = null;
  for (const ep of eps) {
    try { session = await ort.InferenceSession.create(model, { executionProviders: [ep], graphOptimizationLevel: 'all' }); backend = ep; break; } catch (e) { lastErr = e; }
  }
  if (!session) throw lastErr || new Error('rete neurale non avviabile');
  canvas = new OffscreenCanvas(size, size);
  ctx = canvas.getContext('2d', { willReadFrequently: true });
  // prima esecuzione a vuoto (compila i kernel)
  await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * size * size).fill(114), [1, 3, size, size]) });
  return { backend };
}

async function detect(m) {
  const bmp = m.bitmap, W = bmp.width, H = bmp.height;
  const classes = m.ball ? [COCO_PERSON, COCO_BALL] : [COCO_PERSON];
  let all = [];
  for (const [x, y, w, h] of tilesFor(W, H, m.tiles)) {
    const k = Math.min(size / w, size / h);
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, x, y, w, h, 0, 0, Math.round(w * k), Math.round(h * k));
    const rgba = ctx.getImageData(0, 0, size, size).data;
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', toTensor(rgba, size), [1, 3, size, size]) });
    const data = out[session.outputNames[0]].data;
    for (const b of decode(data, size, { classes, thr: m.thr ?? 0.3 })) {
      all.push({ ...b, x0: x + b.x0 / k, y0: y + b.y0 / k, x1: x + b.x1 / k, y1: y + b.y1 / k });
    }
  }
  bmp.close();
  all = nms(all).map((b) => ({ cls: b.cls, score: +b.score.toFixed(3), x0: Math.round(b.x0), y0: Math.round(b.y0), x1: Math.round(b.x1), y1: Math.round(b.y1) }));
  return { boxes: all };
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') self.postMessage({ id: m.id, type: 'ok', ...(await init(m)) });
    else if (m.type === 'detect') self.postMessage({ id: m.id, type: 'ok', ...(await detect(m)) });
  } catch (e) {
    self.postMessage({ id: m.id, type: 'error', message: e.message || String(e) });
  }
};
