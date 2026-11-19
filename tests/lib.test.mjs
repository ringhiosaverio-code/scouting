import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { xy2index, index2xy, xy2zone, xy2subzone, computeHomography, applyH, buildCalibration, zoneForTeam } from '../js/lib/court.js';
import { interpretTyped, parseSkillCode, skillCode, rallyWinner } from '../js/lib/codes.js';
import { newMatch, newPlayer, replay } from '../js/lib/engine.js';
import { fromDVW, toDVW, decodeBytes } from '../js/lib/dvw.js';
import { computeStats } from '../js/lib/stats.js';
import { validate } from '../js/lib/validate.js';
import { rankPlayers, buildLearner } from '../js/lib/predict.js';

const fixture = decodeBytes(readFileSync(new URL('../samples/esempio.dvw', import.meta.url)));

test('griglia DataVolley: index <-> xy', () => {
  for (const idx of [101, 4912, 4976, 3949, 6458, 1234]) {
    const p = index2xy(idx);
    assert.equal(xy2index(p.x, p.y), idx);
  }
});

test('zone e sottozone come datavolley', () => {
  assert.equal(xy2zone(1, 1), 5);
  assert.equal(xy2zone(3, 1), 1);
  assert.equal(xy2zone(1, 3), 4);
  assert.equal(xy2zone(2, 2), 8);
  assert.equal(xy2zone(1, 4), 2); // metà in alto: vicino rete, x=1 -> zona 2
  assert.equal(xy2zone(1, 6), 1);
  assert.equal(xy2subzone(0.6, 0.6), 'D');
  assert.equal(xy2subzone(1.4, 0.6), 'A');
  assert.equal(xy2subzone(0.6, 1.4), 'C');
  assert.equal(xy2subzone(0.6, 3.6), 'B');
  assert.equal(zoneForTeam({ x: 1, y: 3.7 }, '*'), 4);
});

test('omografia: 4 e 10 punti', () => {
  const H0 = [1.2, 0.3, 0.1, -0.1, 0.9, 0.2, 0.05, 0.1, 1];
  const court = [[0.5, 0.5], [3.5, 0.5], [3.5, 6.5], [0.5, 6.5], [0.5, 2.5], [3.5, 2.5]].map(([x, y]) => ({ x, y }));
  const img = court.map((p) => applyH(H0, p));
  const H = computeHomography(img, court);
  for (let i = 0; i < court.length; i++) {
    const q = applyH(H, img[i]);
    assert.ok(Math.abs(q.x - court[i].x) < 1e-6 && Math.abs(q.y - court[i].y) < 1e-6);
  }
  const cal = buildCalibration({ nl: img[0], nr: img[1], fr: img[2], fl: img[3] });
  assert.ok(cal.error < 1e-6);
});

test('codice skill: parse <-> build', () => {
  for (const c of ['a13AH+VV~76~H', '*06SM#~~~18C', 'a06RM=~~~18CW4', 'a10EH#KEF', 'a13AT=X5~47DH2S', '*15BH=~~~~4~~2O']) {
    assert.equal(skillCode(parseSkillCode(c)), c);
  }
});

test('interprete codici digitati', () => {
  const ctx = { serving: '*', p1: { '*': 7, a: 3 }, setter: { '*': 1, a: 10 } };
  let r = interpretTyped('7SQ-.12', ctx);
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].skill, 'S');
  assert.equal(r.events[0].type, 'Q');
  assert.equal(r.events[1].team, 'a');
  assert.equal(r.events[1].skill, 'R');
  assert.equal(r.events[1].ev, '#');
  assert.equal(r.events[1].type, 'Q');
  // squadra inferita dal contesto: dopo la ricezione di 'a', alzata e attacco sono di 'a'
  r = interpretTyped('S+ a5R- E 9X5#', ctx);
  assert.deepEqual(r.events.map((e) => e.team + e.skill + e.ev), ['*S+', 'aR-', 'aE+', 'aA#']);
  assert.equal(r.events[0].num, 7);
  assert.equal(r.events[2].num, 10);
  assert.equal(r.events[3].combo, 'X5');
  assert.equal(r.events[3].sz, 4);
  assert.equal(r.events[3].type, 'T');
  r = interpretTyped('a9X57#', ctx);
  assert.equal(r.events[0].ez, 7);
  r = interpretTyped('*12A-~37 a4D#', ctx);
  assert.equal(r.events[0].sz, 3);
  assert.equal(r.events[0].ez, 7);
  assert.equal(r.events[1].sz, 3);
  r = interpretTyped('*c5:12 aT *p', ctx);
  assert.deepEqual(r.events.map((e) => e.kind), ['sub', 'timeout', 'point']);
  assert.equal(rallyWinner({ kind: 'skill', team: 'a', skill: 'A', ev: '/' }), '*');
});

