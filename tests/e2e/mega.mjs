// Test end-to-end dei link MEGA: node tests/e2e/mega.mjs video.mp4
// Un finto MEGA locale (API /cs + storage con il file cifrato AES-CTR, tratti /a-b)
// e l'app su :8097 con service worker: il video deve suonare, saltare e i
// fotogrammi devono essere leggibili (analisi automatica possibile).
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes, createCipheriv } from 'node:crypto';
const { chromium } = createRequire(import.meta.url)('playwright');

const plain = readFileSync(process.argv[2]);
const k = randomBytes(32);
const key = Buffer.alloc(16); for (let i = 0; i < 16; i++) key[i] = k[i] ^ k[i + 16];
const enc = createCipheriv('aes-128-ctr', key, Buffer.concat([k.subarray(16, 24), Buffer.alloc(8)])).update(plain);
const b64 = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const txt = Buffer.from('MEGA{"n":"battute fano.mp4","c":"x"}');
const c = createCipheriv('aes-128-cbc', key, Buffer.alloc(16)); c.setAutoPadding(false);
const at = b64(Buffer.concat([c.update(Buffer.concat([txt, Buffer.alloc((16 - (txt.length % 16)) % 16)])), c.final()]));
let ranges = 0, expired = false, expireBefore = 0;
const mega = createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
  if (req.url.startsWith('/cs')) {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const [q] = JSON.parse(body);
      const r = q.p === 'AbCd_123' ? [{ s: enc.length, at, g: `http://127.0.0.1:8098/dl/${Date.now()}` }] : [-9];
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify(r));
    });
    return;
  }
  const m = /^\/dl\/(\d+)\/(\d+)-(\d+)$/.exec(req.url);
  if (m && +m[1] < expireBefore) { res.writeHead(403, cors).end(); return; }
  if (!m || expired) { res.writeHead(403, cors).end(); expired = false; return; }
  ranges++;
  res.writeHead(200, { ...cors, 'Content-Type': 'application/octet-stream' }).end(enc.subarray(+m[2], +m[3] + 1));
}).listen(8098);
const app = spawn(process.execPath, [new URL('../../tools/server.mjs', import.meta.url).pathname, '8097'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 880 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.addInitScript(() => { window.VSP_MEGA_API = 'http://127.0.0.1:8098/cs'; });
await page.goto('http://localhost:8097/');
await page.waitForSelector('.tabs button');
const step = async (name, fn) => { try { await fn(); console.log('✓', name); } catch (e) { console.log('✗', name, e.message); errors.push(name + ': ' + e.message); } };
const link = `https://mega.nz/file/AbCd_123#${b64(k)}`;

await step('link MEGA: streaming decifrato dal service worker', async () => {
  await page.click('.tabs button[data-tab=scout]');
  await page.click('.transport button:has-text("🔗 Link")');
  await page.fill('.modal input[type=url]', link);
  await page.click('.modal .btn.primary');
  await page.waitForFunction(() => window.vsp.videoInfo.kind === 'mega' && window.vsp.video.readyState >= 2, null, { timeout: 20000 });
  const name = await page.evaluate(() => window.vsp.match.video.name);
  if (name !== 'battute fano.mp4') throw new Error('nome ' + name);
  if (!(await page.evaluate(() => window.vsp.match.video.url)).includes('#')) throw new Error('link non salvato con la chiave');
});
await step('salto nel video e fotogrammi leggibili (analisi possibile)', async () => {
  const r = await page.evaluate(async () => {
    const v = window.vsp.video;
    v.currentTime = v.duration * 0.7;
    await new Promise((res) => v.addEventListener('seeked', res, { once: true }));
    const c = document.createElement('canvas'); c.width = 64; c.height = 36;
    const x = c.getContext('2d'); x.drawImage(v, 0, 0, 64, 36);
    const d = x.getImageData(0, 0, 64, 36).data; let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i];
    return { t: v.currentTime, mean: sum / (d.length / 4), dur: v.duration };
  });
  if (!(r.mean > 5)) throw new Error('fotogramma nero o illeggibile ' + JSON.stringify(r));
  console.log('   durata', r.dur.toFixed(1), 's, tratti scaricati finora', ranges);
});
await step('calibrazione automatica sul video MEGA', async () => {
  const r = await page.evaluate(async () => { const { autoCalibrateVideo } = await import('./js/vision/analyzer.js'); const o = await autoCalibrateVideo(window.vsp.video.currentSrc, { samples: 8 }); return { ok: o.ok, view: o.view }; });
  if (!r.ok) throw new Error(JSON.stringify(r));
  console.log('   vista', r.view);
});
await step('link scaduto: rinnovo automatico', async () => {
  const before = await page.evaluate(() => window.vsp.video.currentSrc);
  expireBefore = Date.now() + 1; // tutti gli indirizzi dati finora sono scaduti (403)
  await page.evaluate(() => { const v = window.vsp.video; v.src = v.currentSrc + '&nocache=1'; });
  await page.waitForFunction((b) => window.vsp.video.readyState >= 1 && window.vsp.video.currentSrc !== b, before, { timeout: 20000 });
});
await step('ricarica pagina: il link MEGA si ricollega', async () => {
  expired = true; // anche all'apertura: nuovo tentativo con un indirizzo fresco
  await page.reload();
  await page.waitForFunction(() => window.vsp.videoInfo?.kind === 'mega' && window.vsp.video.readyState >= 1, null, { timeout: 20000 });
});
await step('link MEGA inesistente: messaggio chiaro', async () => {
  await page.evaluate((l) => window.vsp.openVideoUrl(l), link.replace('AbCd_123', 'ZZZZ_999'));
  await page.waitForSelector('.toast:has-text("non trovato")', { timeout: 5000 });
});
console.log(errors.length ? `${errors.length} errori:\n` + errors.join('\n') : 'tutto ok');
await browser.close(); app.kill(); mega.close();
process.exit(errors.length ? 1 : 0);
