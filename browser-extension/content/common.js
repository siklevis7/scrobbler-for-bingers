// The loop every site reader shares: find the video, work out what's playing, report every 5 s.
//
// A page can have the title in one frame and the player in another (an embedded player from a
// different domain). Each frame reports what it knows; the background combines them per tab.
(() => {
  if (globalThis.__bingersScrobblerStarted) return; // injected twice (e.g. "Track this site")
  globalThis.__bingersScrobblerStarted = true;

  const POLL_MS = 5000;
  const MIN_DURATION = 60; // seconds; skips ads and short clips (tracking itself needs 4+ minutes)
  const topFrame = window === window.top;

  // Trailers and previews autoplay muted before you've touched the page. A muted video only
  // counts once you've clicked or pressed a key on the page.
  let userInteracted = false;
  for (const type of ["pointerdown", "keydown", "touchstart"]) {
    window.addEventListener(type, () => (userInteracted = true), { capture: true, passive: true });
  }

  /** Every <video>, including ones inside web components (shadow DOM). */
  function allVideos(root = document, out = [], depth = 0) {
    out.push(...root.querySelectorAll("video"));
    if (depth < 4) {
      for (const el of root.querySelectorAll("*")) if (el.shadowRoot) allVideos(el.shadowRoot, out, depth + 1);
    }
    return out;
  }

  /** The main video in this frame: playing first, then the biggest on screen, then the longest. */
  function pickVideo() {
    const videos = allVideos().filter((v) => Number.isFinite(v.duration) && v.duration >= MIN_DURATION);
    const size = (v) => {
      const r = v.getBoundingClientRect();
      return r.width * r.height;
    };
    videos.sort((a, b) => Number(!b.paused) - Number(!a.paused) || size(b) - size(a) || b.duration - a.duration);
    return videos[0] || null;
  }

  function send(message) {
    if (!chrome.runtime?.id) return; // extension was reloaded or removed
    chrome.runtime.sendMessage({ type: "report", ...message }).catch(() => {});
  }

  const sameMedia = (a, b) =>
    a && b && a.title.toLowerCase() === b.title.toLowerCase() && a.season === b.season && a.episode === b.episode;

  /**
   * @param {{service: string, getMedia?: (video: HTMLVideoElement|null) => object|null,
   *          getVideo?: () => HTMLVideoElement|null}} adapter
   */
  function start(adapter) {
    let videoKey = "";
    let locked = null; // the title for the current video
    let tick = 0;

    setInterval(() => {
      tick++;
      const video = (adapter.getVideo && adapter.getVideo()) || pickVideo();
      const duration = video ? video.duration : 0;

      // A new page or a new video (different length) means the old title no longer applies.
      const key = `${location.href}|${video ? Math.round(duration) : 0}`;
      if (key !== videoKey) {
        videoKey = key;
        locked = null;
      }

      let fromAdapter = null;
      try {
        fromAdapter = adapter.getMedia ? adapter.getMedia(video) : null;
      } catch (err) {
        console.debug("[Bingers Scrobbler] reader failed", err);
      }
      const found = BSParse.detect(fromAdapter, video, { topFrame });

      // Keep one title per video. A more reliable source may replace it; a different title from
      // an equal or weaker source is ignored once you're halfway (that's usually the "Next
      // episode" card or a recommendation, not what's playing).
      const progress = duration > 0 && video ? (video.currentTime / duration) * 100 : 0;
      if (found && !sameMedia(found, locked)) {
        if (!locked || found.rank < locked.rank || progress < 50) locked = found;
      } else if (found && locked && found.rank < locked.rank) {
        locked = found;
      }
      const media = locked;

      if (!video) {
        // No player in this frame, but it may know the title (the player lives in another frame).
        if (media) send({ service: adapter.service, media, noVideo: true });
        return;
      }
      const preview = video.muted && !userInteracted && !document.fullscreenElement;
      send({
        service: adapter.service,
        media,
        hint: media ? "" : BSParse.hint(), // raw text for the popup's "Fix it" form
        diag: media || tick % 6 !== 1 ? undefined : BSParse.diagnose(video), // every 30 s while unknown
        url: topFrame ? location.href : "",
        lang: document.documentElement.lang || navigator.language || "",
        position: video.currentTime,
        progress,
        duration,
        playing: !video.paused && !video.ended && video.readyState >= 2,
        counting: !preview,
      });
    }, POLL_MS);
  }

  globalThis.BingersScrobbler = { start, pickVideo };
})();
