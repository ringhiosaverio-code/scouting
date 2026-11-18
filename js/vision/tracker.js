// Tracciamento della palla, individuazione di tocchi, rimbalzi e scambi
// a partire dai candidati prodotti fotogramma per fotogramma (cv.processFrame).

// Regressione polinomiale di grado 2 (o 1) su t -> v; restituisce coefficienti [c0,c1,c2] centrati in tc
function polyfit(ts, vs, tc, deg = 2) {
  const n = ts.length;
  const d = Math.min(deg, n - 1);
  const m = d + 1;
  const A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  for (let k = 0; k < n; k++) {
    const x = ts[k] - tc;
    const pw = [1, x, x * x];
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) A[i][j] += pw[i] * pw[j];
      A[i][m] += pw[i] * vs[k];
    }
  }
  for (let c = 0; c < m; c++) {
    let p = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) return [vs[0], 0, 0];
    for (let r = 0; r < m; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k];
    }
  }
  const coef = A.map((row, i) => row[m] / row[i]);
  while (coef.length < 3) coef.push(0);
  return coef;
}
const evalPoly = (c, x) => c[0] + c[1] * x + c[2] * x * x;

// 1) collega i candidati in tracce (predizione a velocità/accelerazione costante)
export function buildTracks(frames, opts = {}) {
  const maxMiss = opts.maxMiss ?? 4;
  const tracks = [];
  let active = [];
  for (const f of frames) {
    const cands = f.balls.filter((b) => !(opts.ignoreFg && b.fg)).map((b) => ({ ...b, used: false }));
    // predizione per ogni traccia attiva
    const preds = active.map((tr) => {
      const p = tr.pts;
      const last = p[p.length - 1];
      const dt = f.t - last.t;
      let px = last.x, py = last.y, speed = 0;
      if (p.length >= 3) {
        const q = p.slice(-5);
        const cx = polyfit(q.map((z) => z.t), q.map((z) => z.x), last.t, q.length >= 4 ? 2 : 1);
        const cy = polyfit(q.map((z) => z.t), q.map((z) => z.y), last.t, q.length >= 4 ? 2 : 1);
        px = evalPoly(cx, dt); py = evalPoly(cy, dt);
        speed = Math.hypot(cx[1], cy[1]);
      } else if (p.length === 2) {
        const a = p[0];
        const vx = (last.x - a.x) / (last.t - a.t), vy = (last.y - a.y) / (last.t - a.t);
        px = last.x + vx * dt; py = last.y + vy * dt; speed = Math.hypot(vx, vy);
      }
      const gate = (opts.gate ?? 7) + speed * dt * (p.length >= 3 ? 0.35 : 1.2) + (p.length === 1 ? 40 * dt * 30 / 30 + 25 : 0) + tr.miss * 6;
      return { tr, px, py, gate };
    });
    // assegnazione greedy per distanza crescente
    const pairs = [];
    preds.forEach((pr, i) => cands.forEach((c, j) => {
      const d = Math.hypot(c.x - pr.px, c.y - pr.py);
      if (d <= pr.gate) pairs.push({ i, j, d: (d / pr.gate) * (c.fg ? (opts.fgPenalty ?? 1.6) : 1) });
    }));
    pairs.sort((a, b) => a.d - b.d);
    const usedT = new Set();
    for (const pr of pairs) {
      if (usedT.has(pr.i) || cands[pr.j].used) continue;
      usedT.add(pr.i); cands[pr.j].used = true;
      const tr = preds[pr.i].tr;
      tr.pts.push({ t: f.t, x: cands[pr.j].x, y: cands[pr.j].y, inP: cands[pr.j].inP || 0 });
      tr.miss = 0;
    }
    const still = [];
    preds.forEach((pr, i) => {
      if (!usedT.has(i)) pr.tr.miss++;
      if (pr.tr.miss > maxMiss) tracks.push(pr.tr); else still.push(pr.tr);
    });
    active = still;
    // i candidati "da sfondo" non aprono nuove tracce da soli (troppo rumore): solo quelli in movimento
    for (const c of cands) if (!c.used && !(c.fg && opts.fgNoSeed !== false)) active.push({ pts: [{ t: f.t, x: c.x, y: c.y, inP: c.inP || 0 }], miss: 0 });
  }
  tracks.push(...active);
  // toglie le estremità sovrapposte alle sagome (spesso agganci spuri vicino ai giocatori)
  for (const tr of tracks) {
    let a = 0, b = tr.pts.length;
    while (a < b && tr.pts[a].inP) a++;
    while (b > a && tr.pts[b - 1].inP) b--;
    tr.pts = tr.pts.slice(a, b);
  }
  return tracks.filter((tr) => isBallTrack(tr, opts)).sort((a, b) => a.pts[0].t - b.pts[0].t);
}

