// Registrazione dei giocatori sul video ("chi è chi"), come la calibrazione del campo:
// sul fotogramma corrente l'app trova le sagome, propone squadra e numero, lo scout
// conferma o corregge con un clic. Ogni conferma entra nella galleria della squadra
// (vision/playerid.js), che poi riconosce i giocatori nei tocchi dell'analisi automatica
// e continua a imparare dalle correzioni.

import { h, s, clear, toast } from './dom.js';
import { backgroundFromVideo, corsFor } from '../vision/analyzer.js';
import { toGray, processFrame } from '../vision/cv.js';
import { describe, identify, learn, emptyGallery, splitSilhouette } from '../vision/playerid.js';
import { prepareJersey, readDigits, torsoBox } from '../vision/jersey.js';
import { buildCalibration, applyH } from '../lib/court.js';
import { liberos } from '../lib/engine.js';

const bgCache = new Map();
export const galleryOf = (match, team) => (match.teams[team].gallery ||= emptyGallery());
export const galleryCount = (match, team) => Object.values(galleryOf(match, team).samples).filter((l) => l.length).length;

// numeri candidati: in campo + liberi (o tutta la rosa se non ci sono formazioni)
export function candidatesFor(app, team) {
  const cur = app.rp.current;
  const roster = app.match.teams[team].players.map((p) => Number(p.number));
  if (!cur?.pos?.[team]?.length) return roster;
  return [...new Set([...cur.pos[team], ...liberos(app.match, team).map(Number)])];
}

// fotogramma corrente a piena risoluzione (max 1920 px)
function grabFrame(video) {
  const k = Math.min(1, 1920 / video.videoWidth);
  const w = Math.round(video.videoWidth * k), hh = Math.round(video.videoHeight * k);
  const c = document.createElement('canvas'); c.width = w; c.height = hh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, hh);
  return { rgba: ctx.getImageData(0, 0, w, hh).data, w, h: hh };
}

async function background(video) {
  const src = video.currentSrc;
  let bg = bgCache.get(src);
  if (!bg) {
    toast('Prima volta: stima dello sfondo del video (qualche secondo)…', 'info', 4000);
    const b = await backgroundFromVideo(src, { width: 640, samples: 24 });
    bg = { gray: toGray(b.rgb, b.W, b.H, 3, b.W, b.H), w: b.W, h: b.H };
    bgCache.set(src, bg);
  }
  return bg;
}
// primo piano alla risoluzione del fotogramma (confronto con lo sfondo a 640 px)
function fgTest(frame, bg) {
  const cur = toGray(frame.rgba, frame.w, frame.h, 4, bg.w, bg.h);
  const k = frame.w / bg.w;
  return { cur, k, isFg: (x, y) => { const i = Math.min(bg.h - 1, Math.floor(y / k)) * bg.w + Math.min(bg.w - 1, Math.floor(x / k)); return Math.abs(cur[i] - bg.gray[i]) > 30; } };
}

async function silhouettes(video, frame) {
  const bg = await background(video);
  const { cur, k, isFg } = fgTest(frame, bg);
  const r = processFrame({ cur, bg: bg.gray, w: bg.w, h: bg.h, opts: { playerMinArea: Math.round(bg.w * bg.h * 0.0008) } });
  return r.players
    .map((p) => [p.x0 * k, p.y0 * k, (p.x1 + 1) * k, (p.y1 + 1) * k])
    .flatMap((b) => splitSilhouette(frame.rgba, frame.w, frame.h, 4, b, isFg));
}

