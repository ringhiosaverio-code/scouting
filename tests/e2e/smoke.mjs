// Test end-to-end (Playwright): node tests/e2e/smoke.mjs [url] [video.mp4] [outdir]
// Richiede playwright e un server avviato (npm start).
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const url = process.argv[2] || 'http://localhost:8080/';
const videoPath = process.argv[3];
const out = process.argv[4] || '.';
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('dialog', (d) => d.accept());
await page.goto(url);
await page.waitForSelector('.tabs button');

const step = async (name, fn) => { try { await fn(); console.log('✓', name); } catch (e) { console.log('✗', name, e.message); errors.push(name + ': ' + e.message); } };
const panelText = () => page.textContent('.action-card');
const clickCourt = async (x, y) => {
  // coordinate campo -> punto sul campo grande (casa in basso)
  const box = await page.locator('.big-court').boundingBox();
  const k = Math.min(box.width / 4.6, box.height / 8.4);
  const ox = box.x + (box.width - 4.6 * k) / 2, oy = box.y + (box.height - 8.4 * k) / 2;
  await page.mouse.click(ox + (x + 0.3) * k, oy + (7 - y + 0.7) * k);
};

await step('nuova partita: rose incollate e formazioni', async () => {
  await page.click('#btn-new');
  if (await page.$('.modal')) await page.click('.modal .btn.primary');
  await page.waitForSelector('.team-card');
  for (const [k, txt] of [[0, '1;Rossi;Marco;S\n2 Bianchi Luca H\n3,Verdi,Ugo,M\n4;Neri;Ivo;O\n5;Blu;Eli;H\n6;Gialli;Leo;M\n7;Bruni;Max;L'], [1, '11 A B S\n12 C D H\n13 E F M\n14 G H O\n15 I J H\n16 K L M']]) {
    await page.locator('.team-card').nth(k).locator('button:has-text("Incolla rosa")').click();
    await page.fill('.modal textarea', txt);
    await page.click('.modal .btn.primary');
  }
  await page.click('text=Vai allo scouting');
  await page.waitForSelector('.lu-grid');
  const sels = page.locator('.modal .lu-grid select');
  const nums = ['4', '3', '2', '5', '6', '1', '14', '13', '12', '15', '16', '11'];
  for (let i = 0; i < 12; i++) await sels.nth(i).selectOption(nums[i]);
  await page.click('.modal .btn.primary');
  const cur = await page.evaluate(() => window.vsp.rp.current);
  if (cur.pos['*'].join() !== '1,2,3,4,5,6' || cur.setter['*'] !== 1 || cur.setter.a !== 11) throw new Error(JSON.stringify(cur.pos) + JSON.stringify(cur.setter));
});

await step('demo', async () => {
  await page.click('#btn-demo');
  if (await page.$('.modal')) await page.click('.modal .btn.primary');
  await page.waitForSelector('.big-court:not(.hidden)');
});

await step('rally 1: battuta, ricezione, alzata, attacco punto', async () => {
  await clickCourt(3, 0.2); // battuta casa da P1
  await clickCourt(2, 5.5); // arrivo
  if (!(await panelText()).includes('Battuta e ricezione')) throw new Error('pannello battuta non mostrato');
  await page.keyboard.press('2'); // ricezione + (positiva)
  await clickCourt(2.4, 3.8); // alzata ospiti
  await page.keyboard.press('Enter');
  await clickCourt(3.1, 3.8); // attacco da zona 4 ospiti (x alto = sinistra per chi sta in alto)
  await clickCourt(1.2, 1.2); // fine attacco in campo casa
  await page.keyboard.press('#');
  const score = await page.textContent('.scoreboard');
  if (!/0\s*1|01/.test(score.replace(/\s+/g, ' ')) && !score.includes('1')) throw new Error('punteggio non aggiornato: ' + score);
});

await step('rally 2: ospiti battono, errore', async () => {
  const t = await page.textContent('.step-title');
  if (!t.includes('Falchi')) throw new Error('dovrebbe battere Falchi: ' + t);
  await page.keyboard.press('Enter'); // battuta senza posizioni
  await page.keyboard.press('0'); // errore battuta
});

await step('rally 3: codici digitati', async () => {
  await page.click('#code-input');
  await page.keyboard.type('S- 6R# E 10X5/.7');
  await page.waitForTimeout(100);
  const pv = await page.textContent('.code-preview');
  if (!pv.includes('X5')) throw new Error('anteprima mancante: ' + pv);
  await page.keyboard.press('Enter');
});

