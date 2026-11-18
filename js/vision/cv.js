// Primitive di visione artificiale in JavaScript puro (nessuna dipendenza),
// usate sia nel browser (Web Worker) sia nei test con Node.

// RGB/RGBA -> scala di grigi ridimensionata (media dei pixel del blocco)
export function toGray(src, sw, sh, channels, dw, dh) {
  const out = new Uint8Array(dw * dh);
  if (sw === dw && sh === dh) {
    for (let i = 0, j = 0; i < dw * dh; i++, j += channels) out[i] = (77 * src[j] + 150 * src[j + 1] + 29 * src[j + 2]) >> 8;
    return out;
  }
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
  if (kind !== 'yellow') return null;
  const out = new Uint8Array(dw * dh);
  if (sw === dw && sh === dh) {
    for (let i = 0, j = 0; i < dw * dh; i++, j += channels) {
      const r = src[j], g = src[j + 1];
      if (r > 110 && g > 105) { const b = src[j + 2]; if ((r < g ? r : g) - b > 35 && (r > g ? r - g : g - r) < 70) out[i] = 1; }
    }
    return out;
  }
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

// Componenti connesse (4- o 8-connessione) per segmenti di riga: si lavora sulle sequenze di
// pixel accesi invece che pixel per pixel (molto più veloce sulle maschere sparse).
// Restituisce i blob con statistiche, nell'ordine in cui compaiono nella scansione.
let _rs = new Int32Array(0), _re = new Int32Array(0), _ry = new Int32Array(0), _rl = new Int32Array(0), _par = new Int32Array(0);
export function components(m, w, h, minArea = 1, conn8 = false) {
  // 1) segmenti di riga
  let nr = 0;
  const grow = () => {
    const k = Math.max(1024, _rs.length * 2);
    const g = (a) => { const b = new Int32Array(k); b.set(a); return b; };
    _rs = g(_rs); _re = g(_re); _ry = g(_ry); _rl = g(_rl); _par = g(_par);
  };
  const rowStart = new Int32Array(h + 1);
  for (let y = 0; y < h; y++) {
    rowStart[y] = nr;
    const row = y * w;
    let x = 0;
    while (x < w) {
      if (!m[row + x]) { x++; continue; }
      const a = x;
      while (x < w && m[row + x]) x++;
      if (nr >= _rs.length) grow();
      _rs[nr] = a; _re[nr] = x - 1; _ry[nr] = y; nr++;
    }
  }
  rowStart[h] = nr;
  if (!nr) return [];
  const rs = _rs, re = _re, ry = _ry, par = _par;
  for (let i = 0; i < nr; i++) par[i] = i;
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  // 2) unione con i segmenti sovrapposti della riga precedente
  const d = conn8 ? 1 : 0;
  for (let y = 1; y < h; y++) {
    let j = rowStart[y - 1];
    const jEnd = rowStart[y];
    for (let i = rowStart[y]; i < rowStart[y + 1]; i++) {
      const a = rs[i] - d, b = re[i] + d;
      while (j < jEnd && re[j] < a) j++;
      for (let k = j; k < jEnd && rs[k] <= b; k++) {
        const p = find(i), q = find(k);
        if (p !== q) { if (p < q) par[q] = p; else par[p] = q; }
      }
    }
  }
  // 3) statistiche per componente (radice = segmento più in alto a sinistra)
  const stats = new Map();
  const out = [];
  for (let i = 0; i < nr; i++) {
    const r = find(i);
    let st = stats.get(r);
    if (!st) { st = { area: 0, sx: 0, sy: 0, x0: rs[i], y0: ry[i], x1: re[i], y1: ry[i] }; stats.set(r, st); out.push(st); }
    const len = re[i] - rs[i] + 1;
    st.area += len; st.sx += (rs[i] + re[i]) * len / 2; st.sy += ry[i] * len;
    if (rs[i] < st.x0) st.x0 = rs[i]; if (re[i] > st.x1) st.x1 = re[i]; if (ry[i] > st.y1) st.y1 = ry[i];
  }
  const res = [];
  for (const st of out) {
    if (st.area < minArea) continue;
    const bw = st.x1 - st.x0 + 1, bh = st.y1 - st.y0 + 1;
    res.push({ area: st.area, x: st.sx / st.area, y: st.sy / st.area, x0: st.x0, y0: st.y0, x1: st.x1, y1: st.y1, w: bw, h: bh, fill: st.area / (bw * bh) });
  }
  return res;
}

// Elaborazione di un fotogramma: candidati palla (oggetti piccoli e compatti in
// movimento) e sagome dei giocatori (primo piano rispetto allo sfondo).
// prev/cur/next: fotogrammi in grigio consecutivi; bg: sfondo mediano
// rgb (facoltativo): fotogramma a colori (rw x rh, ch canali) per il colore delle maglie
export function processFrame({ prev, cur, next, bg, w, h, opts = {}, state = null, color = null, rgb = null, rw = w, rh = h, ch = 4 }) {
  const motionThr = opts.motionThr ?? 22;
  const fgThr = opts.fgThr ?? 30;
  const ballMax = opts.ballMaxArea ?? Math.max(30, Math.round((w * 0.03) ** 2));
  const ballMin = opts.ballMinArea ?? 2;
  const playerMin = opts.playerMinArea ?? Math.round(w * h * 0.0012);
  const res = { balls: [], players: [] };
  const smallFg = [];
  // distanza media dallo sfondo: alta quando l'inquadratura non è quella principale
  // (replay, primo piano, grafica a tutto schermo)
  if (bg) { let d = 0, n = 0; for (let i = 0; i < cur.length; i += 11) { d += Math.abs(cur[i] - bg[i]); n++; } res.vd = +(d / n).toFixed(1); }
  if (bg) {
    const fm = diffMask(cur, bg, fgThr);
    for (const b of components(fm, w, h, ballMin)) {
      if (b.area >= playerMin) {
        if (b.h < b.w * 0.8) continue; // le persone sono più alte che larghe
        const pl = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, cx: +b.x.toFixed(1), a: b.area };
        if (rgb) { const c = torsoColor(rgb, rw, rh, ch, cur, bg, w, h, b, fgThr); if (c) pl.col = c; }
        res.players.push(pl);
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

// colore medio del busto di una sagoma (solo pixel diversi dallo sfondo): distingue le squadre
function torsoColor(rgb, rw, rh, ch, cur, bg, w, h, b, fgThr) {
  const sx = rw / w, sy = rh / h;
  const y0 = Math.round(b.y0 + (b.y1 - b.y0) * 0.22), y1 = Math.round(b.y0 + (b.y1 - b.y0) * 0.6);
  const x0 = Math.round(b.x0 + (b.x1 - b.x0) * 0.2), x1 = Math.round(b.x1 - (b.x1 - b.x0) * 0.2);
  let r = 0, g = 0, bl = 0, n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (Math.abs(cur[y * w + x] - bg[y * w + x]) <= fgThr) continue;
    const i = (Math.min(rh - 1, Math.round(y * sy)) * rw + Math.min(rw - 1, Math.round(x * sx))) * ch;
    r += rgb[i]; g += rgb[i + 1]; bl += rgb[i + 2]; n++;
  }
  return n >= 4 ? [Math.round(r / n), Math.round(g / n), Math.round(bl / n)] : null;
}