export function startPlayerRegistration(app, { onDone } = {}) {
  const video = app.video;
  const wrap = video.parentNode;
  if (!video.currentSrc || video.readyState < 2) { toast('Carica il video e fermalo su un fotogramma con i giocatori in campo', 'warn'); return; }
  if (!app.videoInfo?.pixels) { toast('Con questo video (YouTube o link senza CORS) i fotogrammi non sono leggibili: la registrazione dei giocatori richiede un file o un link diretto/MEGA.', 'warn', 8000); return; }
  video.pause();
  const layer = s('svg', { class: 'pid-layer' });
  const bar = h('div', { class: 'banner pid-bar' });
  const pop = h('div', { class: 'pid-pop hidden' });
  wrap.append(layer, bar, pop);
  let items = [];
  let frame = null;
  const cal = buildCalibration(app.match.calibration.points);
  const homeNear = app.rp.current?.homeNear ?? true;

  // area dell'immagine dentro il riquadro (object-fit: contain)
  const fit = () => {
    const r = wrap.getBoundingClientRect(), vw = video.videoWidth, vh = video.videoHeight;
    const k = Math.min(r.width / vw, r.height / vh);
    return { k, ox: (r.width - vw * k) / 2, oy: (r.height - vh * k) / 2, r };
  };
  const toScreen = ([x0, y0, x1, y1]) => { const f = fit(), q = video.videoWidth / frame.w; return [f.ox + x0 * q * f.k, f.oy + y0 * q * f.k, f.ox + x1 * q * f.k, f.oy + y1 * q * f.k]; };

  function teamOf(box) {
    if (!cal) return homeNear ? '*' : 'a';
    const c = applyH(cal.H, { x: (box[0] + box[2]) / 2 / frame.w, y: box[3] / frame.h });
    const near = c.y < 3.5;
    return near === homeNear ? '*' : 'a';
  }

  function makeItem(box) {
    const team = teamOf(box);
    const desc = describe(frame.rgba, frame.w, frame.h, 4, box);
    const gal = galleryOf(app.match, team);
    const ranking = Object.keys(gal.samples).length ? identify(gal, desc, candidatesFor(app, team)) : null;
    const guess = ranking && ranking[0].p > 0.45 && (ranking[0].tpl ?? 0) > 0.5 ? ranking[0].num : null;
    return { box, team, desc, ranking, guess, num: null, status: 'todo' };
  }
  // riquadro disegnato a mano: per i giocatori non trovati o fusi con altri
  const fromScreen = (X, Y) => { const f = fit(), q = frame.w / video.videoWidth; return [(X - f.ox) / f.k * q, (Y - f.oy) / f.k * q]; };
  layer.addEventListener('pointerdown', (ev) => {
    if (!frame || ev.target.closest('.pid-box')) return;
    ev.preventDefault();
    const r = wrap.getBoundingClientRect();
    const a = [ev.clientX - r.left, ev.clientY - r.top];
    const rect = s('rect', { class: 'pid-draw', x: a[0], y: a[1], width: 0, height: 0 });
    layer.appendChild(rect);
    layer.setPointerCapture(ev.pointerId);
    const move = (e2) => { const b = [e2.clientX - r.left, e2.clientY - r.top]; rect.setAttribute('x', Math.min(a[0], b[0])); rect.setAttribute('y', Math.min(a[1], b[1])); rect.setAttribute('width', Math.abs(b[0] - a[0])); rect.setAttribute('height', Math.abs(b[1] - a[1])); };
    const up = (e2) => {
      layer.removeEventListener('pointermove', move); layer.removeEventListener('pointerup', up);
      rect.remove();
      const b = [e2.clientX - r.left, e2.clientY - r.top];
      if (Math.abs(b[0] - a[0]) < 8 || Math.abs(b[1] - a[1]) < 14) return;
      const p0 = fromScreen(Math.min(a[0], b[0]), Math.min(a[1], b[1])), p1 = fromScreen(Math.max(a[0], b[0]), Math.max(a[1], b[1]));
      const it = makeItem([p0[0], p0[1], p1[0], p1[1]]);
      items.push(it);
      draw();
      openPicker(it, e2);
    };
    layer.addEventListener('pointermove', move); layer.addEventListener('pointerup', up);
  });

  async function analyse() {
    frame = grabFrame(video);
    let boxes;
    try { boxes = await silhouettes(video, frame); } catch (e) { toast('Errore: ' + e.message, 'error', 6000); return; }
    items = boxes.filter((b) => b[3] - b[1] > 24).map(makeItem);
    draw();
    if (!items.length) toast('Nessuna sagoma trovata in questo fotogramma: prova un istante con i giocatori fermi e ben visibili', 'warn', 6000);
  }

  async function ocrAll() {
    toast('Lettura dei numeri…');
    for (const it of items) {
      if (it.status !== 'todo' || it.guess != null) continue;
      const [x0, y0, x1, y1] = torsoBox(it.box).map(Math.round);
      const w = Math.max(4, x1 - x0), hh = Math.max(4, y1 - y0);
      const crop = new Uint8ClampedArray(w * hh * 4);
      for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
        const si = ((Math.min(frame.h - 1, y0 + y)) * frame.w + Math.min(frame.w - 1, x0 + x)) * 4, di = (y * w + x) * 4;
        crop[di] = frame.rgba[si]; crop[di + 1] = frame.rgba[si + 1]; crop[di + 2] = frame.rgba[si + 2]; crop[di + 3] = 255;
      }
      const prep = prepareJersey(crop, w, hh, 4);
      if (!prep) continue;
      let r;
      try { r = await readDigits(prep); } catch (e) { toast(e.message, 'error', 6000); return; }
      const n = Number(r.text);
      if (r.text && r.conf >= 50 && candidatesFor(app, it.team).includes(n)) it.guess = n;
    }
    draw();
  }

  function confirm(it, num, team = it.team) {
    const sameTeam = it.team === team;
    it.team = team;
    const gal = galleryOf(app.match, team);
    learn(gal, sameTeam ? it.ranking : null, num, it.desc, { source: 'register', t: video.currentTime });
    it.num = num; it.status = 'done';
    app.save();
    draw();
  }

  function openPicker(it, ev) {
    clear(pop);
    pop.classList.remove('hidden');
    const r = wrap.getBoundingClientRect();
    pop.style.left = `${Math.min(r.width - 260, ev.clientX - r.left + 8)}px`;
    pop.style.top = `${Math.min(r.height - 160, ev.clientY - r.top + 8)}px`;
    const team = it.team;
    const T = app.match.teams[team];
    const chips = (tm) => h('div', { class: 'pid-chips' }, app.match.teams[tm].players
      .slice().sort((a, b) => a.number - b.number)
      .map((p) => h('button', {
        class: `btn small pid-chip ${Number(p.number) === it.guess ? 'primary' : ''}`, title: `${p.lastName || ''} ${p.role === 'L' ? '(libero)' : ''}`,
        onclick: () => { pop.classList.add('hidden'); confirm(it, Number(p.number), tm); },
      }, `${p.number}`, p.role === 'L' ? ' L' : '')));
    pop.append(
      h('div', { class: 'small muted' }, `${T.name}: chi è?`), chips(team),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn small', onclick: () => { it.team = team === '*' ? 'a' : '*'; openPicker(it, ev); } }, `È di ${app.match.teams[team === '*' ? 'a' : '*'].name}`),
        h('button', { class: 'btn small', onclick: () => { it.status = 'skip'; pop.classList.add('hidden'); draw(); } }, 'Non è un giocatore'),
        h('button', { class: 'btn small', onclick: () => pop.classList.add('hidden') }, '✕')));
  }

  function draw() {
    clear(layer);
    if (!frame) return;
    const f = fit();
    layer.setAttribute('viewBox', `0 0 ${f.r.width} ${f.r.height}`);
    for (const it of items) {
      if (it.status === 'skip') continue;
      const [x0, y0, x1, y1] = toScreen(it.box);
      const col = app.match.teams[it.team].colour || '#fff';
      const label = it.status === 'done' ? `#${it.num} ✓` : it.guess != null ? `#${it.guess}?` : '?';
      const g = s('g', { class: `pid-box ${it.status}` });
      g.append(
        s('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, stroke: col, rx: 3 }),
        s('rect', { x: x0, y: y0 - 18, width: Math.max(34, label.length * 8 + 8), height: 17, fill: col, class: 'pid-tag', rx: 3 }),
        s('text', { x: x0 + 4, y: y0 - 5 }, label));
      g.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); ev.preventDefault(); openPicker(it, ev); });
      layer.appendChild(g);
    }
    renderBar();
  }

  function renderBar() {
    clear(bar);
    const todo = items.filter((i) => i.status === 'todo');
    const guessed = todo.filter((i) => i.guess != null);
    const cnt = (t) => `${app.match.teams[t].name} ${galleryCount(app.match, t)}/${app.match.teams[t].players.length}`;
    bar.append(
      h('strong', {}, '👕 Giocatori  '),
      h('span', {}, frame ? 'Clicca una sagoma e scegli il numero; se un giocatore manca o è unito a un altro, trascina un riquadro attorno a lui. ' : 'Ricerca delle sagome… '),
      h('span', { class: 'muted' }, `Registrati: ${cnt('*')} · ${cnt('a')}`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', title: 'Proposta automatica con OCR per le sagome senza numero', onclick: () => ocrAll() }, '🔤 Leggi numeri'),
      guessed.length ? h('button', { class: 'btn small', onclick: () => { for (const it of guessed) confirm(it, it.guess); } }, `✓ Conferma ${guessed.length} proposte`) : null,
      h('button', { class: 'btn small', title: 'Avanza di 3 s e registra un altro fotogramma', onclick: async () => { video.currentTime = Math.min(video.duration - 0.1, video.currentTime + 3); await new Promise((r) => video.addEventListener('seeked', r, { once: true })); items = []; draw(); analyse(); } }, '⏩ Altro fotogramma'),
      h('button', { class: 'btn small primary', onclick: () => finish() }, 'Fine'));
  }

  const ro = new ResizeObserver(() => draw());
  ro.observe(wrap);
  function finish() {
    ro.disconnect();
    layer.remove(); bar.remove(); pop.remove();
    app.save();
    onDone?.();
    const n = galleryCount(app.match, '*') + galleryCount(app.match, 'a');
    if (n) toast(`${n} giocatori nella galleria: l'analisi automatica li riconoscerà nei tocchi e imparerà dalle tue correzioni`, 'ok', 6000);
  }
  renderBar();
  const ready = analyse();
  app._pid = { items: () => items, ready, finish }; // per i test
  return { finish, ready };
}

