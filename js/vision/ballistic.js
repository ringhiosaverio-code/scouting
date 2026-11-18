// Ricostruzione 3D della palla: matrice di proiezione della telecamera (DLT) e
// segmentazione delle osservazioni in voli balistici (gravità nota).
// Coordinate 3D in metri: X 0..9 (larghezza), Y 0..18 (Y=0 fondo "vicino" alla
// telecamera), Z altezza. Rete a Y = 9.

export const G = 9.81;

// ---- algebra lineare minima ----
function solveLS(rows, rhs) {
  // minimi quadrati via equazioni normali + eliminazione di Gauss con pivot
  const n = rows[0].length;
  const A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r], b = rhs[r];
    for (let i = 0; i < n; i++) {
      if (row[i] === 0) continue;
      for (let j = 0; j < n; j++) A[i][j] += row[i] * row[j];
      A[i][n] += row[i] * b;
    }
  }
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (f) for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

// Matrice 3x4 da corrispondenze 3D (metri) -> 2D (qualsiasi unità), con normalizzazione
export function cameraMatrix(pts3, pts2) {
  if (pts3.length < 6) throw new Error('Servono almeno 6 punti (con almeno uno fuori dal pavimento)');
  if (!pts3.some((p) => Math.abs(p[2]) > 0.1)) throw new Error('Serve almeno un punto in altezza (bordo della rete)');
  const m2 = pts2.reduce((a, p) => [a[0] + p[0] / pts2.length, a[1] + p[1] / pts2.length], [0, 0]);
  const s2 = Math.SQRT2 / (pts2.reduce((a, p) => a + Math.hypot(p[0] - m2[0], p[1] - m2[1]), 0) / pts2.length || 1);
  const m3 = [0, 1, 2].map((k) => pts3.reduce((a, p) => a + p[k], 0) / pts3.length);
  const s3 = Math.sqrt(3) / (pts3.reduce((a, p) => a + Math.hypot(p[0] - m3[0], p[1] - m3[1], p[2] - m3[2]), 0) / pts3.length || 1);
  const rows = [], rhs = [];
  for (let i = 0; i < pts3.length; i++) {
    const X = pts3[i].map((v, k) => (v - m3[k]) * s3);
    const u = (pts2[i][0] - m2[0]) * s2, v = (pts2[i][1] - m2[1]) * s2;
    rows.push([X[0], X[1], X[2], 1, 0, 0, 0, 0, -u * X[0], -u * X[1], -u * X[2]]); rhs.push(u);
    rows.push([0, 0, 0, 0, X[0], X[1], X[2], 1, -v * X[0], -v * X[1], -v * X[2]]); rhs.push(v);
  }
  const h = solveLS(rows, rhs);
  if (!h) throw new Error('Calibrazione 3D degenere');
  const Pn = [[h[0], h[1], h[2], h[3]], [h[4], h[5], h[6], h[7]], [h[8], h[9], h[10], 1]];
  // de-normalizza: P = T2^-1 * Pn * T3
  const T3 = [[s3, 0, 0, -s3 * m3[0]], [0, s3, 0, -s3 * m3[1]], [0, 0, s3, -s3 * m3[2]], [0, 0, 0, 1]];
  const T2inv = [[1 / s2, 0, m2[0]], [0, 1 / s2, m2[1]], [0, 0, 1]];
  const PT = Pn.map((r) => [0, 1, 2, 3].map((j) => r.reduce((a, v, k) => a + v * T3[k][j], 0)));
  const P = T2inv.map((r) => [0, 1, 2, 3].map((j) => r.reduce((a, v, k) => a + v * PT[k][j], 0)));
  const sc = P[2][3] || 1;
  return P.map((r) => r.map((v) => v / sc));
}

export function project(P, X) {
  const w = P[2][0] * X[0] + P[2][1] * X[1] + P[2][2] * X[2] + P[2][3];
  return [(P[0][0] * X[0] + P[0][1] * X[1] + P[0][2] * X[2] + P[0][3]) / w, (P[1][0] * X[0] + P[1][1] * X[1] + P[1][2] * X[2] + P[1][3]) / w, w];
}

export function reprojError(P, pts3, pts2) {
  return pts3.reduce((a, X, i) => { const q = project(P, X); return a + Math.hypot(q[0] - pts2[i][0], q[1] - pts2[i][1]); }, 0) / pts3.length;
}

// ---- volo balistico ----
// X(t) = p0 + v0*(t - t0) + [0, 0, -g/2 (t - t0)^2]
export function posAt(f, t) {
  const d = t - f.t0;
  return [f.p0[0] + f.v0[0] * d, f.p0[1] + f.v0[1] * d, f.p0[2] + f.v0[2] * d - 0.5 * G * d * d];
}
export const velAt = (f, t) => [f.v0[0], f.v0[1], f.v0[2] - G * (t - f.t0)];

