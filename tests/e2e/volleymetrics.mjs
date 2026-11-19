// Test end-to-end del video da VolleyMetrics/Hudl (domini finti, simulati nel browser di prova):
// pagina della partita con un video da link firmato → collegamento rapido → VolleyScout si apre
// con il video in streaming; link della pagina incollato → istruzioni; link scaduto → avviso.
// node tests/e2e/volleymetrics.mjs [screenshot.png]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { bookmarkletHref } from '../../js/lib/videosrc.js';
const { chromium } = createRequire(import.meta.url)('playwright');

const [shot = 'volleymetrics.png'] = process.argv.slice(2);
const PORT = 8097, APP = `http://localhost:${PORT}/`;
const srv = spawn(process.execPath, [new URL('../../tools/server.mjs', import.meta.url).pathname, String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const webm = readFileSync(new URL('../fixtures/mini.webm', import.meta.url));
const exp = Math.floor(Date.now() / 1000) + 3 * 3600;
const VIDEO = `https://cdn.vm-test.example/v/finale.webm?Expires=${exp}&Signature=abc&Key-Pair-Id=K1`;
const errors = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
// "VolleyMetrics" e la sua CDN, simulati
await ctx.route('https://app.vm-test.example/**', (r) => r.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Sir Susa Perugia vs Pallavolo Padova | Hudl</title><body><h1>Partita</h1><video id="v" muted autoplay src="${VIDEO}"></video></body>` }));
await ctx.route('https://cdn.vm-test.example/**', (r) => r.fulfill({ status: 200, contentType: 'video/webm', headers: { 'access-control-allow-origin': '*', 'accept-ranges': 'none' }, body: webm }));
const step = async (name, fn) => { try { await fn(); console.log('✓', name); } catch (e) { console.log('✗', name, e.message); errors.push(name + ': ' + e.message); } };

let app = null;
await step('collegamento rapido dalla pagina della partita', async () => {
  const vm = await ctx.newPage();
  await vm.goto('https://app.vm-test.example/match/123');
  await vm.waitForFunction(() => document.querySelector('#v').readyState >= 1);
  const code = decodeURIComponent(bookmarkletHref(APP)).slice('javascript:'.length);
  const [popup] = await Promise.all([ctx.waitForEvent('page'), vm.evaluate(code)]);
  app = popup;
  app.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await app.waitForFunction(() => window.vsp?.video?.readyState >= 1, null, { timeout: 20000 });
  const st = await app.evaluate(() => ({ url: window.vsp.match.video.url, name: window.vsp.match.video.name, exp: window.vsp.match.video.expires, h: window.vsp.match.teams['*'].name, a: window.vsp.match.teams.a.name, hash: location.hash }));
  console.log('   ', JSON.stringify(st).slice(0, 220));
  if (st.url !== VIDEO) throw new Error('video non collegato');
  if (st.h !== 'Sir Susa Perugia' || st.a !== 'Pallavolo Padova') throw new Error('squadre dal titolo: ' + st.h + ' / ' + st.a);
  if (!st.exp) throw new Error('scadenza non registrata');
  if (st.hash) throw new Error('indirizzo rimasto nella barra');
});

await step('di nuovo, con una partita già aperta: scelta "nella partita aperta"', async () => {
  await app.evaluate(() => { const m = window.vsp.match; m.events.push({ kind: 'point', id: 'x', team: '*' }); window.vsp.save(); });
  const id0 = await app.evaluate(() => window.vsp.match.id);
  await app.evaluate((u) => { location.hash = 'video=' + encodeURIComponent(u) + '&titolo=Altra&da=app.vm-test.example'; }, VIDEO);
  await app.waitForSelector('.modal >> text=Nella partita aperta');
  await app.click('.modal button:has-text("Nella partita aperta")');
  await app.waitForFunction(() => window.vsp.video.readyState >= 1);
  const id1 = await app.evaluate(() => window.vsp.match.id);
  if (id0 !== id1) throw new Error('ha creato una nuova partita');
});

await step('link della pagina VolleyMetrics incollato: istruzioni e collegamento rapido', async () => {
  await app.evaluate(() => window.vsp.openVideoUrl('https://app.volleymetrics.hudl.com/#/matches/987'));
  await app.waitForSelector('.modal >> text=Collegamento rapido');
  const href = await app.getAttribute('.modal a.bookmarklet', 'href');
  if (!href?.startsWith('javascript:')) throw new Error('pulsante del collegamento rapido mancante');
  await app.screenshot({ path: shot });
  await app.click('.modal .modal-close, .modal button:has-text("×")').catch(() => app.keyboard.press('Escape'));
});

await step('link scaduto: avviso, nessun caricamento', async () => {
  await app.keyboard.press('Escape');
  const ok = await app.evaluate(() => window.vsp.openVideoUrl('https://cdn.vm-test.example/v/finale.webm?Expires=1600000000&Signature=abc&Key-Pair-Id=K1', { quiet: true }));
  if (ok !== false) throw new Error('link scaduto accettato');
});

await browser.close();
srv.kill();
if (errors.length) { console.log('ERRORI:\n' + errors.join('\n')); process.exit(1); }
console.log('OK');
