// Geometria del campo: coordinate DataVolley, zone, sottozone, omografia video->campo.
//
// Sistema di coordinate "campo" (unità DataVolley, 1 unità = 3 m):
//   x da 0.5 (sinistra) a 3.5 (destra), y da 0.5 (fondo squadra in basso) a 6.5 (fondo squadra in alto)
//   rete a y = 3.5, linee dei 3 m a y = 2.5 e y = 4.5.
// Convenzione interna: la squadra di casa ("*") è sempre la metà in basso (y < 3.5).

export const NET_Y = 3.5;

// Punti di riferimento del campo usati per la calibrazione (coordinate campo, lato "vicino" = y basso)
export const REF_POINTS = [
  { id: 'nl', label: 'Angolo vicino sinistro', x: 0.5, y: 0.5, required: true },
  { id: 'nr', label: 'Angolo vicino destro', x: 3.5, y: 0.5, required: true },
  { id: 'fr', label: 'Angolo lontano destro', x: 3.5, y: 6.5, required: true },
  { id: 'fl', label: 'Angolo lontano sinistro', x: 0.5, y: 6.5, required: true },
  { id: 'n3l', label: '3 m vicino, sinistra', x: 0.5, y: 2.5 },
  { id: 'n3r', label: '3 m vicino, destra', x: 3.5, y: 2.5 },
  { id: 'cl', label: 'Linea centrale, sinistra', x: 0.5, y: 3.5 },
  { id: 'cr', label: 'Linea centrale, destra', x: 3.5, y: 3.5 },
  { id: 'f3l', label: '3 m lontano, sinistra', x: 0.5, y: 4.5 },
  { id: 'f3r', label: '3 m lontano, destra', x: 3.5, y: 4.5 },
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---- griglia DataVolley 100 x 101 ----
export function xy2index(x, y) {
  if (x == null || y == null || Number.isNaN(x) || Number.isNaN(y)) return null;
  const xi = clamp(Math.floor((x - 0.5) * 80 / 3 + 11), 1, 100);
  const yi = clamp(Math.floor((y - 0.5) * 81 / 6 + 11), 1, 101);
  return xi + (yi - 1) * 100;
}

export function index2xy(index) {
  if (!index || index < 1) return null;
  const xi = ((index - 1) % 100) + 1;
  const yi = Math.floor((index - 1) / 100) + 1;
  const x = 0.5 + (xi - 11 + 0.5) / 80 * 3;
  const y = 0.5 + (yi - 11 + 0.5) / 81 * 6;
  return { x, y };
}

// R round(): arrotondamento "half to even"
function rround(v) {
  const f = Math.floor(v);
  const d = v - f;
  if (Math.abs(d - 0.5) < 1e-12) return f % 2 === 0 ? f : f + 1;
  return Math.round(v);
}

const ZONE_GRID = [
  [5, 6, 1], // y=1 (fondo, metà in basso)
  [7, 8, 9],
  [4, 3, 2], // vicino alla rete
  [2, 3, 4], // metà in alto, vicino alla rete
  [9, 8, 7],
  [1, 6, 5],
];

export function xy2zone(x, y) {
  if (x == null || y == null) return null;
  const xr = clamp(rround(x), 1, 3);
  const yr = clamp(rround(y), 1, 6);
  return ZONE_GRID[yr - 1][xr - 1];
}

// zona di battuta (posizione lungo la linea di fondo)
export function xy2serveZone(x, y) {
  const breaks = [1.1, 1.7, 2.3, 2.9];
  let b = 0;
  while (b < breaks.length && x > breaks[b]) b++;
  const zm = [5, 7, 6, 9, 1];
  return y > NET_Y ? zm.slice().reverse()[b] : zm[b];
}

export function xy2subzone(x, y) {
  if (x == null || y == null) return null;
  const xi = clamp(Math.ceil((x - 0.5) / 0.5), 1, 6);
  const yi = clamp(Math.ceil((y - 0.5) / 0.5), 1, 12);
  const xodd = xi % 2 === 1;
  const yodd = yi % 2 === 1;
  if (yi <= 6) return yodd ? (xodd ? 'D' : 'A') : (xodd ? 'C' : 'B');
  return yodd ? (xodd ? 'B' : 'C') : (xodd ? 'A' : 'D');
}

// Centro di una zona (per la squadra nella metà in basso / in alto)
export function zoneCentre(zone, half = 'bottom') {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const rr = half === 'bottom' ? r : r + 3;
      if (ZONE_GRID[rr][c] === zone) return { x: c + 1, y: rr + 1 };
    }
  }
  return null;
}

