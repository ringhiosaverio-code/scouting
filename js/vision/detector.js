// Rilevamento delle persone con una rete neurale (YOLOX, Apache-2.0) nel browser.
// Molto più affidabile della differenza dallo sfondo: trova i giocatori anche vicini tra loro,
// in movimento rapido, con telecamera che vibra o pubblico che si muove.
//
// La rete gira in un worker (detworker.js) con onnxruntime-web: WebGPU dove disponibile,
// altrimenti WebAssembly. L'immagine viene divisa in due tasselli sovrapposti, così anche i
// giocatori lontani (piccoli) vengono visti a risoluzione sufficiente.
//
// Parte pura (testabile in Node): preparazione dei tasselli, decodifica dell'uscita, NMS.

export const YOLOX = { nano: { file: 'models/yolox_nano.onnx', size: 416 }, tiny: { file: 'models/yolox_tiny.onnx', size: 416 } };
export const COCO_PERSON = 0, COCO_BALL = 32;

// tasselli: per immagini larghe due metà sovrapposte (56% della larghezza ciascuna)
export function tilesFor(W, H, mode = 'auto') {
  if (mode === 'full' || (mode === 'auto' && W / H < 1.2)) return [[0, 0, W, H]];
  const tw = Math.round(W * 0.56);
  return [[0, 0, tw, H], [W - tw, 0, tw, H]];
}

// rgba di un tassello già ridotto (rw x rh dentro size x size, il resto grigio 114) → tensore CHW BGR
export function toTensor(rgba, size) {
  const n = size * size, out = new Float32Array(3 * n);
  for (let i = 0, j = 0; i < n; i++, j += 4) { out[i] = rgba[j + 2]; out[n + i] = rgba[j + 1]; out[2 * n + i] = rgba[j]; }
  return out;
}

// uscita YOLOX [N, 85] → riquadri nel sistema del tassello (prima della scala)
export function decode(out, size, { classes = [COCO_PERSON], thr = 0.3 } = {}) {
  const res = [];
  let i = 0;
  for (const s of [8, 16, 32]) {
    const g = size / s;
    for (let y = 0; y < g; y++) for (let x = 0; x < g; x++, i++) {
      const o = i * 85;
      const obj = out[o + 4];
      if (obj < thr * 0.5) continue;
      for (const c of classes) {
        const sc = obj * out[o + 5 + c];
        if (sc < thr) continue;
        const cx = (out[o] + x) * s, cy = (out[o + 1] + y) * s, w = Math.exp(out[o + 2]) * s, h = Math.exp(out[o + 3]) * s;
        res.push({ cls: c, score: sc, x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 });
      }
    }
  }
  return res;
}

const iou = (a, b) => {
  const iw = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), ih = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = iw * ih;
  return inter / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter);
};
// sovrapposizione rispetto al più piccolo: per i doppioni ai bordi dei tasselli (riquadri tagliati)
const overlapSmall = (a, b) => {
  const iw = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), ih = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  return iw * ih / Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
};
export function nms(boxes, thr = 0.45, smallThr = 0.7) {
  const s = [...boxes].sort((a, b) => b.score - a.score), keep = [];
  for (const b of s) if (!keep.some((k) => k.cls === b.cls && (iou(k, b) > thr || overlapSmall(k, b) > smallThr))) keep.push(b);
  return keep;
}

// ---------------------------------------------------------------- browser
let worker = null, ready = null, seq = 0;
const pending = new Map();
export function detectorStatus() { return ready ? 'loading-or-ready' : 'idle'; }

export function loadDetector({ model = null } = {}) {
  if (ready) return ready;
  // WebGPU: modello più preciso; solo WebAssembly: modello leggero
  model ||= (navigator.gpu ? 'tiny' : 'nano');
  worker = new Worker(new URL('./detworker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const m = ev.data;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.type === 'error') p.rej(new Error(m.message)); else p.res(m);
  };
  const base = new URL('../../', import.meta.url).href;
  ready = call({ type: 'init', modelUrl: base + YOLOX[model].file, size: YOLOX[model].size, ortBase: window.VSP_ORT_BASE || null })
    .catch((e) => { ready = null; worker.terminate(); worker = null; throw e; });
  return ready;
}
function call(msg, transfer = []) {
  return new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); worker.postMessage({ ...msg, id }, transfer); });
}

// persone nell'immagine (ImageBitmap, canvas o video). Restituisce [{x0,y0,x1,y1,score}] in pixel
// dell'immagine data.
export async function detectPeople(image, { tiles = 'auto', thr = 0.3, ball = false } = {}) {
  await loadDetector();
  const bmp = image instanceof ImageBitmap ? image : await createImageBitmap(image);
  const r = await call({ type: 'detect', bitmap: bmp, tiles, thr, ball }, [bmp]);
  return r.boxes;
}
