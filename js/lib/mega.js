// Link MEGA (mega.nz): i file sono cifrati lato client con AES-128-CTR e la chiave
// sta nel link dopo "#". Qui: lettura del link, richiesta dell'indirizzo di
// download all'API di MEGA, verifica della chiave (decifrando il nome del file).
// La decifratura del video avviene a pezzi nel service worker (sw.js, /mega-stream/),
// quindi il video si guarda in streaming senza scaricarlo.

const b64url = (s) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/').replace(/,/g, '');
  const bin = atob(t + '==='.slice((t.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
export const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

// https://mega.nz/file/HANDLE#KEY  ·  https://mega.nz/#!HANDLE!KEY  ·  mega.co.nz
export function parseMegaLink(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/(^|\.)mega(\.co)?\.nz$/.test(u.hostname)) return null;
  let handle, key;
  const m1 = u.pathname.match(/^\/file\/([\w-]{8})$/);
  if (m1) { handle = m1[1]; key = u.hash.slice(1).split('/')[0]; }
  const m2 = u.hash.match(/^#!([\w-]{8})!([\w,-]+)/);
  if (m2) { handle = m2[1]; key = m2[2]; }
  if (/^\/folder\//.test(u.pathname) || /^#F!/.test(u.hash)) return { error: 'Link di una cartella MEGA: apri il video nella cartella e usa "Condividi → Copia link" del singolo file' };
  if (!handle) return { error: 'Link MEGA non riconosciuto' };
  if (!key) return { error: 'Al link MEGA manca la chiave (la parte dopo #): copia il link completo' };
  let k;
  try { k = b64url(key); } catch { return { error: 'Chiave del link MEGA non valida' }; }
  if (k.length !== 32) return { error: 'Chiave del link MEGA non valida (lunghezza)' };
  const aes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) aes[i] = k[i] ^ k[i + 16];
  return { handle, key: aes, nonce: k.slice(16, 24) };
}

// AES-CBC senza padding con WebCrypto (che impone PKCS#7): si accoda un blocco
// costruito apposta perché la decifratura termini con un padding valido.
async function cbcDecryptNoPad(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt', 'decrypt']);
  const last = data.slice(data.length - 16);
  const pad = new Uint8Array(16).fill(16);
  const extra = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: last }, key, pad)).slice(0, 16);
  const all = new Uint8Array(data.length + 16); all.set(data); all.set(extra, data.length);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, all));
}

export async function decryptMegaAttributes(keyBytes, at) {
  const plain = await cbcDecryptNoPad(keyBytes, b64url(at));
  const txt = new TextDecoder().decode(plain).replace(/\0+$/, '');
  if (!txt.startsWith('MEGA{')) return null;
  try { return JSON.parse(txt.slice(4)); } catch { return null; }
}

const MEGA_ERRORS = { [-2]: 'richiesta non valida', [-9]: 'file non trovato o rimosso', [-11]: 'accesso negato', [-16]: 'file bloccato da MEGA', [-17]: 'limite di traffico superato', [-18]: 'MEGA temporaneamente non disponibile, riprova' };
export const MEGA_API = 'https://g.api.mega.co.nz/cs';

// → { url (download temporaneo, scade dopo alcune ore), size, name, key, nonce }
export async function resolveMega(link, { api = MEGA_API } = {}) {
  const p = parseMegaLink(link);
  if (!p) throw new Error('Non è un link MEGA');
  if (p.error) throw new Error(p.error);
  let res;
  try {
    res = await fetch(`${api}?id=${Math.floor(Math.random() * 1e9)}`, { method: 'POST', body: JSON.stringify([{ a: 'g', g: 1, ssl: 2, p: p.handle }]) });
  } catch { throw new Error('MEGA non raggiungibile (connessione assente o bloccata)'); }
  const j = await res.json();
  const r = Array.isArray(j) ? j[0] : j;
  if (typeof r === 'number') throw new Error('MEGA: ' + (MEGA_ERRORS[r] || `errore ${r}`));
  if (!r?.g) throw new Error('MEGA non ha fornito il file (limite di traffico o file non disponibile)');
  const attrs = r.at ? await decryptMegaAttributes(p.key, r.at) : null;
  if (r.at && !attrs) throw new Error('Chiave del link MEGA errata');
  return { url: r.g, size: r.s, name: attrs?.n || 'video MEGA', key: p.key, nonce: p.nonce };
}

// indirizzo locale servito dal service worker, che scarica e decifra a pezzi
export function megaStreamUrl(r, base = '') {
  const q = new URLSearchParams({ g: r.url, s: String(r.size), k: toHex(r.key), n: toHex(r.nonce), t: mimeFor(r.name) });
  return `${base}mega-stream/${encodeURIComponent(r.name.replace(/[/?#]/g, '_'))}?${q}`;
}
const mimeFor = (n) => ({ mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/webm', ogv: 'video/ogg' })[(n.split('.').pop() || '').toLowerCase()] || 'video/mp4';

// decifra un tratto di file (AES-CTR: accesso casuale, il contatore è l'indice del blocco da 16 byte)
export async function megaDecryptRange(keyHex, nonceHex, offset, data) {
  const hex = (s) => Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));
  const key = await crypto.subtle.importKey('raw', hex(keyHex), 'AES-CTR', false, ['decrypt']);
  const block = Math.floor(offset / 16), skip = offset % 16;
  const ctr = new Uint8Array(16); ctr.set(hex(nonceHex));
  new DataView(ctr.buffer).setBigUint64(8, BigInt(block));
  const buf = new Uint8Array(skip + data.length); buf.set(data, skip);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CTR', counter: ctr, length: 64 }, key, buf)).slice(skip);
}
