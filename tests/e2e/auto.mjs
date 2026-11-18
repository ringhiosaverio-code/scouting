// Test end-to-end dell'analisi automatica su video sintetico.
// node tools/synth-video.mjs /tmp/synth.webm /tmp/synth.json
// node tests/e2e/auto.mjs http://localhost:8080/ /tmp/synth.webm /tmp/synth.json [outdir]
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const [url = 'http://localhost:8080/', videoPath, metaPath, out = '.'] = process.argv.slice(2);
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(url);
await page.waitForSelector('.tabs button');
await page.click('#btn-demo');
if (await page.$('.modal')) await page.click('.modal .btn.primary');
await page.evaluate((cal) => { window.vsp.match.calibration.points = cal; window.vsp.match.settings.clickSurface = 'video'; window.vsp.save(); }, meta.calibration);
await page.evaluate(() => { window.showOpenFilePicker = undefined; });
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('.transport button:has-text("Video")')]);
await fc.setFiles(videoPath);
await page.waitForFunction(() => document.querySelector('#video').readyState >= 1);
await page.click('.tabs button[data-tab="auto"]');
const t0 = Date.now();
await page.click('text=Avvia analisi');
await page.waitForFunction(() => document.querySelector('#tab-auto')?.textContent.includes('Scambi rilevati (') && !document.querySelector('#tab-auto .progress'), null, { timeout: 180000 });
console.log(`analisi in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const an = await page.evaluate(() => ({ mode: window.vsp.match.analysis.mode, frames: window.vsp.match.analysis.frames, rallies: window.vsp.match.analysis.rallies.map((r) => ({ start: r.start, n: r.touches.length, landing: !!r.landing })) }));
console.log('modalità', an.mode, 'fotogrammi', an.frames, 'scambi', JSON.stringify(an.rallies));
await page.screenshot({ path: `${out}/auto-review.png` });
await page.click('text=Accetta in serie');
await page.waitForTimeout(500);
const res = await page.evaluate(() => ({ score: window.vsp.rp.current.score, codes: window.vsp.rp.rows.filter((r) => r.e.kind === 'skill' || r.e.kind === 'point').map((r) => (r.e.kind === 'point' ? 'p' + r.e.team : r.e.team + r.e.skill + r.e.ev)) }));
console.log('codici accettati:', res.codes.join(' '));
console.log('punteggio', JSON.stringify(res.score));
const expScore = { '*': meta.truth.filter((r) => r.winner === '*').length, a: meta.truth.filter((r) => r.winner === 'a').length };
console.log('punteggio vero', JSON.stringify(expScore));
await page.screenshot({ path: `${out}/auto-after.png` });
if (an.rallies.length !== meta.truth.length) errors.push(`scambi rilevati ${an.rallies.length} invece di ${meta.truth.length}`);
console.log(errors.length ? 'ERRORI:\n' + errors.join('\n') : 'OK');
await browser.close();
process.exit(errors.length ? 1 : 0);