await step('rally 4: attacco in gioco con difesa', async () => {
  await page.keyboard.press('Escape');
  await page.locator('.big-court').focus().catch(() => {});
  await clickCourt(1, -0.2);
  await clickCourt(1, 5.5);
  await page.keyboard.press('1'); // ricezione #
  await clickCourt(2.4, 3.7);
  await page.keyboard.press('Enter');
  await clickCourt(1.0, 3.8);
  await clickCourt(3.0, 1.0);
  await page.locator('.action-card button:has-text("Positiva")').first().click(); // difesa +
  const t = await page.textContent('.step-title');
  if (!t.includes('Aquile')) throw new Error('palla dovrebbe essere alla casa: ' + t);
  await clickCourt(2.4, 3.2);
  await page.keyboard.press('Enter');
  await clickCourt(1.0, 3.2);
  await page.keyboard.press('='); // errore attacco
});

const dump = await page.evaluate(() => window.vsp.rp.rows.map((r) => (r.e.kind === 'skill' ? r.e.team + r.e.num + r.e.skill + r.e.ev : r.e.kind + (r.e.team || ''))).join(' '));
console.log('righe:', dump);
const state = await page.evaluate(() => ({ score: window.vsp.rp.current.score, events: window.vsp.match.events.length, issues: window.vsp.issues }));
console.log('stato', JSON.stringify(state.score), 'eventi', state.events, 'problemi', state.issues.map((i) => i.msg).join(' | '));
await page.screenshot({ path: `${out}/scout.png` });

await step('annulla/ripeti', async () => {
  const n = await page.evaluate(() => window.vsp.match.events.length);
  await page.click('#btn-undo');
  const n2 = await page.evaluate(() => window.vsp.match.events.length);
  await page.click('#btn-redo');
  const n3 = await page.evaluate(() => window.vsp.match.events.length);
  if (!(n2 < n && n3 === n)) throw new Error(`${n} ${n2} ${n3}`);
});

await step('report', async () => {
  await page.click('.tabs button[data-tab="report"]');
  await page.waitForSelector('.tbl.players');
  await page.screenshot({ path: `${out}/report.png`, fullPage: false });
});

await step('esempio DVW + report', async () => {
  await page.click('#btn-open');
  await page.click('text=Partita di esempio');
  await page.waitForFunction(() => document.querySelector('.report h1')?.textContent.includes('3-0'), null, { timeout: 5000 });
  const h1 = await page.textContent('.report h1');
  if (!h1.includes('3-0')) throw new Error(h1);
  await page.screenshot({ path: `${out}/report-esempio.png`, fullPage: true });
});

await step('setup', async () => {
  await page.click('.tabs button[data-tab="setup"]');
  await page.waitForSelector('.team-card');
  await page.screenshot({ path: `${out}/setup.png` });
});

await step('playlist', async () => {
  await page.click('.tabs button[data-tab="playlist"]');
  await page.waitForSelector('.pl-filters h3');
  // il file di esempio non ha tempi video: nessuna clip ma l'elenco deve esserci
  await page.waitForSelector('.pl-list .muted');
});

if (videoPath) {
  await step('video + calibrazione', async () => {
    await page.click('.tabs button[data-tab="scout"]');
    await page.evaluate(() => window.vsp.setMatch(window.vsp.match));
    await page.click('#btn-demo');
    await page.click('.modal .btn.primary');
    await page.click('text=🎬 Clic su video');
    await page.evaluate(() => { window.showOpenFilePicker = undefined; });
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('.transport button:has-text("Video")')]);
    await fc.setFiles(videoPath);
    await page.waitForFunction(() => document.querySelector('#video').readyState > 0);
    await page.click('.transport button:has-text("Calibra")');
    const box = await page.locator('#tab-scout .video-wrap').boundingBox();
    const pts = [[0.2, 0.9], [0.8, 0.9], [0.65, 0.3], [0.35, 0.3]];
    for (const [x, y] of pts) await page.mouse.click(box.x + x * box.width, box.y + y * box.height);
    await page.click('.banner button:has-text("Fine")');
    const cal = await page.evaluate(() => Object.keys(window.vsp.match.calibration.points).length);
    if (cal !== 4) throw new Error('punti calibrazione: ' + cal);
    // un clic sul video produce coordinate campo
    await page.mouse.click(box.x + 0.75 * box.width, box.y + 0.95 * box.height);
    await page.mouse.click(box.x + 0.5 * box.width, box.y + 0.4 * box.height);
    await page.keyboard.press('2');
    const e = await page.evaluate(() => window.vsp.match.events.filter((x) => x.kind === 'skill').at(-2));
    if (!e.start || !e.end || e.vt == null) throw new Error('coordinate mancanti ' + JSON.stringify(e));
    console.log('   battuta', JSON.stringify(e.start), JSON.stringify(e.end), 'sz', e.sz, 'ez', e.ez);
    await page.screenshot({ path: `${out}/video.png` });
  });
}

console.log(errors.length ? `\nERRORI (${errors.length}):\n` + errors.join('\n') : '\nNessun errore');
await browser.close();
process.exit(errors.length ? 1 : 0);
