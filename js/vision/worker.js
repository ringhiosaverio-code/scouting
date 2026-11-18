// Web Worker: elaborazione dei fotogrammi fuori dal thread dell'interfaccia.
import { toGray, medianImage, processFrame } from './cv.js';

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
      const g = toGray(new Uint8ClampedArray(m.rgba), w, h, 4, w, h);
      if (cur && prev) {
        const r = processFrame({ prev, cur, next: g, bg, w, h, opts, state });
        self.postMessage({ type: 'result', t: curT, balls: r.balls, players: r.players });
      } else if (cur) self.postMessage({ type: 'result', t: curT, balls: [], players: [] });
      else self.postMessage({ type: 'result', t: null });
      prev = cur; cur = g; curT = m.t;
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
