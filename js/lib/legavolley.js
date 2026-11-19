// Dati ufficiali della Lega Pallavolo Serie A (legavolley.it): tabellino della partita e
// "Punto a Punto". Lettura dell'HTML con espressioni regolari (funziona nel browser e in Node).
//
// Punto a punto: per ogni scambio chi batte, come finisce (ace, errore in battuta, attacco
// punto, muro punto, ricezione errata, attacco murato, errore in attacco…), con giocatore e
// punteggio. È la verità con cui l'analisi automatica si confronta e si corregge.

const text = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&ensp;|&thinsp;|&emsp;|&#160;|&#8201;/g, ' ').replace(/&amp;/g, '&').replace(/&#039;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- tabellino (www.legavolley.it/match/ID)
export function parseMatch(html) {
  const out = { teams: [], sets: [], players: [[], []] };
  const head = html.match(/Stagione&nbsp;\s*([\d/]+)\s*-\s*([^<]*?)\s*-\s*Gara n°(\d+)/);
  if (head) { out.season = head[1]; out.phase = text(head[2]); out.gameNo = +head[3]; }
  const names = [...html.matchAll(/title="Statistiche Squadra"[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>[\s\S]*?id="HighCol"[^>]*>\s*<span[^>]*>\s*(\d)\s*<\/span>/g)];
  out.teams = names.slice(0, 2).map((m) => ({ name: text(m[1]), sets: +m[2] }));
  const date = html.match(/(\d{2}\/\d{2}\/\d{4})&nbsp;/); if (date) out.date = date[1];
  for (const m of html.matchAll(/<tr><td class='DarkCol'>(\d)<\/td>([\s\S]*?)<\/tr>/g)) {
    const cells = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1]));
    const fin = cells[cells.length - 1];
    if (fin && fin !== '0-0') out.sets.push({ n: +m[1], dur: cells[0], partials: cells.slice(1, -1).filter(Boolean), score: fin.split('-').map(Number) });
  }
  // tabelle giocatori: riga [num, nome, voto, s1..s5, Tot, BP, VP, Bat Tot, Err, Ace, Ric Tot, Err, Pos%, Prf%, Att Tot, Err, Mur, Pt, Pt%, Muro Pt]
  let team = -1;
  for (const r of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => text(c[1]));
    if (cells[1] === 'Voto' && cells[2] === 'SET') { team++; continue; }
    if (team < 0 || team > 1 || cells.length < 24 || !/^\d+$/.test(cells[0])) continue;
    const n = (v) => (v === '.' || v === '' || v == null ? 0 : parseFloat(v));
    out.players[team].push({
      number: +cells[0], name: cells[1],
      start: cells.slice(3, 8).map((v) => (/^\d$/.test(v) ? +v : v === '*' ? 'sub' : null)),
      points: n(cells[8]),
      serve: { tot: n(cells[11]), err: n(cells[12]), ace: n(cells[13]) },
      reception: { tot: n(cells[14]), err: n(cells[15]), pos: n(cells[16]), prf: n(cells[17]) },
      attack: { tot: n(cells[18]), err: n(cells[19]), blocked: n(cells[20]), pts: n(cells[21]) },
      block: { pts: n(cells[23]) },
    });
  }
  return out;
}

// ---------------------------------------------------------------- punto a punto (ww2…/tabellini_online/gara_ID.html)
const KINDS = [
  ['ERRORE IN BATTUTA', 'serve_err'], ['ACE', 'ace'], ['BATTUTA', 'serve'],
  ['RICEZIONE ERRATA', 'rec_err'], ['ATTACCO PUNTO', 'att_pt'], ['ATTACCO MURATO', 'att_blocked'], ['ERRORE IN ATTACCO', 'att_err'],
  ['MURO PUNTO', 'block_pt'], ['ATTACCO', 'att'], ['ERRORE', 'err'],
];
const kindOf = (s) => { const u = s.toUpperCase(); for (const [k, v] of KINDS) if (u.includes(k)) return v; return null; };

