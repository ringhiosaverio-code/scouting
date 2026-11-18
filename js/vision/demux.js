// Lettura dei contenitori video (MP4/MOV e WebM) per la decodifica veloce con WebCodecs:
// indice dei campioni (posizione, dimensione, tempo, fotogramma chiave) e configurazione
// del decodificatore. Il video non viene riprodotto: si leggono solo i byte necessari, a
// blocchi, da un File locale o da un URL (richieste Range).
//
// reader: { size, read(offset, length) → Promise<Uint8Array> }

const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const s32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
const str4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

export function fileReader(file) {
  return { size: file.size, read: async (o, n) => new Uint8Array(await file.slice(o, Math.min(file.size, o + n)).arrayBuffer()) };
}
export async function urlReader(url) {
  const head = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  if (head.status === 200) {
    // server senza richieste a tratti: si scarica tutto in memoria se non è enorme
    const len = +head.headers.get('Content-Length') || 0;
    if (len && len > 1.5e9) { head.body?.cancel(); throw new Error('il server non consente la lettura a tratti (Range)'); }
    return fileReader(await head.blob());
  }
  if (head.status !== 206) throw new Error(`video non leggibile (HTTP ${head.status})`);
  const size = +(head.headers.get('Content-Range') || '').split('/')[1];
  if (!size) throw new Error('dimensione del video sconosciuta');
  await head.arrayBuffer();
  return {
    size,
    async read(o, n) {
      const end = Math.min(size, o + n) - 1;
      const r = await fetch(url, { headers: { Range: `bytes=${o}-${end}` } });
      if (!r.ok) throw new Error(`lettura del video: HTTP ${r.status}`);
      const b = new Uint8Array(await r.arrayBuffer());
      // il service worker (MEGA) può restituire meno byte del richiesto: si completa
      if (b.length < end - o + 1 && b.length > 0) {
        const rest = await this.read(o + b.length, end - o + 1 - b.length);
        const all = new Uint8Array(b.length + rest.length); all.set(b); all.set(rest, b.length);
        return all;
      }
      return b;
    },
  };
}

export async function openContainer(reader) {
  const head = await reader.read(0, 64);
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return openWebM(reader);
  if (str4(head, 4) === 'ftyp' || ['moov', 'mdat', 'wide', 'free', 'skip'].includes(str4(head, 4))) return openMP4(reader);
  throw new Error('formato del video non riconosciuto (servono MP4/MOV o WebM)');
}

// ---------------------------------------------------------------- MP4 / MOV
function* boxes(b, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o), hdr = 8;
    const type = str4(b, o + 4);
    if (size === 1) { size = u64(b, o + 8); hdr = 16; } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) break;
    yield { type, start: o, data: o + hdr, end: o + size };
    o += size;
  }
}
const child = (b, box, type) => { for (const c of boxes(b, box.data, box.end)) if (c.type === type) return c; return null; };
const path = (b, box, ...types) => { let c = box; for (const t of types) { c = c && child(b, c, t); } return c; };