// ---- nei tocchi dell'analisi automatica ----
// legge i descrittori del giocatore poco prima del contatto (più istanti, tiene il migliore)
export async function describeTouch(video, t, boxNorm, footNorm = null) {
  let best = null;
  const bg = await background(video);
  for (const dt of [-0.3, -0.15, 0]) {
    const tt = Math.max(0, t + dt);
    if (Math.abs(video.currentTime - tt) > 0.01) { video.currentTime = tt; await new Promise((r) => video.addEventListener('seeked', r, { once: true })); }
    const fr = grabFrame(video);
    let box = [boxNorm[0] * fr.w, boxNorm[1] * fr.h, boxNorm[2] * fr.w, boxNorm[3] * fr.h];
    // sagoma fusa con un altro giocatore: si tiene la parte più vicina al punto del tocco
    const parts = splitSilhouette(fr.rgba, fr.w, fr.h, 4, box, fgTest(fr, bg).isFg);
    if (parts.length > 1) {
      const fx = (footNorm ? footNorm[0] : (boxNorm[0] + boxNorm[2]) / 2) * fr.w, fy = (footNorm ? footNorm[1] : boxNorm[3]) * fr.h;
      box = parts.sort((a, b) => Math.hypot((a[0] + a[2]) / 2 - fx, (a[3] - fy) * 0.7) - Math.hypot((b[0] + b[2]) / 2 - fx, (b[3] - fy) * 0.7))[0];
    }
    const d = describe(fr.rgba, fr.w, fr.h, 4, box);
    if (!best || (d.tpl && !best.tpl)) best = d;
    if (best.tpl) break;
  }
  return best;
}
export { corsFor };
