// Analisi automatica del video: rilevamento di scambi e tocchi, proposta dei
// codici di scouting, revisione rapida (accetta / correggi / scarta).
import { h, s, clear, toast, fmtTime, confirmDialog } from './dom.js';
import { galleryOf, galleryCount, describeTouch } from './players.js';
import { analyzeBreaks, BREAK_LABEL, swappedVs } from '../vision/breaks.js';
import { createLiveFeed } from './livefeed.js';
import { identify, learn } from '../vision/playerid.js';
import { captureFast, captureAndProcess, geometryFor, ralliesFromFrames, corsFor } from '../vision/analyzer.js';
import { interpretRally } from '../vision/rally.js';
import { calibrationPairs3D, buildCalibration } from '../lib/court.js';
import { describe, skillCode, parseSkillCode, interpretTyped } from '../lib/codes.js';
import { rankPlayers } from '../lib/predict.js';
import { uid } from '../lib/engine.js';
import { ATTACK_TABLE } from '../lib/constants.js';
import { readJerseyAt } from '../vision/jersey.js';
import { officialOf, officialRally, applyOfficial, rawReading, officialCard, describeOfficial } from './official.js';
import { winFeatures, loadWinModel, saveWinModel, pNear, updateWinModel } from '../lib/winmodel.js';