export const isBottomHalf = (y) => y < NET_Y;
export const teamHalf = (team) => (team === '*' ? 'bottom' : 'top');

// Riflette un punto nella metà campo della squadra indicata (es. attacco cliccato oltre la rete)
export function intoTeamHalf(pt, team) {
  if (!pt) return pt;
  const wantBottom = team === '*';
  if (isBottomHalf(pt.y) === wantBottom) return pt;
  return { x: pt.x, y: 2 * NET_Y - pt.y };
}

export function zoneForTeam(pt, team) {
  if (!pt) return null;
  const p = intoTeamHalf(pt, team);
  return xy2zone(p.x, p.y);
}

// Inverte la convenzione (per squadre che hanno cambiato campo)
export const flipXY = (p) => (p ? { x: 4 - p.x, y: 7 - p.y } : p);

// ---- Omografia ----
// Risolve H (3x3, h33=1) ai minimi quadrati da >= 4 corrispondenze src->dst
export function computeHomography(src, dst) {
  const n = src.length;
  if (n < 4 || dst.length !== n) throw new Error('Servono almeno 4 punti');
  // normalizzazione (Hartley) per stabilità numerica
  const norm = (pts) => {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const d = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length || 1;
    const s = Math.SQRT2 / d;
    return { T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1], pts: pts.map((p) => ({ x: s * (p.x - cx), y: s * (p.y - cy) })) };
  };
  const ns = norm(src);
  const nd = norm(dst);
  const A = [];
  const b = [];
  for (let i = 0; i < n; i++) {
    const { x, y } = ns.pts[i];
    const { x: u, y: v } = nd.pts[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
  }
  // equazioni normali
  const M = Array.from({ length: 8 }, () => new Array(9).fill(0));
  for (let r = 0; r < A.length; r++) {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) M[i][j] += A[r][i] * A[r][j];
      M[i][8] += A[r][i] * b[r];
    }
  }
  const h = gaussSolve(M);
  const Hn = [...h, 1];
  // H = Td^-1 * Hn * Ts
  const H = matMul(matMul(invert3(nd.T), Hn), ns.T);
  const k = H[8];
  return H.map((v) => v / k);
}

function gaussSolve(M) {
  const n = M.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('Punti degeneri (allineati?)');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function matMul(a, b) {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
}

export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) throw new Error('Matrice singolare');
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}

export function applyH(H, p) {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

// Calibrazione: { points: {id: {x,y}} } in coordinate immagine normalizzate (0..1)
export function buildCalibration(points) {
  const ids = REF_POINTS.filter((r) => points[r.id]);
  if (ids.length < 4 || !REF_POINTS.filter((r) => r.required).every((r) => points[r.id])) return null;
  const src = ids.map((r) => points[r.id]);
  const dst = ids.map((r) => ({ x: r.x, y: r.y }));
  const H = computeHomography(src, dst);
  const Hinv = invert3(H);
  // errore di riproiezione medio in metri
  const err = ids.reduce((s, r) => {
    const q = applyH(H, points[r.id]);
    return s + Math.hypot(q.x - r.x, q.y - r.y) * 3;
  }, 0) / ids.length;
  return { H, Hinv, error: err, n: ids.length };
}

// Linee del campo (in coordinate campo) per il disegno
export const COURT_LINES = [
  [[0.5, 0.5], [3.5, 0.5]], [[3.5, 0.5], [3.5, 6.5]], [[3.5, 6.5], [0.5, 6.5]], [[0.5, 6.5], [0.5, 0.5]],
  [[0.5, 2.5], [3.5, 2.5]], [[0.5, 4.5], [3.5, 4.5]], [[0.2, 3.5], [3.8, 3.5]],
];

export const round2 = (v) => Math.round(v * 1000) / 1000;