function column(seg, cls) {
  const k = seg.indexOf(`class="${cls}`);
  if (k < 0) return [];
  const a = seg.indexOf('<ul>', k), b = seg.indexOf('</ul>', a);
  return [...seg.slice(a, b).matchAll(/<li([^>]*)>([\s\S]*?)<\/li>/g)].map((m) => {
    const num = m[2].match(/class="number"[^>]*>\s*(\d+)\s*</);
    const name = m[2].match(/<b class="no_mobile">([\s\S]*?)<\/b>/);
    const skill = m[2].match(/class="skill"[\s\S]*?<b[^>]*>([\s\S]*?)<\/b>/);
    return { start: /class="start"/.test(m[1]), num: num ? +num[1] : null, name: name ? text(name[1]) : null, what: skill ? text(skill[1]) : text(m[2]) };
  });
}

const scoreOf = (s) => { const m = (s || '').match(/(\d+)\D+(\d+)/); return m ? [+m[1], +m[2]] : [NaN, NaN]; };

export function parsePbp(html) {
  const i = html.indexOf('id="DIV_PbP"');
  if (i < 0) throw new Error('pagina "Punto a Punto" non riconosciuta');
  const seg = html.slice(i, html.indexOf('</section>', i));
  const L = column(seg, 'price_table_left" style'), M = column(seg, 'price_table points'), R = column(seg, 'price_table_right" style');
  const rows = L.map((l, k) => ({ start: l.start || R[k]?.start, home: l, guest: R[k], score: scoreOf(M[k]?.what) })).reverse();
  // ogni riga riporta il punteggio DOPO la sua azione; la prima riga di uno scambio (class
  // "start") è la battuta. Il punteggio che cala indica l'inizio di un nuovo set.
  const rallies = [];
  let cur = null, prev = [0, 0], set = 1;
  for (const r of rows) {
    if (r.start) {
      const sum = r.score[0] + r.score[1];
      if (cur && sum < prev[0] + prev[1] - 3) { set++; prev = [0, 0]; }
      cur = { set, actions: [], scoreBefore: prev };
      rallies.push(cur);
    }
    if (!cur) continue;
    for (const [team, side] of [[0, r.home], [1, r.guest]]) {
      const k = side?.what ? kindOf(side.what) : null;
      if (!k) continue;
      if (k === 'serve' || k === 'ace' || k === 'serve_err') { cur.serveTeam = team; cur.server = side.num; cur.serverName = side.name; cur.serve = k; }
      else cur.actions.push({ team, num: side.num, name: side.name, kind: k });
    }
    if (!isNaN(r.score[0])) { cur.scoreAfter = r.score; prev = r.score; }
  }
  // vincitore: chi batte lo scambio dopo (regola del cambio palla), altrimenti la variazione del
  // punteggio o l'azione finale. Alcuni punti (falli, invasioni) non hanno un'azione registrata e
  // il sito aggiorna il punteggio solo alla riga seguente: la regola del cambio palla li recupera.
  rallies.forEach((r, k) => {
    const nx = rallies[k + 1], last = r.actions[r.actions.length - 1];
    r.end = r.serve === 'ace' || r.serve === 'serve_err' ? { team: r.serveTeam, num: r.server, kind: r.serve } : last ? { team: last.team, num: last.num, kind: last.kind } : null;
    const a = r.scoreAfter, b = r.scoreBefore;
    if (nx && nx.set === r.set && nx.serveTeam != null) r.winner = nx.serveTeam;
    else if (a && (a[0] > b[0] || a[1] > b[1])) r.winner = a[0] - b[0] >= a[1] - b[1] ? 0 : 1;
    else if (r.end) r.winner = r.end.kind === 'ace' || r.end.kind === 'att_pt' || r.end.kind === 'block_pt' ? r.end.team : r.end.kind === 'att' ? null : 1 - r.end.team;
    else r.winner = null;
    if (r.end && r.end.kind === 'att' && r.winner != null) r.end = { ...r.end, kind: r.winner === r.end.team ? 'att_pt?' : 'fault' };
  });
  // punteggio ricalcolato dai vincitori
  let sc = [0, 0], st = 0;
  for (const r of rallies) {
    if (r.set !== st) { sc = [0, 0]; st = r.set; }
    r.scoreBefore = sc.slice();
    if (r.winner != null) sc[r.winner]++;
    r.scoreAfter = sc.slice();
  }
  return rallies;
}

