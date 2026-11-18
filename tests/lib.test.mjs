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
