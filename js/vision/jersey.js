// Lettura dei numeri di maglia (sperimentale).
// Preelaborazione pura (testabile in Node) + OCR con Tesseract.js caricato su richiesta.
import { components } from './cv.js';

// Soglia di Otsu su un'immagine in scala di grigi
export function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  let sum = 0;
  hist.forEach((c, v) => { sum += c * v; });
  let wB = 0, sB = 0, best = 128, bv = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = gray.length - wB; if (!wF) break;
    sB += t * hist[t];
    const v = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
    if (v > bv) { bv = v; best = t; }
  }
  return best;
}

// chiusura morfologica 3x3 (ricuce tratti sottili interrotti)
function close3(m, w, h) {
  const d = new Uint8Array(m.length), e = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let dy = -1; dy <= 1 && !v; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < h && xx >= 0 && xx < w && m[yy * w + xx]) { v = 1; break; } }
    d[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 1;
    for (let dy = -1; dy <= 1 && v; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < h && xx >= 0 && xx < w && !d[yy * w + xx]) { v = 0; break; } }
    e[y * w + x] = v;
  }
  return e;
}

// rgba/rgb (channels) del ritaglio della maglia -> immagine binaria normalizzata
// (cifre nere su bianco, alte ~targetH px) pronta per l'OCR; null se non si trovano cifre
export function prepareJersey(src, w, h, channels = 4, targetH = 40) {
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = (77 * src[i * channels] + 150 * src[i * channels + 1] + 29 * src[i * channels + 2]) >> 8;
  const thr = otsu(gray);
  // le cifre sono la classe minoritaria (numero più piccolo della maglia)
  let bright = 0;
  for (const v of gray) if (v > thr) bright++;
  const digitsBright = bright < gray.length / 2;
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) mask[i] = (gray[i] > thr) === digitsBright ? 1 : 0;
  mask = close3(mask, w, h);
  // componenti compatibili con cifre: alte, non toccano i bordi, proporzioni da carattere
  const blobs = components(mask, w, h, 3, true).filter((b) => b.h >= h * 0.12 && b.h <= h * 0.95 && b.w <= b.h * 2.6 && b.x0 > 0 && b.y0 > 0 && b.x1 < w - 1 && b.y1 < h - 1);
  if (!blobs.length) return null;
  // cifre allineate: stessa altezza circa della più alta
  const H = Math.max(...blobs.map((b) => b.h));
  const ds = blobs.filter((b) => b.h > H * 0.7).sort((a, b) => a.x0 - b.x0).slice(0, 2);
  const x0 = Math.min(...ds.map((b) => b.x0)), x1 = Math.max(...ds.map((b) => b.x1));
  const y0 = Math.min(...ds.map((b) => b.y0)), y1 = Math.max(...ds.map((b) => b.y1));
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const k = targetH / bh;
  const pad = Math.round(targetH * 0.5);
  const W2 = Math.round(bw * k) + 2 * pad, H2 = targetH + 2 * pad;
  const out = new Uint8Array(W2 * H2).fill(255);
  // ingrandimento bilineare del grigio e soglia dopo: contorni più morbidi del binario a blocchi
  const g = (xx, yy) => gray[Math.max(0, Math.min(h - 1, yy)) * w + Math.max(0, Math.min(w - 1, xx))];
  for (let y = -pad + 2; y < targetH + pad - 2; y++) {
    for (let x = -pad + 2; x < Math.round(bw * k) + pad - 2; x++) {
      const fx = x0 + (x + 0.5) / k - 0.5, fy = y0 + (y + 0.5) / k - 0.5;
      const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy;
      const v = (g(ix, iy) * (1 - ax) + g(ix + 1, iy) * ax) * (1 - ay) + (g(ix, iy + 1) * (1 - ax) + g(ix + 1, iy + 1) * ax) * ay;
      if ((v > thr) === digitsBright) out[(y + pad) * W2 + x + pad] = 0;
    }
  }
  // due cifre fuse in una sola macchia (piccole e sfocate): si riconoscono dalla larghezza
  const nDigits = ds.length === 1 && bw > bh * 1.05 ? 2 : ds.length;
  return { gray: out, w: W2, h: H2, nDigits, srcH: bh };
}

// Immagine PGM (supportata da Tesseract/Leptonica) da un buffer in scala di grigi
export function toPGM(p) {
  const head = new TextEncoder().encode(`P5\n${p.w} ${p.h}\n255\n`);
  const out = new Uint8Array(head.length + p.gray.length);
  out.set(head); out.set(p.gray, head.length);
  return out;
}

// Ritaglio del busto (dove sta il numero) dal riquadro del giocatore [x0,y0,x1,y1]
export function torsoBox([x0, y0, x1, y1]) {
  const hgt = y1 - y0, wid = x1 - x0;
  return [x0 + wid * 0.1, y0 + hgt * 0.12, x1 - wid * 0.1, y0 + hgt * 0.55];
}

// ---- browser: Tesseract.js da CDN, caricato solo se l'utente usa la funzione ----
let workerP = null;
const CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
function loadScript(src) {
  return new Promise((res, rej) => {
    if (window.Tesseract) { res(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Impossibile caricare il motore OCR (serve la connessione la prima volta)'));
    document.head.appendChild(s);
  });
}
export async function ocrWorker() {
  if (!workerP) {
    workerP = (async () => {
      await loadScript(CDN);
      const w = await window.Tesseract.createWorker('eng');
      await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' });
      return w;
    })();
    workerP.catch(() => { workerP = null; });
  }
  return workerP;
}

export async function readDigits(prepared) {
  const w = await ocrWorker();
  // una cifra: modalità "carattere singolo"; due: "parola singola"
  await w.setParameters({ tessedit_pageseg_mode: prepared.nDigits === 1 ? '10' : '8' });
  const blob = new Blob([toPGM(prepared)], { type: 'image/x-portable-graymap' });
  const { data } = await w.recognize(blob);
  const text = (data.text || '').replace(/\D/g, '');
  return { text, conf: Math.round(data.confidence || 0) };
}

// Legge il numero di maglia di un giocatore nel fotogramma al tempo t del video.
// box: riquadro in coordinate normalizzate (0..1) dell'immagine
export async function readJerseyAt(video, t, box) {
  if (Math.abs(video.currentTime - t) > 0.01) {
    video.currentTime = t;
    await new Promise((r) => video.addEventListener('seeked', r, { once: true }));
  }
  const vw = video.videoWidth, vh = video.videoHeight;
  const [x0, y0, x1, y1] = torsoBox([box[0] * vw, box[1] * vh, box[2] * vw, box[3] * vh]).map(Math.round);
  const w = Math.max(4, x1 - x0), h = Math.max(4, y1 - y0);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, x0, y0, w, h, 0, 0, w, h);
  const prep = prepareJersey(ctx.getImageData(0, 0, w, h).data, w, h, 4);
  if (!prep) return null;
  return readDigits(prep);
}
