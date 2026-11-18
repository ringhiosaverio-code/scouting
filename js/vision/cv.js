// Primitive di visione artificiale in JavaScript puro (nessuna dipendenza),
// usate sia nel browser (Web Worker) sia nei test con Node.

// RGB/RGBA -> scala di grigi ridimensionata (media dei pixel del blocco)
export function toGray(src, sw, sh, channels, dw, dh) {
  const out = new Uint8Array(dw * dh);
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * sw + x0) * channels;
        for (let xx = x0; xx < x1; xx++, i += channels) { s += 77 * src[i] + 150 * src[i + 1] + 29 * src[i + 2]; n++; }
      }
      out[y * dw + x] = (s / n) >> 8;
    }
  }
  return out;
}

// Maschera dei pixel del colore del pallone (giallo del Mikasa giallo/blu), ridimensionata
export function ballColorMask(src, sw, sh, channels, dw, dh, kind = 'yellow') {
  const out = new Uint8Array(dw * dh);
  if (kind !== 'yellow') return null;
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let hit = 0;
      for (let yy = y0; yy < y1 && !hit; yy++) {
        let i = (yy * sw + x0) * channels;
        for (let xx = x0; xx < x1; xx++, i += channels) {
          const r = src[i], g = src[i + 1], b = src[i + 2];
          if (r > 110 && g > 105 && Math.min(r, g) - b > 35 && Math.abs(r - g) < 70) { hit = 1; break; }
        }
      }
      out[y * dw + x] = hit;
    }
  }
  return out;
}

// Mediana pixel per pixel di più fotogrammi (sfondo senza giocatori in movimento)
export function medianImage(frames) {
  const n = frames.length, len = frames[0].length;
  const out = new Uint8Array(len);
  const buf = new Uint8Array(n);
  for (let i = 0; i < len; i++) {
    for (let k = 0; k < n; k++) buf[k] = frames[k][i];
    buf.sort();
    out[i] = buf[n >> 1];
  }
  return out;
}

// maschera: |a-b| > thr (e opzionalmente |b-c| > thr: differenza a tre fotogrammi)
export function diffMask(a, b, thr, c = null) {
  const m = new Uint8Array(a.length);
  if (c) { for (let i = 0; i < a.length; i++) m[i] = Math.abs(a[i] - b[i]) > thr && Math.abs(c[i] - b[i]) > thr ? 1 : 0; }
  else for (let i = 0; i < a.length; i++) m[i] = Math.abs(a[i] - b[i]) > thr ? 1 : 0;
  return m;
}

// apertura morfologica leggera (rimuove pixel isolati) — erosione 3x3 a croce con soglia
export function denoise(m, w, h) {
  const o = new Uint8Array(m.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      const n = m[i - 1] + m[i + 1] + m[i - w] + m[i + w];
      if (n >= 1) o[i] = 1;
    }
  }
  return o;
}

// Componenti connesse (4-connessione, union-find). Restituisce blob con statistiche.
export function components(m, w, h, minArea = 1, conn8 = false) {
  const lab = new Int32Array(m.length);
  const parent = [0];
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  let next = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      const nb = [x > 0 ? lab[i - 1] : 0, y > 0 ? lab[i - w] : 0];
      if (conn8 && y > 0) { if (x > 0) nb.push(lab[i - w - 1]); if (x < w - 1) nb.push(lab[i - w + 1]); }
      const ls = nb.filter(Boolean);
      if (!ls.length) { lab[i] = next; parent.push(next); next++; continue; }
      const roots = ls.map(find);
      const r = Math.min(...roots);
      lab[i] = r;
      for (const q of roots) if (q !== r) parent[q] = r;
    }
  }
  const stats = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!lab[i]) continue;
      const r = find(lab[i]);
      let s = stats.get(r);
      if (!s) stats.set(r, (s = { area: 0, sx: 0, sy: 0, x0: x, y0: y, x1: x, y1: y }));
      s.area++; s.sx += x; s.sy += y;
      if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x; if (y < s.y0) s.y0 = y; if (y > s.y1) s.y1 = y;
    }
  }
  const out = [];
  for (const s of stats.values()) {
    if (s.area < minArea) continue;
    const bw = s.x1 - s.x0 + 1, bh = s.y1 - s.y0 + 1;
    out.push({ area: s.area, x: s.sx / s.area, y: s.sy / s.area, x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, w: bw, h: bh, fill: s.area / (bw * bh) });
  }
  return out;
}