// stima (p0, v0) da osservazioni [{t,x,y}] (pixel): sistema lineare in 6 incognite
export function fitFlight(P, obs, t0 = obs[0].t, anchor = null) {
  if (obs.length < 4) return null;
  const rows = [], rhs = [];
  if (anchor) {
    // vincolo morbido: la traiettoria passa per il punto di contatto noto (continuità tra voli)
    const d = anchor.t - t0, c = -0.5 * G * d * d, w = anchor.w ?? 120;
    rows.push([w, 0, 0, w * d, 0, 0], [0, w, 0, 0, w * d, 0], [0, 0, w, 0, 0, w * d]);
    rhs.push(w * anchor.X[0], w * anchor.X[1], w * (anchor.X[2] - c));
  }
  for (const o of obs) {
    const d = o.t - t0;
    const c = -0.5 * G * d * d;
    for (const [row, val] of [[P[0], o.x], [P[1], o.y]]) {
      // (P_row - val * P3) . [X;1] = 0, con X = p0 + v0 d + [0,0,c]
      const a = [row[0] - val * P[2][0], row[1] - val * P[2][1], row[2] - val * P[2][2], row[3] - val * P[2][3]];
      // peso ~ 1/profondità per approssimare l'errore in pixel (profondità stimata a 15 m)
      rows.push([a[0], a[1], a[2], a[0] * d, a[1] * d, a[2] * d]);
      rhs.push(-(a[3] + a[2] * c));
    }
  }
  const s = solveLS(rows, rhs);
  if (!s) return null;
  const f = { t0, p0: [s[0], s[1], s[2]], v0: [s[3], s[4], s[5]] };
  // errore di riproiezione (pixel), robusto
  let sse = 0, n = 0;
  for (const o of obs) {
    const X = posAt(f, o.t);
    const q = project(P, X);
    if (q[2] <= 0) { sse += 100; n++; continue; }
    const e2 = (q[0] - o.x) ** 2 + (q[1] - o.y) ** 2;
    sse += Math.min(e2, 36); n++;
  }
  f.sse = sse; f.rms = Math.sqrt(sse / n); f.n = n;
  // vincoli fisici: palla sopra il pavimento (con tolleranza) e velocità plausibile
  const zMin = Math.min(...obs.map((o) => posAt(f, o.t)[2]));
  const speed = Math.hypot(...f.v0);
  f.plausible = zMin > -0.7 && speed < 45 && f.p0[2] < 8;
  return f;
}

