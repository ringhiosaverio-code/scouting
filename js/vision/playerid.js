// Riconoscimento dei giocatori che impara dallo scout.
//
// Come per la calibrazione del campo, lo scout indica una volta chi è chi su un
// fotogramma (clic sulla sagoma → numero), oppure conferma la proposta automatica.
// Ogni conferma o correzione diventa un "campione" nella galleria della squadra:
//   - sagoma del numero di maglia (binaria, normalizzata): con il carattere e il kit
//     di QUESTA squadra il confronto diretto è molto più affidabile di un OCR generico
//   - colori del busto e delle gambe: distinguono il libero e aiutano quando il numero
//     non si vede (giocatore girato o lontano)
//   - altezza del giocatore nell'immagine riportata in metri (facoltativa)
// L'identificazione combina la galleria con la probabilità data da rotazione e
// fondamentale (predict.js). Il peso di ogni indizio si adatta: se un indizio porta
// a errori che lo scout corregge, conta di meno; se indovina, conta di più.

import { prepareJersey, torsoBox } from './jersey.js';

export const TPL_H = 24, TPL_WMAX = 40;
const MAX_SAMPLES = 16;
export const MIN_DIGIT_PX = 9;

// ---------- descrittore di una sagoma ----------
// rgba: immagine (w x h, ch canali); box: [x0, y0, x1, y1] in pixel
export function describe(rgba, w, h, ch, box) {
  const [x0, y0, x1, y1] = box.map(Math.round);
  const bw = Math.max(4, x1 - x0), bh = Math.max(8, y1 - y0);
  const desc = { hist: colourHist(rgba, w, h, ch, [x0, y0, x0 + bw, y0 + bh]), px: bh };
  const sh = shirtBox(rgba, w, h, ch, [x0, y0, x0 + bw, y0 + bh]);
  const [tx0, ty0, tx1, ty1] = sh || torsoBox([x0, y0, x0 + bw, y0 + bh]).map(Math.round);
  const tw = Math.max(4, tx1 - tx0), th = Math.max(4, ty1 - ty0);
  const crop = new Uint8ClampedArray(tw * th * 3);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const sx = Math.min(w - 1, Math.max(0, tx0 + x)), sy = Math.min(h - 1, Math.max(0, ty0 + y));
    for (let k = 0; k < 3; k++) crop[(y * tw + x) * 3 + k] = rgba[(sy * w + sx) * ch + k];
  }
  const prep = prepareJersey(crop, tw, th, 3, 32);
  // numero troppo piccolo nell'immagine (giocatore lontano): la sagoma non è affidabile
  if (prep && prep.srcH >= MIN_DIGIT_PX) desc.tpl = template(prep);
  return desc;
}

// riquadro della maglia: colore dominante al centro del busto, poi estensione dei pixel di
// quel colore (esclude pavimento, braccia e altri giocatori dall'area in cui cercare il numero)
function shirtBox(rgba, w, h, ch, [x0, y0, x1, y1]) {
  const bw = x1 - x0, bh = y1 - y0;
  const cx0 = Math.round(x0 + bw * 0.3), cx1 = Math.round(x1 - bw * 0.3), cy0 = Math.round(y0 + bh * 0.25), cy1 = Math.round(y0 + bh * 0.5);
  const hist = new Map();
  const px = (x, y) => { const i = (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * ch; return [rgba[i], rgba[i + 1], rgba[i + 2]]; };
  for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) { const [r, g, b] = px(x, y); const k = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5); hist.set(k, (hist.get(k) || 0) + 1); }
  if (!hist.size) return null;
  const kk = [...hist.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const C = [((kk >> 6) & 7) * 32 + 16, ((kk >> 3) & 7) * 32 + 16, (kk & 7) * 32 + 16];
  const near = (q) => Math.abs(q[0] - C[0]) + Math.abs(q[1] - C[1]) + Math.abs(q[2] - C[2]) < 110;
  const xs = [], ys = [];
  const sy0 = Math.round(y0 + bh * 0.1), sy1 = Math.round(y0 + bh * 0.75);
  for (let y = sy0; y <= sy1; y++) for (let x = Math.round(x0); x <= Math.round(x1); x++) if (near(px(x, y))) { xs.push(x); ys.push(y); }
  if (xs.length < 12) return null;
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const q = (a, f) => a[Math.min(a.length - 1, Math.floor(a.length * f))];
  const bx0 = q(xs, 0.03), bx1 = q(xs, 0.97), by0 = q(ys, 0.02), by1 = Math.min(q(ys, 0.98), Math.round(y0 + bh * 0.62));
  if (bx1 - bx0 < 4 || by1 - by0 < 6) return null;
  return [bx0 - 1, by0 - 1, bx1 + 2, by1 + 2];
}

