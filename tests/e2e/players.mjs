// Test end-to-end della registrazione dei giocatori e del riconoscimento nei tocchi.
// SIZE=1280x720 node tools/synth-video.mjs v.webm v.json
// node tests/e2e/players.mjs v.webm v.json [screenshot.png]
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { makeMatchClip, playerPos } from '../../tools/synth.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');

const [videoPath, metaPath, shot = 'players.png'] = process.argv.slice(2);
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
const clip = makeMatchClip({ W: 1280, H: 720 });
const trueBoxes = (t) => {
  let R = clip.rallies[0];
  for (const r of clip.rallies) if (t >= r.path.start - 2) R = r;
  return R.players.map((p) => { const pos = playerPos(p, t); const f = clip.cam.project([pos[0], pos[1], 0]), hd = clip.cam.project([pos[0], pos[1], 1.9]); return { num: p.number, team: p.side === 'near' ? '*' : 'a', cx: f.x, y1: f.y, top: hd.y }; });
};
const app = spawn(process.execPath, [new URL('../../tools/server.mjs', import.meta.url).pathname, '8099'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const step = async (name, fn) => { try { await fn(); console.log('✓', name); } catch (e) { console.log('✗', name, e.message); errors.push(name + ': ' + e.message); } };
await page.goto('http://localhost:8099/');
await page.waitForSelector('.tabs button');
await page.click('#btn-demo');
if (await page.$('.modal')) await page.click('.modal .btn.primary');
// formazioni coerenti con il video sintetico: palleggiatori #4 e #6, nessun libero
await page.evaluate(() => { const m = window.vsp.match; for (const t of ['*', 'a']) m.teams[t].players.forEach((p) => { if (p.role === 'L') p.role = 'H'; }); const L = m.events.find((e) => e.kind === 'lineup'); Object.assign(L, { hSetter: 4, vSetter: 6, hLib: [], vLib: [] }); window.vsp.setMatch(m); });
await page.evaluate((cal) => { window.vsp.match.calibration.points = cal; window.vsp.match.settings.clickSurface = 'video'; window.vsp.save(); }, meta.calibration);
await page.evaluate(() => { window.showOpenFilePicker = undefined; });
await page.click('.tabs button[data-tab="scout"]');
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('.transport button:has-text("Video")')]);
await fc.setFiles(videoPath);
await page.waitForFunction(() => document.querySelector('#video').readyState >= 2);

