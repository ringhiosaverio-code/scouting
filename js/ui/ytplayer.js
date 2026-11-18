// Lettore YouTube "travestito" da <video>: l'elemento video dell'app riceve
// currentTime, play(), pause(), paused, duration… collegati al lettore YouTube
// (IFrame API), così scouting, calibrazione manuale e playlist funzionano senza
// modifiche. L'iframe sta sotto l'overlay dei clic, nello stesso riquadro.
//
// Limite invalicabile: i pixel di un iframe YouTube non sono leggibili dalla
// pagina, quindi analisi automatica e calibrazione automatica non sono
// disponibili con YouTube (servono file o link diretti).

let apiPromise = null;
function loadApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise((res, rej) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); res(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiPromise = null; rej(new Error('Impossibile caricare il lettore YouTube (connessione assente o bloccata)')); };
    document.head.appendChild(s);
    setTimeout(() => { if (!window.YT?.Player) { apiPromise = null; rej(new Error('Il lettore YouTube non risponde')); } }, 15000);
  });
  return apiPromise;
}

const PROPS = ['currentTime', 'duration', 'paused', 'playbackRate', 'readyState', 'currentSrc', 'videoWidth', 'videoHeight', 'play', 'pause', 'load'];

export function createYouTubeBinding(video) {
  const holder = document.createElement('div');
  holder.className = 'yt-holder';
  holder.hidden = true;
  const mount = document.createElement('div');
  holder.appendChild(mount);
  let player = null, ready = false, timer = null, active = false, rate = 1, pendingSeek = null;
  const fire = (t) => video.dispatchEvent(new Event(t));

  function bind(id) {
    const def = (k, get, set) => Object.defineProperty(video, k, { configurable: true, get, set });
    def('currentTime', () => (ready ? player.getCurrentTime() : pendingSeek ?? 0), (t) => {
      if (!ready) { pendingSeek = t; return; }
      player.seekTo(Math.max(0, t), true);
      fire('seeked'); fire('timeupdate');
    });
    def('duration', () => (ready ? player.getDuration() || NaN : NaN));
    def('paused', () => !ready || ![1, 3].includes(player.getPlayerState()));
    def('playbackRate', () => rate, (r) => { rate = r; if (ready) player.setPlaybackRate(r); });
    def('readyState', () => (ready ? 4 : 0));
    def('currentSrc', () => (active ? `youtube:${id}` : ''));
    def('videoWidth', () => 1280);
    def('videoHeight', () => 720);
    Object.defineProperty(video, 'play', { configurable: true, value: () => { if (ready) player.playVideo(); return Promise.resolve(); } });
    Object.defineProperty(video, 'pause', { configurable: true, value: () => { if (ready) player.pauseVideo(); } });
    Object.defineProperty(video, 'load', { configurable: true, value: () => {} });
  }
  function unbind() { for (const k of PROPS) delete video[k]; }

  // il riquadro segue l'elemento video quando cambia scheda
  const placeHolder = () => { if (video.parentNode && holder.previousSibling !== video) video.after(holder); };
  new MutationObserver(placeHolder).observe(document.body, { childList: true, subtree: true });

  return {
    holder,
    get active() { return active; },
    async open(id, start = 0) {
      this.close();
      active = true;
      video.removeAttribute('src');
      HTMLMediaElement.prototype.load.call(video);
      video.classList.add('yt-hidden');
      bind(id);
      holder.hidden = false;
      placeHolder();
      const YT = await loadApi();
      if (!active) return;
      const el = document.createElement('div');
      mount.replaceChildren(el);
      pendingSeek = start || null;
      await new Promise((res, rej) => {
        player = new YT.Player(el, {
          videoId: id,
          width: '100%', height: '100%',
          playerVars: { origin: location.origin, rel: 0, modestbranding: 1, playsinline: 1, start: Math.floor(start || 0), controls: 1, disablekb: 1 },
          events: {
            onReady: () => {
              ready = true;
              if (rate !== 1) player.setPlaybackRate(rate);
              if (pendingSeek) { player.seekTo(pendingSeek, true); pendingSeek = null; }
              fire('loadedmetadata'); fire('loadeddata'); fire('timeupdate');
              res();
            },
            onStateChange: (e) => {
              if (e.data === 1) fire('play');
              if (e.data === 2 || e.data === 0) fire('pause');
              if (e.data === 0) fire('ended');
            },
            onPlaybackRateChange: (e) => { rate = e.data; fire('ratechange'); },
            onError: (e) => {
              const why = { 2: 'link non valido', 5: 'errore del lettore', 100: 'video non trovato o privato', 101: 'il proprietario non ne consente la riproduzione incorporata', 150: 'il proprietario non ne consente la riproduzione incorporata' }[e.data] || `errore ${e.data}`;
              const err = new Error(`YouTube: ${why}`);
              video.dispatchEvent(new CustomEvent('yterror', { detail: err }));
              if (!ready) rej(err);
            },
          },
        });
      });
      timer = setInterval(() => { if (ready && !video.paused) fire('timeupdate'); }, 200);
    },
    close() {
      if (!active) return;
      active = false; ready = false;
      clearInterval(timer);
      try { player?.destroy(); } catch { /* lettore già rimosso */ }
      player = null;
      mount.replaceChildren();
      holder.hidden = true;
      video.classList.remove('yt-hidden');
      unbind();
    },
  };
}
