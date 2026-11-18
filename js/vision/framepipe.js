// Elaborazione di una sequenza di fotogrammi RGBA già ridimensionati (w x h): rilevamento dei
// tagli, scala di grigi, colore del pallone e processFrame sulla terna prev/cur/next.
// Condivisa dal worker tradizionale (video riprodotto) e da quello veloce (WebCodecs).
import { toGray, processFrame, ballColorMask } from './cv.js';

export function createPipe(w, h, opts = {}) {
  let prev = null, cur = null, curT = null, curRgba = null, curColor = null, state = {}, bg = null;
  return {
    setBg(b) { bg = b; },
    reset() { prev = cur = null; curT = null; state = {}; },
    // restituisce { result } per il fotogramma precedente (o null), { cut: t } se c'è un taglio
    push(rgba, t) {
      const g = toGray(rgba, w, h, 4, w, h);
      let cut = null, result = null;
      // taglio o dissolvenza nel video: quasi tutta l'immagine cambia -> si riparte da zero
      if (cur) {
        let d = 0;
        for (let i = 0; i < g.length; i += 7) d += Math.abs(g[i] - cur[i]);
        if (d / (g.length / 7) > (opts.cutThr ?? 18)) { prev = cur = null; curT = null; state = {}; cut = t; }
      }
      if (cur && prev) {
        const r = processFrame({ prev, cur, next: g, bg, w, h, opts, state, color: curColor, rgb: curRgba, ch: 4 });
        result = { t: curT, balls: r.balls, players: r.players, vd: r.vd };
      } else if (cur) result = { t: curT, balls: [], players: [] };
      prev = cur; cur = g; curT = t; curRgba = rgba;
      curColor = opts.ballColor && opts.ballColor !== 'any' ? ballColorMask(rgba, w, h, 4, w, h, opts.ballColor) : null;
      return { result, cut };
    },
  };
}
