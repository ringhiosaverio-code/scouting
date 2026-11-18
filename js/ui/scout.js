// Schermata di scouting: video + calibrazione campo, flusso guidato a clic,
// inserimento codici digitati, tabellone, formazioni, cronologia azioni.
import { h, s, $, clear, toast, modal, confirmDialog, fmtTime } from './dom.js';
import { courtSVG, eventToCourt, toSvg, positionXY, arrow, dot } from './courtsvg.js';
import {
  REF_POINTS, buildCalibration, applyH, flipXY, xy2zone, xy2subzone, xy2serveZone, zoneForTeam, COURT_LINES, round2,
} from '../lib/court.js';
import { interpretTyped, describe, skillCode, parseSkillCode, rallyWinner, attackInfo } from '../lib/codes.js';
import { uid, setterPosition, defaultSetter, liberos } from '../lib/engine.js';
import { rankPlayers, rankCombos } from '../lib/predict.js';
import { autoCalibrateVideo } from '../vision/analyzer.js';
import { cameraFromHomography } from '../vision/camera.js';
import { project as project3 } from '../vision/ballistic.js';
import { computeHomography } from '../lib/court.js';
import {
  EVALS, EVAL_TEXT, SERVE_TYPES, TYPE_TEXT, SPECIAL, ATTACK_TABLE, SIMPLIFIED_ATTACKS, SETTER_CALLS,
  SERVE_EVAL_FROM_RECEPTION, ATTACK_EVAL_FROM_DIG, ROLES, SKILLS, other,
} from '../lib/constants.js';

const PLAYER_KEYS = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o'];
const COMBO_KEYS = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k'];
const EVAL_KEYS = { '#': '1', '+': '2', '!': '3', '-': '4', '/': '5', '=': '6' };