// istogramma di tinta/saturazione di busto (parte alta) e gambe (parte bassa)
function colourHist(rgba, w, h, ch, [x0, y0, x1, y1]) {
  const HB = 10, bins = HB + 2; // tinte + (grigi chiari, grigi scuri)
  const out = new Float32Array(bins * 2);
  const ix0 = Math.round(x0 + (x1 - x0) * 0.2), ix1 = Math.round(x1 - (x1 - x0) * 0.2);
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    const part = y < y0 + (y1 - y0) * 0.55 ? 0 : 1;
    if (y < y0 + (y1 - y0) * 0.15) continue; // testa
    for (let x = Math.max(0, ix0); x < Math.min(w, ix1); x++) {
      const i = (y * w + x) * ch;
      const r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      let bin;
      if (d < 0.15 || mx < 0.12) bin = HB + (mx > 0.55 ? 0 : 1);
      else {
        let hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
        if (hue < 0) hue += 6;
        bin = Math.min(HB - 1, Math.floor(hue / 6 * HB));
      }
      out[part * bins + bin] += 1;
    }
  }
  for (const p of [0, 1]) {
    let s = 0; for (let k = 0; k < bins; k++) s += out[p * bins + k];
    if (s) for (let k = 0; k < bins; k++) out[p * bins + k] = +(out[p * bins + k] / s).toFixed(3);
  }
  return Array.from(out);
}

// sagoma del numero: inchiostro ritagliato e riportato ad altezza fissa
function template(prep) {
  const { gray, w, h } = prep;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (gray[y * w + x] < 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const iw = x1 - x0 + 1, ih = y1 - y0 + 1;
  const tw = Math.max(4, Math.min(TPL_WMAX, Math.round(iw * TPL_H / ih)));
  const bits = new Uint8Array(tw * TPL_H);
  for (let y = 0; y < TPL_H; y++) for (let x = 0; x < tw; x++) {
    const sx = x0 + Math.floor((x + 0.5) * iw / tw), sy = y0 + Math.floor((y + 0.5) * ih / TPL_H);
    bits[y * tw + x] = gray[sy * w + sx] < 128 ? 1 : 0;
  }
  return { w: tw, d: packBits(bits), n: prep.nDigits };
}
const packBits = (b) => { let s = ''; for (let i = 0; i < b.length; i += 6) { let v = 0; for (let k = 0; k < 6; k++) v = (v << 1) | (b[i + k] || 0); s += String.fromCharCode(48 + v); } return s; };
const unpack = (t) => { const out = new Uint8Array(t.w * TPL_H); let i = 0; for (const c of t.d) { const v = c.charCodeAt(0) - 48; for (let k = 5; k >= 0 && i < out.length; k--) out[i++] = (v >> k) & 1; } return out; };

// somiglianza tra due sagome di numero (0..1), con piccoli spostamenti
export function tplSimilarity(a, b) {
  if (!a || !b) return null;
  if (a.n !== b.n && Math.abs(a.w - b.w) > Math.max(a.w, b.w) * 0.3) return 0;
  const A = unpack(a), B = unpack(b);
  const w = Math.max(a.w, b.w);
  const at = (T, tw, x, y) => (x < 0 || y < 0 || x >= w || y >= TPL_H ? 0 : T[y * tw + Math.floor(x * tw / w)]);
  let best = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    let inter = 0, uni = 0;
    for (let y = 0; y < TPL_H; y++) for (let x = 0; x < w; x++) {
      const p = at(A, a.w, x, y), q = at(B, b.w, x + dx, y + dy);
      if (p || q) { uni++; if (p && q) inter++; }
    }
    if (uni) best = Math.max(best, inter / uni);
  }
  return best;
}
export function histSimilarity(a, b) {
  if (!a || !b) return null;
  let s = 0; for (let i = 0; i < a.length; i++) s += Math.min(a[i], b[i]);
  return s / 2; // due istogrammi normalizzati (busto + gambe)
}

