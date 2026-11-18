// Riconoscimento dei link video esterni: il video resta dov'è (nessun download
// nel PC), il browser lo riproduce in streaming.
//
//   youtube  → lettore YouTube incorporato (scouting manuale; analisi automatica non possibile)
//   hls      → flusso .m3u8 (nativo su Safari, altrimenti con hls.js)
//   direct   → file video raggiungibile via http(s): MP4, WebM, MOV… (Drive e Dropbox convertiti
//              nel loro link di streaming diretto)

export function classifyVideoUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: 'invalid', reason: 'Link vuoto' };
  let u;
  try { u = new URL(/^[a-z][\w+.-]*:/i.test(s) ? s : 'https://' + s); } catch { return { kind: 'invalid', reason: 'Link non valido' }; }
  if (!/^https?:$/.test(u.protocol)) return { kind: 'invalid', reason: 'Serve un link http o https' };
  const host = u.hostname.replace(/^(www|m)\./, '');

  // YouTube: watch?v=, youtu.be/, shorts/, live/, embed/
  let yt = null;
  if (host === 'youtu.be') yt = u.pathname.slice(1).split('/')[0];
  else if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
    yt = u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/) || [])[1] || null;
  }
  if (yt) {
    if (!/^[\w-]{11}$/.test(yt)) return { kind: 'invalid', reason: 'Link YouTube non riconosciuto' };
    return { kind: 'youtube', id: yt, start: parseYtTime(u.searchParams.get('t') || u.searchParams.get('start')), url: `https://www.youtube.com/watch?v=${yt}` };
  }

  // Google Drive: /file/d/ID/..., open?id=ID, uc?id=ID
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    const id = (u.pathname.match(/\/file\/d\/([^/]+)/) || [])[1] || u.searchParams.get('id');
    if (!id) return { kind: 'invalid', reason: 'Link Google Drive non riconosciuto (serve il link di condivisione del file)' };
    return { kind: 'direct', url: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`, provider: 'drive', original: s };
  }

  // Dropbox: link di condivisione → contenuto grezzo
  if (host === 'dropbox.com' || host === 'dl.dropboxusercontent.com') {
    const d = new URL(u.href);
    d.hostname = 'dl.dropboxusercontent.com';
    d.searchParams.delete('dl');
    d.searchParams.delete('raw');
    return { kind: 'direct', url: d.href, provider: 'dropbox', original: s };
  }

  if (/\.m3u8$/i.test(u.pathname)) return { kind: 'hls', url: u.href };
  return { kind: 'direct', url: u.href };
}

function parseYtTime(t) {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return +t;
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

export const isExternalUrl = (u) => /^https?:/i.test(u || '');
export const isYouTubeSrc = (u) => /^youtube:/.test(u || '');