export function createScout(app) {
  const root = h('div', { class: 'scout-grid' });
  let pend = {}; // azione in corso (clic non ancora confermati)
  let calib = null; // { idx, points } durante la calibrazione
  let panelKeys = new Map(); // tasto -> azione nel pannello corrente
  let typingStartVt = null;
  let liveStart = performance.now();

  // ---------- VIDEO ----------
  const video = app.video;
  const overlay = s('svg', { class: 'overlay' });
  const bigCourt = courtSVG({ cls: 'court-svg big-court' });
  const emptyMsg = h('div', { class: 'video-empty' },
    h('p', {}, 'Nessun video caricato.'),
    h('p', { class: 'muted' }, 'Carica un file video (MP4, WebM, MOV…) oppure scoutizza dal vivo cliccando sul campo schematico.'),
    h('div', { class: 'row gap' },
      h('button', { class: 'btn primary', onclick: () => app.openVideo() }, '📂 Carica video'),
      h('button', { class: 'btn', onclick: () => setSurface('court') }, '🏐 Usa il campo schematico')));
  const banner = h('div', { class: 'banner hidden' });
  const videoWrap = h('div', { class: 'video-wrap' }, video, overlay, bigCourt, emptyMsg, banner);

  const timeLbl = h('span', { class: 'time mono' }, '0:00.0');
  const speedSel = h('select', { 'aria-label': 'Velocità', onchange: () => { video.playbackRate = +speedSel.value; } },
    [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((v) => h('option', { value: v, selected: v === 1 }, `${v}×`)));
  const playBtn = h('button', { class: 'btn icon', title: 'Play/Pausa (Spazio)', onclick: () => togglePlay() }, '▶');
  const tbtn = (label, title, fn) => h('button', { class: 'btn icon', title, onclick: fn }, label);
  const surfaceBtn = h('button', { class: 'btn', title: 'Superficie di clic: video o campo schematico', onclick: () => setSurface(app.match.settings.clickSurface === 'court' ? 'video' : 'court') });
  const transport = h('div', { class: 'transport' },
    tbtn('⏮10', 'Indietro 10 s (Shift+←)', () => seekBy(-10)),
    tbtn('⏪2', 'Indietro 2 s (←)', () => seekBy(-2)),
    tbtn('◀︎|', 'Fotogramma indietro (,)', () => seekBy(-1 / 30)),
    playBtn,
    tbtn('|▶︎', 'Fotogramma avanti (.)', () => seekBy(1 / 30)),
    tbtn('2⏩', 'Avanti 2 s (→)', () => seekBy(2)),
    tbtn('10⏭', 'Avanti 10 s (Shift+→)', () => seekBy(10)),
    timeLbl, speedSel,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn', onclick: () => app.openVideo() }, '📂 Video'),
    h('button', { class: 'btn', title: 'Calibra il campo sul video', onclick: () => startCalibration() }, '📐 Calibra'),
    surfaceBtn);

  const codeInput = h('input', {
    class: 'code-input mono', id: 'code-input', placeholder: 'Codice (es. 7SQ-.12  a9X5#  *p)  — Invio per inserire, Esc per tornare al video',
    autocomplete: 'off', spellcheck: false,
  });
  const codePreview = h('div', { class: 'code-preview' });
  const codebar = h('div', { class: 'codebar' }, h('label', { for: 'code-input', class: 'sr-only' }, 'Codice'), codeInput, codePreview);

  // ---------- PANNELLO DESTRO ----------
  const scoreboard = h('div', { class: 'scoreboard' });
  const stepTitle = h('div', { class: 'step-title' });
  const panel = h('div', { class: 'action-panel' });
  const miniCourt = courtSVG({ zones: false, cls: 'court-svg mini-court' });
  const quick = h('div', { class: 'quick' });
  const pbpBody = h('tbody');
  const pbp = h('div', { class: 'pbp' }, h('table', { class: 'pbp-table' },
    h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Set'), h('th', {}, 'Punt.'), h('th', {}, 'Codice'), h('th', {}, 'Descrizione'), h('th', {}, 'Video'), h('th', {}, ''))),
    pbpBody));

  root.append(
    h('div', { class: 'left-col' }, videoWrap, transport, codebar, pbp),
    h('div', { class: 'right-col' }, scoreboard, h('div', { class: 'card action-card' }, stepTitle, panel), h('div', { class: 'card mini-card' }, miniCourt, h('div', { class: 'mini-legend muted' }, 'Clic sul campo = posizione del tocco')), quick),
  );

  // ---------- helpers video ----------
  const hasVideo = () => !!video.currentSrc && video.readyState > 0;
  const now = () => (hasVideo() ? video.currentTime : (performance.now() - liveStart) / 1000);
  const wallClock = () => { const d = new Date(); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join('.'); };
  function togglePlay() { if (!hasVideo()) return; if (video.paused) video.play(); else video.pause(); }
  function seekBy(d) { if (!hasVideo()) return; video.currentTime = Math.max(0, Math.min(video.duration || 1e9, video.currentTime + d)); }
  function pauseForPopup() { if (app.match.settings.pauseOnPopup && hasVideo() && !video.paused) { video.pause(); pend.autoPaused = true; } }
  function resumeAfter() {
    if (!hasVideo()) return;
    const st = app.match.settings;
    if (st.rewindAfterPopup) video.currentTime = Math.max(0, video.currentTime - st.rewindAfterPopup);
    if (st.resumeAfterPopup && pend.autoPaused) video.play();
  }
  video.addEventListener('play', () => { playBtn.textContent = '⏸'; });
  video.addEventListener('pause', () => { playBtn.textContent = '▶'; });
  video.addEventListener('timeupdate', () => { timeLbl.textContent = fmtTime(video.currentTime); });
  video.addEventListener('loadedmetadata', () => { layoutOverlay(); render(); });

  function setSurface(v) {
    app.match.settings.clickSurface = v;
    app.save();
    render();
  }

  // area effettiva dell'immagine dentro l'elemento video (object-fit: contain)
  function contentBox() {
    const r = videoWrap.getBoundingClientRect();
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    const k = Math.min(r.width / vw, r.height / vh);
    const w = vw * k, hh = vh * k;
    return { r, ox: (r.width - w) / 2, oy: (r.height - hh) / 2, w, h: hh };
  }
  function layoutOverlay() {
    const r = videoWrap.getBoundingClientRect();
    overlay.setAttribute('viewBox', `0 0 ${Math.max(1, r.width)} ${Math.max(1, r.height)}`);
    drawOverlay();
  }
  new ResizeObserver(() => layoutOverlay()).observe(videoWrap);

  const norm2px = (p) => { const b = contentBox(); return { x: b.ox + p.x * b.w, y: b.oy + p.y * b.h }; };
  function evToNorm(ev) {
    const b = contentBox();
    return { x: (ev.clientX - b.r.left - b.ox) / b.w, y: (ev.clientY - b.r.top - b.oy) / b.h };
  }

  function calibration() {
    const c = app.match.calibration;
    if (!c._cache || c._cache.key !== JSON.stringify(c.points)) {
      let res = null;
      try { res = buildCalibration(c.points); } catch { res = null; }
      Object.defineProperty(c, '_cache', { value: { key: JSON.stringify(c.points), res }, writable: true, enumerable: false, configurable: true });
    }
    return c._cache.res;
  }
  const homeNear = () => app.rp.current?.homeNear ?? true;
  // immagine normalizzata -> coordinate campo canoniche (casa in basso)
  function imgToCourt(p) {
    const cal = calibration();
    if (!cal) return null;
    const q = applyH(cal.H, p);
    const c = homeNear() ? q : flipXY(q);
    return { x: round2(c.x), y: round2(c.y) };
  }
  function courtToImg(c) {
    const cal = calibration();
    if (!cal) return null;
    const q = homeNear() ? c : flipXY(c);
    return applyH(cal.Hinv, q);
  }

  // ---------- disegno overlay ----------
  function drawOverlay() {
    clear(overlay);
    const surfaceCourt = app.match.settings.clickSurface === 'court';
    if (surfaceCourt && !calib) return;
    const cal = calibration();
    if (calib) {
      // punti di calibrazione e linee stimate
      const pts = app.match.calibration.points;
      if (cal) { drawCourtLines(cal, 'calib-lines'); drawNetEstimate(); }
      REF_POINTS.forEach((rp, i) => {
        const p = pts[rp.id];
        if (!p) return;
        const q = norm2px(p);
        const g = s('g', { class: `calib-pt ${i === calib.idx ? 'current' : ''}` });
        g.append(s('circle', { cx: q.x, cy: q.y, r: 9 }), s('text', { x: q.x + 12, y: q.y - 10 }, rp.label));
        makeDraggable(g, rp.id);
        overlay.appendChild(g);
      });
      return;
    }
    if (cal && app.match.settings.zoneDisplay && hasVideo()) drawCourtLines(cal, 'court-proj');
    // tocchi del rally in corso
    const rows = app.rp.current?.rallyRows || [];
    const touches = rows.filter((e) => e.start || e.end);
    for (const e of touches) {
      const col = e.team === '*' ? app.match.teams['*'].colour : app.match.teams.a.colour;
      const a = e.start && courtToImg(e.start), b = e.end && courtToImg(e.end);
      if (a && b) {
        const A = norm2px(a), B = norm2px(b);
        overlay.appendChild(s('line', { x1: A.x, y1: A.y, x2: B.x, y2: B.y, stroke: col, class: 'ov-arrow' }));
      }
      for (const p of [a, b]) if (p) { const P = norm2px(p); overlay.appendChild(s('circle', { cx: P.x, cy: P.y, r: 6, fill: col, class: 'ov-dot' })); }
    }
    for (const k of ['serveStart', 'serveEnd', 'second', 'recep', 'dig']) {
      const c = pend[k]?.pt;
      const p = c && courtToImg(c);
      if (p) { const P = norm2px(p); overlay.appendChild(s('circle', { cx: P.x, cy: P.y, r: 8, class: 'ov-pending' })); }
    }
    if (pend.attack?.start?.pt) { const p = courtToImg(pend.attack.start.pt); if (p) { const P = norm2px(p); overlay.appendChild(s('circle', { cx: P.x, cy: P.y, r: 8, class: 'ov-pending' })); } }
    if (pend.attack?.end?.pt) { const p = courtToImg(pend.attack.end.pt); if (p) { const P = norm2px(p); overlay.appendChild(s('circle', { cx: P.x, cy: P.y, r: 8, class: 'ov-pending' })); } }
  }
  // bordo superiore della rete previsto dalla telecamera stimata (dal solo pavimento):
  // permette di verificare a colpo d'occhio la calibrazione 3D automatica
  function drawNetEstimate() {
    const pts = app.match.calibration.points;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    const floor = REF_POINTS.filter((r) => !r.net && pts[r.id]);
    if (floor.length < 4) return;
    let cam;
    try {
      const Hm = computeHomography(floor.map((r) => ({ x: (r.x - 0.5) * 3, y: (r.y - 0.5) * 3 })), floor.map((r) => ({ x: pts[r.id].x * vw, y: pts[r.id].y * vh })));
      cam = cameraFromHomography(Hm, vw, vh);
    } catch { return; }
    if (!cam) return;
    const nh = app.match.settings.netHeight || 2.43;
    const P = (X) => { const q = project3(cam.P, X); return norm2px({ x: q[0] / vw, y: q[1] / vh }); };
    const a = P([0, 9, nh]), b = P([9, 9, nh]), a0 = P([0, 9, 0]), b0 = P([9, 9, 0]);
    overlay.append(
      s('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'net-est' }),
      s('line', { x1: a0.x, y1: a0.y, x2: a.x, y2: a.y, class: 'net-est post' }),
      s('line', { x1: b0.x, y1: b0.y, x2: b.x, y2: b.y, class: 'net-est post' }),
      s('text', { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 8, class: 'net-est-label' }, 'rete stimata'));
  }
  async function autoCalibrate() {
    if (!hasVideo()) { toast('Carica prima un video', 'warn'); return; }
    if (app.match.settings.clickSurface === 'court') setSurface('video');
    video.pause();
    toast('Ricerca delle linee del campo…', 'info', 4000);
    let r;
    try { r = await autoCalibrateVideo(video.currentSrc, { samples: 30 }); } catch (e) { toast('Errore: ' + e.message, 'error', 5000); return; }
    if (!r.ok) { toast(`Calibrazione automatica non riuscita (${r.reason}): usa la calibrazione manuale`, 'warn', 6000); startCalibration(); return; }
    const pts = app.match.calibration.points;
    for (const k of Object.keys(pts)) if (!REF_POINTS.find((x) => x.id === k)?.net) delete pts[k];
    Object.assign(pts, r.points);
    app.save();
    calib = { idx: REF_POINTS.length };
    updateCalibBanner();
    drawOverlay();
    toast(`Campo riconosciuto (linee spiegate ${Math.round(r.quality * 100)}%). Controlla le linee gialle e la rete stimata, poi Fine.`, 'ok', 7000);
  }
  function drawCourtLines(cal, cls) {
    for (const [[x1, y1], [x2, y2]] of COURT_LINES) {
      const a = norm2px(applyH(cal.Hinv, { x: x1, y: y1 })), b = norm2px(applyH(cal.Hinv, { x: x2, y: y2 }));
      overlay.appendChild(s('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: cls }));
    }
  }
  function makeDraggable(g, id) {
    g.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation(); ev.preventDefault();
      g.setPointerCapture(ev.pointerId);
      const move = (e2) => { app.match.calibration.points[id] = evToNorm(e2); drawOverlay(); };
      const up = () => { g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); app.save(); updateCalibBanner(); };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
    });
  }

  // ---------- calibrazione ----------
  function startCalibration() {
    if (!hasVideo()) { toast('Carica prima un video', 'warn'); return; }
    if (app.match.settings.clickSurface === 'court') setSurface('video');
    video.pause();
    const existing = Object.keys(app.match.calibration.points).length;
    const missing = REF_POINTS.findIndex((r) => !app.match.calibration.points[r.id]);
    calib = { idx: existing >= 4 && missing >= 0 && REF_POINTS[missing].required ? missing : missing < 0 ? REF_POINTS.length : missing };
    updateCalibBanner();
    drawOverlay();
  }
  function updateCalibBanner() {
    if (!calib) { banner.classList.add('hidden'); return; }
    const cal = calibration();
    clear(banner);
    banner.classList.remove('hidden');
    const cur = REF_POINTS[calib.idx];
    banner.append(
      h('strong', {}, '📐 Calibrazione campo  '),
      cur ? h('span', {}, `Clicca: ${cur.label}${cur.required ? '' : ' (facoltativo)'} — oppure 🪄 Automatica`) : h('span', {}, 'Trascina i punti per rifinire.'),
      cal ? h('span', { class: 'muted' }, `  · errore medio ${cal.error.toFixed(2)} m su ${cal.n} punti`) : null,
      h('span', { class: 'spacer' }),
      cur && !cur.required ? h('button', { class: 'btn small', onclick: () => { calib.idx++; updateCalibBanner(); drawOverlay(); } }, 'Salta') : null,
      h('button', { class: 'btn small', title: 'Riconosce da solo le linee del campo', onclick: () => autoCalibrate() }, '🪄 Automatica'),
      h('button', { class: 'btn small', onclick: () => { app.match.calibration.points = {}; calib.idx = 0; app.save(); updateCalibBanner(); drawOverlay(); } }, 'Ricomincia'),
      h('button', { class: 'btn small primary', disabled: !cal, onclick: () => { calib = null; app.save(); updateCalibBanner(); render(); toast('Campo calibrato'); } }, 'Fine'));
  }

  // ---------- gestione clic ----------
  overlay.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const p = evToNorm(ev);
    if (p.x < -0.05 || p.x > 1.05 || p.y < -0.05 || p.y > 1.05) return;
    if (calib) {
      const cur = REF_POINTS[calib.idx];
      if (!cur) return;
      app.match.calibration.points[cur.id] = p;
      calib.idx++;
      app.save();
      updateCalibBanner();
      drawOverlay();
      return;
    }
    const vt = now();
    const c = imgToCourt(p);
    if (!c && !calibration()) toast('Campo non calibrato: posizione non registrata (usa 📐 Calibra)', 'warn', 1800);
    onTouch(c, vt);
  });
  for (const svg of [bigCourt, miniCourt]) {
    svg.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const c = eventToCourt(svg, ev);
      onTouch({ x: round2(c.x), y: round2(c.y) }, now());
    });
  }

  // ---------- stato del flusso ----------
  function flow() {
    const cur = app.rp.current;
    if (!cur) return { step: 'nolineup' };
    if (cur.over) return { step: app.rp.matchOver ? 'matchover' : 'nextset' };
    if (cur.pendingEnd) return { step: 'setend' };
    if (!cur.inRally) return { step: 'serve', team: cur.serving };
    const last = cur.lastSkill;
    const owner = cur.ballOwner;
    if (rallyWinner(last)) return { step: 'point', team: rallyWinner(last) };
    switch (last.skill) {
      case 'S': return { step: 'reception', team: owner };
      case 'E': return { step: 'third', team: last.team };
      case 'A': case 'B': return { step: 'dig', team: owner, skill: 'D' };
      case 'F': return owner !== last.team ? { step: 'dig', team: owner, skill: 'F' } : { step: 'second', team: owner };
      default: return { step: 'second', team: owner };
    }
  }

  function onTouch(pt, vt) {
    const f = flow();
    if (['nolineup', 'nextset'].includes(f.step)) { app.openLineup(); return; }
    if (f.step === 'setend') { askEndSet(); return; }
    if (f.step === 'matchover') { toast('Partita terminata'); return; }
    const tp = { pt, vt };
    switch (f.step) {
      case 'serve':
        if (!pend.serveStart) { pend.serveStart = tp; }
        else { pend.serveEnd = tp; pauseForPopup(); }
        break;
      case 'reception': pend.recep = tp; pauseForPopup(); break;
      case 'second':
        if (pend.attack) { pend.attack.end = tp; pauseForPopup(); }
        else if (pend.second) { pend.second = tp; }
        else if (app.match.settings.scoutSets) { pend.second = tp; pauseForPopup(); }
        else { pend.attack = { start: tp, autoSet: true }; pauseForPopup(); }
        break;
      case 'third':
        if (!pend.attack) pend.attack = { start: tp };
        else pend.attack.end = tp;
        pauseForPopup();
        break;
      case 'dig': pend.dig = tp; pauseForPopup(); break;
      default:
    }
    render();
  }

  // ---------- costruzione righe ----------
  const lookup = (t, n) => app.lookup(t, n);
  const state = () => app.rp.current;
  function rank(team, skill, zone, opts) { return rankPlayers(app.match, state(), app.learner, team, skill, zone, opts); }
  const attackTable = () => (app.match.settings.attackSet === 'simplified' ? ATTACK_TABLE.filter((a) => SIMPLIFIED_ATTACKS.includes(a.code)) : (app.match.settings.attackTable || ATTACK_TABLE));

  function sk(team, num, skill, extra = {}) {
    return { kind: 'skill', id: uid(), team, num, skill, type: app.match.settings.defaultType || 'H', ev: '+', combo: null, target: null, sz: null, ez: null, esz: null, stype: null, nb: null, special: null, custom: '', t: hasVideo() ? null : wallClock(), ...extra };
  }
  const zEnd = (pt) => (pt ? xy2zone(pt.x, pt.y) : null);
  const szEnd = (pt) => (pt ? xy2subzone(pt.x, pt.y) : null);

  function commitRows(rows, label, pre = null) {
    app.commit(label, (m) => {
      if (pre) pre(m);
      // alzata precedente: tempo e target ricavati dall'attacco
      const a = rows.find((r) => r.kind === 'skill' && r.skill === 'A');
      if (a) {
        const prev = [...m.events].reverse().find((e) => e.kind === 'skill');
        const set = rows.find((r) => r.skill === 'E' && r.team === a.team) || (prev && prev.skill === 'E' && prev.team === a.team ? prev : null);
        if (set) {
          set.type = a.type;
          const info = a.combo && attackInfo(a.combo, attackTable());
          if (info && info.setType && info.setType !== '-' && !set.target) set.target = info.setType;
        }
      }
      m.events.push(...rows);
      const w = rows.map(rallyWinner).find(Boolean);
      if (w) m.events.push({ kind: 'point', id: uid(), team: w, vt: rows.at(-1).vt });
    });
    pend = { autoPaused: pend.autoPaused };
    resumeAfter();
    pend = {};
    afterCommit();
  }

  function afterCommit() {
    render();
    const cur = app.rp.current;
    if (cur?.pendingEnd && app.match.settings.autoEndSet) { askEndSet(); return; }
    // set decisivo: cambio campo a 8 punti
    const f = app.match.settings.format;
    if (cur && !cur.over && cur.set === f.setsToWin * 2 - 1 && Math.max(cur.score['*'], cur.score.a) === Math.ceil(f.tiebreakPoints / 2) && !cur.inRally) {
      const already = app.rp.rows.some((r) => r.set === cur.set && r.e.kind === 'side');
      if (!already) confirmDialog('Cambio campo', 'Set decisivo: le squadre cambiano campo. Aggiornare il lato rispetto alla telecamera?', 'Cambia campo').then((ok) => {
        if (ok) { app.commit('Cambio campo', (m) => m.events.push({ kind: 'side', id: uid(), vt: now() })); render(); }
      });
    }
  }

  async function askEndSet() {
    const cur = app.rp.current;
    if (!cur?.pendingEnd) return;
    if (hasVideo()) video.pause();
    const ok = await confirmDialog(`Fine del set ${cur.set}`, `Punteggio ${cur.score['*']}–${cur.score.a}. Confermi la fine del set?`, 'Fine set');
    if (!ok) return;
    app.commit('Fine set', (m) => m.events.push({ kind: 'endset', id: uid(), vt: now() }));
    render();
    if (!app.rp.matchOver) app.openLineup();
    else toast(`Partita terminata ${app.rp.setsWon['*']}–${app.rp.setsWon.a}`, 'ok', 5000);
  }

  // ---------- pannelli azione ----------
  function playerChips(team, ranked, selected, onPick, { includeBench = false, keys = true } = {}) {
    const cur = state();
    const libs = liberos(app.match, team);
    let list = ranked.map((r) => r.num);
    for (const n of [...cur.pos[team], ...libs]) if (!list.includes(n)) list.push(n);
    if (includeBench) for (const p of app.match.teams[team].players) if (!list.includes(Number(p.number))) list.push(Number(p.number));
    const pmap = new Map(ranked.map((r) => [r.num, r.p]));
    return h('div', { class: 'chips players' }, list.slice(0, 12).map((n, i) => {
      const p = lookup(team, n);
      const key = keys ? PLAYER_KEYS[i] : null;
      if (key) panelKeys.set(key, () => onPick(n));
      const prob = pmap.get(n) || 0;
      return h('button', {
        class: `chip player ${n === selected ? 'sel' : ''} ${p?.role === 'L' ? 'libero' : ''}`,
        style: { '--p': `${Math.round(prob * 100)}%` },
        title: `${p ? `${p.lastName} ${p.firstName}` : ''} ${p ? ROLES[p.role]?.name : ''} — ${Math.round(prob * 100)}%`,
        onclick: () => onPick(n),
      }, key ? h('kbd', {}, key) : null, h('b', {}, n), h('span', {}, p ? p.lastName.slice(0, 9) : ''), h('i', { class: 'role' }, p?.role || ''));
    }));
  }
  function evalButtons(skill, onPick, { exclude = [], labels = {}, selected = null, symbolKeys = true } = {}) {
    return h('div', { class: 'chips evals' }, EVALS.filter((e) => !exclude.includes(e)).map((ev) => {
      if (symbolKeys) panelKeys.set(ev, () => onPick(ev));
      panelKeys.set(EVAL_KEYS[ev], () => onPick(ev));
      return h('button', { class: `chip eval ev-${evClass(ev)} ${selected === ev ? 'sel' : ''}`, onclick: () => onPick(ev), title: `Tasto ${ev} o ${EVAL_KEYS[ev]}` },
        h('kbd', {}, EVAL_KEYS[ev]), h('b', {}, ev), h('span', {}, labels[ev] || EVAL_TEXT[skill][ev]));
    }));
  }
  const evClass = (ev) => ({ '#': 'hash', '+': 'plus', '!': 'excl', '-': 'minus', '/': 'slash', '=': 'eq' }[ev]);
  const section = (label, ...content) => h('div', { class: 'psec' }, h('div', { class: 'plabel' }, label), ...content);
  const actBtn = (label, fn, cls = '', key = null) => {
    if (key) panelKeys.set(key, fn);
    return h('button', { class: `btn act ${cls}`, onclick: fn }, key ? h('kbd', {}, key === 'Enter' ? '↵' : key) : null, label);
  };
  const teamName = (t) => app.match.teams[t].name;
  const teamTag = (t) => h('span', { class: 'team-tag', style: { background: app.match.teams[t].colour } }, teamName(t));

  function renderPanel() {
    clear(panel);
    panelKeys = new Map();
    const f = flow();
    const cur = state();
    const title = (txt, team) => { clear(stepTitle); stepTitle.append(team ? teamTag(team) : '', ' ', txt); };

    if (f.step === 'nolineup' || f.step === 'nextset') {
      title(f.step === 'nolineup' ? 'Inizio partita' : `Set ${app.rp.nextSet}`);
      panel.append(h('p', {}, 'Inserisci le formazioni iniziali per iniziare a scoutizzare.'), actBtn('Formazioni…', () => app.openLineup(), 'primary', 'Enter'));
      return;
    }
    if (f.step === 'matchover') {
      title('Partita terminata');
      panel.append(h('p', {}, `Risultato: ${teamName('*')} ${app.rp.setsWon['*']} – ${app.rp.setsWon.a} ${teamName('a')}`), actBtn('Vai al report', () => app.showTab('report'), 'primary', 'Enter'));
      return;
    }
    if (f.step === 'setend') {
      title(`Fine set ${cur.set}?`);
      panel.append(actBtn('Conferma fine set', () => askEndSet(), 'primary', 'Enter'));
      return;
    }

    if (f.step === 'serve') {
      const t = f.team, r = other(t);
      if (!pend.serveEnd) {
        title(pend.serveStart ? 'Clicca dove arriva la battuta' : 'Clicca il punto di battuta', t);
        panel.append(h('p', { class: 'muted' }, pend.serveStart ? 'Posizione di ricezione/arrivo della palla.' : `Batte #${cur.pos[t][0]} ${lookup(t, cur.pos[t][0])?.lastName || ''}. Puoi anche premere Invio per registrare senza posizioni.`));
        panel.append(actBtn('Battuta senza posizioni', () => { if (!pend.serveStart) pend.serveStart = { pt: null, vt: now() }; pend.serveEnd = { pt: null, vt: now() }; pauseForPopup(); render(); }, '', 'Enter'));
        if (pend.serveStart) panel.append(actBtn('Annulla clic', () => { pend = {}; render(); }, '', 'Escape'));
        return;
      }
      title('Battuta e ricezione', t);
      const srvDefault = cur.pos[t][0];
      pend.server ??= srvDefault;
      pend.stype ??= app.learner.serveType(t, pend.server) || pend.lastStype || 'Q';
      const ez = zEnd(pend.serveEnd.pt);
      const recRank = rank(r, 'R', ez);
      pend.receiver ??= recRank[0]?.num;
      const commitServe = (recEv, special = null) => {
        const sz = pend.serveStart.pt ? xy2serveZone(pend.serveStart.pt.x, pend.serveStart.pt.y) : null;
        const base = { type: pend.stype, sz, ez, esz: szEnd(pend.serveEnd.pt) };
        const sEv = recEv === 'serr' ? '=' : SERVE_EVAL_FROM_RECEPTION[recEv];
        const S = sk(t, pend.server, 'S', { ...base, ev: sEv, special: recEv === 'serr' ? special : null, start: pend.serveStart.pt || undefined, end: pend.serveEnd.pt || undefined, vt: pend.serveStart.vt });
        const rows = [S];
        if (recEv !== 'serr') rows.push(sk(r, pend.receiver, 'R', { ...base, ev: recEv, start: pend.serveStart.pt || undefined, end: pend.serveEnd.pt || undefined, vt: pend.serveEnd.vt }));
        pend.lastStype = pend.stype;
        commitRows(rows, recEv === 'serr' ? 'Errore battuta' : recEv === '=' ? 'Ace' : 'Battuta/ricezione');
      };
      panel.append(
        section('Battitore', playerChips(t, rank(t, 'S', 1), pend.server, (n) => { pend.server = n; pend.stype = app.learner.serveType(t, n) || pend.stype; render(); }, { keys: false })),
        section('Tipo di battuta', h('div', { class: 'chips' }, SERVE_TYPES.map((ty, i) => {
          panelKeys.set(`F${i + 1}`, () => { pend.stype = ty; render(); });
          return h('button', { class: `chip ${pend.stype === ty ? 'sel' : ''}`, title: `F${i + 1}`, onclick: () => { pend.stype = ty; render(); } }, h('b', {}, ty), h('span', {}, TYPE_TEXT.S[ty]));
        }))),
        section(`Ricevitore (${teamName(r)})`, playerChips(r, recRank, pend.receiver, (n) => { pend.receiver = n; render(); })),
        section('Esito ricezione', evalButtons('R', (ev) => commitServe(ev), { labels: { '=': 'Errore (ACE)' } })),
        section('Errore di battuta', h('div', { class: 'chips' },
          actBtn('Errore battuta', () => commitServe('serr'), 'danger', '0'),
          Object.entries(SPECIAL.S['=']).map(([k, v]) => h('button', { class: 'chip small', onclick: () => commitServe('serr', k) }, v)))),
        actBtn('Annulla', () => { pend = {}; render(); }, 'ghost', 'Escape'),
      );
      return;
    }

    if (f.step === 'reception') {
      const t = f.team;
      title('Ricezione', t);
      if (!pend.recep) { panel.append(h('p', { class: 'muted' }, 'Clicca dove viene ricevuta la palla, o scegli direttamente.')); }
      const ez = zEnd(pend.recep?.pt) ?? cur.lastSkill.ez;
      const rk = rank(t, 'R', ez);
      pend.receiver ??= rk[0]?.num;
      panel.append(
        section('Ricevitore', playerChips(t, rk, pend.receiver, (n) => { pend.receiver = n; render(); })),
        section('Valutazione', evalButtons('R', (ev) => {
          const sv = cur.lastSkill;
          const R = sk(t, pend.receiver, 'R', { type: sv.type, sz: sv.sz, ez: ez ?? sv.ez, esz: szEnd(pend.recep?.pt) ?? sv.esz, ev, end: pend.recep?.pt || undefined, vt: pend.recep?.vt ?? now() });
          commitRows([R], 'Ricezione', (m) => {
            const se = m.events.find((e) => e.id === sv.id);
            if (se) se.ev = SERVE_EVAL_FROM_RECEPTION[ev];
          });
        })),
      );
      return;
    }

    if (f.step === 'second') {
      const t = f.team;
      if (pend.attack) { renderAttack(t); return; }
      if (!pend.second) {
        title(app.match.settings.scoutSets ? 'Clicca il secondo tocco (alzata)' : 'Clicca il punto di attacco', t);
        panel.append(h('p', { class: 'muted' }, app.match.settings.scoutSets ? 'Posizione dell\'alzata. Invio = alzata del palleggiatore senza posizione.' : 'L\'alzata viene registrata automaticamente.'));
        panel.append(actBtn('Alzata senza posizione', () => { pend.second = { pt: null, vt: now() }; pauseForPopup(); render(); }, '', 'Enter'));
        panel.append(manualRallyButtons(t));
        return;
      }
      title('Secondo tocco', t);
      const zone = pend.second.pt ? zoneForTeam(pend.second.pt, t) : null;
      const rk = rank(t, 'E', zone);
      pend.setter ??= rk[0]?.num;
      pend.setEval ??= app.match.settings.defaultEval.E || '+';
      const commitSet = (ev = pend.setEval) => {
        const E = sk(t, pend.setter, 'E', { ev, combo: pend.call || null, start: pend.second.pt || undefined, vt: pend.second.vt, ez: zone });
        commitRows([E], ev === '=' ? 'Errore alzata' : 'Alzata');
      };
      panel.append(
        section('Giocatore', playerChips(t, rk, pend.setter, (n) => { pend.setter = n; render(); })),
        section('Chiamata palleggiatore (facoltativa)', h('div', { class: 'chips' }, SETTER_CALLS.map((c) => h('button', { class: `chip small ${pend.call === c.code ? 'sel' : ''}`, onclick: () => { pend.call = pend.call === c.code ? null : c.code; render(); } }, h('b', {}, c.code), h('span', {}, c.description))))),
        section('Valutazione alzata', evalButtons('E', (ev) => commitSet(ev), { selected: pend.setEval })),
        h('div', { class: 'row gap wrap' },
          actBtn('Alzata ✓', () => commitSet(), 'primary', 'Enter'),
          actBtn('Attacco di 2ª', () => { pend.attack = { start: pend.second, player: pend.setter, combo: 'P2', noSet: true }; pend.second = null; render(); }, '', 'z'),
          actBtn('Free ball', () => { commitRows([sk(t, pend.setter, 'F', { start: pend.second.pt || undefined, vt: pend.second.vt })], 'Free ball'); }, '', 'x'),
          actBtn('Annulla', () => { pend = {}; render(); }, 'ghost', 'Escape')),
      );
      return;
    }

    if (f.step === 'third') {
      renderAttack(f.team);
      return;
    }

    if (f.step === 'dig') {
      const t = f.team;
      const skill = f.skill || 'D';
      title(skill === 'F' ? 'Ricezione free ball' : (cur.lastSkill.skill === 'B' && cur.lastSkill.ev === '!' ? 'Ricopertura' : 'Difesa'), t);
      const zone = pend.dig?.pt ? zoneForTeam(pend.dig.pt, t) : cur.lastSkill.ez;
      const rk = rank(t, skill, zone);
      pend.digger ??= rk[0]?.num;
      if (!pend.dig) panel.append(h('p', { class: 'muted' }, 'Clicca la posizione del tocco o scegli direttamente.'));
      panel.append(
        section('Giocatore', playerChips(t, rk, pend.digger, (n) => { pend.digger = n; render(); })),
        section('Valutazione', evalButtons(skill, (ev) => {
          const prev = cur.lastSkill;
          const D = sk(t, pend.digger, skill, { ev, type: prev.type, sz: prev.skill === 'A' ? prev.sz : null, ez: zone, esz: szEnd(pend.dig?.pt), start: pend.dig?.pt || undefined, vt: pend.dig?.vt ?? now() });
          if (skill === 'D' && prev.skill === 'B' && prev.ev === '!') D.stype = 'C';
          commitRows([D], SKILLS[skill]);
        })),
        manualRallyButtons(t),
      );
      return;
    }
    if (f.step === 'point') {
      title('Assegna il punto');
      panel.append(manualRallyButtons(null));
    }
  }

  function manualRallyButtons() {
    return h('div', { class: 'row gap wrap manual' },
      h('button', { class: 'btn small', onclick: () => manualPoint('*') }, `+1 ${teamName('*')}`),
      h('button', { class: 'btn small', onclick: () => manualPoint('a') }, `+1 ${teamName('a')}`));
  }
  function manualPoint(team) {
    app.commit('Punto manuale', (m) => m.events.push({ kind: 'point', id: uid(), team, vt: now() }));
    pend = {};
    afterCommit();
  }

  function renderAttack(t) {
    const cur = state();
    const at = pend.attack;
    const opp = other(t);
    const title = (txt) => { clear(stepTitle); stepTitle.append(teamTag(t), ' ', txt); };
    if (!at) {
      title('Clicca il punto di attacco');
      panel.append(h('p', { class: 'muted' }, 'Posizione del colpo (o dei piedi dell\'attaccante). Invio = attacco senza posizione.'),
        actBtn('Attacco senza posizione', () => { pend.attack = { start: { pt: null, vt: now() } }; pauseForPopup(); render(); }, '', 'Enter'),
        actBtn('Free ball inviata', () => { const rk = rank(t, 'F', null); commitRows([sk(t, rk[0]?.num, 'F', { vt: now() })], 'Free ball'); }, '', 'x'),
        manualRallyButtons(t));
      return;
    }
    const sz0 = at.start.pt ? zoneForTeam(at.start.pt, t) : null;
    const table = attackTable();
    if (at.player == null) at.player = rank(t, 'A', at.combo ? attackInfo(at.combo, table)?.zone ?? sz0 : sz0)[0]?.num;
    const combos = rankCombos(app.rp.rows, t, sz0 ?? 4, table, at.player).slice(0, 8);
    if (at.combo === undefined) at.combo = combos[0]?.code ?? null;
    const info = at.combo ? attackInfo(at.combo, table) : null;
    const sz = info?.zone ?? sz0;
    const rk = rank(t, 'A', sz);
    at.stype ??= 'H';
    title(at.end ? 'Esito attacco' : 'Attacco — clicca dove finisce (o scegli l\'esito)');

    const buildA = (ev, extra = {}) => {
      const end = at.end?.pt;
      return sk(t, at.player, 'A', {
        ev, combo: at.combo, type: info?.type || app.match.settings.defaultType, sz, ez: end ? xy2zone(end.x, end.y) : null, esz: szEnd(end),
        stype: at.stype, nb: at.nb ?? null, start: at.start.pt || undefined, end: end || undefined, vt: at.start.vt, ...extra,
      });
    };
    const preRows = () => {
      if (!at.autoSet || at.noSet) return [];
      const setter = rank(t, 'E', null)[0]?.num;
      return [sk(t, setter, 'E', { ev: app.match.settings.defaultEval.E || '+', vt: Math.max(0, at.start.vt - 1) })];
    };
    const blockRank = rank(opp, 'B', sz, { attackZone: sz });
    at.blocker ??= blockRank[0]?.num;
    const endZone = at.end?.pt ? zoneForTeam(at.end.pt, opp) : null;
    const digRank = rank(opp, 'D', endZone);
    at.digger ??= digRank[0]?.num;
    const commit = (rows, label) => commitRows([...preRows(), ...rows], label);
    const vEnd = at.end?.vt ?? now();
    const atkExtras = section('Dettagli', h('div', { class: 'chips' },
      Object.entries({ H: 'Schiacciata', P: 'Piazzata', T: 'Pallonetto' }).map(([k, v]) => h('button', { class: `chip small ${at.stype === k ? 'sel' : ''}`, onclick: () => { at.stype = k; render(); } }, v)),
      h('span', { class: 'sep' }),
      [0, 1, 2, 3].map((n) => h('button', { class: `chip small ${at.nb === n ? 'sel' : ''}`, title: 'Numero di muri', onclick: () => { at.nb = at.nb === n ? null : n; render(); } }, `${n} muro`))));

    panel.append(
      section('Attaccante', playerChips(t, rk, at.player, (n) => { at.player = n; render(); })),
      section(`Combinazione${sz0 ? ` (zona ${sz0})` : ''}`, h('div', { class: 'chips' }, combos.map((c, i) => {
        panelKeys.set(COMBO_KEYS[i], () => { at.combo = c.code; render(); });
        return h('button', { class: `chip combo ${at.combo === c.code ? 'sel' : ''}`, title: c.description, onclick: () => { at.combo = c.code; at.player = null; render(); } }, h('kbd', {}, COMBO_KEYS[i]), h('b', {}, c.code), h('span', {}, c.description));
      }), h('button', { class: `chip small ${at.combo == null ? 'sel' : ''}`, onclick: () => { at.combo = null; render(); } }, 'nessuna'))),
      atkExtras,
      section('Esito', h('div', { class: 'row gap wrap' },
        actBtn('Punto', () => commit([buildA('#')], 'Attacco punto'), 'ok', '#'),
        actBtn('Errore', () => commit([buildA('=')], 'Errore attacco'), 'danger', '='),
        actBtn('Murato', () => commit([buildA('/'), sk(opp, at.blocker, 'B', { ev: '#', type: info?.type || 'H', nb: at.nb, vt: vEnd })], 'Murato'), 'danger', '/'),
        actBtn('Murato, ricoperto', () => commit([buildA('!'), sk(opp, at.blocker, 'B', { ev: '!', type: info?.type || 'H', nb: at.nb, vt: vEnd })], 'Ricoperto'), '', '!'))),
      section('Speciale punto / errore', h('div', { class: 'chips' },
        Object.entries(SPECIAL.A['#']).map(([k, v]) => h('button', { class: 'chip small ok', onclick: () => commit([buildA('#', { special: k })], 'Attacco punto') }, '# ' + v)),
        Object.entries(SPECIAL.A['=']).map(([k, v]) => h('button', { class: 'chip small bad', onclick: () => commit([buildA('=', { special: k })], 'Errore attacco') }, '= ' + v)))),
      section(`Muro (${teamName(opp)})`, playerChips(opp, blockRank, at.blocker, (n) => { at.blocker = n; render(); }, { keys: false })),
    );
    {
      panel.append(
        section(`In gioco — difensore (${teamName(opp)})${endZone ? ` zona ${endZone}` : ''}`, playerChips(opp, digRank, at.digger, (n) => { at.digger = n; render(); }, { keys: false })),
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: !!at.touch, onchange: (e) => { at.touch = e.target.checked; } }), ' Tocco a muro prima della difesa'),
        section('Valutazione difesa', evalButtons('D', (dev) => {
          const aEv = ATTACK_EVAL_FROM_DIG[dev];
          const rows = [buildA(aEv)];
          if (at.touch) rows.push(sk(opp, at.blocker, 'B', { ev: dev === '#' || dev === '+' ? '+' : '-', type: info?.type || 'H', nb: at.nb, vt: vEnd }));
          rows.push(sk(opp, at.digger, 'D', { ev: dev, type: info?.type || 'H', sz, ez: rows[0].ez, esz: rows[0].esz, stype: at.touch ? 'B' : 'S', start: at.end?.pt || undefined, vt: vEnd }));
          commit(rows, 'Attacco in gioco');
        }, { labels: { '=': 'Errore (punto attacco)' }, symbolKeys: false })),
      );
    }
    panel.append(actBtn('Annulla', () => { pend = {}; render(); }, 'ghost', 'Escape'));
  }

  // ---------- tabellone ----------
  function renderScoreboard() {
    clear(scoreboard);
    const cur = state();
    const m = app.match;
    const sw = app.rp.setsWon;
    const team = (t) => h('div', { class: `sb-team ${cur?.serving === t ? 'serving' : ''}` },
      h('div', { class: 'sb-name', style: { borderColor: m.teams[t].colour } }, cur?.serving === t ? h('span', { class: 'ball', title: 'Al servizio' }, '●') : null, m.teams[t].name),
      h('div', { class: 'sb-sets' }, sw[t]),
      h('div', { class: 'sb-score' }, cur ? cur.score[t] : 0),
      h('div', { class: 'sb-meta' },
        cur ? `P${cur.setterPos[t] ?? '?'}` : '',
        ' · TO ', h('span', { class: 'dots' }, '●'.repeat(cur?.timeouts?.[t] || 0) + '○'.repeat(Math.max(0, 2 - (cur?.timeouts?.[t] || 0)))),
        ' · C ', cur?.subs?.[t] ?? 0));
    scoreboard.append(team('*'), h('div', { class: 'sb-mid' }, h('div', { class: 'sb-set' }, cur ? `SET ${cur.set}` : '—')), team('a'));
  }

  // ---------- mini campo con formazioni ----------
  function renderMiniCourt() {
    const layer = miniCourt.querySelector('.court-layer');
    clear(layer);
    const cur = state();
    if (!cur) return;
    for (const t of ['*', 'a']) {
      const col = app.match.teams[t].colour;
      cur.pos[t].forEach((n, i) => {
        const p = positionXY(i + 1, t);
        const pl = lookup(t, n);
        const isSetter = n === cur.setter[t];
        dot(layer, p, { r: 0.24, cls: `lineup ${isSetter ? 'setter' : ''}`, colour: col, label: n, title: `P${i + 1} · #${n} ${pl ? pl.lastName : ''}${isSetter ? ' (palleggiatore)' : ''}` });
      });
    }
    for (const e of cur.rallyRows) {
      const col = app.match.teams[e.team].colour;
      if (e.start && e.end) arrow(layer, e.start, e.end, { colour: col, width: 0.035, cls: 'rally' });
      else if (e.start || e.end) dot(layer, e.start || e.end, { r: 0.08, colour: col, cls: 'rally' });
    }
    for (const k of ['serveStart', 'serveEnd', 'second', 'recep', 'dig']) if (pend[k]?.pt) dot(layer, pend[k].pt, { r: 0.1, cls: 'pending' });
    if (pend.attack?.start?.pt) dot(layer, pend.attack.start.pt, { r: 0.1, cls: 'pending' });
    if (pend.attack?.end?.pt) dot(layer, pend.attack.end.pt, { r: 0.1, cls: 'pending' });
    // grande campo (modalità campo)
    const big = bigCourt.querySelector('.court-layer');
    clear(big);
    for (const t of ['*', 'a']) cur.pos[t].forEach((n, i) => dot(big, positionXY(i + 1, t), { r: 0.17, cls: `lineup faint ${n === cur.setter[t] ? 'setter' : ''}`, colour: app.match.teams[t].colour, label: n }));
    for (const e of cur.rallyRows) {
      const col = app.match.teams[e.team].colour;
      if (e.start && e.end) arrow(big, e.start, e.end, { colour: col, width: 0.03 });
      else if (e.start || e.end) dot(big, e.start || e.end, { r: 0.06, colour: col });
    }
    for (const k of ['serveStart', 'serveEnd', 'second', 'recep', 'dig']) if (pend[k]?.pt) dot(big, pend[k].pt, { r: 0.09, cls: 'pending' });
    if (pend.attack?.start?.pt) dot(big, pend.attack.start.pt, { r: 0.09, cls: 'pending' });
    if (pend.attack?.end?.pt) dot(big, pend.attack.end.pt, { r: 0.09, cls: 'pending' });
  }

  // ---------- azioni rapide ----------
  function renderQuick() {
    clear(quick);
    const cur = state();
    const dis = !cur || cur.over;
    quick.append(
      h('div', { class: 'row gap wrap' },
        h('button', { class: 'btn', disabled: dis, onclick: () => manualPoint('*') }, `Punto ${app.match.teams['*'].code || 'Casa'}`),
        h('button', { class: 'btn', disabled: dis, onclick: () => manualPoint('a') }, `Punto ${app.match.teams.a.code || 'Ospiti'}`),
        h('button', { class: 'btn', disabled: dis, onclick: () => timeoutDialog() }, 'Time-out'),
        h('button', { class: 'btn', disabled: dis, onclick: () => subDialog() }, 'Cambio'),
        h('button', { class: 'btn', disabled: dis, onclick: () => rotationDialog() }, 'Rotazione'),
        h('button', { class: 'btn', disabled: dis, title: 'Le squadre cambiano lato rispetto alla telecamera', onclick: () => { app.commit('Cambio campo', (m) => m.events.push({ kind: 'side', id: uid(), vt: now() })); render(); } }, '⇅ Campo'),
        h('button', { class: 'btn', disabled: dis, onclick: () => (cur?.pendingEnd ? askEndSet() : forceEndSet()) }, 'Fine set'),
        h('button', { class: 'btn', onclick: () => { pend = {}; app.undo(); } , title: 'Annulla (Ctrl+Z / U)' }, '↶ Annulla')));
  }
  async function forceEndSet() {
    const cur = state();
    const ok = await confirmDialog('Chiudere il set?', `Il punteggio ${cur.score['*']}–${cur.score.a} non è un punteggio di fine set regolare. Chiudere comunque?`, 'Chiudi set');
    if (!ok) return;
    app.commit('Fine set', (m) => m.events.push({ kind: 'endset', id: uid() }));
    render();
    if (!app.rp.matchOver) app.openLineup();
  }
  function timeoutDialog() {
    const dlg = modal('Time-out', h('div', { class: 'row gap' },
      ['*', 'a'].map((t) => h('button', { class: 'btn big', onclick: () => { app.commit('Time-out', (m) => m.events.push({ kind: 'timeout', id: uid(), team: t, vt: now() })); dlg.close(); render(); } }, app.match.teams[t].name))));
  }
  function rotationDialog() {
    const dlg = modal('Correggi rotazione', h('div', { class: 'grid2' },
      ['*', 'a'].map((t) => h('div', { class: 'card' }, h('h3', {}, app.match.teams[t].name),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn', onclick: () => { app.commit('Rotazione', (m) => m.events.push({ kind: 'rot', id: uid(), team: t, dir: -1 })); dlg.close(); render(); } }, '↺ Indietro'),
          h('button', { class: 'btn', onclick: () => { app.commit('Rotazione', (m) => m.events.push({ kind: 'rot', id: uid(), team: t, dir: 1 })); dlg.close(); render(); } }, '↻ Avanti'))))));
  }
  function subDialog() {
    const cur = state();
    let team = '*', out = null, inn = null, newSetter = false;
    const body = h('div');
    const draw = () => {
      clear(body);
      const on = cur.pos[team];
      const libs = liberos(app.match, team);
      const bench = app.match.teams[team].players.map((p) => Number(p.number)).filter((n) => !on.includes(n) && !libs.includes(n));
      body.append(
        h('div', { class: 'row gap' }, ['*', 'a'].map((t) => h('button', { class: `btn ${t === team ? 'primary' : ''}`, onclick: () => { team = t; out = inn = null; draw(); } }, app.match.teams[t].name))),
        h('h4', {}, 'Esce'), h('div', { class: 'chips' }, on.map((n) => h('button', { class: `chip player ${out === n ? 'sel' : ''}`, onclick: () => { out = n; draw(); } }, h('b', {}, n), h('span', {}, lookup(team, n)?.lastName || '')))),
        h('h4', {}, 'Entra'), h('div', { class: 'chips' }, bench.map((n) => h('button', { class: `chip player ${inn === n ? 'sel' : ''}`, onclick: () => { inn = n; draw(); } }, h('b', {}, n), h('span', {}, lookup(team, n)?.lastName || '')))),
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: newSetter, onchange: (e) => { newSetter = e.target.checked; } }), ' Chi entra diventa il palleggiatore'));
    };
    draw();
    modal('Sostituzione', body, {
      actions: [{ label: 'Annulla' }, {
        label: 'Conferma', primary: true, onClick: () => {
          if (out == null || inn == null) { toast('Scegli chi esce e chi entra', 'warn'); return false; }
          app.commit('Cambio', (m) => m.events.push({ kind: 'sub', id: uid(), team, out, in: inn, newSetter: newSetter ? inn : undefined, vt: now() }));
          render();
          return true;
        },
      }],
    });
  }

  // ---------- cronologia azioni (play-by-play) ----------
  let pbpLimit = 300;
  function renderPbp() {
    clear(pbpBody);
    const rows = app.rp.rows;
    const issues = new Map();
    for (const is of app.issues || []) if (is.i != null) { const l = issues.get(is.i) || []; l.push(is); issues.set(is.i, l); }
    const start = Math.max(0, rows.length - pbpLimit);
    if (start > 0) pbpBody.append(h('tr', {}, h('td', { colspan: 7, class: 'muted center' }, h('button', { class: 'btn small', onclick: () => { pbpLimit += 500; renderPbp(); } }, `Mostra ${start} righe precedenti`))));
    for (let k = start; k < rows.length; k++) {
      const r = rows[k];
      const e = r.e;
      const code = codeOf(r);
      const iss = issues.get(r.i);
      const tr = h('tr', { class: `k-${e.kind} ${e.team === 'a' ? 'vis' : e.team === '*' ? 'home' : ''} ${iss ? 'has-issue' : ''}`, 'data-i': r.i },
        h('td', { class: 'mono muted' }, r.i + 1),
        h('td', {}, r.set ?? ''),
        h('td', { class: 'mono' }, e.kind === 'point' ? `${r.scoreAfter['*']}-${r.scoreAfter.a}` : (r.score ? `${r.score['*']}-${r.score.a}` : '')),
        h('td', { class: 'mono code', title: 'Doppio clic per modificare', ondblclick: () => editRow(r, tr) }, code),
        h('td', { class: 'desc' }, iss ? h('span', { class: `issue ${iss[0].level}`, title: iss.map((x) => x.msg).join('\n') }, iss.some((x) => x.level !== 'info') ? '⚠ ' : 'ℹ ') : null, describe(e, lookup)),
        h('td', { class: 'mono' }, e.vt != null ? h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); seekTo(e.vt); } }, fmtTime(e.vt)) : (e.t || '')),
        h('td', { class: 'row-actions' },
          h('button', { class: 'icon-btn', title: 'Modifica', onclick: () => editRow(r, tr) }, '✎'),
          h('button', { class: 'icon-btn', title: 'Inserisci sopra', onclick: () => insertAt(r.i) }, '⤒'),
          h('button', { class: 'icon-btn danger', title: 'Elimina', onclick: () => { app.commit('Elimina riga', (m) => m.events.splice(r.i, 1)); render(); } }, '🗑')));
      pbpBody.append(tr);
    }
    const sc = pbp;
    if (sc.dataset.stick !== 'no') sc.scrollTop = sc.scrollHeight;
  }
  pbp.addEventListener('scroll', () => { pbp.dataset.stick = pbp.scrollTop + pbp.clientHeight >= pbp.scrollHeight - 30 ? 'yes' : 'no'; });

  function codeOf(r) {
    const e = r.e;
    switch (e.kind) {
      case 'skill': return skillCode(e);
      case 'point': return `${e.team}p${String(r.scoreAfter['*']).padStart(2, '0')}:${String(r.scoreAfter.a).padStart(2, '0')}`;
      case 'timeout': return `${e.team}T`;
      case 'sub': return `${e.team}c${e.out}:${e.in}`;
      case 'setter': return `${e.team}P${e.num}`;
      case 'rot': return `${e.team}z${e.dir > 0 ? '+' : '-'}`;
      case 'rotset': return `${e.team}z${e.pos}`;
      case 'lineup': return `>LUp ${e.set}`;
      case 'endset': return `**${r.set}set`;
      case 'green': return `${e.team}$$&${e.type || 'H'}${e.ev}`;
      case 'side': return '<->';
      case 'segment': return '--- sequenza';
      default: return '';
    }
  }
  function seekTo(vt) { if (!hasVideo()) return; video.currentTime = Math.max(0, vt - (app.match.settings.clipPre ?? 3)); }

  function editRow(r, tr) {
    if (r.e.kind === 'lineup') { app.openLineup(r.i); return; }
    const td = tr.querySelector('.code');
    const inp = h('input', { class: 'mono inline-edit', value: codeOf(r) });
    clear(td).appendChild(inp);
    inp.focus(); inp.select();
    const done = (save) => {
      if (save) {
        const txt = inp.value.trim();
        let evs;
        try {
          if (/^[*a]\d\d[SREABDF]/.test(txt)) evs = [parseSkillCode(txt)];
          else {
            const res = interpretTyped(txt, ctxAt(r.i));
            if (res.errors.length) throw new Error(res.errors.join('; '));
            evs = res.events;
          }
        } catch (err) { toast(err.message, 'error'); renderPbp(); return; }
        app.commit('Modifica riga', (m) => {
          const old = m.events[r.i];
          const repl = evs.map((e, k) => (k === 0 && old.kind === e.kind ? { ...old, ...e, id: old.id, start: old.start, mid: old.mid, end: old.end, vt: old.vt, t: old.t } : { ...e, id: uid(), vt: old.vt }));
          m.events.splice(r.i, 1, ...repl);
        });
        render();
      } else renderPbp();
    };
    inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(false));
  }
  function insertAt(i) {
    const inp = h('input', { class: 'mono', placeholder: 'Codice/i da inserire (es. a12D+)', style: { width: '100%' } });
    modal('Inserisci prima della riga ' + (i + 1), h('div', {}, inp, h('p', { class: 'muted' }, 'Puoi inserire più codici separati da spazio.')), {
      actions: [{ label: 'Annulla' }, {
        label: 'Inserisci', primary: true, onClick: () => {
          const res = interpretTyped(inp.value, ctxAt(i));
          if (res.errors.length) { toast(res.errors.join('; '), 'error'); return false; }
          const vt = app.match.events[i]?.vt ?? null;
          app.commit('Inserisci', (m) => m.events.splice(i, 0, ...res.events.map((e) => ({ ...e, id: uid(), vt }))));
          render();
          return true;
        },
      }],
    });
    inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') ev.target.closest('.modal').querySelector('.btn.primary').click(); });
  }

  // ---------- inserimento codici digitati ----------
  function ctxAt(i = null) {
    const rows = app.rp.rows;
    const r = i == null ? null : rows[i];
    const cur = r ? { ...r, ballOwner: r.serving, lastSkill: null } : state();
    if (!cur) return {};
    return {
      serving: cur.serving,
      ballOwner: cur.ballOwner,
      prevSkill: cur.lastSkill,
      setter: cur.setter,
      p1: { '*': cur.pos['*'][0], a: cur.pos.a[0] },
      defaults: { eval: app.match.settings.defaultEval, type: app.match.settings.defaultType },
      attackTable: attackTable(),
      serveType: (t, n) => app.learner.serveType(t, n),
      predict: (t, skill, zone) => rankPlayers(app.match, cur, app.learner, t, skill, zone)[0]?.num ?? null,
    };
  }
  codeInput.addEventListener('input', () => {
    if (typingStartVt == null && codeInput.value) typingStartVt = now();
    if (!codeInput.value) typingStartVt = null;
    const v = codeInput.value.trim();
    clear(codePreview);
    if (!v) return;
    const res = interpretTyped(v, ctxAt());
    codePreview.append(...res.events.map((e) => h('div', { class: 'pv' }, h('code', {}, e.kind === 'skill' ? skillCode(e) : ''), ' ', describe(e, lookup))),
      ...res.errors.map((x) => h('div', { class: 'pv err' }, x)));
  });
  codeInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      submitCode();
    } else if (ev.key === 'Escape') {
      codeInput.blur();
    } else if (ev.ctrlKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      ev.preventDefault(); seekBy(ev.key === 'ArrowLeft' ? -2 : 2);
    } else if (ev.altKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      ev.preventDefault(); seekBy(ev.key === 'ArrowLeft' ? -10 : 10);
    } else if (ev.key === 'Tab') {
      ev.preventDefault(); togglePlay();
    }
  });
  function submitCode() {
    const v = codeInput.value.trim();
    if (!v) return;
    const res = interpretTyped(v, ctxAt());
    if (res.errors.length) { toast(res.errors.join('; '), 'error', 4000); return; }
    const vt = typingStartVt ?? now();
    const evs = res.events.map((e) => ({ ...e, id: uid(), vt, t: hasVideo() ? null : wallClock() }));
    app.commit('Codice', (m) => {
      const ev0 = m.events;
      const last = ev0[ev0.length - 1];
      const prev = ev0[ev0.length - 2];
      let insertBeforePoint = false;
      if (evs[0]?.kind === 'skill' && last?.kind === 'point' && prev?.kind === 'skill') {
        const pair = (prev.skill === 'S' && evs[0].skill === 'R') || (prev.skill === 'A' && (evs[0].skill === 'B' || evs[0].skill === 'D') && rallyWinner(prev));
        if (pair && evs[0].team !== prev.team) insertBeforePoint = true;
      }
      if (insertBeforePoint) {
        const k = ev0.length - 1;
        const skills = [];
        while (evs.length && evs[0].kind === 'skill' && skills.length < 1) skills.push(evs.shift());
        ev0.splice(k, 0, ...skills);
      }
      ev0.push(...evs);
      const hasPoint = evs.some((e) => e.kind === 'point');
      const w = evs.map(rallyWinner).find(Boolean);
      if (w && !hasPoint) ev0.push({ kind: 'point', id: uid(), team: w, vt });
    });
    codeInput.value = '';
    typingStartVt = null;
    clear(codePreview);
    pend = {};
    afterCommit();
  }

  // ---------- tastiera ----------
  function onKey(ev) {
    if (!root.isConnected || root.offsetParent === null) return false;
    const tag = (ev.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || document.querySelector('.modal-back')) return false;
    const k = ev.key;
    if ((ev.ctrlKey || ev.metaKey) && k.toLowerCase() === 'z') { ev.preventDefault(); pend = {}; app.undo(); return true; }
    if ((ev.ctrlKey || ev.metaKey) && k.toLowerCase() === 'y') { ev.preventDefault(); app.redo(); return true; }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
    if (k === ' ') { ev.preventDefault(); togglePlay(); return true; }
    if (k === 'ArrowLeft') { ev.preventDefault(); seekBy(ev.shiftKey ? -10 : -2); return true; }
    if (k === 'ArrowRight') { ev.preventDefault(); seekBy(ev.shiftKey ? 10 : 2); return true; }
    if (k === ',') { seekBy(-1 / 30); return true; }
    if (k === '.') { seekBy(1 / 30); return true; }
    if (k === '[') { video.playbackRate = Math.max(0.25, video.playbackRate - 0.25); speedSel.value = video.playbackRate; return true; }
    if (k === ']') { video.playbackRate = Math.min(4, video.playbackRate + 0.25); speedSel.value = video.playbackRate; return true; }
    if (k === 'Escape' && !panelKeys.has('Escape')) { pend = {}; calib = null; updateCalibBanner(); render(); return true; }
    const fn = panelKeys.get(k) || panelKeys.get(k.toLowerCase());
    if (fn) { ev.preventDefault(); fn(); return true; }
    if (k === 'c' || k === '/') { ev.preventDefault(); codeInput.focus(); return true; }
    if (k === 'u') { pend = {}; app.undo(); return true; }
    return false;
  }

  // ---------- render ----------
  function render() {
    const m = app.match;
    const court = m.settings.clickSurface === 'court';
    const vid = hasVideo();
    videoWrap.classList.toggle('surface-court', court);
    video.classList.toggle('hidden', court);
    bigCourt.classList.toggle('hidden', !court);
    emptyMsg.classList.toggle('hidden', vid || court);
    surfaceBtn.textContent = court ? '🎬 Clic su video' : '🏐 Clic su campo';
    renderScoreboard();
    renderPanel();
    renderMiniCourt();
    renderQuick();
    renderPbp();
    drawOverlay();
    updateCalibBanner();
    if (!calibration() && vid && !court && !calib) {
      banner.classList.remove('hidden');
      clear(banner).append(h('span', {}, '⚠ Campo non calibrato: le posizioni dei tocchi non vengono registrate. '), h('button', { class: 'btn small primary', onclick: () => autoCalibrate() }, '🪄 Calibra automaticamente'), h('button', { class: 'btn small', onclick: () => startCalibration() }, '📐 A mano'));
    }
  }

  return {
    el: root, render, onKey, startCalibration, hasVideo, now, resetLiveClock: () => { liveStart = performance.now(); },
    clearPending: () => { pend = {}; },
    autoCalibrate,
    // per i test
    _debug: () => ({ pend, flow: flow() }),
  };
}
