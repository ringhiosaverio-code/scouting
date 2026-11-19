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
  // la palla in gioco resta nel palazzetto: un oggetto quasi fermo nell'immagine (persona in
  // giallo, cartellone) si "spiega" come palla lontanissima lungo il raggio visivo
  const inHall = obs.every((o) => { const X = posAt(f, o.t); return X[1] > -12 && X[1] < 28 && X[0] > -7 && X[0] < 16; });
  f.plausible = zMin > -0.7 && speed < 45 && f.p0[2] < 8 && inHall;
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
  if (opts.refineDepth === true && good.length) refineDepths(P, obs, segs, events, opts);
  return { segs, events };
}

// ---- profondità coerente di tutto lo scambio ----
// Con la telecamera dietro il fondo, un volo visto solo in parte (la battuta esce in alto
// dall'inquadratura) ha la profondità ambigua: un tocco a 14 m alto 0,8 m e uno a 4 m alto
// 3 m stanno sullo stesso raggio visivo. Ogni tocco sta sul suo raggio: si cerca l'altezza
// di TUTTI i tocchi insieme (programmazione dinamica) tale che ogni volo tra due tocchi,
// determinato dai due estremi e dalla gravità, passi per le osservazioni intermedie.
export function cameraCenter(P) {
  const M = [[P[0][0], P[0][1], P[0][2]], [P[1][0], P[1][1], P[1][2]], [P[2][0], P[2][1], P[2][2]]];
  const inv = inv3(M);
  if (!inv) return null;
  const p4 = [P[0][3], P[1][3], P[2][3]];
  return { C: inv.map((r) => -(r[0] * p4[0] + r[1] * p4[1] + r[2] * p4[2])), Minv: inv };
}
function inv3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), Cc = d * h - e * g;
  const det = a * A + b * B + c * Cc;
  if (Math.abs(det) < 1e-12) return null;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [Cc / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
// punto del raggio visivo del pixel u all'altezza z
export function rayAtHeight(cam, u, z) {
  const d = [0, 1, 2].map((k) => cam.Minv[k][0] * u[0] + cam.Minv[k][1] * u[1] + cam.Minv[k][2]);
  if (Math.abs(d[2]) < 1e-9) return null;
  const s = (z - cam.C[2]) / d[2];
  if (s <= 0) return null; // dietro la telecamera
  return [cam.C[0] + s * d[0], cam.C[1] + s * d[1], z];
}

export function refineDepths(P, obs, segs, events, opts = {}) {
  const cam = cameraCenter(P);
  if (!cam) return false;
  // nodi: inizio del primo volo, i tocchi/rimbalzi, fine dell'ultimo volo
  const first = segs[0], last = segs[segs.length - 1];
  const nodes = [{ t: obs[first.i].t, u: [obs[first.i].x, obs[first.i].y], free: true }];
  for (const e of events) { const q = project(P, e.X); nodes.push({ t: e.t, u: [q[0], q[1]], ev: e }); }
  nodes.push({ t: obs[last.j - 1].t, u: [obs[last.j - 1].x, obs[last.j - 1].y], free: true });
  for (let k = 1; k < nodes.length; k++) if (nodes[k].t - nodes[k - 1].t < 0.04) return false;
  const inGood = (i) => segs.some((g) => i >= g.i && i < g.j);
  // altezze candidate per nodo
  const grid = nodes.map((n) => {
    let zs;
    if (n.ev && n.ev.kind === 'bounce') zs = [0.11];
    else if (n.free) zs = Array.from({ length: 61 }, (_, k) => 0.1 + k * 0.15);
    else zs = Array.from({ length: 45 }, (_, k) => 0.1 + k * 0.1);
    return zs.map((z) => ({ z, X: rayAtHeight(cam, n.u, z) })).filter((c) => c.X && c.X[0] > -6 && c.X[0] < 15 && c.X[1] > -14 && c.X[1] < 32);
  });
  if (grid.some((g) => !g.length)) return false;
  // osservazioni di ogni volo (tra due nodi consecutivi)
  const flightObs = [];
  for (let k = 0; k + 1 < nodes.length; k++) {
    const a = nodes[k].t, b = nodes[k + 1].t;
    flightObs.push(obs.filter((o, i) => o.t > a + 0.015 && o.t < b - 0.015 && inGood(i)));
  }
  const flightCost = (A, ta, B, tb, ob) => {
    const T = tb - ta;
    const v0 = [(B[0] - A[0]) / T, (B[1] - A[1]) / T, (B[2] - A[2]) / T + 0.5 * G * T];
    if (Math.hypot(...v0) > 38) return { c: 1e6 };
    let c = 0;
    for (const o of ob) {
      const d = o.t - ta;
      const q = project(P, [A[0] + v0[0] * d, A[1] + v0[1] * d, A[2] + v0[2] * d - 0.5 * G * d * d]);
      if (q[2] <= 0) { c += 36; continue; }
      c += Math.min((q[0] - o.x) ** 2 + (q[1] - o.y) ** 2, 36);
    }
    // apice plausibile (palla in palestra)
    const tApex = v0[2] / G;
    if (tApex > 0 && tApex < T) { const zA = A[2] + v0[2] * tApex - 0.5 * G * tApex * tApex; if (zA > 16) c += (zA - 16) * 50; }
    return { c, v0 };
  };
  // programmazione dinamica sulle altezze
  const prior = (n, z) => (n.free ? 0 : z > 3.7 ? (z - 3.7) * 40 : 0);
  // un tocco "a metà volo" (volo che si allontana dalla telecamera spezzato in due) si può
  // saltare: un volo unico dal nodo precedente al successivo; ogni tocco tenuto costa `pen`
  const pen = opts.touchPenalty ?? 60;
  const obsBetween = (a, b) => obs.filter((o, i) => o.t > nodes[a].t + 0.015 && o.t < nodes[b].t - 0.015 && inGood(i));
  const best = grid.map((g) => g.map(() => ({ cost: Infinity, from: null })));
  grid[0].forEach((g, i) => { best[0][i].cost = prior(nodes[0], g.z); });
  for (let b = 1; b < nodes.length; b++) {
    for (let a = b - 1; a >= 0; a--) {
      // si possono saltare solo tocchi (non rimbalzi) e voli non troppo lunghi
      if (a < b - 1 && (nodes[a + 1].ev?.kind === 'bounce' || nodes[b].t - nodes[a].t > 2.8)) break;
      const ob = a === b - 1 ? flightObs[a] : obsBetween(a, b);
      const extra = b < nodes.length - 1 ? pen : 0;
      for (let j = 0; j < grid[b].length; j++) {
        const B = grid[b][j].X;
        for (let i = 0; i < grid[a].length; i++) {
          if (best[a][i].cost === Infinity) continue;
          const { c } = flightCost(grid[a][i].X, nodes[a].t, B, nodes[b].t, ob);
          const tot = best[a][i].cost + c + extra + prior(nodes[b], grid[b][j].z);
          if (tot < best[b][j].cost) { best[b][j].cost = tot; best[b][j].from = [a, i]; }
        }
      }
    }
  }
  const lastN = nodes.length - 1;
  let j = best[lastN].reduce((bi, b, i) => (b.cost < best[lastN][bi].cost ? i : bi), 0);
  const kept = [];
  for (let cur = [lastN, j]; cur; cur = best[cur[0]][cur[1]].from) kept.unshift({ k: cur[0], X: grid[cur[0]][cur[1]].X });
  const nObs = flightObs.reduce((a, o) => a + o.length, 0);
  const rms = Math.sqrt(Math.max(0, best[lastN][j].cost - pen * (kept.length - 2)) / Math.max(1, nObs));
  if (!(rms < (opts.refineMaxRms ?? 3))) return false;
  // voli risultanti e aggiornamento degli eventi (quelli saltati vengono rimossi)
  const flights = [];
  for (let q = 0; q + 1 < kept.length; q++) {
    const A = kept[q], Bn = kept[q + 1];
    const { v0 } = flightCost(A.X, nodes[A.k].t, Bn.X, nodes[Bn.k].t, []);
    flights.push({ t0: nodes[A.k].t, t1: nodes[Bn.k].t, p0: A.X, v0, rms });
  }
  const keptSet = new Set(kept.map((q) => q.k));
  for (let k = nodes.length - 2; k >= 1; k--) if (!keptSet.has(k)) events.splice(events.indexOf(nodes[k].ev), 1);
  for (let q = 1; q + 1 < kept.length; q++) {
    const k = kept[q].k;
    const e = nodes[k].ev, fi = flights[q - 1], fo = flights[q];
    e.X = kept[q].X.map((v) => v);
    e.vin = velAt(fi, nodes[k].t); e.vout = [...fo.v0];
    e.speedIn = Math.hypot(...e.vin); e.speedOut = Math.hypot(...e.vout);
    if (e.kind !== 'bounce' && (e.X[2] < 0.25 || (e.X[2] < (opts.bounceZ ?? 0.45) && e.vin[2] < -1 && e.vout[2] > 0))) { e.kind = 'bounce'; e.X[2] = 0; }
    e.depthRefined = true;
  }
  for (const g of segs) {
    const tm = (g.t0 + g.t1) / 2;
    const f = flights.find((q) => tm >= q.t0 && tm <= q.t1) || flights[0];
    g.fit = { ...g.fit, t0: f.t0, p0: f.p0, v0: f.v0 };
  }
  return true;
}

// Volo che termina (o inizia) in un punto noto A all'istante ta: si stima solo la velocità in A.
// X(t) = A + v (t - ta) - g/2 (t - ta)^2 ez  -> sistema lineare in v (3 incognite), ben condizionato.
// Serve a ricostruire voli visti male (es. battuta dal fondo lontano) dal punto in cui finiscono.
export function fitFlightThrough(P, obs, ta, A) {
  if (obs.length < 3) return null;
  const rows = [], rhs = [];
  for (const o of obs) {
    const d = o.t - ta, c = -0.5 * G * d * d;
    for (const [row, val] of [[P[0], o.x], [P[1], o.y]]) {
      const a = [row[0] - val * P[2][0], row[1] - val * P[2][1], row[2] - val * P[2][2], row[3] - val * P[2][3]];
      rows.push([a[0] * d, a[1] * d, a[2] * d]);
      rhs.push(-(a[0] * A[0] + a[1] * A[1] + a[2] * (A[2] + c) + a[3]));
    }
  }
  const v = solveLS(rows, rhs);
  if (!v) return null;
  // in forma standard (p0 all'istante ta, v0 = v) per usare posAt/velAt
  const f = { t0: ta, p0: [...A], v0: v };
  let sse = 0;
  for (const o of obs) { const q = project(P, posAt(f, o.t)); sse += Math.min((q[0] - o.x) ** 2 + (q[1] - o.y) ** 2, 36); }
  f.rms = Math.sqrt(sse / obs.length);
  return f;
}

// ---- segmentazione 3D: tocchi e profondità insieme ----
// I nodi candidati (un'osservazione ogni `step`) stanno sul raggio visivo della palla; per
// ognuno si prova un insieme di altezze. Un volo tra due nodi è fissato dai due estremi e
// dalla gravità, e costa quanto si discosta dalle osservazioni intermedie. La
// programmazione dinamica sceglie insieme quali nodi sono tocchi (con una penalità per
// tocco) e a che altezza: un volo che si allontana dalla telecamera (palla quasi ferma
// nell'immagine) non viene spezzato in due, e la profondità di ogni tocco è coerente con
// la fisica di tutti i voli. Si applica alle osservazioni già ripulite dai voli spuri.
export function segmentFlights3D(P, obs, opts = {}) {
  const cam = cameraCenter(P);
  const n = obs.length;
  if (!cam || n < 6) return null;
  const step = opts.nodeStep ?? 2, maxDur = opts.maxFlight ?? 2.8, penalty = opts.touchPenalty3d ?? 110;
  const idx = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  const m = idx.length;
  const zIn = Array.from({ length: 23 }, (_, k) => 0.05 + k * 0.18);
  const zEnd = Array.from({ length: 24 }, (_, k) => 0.1 + k * 0.35);
  const cand = idx.map((i, k) => (k === 0 || k === m - 1 ? zEnd : zIn).map((z) => ({ z, X: rayAtHeight(cam, [obs[i].x, obs[i].y], z) })).filter((c) => c.X && c.X[0] > -7 && c.X[0] < 16 && c.X[1] > -12 && c.X[1] < 28));
  if (cand.some((c) => !c.length)) return null;
  const p = P.flat();
  const err2 = (X, o) => {
    const w = p[8] * X[0] + p[9] * X[1] + p[10] * X[2] + p[11];
    if (w <= 0) return 36;
    const u = (p[0] * X[0] + p[1] * X[1] + p[2] * X[2] + p[3]) / w - o.x, v = (p[4] * X[0] + p[5] * X[1] + p[6] * X[2] + p[7]) / w - o.y;
    const e = u * u + v * v;
    return e < 36 ? e : 36;
  };
  const flight = (A, ta, B, tb) => { const T = tb - ta; return [(B[0] - A[0]) / T, (B[1] - A[1]) / T, (B[2] - A[2]) / T + 0.5 * G * T]; };
  const cost = (a, ca, b, cb, limit) => {
    const A = ca.X, B = cb.X, ta = obs[idx[a]].t, tb = obs[idx[b]].t;
    const v = flight(A, ta, B, tb);
    if (v[0] * v[0] + v[1] * v[1] + v[2] * v[2] > 38 * 38) return Infinity;
    const tA = v[2] / G;
    if (tA > 0 && tA < tb - ta && A[2] + v[2] * tA - 0.5 * G * tA * tA > 16) return Infinity;
    let c = 0;
    for (let i = idx[a] + 1; i < idx[b]; i++) {
      const d = obs[i].t - ta;
      c += err2([A[0] + v[0] * d, A[1] + v[1] * d, A[2] + v[2] * d - 0.5 * G * d * d], obs[i]);
      if (c > limit) return Infinity;
    }
    return c;
  };
  const best = cand.map((c) => new Float64Array(c.length).fill(Infinity));
  const from = cand.map((c) => c.map(() => null));
  best[0].fill(0);
  for (let b = 1; b < m; b++) {
    const tb = obs[idx[b]].t;
    for (let a = b - 1; a >= 0; a--) {
      const ta = obs[idx[a]].t;
      if (tb - ta > maxDur) break;
      // due tocchi a meno di ~0,22 s: in pallavolo quasi impossibile (è lo stesso tocco)
      if (obs[idx[b]].t - obs[idx[a]].t < (opts.minTouchGap ?? 0.22) && b !== m - 1 && a !== 0) continue;
      const pen = a === 0 ? 0 : penalty;
      for (let j = 0; j < cand[b].length; j++) {
        for (let i = 0; i < cand[a].length; i++) {
          const base = best[a][i] + pen;
          if (base >= best[b][j]) continue;
          const c = cost(a, cand[a][i], b, cand[b][j], best[b][j] - base);
          if (base + c < best[b][j]) { best[b][j] = base + c; from[b][j] = [a, i]; }
        }
      }
    }
  }
  let b = m - 1;
  while (b > 0 && Math.min(...best[b]) === Infinity) b--;
  if (b === 0) return null;
  let j = 0;
  for (let k = 1; k < best[b].length; k++) if (best[b][k] < best[b][j]) j = k;
  const chain0 = [];
  for (let cur = [b, j]; cur; cur = from[cur[0]][cur[1]]) chain0.unshift({ node: cur[0], c: cand[cur[0]][cur[1]] });
  // rifinitura continua: ogni nodo può spostarsi di qualche osservazione e l'altezza
  // varia finemente (la griglia è grossolana), con i nodi vicini fissi
  const chain = chain0.map((q) => ({ i: idx[q.node], X: q.c.X, z: q.c.z }));
  const segCost = (A, ia, B, ib) => {
    const ta = obs[ia].t, tb = obs[ib].t;
    if (tb - ta < 0.05) return Infinity;
    const v = flight(A, ta, B, tb);
    if (v[0] * v[0] + v[1] * v[1] + v[2] * v[2] > 38 * 38) return Infinity;
    let c = 0;
    for (let i = ia + 1; i < ib; i++) { const d = obs[i].t - ta; c += err2([A[0] + v[0] * d, A[1] + v[1] * d, A[2] + v[2] * d - 0.5 * G * d * d], obs[i]); }
    return c;
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < chain.length; k++) {
      const prevN = chain[k - 1], nextN = chain[k + 1], me = chain[k];
      let bestC = Infinity, bestS = null;
      const lo = prevN ? prevN.i + 2 : 0, hi = nextN ? nextN.i - 2 : n - 1;
      for (let i = Math.max(lo, me.i - 2); i <= Math.min(hi, me.i + 2); i++) {
        if ((k === 0 && i !== me.i) || (k === chain.length - 1 && i !== me.i)) continue;
        for (let dz = -0.3; dz <= 0.3001; dz += 0.03) {
          const z = Math.max(0.05, me.z + dz);
          const X = rayAtHeight(cam, [obs[i].x, obs[i].y], z);
          if (!X) continue;
          const c = (prevN ? segCost(prevN.X, prevN.i, X, i) : 0) + (nextN ? segCost(X, i, nextN.X, nextN.i) : 0);
          if (c < bestC) { bestC = c; bestS = { i, X, z }; }
        }
      }
      if (bestS) Object.assign(me, bestS);
    }
  }
  const segs = [], events = [];
  for (let k = 0; k + 1 < chain.length; k++) {
    const a = { node: null, c: { X: chain[k].X } }, z = { c: { X: chain[k + 1].X } };
    const ia = chain[k].i, ib = chain[k + 1].i;
    const ta = obs[ia].t, tb = obs[ib].t;
    const v0 = flight(a.c.X, ta, z.c.X, tb);
    let sse = 0, cnt = 0;
    for (let i = ia; i <= ib; i++) { const d = obs[i].t - ta; sse += err2([a.c.X[0] + v0[0] * d, a.c.X[1] + v0[1] * d, a.c.X[2] + v0[2] * d - 0.5 * G * d * d], obs[i]); cnt++; }
    segs.push({ i: ia, j: ib + 1, t0: ta, t1: tb, fit: { t0: ta, p0: [...a.c.X], v0, sse, rms: Math.sqrt(sse / cnt), n: cnt, plausible: true } });
  }
  for (let k = 1; k + 1 < chain.length; k++) {
    const A = segs[k - 1], B = segs[k], X = [...chain[k].X];
    const t = B.t0;
    const vin = velAt(A.fit, t), vout = [...B.fit.v0];
    const angle = Math.acos(Math.max(-1, Math.min(1, (vin[0] * vout[0] + vin[1] * vout[1] + vin[2] * vout[2]) / (Math.hypot(...vin) * Math.hypot(...vout) || 1)))) * 180 / Math.PI;
    const bounce = X[2] < 0.25 || (X[2] < (opts.bounceZ ?? 0.45) && vin[2] < -1 && vout[2] > 0);
    if (bounce) X[2] = 0;
    events.push({ t, X, vin, vout, gap: 0, angle, kind: bounce ? 'bounce' : 'touch', speedIn: Math.hypot(...vin), speedOut: Math.hypot(...vout), conf: Math.min(1, 3 / (1 + A.fit.rms + B.fit.rms)), missing: B.t0 - A.t1 > 0.9, seg3d: true });
  }
  const total = segs.reduce((a, g) => a + g.fit.sse, 0), cnt = segs.reduce((a, g) => a + g.fit.n, 0);
  return { segs, events, rms: Math.sqrt(total / Math.max(1, cnt)) };
}