async function openMP4(reader) {
  // scansione dei box di primo livello per trovare 'moov' (può essere in fondo al file)
  let o = 0, moov = null;
  while (o + 8 <= reader.size) {
    const h = await reader.read(o, 16);
    let size = u32(h, 0);
    const type = str4(h, 4);
    if (size === 1) size = u64(h, 8); else if (size === 0) size = reader.size - o;
    if (size < 8) break;
    if (type === 'moov') { moov = await reader.read(o, size); break; }
    if (type === 'moof') throw new Error('MP4 frammentato: si usa la lettura tradizionale');
    o += size;
  }
  if (!moov) throw new Error('MP4 senza indice (moov)');
  const root = { data: 8, end: moov.length };
  let trak = null;
  for (const t of boxes(moov, root.data, root.end)) {
    if (t.type !== 'trak') continue;
    const hdlr = path(moov, t, 'mdia', 'hdlr');
    if (hdlr && str4(moov, hdlr.data + 8) === 'vide') { trak = t; break; }
  }
  if (!trak) throw new Error('nessuna traccia video nel file');
  const b = moov;
  const mdhd = path(b, trak, 'mdia', 'mdhd');
  const ts = b[mdhd.data] === 1 ? u32(b, mdhd.data + 20) : u32(b, mdhd.data + 12);
  const stbl = path(b, trak, 'mdia', 'minf', 'stbl');
  const stsd = child(b, stbl, 'stsd');
  const entry = boxes(b, stsd.data + 8, stsd.end).next().value;
  const fourcc = entry.type;
  const width = u16(b, entry.data + 24), height = u16(b, entry.data + 26);
  let codec = null, description = null;
  for (const c of boxes(b, entry.data + 78, entry.end)) {
    if (c.type === 'avcC') {
      description = b.slice(c.data, c.end);
      codec = `${fourcc === 'avc3' ? 'avc3' : 'avc1'}.${[1, 2, 3].map((k) => description[k].toString(16).padStart(2, '0')).join('')}`;
    } else if (c.type === 'hvcC') {
      description = b.slice(c.data, c.end);
      codec = hevcCodec(fourcc === 'hev1' ? 'hev1' : 'hvc1', description);
    } else if (c.type === 'vpcC') {
      const d = b.slice(c.data, c.end);
      codec = `vp09.${String(d[4]).padStart(2, '0')}.${String(d[5]).padStart(2, '0')}.${String(d[6] >> 4).padStart(2, '0')}`;
    } else if (c.type === 'av1C') {
      const d = b.slice(c.data, c.end);
      const prof = d[1] >> 5, lvl = d[1] & 31, tier = d[2] >> 7 ? 'H' : 'M', hb = (d[2] >> 6) & 1, tw = (d[2] >> 5) & 1;
      codec = `av01.${prof}.${String(lvl).padStart(2, '0')}${tier}.${hb ? (tw ? '12' : '10') : '08'}`;
      description = d;
    }
  }
  if (!codec) throw new Error(`codifica video non supportata (${fourcc})`);

  // tabelle dei campioni
  const stts = child(b, stbl, 'stts'), ctts = child(b, stbl, 'ctts'), stss = child(b, stbl, 'stss');
  const stsc = child(b, stbl, 'stsc'), stsz = child(b, stbl, 'stsz'), stco = child(b, stbl, 'stco') || child(b, stbl, 'co64');
  const is64 = stco.type === 'co64';
  const n = u32(b, stsz.data + 8), fixed = u32(b, stsz.data + 4);
  const size = new Uint32Array(n), off = new Float64Array(n), dts = new Float64Array(n), cts = new Float64Array(n), key = new Uint8Array(n);
  for (let i = 0; i < n; i++) size[i] = fixed || u32(b, stsz.data + 12 + i * 4);
  // tempi di decodifica
  { let i = 0, t = 0; const ne = u32(b, stts.data + 4); for (let e = 0; e < ne; e++) { const cnt = u32(b, stts.data + 8 + e * 8), d = u32(b, stts.data + 12 + e * 8); for (let k = 0; k < cnt && i < n; k++) { dts[i++] = t; t += d; } } }
  cts.set(dts);
  if (ctts) { let i = 0; const v1 = b[ctts.data] === 1, ne = u32(b, ctts.data + 4); for (let e = 0; e < ne; e++) { const cnt = u32(b, ctts.data + 8 + e * 8), d = v1 ? s32(b, ctts.data + 12 + e * 8) : u32(b, ctts.data + 12 + e * 8); for (let k = 0; k < cnt && i < n; k++, i++) cts[i] = dts[i] + d; } }
  if (stss) { const ne = u32(b, stss.data + 4); for (let e = 0; e < ne; e++) key[u32(b, stss.data + 8 + e * 4) - 1] = 1; } else key.fill(1);
  // posizioni nel file: blocchi (chunk) e campioni per blocco
  { const nc = u32(b, stco.data + 4), chunkOff = (c) => (is64 ? u64(b, stco.data + 8 + c * 8) : u32(b, stco.data + 8 + c * 4));
    const ne = u32(b, stsc.data + 4);
    let i = 0;
    for (let e = 0; e < ne; e++) {
      const first = u32(b, stsc.data + 8 + e * 12) - 1, per = u32(b, stsc.data + 12 + e * 12);
      const last = e + 1 < ne ? u32(b, stsc.data + 8 + (e + 1) * 12) - 1 : nc;
      for (let c = first; c < last && i < n; c++) { let p = chunkOff(c); for (let k = 0; k < per && i < n; k++) { off[i] = p; p += size[i]; i++; } }
    } }
  // lista di modifica (edts/elst): spostamento iniziale dei tempi di presentazione
  let shift = 0;
  const elst = path(b, trak, 'edts', 'elst');
  if (elst) {
    const v1 = b[elst.data] === 1, ne = u32(b, elst.data + 4);
    const mvhd = child(b, root, 'mvhd'), mts = b[mvhd.data] === 1 ? u32(b, mvhd.data + 20) : u32(b, mvhd.data + 12);
    let empty = 0;
    for (let e = 0; e < ne; e++) {
      const p = elst.data + 8 + e * (v1 ? 20 : 12);
      const dur = v1 ? u64(b, p) : u32(b, p), mt = v1 ? u64(b, p + 8) - (b[p + 8] & 0x80 ? 2 ** 64 : 0) : s32(b, p + 4);
      if (mt === -1 || mt === 4294967295) { empty += dur / mts; continue; }
      shift = mt / ts - empty;
      break;
    }
  }
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = cts[i] / ts - shift;
  const duration = n ? Math.max(...t.subarray(Math.max(0, n - 64))) + (n > 1 ? (dts[n - 1] - dts[n - 2]) / ts : 0) : 0;
  return { kind: 'mp4', codec, description, width, height, n, off, size, t, key, duration, fps: n > 1 ? n / duration : 30 };
}

