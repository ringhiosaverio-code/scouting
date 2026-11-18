// Telecamera completa da una sola omografia del pavimento (metodo di Zhang con un piano):
// ipotesi standard — pixel quadrati, nessuna inclinazione, centro ottico al centro dell'immagine.
// Permette la ricostruzione 3D senza cliccare il bordo della rete.

// H: 3x3 (array di 9) che porta metri sul pavimento (X, Y) -> pixel (u, v)
export function cameraFromHomography(H, W, Hh) {
  const cx = W / 2, cy = Hh / 2;
  // sposta l'origine dell'immagine nel centro ottico
  const T = [1, 0, -cx, 0, 1, -cy, 0, 0, 1];
  const M = mul3(T, H);
  const h1 = [M[0], M[3], M[6]], h2 = [M[1], M[4], M[7]], h3 = [M[2], M[5], M[8]];
  // vincoli: h1' w h2 = 0 ; h1' w h1 = h2' w h2 con w = diag(1/f², 1/f², 1)
  const f2a = -(h1[0] * h2[0] + h1[1] * h2[1]) / (h1[2] * h2[2]);
  const f2b = -((h1[0] ** 2 + h1[1] ** 2) - (h2[0] ** 2 + h2[1] ** 2)) / (h1[2] ** 2 - h2[2] ** 2);
  // i due vincoli sono lineari in s = 1/f²: a·s + b = 0. Minimi quadrati: un vincolo mal
  // condizionato (es. asse X parallelo all'immagine, telecamera perfettamente allineata) pesa poco
  const a1 = h1[0] * h2[0] + h1[1] * h2[1], b1 = h1[2] * h2[2];
  const a2 = (h1[0] ** 2 + h1[1] ** 2) - (h2[0] ** 2 + h2[1] ** 2), b2 = h1[2] ** 2 - h2[2] ** 2;
  const s = -(a1 * b1 + a2 * b2) / (a1 * a1 + a2 * a2);
  if (!(s > 0)) return null;
  const f = 1 / Math.sqrt(s);
  const Kinv = (v) => [v[0] / f, v[1] / f, v[2]];
  let r1 = Kinv(h1), r2 = Kinv(h2), t = Kinv(h3);
  const lam = 1 / Math.sqrt(Math.hypot(...r1) * Math.hypot(...r2));
  r1 = r1.map((v) => v * lam); r2 = r2.map((v) => v * lam); t = t.map((v) => v * lam);
  if (t[2] < 0) { r1 = r1.map((v) => -v); r2 = r2.map((v) => -v); t = t.map((v) => -v); }
  // ortonormalizzazione (r1, r2 quasi ortogonali)
  r1 = norm(r1);
  r2 = norm(sub(r2, scale(r1, dot(r1, r2))));
  let r3 = cross(r1, r2);
  const P = [0, 1, 2].map((i) => {
    const K = i === 0 ? [f, 0, cx] : i === 1 ? [0, f, cy] : [0, 0, 1];
    const R = [[r1[0], r2[0], r3[0], t[0]], [r1[1], r2[1], r3[1], t[1]], [r1[2], r2[2], r3[2], t[2]]];
    return [0, 1, 2, 3].map((j) => K[0] * R[0][j] + K[1] * R[1][j] + K[2] * R[2][j]);
  });
  // l'asse Z deve puntare verso l'alto: un punto alto deve apparire più in alto nell'immagine
  const pr = (X) => { const w = P[2][0] * X[0] + P[2][1] * X[1] + P[2][2] * X[2] + P[2][3]; return (P[1][0] * X[0] + P[1][1] * X[1] + P[1][2] * X[2] + P[1][3]) / w; };
  if (pr([4.5, 9, 2.43]) > pr([4.5, 9, 0])) {
    for (const row of P) row[2] = -row[2];
  }
  const sc = P[2][3];
  return { P: P.map((r) => r.map((v) => v / sc)), f, fA: f2a > 0 ? Math.sqrt(f2a) : null, fB: f2b > 0 ? Math.sqrt(f2b) : null };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, k) => a.map((v) => v * k);
const norm = (a) => scale(a, 1 / Math.hypot(...a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function mul3(a, b) {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
}