// Segmentazione ottimale (programmazione dinamica) in voli balistici.
// Restituisce i voli e gli eventi (tocchi/rimbalzi) tra un volo e il successivo.
export function segmentFlights(P, obs, opts = {}) {
  const n = obs.length;
  const maxDur = opts.maxFlight ?? 2.8;
  const minPts = opts.minPts ?? 5;
  const penalty = opts.penalty ?? 60;
  const best = new Array(n + 1).fill(Infinity);
  const from = new Array(n + 1).fill(-1);
  const fits = new Map();
  best[0] = 0;
  for (let j = minPts; j <= n; j++) {
    for (let i = j - minPts; i >= 0; i--) {
      if (obs[j - 1].t - obs[i].t > maxDur) break;
      if (best[i] === Infinity) continue;
      const f = fitFlight(P, obs.slice(i, j));
      if (!f) continue;
      const cost = f.sse + penalty + (f.plausible ? 0 : 400);
      if (best[i] + cost < best[j]) { best[j] = best[i] + cost; from[j] = i; fits.set(`${i},${j}`, f); }
    }
  }
  // punti non coperti alla fine: accetta l'ultimo indice raggiungibile
  let end = n;
  while (end > 0 && best[end] === Infinity) end--;
  const segs = [];
  for (let j = end; j > 0;) {
    const i = from[j];
    if (i < 0) break;
    segs.unshift({ i, j, fit: fits.get(`${i},${j}`), t0: obs[i].t, t1: obs[j - 1].t });
    j = i;
  }
  // continuità: un volo mal condizionato (es. attacco che si allontana dalla telecamera)
  // viene ristimato vincolandolo al punto di contatto con un volo vicino ben stimato
  const strong = (g) => g.fit && g.fit.plausible && g.j - g.i >= 12 && g.fit.rms < 1.2;
  const refit = (g, anchorSeg, t) => {
    const X = posAt(anchorSeg.fit, t);
    const f = fitFlight(P, obs.slice(g.i, g.j), obs[g.i].t, { t, X });
    if (f && f.plausible && f.rms < Math.max(1.5, (g.fit?.rms ?? 9) + 0.6)) g.fit = f;
  };
  for (let k = 1; k < segs.length; k++) {
    const A = segs[k - 1], B = segs[k];
    if (B.t0 - A.t1 > 0.3) continue;
    const t = (A.t1 + B.t0) / 2;
    if (strong(A) && !strong(B)) refit(B, A, t);
    else if (strong(B) && !strong(A)) refit(A, B, t);
  }
  // rifinitura dei bordi: i primi/ultimi punti di un volo possono appartenere al volo adiacente
  for (const g of segs) {
    if (!g.fit || g.fit.rms < (opts.trimRms ?? 1.2)) continue;
    for (const side of ['start', 'end']) {
      let best = null;
      for (let k = 1; k <= 3; k++) {
        const i = side === 'start' ? g.i + k : g.i, j = side === 'end' ? g.j - k : g.j;
        if (j - i < minPts) break;
        const f = fitFlight(P, obs.slice(i, j));
        if (f && f.plausible && f.rms < g.fit.rms * 0.6 && f.rms < 1.0 && (!best || f.rms < best.f.rms)) best = { i, j, f };
      }
      if (best) { g.i = best.i; g.j = best.j; g.fit = best.f; g.t0 = obs[g.i].t; g.t1 = obs[g.j - 1].t; }
    }
  }
  // tiene solo i voli ben stimati (gli altri sono di solito punti spuri)
  const good = segs.filter((g) => g.fit && g.fit.plausible && g.fit.rms <= (opts.maxRms ?? 2.6) && g.j - g.i >= minPts);
  const weight = (g) => (g.j - g.i) * Math.max(0.05, g.t1 - g.t0) ** 2 / (0.3 + g.fit.rms);
  const events = [];
  for (let k = 0; k + 1 < good.length; k++) {
    const A = good[k], B = good[k + 1];
    // istante del contatto: dove le due traiettorie proiettate si incontrano nell'immagine
    let bt = (A.t1 + B.t0) / 2, bd = 1e9;
    for (let t = A.t1 - 0.1; t <= B.t0 + 0.1; t += 0.005) {
      const a = project(P, posAt(A.fit, t)), b = project(P, posAt(B.fit, t));
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (d < bd) { bd = d; bt = t; }
    }
    const a = posAt(A.fit, bt), b = posAt(B.fit, bt);
    const wa = weight(A), wb = weight(B);
    const X = [0, 1, 2].map((i) => (a[i] * wa + b[i] * wb) / (wa + wb));
    const vin = velAt(A.fit, bt), vout = velAt(B.fit, bt);
    const angle = Math.acos(Math.max(-1, Math.min(1, (vin[0] * vout[0] + vin[1] * vout[1] + vin[2] * vout[2]) / (Math.hypot(...vin) * Math.hypot(...vout) || 1)))) * 180 / Math.PI;
    // continuità: due voli quasi identici = falso tocco (rumore)
    if (angle < (opts.minAngle ?? 12) && Math.abs(Math.hypot(...vin) - Math.hypot(...vout)) < 2) continue;
    if (X[2] < -0.6) continue; // contatto sotto il pavimento: stima incoerente
    // rimbalzo: contatto a terra e la palla risale più lenta (perde energia);
    // una ricezione/difesa bassa invece la rilancia in alto
    const bounce = X[2] < 0.25 || (X[2] < (opts.bounceZ ?? 0.45) && vin[2] < -1 && vout[2] > 0);
    if (bounce) {
      // punto di atterraggio dal volo in arrivo (più lungo e stabile): z = raggio della palla
      const f = A.fit, d0 = f.t0;
      const a2 = -0.5 * G, b2 = f.v0[2], c2 = f.p0[2] - 0.11;
      const disc = b2 * b2 - 4 * a2 * c2;
      if (disc >= 0) {
        const tl = d0 + (-b2 - Math.sqrt(disc)) / (2 * a2);
        if (Math.abs(tl - bt) < 0.25) { const q = posAt(f, tl); X[0] = q[0]; X[1] = q[1]; X[2] = 0; bt = tl; }
      }
    }
    const missing = B.t0 - A.t1 > 0.9; // probabile tocco perso in mezzo
    events.push({ t: bt, X, vin, vout, gap: bd, angle, kind: bounce ? 'bounce' : 'touch', speedIn: Math.hypot(...vin), speedOut: Math.hypot(...vout), conf: missing ? 0.4 : Math.min(1, 2 / (1 + bd)), missing });
  }
  segs.length = 0; segs.push(...good);
  return { segs, events };
}
