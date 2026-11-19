// Scarica i dati ufficiali Legavolley (tabellino + punto a punto) delle partite giocate e li
// salva in forma compatta in data/legavolley/ (indice + un file per partita), usati dall'app
// per verificare e correggere l'analisi automatica e per imparare le dinamiche di gioco.
//
// Uso: NODE_USE_ENV_PROXY=1 node tools/legavolley.mjs [--recheck] [IdCampionato ...]
//      (predefiniti: 999 1000 1001 = SuperLega, A2, A3 della stagione in corso). Le partite già
//      scaricate non vengono riscaricate; quelle con punto a punto incompleto sul sito vengono
//      saltate (e riprovate con --recheck).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { parseMatch, parsePbp, packMatch } from '../js/lib/legavolley.js';

const OUT = new URL('../data/legavolley/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2), recheck = args.includes('--recheck');
const campArgs = args.filter((a) => /^\d+$/.test(a));
const camps = campArgs.length ? campArgs : ['999', '1000', '1001'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 3) {
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (VolleyScout data tool)' } });
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
    } catch (e) { if (k === tries - 1) throw e; }
    await sleep(1000 * (k + 1));
  }
  return null;
}

const idxFile = new URL('index.json', OUT);
const index = existsSync(idxFile) ? JSON.parse(readFileSync(idxFile, 'utf8')) : { updated: null, matches: [] };
index.skipped ||= [];
if (recheck) index.skipped = [];
const known = new Set([...index.matches.map((m) => m.id), ...index.skipped]);
let added = 0;
for (const camp of camps) {
  // tutte le giornate del campionato: la pagina dei risultati elenca le giornate nel menu
  const first = await get(`https://www.legavolley.it/risultati/?IdCampionato=${camp}`);
  if (!first) { console.warn('campionato', camp, 'non trovato'); continue; }
  const days = [...new Set([...first.matchAll(/<option[^>]*value=(\d+)>[^<]*Giornata/g)].map((m) => m[1]))];
  const pages = [first];
  for (const d of days) {
    const p = await get(`https://www.legavolley.it/risultati/?IdCampionato=${camp}&IdGiornata=${d}`);
    if (p) pages.push(p);
    await sleep(200);
  }
  const ids = [...new Set(pages.flatMap((p) => [...p.matchAll(/\/match\/(\d+)/g)].map((m) => +m[1])))].sort((a, b) => a - b);
  console.log(`campionato ${camp}: ${days.length} giornate, ${ids.length} partite`);
  for (const id of ids) {
    if (known.has(id)) continue;
    const mh = await get(`https://www.legavolley.it/match/${id}`);
    if (!mh) continue;
    const m = parseMatch(mh);
    if (!m.sets.length) continue; // non ancora giocata
    const ph = await get(`https://ww2.legavolley.it/tabellini_online/gara_${id}.html`);
    let rallies = [];
    try { rallies = ph ? parsePbp(ph) : []; } catch { rallies = []; }
    // controllo: i punti dei set ricalcolati devono coincidere con il risultato ufficiale
    const ok = rallies.length > 0 && m.sets.every((s) => {
      const L = rallies.filter((r) => r.set === s.n);
      return L.filter((r) => r.winner === 0).length === s.score[0] && L.filter((r) => r.winner === 1).length === s.score[1];
    });
    known.add(id);
    if (!ok) { index.skipped.push(id); console.log(id, m.date, m.teams.map((t) => t.name).join(' - '), '✗ punto a punto incompleto o incoerente sul sito: saltata'); continue; }
    const pack = packMatch(id, m, rallies);
    pack.camp = +camp; pack.checked = ok;
    writeFileSync(new URL(`${id}.json`, OUT), JSON.stringify(pack));
    index.matches.push({ id, camp: +camp, date: m.date, home: m.teams[0]?.name, guest: m.teams[1]?.name, sets: m.teams.map((t) => t.sets), rallies: rallies.length, checked: ok });
    added++;
    console.log(id, m.date, m.teams.map((t) => t.name).join(' - '), m.sets.map((s) => s.score.join('-')).join(' '), rallies.length, 'scambi ✓');
    await sleep(250);
  }
}
index.matches.sort((a, b) => a.id - b.id);
index.updated = new Date().toISOString().slice(0, 10);
index.note = 'Solo partite con punto a punto completo (punti ricalcolati = risultato ufficiale). Fonte: Lega Pallavolo Serie A, legavolley.it';
writeFileSync(idxFile, JSON.stringify(index).replace(/\},\{/g, '},\n{'));
console.log(`nuove partite: ${added}, totale ${index.matches.length}`);
