// Riconoscitore dei numeri di maglia: piccola rete convoluzionale addestrata su maglie
// sintetiche (tools/digits), eseguita in JavaScript puro (nessuna libreria, ~10 ms).
// Ingresso: ritaglio del busto del giocatore; uscita: numero (1-99) con affidabilità, oppure
// "nessun numero leggibile".

export const IN_H = 40, IN_W = 32;
let net = null, loading = null;

export function loadDigitNet(base = new URL('../../models/', import.meta.url).href) {
  if (net) return Promise.resolve(net);
  loading ||= (async () => {
    const meta = await (await fetch(base + 'digitnet.json')).json();
    const buf = await (await fetch(base + 'digitnet.f16')).arrayBuffer();
    net = buildNet(meta, buf);
    return net;
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

// pesi float16 → float32
function f16(buf) {
  const h = new Uint16Array(buf), out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const v = h[i], s = v & 0x8000 ? -1 : 1, e = (v >> 10) & 31, m = v & 1023;
    out[i] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return out;
}

export function buildNet(meta, buf) {
  const flat = buf instanceof Float32Array ? buf : f16(buf);
  const T = {};
  let o = 0;
  for (const [name, shape] of meta.tensors) { const n = shape.reduce((a, b) => a * b, 1); T[name] = { data: flat.subarray(o, o + n), shape }; o += n; }
  return { meta, T };
}

// x: Float32Array HWC (IN_H x IN_W x 3), già normalizzato
export function forward(netw, x) {
  const { meta, T } = netw;
  let h = x, H = IN_H, W = IN_W, C = 3;
  meta.arch.forEach((l, i) => {
    if (l[0] === 'conv') {
      const w = T[`c${i}w`].data, b = T[`c${i}b`].data, Co = l[2], Ci = l[1];
      const out = new Float32Array(H * W * Co);
      for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
        const ob = (y * W + xx) * Co;
        for (let co = 0; co < Co; co++) out[ob + co] = b[co];
        for (let ky = 0; ky < 3; ky++) {
          const yy = y + ky - 1; if (yy < 0 || yy >= H) continue;
          for (let kx = 0; kx < 3; kx++) {
            const x2 = xx + kx - 1; if (x2 < 0 || x2 >= W) continue;
            const ib = (yy * W + x2) * Ci, wb = (ky * 3 + kx) * Ci * Co;
            for (let ci = 0; ci < Ci; ci++) {
              const v = h[ib + ci]; if (v === 0) continue;
              const wr = wb + ci * Co;
              for (let co = 0; co < Co; co++) out[ob + co] += v * w[wr + co];
            }
          }
        }
        for (let co = 0; co < Co; co++) if (out[ob + co] < 0) out[ob + co] = 0;
      }
      h = out; C = Co;
    } else if (l[0] === 'pool') {
      const H2 = H >> 1, W2 = W >> 1, out = new Float32Array(H2 * W2 * C);
      for (let y = 0; y < H2; y++) for (let xx = 0; xx < W2; xx++) for (let c = 0; c < C; c++) {
        const a = h[((2 * y) * W + 2 * xx) * C + c], b2 = h[((2 * y) * W + 2 * xx + 1) * C + c], c2 = h[((2 * y + 1) * W + 2 * xx) * C + c], d = h[((2 * y + 1) * W + 2 * xx + 1) * C + c];
        out[(y * W2 + xx) * C + c] = Math.max(a, b2, c2, d);
      }
      h = out; H = H2; W = W2;
    } else if (l[0] === 'fc') {
      const w = T[`f${i}w`].data, b = T[`f${i}b`].data, N = l[2], K = l[1];
      const out = new Float32Array(N);
      out.set(b);
      for (let k = 0; k < K; k++) { const v = h[k]; if (v === 0) continue; const wr = k * N; for (let n = 0; n < N; n++) out[n] += v * w[wr + n]; }
      for (let n = 0; n < N; n++) if (out[n] < 0) out[n] = 0;
      h = out;
    }
  });
  const head = (wn, bn) => { const w = T[wn].data, b = T[bn].data, out = Float32Array.from(b); for (let k = 0; k < h.length; k++) { const v = h[k]; if (!v) continue; for (let n = 0; n < 11; n++) out[n] += v * w[k * 11 + n]; } return softmax(out); };
  return { tens: head('tw', 'tb'), units: head('uw', 'ub') };
}
const softmax = (a) => { const m = Math.max(...a); const e = a.map((v) => Math.exp(v - m)); const s = e.reduce((x, y) => x + y, 0); return e.map((v) => v / s); };

// ritaglio del busto dal riquadro della persona [x0,y0,x1,y1] (pixel) → ingresso normalizzato
export const TORSO = { x: 0.10, y0: 0.12, y1: 0.60 };
export function torsoInput(rgba, w, h, box, ch = 4) {
  const [x0, y0, x1, y1] = box, bw = x1 - x0, bh = y1 - y0;
  const cx0 = x0 + TORSO.x * bw, cx1 = x1 - TORSO.x * bw, cy0 = y0 + TORSO.y0 * bh, cy1 = y0 + TORSO.y1 * bh;
  const out = new Float32Array(IN_H * IN_W * 3);
  // ricampionamento con media dell'area (come il ridimensionamento del generatore)
  const sx = (cx1 - cx0) / IN_W, sy = (cy1 - cy0) / IN_H;
  for (let y = 0; y < IN_H; y++) for (let x = 0; x < IN_W; x++) {
    const ax = cx0 + x * sx, ay = cy0 + y * sy;
    const nx = Math.max(1, Math.round(sx)), ny = Math.max(1, Math.round(sy));
    let r = 0, g = 0, b = 0, n = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const px = Math.min(w - 1, Math.max(0, Math.floor(ax + (i + 0.5) * sx / nx))), py = Math.min(h - 1, Math.max(0, Math.floor(ay + (j + 0.5) * sy / ny)));
      const k = (py * w + px) * ch; r += rgba[k]; g += rgba[k + 1]; b += rgba[k + 2]; n++;
    }
    const o = (y * IN_W + x) * 3;
    out[o] = r / n / 255; out[o + 1] = g / n / 255; out[o + 2] = b / n / 255;
  }
  let m = 0; for (const v of out) m += v; m /= out.length;
  let s = 0; for (const v of out) s += (v - m) ** 2; s = Math.sqrt(s / out.length) + 0.05;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - m) / s;
  return out;
}

// numero più probabile e distribuzione sui candidati
export function readNumber(netw, input, candidates = null) {
  const { tens, units } = forward(netw, input);
  const pNone = units[10];
  const prob = (n) => (n < 10 ? tens[0] * units[n] : tens[Math.floor(n / 10) + 1] * units[n % 10]);
  let best = null;
  const list = candidates || Array.from({ length: 99 }, (_, i) => i + 1);
  const scores = list.map((n) => ({ num: n, p: prob(n) }));
  for (const s of scores) if (!best || s.p > best.p) best = s;
  return { num: best?.num ?? null, p: best?.p ?? 0, pNone, scores };
}