function demoMatch() {
  const m = newMatch();
  m.teams['*'].players = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => newPlayer({ number: n, lastName: 'H' + n, role: n === 1 ? 'S' : n === 8 ? 'L' : n % 3 === 0 ? 'M' : 'H' }));
  m.teams.a.players = [11, 12, 13, 14, 15, 16, 17].map((n) => newPlayer({ number: n, lastName: 'V' + n, role: n === 11 ? 'S' : 'H' }));
  m.events.push({ kind: 'lineup', set: 1, h: [1, 2, 3, 4, 5, 6], v: [11, 12, 13, 14, 15, 16], hSetter: 1, vSetter: 11, serve: '*', homeNear: true });
  return m;
}

test('motore: punteggio, rotazione, cambio palla', () => {
  const m = demoMatch();
  m.events.push({ kind: 'skill', team: '*', num: 1, skill: 'S', ev: '=' }, { kind: 'point', team: 'a' });
  let rp = replay(m);
  assert.deepEqual(rp.current.score, { '*': 0, a: 1 });
  assert.equal(rp.current.serving, 'a');
  assert.deepEqual(rp.current.pos.a, [12, 13, 14, 15, 16, 11]);
  assert.equal(rp.current.setterPos.a, 6);
  // break point: niente rotazione
  m.events.push({ kind: 'skill', team: 'a', num: 12, skill: 'S', ev: '#' }, { kind: 'point', team: 'a' });
  rp = replay(m);
  assert.deepEqual(rp.current.pos.a, [12, 13, 14, 15, 16, 11]);
  assert.equal(rp.rows.at(-2).phase, 'p');
  // cambio
  m.events.push({ kind: 'sub', team: '*', out: 4, in: 7 });
  rp = replay(m);
  assert.ok(rp.current.pos['*'].includes(7));
  // fine set
  for (let i = 0; i < 23; i++) m.events.push({ kind: 'point', team: 'a' });
  rp = replay(m);
  assert.equal(rp.current.pendingEnd, true);
  m.events.push({ kind: 'endset' });
  rp = replay(m);
  assert.equal(rp.setsWon.a, 1);
});

test('import DVW di esempio: punteggi finali dei set', () => {
  const m = fromDVW(fixture);
  assert.equal(m.teams['*'].players.length, 14);
  const rp = replay(m);
  const finals = rp.sets.map((s) => `${s.score['*']}-${s.score.a}`);
  assert.deepEqual(finals, ['25-16', '25-14', '25-22']);
  assert.equal(rp.setsWon['*'], 3);
  // posizioni in campo ricostruite coerenti con il file
  const lines = fixture.split(/\r?\n/);
  const scout = lines.slice(lines.findIndex((l) => l.startsWith('[3SCOUT]')) + 1).filter((l) => /^[*a]\d\d[SREABDF]/.test(l));
  const skillRows = rp.rows.filter((r) => r.e.kind === 'skill');
  assert.equal(skillRows.length, scout.length);
  let mismatches = 0;
  scout.forEach((l, k) => {
    const c = l.split(';');
    const exp = c.slice(14, 20).map(Number).join(',');
    if (skillRows[k].pos['*'].join(',') !== exp) mismatches++;
  });
  assert.equal(mismatches, 0);
  const st = computeStats(m, rp);
  assert.ok(st.team['*'].A.n > 50);
  const issues = validate(m, rp);
  assert.ok(Array.isArray(issues));
});

