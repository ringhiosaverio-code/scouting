// Persistenza locale: salvataggio automatico delle partite, libreria squadre,
// handle del file video (File System Access API, dove disponibile).
const PREFIX = 'vsp:';

const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

export function saveMatch(match) {
  const key = PREFIX + 'match:' + match.id;
  const ok = safe(() => { localStorage.setItem(key, JSON.stringify(match)); return true; }, false);
  if (ok) {
    const idx = listMatches().filter((m) => m.id !== match.id);
    idx.unshift({ id: match.id, title: `${match.teams['*'].name} – ${match.teams.a.name}`, date: match.meta.date, saved: new Date().toISOString() });
    safe(() => localStorage.setItem(PREFIX + 'index', JSON.stringify(idx.slice(0, 200))));
    safe(() => localStorage.setItem(PREFIX + 'last', match.id));
  }
  return ok;
}

export const listMatches = () => safe(() => JSON.parse(localStorage.getItem(PREFIX + 'index') || '[]'), []);
export const loadMatch = (id) => safe(() => JSON.parse(localStorage.getItem(PREFIX + 'match:' + id)));
export const lastMatchId = () => safe(() => localStorage.getItem(PREFIX + 'last'));
export function deleteMatch(id) {
  safe(() => localStorage.removeItem(PREFIX + 'match:' + id));
  safe(() => localStorage.setItem(PREFIX + 'index', JSON.stringify(listMatches().filter((m) => m.id !== id))));
}

// Libreria squadre (rose riutilizzabili tra partite)
export const listTeams = () => safe(() => JSON.parse(localStorage.getItem(PREFIX + 'teams') || '[]'), []);
export function saveTeam(team) {
  const all = listTeams().filter((t) => t.name !== team.name);
  all.push({ code: team.code, name: team.name, coach: team.coach, assistant: team.assistant, colour: team.colour, players: team.players });
  all.sort((a, b) => a.name.localeCompare(b.name));
  safe(() => localStorage.setItem(PREFIX + 'teams', JSON.stringify(all)));
}
export function deleteTeam(name) {
  safe(() => localStorage.setItem(PREFIX + 'teams', JSON.stringify(listTeams().filter((t) => t.name !== name))));
}

export const getPref = (k, d) => safe(() => JSON.parse(localStorage.getItem(PREFIX + 'pref:' + k)) ?? d, d);
export const setPref = (k, v) => safe(() => localStorage.setItem(PREFIX + 'pref:' + k, JSON.stringify(v)));

// ---- IndexedDB per gli handle dei file video ----
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('volleyscout', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('handles');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function putHandle(key, handle) {
  try {
    const db = await idb();
    await new Promise((res, rej) => { const tx = db.transaction('handles', 'readwrite'); tx.objectStore('handles').put(handle, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  } catch { /* non supportato */ }
}
export async function getHandle(key) {
  try {
    const db = await idb();
    return await new Promise((res) => { const tx = db.transaction('handles'); const q = tx.objectStore('handles').get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); });
  } catch { return null; }
}

export function download(name, content, type = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