const T0 = 1.0;
let registered = 0;
await step('registrazione: sagome trovate e numeri assegnati con un clic', async () => {
  await page.evaluate(async (t) => { const v = window.vsp.video; v.currentTime = t; await new Promise((r) => v.addEventListener('seeked', r, { once: true })); }, T0);
  await page.click('.transport button:has-text("Giocatori")');
  await page.waitForFunction(() => window.vsp._pid && window.vsp._pid.items().length > 0, null, { timeout: 30000 });
  const items = await page.evaluate(() => window.vsp._pid.items().map((it) => ({ box: it.box, team: it.team })));
  const truth = trueBoxes(T0);
  console.log(`   ${items.length} sagome (giocatori veri: ${truth.length})`);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const cx = (it.box[0] + it.box[2]) / 2, y1 = it.box[3];
    const m = truth.filter((q) => Math.abs(q.cx - cx) < (it.box[2] - it.box[0]) / 2 + 4 && Math.abs(q.y1 - y1) < 20);
    if (m.length !== 1) continue; // sagoma non associabile con certezza a un giocatore: si salta
    const tb = m[0];
    await page.locator('.pid-box').nth(i).click({ position: { x: 3, y: 3 }, force: true });
    await page.waitForSelector('.pid-pop:not(.hidden)');
    if (tb.team !== it.team) await page.click('.pid-pop button:has-text("È di")');
    await page.click(`.pid-pop .pid-chip >> text=/^${tb.num}( L)?$/`);
    registered++;
  }
  await page.screenshot({ path: shot });
  if (registered < 6) throw new Error('registrati solo ' + registered);
  await page.click('.pid-bar button:has-text("Fine")');
  const n = await page.evaluate(() => Object.keys(window.vsp.match.teams['*'].gallery.samples).length + Object.keys(window.vsp.match.teams.a.gallery.samples).length);
  console.log(`   ${registered} registrati, ${n} giocatori in galleria`);
});
await step('secondo fotogramma: le proposte arrivano dalla galleria', async () => {
  await page.evaluate(async () => { const v = window.vsp.video; v.currentTime = 12; await new Promise((r) => v.addEventListener('seeked', r, { once: true })); });
  await page.click('.transport button:has-text("Giocatori")');
  await page.waitForFunction(() => window.vsp._pid.items().length > 0, null, { timeout: 30000 });
  const items = await page.evaluate(() => window.vsp._pid.items().map((it) => ({ box: it.box, guess: it.guess, team: it.team })));
  const truth = trueBoxes(12);
  let ok = 0, wrong = 0, none = 0;
  for (const it of items) {
    const cx = (it.box[0] + it.box[2]) / 2;
    const m = truth.filter((q) => Math.abs(q.cx - cx) < (it.box[2] - it.box[0]) / 2 + 4 && Math.abs(q.y1 - it.box[3]) < 20);
    if (m.length !== 1) continue;
    const tb = m[0];
    if (it.guess == null) none++; else if (it.guess === tb.num) ok++; else wrong++;
  }
  console.log(`   proposte giuste ${ok}, sbagliate ${wrong}, senza proposta ${none}`);
  if (wrong > 1 || ok < 2) throw new Error('riconoscimento insufficiente');
  await page.click('.pid-bar button:has-text("Fine")');
});
await step('analisi automatica: chi tocca riconosciuto, lo scout corregge, l\'app impara', async () => {
  await page.click('.tabs button[data-tab="auto"]');
  await page.click('text=Avvia analisi');
  await page.waitForFunction(() => document.querySelector('#tab-auto')?.textContent.includes('Scambi rilevati (') && !document.querySelector('#tab-auto .progress'), null, { timeout: 240000 });
  const all = meta.truth.flatMap((r) => r.touches);
  const truthFor = (t) => [...all].sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
  const nR = await page.evaluate(() => window.vsp.match.analysis.rallies.length);
  const perRally = [];
  for (let i = 0; i < Math.min(3, nR); i++) {
    await page.click(`.auto-list .clips li >> nth=${i}`);
    if (!(await page.$('text=Riconosci giocatori'))) continue; // nessuna proposta (es. fine set)
    await page.click('text=Riconosci giocatori');
    try { await page.waitForSelector('.ocr-results', { timeout: 60000 }); } catch { console.log('   scambio', i + 1, 'senza risultati'); continue; }
    const res = await page.evaluate(() => [...document.querySelectorAll('.ocr-results li')].map((l) => l.textContent));
    const tks = await page.evaluate(() => [...document.querySelectorAll('.ocr-results li')].map((l) => (l.dataset.tk === '' || l.dataset.tk == null ? null : +l.dataset.tk)));
    const tts = await page.evaluate((k) => window.vsp.match.analysis.rallies[k].touches.map((t) => t.t), i);
    let good = 0, bad = 0, numBad = 0;
    const fixes = [];
    res.forEach((l, k) => {
      const tr = truthFor(tts[tks[k] ?? k]);
      const m = l.match(/(riconosciuto|confermato|incerto:) #(\d+)/);
      if (m && Number(m[2]) === tr.player) good++; else { bad++; if (/numero riconosciuto/.test(l)) numBad++; console.log(`   ✗ scambio ${i + 1} tocco ${tr.skill} vero #${tr.player}: ${l}`); }
      fixes.push(tr.player);
    });
    perRally.push({ good, bad, numBad });
    console.log(`   scambio ${i + 1}: giusti ${good}, sbagliati ${bad}`);
    // lo scout corregge i numeri nel riquadro e accetta: l'app impara
    await page.evaluate((nums) => {
      const ta = document.querySelector('#tab-auto textarea');
      let k = 0;
      ta.value = ta.value.split(/\s+/).map((tk) => (/^[*a]\d\d[SREABDF]/.test(tk) && k < nums.length ? tk[0] + String(nums[k++]).padStart(2, '0') + tk.slice(3) : tk)).join(' ');
    }, fixes);
    await page.click('text=✓ Accetta');
    await page.waitForTimeout(300);
  }
  const first = perRally[0], later = perRally.slice(1);
  console.log('   errori: primo scambio', first.bad, '· scambi successivi', later.map((r) => r.bad).join(', '));
  // le proposte basate sul numero riconosciuto devono essere affidabili; quelle basate solo
  // sulla rotazione dipendono dalle formazioni (qui quelle della demo, diverse dal video sintetico)
  const nb = perRally.reduce((a, r) => a + r.numBad, 0);
  if (nb > 1) throw new Error(`${nb} errori con numero riconosciuto`);
});
console.log(errors.length ? `${errors.length} errori:\n` + errors.join('\n') : 'tutto ok');
await browser.close(); app.kill();
process.exit(errors.length ? 1 : 0);
