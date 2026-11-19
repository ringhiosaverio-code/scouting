// Riconoscitore della palla: piccola rete che guarda il ritaglio attorno a ogni candidato
// (colori + movimento) e dice se è la palla. Addestrata in modo auto-supervisionato: la fisica
// dei voli balistici etichetta da sola gli esempi dei video reali (tools/ball).
export const PATCH = 12; // lato del ritaglio (pixel di lavoro)

// ingresso: PATCH x PATCH x 5 (R, G, B normalizzati; |cur-prev|, |cur-next|), centrato sul candidato
export function patchFeatures(rgba, prev, cur, next, w, h, b) {
  const out = new Float32Array(PATCH * PATCH * 5);
  const x0 = Math.round(b.x) - PATCH / 2, y0 = Math.round(b.y) - PATCH / 2;
  let o = 0;
  for (let y = 0; y < PATCH; y++) for (let x = 0; x < PATCH; x++) {
    const X = Math.min(w - 1, Math.max(0, x0 + x)), Y = Math.min(h - 1, Math.max(0, y0 + y)), i = Y * w + X;
    out[o++] = rgba[i * 4] / 255; out[o++] = rgba[i * 4 + 1] / 255; out[o++] = rgba[i * 4 + 2] / 255;
    out[o++] = Math.abs(cur[i] - prev[i]) / 255; out[o++] = Math.abs(cur[i] - next[i]) / 255;
  }
  return out;
}

// rete (pesi esportati da tools/ball/train.py): conv3x3 → relu → pool → conv3x3 → relu → pool → fc → sigmoide
export function buildBallNet(meta, flat) {
  const T = {}; let o = 0;
  for (const [name, shape] of meta.tensors) { const n = shape.reduce((a, b) => a * b, 1); T[name] = { data: flat.subarray(o, o + n), shape }; o += n; }
  return { meta, T };
}
function conv(h, H, W, Ci, w, b, Co) {
  const out = new Float32Array(H * W * Co);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ob = (y * W + x) * Co;
    for (let c = 0; c < Co; c++) out[ob + c] = b[c];
    for (let ky = 0; ky < 3; ky++) { const yy = y + ky - 1; if (yy < 0 || yy >= H) continue;
      for (let kx = 0; kx < 3; kx++) { const xx = x + kx - 1; if (xx < 0 || xx >= W) continue;
        const ib = (yy * W + xx) * Ci, wb = (ky * 3 + kx) * Ci * Co;
        for (let ci = 0; ci < Ci; ci++) { const v = h[ib + ci]; if (!v) continue; const wr = wb + ci * Co; for (let c = 0; c < Co; c++) out[ob + c] += v * w[wr + c]; } } }
    for (let c = 0; c < Co; c++) if (out[ob + c] < 0) out[ob + c] = 0;
  }
  return out;
}
function pool(h, H, W, C) {
  const H2 = H >> 1, W2 = W >> 1, out = new Float32Array(H2 * W2 * C);
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) for (let c = 0; c < C; c++) {
    const a = h[((2 * y) * W + 2 * x) * C + c], b2 = h[((2 * y) * W + 2 * x + 1) * C + c], d = h[((2 * y + 1) * W + 2 * x) * C + c], e = h[((2 * y + 1) * W + 2 * x + 1) * C + c];
    out[(y * W2 + x) * C + c] = Math.max(a, b2, d, e);
  }
  return out;
}
export function ballScore(net, feats, extra) {
  const { T } = net;
  const c1 = T.c1w.shape[3], c2 = T.c2w.shape[3];
  let hh = conv(feats, PATCH, PATCH, 5, T.c1w.data, T.c1b.data, c1);
  hh = pool(hh, PATCH, PATCH, c1);
  hh = conv(hh, PATCH / 2, PATCH / 2, c1, T.c2w.data, T.c2b.data, c2);
  hh = pool(hh, PATCH / 2, PATCH / 2, c2);
  // + caratteristiche del candidato (area, sulla sagoma di un giocatore, colore del pallone)
  const K = hh.length, F = T.fw.shape[1];
  const z = Float32Array.from(T.fb.data);
  for (let k = 0; k < K; k++) { const v = hh[k]; if (!v) continue; for (let n = 0; n < F; n++) z[n] += v * T.fw.data[k * F + n]; }
  for (let k = 0; k < extra.length; k++) for (let n = 0; n < F; n++) z[n] += extra[k] * T.fw.data[(K + k) * F + n];
  let s = T.ob.data[0];
  for (let n = 0; n < F; n++) if (z[n] > 0) s += z[n] * T.ow.data[n];
  return 1 / (1 + Math.exp(-s));
}
