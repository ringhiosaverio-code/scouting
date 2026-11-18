// Test end-to-end dei video da link: node tests/e2e/link.mjs video.mp4
// Avvia l'app su :8093 e un "server esterno" su :8094 (con e senza CORS);
// YouTube è simulato con un finto IFrame API (window.YT) iniettato nella pagina.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
const { chromium } = createRequire(import.meta.url)('playwright');

const videoPath = process.argv[2];
const app = spawn(process.execPath, [new URL('../../tools/server.mjs', import.meta.url).pathname, '8093'], { stdio: 'ignore' });
const size = statSync(videoPath).size;
const ext = createServer((req, res) => {
  const cors = req.url.includes('cors=1') ? { 'Access-Control-Allow-Origin': '*' } : {};
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const buf = readFileSync(videoPath);
  if (m) {
    const a = +m[1], b = m[2] ? +m[2] : size - 1;
    res.writeHead(206, { ...cors, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 });
    res.end(buf.subarray(a, b + 1));
  } else { res.writeHead(200, { ...cors, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': size }); res.end(buf); }
}).listen(8094);
await new Promise((r) => setTimeout(r, 600));

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 880 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.addInitScript(() => {
  // finto lettore YouTube: tempo che scorre quando "suona"
  window.YT = { Player: class {
    constructor(el, o) {
      this.t = o.playerVars.start || 0; this.state = 5; this.o = o;
      const f = document.createElement('iframe'); f.className = 'fake-yt'; el.replaceWith(f);
      setTimeout(() => o.events.onReady({ target: this }), 50);
      this.iv = setInterval(() => { if (this.state === 1) this.t += 0.1 * (this.r || 1); }, 100);
    }
    getCurrentTime() { return this.t; } getDuration() { return 600; } getPlayerState() { return this.state; }
    seekTo(t) { this.t = t; } setPlaybackRate(r) { this.r = r; }
    playVideo() { this.state = 1; this.o.events.onStateChange({ data: 1 }); }
    pauseVideo() { this.state = 2; this.o.events.onStateChange({ data: 2 }); }
    destroy() { clearInterval(this.iv); }
  } };
});
await page.goto('http://localhost:8093/');
await page.waitForSelector('.tabs button');
const step = async (name, fn) => { try { await fn(); console.log('✓', name); } catch (e) { console.log('✗', name, e.message); errors.push(name + ': ' + e.message); } };
const openLink = async (u) => {
  await page.click('.transport button:has-text("🔗 Link")');
  await page.fill('.modal input[type=url]', u);
  await page.click('.modal .btn.primary');
};

await step('demo + scheda scout', async () => { await page.click('#btn-demo'); if (await page.$('.modal .btn.primary')) await page.click('.modal .btn.primary'); await page.click('.tabs button[data-tab=scout]'); });
await step('link diretto con CORS: streaming e fotogrammi leggibili', async () => {
  await openLink('http://127.0.0.1:8094/partita.mp4?cors=1');
  await page.waitForFunction(() => window.vsp.video.readyState > 0 && window.vsp.videoInfo.pixels === true, null, { timeout: 15000 });
  const ok = await page.evaluate(() => { const v = window.vsp.video, c = document.createElement('canvas'); c.width = 8; c.height = 8; const x = c.getContext('2d'); x.drawImage(v, 0, 0, 8, 8); try { x.getImageData(0, 0, 1, 1); return true; } catch { return false; } });
  if (!ok) throw new Error('canvas contaminato');
  const saved = await page.evaluate(() => window.vsp.match.video.url);
  if (!saved.includes('8094')) throw new Error('link non salvato: ' + saved);
});
await step('link diretto senza CORS: riproduce, analisi disattivata', async () => {
  await openLink('http://127.0.0.1:8094/partita.mp4');
  await page.waitForFunction(() => window.vsp.video.readyState > 0 && window.vsp.videoInfo.kind === 'direct', null, { timeout: 20000 });
  if (await page.evaluate(() => window.vsp.videoInfo.pixels)) throw new Error('pixels dovrebbe essere false');
  await page.click('.tabs button[data-tab=auto]');
  await page.waitForSelector('text=non consente la lettura dei fotogrammi');
  await page.click('.tabs button[data-tab=scout]');
});
await step('YouTube: lettore collegato, play/pausa/seek dall\'app', async () => {
  await openLink('https://youtu.be/UjNw6Gd5Zuc?t=30');
  await page.waitForFunction(() => window.vsp.video.readyState === 4 && window.vsp.video.currentSrc === 'youtube:UjNw6Gd5Zuc', null, { timeout: 5000 });
  if (!(await page.isVisible('.video-wrap .yt-holder iframe.fake-yt'))) throw new Error('iframe non visibile nel riquadro di scouting');
  const t0 = await page.evaluate(() => window.vsp.video.currentTime);
  if (Math.abs(t0 - 30) > 0.5) throw new Error('start ' + t0);
  await page.click('.transport button[title^="Play"]');
  await page.waitForTimeout(600);
  const t1 = await page.evaluate(() => window.vsp.video.currentTime);
  if (!(t1 > t0)) throw new Error('il tempo non scorre');
  if ((await page.textContent('.transport button[title^="Play"]')) !== '⏸') throw new Error('pulsante play non aggiornato');
  await page.click('.transport button[title^="Avanti 10"]');
  const t2 = await page.evaluate(() => window.vsp.video.currentTime);
  if (t2 < t1 + 9) throw new Error('seek non riuscito');
  await page.keyboard.press('Space');
  await page.screenshot({ path: process.argv[3] || 'link-yt.png' });
});
await step('YouTube: overlay dei clic sopra il lettore e calibrazione manuale', async () => {
  const top = await page.evaluate(() => { const r = document.querySelector('.video-wrap .overlay').getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2).closest('svg.overlay') != null; });
  if (!top) throw new Error('overlay non in cima');
  await page.click('.transport button:has-text("Calibra")');
  await page.waitForSelector('.banner select');
  await page.selectOption('.banner select', 'side');
  await page.waitForSelector('text=Fondo sinistro, angolo lontano');
});
await step('YouTube: analisi automatica rifiutata con spiegazione', async () => {
  await page.click('.tabs button[data-tab=auto]');
  await page.waitForSelector('text=Video YouTube');
  if (!(await page.isVisible('.yt-holder iframe'))) throw new Error('lettore non spostato nella scheda analisi');
});
await step('ricarica pagina: il link YouTube si ricollega da solo', async () => {
  await page.reload();
  await page.waitForFunction(() => window.vsp.video.currentSrc === 'youtube:UjNw6Gd5Zuc' && window.vsp.video.readyState === 4, null, { timeout: 5000 });
});
await step('ritorno al file locale: lettore YouTube chiuso', async () => {
  await page.evaluate(() => window.vsp.openVideoUrl('http://127.0.0.1:8094/partita.mp4?cors=1'));
  await page.waitForFunction(() => window.vsp.videoInfo.pixels && !document.querySelector('.yt-holder iframe'), null, { timeout: 15000 });
});
console.log(errors.length ? `${errors.length} errori:\n` + errors.join('\n') : 'tutto ok');
await browser.close(); app.kill(); ext.close();
process.exit(errors.length ? 1 : 0);
