// Test end-to-end dei dati ufficiali Legavolley: caricamento dall'archivio, formazioni dal
// tabellino, proposta corretta con il punto a punto, verifica dopo l'accettazione.
// node tests/e2e/official.mjs [screenshot.png]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const { chromium } = createRequire(import.meta.url)('playwright');

const [shot = 'official.png'] = process.argv.slice(2);
const srv = spawn(process.execPath, [new URL('../../tools/server.mjs', import.meta.url).pathname, '8098'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const step = async (name, fn) => { try { await fn(); console.log('✓', name); } catch (e) { console.log('✗', name, e.message); errors.push(name + ': ' + e.message); } };

await page.goto('http://localhost:8098/');
await page.waitForSelector('.tabs button');
await page.click('#btn-demo');
if (await page.$('.modal')) await page.click('.modal .btn.primary');
// rose ufficiali di Perugia e Padova, nessun evento
await page.evaluate(async () => {
  const L = await (await fetch('data/legavolley-2026-27.json')).json();
  const m = window.vsp.match;
  for (const [t, q] of [['*', 'Perugia'], ['a', 'Padova']]) {
    const sq = L.squadre.find((s) => s.nome.includes(q));
    Object.assign(m.teams[t], { name: sq.nome, players: sq.giocatori.map((g, i) => ({ id: 'p' + t + i, number: g.number, lastName: g.lastName, firstName: g.firstName, role: g.role })) });
  }
  m.events = [];
  window.vsp.setMatch(m);
});
await page.click('.tabs button[data-tab="auto"]');

await step('archivio: la partita delle due squadre è proposta e si carica', async () => {
  await page.click('button:has-text("Carica dati ufficiali")');
  await page.waitForSelector('.modal .lega-team');
  const first = await page.textContent('.modal .lega-team');
  if (!/Perugia/.test(first) || !/Padova/.test(first)) throw new Error('prima proposta: ' + first);
  await page.click('.modal .lega-team');
  await page.waitForSelector('.official-card >> text=Inverti squadre');
  const ok = await page.evaluate(() => window.vsp.match.official?.id === 40345 && window.vsp.match.official.homeIs === 0);
  if (!ok) throw new Error('dati non caricati');
});

await step('formazioni del 1° set dal tabellino', async () => {
  await page.evaluate(() => window.vsp.openLineup());
  await page.waitForSelector('.modal >> text=dal tabellino ufficiale');
  const vals = await page.$$eval('.modal .lineup-card select[aria-label^="P"]', (s) => s.map((x) => x.value));
  if (vals.filter(Boolean).length !== 12) throw new Error('formazioni incomplete: ' + vals.join(','));
  await page.click('.modal .btn.primary');
  const L = await page.evaluate(() => window.vsp.match.events.find((e) => e.kind === 'lineup'));
  console.log('   casa', L.h.join(' '), '· ospiti', L.v.join(' '), '· batte', L.serve);
  if (L.serve !== '*') throw new Error('al servizio: ' + L.serve);
});

// primo scambio ufficiale: batte #7 (casa), attacco #11 ospiti, attacco punto #7 casa.
// Il "video" ha visto tutti i tocchi ma la palla dell'ultimo attacco cade fuori dal campo.
await page.evaluate(() => {
  const tc = (t, side, X, extra = {}) => ({ t, side, X, conf: 0.8, ...extra });
  const touches = [tc(10, 'near', [6, -0.5, 2.8], { speedOut: 20 }), tc(11.2, 'far', [4, 14, 0.8]), tc(12.6, 'far', [5.5, 10, 2.6]), tc(13.6, 'far', [2, 9.8, 3.1], { speedOut: 15 }),
    tc(14.2, 'near', [4, 3, 0.8]), tc(15.6, 'near', [5.5, 8, 2.6]), tc(16.5, 'near', [7.5, 8.2, 3.1], { speedOut: 16 })];
  const m = window.vsp.match;
  m.analysis = { version: 1, W: 1280, H: 720, frames: 0, mode: '3d', rallies: [{ id: 'r1', start: 9.5, end: 17.5, touches, landing: { X: [9.8, 16, 0], t: 17 }, path: [], mode: '3d', status: 'todo' }], breaks: [] };
  window.vsp.save();
});
await page.click('.tabs button[data-tab="scout"]');
await page.click('.tabs button[data-tab="auto"]');
await step('proposta corretta con il punto a punto', async () => {
  await page.click('.auto-list .clips li');
  await page.waitForSelector('.official-box');
  const txt = await page.inputValue('textarea[data-rally="r1"]');
  console.log('   codici:', txt);
  const box = await page.textContent('.official-box');
  console.log('   ', box);
  if (!/\*07S/.test(txt)) throw new Error('battitore non ufficiale');
  if (!/a11A/.test(txt)) throw new Error('attaccante ospite non ufficiale');
  if (!/\*07A.#/.test(txt)) throw new Error('attacco punto non corretto');
  if (!/\*p\b/.test(txt)) throw new Error('punto non alla casa');
});
await step('accettazione: punteggio e verifica del video', async () => {
  await page.click('button:has-text("Accetta (Invio)")');
  await page.waitForFunction(() => window.vsp.rp.current?.score['*'] === 1);
  await page.waitForSelector('.official-card >> text=Verifica del video su 1');
  const rows = await page.$$eval('.official-card .mini-table tr', (t) => t.map((r) => r.textContent));
  console.log('   ', rows.join(' | '));
  const r = await page.evaluate(() => window.vsp.match.analysis.rallies[0]);
  if (!r.raw || r.off?.k !== 0) throw new Error('lettura del video non conservata');
});
await page.screenshot({ path: shot, fullPage: false });
await browser.close();
srv.kill();
if (errors.length) { console.log('ERRORI:\n' + errors.join('\n')); process.exit(1); }
console.log('OK');
