// Service worker: rende l'app utilizzabile offline (es. palazzetti senza rete).
const CACHE = 'vsp-v4';
const FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg', 'samples/esempio.dvw',
  'js/main.js', 'js/lib/constants.js', 'js/lib/court.js', 'js/lib/codes.js', 'js/lib/engine.js', 'js/lib/predict.js',
  'js/lib/stats.js', 'js/lib/validate.js', 'js/lib/dvw.js', 'js/lib/store.js',
  'js/ui/dom.js', 'js/ui/courtsvg.js', 'js/ui/scout.js', 'js/ui/setup.js', 'js/ui/report.js', 'js/ui/playlist.js', 'js/ui/settings.js', 'js/ui/auto.js',
  'js/vision/cv.js', 'js/vision/autocourt.js', 'js/vision/camera.js', 'js/vision/jersey.js', 'js/vision/digits.js', 'js/vision/tracker.js', 'js/vision/ballistic.js', 'js/vision/rally.js', 'js/vision/analyzer.js', 'js/vision/worker.js',
];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// rete prima (per avere sempre l'ultima versione), cache come riserva
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then((r) => r || caches.match('index.html'))));
});