// Elaborazione di un fotogramma: candidati palla (oggetti piccoli e compatti in
// movimento) e sagome dei giocatori (primo piano rispetto allo sfondo).
// prev/cur/next: fotogrammi in grigio consecutivi; bg: sfondo mediano
export function processFrame({ prev, cur, next, bg, w, h, opts = {}, state = null, color = null }) {
  const motionThr = opts.motionThr ?? 22;
  const fgThr = opts.fgThr ?? 30;
  const ballMax = opts.ballMaxArea ?? Math.max(30, Math.round((w * 0.03) ** 2));
  const ballMin = opts.ballMinArea ?? 2;
  const playerMin = opts.playerMinArea ?? Math.round(w * h * 0.0012);
  const res = { balls: [], players: [] };
  const smallFg = [];
  if (bg) {
    const fm = diffMask(cur, bg, fgThr);
    for (const b of components(fm, w, h, ballMin)) {
      if (b.area >= playerMin) {
        if (b.h < b.w * 0.8) continue; // le persone sono più alte che larghe
        res.players.push({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, cx: +b.x.toFixed(1), a: b.area });
      } else if (b.area <= ballMax && b.fill >= 0.4 && Math.max(b.w, b.h) / Math.min(b.w, b.h) <= 2.2) smallFg.push(b);
    }
  }
  if (prev && next) {
    const mm = diffMask(prev, cur, motionThr, next);
    for (const b of components(mm, w, h, ballMin)) {
      if (b.area > ballMax) continue;
      const aspect = Math.max(b.w, b.h) / Math.min(b.w, b.h);
      if (aspect > 3.2 || b.fill < 0.3) continue;
      // candidato sovrapposto a una sagoma: probabilmente bordo di un giocatore in movimento
      const inP = res.players.some((p) => b.x >= p.x0 - 2 && b.x <= p.x1 + 2 && b.y >= p.y0 - 2 && b.y <= p.y1 + 2);
      res.balls.push({ x: +b.x.toFixed(2), y: +b.y.toFixed(2), a: b.area, inP: inP ? 1 : 0 });
    }
  }
  // filtro colore: il candidato deve contenere pixel del colore del pallone diversi dallo sfondo
  if (color && bg) {
    const fgThr2 = fgThr * 0.6;
    const colorFg = (x, y) => color[y * w + x] && Math.abs(cur[y * w + x] - bg[y * w + x]) > fgThr2;
    const hasColor = (b) => {
      const r = 2;
      for (let y = Math.max(0, Math.round(b.y) - r); y <= Math.min(h - 1, Math.round(b.y) + r); y++) for (let x = Math.max(0, Math.round(b.x) - r); x <= Math.min(w - 1, Math.round(b.x) + r); x++) if (colorFg(x, y)) return true;
      return false;
    };
    res.balls = res.balls.filter(hasColor);
    // oggetti piccoli del colore del pallone anche se fermi o lenti (palla lontana, palla all'apice)
    const cm = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) cm[i] = color[i] && Math.abs(cur[i] - bg[i]) > fgThr2 ? 1 : 0;
    const hist = state ? (state.chist ||= []) : [];
    const seenHere = (b) => hist.filter((fr) => fr.some((q) => Math.abs(q.x - b.x) < 2 && Math.abs(q.y - b.y) < 2)).length;
    const blobs = components(cm, w, h, 1, true).filter((b) => b.area <= ballMax && Math.max(b.w, b.h) <= 3 * Math.min(b.w, b.h) + 1);
    if (state) { hist.push(blobs.map((b) => ({ x: b.x, y: b.y }))); if (hist.length > 12) hist.shift(); }
    for (const b of blobs) {
      if (seenHere(b) >= 6) continue; // fermo: tabellone, persona a bordo campo
      if (res.balls.some((c) => Math.abs(c.x - b.x) < 4 && Math.abs(c.y - b.y) < 4)) continue;
      const inP = res.players.some((p) => b.x >= p.x0 - 2 && b.x <= p.x1 + 2 && b.y >= p.y0 - 2 && b.y <= p.y1 + 2);
      res.balls.push({ x: +b.x.toFixed(2), y: +b.y.toFixed(2), a: b.area, inP: inP ? 1 : 0, col: 1 });
    }
  }
  // palla spezzata in due da una linea o dalla rete: unisce i candidati molto vicini
  const merged = [];
  for (const b of res.balls.sort((p, q) => q.a - p.a)) {
    const m = merged.find((c) => Math.hypot(c.x - b.x, c.y - b.y) < (opts.mergeDist ?? 5));
    if (m) { const a = m.a + b.a; m.x = +((m.x * m.a + b.x * b.a) / a).toFixed(2); m.y = +((m.y * m.a + b.y * b.a) / a).toFixed(2); m.a = a; m.inP = m.inP && b.inP; }
    else merged.push({ ...b });
  }
  res.balls = merged;
  // oggetti piccoli e compatti diversi dallo sfondo: vedono la palla anche quando si muove poco
  // (es. battuta dal fondo lontano, che viaggia verso la telecamera)
  if (opts.useForeground === true) {
    // memoria delle posizioni recenti: un oggetto fermo per molti fotogrammi non è la palla in gioco
    const hist = state ? (state.hist ||= []) : [];
    const stationary = (b) => hist.filter((fr) => fr.some((q) => Math.abs(q.x - b.x) < 1.5 && Math.abs(q.y - b.y) < 1.5)).length >= 6;
    const keep = [];
    for (const b of smallFg) {
      if (stationary(b)) continue;
      keep.push(b);
    }
    if (state) { hist.push(smallFg.map((b) => ({ x: b.x, y: b.y }))); if (hist.length > 10) hist.shift(); }
    for (const b of keep) {
      if (res.balls.some((c) => Math.abs(c.x - b.x) < 3 && Math.abs(c.y - b.y) < 3)) continue;
      const inP = res.players.some((p) => b.x >= p.x0 - 2 && b.x <= p.x1 + 2 && b.y >= p.y0 - 2 && b.y <= p.y1 + 2);
      if (inP) continue;
      res.balls.push({ x: +b.x.toFixed(2), y: +b.y.toFixed(2), a: b.area, inP: 0, fg: 1 });
    }
  }
  return res;
}
