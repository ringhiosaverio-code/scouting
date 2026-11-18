// Analisi automatica del video: rilevamento di scambi e tocchi, proposta dei
// codici di scouting, revisione rapida (accetta / correggi / scarta).
import { h, s, clear, toast, fmtTime, confirmDialog } from './dom.js';
import { captureAndProcess, geometryFor, ralliesFromFrames } from '../vision/analyzer.js';
import { interpretRally } from '../vision/rally.js';
import { calibrationPairs3D, buildCalibration } from '../lib/court.js';
import { describe, skillCode, parseSkillCode, interpretTyped } from '../lib/codes.js';
import { rankPlayers } from '../lib/predict.js';
import { uid } from '../lib/engine.js';
import { ATTACK_TABLE } from '../lib/constants.js';
import { readJerseyAt } from '../vision/jersey.js';

export function createAuto(app) {
  const root = h('div', { class: 'playlist-grid auto-grid' });
  const videoBox = h('div', { class: 'video-wrap pl-video' });
  const overlay = s('svg', { class: 'overlay passive' });
  const info = h('div', { class: 'now-playing muted' }, 'Analisi automatica: rileva scambi e tocchi dal video e propone i codici.');
  const setupCard = h('div', { class: 'card' });
  const listCard = h('div', { class: 'card auto-list' });
  const propCard = h('div', { class: 'card' });
  root.append(
    h('div', { class: 'left-col' }, videoBox, info, h('div', { class: 'pl-controls row gap' },
      h('button', { class: 'btn', onclick: () => select(selIndex - 1) }, '⏮ Scambio prec.'),
      h('button', { class: 'btn', onclick: () => playSel() }, '▶ Rivedi scambio'),
      h('button', { class: 'btn', onclick: () => select(selIndex + 1) }, 'Scambio succ. ⏭'))),
    h('div', { class: 'right-col' }, setupCard, propCard, listCard));

  const video = app.video;
  let running = null; // AbortController
  let progress = { frac: 0, msg: '' };
  let selIndex = -1;
  let proposal = null; // { rallyIdx, events, text, notes }
  let stopAt = null;

  const A = () => app.match.analysis;
  const rallies = () => A()?.rallies || [];

  // ---------- geometria / overlay ----------
  function contentBox() {
    const r = videoBox.getBoundingClientRect();
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    const k = Math.min(r.width / vw, r.height / vh);
    return { r, ox: (r.width - vw * k) / 2, oy: (r.height - vh * k) / 2, w: vw * k, h: vh * k };
  }
  function drawOverlay() {
    clear(overlay);
    const r = videoBox.getBoundingClientRect();
    overlay.setAttribute('viewBox', `0 0 ${Math.max(1, r.width)} ${Math.max(1, r.height)}`);
    const ra = rallies()[selIndex];
    const an = A();
    if (!ra || !an || !video.videoWidth) return;
    const b = contentBox();
    const P = (x, y) => [b.ox + (x / an.W) * b.w, b.oy + (y / an.H) * b.h];
    const pts = ra.path.map(([, x, y]) => P(x, y));
    if (pts.length > 1) overlay.appendChild(s('polyline', { points: pts.map((p) => p.join(',')).join(' '), class: 'auto-path' }));
    const now = video.currentTime;
    const cur = ra.path.reduce((best, q) => (Math.abs(q[0] - now) < Math.abs(best[0] - now) ? q : best), ra.path[0]);
    if (cur && Math.abs(cur[0] - now) < 0.2) { const p = P(cur[1], cur[2]); overlay.appendChild(s('circle', { cx: p[0], cy: p[1], r: 9, class: 'auto-ball' })); }
    ra.touches.forEach((tc, i) => {
      const q = ra.path.reduce((best, z) => (Math.abs(z[0] - tc.t) < Math.abs(best[0] - tc.t) ? z : best), ra.path[0]);
      if (!q) return;
      const p = P(q[1], q[2]);
      const lab = proposal && proposal.rallyIdx === selIndex ? proposal.labels[i] : String(i + 1);
      overlay.append(s('circle', { cx: p[0], cy: p[1], r: 6, class: `auto-touch ${tc.side}` }), s('text', { x: p[0] + 8, y: p[1] - 8, class: 'auto-label' }, lab || ''));
    });
    if (ra.landing) {
      const q = ra.path.reduce((best, z) => (Math.abs(z[0] - ra.landing.t) < Math.abs(best[0] - ra.landing.t) ? z : best), ra.path[0]);
      if (q) { const p = P(q[1], q[2]); overlay.appendChild(s('path', { d: `M${p[0] - 7},${p[1] - 7}L${p[0] + 7},${p[1] + 7}M${p[0] + 7},${p[1] - 7}L${p[0] - 7},${p[1] + 7}`, class: 'auto-landing' })); }
    }
  }
  new ResizeObserver(() => drawOverlay()).observe(videoBox);
  video.addEventListener('timeupdate', () => {
    if (app.tab === 'auto') {
      drawOverlay();
      if (stopAt != null && video.currentTime >= stopAt) { video.pause(); stopAt = null; }
    }
    // salto dei tempi morti durante lo scouting
    if (app.tab === 'scout' && app.match.settings.skipDeadTime && !video.paused && rallies().length) {
      const t = video.currentTime;
      const inRally = rallies().some((r) => t >= r.start - 2.5 && t <= r.end + 1.5);
      if (!inRally) {
        const next = rallies().find((r) => r.start - 2.5 > t);
        if (next) video.currentTime = next.start - 2.5;
      }
    }
  });

  // ---------- avvio analisi ----------
  function geometryStatus() {
    const pts = app.match.calibration.points;
    const floor = !!buildCalibration(pts);
    const { has3D } = calibrationPairs3D(pts);
    return { floor, has3D };
  }
  async function run(start, end) {
    if (!video.currentSrc) { toast('Carica prima il video della partita', 'warn'); return; }
    const g = geometryStatus();
    if (!g.floor) { toast('Calibra il campo (scheda Scouting → 📐 Calibra)', 'warn', 4000); return; }
    running = new AbortController();
    const t0 = performance.now();
    progress = { frac: 0, msg: 'Avvio…' };
    renderSetup();
    try {
      const res = await captureAndProcess({
        src: video.currentSrc, start, end, rate: +(app.match.settings.analysisRate || 2), signal: running.signal,
        onProgress: (frac, msg) => {
          const el = (performance.now() - t0) / 1000;
          const eta = frac > 0.06 ? el / frac - el : null;
          progress = { frac, msg: `${msg} ${Math.round(frac * 100)}%${eta != null ? ` · ~${Math.ceil(eta / 60)} min rimanenti` : ''}` };
          updateProgress();
        },
      });
      app._lastFrames = res; // per diagnostica
      const geo = geometryFor(app.match.calibration.points, res.W, res.H, app.match.settings.netHeight);
      const found = ralliesFromFrames(res.frames, geo).map((r) => ({ ...r, id: uid(), status: 'todo' }));
      // unisce con analisi precedenti (sostituisce l'intervallo analizzato)
      const old = (A()?.rallies || []).filter((r) => r.end < res.start || r.start > res.end || r.status === 'accepted');
      app.match.analysis = { version: 1, created: new Date().toISOString(), mode: geo.mode, W: res.W, H: res.H, frames: res.frames.length, rallies: [...old, ...found].sort((a, b) => a.start - b.start) };
      app.save();
      toast(`Analisi completata: ${found.length} scambi rilevati (${geo.mode === '3d' ? 'ricostruzione 3D' : 'modalità 2D'})`, 'ok', 5000);
      selIndex = rallies().findIndex((r) => r.status === 'todo');
      proposal = null;
    } catch (e) {
      if (e.name === 'AbortError') toast('Analisi annullata');
      else { console.error(e); toast('Errore durante l\'analisi: ' + e.message, 'error', 6000); }
    } finally {
      running = null;
      render();
    }
  }
  function updateProgress() {
    const bar = setupCard.querySelector('.progress > div');
    const lab = setupCard.querySelector('.progress-label');
    if (bar) bar.style.width = `${Math.round(progress.frac * 100)}%`;
    if (lab) lab.textContent = progress.msg;
  }

  // ---------- proposta per lo scambio selezionato ----------
  function ctxNow() {
    const cur = app.rp.current;
    return {
      homeNear: cur.homeNear, serving: cur.serving,
      p1: { '*': cur.pos['*'][0], a: cur.pos.a[0] }, setter: cur.setter,
      rank: (t, skill, zone) => rankPlayers(app.match, cur, app.learner, t, skill, zone)[0]?.num ?? null,
      attackTable: app.match.settings.attackTable || ATTACK_TABLE,
    };
  }
  const tokenOf = (e) => (e.kind === 'skill' ? skillCode(e) : `${e.team}p`);

  // ---------- lettura dei numeri di maglia (OCR, sperimentale) ----------
  let ocrVideo = null;
  async function readNumbers() {
    const ra = rallies()[selIndex];
    if (!ra || !proposal || !video.currentSrc) return;
    if (!ocrVideo || ocrVideo.src !== video.currentSrc) {
      ocrVideo = document.createElement('video');
      ocrVideo.muted = true; ocrVideo.preload = 'auto'; ocrVideo.src = video.currentSrc;
      await new Promise((r) => ocrVideo.addEventListener('loadeddata', r, { once: true }));
    }
    const skills = proposal.events.filter((e) => e.kind === 'skill');
    const results = [];
    toast('Lettura dei numeri di maglia…');
    for (let k = 0; k < ra.touches.length && k < skills.length; k++) {
      const tc = ra.touches[k], e = skills[k];
      if (!tc.box) { results.push({ k, msg: 'giocatore non individuato' }); continue; }
      // il numero letto deve essere di un giocatore in campo (o del libero) di quella squadra
      const cur = app.rp.current;
      const valid = new Set([...(cur ? cur.pos[e.team] : []), ...app.match.teams[e.team].players.filter((p) => p.role === 'L').map((p) => Number(p.number))]);
      const boxH = (tc.box[3] - tc.box[1]) * (ocrVideo.videoHeight || 0);
      if (boxH < (app.match.settings.ocrMinPx || 90)) { results.push({ k, msg: 'giocatore troppo piccolo nell\'immagine' }); continue; }
      let best = null;
      // più istanti prima del contatto: il giocatore può essere girato o coperto
      for (const dt of [-0.3, -0.15, 0]) {
        let r = null;
        try { r = await readJerseyAt(ocrVideo, Math.max(0, tc.t + dt), tc.box); } catch (err) { toast(err.message, 'error', 6000); return; }
        if (r && r.text && valid.has(Number(r.text)) && (!best || r.conf > best.conf)) best = r;
      }
      // prudenza: una cifra persa ("11" letto "1") non deve sostituire una proposta compatibile
      if (best && e.num != null && String(e.num).length > best.text.length && String(e.num).includes(best.text)) {
        results.push({ k, msg: `letto "${best.text}", compatibile con #${e.num}: mantenuto` });
        continue;
      }
      if (best && best.conf >= 55) {
        const old = e.num;
        e.num = Number(best.text);
        e.auto = { ...(e.auto || {}), ocr: best.conf };
        results.push({ k, msg: old === e.num ? `confermato #${e.num} (${best.conf}%)` : `letto #${e.num} (${best.conf}%), proposto era #${old}` });
      } else results.push({ k, msg: 'numero non leggibile' });
    }
    proposal.text = proposal.events.map(tokenOf).join(' ');
    proposal.ocr = results;
    render();
  }
  function buildProposal(i) {
    const ra = rallies()[i];
    const cur = app.rp.current;
    if (!ra || !cur || cur.over) return null;
    const out = interpretRally(ra, ctxNow());
    // i primi eventi corrispondono, in ordine, ai tocchi rilevati
    const skills = out.events.filter((e) => e.kind === 'skill');
    const labels = ra.touches.map((_, k) => (skills[k] ? `${skills[k].skill}${skills[k].ev}` : ''));
    return { rallyIdx: i, events: out.events, text: out.events.map(tokenOf).join(' '), notes: out.notes, conf: out.conf, labels };
  }
  function parseProposal(text, base) {
    const toks = text.trim().split(/\s+/).filter(Boolean);
    const evs = [];
    const baseSkills = base.filter((e) => e.kind === 'skill');
    let k = 0;
    for (const tk of toks) {
      if (/^[*a]\d\d[SREABDF]/.test(tk)) {
        const e = parseSkillCode(tk);
        const b = baseSkills[k++];
        if (b) Object.assign(e, { start: b.start, end: b.end, vt: b.vt, auto: b.auto });
        evs.push(e);
      } else {
        const r = interpretTyped(tk, {});
        if (r.errors.length) throw new Error(r.errors.join('; '));
        const last = base[base.length - 1];
        evs.push(...r.events.map((e) => ({ ...e, vt: e.vt ?? last?.vt })));
      }
    }
    return evs;
  }
  async function accept(i = selIndex, silent = false) {
    const ra = rallies()[i];
    if (!ra || !proposal || proposal.rallyIdx !== i) return false;
    // il riquadro modificabile vale solo se si riferisce a questo scambio
    const ta = !silent ? propCard.querySelector(`textarea[data-rally="${ra.id}"]`) : null;
    let evs;
    try { evs = parseProposal(ta ? ta.value : proposal.text, proposal.events); } catch (e) { toast(e.message, 'error'); return false; }
    // ordine cronologico rispetto a quanto già scoutizzato
    const lastVt = [...app.match.events].reverse().find((e) => e.vt != null)?.vt ?? -1;
    if (!silent && ra.start < lastVt - 1 && !(await confirmDialog('Ordine degli scambi', 'Questo scambio è precedente all\'ultima azione già registrata: verrà aggiunto in coda. Continuare?', 'Aggiungi'))) return false;
    app.commit('Analisi automatica', (m) => {
      for (const e of evs) m.events.push({ ...e, id: uid() });
      const r = m.analysis.rallies.find((x) => x.id === ra.id);
      if (r) r.status = 'accepted';
    });
    if (!silent) { toast('Scambio aggiunto', 'ok'); next(); }
    return true;
  }
  function discard() {
    const ra = rallies()[selIndex];
    if (!ra) return;
    ra.status = 'discarded';
    app.save();
    next();
  }
  function next() {
    const k = rallies().findIndex((r, j) => j > selIndex && r.status === 'todo');
    select(k >= 0 ? k : selIndex);
  }
  async function acceptAll() {
    const minConf = 0.6;
    let n = 0, stopReason = '';
    for (let i = 0; i < rallies().length; i++) {
      const ra = rallies()[i];
      if (ra.status !== 'todo') continue;
      selIndex = i;
      proposal = buildProposal(i);
      if (!proposal || proposal.notes.length || proposal.conf < minConf || !proposal.events.some((e) => e.kind === 'point')) { stopReason = proposal?.notes[0] || (proposal ? `affidabilità ${Math.round(proposal.conf * 100)}%` : 'set concluso'); break; }
      if (!(await accept(i, true))) break;
      n++;
      if (app.rp.current?.pendingEnd || app.rp.current?.over) break;
    }
    toast(`${n} scambi accettati automaticamente${stopReason ? ` — fermato: ${stopReason}` : ''}`, 'ok', 6000);
    render();
    if (app.rp.current?.pendingEnd) toast('Fine set raggiunta: confermala nella scheda Scouting', 'warn', 5000);
  }

  function select(i) {
    if (i < 0 || i >= rallies().length) return;
    selIndex = i;
    proposal = buildProposal(i);
    const ra = rallies()[i];
    if (video.currentSrc) { video.currentTime = Math.max(0, ra.start - 1.5); }
    render();
  }
  function playSel() {
    const ra = rallies()[selIndex];
    if (!ra || !video.currentSrc) return;
    video.currentTime = Math.max(0, ra.start - 1.5);
    stopAt = ra.end + 1.5;
    video.play();
  }

  // ---------- render ----------
  function renderSetup() {
    clear(setupCard);
    const g = geometryStatus();
    const st = app.match.settings;
    const dur = video.duration || 0;
    const fromInp = h('input', { type: 'text', value: '0:00', size: 6, 'aria-label': 'Da' });
    const toInp = h('input', { type: 'text', value: dur ? fmtMin(dur) : '', size: 6, 'aria-label': 'A' });
    setupCard.append(
      h('h3', {}, 'Analisi automatica del video'),
      h('ul', { class: 'checklist' },
        h('li', { class: video.currentSrc ? 'ok' : 'bad' }, video.currentSrc ? `Video caricato (${fmtMin(dur)})` : 'Video non caricato'),
        h('li', { class: g.floor ? 'ok' : 'bad' }, g.floor ? 'Campo calibrato' : 'Campo non calibrato (scheda Scouting → 📐 Calibra)'),
        h('li', { class: g.has3D ? 'ok' : 'warn' }, g.has3D ? 'Rete calibrata: ricostruzione 3D della palla' : 'Rete non calibrata: modalità 2D, meno precisa (aggiungi i 2 punti della rete in 📐 Calibra)'),
        h('li', { class: app.rp.current ? 'ok' : 'warn' }, app.rp.current ? 'Formazioni inserite' : 'Inserisci le formazioni per ottenere i codici con i giocatori')),
      h('div', { class: 'row gap wrap' },
        h('label', { class: 'field inline' }, h('span', {}, 'Da'), fromInp),
        h('label', { class: 'field inline' }, h('span', {}, 'A'), toInp),
        h('button', { class: 'btn small', onclick: () => { fromInp.value = fmtMin(video.currentTime || 0); } }, 'Da qui'),
        h('label', { class: 'field inline' }, h('span', {}, 'Rete'), h('select', { onchange: (e) => { st.netHeight = +e.target.value; app.save(); } },
          h('option', { value: 2.43, selected: st.netHeight === 2.43 }, 'Maschile 2,43 m'), h('option', { value: 2.24, selected: st.netHeight === 2.24 }, 'Femminile 2,24 m'),
          h('option', { value: 2.35, selected: st.netHeight === 2.35 }, 'Under 2,35 m'), h('option', { value: 2.15, selected: st.netHeight === 2.15 }, 'Under F 2,15 m'))),
        h('label', { class: 'field inline' }, h('span', {}, 'Velocità'), h('select', { onchange: (e) => { st.analysisRate = +e.target.value; app.save(); } },
          [[1, 'Accurata (1×)'], [2, 'Normale (2×)'], [4, 'Veloce (4×)']].map(([v, l]) => h('option', { value: v, selected: (st.analysisRate || 2) === v }, l))))),
      running
        ? h('div', {}, h('div', { class: 'progress' }, h('div', { style: { width: `${Math.round(progress.frac * 100)}%` } })), h('div', { class: 'progress-label muted small' }, progress.msg),
          h('button', { class: 'btn danger', onclick: () => running.abort() }, 'Annulla'))
        : h('div', { class: 'row gap wrap' },
          h('button', { class: 'btn primary', disabled: !video.currentSrc || !g.floor, onclick: () => run(parseMin(fromInp.value) ?? 0, parseMin(toInp.value) ?? dur) }, '🤖 Avvia analisi'),
          h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: !!st.skipDeadTime, onchange: (e) => { st.skipDeadTime = e.target.checked; app.save(); } }), ' Salta i tempi morti durante lo scouting')),
      h('p', { class: 'muted small' }, 'Telecamera fissa consigliata. Il sistema propone; lo scout conferma o corregge ogni scambio.'));
  }

  function renderProposal() {
    clear(propCard);
    const ra = rallies()[selIndex];
    if (!ra) { propCard.append(h('h3', {}, 'Proposta'), h('p', { class: 'muted' }, rallies().length ? 'Seleziona uno scambio dall\'elenco.' : 'Nessuna analisi ancora.')); return; }
    if (!app.rp.current || app.rp.current.over) { propCard.append(h('h3', {}, 'Proposta'), h('p', { class: 'warn' }, app.rp.current?.over ? 'Set concluso: inserisci le formazioni del set successivo (scheda Scouting).' : 'Inserisci le formazioni (scheda Scouting) per generare i codici.')); return; }
    if (!proposal || proposal.rallyIdx !== selIndex) proposal = buildProposal(selIndex);
    const ta = h('textarea', { class: 'mono', rows: 3, spellcheck: false, 'aria-label': 'Codici proposti', 'data-rally': ra.id });
    ta.value = proposal.text;
    const descr = h('ol', { class: 'auto-desc' });
    const drawDescr = () => {
      clear(descr);
      let evs = [];
      try { evs = parseProposal(ta.value, proposal.events); } catch (e) { descr.append(h('li', { class: 'warn' }, e.message)); return; }
      descr.append(...evs.map((e) => h('li', {}, describe(e, app.lookup), e.auto?.speed ? h('span', { class: 'muted' }, ` · ${e.auto.speed} km/h`) : null, e.auto?.height != null && e.skill !== 'S' ? h('span', { class: 'muted' }, ` · h ${e.auto.height} m`) : null, e.auto?.conf != null && e.auto.conf < 0.5 ? h('span', { class: 'warn' }, ' · incerto') : null)));
    };
    ta.addEventListener('input', drawDescr);
    ta.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); accept(); } });
    drawDescr();
    const statusTxt = { todo: 'da rivedere', accepted: 'accettato', discarded: 'scartato' }[ra.status];
    propCard.append(
      h('h3', {}, `Scambio ${selIndex + 1} · ${fmtTime(ra.start)} · ${statusTxt}`),
      h('p', { class: 'muted small' }, `Affidabilità ${Math.round(proposal.conf * 100)}% · ${ra.touches.length} tocchi · ${ra.landing ? `atterraggio ${ra.landing.extrapolated ? 'stimato' : 'visto'}` : 'atterraggio non visto'} · ${ra.mode.toUpperCase()}`),
      proposal.notes.length ? h('ul', { class: 'notes' }, proposal.notes.map((n) => h('li', { class: 'warn' }, '⚠ ' + n))) : null,
      proposal.ocr ? h('ul', { class: 'notes ocr-results' }, proposal.ocr.map((r) => h('li', {}, `Tocco ${r.k + 1}: ${r.msg}`))) : null,
      ta, descr,
      h('div', { class: 'row gap wrap' },
        h('button', { class: 'btn primary', disabled: ra.status === 'accepted', onclick: () => accept() }, '✓ Accetta (Invio)'),
        h('button', { class: 'btn', onclick: () => discard() }, 'Scarta'),
        h('button', { class: 'btn', onclick: () => { proposal = buildProposal(selIndex); render(); } }, '↺ Ripristina'),
        h('button', { class: 'btn', title: 'Sperimentale: legge i numeri sulle maglie dei giocatori che toccano (scarica il motore OCR al primo uso)', onclick: () => readNumbers() }, '🔢 Leggi numeri di maglia'),
        h('button', { class: 'btn', onclick: () => acceptAll() }, '⏩ Accetta in serie gli scambi sicuri')),
      h('p', { class: 'muted small' }, 'Puoi modificare i codici prima di accettare (sintassi DataVolley; *p / ap per il punto).'));
  }

  function renderList() {
    clear(listCard);
    const rs = rallies();
    const counts = { todo: 0, accepted: 0, discarded: 0 };
    rs.forEach((r) => counts[r.status]++);
    listCard.append(h('h3', {}, `Scambi rilevati (${rs.length})`),
      rs.length ? h('p', { class: 'muted small' }, `${counts.accepted} accettati · ${counts.todo} da rivedere · ${counts.discarded} scartati`) : null,
      h('ol', { class: 'clips' }, rs.map((r, i) => h('li', { class: `${i === selIndex ? 'playing' : ''} st-${r.status}`, onclick: () => select(i) },
        h('span', { class: 'mono' }, fmtTime(r.start)), ' ',
        r.touches.map((tc) => (tc.side === 'near' ? '●' : '○')).join(''),
        r.landing ? ' ✕' : ' ?', ' ',
        h('span', { class: 'muted' }, { todo: '', accepted: '✓', discarded: 'scartato' }[r.status])))));
  }

  function render() {
    if (!video.currentSrc && !videoBox.querySelector('.video-empty')) videoBox.append(h('div', { class: 'video-empty' }, h('p', {}, 'Carica il video della partita.'), h('button', { class: 'btn primary', onclick: () => app.openVideo() }, '📂 Carica video')));
    if (video.currentSrc) videoBox.querySelector('.video-empty')?.remove();
    renderSetup();
    renderProposal();
    renderList();
    drawOverlay();
  }

  function onKey(ev) {
    const tag = (ev.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || document.querySelector('.modal-back')) return;
    if (ev.key === ' ') { ev.preventDefault(); if (video.paused) video.play(); else video.pause(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); accept(); }
    else if (ev.key === 'ArrowDown' || ev.key === 'n') select(selIndex + 1);
    else if (ev.key === 'ArrowUp' || ev.key === 'p') select(selIndex - 1);
    else if (ev.key === 'r') playSel();
    else if (ev.key === 'Delete') discard();
  }

  return {
    el: root, render, onKey,
    attachVideo: () => { videoBox.prepend(video); videoBox.appendChild(overlay); video.controls = true; },
    _run: run,
  };
}

function fmtMin(t) { t = Math.max(0, t || 0); return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; }
function parseMin(v) {
  if (!v) return null;
  const p = String(v).trim().split(':').map(Number);
  if (p.some(Number.isNaN)) return null;
  return p.length === 1 ? p[0] : p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2];
}