function hevcCodec(type, d) {
  const space = d[1] >> 6, tier = (d[1] >> 5) & 1, prof = d[1] & 31;
  let compat = u32(d, 2), rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
  const cons = Array.from(d.slice(6, 12));
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  return `${type}.${['', 'A', 'B', 'C'][space]}${prof}.${(rev >>> 0).toString(16)}.${tier ? 'H' : 'L'}${d[12]}${cons.map((c) => '.' + c.toString(16).toUpperCase()).join('')}`;
}

// ---------------------------------------------------------------- WebM / Matroska
const ID = { EBML: 0x1a45dfa3, Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489, Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, ReferenceBlock: 0xfb, Cues: 0x1c53bb6b, Tags: 0x1254c367, SeekHead: 0x114d9b74, Chapters: 0x1043a770, Attachments: 0x1941a469 };
const TOP = new Set([ID.Cluster, ID.Cues, ID.Tags, ID.SeekHead, ID.Info, ID.Tracks, ID.Chapters, ID.Attachments]);
function vint(b, o, keepMarker) {
  const f = b[o];
  let len = 1, mask = 0x80;
  while (len <= 8 && !(f & mask)) { len++; mask >>= 1; }
  if (len > 8) return null;
  let v = keepMarker ? f : f & (mask - 1), allOnes = (f & (mask - 1)) === mask - 1;
  for (let k = 1; k < len; k++) { v = v * 256 + b[o + k]; if (b[o + k] !== 255) allOnes = false; }
  return { v, len, unknown: !keepMarker && allOnes };
}
const uint = (b, o, n) => { let v = 0; for (let k = 0; k < n; k++) v = v * 256 + b[o + k]; return v; };
const float = (b, o, n) => { const dv = new DataView(b.buffer, b.byteOffset + o, n); return n === 4 ? dv.getFloat32(0) : dv.getFloat64(0); };