// una traccia di palla è abbastanza lunga, si sposta, ed è liscia (balistica)
function isBallTrack(tr, opts) {
  const p = tr.pts;
  if (p.length < (opts.minLen ?? 6)) return false;
  const disp = Math.hypot(p[p.length - 1].x - p[0].x, p[p.length - 1].y - p[0].y);
  let path = 0;
  for (let i = 1; i < p.length; i++) path += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  if (path < (opts.minPath ?? 15)) return false;
  // tracce quasi sempre dentro le sagome dei giocatori = bordi di persone in movimento
  const inside = p.reduce((a, q) => a + (q.inP || 0), 0) / p.length;
  if (inside > (opts.maxInside ?? 0.6)) return false;
  // rumore che "salta" avanti e indietro: percorso molto più lungo dello spostamento
  if (path > disp * 4 && disp < 30) return false;
  return true;
}

// 2) catene: tracce consecutive separate da piccoli intervalli formano un volo continuo
export function buildChains(tracks, opts = {}) {
  const maxGap = opts.chainGap ?? 0.6;
  const chains = [];
  for (const tr of tracks) {
    let best = null;
    for (const ch of chains) {
      const last = ch.pts[ch.pts.length - 1];
      const first = tr.pts.find((q) => q.t > last.t + 1e-6);
      if (!first || tr.pts[0].t > last.t + maxGap || tr.pts[0].t < last.t - 0.6) continue;
      const gap = first.t - last.t;
      const d = Math.hypot(first.x - last.x, first.y - last.y);
      const lim = 12 + gap * 400;
      if (d < lim && (!best || gap < best.gap)) best = { ch, gap };
    }
    if (best) {
      const lastT = best.ch.pts[best.ch.pts.length - 1].t;
      const add = tr.pts.filter((p) => p.t > lastT + 1e-6);
      if (add.length) { best.ch.joins.push(best.ch.pts.length); best.ch.pts.push(...add); }
    } else chains.push({ pts: [...tr.pts], joins: [] });
  }
  return chains.filter((c) => c.pts[c.pts.length - 1].t - c.pts[0].t >= (opts.minChain ?? 1.0));
}

function rms(ts, xs, ys, tc) {
  const cx = polyfit(ts, xs, tc, 2), cy = polyfit(ts, ys, tc, 2);
  let e = 0;
  for (let k = 0; k < ts.length; k++) e += (evalPoly(cx, ts[k] - tc) - xs[k]) ** 2 + (evalPoly(cy, ts[k] - tc) - ys[k]) ** 2;
  return { e: Math.sqrt(e / ts.length), cx, cy };
}