test('export DVW -> import: roundtrip', () => {
  const m = fromDVW(fixture);
  const out = toDVW(m);
  assert.match(out, /\[3SCOUT\]/);
  const m2 = fromDVW(out);
  const a = replay(m), b = replay(m2);
  assert.deepEqual(b.sets.map((s) => s.score), a.sets.map((s) => s.score));
  const ca = a.rows.filter((r) => r.e.kind === 'skill').map((r) => skillCode(r.e));
  const cb = b.rows.filter((r) => r.e.kind === 'skill').map((r) => skillCode(r.e));
  assert.deepEqual(cb, ca);
  // le righe skill esportate hanno fasi e posizioni
  const orig = fixture.split(/\r?\n/).filter((l) => /^[*a]\d\d[SREABDF]/.test(l));
  const exp = out.split(/\r?\n/).filter((l) => /^[*a]\d\d[SREABDF]/.test(l));
  let same = 0;
  orig.forEach((l, k) => { const x = l.split(';'), y = exp[k].split(';'); if (x[1] === y[1] && x[2] === y[2]) same++; });
  assert.ok(same / orig.length > 0.97, `fasi coerenti: ${same}/${orig.length}`);
});

test('predizione: battitore in P1, palleggiatore, apprendimento', () => {
  const m = demoMatch();
  const rp = replay(m);
  const L = buildLearner(rp.rows);
  assert.equal(rankPlayers(m, rp.current, L, '*', 'S', 1)[0].num, 1);
  assert.equal(rankPlayers(m, rp.current, L, '*', 'E', 3)[0].num, 1);
  const rec = rankPlayers(m, rp.current, L, '*', 'R', 6);
  assert.equal(rec[0].num, 8); // libero al centro
});

test('valutazione ricezione dalle zone (posizione dell\'alzata)', async () => {
  const { receptionEvalAt, receptionEvalFromDV } = await import('../js/lib/court.js');
  // squadra in basso (Y < 9): rete a Y = 9, sinistra a X = 0
  assert.equal(receptionEvalAt(5.5, 8.5, true), '#');      // 0,5 m dalla rete, poco a destra del centro
  assert.equal(receptionEvalAt(5.5, 8.5, true, 1.5), '+'); // palla bassa: un livello in meno
  assert.equal(receptionEvalAt(3.0, 7.5, true), '+');      // 1,5 m dalla rete, più a sinistra
  assert.equal(receptionEvalAt(6.0, 6.2, true), '!');      // 2,8 m dalla rete
  assert.equal(receptionEvalAt(6.0, 4.0, true), '-');      // 5 m dalla rete
  assert.equal(receptionEvalAt(1.0, 8.5, true), '-');      // vicino a rete ma troppo a sinistra
  assert.equal(receptionEvalAt(5.5, 10, true), '/');       // palla passata nell'altro campo
  // squadra in alto: specchiato (la sua sinistra è X = 9)
  assert.equal(receptionEvalAt(3.5, 9.5, false), '#');
  assert.equal(receptionEvalAt(8.0, 9.5, false), '-');
  // coordinate DataVolley canoniche: casa in basso
  assert.equal(receptionEvalFromDV({ x: 0.5 + 5.5 / 3, y: 0.5 + 8.5 / 3 }, '*'), '#');
});

test('link video esterni: YouTube, Drive, Dropbox, HLS, diretti', async () => {
  const { classifyVideoUrl } = await import('../js/lib/videosrc.js');
  let c = classifyVideoUrl('https://youtu.be/UjNw6Gd5Zuc?is=Th_Xs2E6lfa02kCW');
  assert.equal(c.kind, 'youtube'); assert.equal(c.id, 'UjNw6Gd5Zuc');
  c = classifyVideoUrl('www.youtube.com/watch?v=UjNw6Gd5Zuc&t=1m30s');
  assert.equal(c.start, 90);
  assert.equal(classifyVideoUrl('https://www.youtube.com/live/UjNw6Gd5Zuc').id, 'UjNw6Gd5Zuc');
  c = classifyVideoUrl('https://drive.google.com/file/d/1AbC_dEf/view?usp=sharing');
  assert.equal(c.url, 'https://drive.google.com/uc?export=download&id=1AbC_dEf');
  c = classifyVideoUrl('https://www.dropbox.com/scl/fi/xyz/partita.mp4?rlkey=abc&dl=0');
  assert.equal(c.url, 'https://dl.dropboxusercontent.com/scl/fi/xyz/partita.mp4?rlkey=abc');
  assert.equal(classifyVideoUrl('https://cdn.example.com/live/a.m3u8').kind, 'hls');
  assert.equal(classifyVideoUrl('https://example.com/p.mp4').kind, 'direct');
  assert.equal(classifyVideoUrl('ftp://example.com/p.mp4').kind, 'invalid');
});

