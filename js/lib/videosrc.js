// Riconoscimento dei link video esterni: il video resta dov'è (nessun download
// nel PC), il browser lo riproduce in streaming.
//
//   youtube  → lettore YouTube incorporato (scouting manuale; analisi automatica non possibile)
//   mega     → link mega.nz: streaming con decifratura nel service worker
//   hls      → flusso .m3u8 (nativo su Safari, altrimenti con hls.js)
//   direct   → file video raggiungibile via http(s): MP4, WebM, MOV… (Drive e Dropbox convertiti
//              nel loro link di streaming diretto)
//   volleymetrics → pagina di VolleyMetrics / Hudl: non è il video (protetto dall'accesso
//              all'account); il video si prende con il collegamento rapido (vedi grabVideo)
// I link "firmati" (CDN con scadenza: Expires, X-Amz-*, Key-Pair-Id, token…) funzionano solo
// per qualche ora: temporary = true ed expires = data di scadenza se leggibile.

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

  // MEGA: file cifrato, decifrato a pezzi dal service worker (vedi lib/mega.js)
  if (/(^|\.)mega(\.co)?\.nz$/.test(host)) return { kind: 'mega', url: u.href };

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

  const media = /\.(m3u8|mp4|m4v|mov|webm|mkv|ts|mpd)$/i.test(u.pathname);
  // VolleyMetrics / Hudl: la pagina della partita (non il file video)
  if (!media && /(^|\.)(volleymetrics(\.hudl)?\.com|hudl\.com|balltime\.com)$/.test(host)) return { kind: 'volleymetrics', url: u.href, host };
  if (/\.mpd$/i.test(u.pathname)) return { kind: 'invalid', reason: 'Flusso DASH (.mpd) non supportato: scarica il video e aprilo come file' };
  const extra = signedInfo(u);
  if (/hudl|volleymetrics/.test(host)) extra.provider = 'volleymetrics';
  if (/\.m3u8$/i.test(u.pathname)) return { kind: 'hls', url: u.href, ...extra };
  return { kind: 'direct', url: u.href, ...extra };
}

// link firmato con scadenza (CloudFront, S3, Akamai, Azure…)
export function signedInfo(u) {
  const q = u.searchParams, keys = [...q.keys()].map((k) => k.toLowerCase());
  const signed = keys.some((k) => ['signature', 'policy', 'key-pair-id', 'x-amz-signature', 'x-amz-credential', 'sig', 'token', 'hdnts', 'hdnea', 'se', 'sv', 'expires', 'exp', 'st', 'e'].includes(k)) && keys.some((k) => ['signature', 'policy', 'key-pair-id', 'x-amz-signature', 'sig', 'token', 'hdnts', 'hdnea', 'se', 'expires', 'exp'].includes(k));
  if (!signed) return {};
  let exp = null;
  const num = (v) => (v && /^\d{9,11}$/.test(v) ? new Date(+v * 1000) : null);
  exp = num(q.get('Expires') || q.get('expires') || q.get('exp') || q.get('e'));
  const ad = q.get('X-Amz-Date'), ae = q.get('X-Amz-Expires');
  if (!exp && ad && ae) { const m = ad.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/); if (m) exp = new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + ae * 1000); }
  const tok = q.get('hdnts') || q.get('hdnea') || q.get('token') || '';
  if (!exp) exp = num((tok.match(/exp=(\d+)/) || [])[1]);
  if (!exp && q.get('se')) { const d = new Date(q.get('se')); if (!isNaN(d)) exp = d; }
  return { temporary: true, expires: exp ? exp.toISOString() : null };
}

// Collegamento rapido (bookmarklet): eseguito sulla pagina di VolleyMetrics/Hudl (o di un altro
// sito) dove si sta guardando la partita, trova l'indirizzo del video che la pagina sta
// riproducendo (elemento <video> oppure flusso .m3u8/.mp4 scaricato dalla pagina) e apre
// VolleyScout con quel video. Nessuna password o cookie viene letto: solo l'indirizzo del video.
// Scritto in JavaScript "vecchio stile" e senza commenti di riga: diventa un link javascript:.
export function grabVideo(app) {
  var isMedia = function (u) { return /\.(m3u8|mp4|m4v|mov|webm)(\?|#|$)/i.test(u); };
  var found = [];
  var add = function (u) { if (u && !/^(blob|data):/.test(u) && found.indexOf(u) < 0) found.push(u); };
  var docs = [document];
  [].forEach.call(document.querySelectorAll('iframe'), function (f) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) { /* altro dominio */ } });
  docs.forEach(function (d) { [].forEach.call(d.querySelectorAll('video, video source'), function (v) { add(v.currentSrc || v.src); }); });
  var res = [];
  try { res = performance.getEntriesByType('resource').map(function (e) { return e.name; }).filter(isMedia); } catch (e) { res = []; }
  var hls = res.filter(function (u) { return /\.m3u8/i.test(u); });
  var url = found.filter(isMedia)[0] || hls[0] || found[0] || res[res.length - 1];
  if (!url) { alert('VolleyScout: nessun video trovato in questa pagina. Avvia la riproduzione del video e riprova.'); return null; }
  var title = (document.title || '').replace(/\s*[|·–-]\s*(Hudl|VolleyMetrics|Volleymetrics|Balltime)\b.*$/, '').trim();
  var target = app + '#video=' + encodeURIComponent(url) + '&titolo=' + encodeURIComponent(title) + '&da=' + encodeURIComponent(location.hostname);
  window.open(target, '_blank');
  return target;
}
export const bookmarkletHref = (appUrl) => 'javascript:' + encodeURIComponent(`(${grabVideo.toString().replace(/\/\*[^*]*\*\//g, '').replace(/\s*\n\s*/g, ' ')})(${JSON.stringify(appUrl)});void 0`);

// "Squadra A vs Squadra B" (titolo della pagina) → nomi delle squadre
export function teamsFromTitle(t) {
  const m = String(t || '').match(/^\s*(.+?)\s+(?:vs\.?|v\.?|-|–|@|contro)\s+(.+?)\s*(?:[|(\[].*)?$/i);
  return m ? [m[1].trim(), m[2].trim()] : null;
}

function parseYtTime(t) {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return +t;
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

export const isExternalUrl = (u) => /^https?:/i.test(u || '');
export const isYouTubeSrc = (u) => /^youtube:/.test(u || '');
