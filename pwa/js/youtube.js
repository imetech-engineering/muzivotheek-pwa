// YouTube bij een nummer: link opslaan en afspelen via de officiële
// YouTube-speler (youtube-nocookie). Werkt alleen met internet; video's worden
// niet gedownload (mag niet volgens YouTube).

// Haal video-id en starttijd uit alle gangbare linkvormen.
export function parseYouTube(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[\w-]{11}$/.test(s)) return { id: s, start: 0 };
  let url;
  try {
    url = new URL(s.startsWith("http") ? s : "https://" + s);
  } catch (e) {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  let id = null;
  if (host === "youtu.be") id = url.pathname.slice(1, 12);
  else if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
    id = url.searchParams.get("v");
    const m = url.pathname.match(/\/(embed|shorts|live|v)\/([\w-]{11})/);
    if (!id && m) id = m[2];
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  const t = url.searchParams.get("t") || url.searchParams.get("start") || "";
  return { id, start: parseTime(t) };
}

function parseTime(t) {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return +t;
  const m = t.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

export function searchUrl(song) {
  const q = [song.title, song.composer].filter(Boolean).join(" ");
  return "https://www.youtube.com/results?search_query=" + encodeURIComponent(q);
}

let apiPromise = null;
function loadApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev && prev();
      resolve();
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => {
      apiPromise = null;
      reject(new Error("YouTube kon niet laden (geen internet?)"));
    };
    document.head.append(s);
  });
  return apiPromise;
}

// Zelfde bediening als een <audio>-element, zodat het paneel beide kan bedienen.
export class YouTubePlayer {
  constructor(container, { id, start = 0 }) {
    this.ready = loadApi().then(
      () =>
        new Promise((resolve) => {
          this.p = new window.YT.Player(container, {
            host: "https://www.youtube-nocookie.com",
            videoId: id,
            width: "100%",
            height: "100%",
            playerVars: { playsinline: 1, rel: 0, modestbranding: 1, start: Math.floor(start) },
            events: {
              onReady: () => resolve(this),
              onStateChange: (e) => this.onstate && this.onstate(e.data),
            },
          });
        })
    );
  }
  get paused() {
    const s = this.p && this.p.getPlayerState ? this.p.getPlayerState() : -1;
    return s !== 1 && s !== 3; // 1 = speelt, 3 = laden
  }
  get currentTime() {
    return this.p && this.p.getCurrentTime ? this.p.getCurrentTime() : 0;
  }
  set currentTime(t) {
    this.p && this.p.seekTo(Math.max(0, t), true);
  }
  get duration() {
    return this.p && this.p.getDuration ? this.p.getDuration() : 0;
  }
  get playbackRate() {
    return this.p && this.p.getPlaybackRate ? this.p.getPlaybackRate() : 1;
  }
  set playbackRate(r) {
    this.p && this.p.setPlaybackRate(r);
  }
  play() {
    this.p && this.p.playVideo();
  }
  pause() {
    this.p && this.p.pauseVideo && this.p.pauseVideo();
  }
  destroy() {
    try {
      this.p && this.p.destroy();
    } catch (e) {}
    this.p = null;
  }
}