test('etichette di calibrazione per telecamera laterale', async () => {
  const { refLabel } = await import('../js/lib/court.js');
  const nl = { id: 'nl', label: 'Angolo vicino sinistro' };
  assert.equal(refLabel(nl, 'end'), 'Angolo vicino sinistro');
  assert.match(refLabel(nl, 'side'), /Fondo sinistro/);
});

test('MEGA: link, chiave, nome del file e decifratura a tratti', async () => {
  const { parseMegaLink, decryptMegaAttributes, megaDecryptRange, toHex } = await import('../js/lib/mega.js');
  const { randomBytes, createCipheriv } = await import('node:crypto');
  const k = randomBytes(32);
  const key = Buffer.alloc(16); for (let i = 0; i < 16; i++) key[i] = k[i] ^ k[i + 16];
  const b64 = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  for (const link of [`https://mega.nz/file/AbCd_123#${b64(k)}`, `https://mega.nz/#!AbCd_123!${b64(k)}`]) {
    const p = parseMegaLink(link);
    assert.equal(p.handle, 'AbCd_123');
    assert.deepEqual(Buffer.from(p.key), key);
    assert.deepEqual(Buffer.from(p.nonce), k.subarray(16, 24));
  }
  assert.match(parseMegaLink('https://mega.nz/folder/AbCd_123#xyz').error, /cartella/);
  assert.match(parseMegaLink('https://mega.nz/file/AbCd_123').error, /chiave/);
  // attributi: AES-CBC senza padding
  const txt = Buffer.from('MEGA{"n":"partita fano.mp4"}');
  const padded = Buffer.concat([txt, Buffer.alloc((16 - (txt.length % 16)) % 16)]);
  const c = createCipheriv('aes-128-cbc', key, Buffer.alloc(16)); c.setAutoPadding(false);
  const at = b64(Buffer.concat([c.update(padded), c.final()]));
  assert.equal((await decryptMegaAttributes(key, at)).n, 'partita fano.mp4');
  assert.equal(await decryptMegaAttributes(randomBytes(16), at), null); // chiave sbagliata
  // contenuto: AES-CTR, tratti a partire da offset qualsiasi (anche non allineati)
  const plain = randomBytes(5000);
  const iv = Buffer.concat([k.subarray(16, 24), Buffer.alloc(8)]);
  const enc = createCipheriv('aes-128-ctr', key, iv).update(plain);
  for (const [a, b] of [[0, 4999], [17, 1000], [4096, 4999], [333, 334]]) {
    const out = await megaDecryptRange(toHex(key), toHex(k.subarray(16, 24)), a, enc.subarray(a, b + 1));
    assert.deepEqual(Buffer.from(out), plain.subarray(a, b + 1));
  }
});

