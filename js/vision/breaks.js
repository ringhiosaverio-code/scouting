// Cosa succede tra uno scambio e l'altro: pausa normale, time-out, video check,
// fine set, cambio campo; e scambi troncati da un taglio o da un replay.
//
// Segnali usati (per fotogramma, calcolati dal worker):
//  - sagome dei giocatori con i piedi riportati sul campo (omografia) → quanti sono in campo
//  - colore medio del busto → quale squadra sta in quale metà campo
//  - distanza dallo sfondo (vd) → inquadratura principale o no (replay, primo piano, grafica)
// Le soglie sono in secondi di gioco reali (pallavolo di alto livello: 12–25 s tra due
// punti, time-out 30 s, video check 1–2 min, intervallo tra i set 3 min).

import { applyH } from '../lib/court.js';

export const BREAK_DEFAULTS = {
  pointGapMax: 30,     // oltre: pausa da spiegare
  setBreakMin: 120,    // oltre, a giocatori fuori campo: intervallo tra i set
  outFrac: 0.45,       // giocatori in campo rispetto agli scambi: sotto → sono usciti (time-out, intervallo)
  offViewFactor: 2.5,  // vd oltre questo multiplo della mediana → inquadratura diversa
  colourMin: 28,       // distanza minima tra i colori delle squadre per fidarsi del confronto
};

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const medCol = (cols) => (cols.length >= 3 ? [0, 1, 2].map((k) => median(cols.map((c) => c[k]))) : null);

// piedi delle sagome sul campo (metri)
function feet(players, Hpx) {
  return players.map((p) => ({ ...applyH(Hpx, { x: (p.x0 + p.x1) / 2, y: p.y1 }), a: p.a, col: p.col }));
}
const inCourt = (q) => q.x > -1 && q.x < 10 && q.y > -1.5 && q.y < 19.5;

function frameStats(fr, Hpx) {
  const ff = feet(fr.players || [], Hpx);
  let tot = 0, inside = 0;
  for (const q of ff) { tot += q.a; if (inCourt(q)) inside += q.a; }
  return { inside, tot, ff };
}

// colori delle due metà campo in un intervallo di tempo
export function sideColours(frames, Hpx, t0, t1) {
  const near = [], far = [];
  for (const fr of frames) {
    if (fr.t < t0 || fr.t > t1 || !fr.players) continue;
    for (const q of feet(fr.players, Hpx)) {
      if (!q.col || !inCourt(q) || Math.abs(q.y - 9) < 0.8) continue;
      (q.y < 9 ? near : far).push(q.col);
    }
  }
  const n = medCol(near), f = medCol(far);
  return n && f ? { near: n, far: f } : null;
}

// le squadre risultano scambiate rispetto al riferimento? true / false / null (non si sa)
export function swappedVs(ref, cur, minDist = BREAK_DEFAULTS.colourMin) {
  if (!ref || !cur) return null;
  if (dist(ref.near, ref.far) < minDist || dist(cur.near, cur.far) < minDist) return null;
  const same = dist(ref.near, cur.near) + dist(ref.far, cur.far);
  const swap = dist(ref.near, cur.far) + dist(ref.far, cur.near);
  if (Math.abs(same - swap) < minDist) return null;
  return swap < same;
}

// rallies: [{start, end, landing, ...}] in ordine; restituisce
//   breaks: [{ after (indice scambio), start, end, dur, kind, conf, why }]
//   rallies arricchiti con colours e flag cutEnd / offView
export function analyzeBreaks(frames, rallies, Hpx, { cuts = [], ...o } = {}) {
  const opt = { ...BREAK_DEFAULTS, ...o };
  const vds = frames.map((f) => f.vd).filter((v) => v != null);
  const vdMed = median(vds) ?? 0;
  const offThr = Math.max(vdMed * opt.offViewFactor, vdMed + 12);
  const off = (fr) => fr.vd != null && fr.vd > offThr;
  const stats = new Map(frames.map((fr) => [fr, frameStats(fr, Hpx)]));
  // riferimento: giocatori in campo durante gli scambi
  const inRally = (t) => rallies.some((r) => t >= r.start && t <= r.end);
  const refIn = median(frames.filter((fr) => inRally(fr.t) && !off(fr)).map((fr) => stats.get(fr).inside).filter((v) => v > 0)) || 1;

  const out = rallies.map((r) => {
    const fr = frames.filter((f) => f.t >= r.start && f.t <= r.end + 1.5);
    const offEnd = fr.filter((f) => f.t > r.end - 0.6).some(off);
    const cutEnd = cuts.some((c) => c > r.end - 0.8 && c < r.end + 1.5) || offEnd;
    return { ...r, colours: sideColours(frames, Hpx, r.start, r.end), cutEnd: cutEnd && !(r.landing && !r.landing.extrapolated && !offEnd) };
  });

  const breaks = [];
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i], b = out[i + 1];
    const start = a.end, end = b.start, dur = end - start;
    // colori: l'ultimo scambio con colori noti prima della pausa contro il primo dopo
    const before = out.slice(0, i + 1).reverse().find((r) => r.colours)?.colours;
    const after = out.slice(i + 1).find((r) => r.colours)?.colours;
    const sw = (a.colours && b.colours) || dur >= opt.pointGapMax ? swappedVs(before, after, opt.colourMin) : null;
    if (dur < opt.pointGapMax && !sw) continue;
    const mid = frames.filter((f) => f.t > start + 3 && f.t < end - 3);
    const inF = mid.length ? median(mid.filter((f) => !off(f)).map((f) => stats.get(f).inside / refIn)) ?? 0 : 1;
    const offF = mid.length ? mid.filter(off).length / mid.length : 0;
    let kind, conf, why;
    if (sw) {
      kind = dur >= opt.setBreakMin ? 'setbreak' : 'side';
      conf = 0.8; why = 'le maglie hanno cambiato metà campo';
    } else if (dur >= opt.setBreakMin && inF < opt.outFrac) {
      kind = 'setbreak'; conf = 0.6; why = `${Math.round(dur)} s di pausa, giocatori fuori dal campo`;
    } else if (inF < opt.outFrac) {
      kind = 'timeout'; conf = dur < 75 ? 0.7 : 0.5; why = `${Math.round(dur)} s, giocatori fuori dal campo (verso le panchine)`;
    } else {
      kind = 'videocheck'; conf = offF > 0.25 ? 0.7 : 0.55;
      why = `${Math.round(dur)} s di gioco fermo con i giocatori in campo${offF > 0.25 ? ', con replay a video' : ''}`;
    }
    breaks.push({ after: i, start: +start.toFixed(2), end: +end.toFixed(2), dur: +dur.toFixed(1), kind, conf, why, inF: +inF.toFixed(2), offF: +offF.toFixed(2) });
  }
  return { rallies: out, breaks };
}

export const BREAK_LABEL = {
  timeout: '⏱ Time-out?',
  videocheck: '📺 Video check?',
  setbreak: '🏁 Fine set?',
  side: '⇅ Cambio campo?',
};
