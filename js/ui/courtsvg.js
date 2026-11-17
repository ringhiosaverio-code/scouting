// Disegno del campo schematico (SVG) in coordinate DataVolley. Casa in basso.
import { s } from './dom.js';
import { zoneCentre } from '../lib/court.js';

export const W = 4, H = 7;
// margine attorno al campo (zona di battuta e fuori campo)
const VB = { x: -0.3, y: -0.7, w: 4.6, h: 8.4 };
export const toSvg = (p) => ({ x: p.x, y: H - p.y });

export function courtSVG({ zones = true, cls = 'court-svg', teamColours = null } = {}) {
  const svg = s('svg', { viewBox: `${VB.x} ${VB.y} ${VB.w} ${VB.h}`, class: cls, preserveAspectRatio: 'xMidYMid meet' });
  const g = s('g', { class: 'court-base' });
  g.appendChild(s('rect', { x: VB.x, y: VB.y, width: VB.w, height: VB.h, class: 'court-out' }));
  g.appendChild(s('rect', { x: 0.5, y: 0.5, width: 3, height: 3, class: 'court-half top', style: teamColours ? `fill:${teamColours.a}22` : null }));
  g.appendChild(s('rect', { x: 0.5, y: 3.5, width: 3, height: 3, class: 'court-half bottom', style: teamColours ? `fill:${teamColours['*']}22` : null }));
  g.appendChild(s('line', { x1: 0.5, y1: 2.5, x2: 3.5, y2: 2.5, class: 'court-line' }));
  g.appendChild(s('line', { x1: 0.5, y1: 4.5, x2: 3.5, y2: 4.5, class: 'court-line' }));
  g.appendChild(s('rect', { x: 0.5, y: 0.5, width: 3, height: 6, class: 'court-border' }));
  g.appendChild(s('line', { x1: 0.25, y1: 3.5, x2: 3.75, y2: 3.5, class: 'court-net' }));
  if (zones) {
    for (const half of ['bottom', 'top']) {
      for (let z = 1; z <= 9; z++) {
        const c = zoneCentre(z, half);
        const p = toSvg(c);
        g.appendChild(s('text', { x: p.x, y: p.y, class: 'zone-label' }, z));
      }
    }
    for (const v of [1.5, 2.5]) {
      g.appendChild(s('line', { x1: v, y1: 0.5, x2: v, y2: 6.5, class: 'zone-line' }));
    }
    for (const v of [1.5, 5.5]) g.appendChild(s('line', { x1: 0.5, y1: v, x2: 3.5, y2: v, class: 'zone-line' }));
  }
  svg.appendChild(g);
  svg.appendChild(s('g', { class: 'court-layer' }));
  return svg;
}

export function eventToCourt(svg, ev) {
  const pt = svg.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  const q = pt.matrixTransform(svg.getScreenCTM().inverse());
  return { x: q.x, y: H - q.y };
}

const POS_XY_BOTTOM = { 1: [3, 1], 2: [3, 3], 3: [2, 3], 4: [1, 3], 5: [1, 1], 6: [2, 1] };
export function positionXY(pos, team) {
  const [x, y] = POS_XY_BOTTOM[pos];
  return team === '*' ? { x, y: y - 0.05 } : { x: 4 - x, y: 7 - y + 0.05 };
}

export function arrow(layer, a, b, { cls = '', colour = null, width = 0.03, title = null } = {}) {
  const p = toSvg(a), q = toSvg(b);
  const g = s('g', { class: `arrow ${cls}` });
  if (title) g.appendChild(s('title', {}, title));
  g.appendChild(s('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke: colour, 'stroke-width': width }));
  const ang = Math.atan2(q.y - p.y, q.x - p.x);
  const L = 0.12;
  const pts = [[q.x, q.y], [q.x - L * Math.cos(ang - 0.4), q.y - L * Math.sin(ang - 0.4)], [q.x - L * Math.cos(ang + 0.4), q.y - L * Math.sin(ang + 0.4)]];
  g.appendChild(s('polygon', { points: pts.map((x) => x.join(',')).join(' '), fill: colour }));
  layer.appendChild(g);
  return g;
}

export function dot(layer, a, { r = 0.07, cls = '', colour = null, label = null, title = null } = {}) {
  const p = toSvg(a);
  const g = s('g', { class: `dot ${cls}` });
  if (title) g.appendChild(s('title', {}, title));
  g.appendChild(s('circle', { cx: p.x, cy: p.y, r, fill: colour }));
  if (label != null) g.appendChild(s('text', { x: p.x, y: p.y, class: 'dot-label', 'font-size': r * 1.3 }, label));
  layer.appendChild(g);
  return g;
}