test('demux: MP4, MOV e WebM (indice dei campioni per la decodifica veloce)', async () => {
  const { openContainer, keyBefore } = await import('../js/vision/demux.js');
  const { readFileSync } = await import('node:fs');
  const rd = (f) => { const b = readFileSync(new URL(`./fixtures/${f}`, import.meta.url)); return { size: b.length, read: async (o, n) => new Uint8Array(b.buffer, b.byteOffset + o, Math.min(n, b.length - o)) }; };
  const mp4 = await openContainer(rd('mini.mp4'));
  assert.equal(mp4.kind, 'mp4'); assert.match(mp4.codec, /^avc1\./);
  assert.equal(mp4.n, 50); assert.equal(mp4.width, 96); assert.equal(mp4.height, 64);
  assert.ok(Math.abs(mp4.duration - 2) < 0.05);
  // tempi di presentazione: tutti i fotogrammi da 0 a 1.96 s (con B-frame riordinati)
  const ts = Array.from(mp4.t).sort((a, b) => a - b);
  ts.forEach((t, i) => assert.ok(Math.abs(t - i / 25) < 1e-6, `t[${i}] = ${t}`));
  assert.ok(mp4.key.reduce((a, b) => a + b, 0) >= 5);
  assert.ok(mp4.t[keyBefore(mp4, 1.0)] <= 1.0);
  const mov = await openContainer(rd('mini.mov'));
  assert.equal(mov.n, 30); assert.match(mov.codec, /^avc1\./);
  const webm = await openContainer(rd('mini.webm'));
  assert.equal(webm.kind, 'webm'); assert.equal(webm.codec, 'vp09.00.10.08');
  assert.equal(webm.n, 50); assert.ok(webm.key[0] === 1);
  Array.from(webm.t).forEach((t, i) => assert.ok(Math.abs(t - i / 25) < 1e-3));
});

test('rilevatore persone: decodifica YOLOX, tasselli e NMS', async () => {
  const { decode, nms, tilesFor, toTensor } = await import('../js/vision/detector.js');
  const size = 64, n = (size / 8) ** 2 + (size / 16) ** 2 + (size / 32) ** 2;
  const out = new Float32Array(n * 85).fill(-10);
  for (let i = 0; i < n; i++) { out[i * 85 + 4] = 0; out[i * 85 + 5] = 0; }
  // una persona nella cella (3,2) del livello a passo 8: centro (3.5*8, 2.5*8), 16x32 px
  const i = 2 * 8 + 3;
  out.set([0.5, 0.5, Math.log(2), Math.log(4), 0.95], i * 85); out[i * 85 + 5] = 0.9;
  const b = decode(out, size, { thr: 0.3 });
  assert.equal(b.length, 1);
  assert.ok(Math.abs(b[0].x0 - 20) < 1e-6 && Math.abs(b[0].y1 - 36) < 1e-6);
  const dup = nms([{ cls: 0, score: 0.9, x0: 0, y0: 0, x1: 10, y1: 20 }, { cls: 0, score: 0.8, x0: 1, y0: 0, x1: 11, y1: 20 }, { cls: 0, score: 0.7, x0: 2, y0: 2, x1: 10, y1: 12 }, { cls: 0, score: 0.6, x0: 50, y0: 0, x1: 60, y1: 20 }]);
  assert.equal(dup.length, 2); // doppione e riquadro tagliato al bordo del tassello eliminati
  assert.equal(tilesFor(1280, 720).length, 2);
  assert.equal(tilesFor(640, 640).length, 1);
  const t = toTensor(new Uint8ClampedArray([10, 20, 30, 255]), 1);
  assert.deepEqual(Array.from(t), [30, 20, 10]); // BGR
});

// ---------------------------------------------------------------- dati ufficiali Legavolley
import { parsePbp, alignRallies, verify, packMatch, unpackMatch, lineupFromBox, nameScore } from '../js/lib/legavolley.js';

// pagina "punto a punto" ridotta con la stessa struttura del sito (righe dalla più recente)
function pbpHtml(rows) {
  const li = (r, k) => `<li${r.start ? ' class="start"' : ''}${k === 'side' ? ' style="text-align:left;"' : ''}>${r[k] || ''}</li>`;
  const cell = (s) => (s ? `<span class="number">${s[0]}</span><b class="no_mobile">${s[1]}</b><span class="skill"><b>${s[2]}</b></span>` : '');
  const rev = [...rows].reverse();
  const col = (cls, f) => `<div class="${cls}"><div class="price_table_inner"><ul>${rev.map((r) => `<li${r.start ? ' class="start"' : ''}>${f(r)}</li>`).join('')}</ul></div></div>`;
  return `<section><div id="DIV_PbP">${col('price_table_left" style="x', (r) => cell(r.h))}${col('price_table points', (r) => `<span>${r.s[0]}</span>&thinsp;-&thinsp;<span>${r.s[1]}</span>`)}${col('price_table_right" style="x', (r) => cell(r.g))}</div></section>`;
}

