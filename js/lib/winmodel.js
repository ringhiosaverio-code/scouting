// Chi vince lo scambio? Piccolo modello (regressione logistica) che combina gli indizi del video
// e la regola del cambio palla (chi vince batte lo scambio dopo). Parte da pesi ricavati dalle
// partite ufficiali e si aggiorna a ogni scambio confermato (dallo scout o dal punto a punto
// ufficiale): impara quanto fidarsi di ciascun indizio con quella telecamera e quel campo.
//
// Indizi, tutti dal punto di vista del lato vicino alla telecamera (+1 = lato vicino):
//  0 atterraggio: in campo dal lato vicino → vince il lontano (-1), e viceversa; 0 se non visto
//  1 ultimo tocco: chi ha toccato per ultimo (spesso chi sbaglia o chi attacca)
//  2 battuta: chi batte (chi batte vince meno spesso: 32% degli scambi in SuperLega, 31-34% in
//    A2/A3, dal punto a punto ufficiale: data/dynamics.json)
//  3 cambio palla: chi batte lo scambio dopo (0 se non c'è o c'è un cambio campo in mezzo)
//  4 costante
export const FEATURES = ['atterraggio', 'ultimo tocco', 'battuta', 'battuta successiva', 'costante'];
export const PRIOR = [1.8, 0.35, -0.75, 2.0, 0]; // battuta: logit(0.32)
const KEY = 'vsp-winmodel-v1';

// lato che batte secondo il primo tocco di uno scambio, con affidabilità: una battuta parte da
// dietro la linea di fondo; un primo tocco basso dentro il campo è la ricezione (la battuta non
// è stata vista) e quindi batteva l'altra metà campo
export function serveSideOf(ra) {
  const t0 = ra?.touches?.[0];
  if (!t0 || t0.noServe) return { side: null, w: 0 };
  const y = t0.X?.[1], z = t0.X?.[2];
  if (y != null && y > 1.5 && y < 16.5) {
    if (z != null && z < 1.6) return { side: t0.side === 'near' ? 'far' : 'near', w: 0.5 };
    return { side: t0.side, w: 0.3 };
  }
  return { side: t0.side, w: t0.reconstructed ? 0.6 : 1 };
}

// typicalGap: pausa tipica tra due scambi rilevati (mediana); una pausa molto più lunga fa
// pensare a uno scambio non rilevato in mezzo, e la battuta dopo non dice chi ha vinto questo
export function typicalGap(rallies) {
  const g = [];
  for (let k = 1; k < rallies.length; k++) { const d = rallies[k].start - rallies[k - 1].end; if (d > 0) g.push(d); }
  g.sort((a, b) => a - b);
  return g.length >= 3 ? g[g.length >> 1] : null;
}

export function winFeatures(ra, next, gapBreak, landingWinner, gap = null) {
  const sgn = (side) => (side === 'near' ? 1 : side === 'far' ? -1 : 0);
  const L = ra.landing;
  const land = landingWinner ? (landingWinner === 'near' ? 1 : -1) * (L && !L.extrapolated ? 1 : 0.6) : 0;
  const last = sgn(ra.touches[ra.touches.length - 1]?.side);
  const me = serveSideOf(ra);
  const srv = sgn(me.side) * me.w;
  let nx = 0;
  if (next && !gapBreak) {
    const n = serveSideOf(next);
    nx = sgn(n.side) * n.w;
    if (gap && next.start - ra.end > 2.2 * gap) nx *= 0.3;
  }
  return [land, last, srv, nx, 1];
}

export function loadWinModel(storage = globalThis.localStorage) {
  try { const m = JSON.parse(storage?.getItem(KEY) || 'null'); if (m?.w?.length === PRIOR.length) return m; } catch { /* nessun modello salvato */ }
  return { w: [...PRIOR], n: 0, ok: 0 };
}
export function saveWinModel(m, storage = globalThis.localStorage) { try { storage?.setItem(KEY, JSON.stringify(m)); } catch { /* memoria non disponibile */ } }

export const pNear = (m, f) => 1 / (1 + Math.exp(-f.reduce((a, v, i) => a + v * m.w[i], 0)));

// aggiornamento con un esito vero (nearWon: true/false); regolarizzato verso i pesi iniziali
export function updateWinModel(m, f, nearWon, lr = 0.15) {
  const p = pNear(m, f), y = nearWon ? 1 : 0;
  m.n++; if ((p >= 0.5) === nearWon) m.ok++;
  for (let i = 0; i < m.w.length; i++) m.w[i] += lr * ((y - p) * f[i] - 0.02 * (m.w[i] - PRIOR[i]));
  return m;
}