async function openWebM(reader) {
  // intestazione: EBML + inizio del Segment, con Info e Tracks (di solito nei primi KB)
  let buf = await reader.read(0, Math.min(reader.size, 1 << 20));
  const el = (o) => { const id = vint(buf, o, true); const sz = vint(buf, o + id.len, false); return { id: id.v, size: sz.unknown ? null : sz.v, data: o + id.len + sz.len }; };
  let o = 0;
  const ebml = el(o); o = ebml.data + ebml.size;
  const seg = el(o);
  const segData = seg.data;
  let scale = 1e6, durTicks = null, track = null;
  o = segData;
  let firstCluster = null;
  while (o < buf.length - 12) {
    const e = el(o);
    if (e.id === ID.Cluster) { firstCluster = o; break; }
    if (e.size == null) break;
    if (e.data + e.size > buf.length && (e.id === ID.Info || e.id === ID.Tracks)) { buf = await reader.read(0, e.data + e.size + 64); }
    if (e.id === ID.Info) {
      for (let p = e.data; p < e.data + e.size;) { const c = el(p); if (c.id === ID.TimecodeScale) scale = uint(buf, c.data, c.size); if (c.id === ID.Duration) durTicks = float(buf, c.data, c.size); p = c.data + c.size; }
    } else if (e.id === ID.Tracks) {
      for (let p = e.data; p < e.data + e.size;) {
        const te = el(p);
        if (te.id === ID.TrackEntry) {
          const tr = {};
          for (let q = te.data; q < te.data + te.size;) {
            const c = el(q);
            if (c.id === ID.TrackNumber) tr.num = uint(buf, c.data, c.size);
            else if (c.id === ID.TrackType) tr.type = uint(buf, c.data, c.size);
            else if (c.id === ID.CodecID) tr.codecId = new TextDecoder().decode(buf.slice(c.data, c.data + c.size)).replace(/\0+$/, '');
            else if (c.id === ID.CodecPrivate) tr.priv = buf.slice(c.data, c.data + c.size);
            else if (c.id === ID.Video) { for (let r = c.data; r < c.data + c.size;) { const v = el(r); if (v.id === ID.PixelWidth) tr.width = uint(buf, v.data, v.size); if (v.id === ID.PixelHeight) tr.height = uint(buf, v.data, v.size); r = v.data + v.size; } }
            q = c.data + c.size;
          }
          if (tr.type === 1 && !track) track = tr;
        }
        p = te.data + te.size;
      }
    }
    o = e.data + e.size;
  }
  if (!track) throw new Error('nessuna traccia video nel WebM');
  const codec = { V_VP9: 'vp09.00.10.08', V_VP8: 'vp8', V_AV1: 'av01.0.04M.08' }[track.codecId] || (track.codecId === 'V_MPEG4/ISO/AVC' && track.priv ? `avc1.${[1, 2, 3].map((k) => track.priv[k].toString(16).padStart(2, '0')).join('')}` : null);
  if (!codec) throw new Error(`codifica video non supportata (${track.codecId})`);
  const description = track.codecId === 'V_MPEG4/ISO/AVC' ? track.priv : undefined;
  if (firstCluster == null) {
    // cerca il primo Cluster saltando gli elementi
    o = segData;
    for (;;) { const h = await reader.read(o, 16); const id = vint(h, 0, true), sz = vint(h, id.len, false); if (id.v === ID.Cluster) { firstCluster = o; break; } o += id.len + sz.len + sz.v; if (o >= reader.size) throw new Error('WebM senza dati video'); }
  }
  // indice dei blocchi: lettura sequenziale a grandi tratti (i blocchi stanno dentro i Cluster)
  const off = [], size = [], t = [], key = [];
  const CH = 8 << 20;
  let base = firstCluster, chunk = await reader.read(base, CH);
  const ensure = async (p, n) => { if (p - base + n > chunk.length && base + chunk.length < reader.size) { chunk = await reader.read(p, Math.max(CH, n)); base = p; } };
  let p = firstCluster, clusterTc = 0, clusterEnd = Infinity;
  while (p < reader.size - 2) {
    await ensure(p, 16);
    const q = p - base;
    const id = vint(chunk, q, true);
    if (!id) break;
    const sz = vint(chunk, q + id.len, false);
    const dataPos = p + id.len + sz.len;
    if (id.v === ID.Cluster) { clusterEnd = sz.unknown ? Infinity : dataPos + sz.v; p = dataPos; continue; }
    if (p >= clusterEnd && !TOP.has(id.v)) { clusterEnd = Infinity; }
    if (id.v === ID.Timecode) { await ensure(dataPos, sz.v); clusterTc = uint(chunk, dataPos - base, sz.v); p = dataPos + sz.v; continue; }
    if (id.v === ID.BlockGroup) { // entra nel gruppo: Block e ReferenceBlock
      await ensure(dataPos, Math.min(sz.v, 64));
      let isKey = true, blk = null;
      for (let r = dataPos; r < dataPos + sz.v;) {
        await ensure(r, 16);
        const cid = vint(chunk, r - base, true), csz = vint(chunk, r - base + cid.len, false);
        if (cid.v === ID.ReferenceBlock) isKey = false;
        if (cid.v === ID.Block) blk = { pos: r + cid.len + csz.len, size: csz.v };
        r += cid.len + csz.len + csz.v;
      }
      if (blk) await addBlock(blk.pos, blk.size, isKey);
      p = dataPos + sz.v; continue;
    }
    if (id.v === ID.SimpleBlock) { await addBlock(dataPos, sz.v, null); p = dataPos + sz.v; continue; }
    if (sz.unknown) { p = dataPos; continue; }
    p = dataPos + sz.v;
  }
  async function addBlock(pos, len, isKey) {
    await ensure(pos, 8);
    const q = pos - base;
    const tn = vint(chunk, q, false);
    if (tn.v !== track.num) return;
    const rel = (chunk[q + tn.len] << 8 | chunk[q + tn.len + 1]) << 16 >> 16;
    const flags = chunk[q + tn.len + 2];
    if (flags & 0x06) return; // lacing (raro nel video): non gestito
    const hdr = tn.len + 3;
    off.push(pos + hdr); size.push(len - hdr); t.push((clusterTc + rel) * scale / 1e9); key.push(isKey == null ? (flags & 0x80 ? 1 : 0) : isKey ? 1 : 0);
  }
  const n = t.length;
  const duration = durTicks ? durTicks * scale / 1e9 : n ? t[n - 1] : 0;
  return { kind: 'webm', codec, description, width: track.width, height: track.height, n, off: Float64Array.from(off), size: Uint32Array.from(size), t: Float64Array.from(t), key: Uint8Array.from(key), duration, fps: n > 1 ? n / duration : 30 };
}

// primo fotogramma chiave a o prima del tempo t (ordine di decodifica)
export function keyBefore(idx, t) {
  let best = 0;
  for (let i = 0; i < idx.n; i++) if (idx.key[i] && idx.t[i] <= t + 1e-6) best = i; else if (idx.key[i] && idx.t[i] > t) break;
  return best;
}
