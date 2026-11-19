// Dinamiche di gioco apprese dalle partite ufficiali (data/legavolley/*.json) e dalle partite
// DataVolley d'esempio: frequenze con cui finiscono gli scambi, quanti attacchi servono, quanto
// vince chi batte. Salvate in data/dynamics.json e usate dall'app come conoscenza di partenza
// (es. modello del punto, controllo di plausibilità degli scambi rilevati).
// Uso: node tools/dynamics.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { unpackMatch } from '../js/lib/legavolley.js';

const DIR = new URL('../data/legavolley/', import.meta.url);
const idx = JSON.parse(readFileSync(new URL('index.json', DIR), 'utf8'));
const LEAGUE = { 999: 'SuperLega', 1000: 'Serie A2', 1001: 'Serie A3' };
const out = { fonte: 'Punto a punto ufficiale Lega Pallavolo Serie A (legavolley.it)', aggiornato: idx.updated, leghe: {} };
const ATT = new Set(['att', 'att_pt', 'att_err', 'att_blocked']);
for (const [camp, name] of Object.entries(LEAGUE)) {
  const ms = idx.matches.filter((m) => m.camp === +camp);
  const R = ms.flatMap((m) => unpackMatch(JSON.parse(readFileSync(new URL(`${m.id}.json`, DIR), 'utf8'))).rallies);
  if (!R.length) continue;
  const n = R.length, f = (k) => +(k / n).toFixed(4);
  const nAtt = R.map((r) => r.actions.filter((a) => ATT.has(a.kind)).length);
  const hist = Array.from({ length: 8 }, (_, k) => f(nAtt.filter((x) => (k === 7 ? x >= 7 : x === k)).length));
  const ends = {};
  for (const r of R) { const k = r.end?.kind || 'altro'; ends[k] = (ends[k] || 0) + 1; }
  // il primo attacco dopo la ricezione (cambio palla) e i contrattacchi
  const firstAtt = R.filter((r) => r.serve === 'serve').map((r) => r.actions.find((a) => ATT.has(a.kind))).filter(Boolean);
  const so = firstAtt.filter((a) => a.kind === 'att_pt').length / Math.max(1, firstAtt.length);
  // chi attacca per ultimo vince? (per dedurre il punto quando l'atterraggio non si vede)
  const lastAttWins = R.filter((r) => r.actions.some((a) => ATT.has(a.kind))).map((r) => { const a = r.actions.filter((x) => ATT.has(x.kind)).pop(); return a.team === r.winner; });
  out.leghe[name] = {
    partite: ms.length, scambi: n,
    vinceChiBatte: f(R.filter((r) => r.serveTeam === r.winner).length),
    ace: f(R.filter((r) => r.serve === 'ace').length), erroreBattuta: f(R.filter((r) => r.serve === 'serve_err').length),
    attacchiPerScambio: hist, attacchiMedi: +(nAtt.reduce((a, b) => a + b, 0) / n).toFixed(3),
    fine: Object.fromEntries(Object.entries(ends).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, f(v)])),
    primoAttaccoPunto: +so.toFixed(4),
    vinceChiAttaccaPerUltimo: +(lastAttWins.filter(Boolean).length / Math.max(1, lastAttWins.length)).toFixed(4),
  };
}
writeFileSync(new URL('../data/dynamics.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