// ---------- galleria e apprendimento ----------
export function emptyGallery() { return { samples: {}, cues: { tpl: { ok: 1, ko: 0 }, col: { ok: 1, ko: 0 }, prior: { ok: 1, ko: 0 }, dig: { ok: 2, ko: 0 } } }; }

export function addSample(gal, num, desc, { source = 'manual', t = null } = {}) {
  if (!desc || (!desc.tpl && !desc.hist)) return;
  const list = (gal.samples[num] ||= []);
  list.push({ tpl: desc.tpl, hist: desc.hist, px: desc.px, src: source, t });
  // tiene i campioni manuali e i più recenti
  while (list.length > MAX_SAMPLES) { const k = list.findIndex((s) => s.src === 'auto'); list.splice(k >= 0 ? k : 0, 1); }
}

const cueWeight = (c) => Math.max(0.2, Math.min(3, Math.log((c.ok + 1) / (c.ko + 1)) + 1));

// punteggi per i candidati: { num, score, tpl, col, prior }
// prior: Map/oggetto num -> probabilità (rotazione, fondamentale, frequenze apprese)
export function identify(gal, desc, candidates, prior = null) {
  const pr = (n) => (prior ? (prior instanceof Map ? prior.get(n) : prior[n]) ?? 0.02 : 1 / candidates.length);
  const wT = cueWeight(gal.cues.tpl), wC = cueWeight(gal.cues.col), wP = cueWeight(gal.cues.prior), wD = cueWeight(gal.cues.dig ||= { ok: 2, ko: 0 });
  // lettura del numero dalla rete neurale (più fotogrammi già combinati): { num: prob }, readable
  const dig = desc?.digits && desc.readable ? desc.digits : null;
  const base = 1 / Math.max(2, candidates.length);
  const rows = candidates.map((num) => {
    const ss = gal.samples[num] || [];
    const st = ss.filter((s) => s.tpl);
    const tpl = desc?.tpl && st.length ? Math.max(...st.map((s) => tplSimilarity(desc.tpl, s.tpl))) : null;
    const col = desc?.hist && ss.length ? Math.max(0, ...ss.map((s) => histSimilarity(desc.hist, s.hist) ?? 0)) : null;
    const p = pr(num);
    // punteggio in "log-verosimiglianza": il numero conta molto se combacia bene
    let score = wP * Math.log(Math.max(p, 0.005));
    // stesso giocatore: somiglianza tipica > 0.8; numeri diversi: < 0.65 (6 e 8 fino a 0.8).
    // Senza campioni del numero il candidato resta neutro: una somiglianza mediocre con un
    // altro giocatore non basta a scartarlo.
    if (tpl != null) score += wT * 12 * (tpl - 0.72);
    // il colore serve a escludere (libero, altra divisa), non a scegliere tra maglie uguali
    if (col != null) score += wC * 8 * Math.min(0, col - 0.72);
    let dp = null;
    if (dig) { dp = dig[num] ?? 0; score += wD * 1.6 * Math.log((dp + 0.02) / (base + 0.02)); }
    return { num, score, tpl, col, prior: p, n: ss.length, dig: dp };
  }).sort((a, b) => b.score - a.score);
  const z = rows.reduce((s, r) => s + Math.exp(r.score - rows[0].score), 0);
  rows.forEach((r) => { r.p = Math.exp(r.score - rows[0].score) / z; });
  return rows;
}

