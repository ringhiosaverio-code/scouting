// Server statico minimale (nessuna dipendenza): node tools/server.mjs [porta]
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const port = Number(process.argv[2] || process.env.PORT || 8080);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.dvw': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.onnx': 'application/octet-stream', '.wasm': 'application/wasm', '.mjs': 'text/javascript; charset=utf-8' };

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(root, p));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    const st = await stat(file);
    if (st.isDirectory()) { res.writeHead(302, { Location: p + '/' }).end(); return; }
    const type = types[extname(file)] || 'application/octet-stream';
    // richieste a tratti (Range): servono ai video (salto nel tempo, analisi veloce)
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const a = m[1] ? +m[1] : Math.max(0, st.size - +m[2]), b = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
      if (a >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end(); return; }
      res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1, 'Cache-Control': 'no-cache' });
      createReadStream(file, { start: a, end: b }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, () => console.log(`VolleyScout Pro: http://localhost:${port}`));
