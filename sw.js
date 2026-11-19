// Service worker: rende l'app utilizzabile offline (es. palazzetti senza rete).
const CACHE = 'vsp-v6';
const FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg', 'samples/esempio.dvw', 'data/legavolley-2026-27.json', 'data/legavolley/index.json',
  'js/lib/codes.js', 'js/lib/constants.js', 'js/lib/court.js', 'js/lib/dvw.js', 'js/lib/engine.js', 'js/lib/legavolley.js', 'js/lib/mega.js',
  'js/lib/predict.js', 'js/lib/stats.js', 'js/lib/store.js', 'js/lib/validate.js', 'js/lib/videosrc.js', 'js/lib/winmodel.js', 'js/main.js',
  'js/ui/auto.js', 'js/ui/courtsvg.js', 'js/ui/dom.js', 'js/ui/livefeed.js', 'js/ui/official.js', 'js/ui/players.js', 'js/ui/playlist.js',
  'js/ui/report.js', 'js/ui/scout.js', 'js/ui/settings.js', 'js/ui/setup.js', 'js/ui/ytplayer.js', 'js/vision/analyzer.js', 'js/vision/autocourt.js',
  'js/vision/ballistic.js', 'js/vision/ballnet.js', 'js/vision/breaks.js', 'js/vision/camera.js', 'js/vision/cv.js', 'js/vision/demux.js',
  'js/vision/detector.js', 'js/vision/detworker.js', 'js/vision/digitnet.js', 'js/vision/digits.js', 'js/vision/fastworker.js',
  'js/vision/framepipe.js', 'js/vision/jersey.js', 'js/vision/playerid.js', 'js/vision/rally.js', 'js/vision/tracker.js', 'js/vision/worker.js',
];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// ---- video da MEGA: /mega-stream/nome?g=<download>&s=<byte>&k=<chiave>&n=<nonce>&t=<mime>
// il browser chiede un tratto (Range), qui si scarica solo quel tratto da MEGA e si
// decifra (AES-128-CTR, accesso casuale): streaming senza scaricare il file.
const MEGA_CHUNK = 4 << 20;
const hex = (s) => Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));
async function megaDecrypt(keyHex, nonceHex, offset, data) {
  const key = await crypto.subtle.importKey('raw', hex(keyHex), 'AES-CTR', false, ['decrypt']);
  const skip = offset % 16, ctr = new Uint8Array(16);
  ctr.set(hex(nonceHex));
  new DataView(ctr.buffer).setBigUint64(8, BigInt(Math.floor(offset / 16)));
  const buf = new Uint8Array(skip + data.length); buf.set(data, skip);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CTR', counter: ctr, length: 64 }, key, buf)).subarray(skip);
}
async function megaStream(req, u) {
  const q = u.searchParams, size = +q.get('s');
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  let a = m && m[1] ? +m[1] : 0;
  let b = m && m[2] ? +m[2] : size - 1;
  if (m && !m[1] && m[2]) { a = Math.max(0, size - +m[2]); b = size - 1; } // bytes=-N
  if (a >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  b = Math.min(b, size - 1, a + MEGA_CHUNK - 1);
  const up = await fetch(`${q.get('g')}/${a}-${b}`);
  if (!up.ok) return new Response('MEGA: ' + up.status, { status: 502 });
  const data = await megaDecrypt(q.get('k'), q.get('n'), a, new Uint8Array(await up.arrayBuffer()));
  return new Response(data, {
    status: 206,
    headers: { 'Content-Type': q.get('t') || 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${a}-${a + data.length - 1}/${size}`, 'Content-Length': String(data.length), 'Cache-Control': 'no-store' },
  });
}

// rete prima (per avere sempre l'ultima versione), cache come riserva
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const u = new URL(req.url);
  if (u.origin === location.origin && /\/mega-stream\//.test(u.pathname)) { e.respondWith(megaStream(req, u)); return; }
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.status === 200 && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then((r) => r || caches.match('index.html'))));
});