test('punto a punto Legavolley: scambi, vincitori (anche falli senza azione) e set', () => {
  const rows = [
    { start: 1, h: [7, 'Rossi', 'BATTUTA'], s: [0, 0] }, { g: [11, 'Bianchi', 'ATTACCO'], s: [0, 0] }, { h: [4, 'Verdi', 'ATTACCO PUNTO'], s: [1, 0] },
    { start: 1, h: [7, 'Rossi', 'ERRORE IN BATTUTA'], s: [1, 1] },
    { start: 1, g: [11, 'Bianchi', 'ACE'], s: [1, 1] }, { h: [16, 'Neri', 'RICEZIONE ERRATA'], s: [1, 2] },
    // fallo non registrato: il punteggio non cambia, lo aggiorna la riga dopo
    { start: 1, g: [11, 'Bianchi', 'BATTUTA'], s: [1, 2] }, { h: [4, 'Verdi', 'ATTACCO'], s: [1, 2] },
    { start: 1, h: [8, 'Gialli', 'BATTUTA'], s: [2, 2] }, { g: [9, 'Blu', 'ATTACCO MURATO'], s: [2, 2] }, { h: [6, 'Viola', 'MURO PUNTO'], s: [3, 2] },
    // nuovo set
    { start: 1, g: [15, 'Rosa', 'ERRORE IN BATTUTA'], s: [1, 0] },
  ];
  const r = parsePbp(pbpHtml(rows));
  assert.equal(r.length, 6);
  assert.deepEqual(r.map((x) => x.winner), [0, 1, 1, 0, 0, 0]);
  assert.deepEqual(r.map((x) => x.serveTeam), [0, 0, 1, 1, 0, 1]);
  assert.deepEqual(r.map((x) => x.set), [1, 1, 1, 1, 1, 2]);
  assert.deepEqual(r[4].scoreAfter, [3, 2]);
  assert.equal(r[0].end.kind, 'att_pt'); assert.equal(r[0].end.num, 4);
  assert.equal(r[2].serve, 'ace'); assert.equal(r[4].end.kind, 'block_pt');
  // forma compatta andata e ritorno
  const m = { teams: [{ name: 'A' }, { name: 'B' }], sets: [], players: [[{ number: 7, name: 'Rossi', start: [1, null, null, null, null], points: 0, serve: { tot: 2, err: 1, ace: 0 }, reception: { tot: 0, err: 0, pos: 0, prf: 0 }, attack: { tot: 0, err: 0, blocked: 0, pts: 0 }, block: { pts: 0 } }], []] };
  const u = unpackMatch(JSON.parse(JSON.stringify(packMatch(1, m, r))));
  assert.deepEqual(u.rallies.map((x) => x.winner), [0, 1, 1, 0, 0, 0]);
  assert.equal(u.rallies[4].end.kind, 'block_pt');
  assert.equal(u.players[0][0].serve.err, 1);
});

test('allineamento con il punto a punto: scambi in più e mancanti', () => {
  const pbp = [0, 0, 1, 1, 0, 1, 1, 0].map((w, k, a) => ({ serveTeam: k ? a[k - 1] : 0, winner: w }));
  // rilevati: manca il 3° scambio, c'è un falso scambio (palleggi) dopo il 5°
  const det = [0, 1, 3, 4, null, 5, 6, 7].map((k) => (k == null ? { serveTeam: 'a', winner: null } : { serveTeam: pbp[k].serveTeam ? 'a' : '*', winner: pbp[k].winner ? 'a' : '*' }));
  const pairs = alignRallies(det, pbp, 0);
  assert.deepEqual(pairs, [0, 1, 3, 4, null, 5, 6, 7]);
  const v = verify(det, pbp, pairs, 0);
  assert.equal(v.matched, 7); assert.equal(v.serve.ok, 7); assert.equal(v.winner.ok, 7);
});

