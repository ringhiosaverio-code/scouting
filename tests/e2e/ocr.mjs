// Test della lettura dei numeri di maglia nel browser con caratteri reali (canvas).
// Le risorse di Tesseract.js vengono servite da node_modules locali (dir passata come argomento).
// node tests/e2e/ocr.mjs http://localhost:8080/ /percorso/node_modules
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
const [url = 'http://localhost:8080/', nm] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.route(/cdn\.jsdelivr\.net\/npm\/(.*)/, (route) => {
  const u = new URL(route.request().url());
  let p = u.pathname.replace(/^\/npm\//, '');
  // es. tesseract.js@5.1.1/dist/x.js, tesseract.js-core@v5.x/tesseract-core-simd.wasm.js, @tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz
  p = p.replace(/^(@?[^@/]+(?:\/[^@/]+)?)@[^/]+/, '$1');
  let f = join(nm, p);
  if (!existsSync(f)) f = f.replace('4.0.0_best_int', '4.0.0');
  if (!existsSync(f)) { console.log('mancante', p); return route.fulfill({ status: 404 }); }
  const type = f.endsWith('.js') ? 'text/javascript' : f.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
  route.fulfill({ status: 200, body: readFileSync(f), headers: { 'content-type': type, 'access-control-allow-origin': '*' } });
});
await page.goto(url);
await page.waitForSelector('.tabs button');
const res = await page.evaluate(async () => {
  const J = await import('./js/vision/jersey.js');
  const out = [];
  const nums = [1, 3, 4, 7, 8, 9, 10, 12, 14, 17, 21, 33];
  for (const n of nums) {
    for (const hgt of [9, 12, 18, 28]) {
      const W = Math.round(hgt * 3.2), H = Math.round(hgt * 2.2);
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.fillStyle = n % 2 ? '#c82828' : '#1e5adc'; ctx.fillRect(0, 0, W, H);
      ctx.filter = 'blur(0.7px)';
      ctx.fillStyle = '#f5f5f5'; ctx.font = `bold ${Math.round(hgt * 1.35)}px Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(n), W / 2, H / 2 + 1);
      ctx.filter = 'none';
      const id = ctx.getImageData(0, 0, W, H);
      for (let i = 0; i < id.data.length; i += 4) { const r = (Math.random() - 0.5) * 30; id.data[i] += r; id.data[i + 1] += r; id.data[i + 2] += r; }
      const p = J.prepareJersey(id.data, W, H, 4);
      if (!p) { out.push({ n, hgt, read: null }); continue; }
      const r = await J.readDigits(p);
      out.push({ n, hgt, read: r.text, conf: r.conf });
    }
  }
  return out;
});
const ok = res.filter((r) => r.read === String(r.n)).length;
for (const h of [9, 12, 18, 28]) {
  const sub = res.filter((r) => r.hgt === h);
  console.log(`cifre alte ~${h} px: ${sub.filter((r) => r.read === String(r.n)).length}/${sub.length} lette correttamente`, sub.filter((r) => r.read !== String(r.n)).map((r) => `${r.n}→${r.read ?? '∅'}`).join(' '));
}
console.log(`totale ${ok}/${res.length}`);
await browser.close();
