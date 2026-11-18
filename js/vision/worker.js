// Web Worker: elaborazione dei fotogrammi fuori dal thread dell'interfaccia (video riprodotto).
import { toGray, medianImage } from './cv.js';
import { createPipe } from './framepipe.js';

let w = 0, h = 0, bgFrames = [], pipe = null;

self.onmessage = (ev) => {
  const m = ev.data;
  switch (m.type) {
    case 'init':
      ({ w, h } = m); bgFrames = []; pipe = createPipe(w, h, m.opts || {});
      break;
    case 'bg':
      bgFrames.push(toGray(new Uint8ClampedArray(m.rgba), w, h, 4, w, h));
      break;
    case 'bgdone':
      pipe.setBg(medianImage(bgFrames)); bgFrames = [];
      self.postMessage({ type: 'bgready' });
      break;
    case 'frame': {
      const { result, cut } = pipe.push(new Uint8ClampedArray(m.rgba), m.t);
      if (result) self.postMessage({ type: 'result', ...result });
      else self.postMessage({ type: 'result', t: null, cut });
      break;
    }
    case 'reset': // discontinuità (salto nel video): ricomincia la terna di fotogrammi
      pipe.reset();
      break;
    case 'end':
      self.postMessage({ type: 'done' });
      break;
    default:
  }
};