test('formazione dal tabellino e nomi delle squadre', () => {
  const P = [4, 6, 7, 8, 16, 18].map((n, i) => ({ number: n, start: [i + 1, ((i + 2) % 6) + 1] }));
  assert.deepEqual(lineupFromBox(P, 1), [4, 6, 7, 8, 16, 18]);
  assert.deepEqual(lineupFromBox(P, 2), [16, 18, 4, 6, 7, 8]);
  assert.ok(nameScore('Sir Susa Scai Perugia', 'Perugia') > 0.9);
  assert.equal(nameScore('Pallavolo Padova', 'Perugia'), 0);
});

import { applyOfficial, officialRally, verifyReport, rawReading } from '../js/ui/official.js';
import { winFeatures, loadWinModel, pNear, updateWinModel } from '../js/lib/winmodel.js';

test('correzione della proposta con il punto a punto ufficiale', () => {
  const match = { teams: { '*': { name: 'Casa' }, a: { name: 'Ospiti' } }, official: { homeIs: 0 } };
  const sk = (team, skill, num, ev, vt) => ({ kind: 'skill', team, skill, num, ev, vt, type: 'H' });
  const base = [sk('*', 'S', 4, '+', 1), sk('a', 'R', 5, '+', 2), sk('a', 'E', 6, '+', 3), sk('a', 'A', 9, '+', 4), sk('*', 'D', 12, '+', 5), sk('*', 'E', 3, '+', 6), sk('*', 'A', 10, '#', 7), { kind: 'point', team: '*', vt: 8 }];
  // attacco punto: battitore e attaccanti dal punto a punto
  let r = { serveTeam: 0, server: 7, serve: 'serve', winner: 0, actions: [{ team: 1, num: 11, kind: 'att' }, { team: 0, num: 4, kind: 'att_pt' }], end: { team: 0, num: 4, kind: 'att_pt' } };
  let o = applyOfficial(base, r, match);
  assert.equal(o.notes.length, 0);
  const S = o.events.find((e) => e.skill === 'S'), As = o.events.filter((e) => e.skill === 'A');
  assert.equal(S.num, 7); assert.deepEqual(As.map((e) => e.num), [11, 4]); assert.equal(As[1].ev, '#');
  assert.equal(o.events[o.events.length - 1].kind, 'point'); assert.equal(o.events[o.events.length - 1].team, '*');
  // attacco murato: muro punto aggiunto se non visto, punto all'altra squadra
  r = { serveTeam: 0, server: 7, serve: 'serve', winner: 1, actions: [{ team: 1, num: 11, kind: 'att' }, { team: 0, num: 4, kind: 'att_blocked' }, { team: 1, num: 14, kind: 'block_pt' }], end: { team: 1, num: 14, kind: 'block_pt' } };
  o = applyOfficial(base, r, match);
  const B = o.events.find((e) => e.skill === 'B');
  assert.ok(B); assert.equal(B.team, 'a'); assert.equal(B.num, 14); assert.equal(B.ev, '#');
  assert.equal(o.events.filter((e) => e.skill === 'A').pop().ev, '/');
  assert.equal(o.events.find((e) => e.kind === 'point').team, 'a');
  // ace: ricezione errata del giocatore ufficiale, tocchi successivi eliminati
  r = { serveTeam: 0, server: 7, serve: 'ace', winner: 0, actions: [{ team: 1, num: 15, kind: 'rec_err' }], end: { team: 0, num: 7, kind: 'ace' } };
  o = applyOfficial(base, r, match);
  assert.deepEqual(o.events.map((e) => e.skill || e.kind), ['S', 'R', 'point']);
  assert.equal(o.events[0].ev, '#'); assert.equal(o.events[1].num, 15); assert.equal(o.events[1].ev, '=');
  // errore in battuta
  o = applyOfficial(base, { serveTeam: 0, server: 7, serve: 'serve_err', winner: 1, actions: [] }, match);
  assert.deepEqual(o.events.map((e) => e.skill || e.kind), ['S', 'point']); assert.equal(o.events[1].team, 'a');
  // attacco decisivo non visto: aggiunto in coda
  o = applyOfficial(base.slice(0, 4).concat({ kind: 'point', team: 'a', vt: 5 }), { serveTeam: 0, server: 7, serve: 'serve', winner: 0, actions: [{ team: 1, num: 11, kind: 'att' }, { team: 0, num: 10, kind: 'att_pt' }], end: { team: 0, num: 10, kind: 'att_pt' } }, match);
  const last = o.events.filter((e) => e.kind === 'skill').pop();
  assert.equal(last.skill, 'A'); assert.equal(last.team, '*'); assert.equal(last.num, 10); assert.equal(last.ev, '#');
  // squadra al servizio diversa: nessuna correzione, avviso
  o = applyOfficial(base, { serveTeam: 1, server: 9, serve: 'serve', winner: 1, actions: [] }, match);
  assert.equal(o.applied, false); assert.equal(o.notes.length, 1);
  // squadre invertite (casa dell'app = ospiti Legavolley)
  o = applyOfficial(base, { serveTeam: 1, server: 7, serve: 'serve_err', winner: 0, actions: [] }, { ...match, official: { homeIs: 1 } });
  assert.equal(o.events[0].num, 7); assert.equal(o.events[1].team, 'a');
});