export function createAuto(app) {
  const root = h('div', { class: 'playlist-grid auto-grid' });
  const videoBox = h('div', { class: 'video-wrap pl-video' });
  const overlay = s('svg', { class: 'overlay passive' });
  const info = h('div', { class: 'now-playing muted' }, 'Analisi automatica: rileva scambi e tocchi dal video e propone i codici.');
  const setupCard = h('div', { class: 'card' });
  const liveCard = h('div', { class: 'card live-card hidden' });
  const listCard = h('div', { class: 'card auto-list' });
  const offCard = h('div');
  const propCard = h('div', { class: 'card' });
  root.append(
    h('div', { class: 'left-col' }, videoBox, info, h('div', { class: 'pl-controls row gap' },
      h('button', { class: 'btn', onclick: () => select(selIndex - 1) }, '⏮ Scambio prec.'),
      h('button', { class: 'btn', onclick: () => playSel() }, '▶ Rivedi scambio'),
      h('button', { class: 'btn', onclick: () => select(selIndex + 1) }, 'Scambio succ. ⏭'))),
    h('div', { class: 'right-col' }, setupCard, offCard, liveCard, propCard, listCard));

  const video = app.video;
  let running = null; // AbortController
  let progress = { frac: 0, msg: '' };
  let selIndex = -1;
  let proposal = null; // { rallyIdx, events, text, notes }
  let stopAt = null;

  const A = () => app.match.analysis;
  const winModel = loadWinModel();
  const teamOf = (t) => (t == null ? null : t === (app.match.official?.homeIs ?? 0) ? '*' : 'a');
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
      // giocatore riconosciuto al tocco (vicino nel tempo)
      if (tc.pbox && Math.abs(now - tc.t) < 0.6) {
        const a = P(tc.pbox[0] * an.W, tc.pbox[1] * an.H), z = P(tc.pbox[2] * an.W, tc.pbox[3] * an.H);
        const ev = proposal && proposal.rallyIdx === selIndex ? proposal.events.filter((e) => e.kind === 'skill')[i] : null;
        overlay.append(s('rect', { x: a[0], y: a[1], width: z[0] - a[0], height: z[1] - a[1], class: `auto-pbox ${tc.side}` }));
        if (ev?.num != null) overlay.append(s('text', { x: a[0], y: a[1] - 4, class: 'auto-label' }, `#${ev.num}`));
      }
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
    if (!app.videoInfo?.pixels) { toast(app.videoInfo?.kind === 'youtube' ? 'L\'analisi automatica non funziona con YouTube: YouTube non permette di leggere i fotogrammi. Usa il file o un link diretto (MP4, Dropbox, Drive).' : 'Questo link non permette di leggere i fotogrammi (CORS o flusso HLS): analisi automatica non disponibile.', 'warn', 8000); return; }
    const g = geometryStatus();
    if (!g.floor) { toast('Calibra il campo (scheda Scouting → 📐 Calibra)', 'warn', 4000); return; }
    running = new AbortController();
    const t0 = performance.now();
    progress = { frac: 0, msg: 'Avvio…' };
    renderSetup();
    try {
      const onProgress = (frac, msg) => {
        const el = (performance.now() - t0) / 1000;
        const eta = frac > 0.06 ? el / frac - el : null;
        progress = { frac, msg: `${msg} ${Math.round(frac * 100)}%${eta != null ? ` · ~${eta < 90 ? Math.ceil(eta) + ' s' : Math.ceil(eta / 60) + ' min'} rimanenti` : ''}` };
        updateProgress();
      };
      const cvOpts = { ballColor: app.match.settings.ballColor || 'yellow' };
      let res = null;
      // cronaca in diretta: scambi riconosciuti e scritti mentre l'analisi procede
      const vw = video.videoWidth || 1280, vh = video.videoHeight || 720, lw = Math.min(480, vw);
      const liveGeo = geometryFor(app.match.calibration.points, lw, Math.round(vh * lw / vw), app.match.settings.netHeight);
      liveCard.classList.remove('hidden');
      const live = createLiveFeed({ app, geo: liveGeo, ctx: () => (app.rp.current ? ctxNow() : { homeNear: true, serving: '*' }), el: liveCard });
      const onFrames = (i, fs) => live.push(i, fs);
      // 1) analisi veloce: decodifica diretta del file in più worker (WebCodecs)
      const fastSrc = app.videoFile ? { file: app.videoFile } : /^(https?:|\/|mega-stream)/.test(video.currentSrc) || video.currentSrc.startsWith(location.origin) ? { src: video.currentSrc } : null;
      if (fastSrc && app.match.settings.fastAnalysis !== false) {
        try { res = await captureFast({ ...fastSrc, start, end, signal: running.signal, cvOpts, onProgress, onFrames }); }
        catch (e) {
          if (e.name === 'AbortError') throw e;
          console.warn('analisi veloce non disponibile:', e);
          toast(`Analisi veloce non disponibile (${e.message}): uso la lettura tradizionale, più lenta`, 'warn', 6000);
        }
      }
      // 2) ripiego: il video viene riprodotto e letto fotogramma per fotogramma
      if (!res) res = await captureAndProcess({ src: video.currentSrc, start, end, rate: +(app.match.settings.analysisRate || 2), signal: running.signal, cvOpts, onProgress, onFrames });
      live.finish();
      app._lastFrames = res; // per diagnostica
      const geo = geometryFor(app.match.calibration.points, res.W, res.H, app.match.settings.netHeight);
      let found = ralliesFromFrames(res.frames, geo).map((r) => ({ ...r, id: uid(), status: 'todo' }));
      // pause tra gli scambi (time-out, video check, fine set, cambio campo) e scambi tagliati
      let breaks = [];
      if (geo.Hpx) {
        const an = analyzeBreaks(res.frames, found, geo.Hpx, { cuts: res.cuts || [] });
        found = an.rallies;
        breaks = an.breaks.map((b) => ({ ...b, id: uid(), afterId: found[b.after].id, status: 'todo' }));
      }
      // unisce con analisi precedenti (sostituisce l'intervallo analizzato)
      const old = (A()?.rallies || []).filter((r) => r.end < res.start || r.start > res.end || r.status === 'accepted');
      const oldBreaks = (A()?.breaks || []).filter((b) => b.end < res.start || b.start > res.end);
      app.match.analysis = { version: 1, created: new Date().toISOString(), mode: geo.mode, W: res.W, H: res.H, frames: res.frames.length, rallies: [...old, ...found].sort((a, b) => a.start - b.start), breaks: [...oldBreaks, ...breaks].sort((a, b) => a.start - b.start) };
      if (breaks.length) toast(`Pause riconosciute: ${breaks.map((b) => BREAK_LABEL[b.kind]).join(', ')}`, 'info', 6000);
      app.save();
      const secs = (performance.now() - t0) / 1000;
      toast(`Analisi completata in ${secs < 90 ? Math.round(secs) + ' s' : Math.round(secs / 60) + ' min'} (${((res.end - res.start) / secs).toFixed(1)}× tempo reale${res.fast ? `, ${res.fast.workers} in parallelo` : ''}): ${found.length} scambi rilevati`, 'ok', 6000);
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
  const galleryReady = () => app.videoInfo?.pixels && app.match.settings.autoIdentify !== false;
  let readChain = Promise.resolve();
  function readNumbers(opts = {}) {
    // una lettura alla volta (il video di lettura è condiviso): si accodano
    const run = readChain.then(() => readNumbersNow(opts)).catch((e) => { console.warn(e); toast('Riconoscimento dei giocatori non riuscito: ' + e.message, 'warn', 5000); });
    readChain = run;
    return run;
  }
  async function readNumbersNow({ quiet = false } = {}) {
    const ra = rallies()[selIndex];
    const prop = proposal;
    if (!ra || !prop || !video.currentSrc) return;
    if (!ocrVideo || ocrVideo.src !== video.currentSrc) {
      ocrVideo = document.createElement('video');
      ocrVideo.muted = true; ocrVideo.preload = 'auto'; corsFor(ocrVideo, video.currentSrc); ocrVideo.src = video.currentSrc;
      await new Promise((r) => ocrVideo.addEventListener('loadeddata', r, { once: true }));
    }
    const skills = prop.events.filter((e) => e.kind === 'skill');
    const results = [];
    if (!quiet) toast('Riconoscimento dei giocatori…');
    for (let k = 0; k < skills.length; k++) {
      const e = skills[k];
      const tk = e.tk ?? k;
      if (tk < 0 || !ra.touches[tk]) continue; // tocco dedotto, non visto nel video
      const tc = ra.touches[tk];
      if (!tc.box && !tc.foot) { results.push({ k, msg: 'giocatore non individuato' }); continue; }
      // il numero letto deve essere di un giocatore in campo (o del libero) di quella squadra
      const cur = app.rp.current;
      const valid = new Set([...(cur ? cur.pos[e.team] : []), ...app.match.teams[e.team].players.filter((p) => p.role === 'L').map((p) => Number(p.number))]);
      const boxH = tc.box ? (tc.box[3] - tc.box[1]) * (ocrVideo.videoHeight || 0) : Infinity;
      // riconoscimento: rete neurale (chi è il giocatore e che numero ha, su più fotogrammi),
      // galleria della squadra (registrazioni e correzioni), rotazione e fondamentale
      {
        const desc = await describeTouch(ocrVideo, tc.t, tc.box, tc.foot, buildCalibration(app.match.calibration.points), [...valid]);
        if (!desc) { results.push({ k, msg: 'giocatore non individuato' }); continue; }
        tc.pbox = desc.box; // riquadro del giocatore al tocco (disegnato sul video)
        const zone = e.skill === 'R' || e.skill === 'D' ? e.ez ?? e.sz : e.sz;
        const prior = new Map(rankPlayers(app.match, cur, app.learner, e.team, e.skill, zone).map((r) => [r.num, r.p]));
        const ranking = identify(galleryOf(app.match, e.team), desc, [...valid], prior);
        const top = ranking[0];
        (prop.pid ||= {})[k] = { desc, ranking, proposed: e.num, tk };
        // numero dai dati ufficiali: non si cambia; la galleria imparerà da questo tocco
        if (e.official) {
          results.push({ k, msg: top?.num === e.num ? `#${e.num} ufficiale, riconosciuto anche dal video (${Math.round(top.p * 100)}%)` : `#${e.num} ufficiale${top ? ` (il video proponeva #${top.num}, ${Math.round(top.p * 100)}%)` : ''}: la galleria impara da questo tocco` });
          continue;
        }
        // battuta: il battitore dalla rotazione è quasi sempre giusto; lo si cambia solo con una
        // lettura sicurissima e confermata in più fotogrammi
        const strict = e.skill === 'S' && e.num != null;
        const seen = strict ? (top.dig ?? 0) >= 0.9 && (desc.nReads || 0) >= 2 : (top.dig ?? 0) >= 0.5 || (top.tpl ?? 0) >= 0.75;
        // si cambia la proposta solo se il numero è stato davvero visto (rete delle cifre o
        // sagoma registrata); con la sola rotazione resta quella di partenza
        if (top && top.p >= 0.5 && (top.num === e.num || seen)) {
          const old = e.num;
          e.num = top.num;
          prop.pid[k].proposed = e.num;
          e.auto = { ...(e.auto || {}), pid: Math.round(top.p * 100) };
          const why = (top.dig ?? 0) >= 0.5 ? `numero letto${desc.nReads > 1 ? ` in ${desc.nReads} fotogrammi` : ''}` : (top.tpl ?? 0) >= 0.75 ? 'numero riconosciuto' : 'posizione e aspetto';
          results.push({ k, msg: old === e.num ? `confermato #${e.num} (${Math.round(top.p * 100)}%, ${why})` : `riconosciuto #${e.num} (${Math.round(top.p * 100)}%, ${why}), proposto era #${old}` });
        } else results.push({ k, msg: desc.readable ? `incerto: #${top?.num ?? '?'} ${Math.round((top?.p || 0) * 100)}% — conferma o correggi, l'app impara` : 'numero non visibile: resta la proposta da rotazione e ruolo' });
        continue;
      }
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
    prop.text = prop.events.map(tokenOf).join(' ');
    prop.ocr = results;
    render();
  }
  const breakAfter = (ra) => (A()?.breaks || []).find((b) => b.afterId === ra.id);
  const breakBefore = (ra) => { const rs = rallies(); const k = rs.indexOf(ra); return k > 0 ? breakAfter(rs[k - 1]) : null; };
  // pausa registrata come evento nella partita (time-out o cambio campo), al punto giusto della sequenza
  function applyBreak(b, ev) {
    app.commit(ev.kind === 'timeout' ? 'Time-out (analisi)' : 'Cambio campo (analisi)', (m) => {
      const e = { ...ev, id: uid(), vt: b.start + 1 };
      const k = m.events.findIndex((x) => x.vt != null && x.vt > e.vt);
      if (k < 0) m.events.push(e); else m.events.splice(k, 0, e);
      const bb = m.analysis.breaks.find((x) => x.id === b.id);
      if (bb) bb.status = 'done';
    });
    proposal = buildProposal(selIndex);
    render();
  }
  function ignoreBreak(b) { b.status = 'ignored'; app.save(); proposal = buildProposal(selIndex); render(); }
  function breakRow(b) {
    const T = app.match.teams;
    const acts = b.status !== 'todo' ? [h('span', { class: 'muted' }, b.status === 'done' ? ' ✓ registrato' : ' ignorato')]
      : b.kind === 'timeout' ? [' ', ...['*', 'a'].map((t) => h('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); applyBreak(b, { kind: 'timeout', team: t }); } }, `T ${T[t].code || T[t].name}`))]
        : b.kind === 'side' || b.kind === 'setbreak' ? [' ', h('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); applyBreak(b, { kind: 'side' }); } }, '⇅ Registra cambio campo')]
          : [];
    return h('li', { class: `break-row k-${b.kind}`, title: b.why, onclick: () => { video.currentTime = b.start + 1; } },
      h('span', { class: 'mono' }, fmtTime(b.start)), ' ', h('b', {}, BREAK_LABEL[b.kind]), ' ', h('span', { class: 'muted small' }, `${Math.round(b.dur)} s · ${b.why}`),
      ...acts,
      b.status === 'todo' ? h('button', { class: 'btn small', title: 'Non è successo', onclick: (e) => { e.stopPropagation(); ignoreBreak(b); } }, '✕') : null);
  }

  function buildProposal(i) {
    const ra = rallies()[i];
    const cur = app.rp.current;
    if (!ra || !cur || cur.over) return null;
    const ctx = ctxNow();
    // lettura del solo video (conservata per la verifica con i dati ufficiali)
    const raw = interpretRally(ra, ctx);
    const notes = [], info = [];
    // chi vince: indizi del video + cambio palla (chi batte lo scambio dopo), modello che impara
    const rs = rallies();
    const next = rs[i + 1], br = breakAfter(ra);
    const gapBreak = !!br && (br.kind === 'side' || br.kind === 'setbreak');
    const landSide = raw.winner ? ((raw.winner === '*') === cur.homeNear ? 'near' : 'far') : null;
    const feats = winFeatures(ra, next && next.status !== 'discarded' ? next : null, gapBreak, landSide);
    const pn = pNear(winModel, feats);
    const sideTeam = (near) => ((near === cur.homeNear) ? '*' : 'a');
    let force = null;
    // scambio ufficiale: quello del punteggio attuale; per uno scambio già accettato, quello abbinato allora
    const offM = officialOf(app.match) && app.match.official.apply !== false ? officialOf(app.match) : null;
    const offAt = (o) => { const r = offM.rallies.filter((x) => x.set === o.set)[o.k]; return r ? { r, k: o.k, ok: true, before: [] } : null; };
    const off = !offM ? null : ra.status === 'accepted' ? (ra.off ? offAt(ra.off) : null) : officialRally(app.match, cur);
    if (off) force = teamOf(off.r.winner);
    else if (pn >= 0.8 || pn <= 0.2) {
      const w = sideTeam(pn >= 0.5);
      if (w !== raw.winner) {
        force = w;
        notes.push(raw.winner ? `Punto: il video indicava ${app.match.teams[raw.winner].name}, ma batte poi ${app.match.teams[w].name} (cambio palla, ${Math.round(Math.max(pn, 1 - pn) * 100)}%): verifica` : `Punto dedotto: batte poi ${app.match.teams[w].name} (cambio palla, ${Math.round(Math.max(pn, 1 - pn) * 100)}%)`);
      }
    }
    const out = force ? interpretRally(ra, { ...ctx, forceWinner: force }) : raw;
    notes.push(...out.notes.filter((n) => !(force && /^Atterraggio non visto/.test(n))));
    let events = out.events;
    let official = null;
    if (off) {
      if (!off.ok) notes.push(`Il punteggio registrato (${cur.score['*']}-${cur.score.a}) non coincide con quello ufficiale a questo punto (${off.before.join('-')}): controlla gli scambi precedenti`);
      const fixed = applyOfficial(events, off.r, app.match);
      events = fixed.events;
      notes.push(...fixed.notes);
      if (fixed.applied && raw.winner && raw.winner !== force) info.push(`punto a ${app.match.teams[force].name} (il video indicava ${app.match.teams[raw.winner].name})`);
      info.push(...fixed.info);
      official = { set: ra.status === 'accepted' && ra.off ? ra.off.set : cur.set, k: off.k, text: describeOfficial(offM, app.match, off.r), applied: fixed.applied };
    }
    // ogni tocco rilevato con il suo fondamentale (per le etichette sul video)
    const skills = events.filter((e) => e.kind === 'skill');
    const labels = ra.touches.map((_, k) => { const e = skills.find((x) => x.tk === k); return e ? `${e.skill}${e.ev}` : ''; });
    if (ra.cutEnd) {
      notes.push('Scambio interrotto da un taglio o da un replay: l\'esito non si vede, verifica il punto');
    }
    if (br?.kind === 'videocheck') notes.push(`Dopo questo scambio: ${br.why}. Probabile video check: verifica il punto (può essere stato ribaltato)`);
    const prevBr = breakBefore(ra);
    if (prevBr && (prevBr.kind === 'side' || prevBr.kind === 'setbreak') && prevBr.status === 'todo') notes.push(`Prima di questo scambio: ${BREAK_LABEL[prevBr.kind]} (${prevBr.why}). Registralo o ignoralo nell'elenco prima di accettare`);
    // colori delle maglie imparati dagli scambi accettati: le squadre sono dalla parte attesa?
    const tc = A()?.teamColours;
    if (tc && ra.colours && cur) {
      const exp = cur.homeNear ? { near: tc['*'], far: tc.a } : { near: tc.a, far: tc['*'] };
      if (swappedVs(exp, ra.colours) === true) notes.push('Le maglie dicono che le squadre hanno cambiato campo rispetto a quanto registrato: usa ⇅ Campo nella scheda Scouting');
    }
    return { rallyIdx: i, events, text: events.map(tokenOf).join(' '), notes, info, official, raw: rawReading(raw.events), feats, pn, homeNear: cur.homeNear, conf: official?.applied ? Math.max(out.conf, 0.9) : out.conf, labels };
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
    // apprendimento: il numero finale (confermato o corretto dallo scout) entra nella galleria
    if (proposal.pid) {
      const fin = evs.filter((e) => e.kind === 'skill');
      let learned = 0, corrected = 0, skipped = 0;
      for (const [k, it] of Object.entries(proposal.pid)) {
        const e = fin[+k];
        if (!e || e.num == null || !it.desc) continue;
        const offNum = proposal.events.filter((x) => x.kind === 'skill')[+k]?.official;
        const ok = learn(galleryOf(app.match, e.team), it.ranking, Number(e.num), it.desc, { source: offNum ? 'official' : Number(e.num) !== it.proposed ? 'manual' : 'auto', t: ra.touches[it.tk ?? +k]?.t });
        if (!ok) { skipped++; continue; }
        learned++; if (Number(e.num) !== it.proposed) corrected++;
      }
      if (corrected && !silent) toast(`Imparato da ${corrected} correzion${corrected === 1 ? 'e' : 'i'}: non ripeterà lo stesso errore su questi giocatori`, 'info', 4000);
      if (skipped && !silent) toast(`${skipped} riquadr${skipped === 1 ? 'o inquadrava' : 'i inquadravano'} probabilmente un altro giocatore (numero diverso ben leggibile): non usat${skipped === 1 ? 'o' : 'i'} per imparare`, 'info', 5000);
    }
    app.commit('Analisi automatica', (m) => {
      for (const e of evs) m.events.push({ ...e, id: uid() });
      const r = m.analysis.rallies.find((x) => x.id === ra.id);
      if (r) {
        r.status = 'accepted';
        // per la verifica: cosa aveva letto il video da solo, e quale scambio ufficiale è
        r.raw = proposal.raw;
        if (proposal.official) r.off = { set: proposal.official.set, k: proposal.official.k };
      }
      // colori delle squadre, per accorgersi poi di un cambio campo non registrato
      const cur0 = app.rp.current;
      if (ra.colours && cur0) {
        const byTeam = cur0.homeNear ? { '*': ra.colours.near, a: ra.colours.far } : { '*': ra.colours.far, a: ra.colours.near };
        m.analysis.teamColours ||= byTeam;
      }
    });
    // chi ha vinto davvero: il modello del punto impara
    const pt = evs.find((e) => e.kind === 'point');
    if (pt && proposal.feats && proposal.homeNear != null) { updateWinModel(winModel, proposal.feats, (pt.team === '*') === proposal.homeNear); saveWinModel(winModel); }
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
      if (!proposal || proposal.notes.length || (proposal.conf < minConf && !proposal.official?.applied) || !proposal.events.some((e) => e.kind === 'point')) { stopReason = proposal?.notes[0] || (proposal ? `affidabilità ${Math.round(proposal.conf * 100)}%` : 'set concluso'); break; }
      const pb = breakBefore(ra);
      if (pb && pb.status === 'todo' && pb.kind !== 'videocheck') { stopReason = `${BREAK_LABEL[pb.kind]} prima dello scambio`; break; }
      if (galleryReady()) await readNumbers({ quiet: true });
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
    // giocatori registrati: riconoscimento automatico di chi tocca
    if (proposal && galleryReady()) { const p0 = proposal; readNumbers({ quiet: true }).catch(() => {}); }
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
        video.currentSrc && !app.videoInfo?.pixels ? h('li', { class: 'bad' }, app.videoInfo?.kind === 'youtube' ? 'Video YouTube: i fotogrammi non sono leggibili, analisi non disponibile (usa il file o un link diretto)' : 'Il link non consente la lettura dei fotogrammi (CORS/HLS)') : null,
        h('li', { class: g.floor ? 'ok' : 'bad' }, g.floor ? 'Campo calibrato' : 'Campo non calibrato (scheda Scouting → 📐 Calibra)'),
        h('li', { class: 'ok' }, g.has3D ? 'Rete calibrata: ricostruzione 3D della palla' : 'Rete stimata dalla calibrazione del campo: ricostruzione 3D (per più precisione aggiungi i 2 punti della rete in 📐 Calibra)'),
        h('li', { class: app.rp.current ? 'ok' : 'warn' }, app.rp.current ? 'Formazioni inserite' : 'Inserisci le formazioni per ottenere i codici con i giocatori')),
      h('div', { class: 'row gap wrap' },
        h('label', { class: 'field inline' }, h('span', {}, 'Da'), fromInp),
        h('label', { class: 'field inline' }, h('span', {}, 'A'), toInp),
        h('button', { class: 'btn small', onclick: () => { fromInp.value = fmtMin(video.currentTime || 0); } }, 'Da qui'),
        h('label', { class: 'field inline' }, h('span', {}, 'Rete'), h('select', { onchange: (e) => { st.netHeight = +e.target.value; app.save(); } },
          h('option', { value: 2.43, selected: st.netHeight === 2.43 }, 'Maschile 2,43 m'), h('option', { value: 2.24, selected: st.netHeight === 2.24 }, 'Femminile 2,24 m'),
          h('option', { value: 2.35, selected: st.netHeight === 2.35 }, 'Under 2,35 m'), h('option', { value: 2.15, selected: st.netHeight === 2.15 }, 'Under F 2,15 m'))),
        h('label', { class: 'field inline' }, h('span', {}, 'Pallone'), h('select', { title: 'Il colore aiuta a distinguere la palla da braccia, gambe e scarpe dei giocatori', onchange: (e) => { st.ballColor = e.target.value; app.save(); } },
          h('option', { value: 'yellow', selected: (st.ballColor || 'yellow') === 'yellow' }, 'Giallo/blu (Mikasa)'), h('option', { value: 'any', selected: st.ballColor === 'any' }, 'Altro colore (nessun filtro)'))),
        h('label', { class: 'toggle', title: 'Decodifica il file direttamente in più processi paralleli invece di riprodurlo: molte volte più veloce' }, h('input', { type: 'checkbox', checked: st.fastAnalysis !== false, onchange: (e) => { st.fastAnalysis = e.target.checked; app.save(); } }), ' ⚡ Analisi veloce (decodifica diretta)'),
        h('label', { class: 'field inline', title: 'Solo per la lettura tradizionale (video riprodotto), usata se l\'analisi veloce non è disponibile' }, h('span', {}, 'Velocità di riserva'), h('select', { onchange: (e) => { st.analysisRate = +e.target.value; app.save(); } },
          [[1, 'Accurata (1×)'], [2, 'Normale (2×)'], [4, 'Veloce (4×)']].map(([v, l]) => h('option', { value: v, selected: (st.analysisRate || 2) === v }, l))))),
      running
        ? h('div', {}, h('div', { class: 'progress' }, h('div', { style: { width: `${Math.round(progress.frac * 100)}%` } })), h('div', { class: 'progress-label muted small' }, progress.msg),
          h('button', { class: 'btn danger', onclick: () => running.abort() }, 'Annulla'))
        : h('div', { class: 'row gap wrap' },
          h('button', { class: 'btn primary', disabled: !video.currentSrc || !g.floor || !app.videoInfo?.pixels, onclick: () => run(parseMin(fromInp.value) ?? 0, parseMin(toInp.value) ?? dur) }, '🤖 Avvia analisi'),
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
      proposal.official ? h('div', { class: 'official-box small' }, h('b', {}, '📋 Ufficiale: '), proposal.official.text,
        proposal.info.length ? h('div', { class: 'muted' }, 'Corretto con il punto a punto: ' + proposal.info.join(' · ')) : null) : null,
      !proposal.official && proposal.pn != null ? h('p', { class: 'muted small' }, `Punto: ${Math.round(Math.max(proposal.pn, 1 - proposal.pn) * 100)}% ${app.match.teams[(proposal.pn >= 0.5) === proposal.homeNear ? '*' : 'a'].name} secondo il modello (impara da ogni scambio confermato: ${winModel.n ? `${Math.round((100 * winModel.ok) / winModel.n)}% giusti su ${winModel.n}` : 'ancora nessuno'})`) : null,
      proposal.ocr ? h('ul', { class: 'notes ocr-results' }, proposal.ocr.map((r) => { const e = proposal.events.filter((x) => x.kind === 'skill')[r.k]; return h('li', {}, `${r.k + 1}. ${e ? e.skill : ''}: ${r.msg}`); })) : null,
      ta, descr,
      h('div', { class: 'row gap wrap' },
        h('button', { class: 'btn primary', disabled: ra.status === 'accepted', onclick: () => accept() }, '✓ Accetta (Invio)'),
        h('button', { class: 'btn', onclick: () => discard() }, 'Scarta'),
        h('button', { class: 'btn', onclick: () => { proposal = buildProposal(selIndex); render(); } }, '↺ Ripristina'),
        h('button', { class: 'btn', title: 'Riconosce chi tocca: galleria dei giocatori registrati (👕) + numeri di maglia', onclick: () => readNumbers() }, '👕 Riconosci giocatori'),
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
      h('ol', { class: 'clips' }, rs.flatMap((r, i) => [h('li', { class: `${i === selIndex ? 'playing' : ''} st-${r.status}`, onclick: () => select(i) },
        h('span', { class: 'mono' }, fmtTime(r.start)), ' ',
        r.touches.map((tc) => (tc.side === 'near' ? '●' : '○')).join(''),
        r.landing ? ' ✕' : ' ?', r.cutEnd ? ' ✂' : '', ' ',
        r.off && r.raw ? h('span', { class: 'small', title: 'Lettura del video confrontata con il punto a punto ufficiale' }, offMark(r)) : null, ' ',
        h('span', { class: 'muted' }, { todo: '', accepted: '✓', discarded: 'scartato' }[r.status])),
      ...(breakAfter(r) ? [breakRow(breakAfter(r))] : [])])));
  }

  // ✓ il video aveva letto giusto chi batte e chi vince; ✗ no (confronto con il punto a punto)
  function offMark(r) {
    const off = officialOf(app.match);
    const o = off?.rallies.filter((x) => x.set === r.off.set)[r.off.k];
    if (!o) return '';
    const okS = r.raw.serveTeam === teamOf(o.serveTeam), okW = r.raw.winner === teamOf(o.winner);
    return okS && okW ? '📋✓' : `📋✗${okS ? '' : ' battuta'}${okW ? '' : ' punto'}`;
  }
  function render() {
    if (!video.currentSrc && !videoBox.querySelector('.video-empty')) videoBox.append(h('div', { class: 'video-empty' }, h('p', {}, 'Carica il video della partita.'), h('div', { class: 'row gap wrap' }, h('button', { class: 'btn primary', onclick: () => app.openVideo() }, '📂 File dal PC'), h('button', { class: 'btn', onclick: () => app.openVideoLink() }, '🔗 Link video'))));
    if (video.currentSrc) videoBox.querySelector('.video-empty')?.remove();
    renderSetup();
    clear(offCard); offCard.append(officialCard(app, () => { proposal = null; render(); }));
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