// ---------------------------------------------------------------- confronto con l'analisi
// detected: [{ serveTeam: '*'|'a'|null, winner: '*'|'a'|null }] in ordine di tempo;
// pbp: scambi di un set (o di più set consecutivi); homeIs: 0 se la squadra di casa dell'app
// è la squadra di casa Legavolley, 1 altrimenti. Allineamento con programmazione dinamica:
// scambi rilevati in più (es. palleggi) o mancanti (tagli del video) sono ammessi.
export function alignRallies(detected, pbp, homeIs = 0) {
  const T = (t) => (t == null ? null : (t === homeIs ? '*' : 'a'));
  const n = detected.length, m = pbp.length;
  const cost = (d, p) => {
    let c = 0;
    if (d.serveTeam && p.serveTeam != null) c += d.serveTeam === T(p.serveTeam) ? -1 : 1.2;
    if (d.winner && p.winner != null) c += d.winner === T(p.winner) ? -1 : 0.8;
    return c;
  };
  const SKIP_D = 1.0, SKIP_P = 0.9;
  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
  const B = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
  D[0][0] = 0;
  for (let j = 1; j <= m; j++) { D[0][j] = D[0][j - 1] + SKIP_P * 0.3; B[0][j] = 2; } // può cominciare a metà set
  for (let i = 1; i <= n; i++) { D[i][0] = D[i - 1][0] + SKIP_D; B[i][0] = 1; }
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const a = D[i - 1][j - 1] + cost(detected[i - 1], pbp[j - 1]), b = D[i - 1][j] + SKIP_D, c = D[i][j - 1] + SKIP_P;
    if (a <= b && a <= c) { D[i][j] = a; B[i][j] = 0; } else if (b <= c) { D[i][j] = b; B[i][j] = 1; } else { D[i][j] = c; B[i][j] = 2; }
  }
  // fine libera nel punto a punto (il video può finire prima)
  let j = 0; for (let k = 1; k <= m; k++) if (D[n][k] < D[n][j]) j = k;
  const pairs = new Array(n).fill(null);
  for (let i = n; i > 0 || j > 0;) {
    const b = B[i][j];
    if (i > 0 && j > 0 && b === 0) { pairs[i - 1] = j - 1; i--; j--; } else if (i > 0 && (j === 0 || b === 1)) i--; else j--;
  }
  return pairs; // per ogni scambio rilevato, l'indice nel punto a punto (o null)
}

// riassunto della verifica: quanti scambi tornano, battitore e vincitore giusti
export function verify(detected, pbp, pairs, homeIs = 0) {
  const T = (t) => (t == null ? null : (t === homeIs ? '*' : 'a'));
  let matched = 0, srvOk = 0, srvN = 0, winOk = 0, winN = 0;
  detected.forEach((d, i) => {
    const k = pairs[i]; if (k == null) return;
    matched++;
    const p = pbp[k];
    if (d.serveTeam && p.serveTeam != null) { srvN++; if (d.serveTeam === T(p.serveTeam)) srvOk++; }
    if (d.winner && p.winner != null) { winN++; if (d.winner === T(p.winner)) winOk++; }
  });
  return { detected: detected.length, official: pbp.length, matched, serve: { ok: srvOk, n: srvN }, winner: { ok: winOk, n: winN } };
}