test('scambio ufficiale dal punteggio e verifica delle letture del video', () => {
  const pack = { id: 1, teams: [{ name: 'A' }, { name: 'B' }], sets: [], players: [[], []], rallies: [[1, 0, 7, 'S', 0, [[0, 4, 'AP']]], [1, 0, 7, 'SE', 1, []], [1, 1, 9, 'A', 1, [[0, 5, 'RE']]]] };
  const match = { teams: { '*': { name: 'A' }, a: { name: 'B' } }, official: { homeIs: 0, data: pack } };
  const q = officialRally(match, { set: 1, score: { '*': 1, a: 1 } });
  assert.equal(q.k, 2); assert.equal(q.ok, true); assert.equal(q.r.serve, 'ace');
  assert.equal(officialRally(match, { set: 1, score: { '*': 2, a: 0 } }).ok, false);
  const raw = (ev) => rawReading(ev);
  const rallies = [
    { status: 'accepted', off: { set: 1, k: 0 }, raw: raw([{ kind: 'skill', team: '*', skill: 'S', num: 7, ev: '+' }, { kind: 'skill', team: '*', skill: 'A', num: 4, ev: '#' }, { kind: 'point', team: '*' }]) },
    { status: 'accepted', off: { set: 1, k: 1 }, raw: raw([{ kind: 'skill', team: '*', skill: 'S', num: 8, ev: '+' }, { kind: 'point', team: '*' }]) },
  ];
  const v = verifyReport(match, rallies);
  assert.equal(v.n, 2); assert.deepEqual(v.serve, [2, 2]); assert.deepEqual(v.server, [1, 2]); assert.deepEqual(v.winner, [1, 2]); assert.deepEqual(v.outcome, [1, 2]); assert.deepEqual(v.endPlayer, [1, 1]);
});

test('modello del punto: cambio palla e apprendimento dagli scambi confermati', () => {
  const mem = new Map(); const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const m = loadWinModel(st);
  const ra = (srv, last, landing) => ({ touches: [{ side: srv }, { side: last }], landing });
  // l'atterraggio non visto, ma lo scambio dopo batte il lato lontano: punto al lontano
  const f = winFeatures(ra('near', 'far', null), { touches: [{ side: 'far' }] }, false, null);
  assert.ok(pNear(m, f) < 0.2);
  // con un cambio campo in mezzo la battuta successiva non conta
  const g = winFeatures(ra('near', 'far', null), { touches: [{ side: 'far' }] }, true, null);
  assert.ok(pNear(m, g) > 0.2 && pNear(m, g) < 0.8); // non decisivo
  // telecamera in cui l'atterraggio "lato vicino" è spesso sbagliato: il modello impara a fidarsene meno
  const w0 = m.w[0];
  for (let k = 0; k < 40; k++) updateWinModel(m, winFeatures(ra('far', 'near', { X: [0, 0, 0] }), null, false, 'near'), false);
  assert.ok(m.w[0] < w0);
});
