// Web Worker: elaborazione dei fotogrammi fuori dal thread dell'interfaccia.
import { toGray, medianImage, processFrame, ballColorMask } from './cv.js';

let curColor = null, curRgba = null, cutAt = null;
let w = 0, h = 0, bg = null, bgFrames = [], prev = null, cur = null, curT = null, opts = {}, state = {};

self.onmessage = (ev) => {
  const m = ev.data;
  switch (m.type) {
    case 'init':
      ({ w, h } = m); opts = m.opts || {}; bg = null; bgFrames = []; prev = cur = null; curT = null; state = {};
      break;
    case 'bg':
      bgFrames.push(toGray(new Uint8ClampedArray(m.rgba), w, h, 4, w, h));
      break;
    case 'bgdone':
      bg = medianImage(bgFrames); bgFrames = [];
      self.postMessage({ type: 'bgready' });
      break;
    case 'frame': {
      const rgba = new Uint8ClampedArray(m.rgba);
      const g = toGray(rgba, w, h, 4, w, h);
      // taglio o dissolvenza nel video: quasi tutta l'immagine cambia -> si riparte da zero
      if (cur) {
        let d = 0;
        for (let i = 0; i < g.length; i += 7) d += Math.abs(g[i] - cur[i]);
        if (d / (g.length / 7) > (opts.cutThr ?? 18)) { prev = cur = null; curT = null; state = {}; cutAt = m.t; }
      }
      if (cur && prev) {
        const r = processFrame({ prev, cur, next: g, bg, w, h, opts, state, color: curColor, rgb: curRgba, ch: 4 });
        self.postMessage({ type: 'result', t: curT, balls: r.balls, players: r.players, vd: r.vd });
      } else if (cur) self.postMessage({ type: 'result', t: curT, balls: [], players: [] });
      else self.postMessage({ type: 'result', t: null, cut: cutAt });
      cutAt = null;
      prev = cur; cur = g; curT = m.t; curRgba = rgba;
      curColor = opts.ballColor && opts.ballColor !== 'any' ? ballColorMask(rgba, w, h, 4, w, h, opts.ballColor) : null;
      break;
    }
    case 'reset': // discontinuità (salto nel video): ricomincia la terna di fotogrammi
      prev = cur = null; curT = null; state = {};
      break;
    case 'end':
      self.postMessage({ type: 'done' });
      break;
    default:
  }
};