// 3) cambi bruschi di traiettoria = tocchi o rimbalzi
export function detectBreaks(chain, opts = {}) {
  const p = chain.pts;
  const win = opts.window ?? 0.25; // secondi per lato
  const cands = [];
  for (let i = 3; i < p.length - 3; i++) {
    const t = p[i].t;
    const L = p.filter((q, k) => k <= i && q.t >= t - win);
    const R = p.filter((q, k) => k >= i && q.t <= t + win);
    if (L.length < 4 || R.length < 4) continue;
    const A = L.concat(R.slice(1));
    const all = rms(A.map((q) => q.t), A.map((q) => q.x), A.map((q) => q.y), t);
    const l = rms(L.map((q) => q.t), L.map((q) => q.x), L.map((q) => q.y), t);
    const r = rms(R.map((q) => q.t), R.map((q) => q.x), R.map((q) => q.y), t);
    const sep = Math.max(0.6, (l.e * L.length + r.e * R.length) / (L.length + R.length));
    const score = all.e / sep;
    if (all.e > (opts.minResidual ?? 1.6) && score > (opts.minScore ?? 2.5)) {
      cands.push({ i, t, x: p[i].x, y: p[i].y, vin: [l.cx[1], l.cy[1]], vout: [r.cx[1], r.cy[1]], score });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const out = [];
  for (const c of cands) if (!out.some((o) => Math.abs(o.t - c.t) < (opts.nms ?? 0.3))) out.push(c);
  // giunzioni tra tracce: tocco nel punto in cui le due traiettorie estrapolate si incontrano
  for (const j of chain.joins) {
    const A = p.slice(Math.max(0, j - 6), j), B = p.slice(j, j + 6);
    if (A.length < 2 || B.length < 2) continue;
    const ta = A[A.length - 1].t, tb = B[0].t;
    const fa = rms(A.map((q) => q.t), A.map((q) => q.x), A.map((q) => q.y), ta);
    const fb = rms(B.map((q) => q.t), B.map((q) => q.x), B.map((q) => q.y), tb);
    // stessa parabola da entrambi i lati = volo continuo (palla persa all'apice o dietro qualcosa)
    if (A.length >= 3 && B.length >= 3) {
      const AB = A.concat(B);
      const all = rms(AB.map((q) => q.t), AB.map((q) => q.x), AB.map((q) => q.y), (ta + tb) / 2);
      const sep = Math.max(0.6, (fa.e * A.length + fb.e * B.length) / AB.length);
      if (all.e < (opts.minResidual ?? 1.6) || all.e / sep < (opts.minScore ?? 2.5)) continue;
    }
    let bt = (ta + tb) / 2, bd = 1e9;
    for (let tt = ta; tt <= tb; tt += 0.01) {
      const d = Math.hypot(evalPoly(fa.cx, tt - ta) - evalPoly(fb.cx, tt - tb), evalPoly(fa.cy, tt - ta) - evalPoly(fb.cy, tt - tb));
      if (d < bd) { bd = d; bt = tt; }
    }
    const x = (evalPoly(fa.cx, bt - ta) + evalPoly(fb.cx, bt - tb)) / 2, y = (evalPoly(fa.cy, bt - ta) + evalPoly(fb.cy, bt - tb)) / 2;
    const near = out.findIndex((o) => Math.abs(o.t - bt) < (opts.nms ?? 0.3));
    if (near >= 0) out.splice(near, 1);
    out.push({ i: j, t: bt, x, y, vin: [fa.cx[1], fa.cy[1]], vout: [fb.cx[1], fb.cy[1]], join: true, score: 3 });
  }
  return out.sort((a, b) => a.t - b.t);
}

// giocatore che tocca: sagoma che contiene la palla (con margine); null se nessuna
export function playerAt(frame, x, y) {
  if (!frame) return null;
  let best = null, bd = 1e9;
  for (const p of frame.players) {
    const hgt = p.y1 - p.y0;
    const mx = Math.max(4, (p.x1 - p.x0) * 0.6);
    if (x < p.x0 - mx || x > p.x1 + mx) continue;
    if (y < p.y0 - hgt * 0.9 || y > p.y1 + 3) continue;
    const d = Math.abs(x - (p.x0 + p.x1) / 2) + Math.max(0, p.y0 - y) * 0.5;
    if (d < bd) { bd = d; best = p; }
  }
  if (!best) return null;
  const hgt = best.y1 - best.y0;
  const rel = (best.y1 - y) / Math.max(1, hgt); // 0 = piedi, 1 = testa
  return { box: best, feet: { x: (best.x0 + best.x1) / 2, y: best.y1 }, rel };
}

// 4) scambi: catena con tocchi classificati (tocco di giocatore / rimbalzo a terra)
export function detectRallies(frames, opts = {}) {
  const tracks = buildTracks(frames, opts);
  const chains = buildChains(tracks, opts);
  const byT = (t) => {
    // fotogramma più vicino
    let lo = 0, hi = frames.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (frames[m].t < t) lo = m + 1; else hi = m; }
    if (lo > 0 && Math.abs(frames[lo - 1].t - t) < Math.abs(frames[lo].t - t)) lo--;
    return frames[lo];
  };
  const rallies = [];
  for (const ch of chains) {
    const breaks = detectBreaks(ch, opts);
    const events = [];
    for (const b of breaks) {
      // la sagoma va cercata un po' prima del contatto (la palla si sovrappone al giocatore)
      let pl = null;
      for (const dt of [0, -0.07, 0.07, -0.14, 0.14]) { pl = playerAt(byT(b.t + dt), b.x, b.y); if (pl) break; }
      const downIn = b.vin ? b.vin[1] > 0 : false;
      const upOut = b.vout ? b.vout[1] < 0 : false;
      let kind = 'touch';
      if (!pl) kind = downIn && upOut ? 'bounce' : 'unknown';
      else if (pl.rel < 0.1 && downIn && upOut) kind = 'bounce';
      events.push({ t: b.t, img: { x: b.x, y: b.y }, feet: pl ? pl.feet : null, kind, conf: pl ? (b.join ? 0.6 : 0.85) : 0.3, rel: pl?.rel ?? null });
    }
    const first = ch.pts[0], last = ch.pts[ch.pts.length - 1];
    rallies.push({ start: first.t, end: last.t, path: ch.pts, events, lastPt: last });
  }
  return { tracks, chains, rallies };
}