// dopo la conferma dello scout: rafforza gli indizi che avevano ragione, indebolisce gli altri
// Restituisce false se il campione è stato scartato perché contraddittorio: il numero letto
// combacia benissimo con un ALTRO giocatore registrato, quindi il riquadro del tocco
// inquadrava probabilmente il giocatore sbagliato (non va insegnato).
export function learn(gal, ranking, correct, desc, opts = {}) {
  if (ranking?.length && opts.source !== 'register') {
    const other = ranking.find((r) => r.num !== correct && r.tpl != null && r.tpl >= 0.85);
    const mine = ranking.find((r) => r.num === correct);
    if (other && !(mine?.tpl >= 0.7)) return false;
  }
  if (ranking?.length) {
    const top = (key) => [...ranking].filter((r) => r[key] != null).sort((a, b) => b[key] - a[key])[0];
    for (const [cue, key] of [['tpl', 'tpl'], ['col', 'col'], ['prior', 'prior'], ['dig', 'dig']]) {
      const t = top(key);
      const vals = ranking.map((r) => r[key]).filter((v) => v != null);
      if (vals.length > 1 && Math.max(...vals) - Math.min(...vals) < 1e-6) continue; // indizio muto (tutti uguali)
      if (!t || (key !== 'prior' && key !== 'dig' && !(gal.samples[correct]?.length))) continue;
      (gal.cues[cue] ||= { ok: 1, ko: 0 });
      if (t.num === correct) gal.cues[cue].ok++; else gal.cues[cue].ko++;
    }
  }
  addSample(gal, correct, desc, opts);
  return true;
}

// ---------- sagome fuse: giocatori vicini o sovrapposti nell'immagine ----------
// Dentro una sagoma si cercano le maglie (colori saturi dominanti) e se ne prendono le parti
// connesse: due maglie di colore diverso, o due parti staccate dello stesso colore, sono due
// giocatori. isFg(x, y): pixel in primo piano (diverso dallo sfondo).
export function splitSilhouette(rgba, w, h, ch, box, isFg) {
  const [x0, y0, x1, y1] = box.map(Math.round);
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 6 || bh < 12) return [box];
  const px = (x, y) => { const i = (y * w + x) * ch; return [rgba[i], rgba[i + 1], rgba[i + 2]]; };
  const sat = (c) => Math.max(...c) - Math.min(...c);
  const hist = new Map();
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (x < 0 || y < 0 || x >= w || y >= h || !isFg(x, y)) continue;
    const c = px(x, y);
    n++;
    if (sat(c) < 60) continue;
    const k = ((c[0] >> 5) << 6) | ((c[1] >> 5) << 3) | (c[2] >> 5);
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  const cols = [];
  for (const [k, v] of [...hist.entries()].sort((a, b) => b[1] - a[1])) {
    if (v < n * 0.08) break;
    const C = [((k >> 6) & 7) * 32 + 16, ((k >> 3) & 7) * 32 + 16, (k & 7) * 32 + 16];
    // pelle (testa, braccia): non è una maglia
    if (C[0] > C[1] && C[1] > C[2] && C[0] - C[2] < 110 && C[0] > 150) continue;
    if (!cols.some((q) => Math.abs(q[0] - C[0]) + Math.abs(q[1] - C[1]) + Math.abs(q[2] - C[2]) < 90)) cols.push(C);
  }
  const parts = [];
  for (const C of cols) {
    const m = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const X = x0 + x, Y = y0 + y;
      if (X < 0 || Y < 0 || X >= w || Y >= h || !isFg(X, Y)) continue;
      const c = px(X, Y);
      if (Math.abs(c[0] - C[0]) + Math.abs(c[1] - C[1]) + Math.abs(c[2] - C[2]) < 100) m[y * bw + x] = 1;
    }
    for (const b of comps(m, bw, bh)) {
      if (b.area < bw * bh * 0.03 || b.y1 - b.y0 < bh * 0.25) continue;
      const top = Math.max(y0, y0 + b.y0 - Math.round(bh * 0.14));
      const bottom = b.y1 > bh * 0.75 ? y0 + b.y1 + 1 : y1;
      parts.push([x0 + b.x0, top, x0 + b.x1 + 1, bottom]);
    }
  }
  return parts.length >= 2 ? parts : [box];
}

function comps(m, w, h) {
  const lab = new Int32Array(w * h), out = [];
  const st = [];
  for (let i = 0; i < w * h; i++) {
    if (!m[i] || lab[i]) continue;
    const b = { x0: w, y0: h, x1: 0, y1: 0, area: 0 };
    lab[i] = out.length + 1; st.push(i);
    while (st.length) {
      const j = st.pop(), x = j % w, y = (j / w) | 0;
      b.area++; if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const k = yy * w + xx;
        if (m[k] && !lab[k]) { lab[k] = lab[i]; st.push(k); }
      }
    }
    out.push(b);
  }
  return out;
}