// ---------------------------------------------------------------- forma compatta (data/legavolley/ID.json)
const CODE = { serve: 'S', ace: 'A', serve_err: 'SE', rec_err: 'RE', att_pt: 'AP', att_blocked: 'AB', att_err: 'AE', block_pt: 'BP', att: 'AT', err: 'E', 'att_pt?': 'AT', fault: 'AT' };
const KIND = Object.fromEntries(Object.entries(CODE).filter(([k]) => !k.includes('?') && k !== 'fault').map(([k, v]) => [v, k]));
export function packMatch(id, m, rallies) {
  return {
    id, date: m.date, season: m.season, phase: m.phase, teams: m.teams, sets: m.sets.map((s) => ({ n: s.n, score: s.score, partials: s.partials })),
    players: m.players.map((P) => P.map((p) => ({ n: p.number, name: p.name, start: p.start, pts: p.points, s: [p.serve.tot, p.serve.err, p.serve.ace], r: [p.reception.tot, p.reception.err, p.reception.pos, p.reception.prf], a: [p.attack.tot, p.attack.err, p.attack.blocked, p.attack.pts], b: p.block.pts }))),
    rallies: rallies.map((r) => [r.set, r.serveTeam ?? null, r.server ?? null, CODE[r.serve] || null, r.winner ?? null, r.actions.map((a) => [a.team, a.num, CODE[a.kind]])]),
  };
}
export function unpackMatch(p) {
  const rallies = [];
  const sc = {};
  for (const [set, serveTeam, server, sk, winner, acts] of p.rallies) {
    const s = (sc[set] ||= [0, 0]);
    const r = { set, serveTeam, server, serve: KIND[sk] || null, winner, actions: acts.map(([team, num, k]) => ({ team, num, kind: KIND[k] })), scoreBefore: s.slice() };
    if (winner != null) s[winner]++;
    r.scoreAfter = s.slice();
    const last = r.actions[r.actions.length - 1];
    r.end = r.serve === 'ace' || r.serve === 'serve_err' ? { team: serveTeam, num: server, kind: r.serve } : last ? { team: last.team, num: last.num, kind: last.kind } : null;
    rallies.push(r);
  }
  const players = p.players.map((P) => P.map((x) => ({ number: x.n, name: x.name, start: x.start, points: x.pts, serve: { tot: x.s[0], err: x.s[1], ace: x.s[2] }, reception: { tot: x.r[0], err: x.r[1], pos: x.r[2], prf: x.r[3] }, attack: { tot: x.a[0], err: x.a[1], blocked: x.a[2], pts: x.a[3] }, block: { pts: x.b } })));
  return { ...p, rallies, players };
}

// formazione di partenza di un set dal tabellino: il numero nella colonna del set è la posizione
// (1 = in battuta/zona 1 … 6); restituisce [p1..p6] (numeri di maglia) o null
export function lineupFromBox(players, set) {
  const pos = new Array(6).fill(null);
  for (const p of players) { const v = p.start?.[set - 1]; if (typeof v === 'number' && v >= 1 && v <= 6) pos[v - 1] = p.number; }
  return pos.every((x) => x != null) ? pos : null;
}

// ordine di battuta osservato nel punto a punto (per controllare o dedurre la rotazione)
export function serveOrder(rallies, set, team) {
  const out = [];
  for (const r of rallies) if (r.set === set && r.serveTeam === team && r.server != null && out[out.length - 1] !== r.server) out.push(r.server);
  return out;
}

// il nome di una squadra Legavolley somiglia a quello dell'app? (sponsor e città cambiano)
export function nameScore(a, b) {
  const w = (s) => new Set((s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((x) => x.length > 2 && !['volley', 'pallavolo', 'vbc', 'asd', 'ssd', 'club'].includes(x)));
  const A = w(a), B = w(b);
  if (!A.size || !B.size) return 0;
  let k = 0; for (const x of A) if (B.has(x)) k++;
  return k / Math.min(A.size, B.size);
}
