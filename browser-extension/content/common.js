// The loop every site reader shares: find the video, work out what's playing, report every 5 s.
//
// A page can have the title in one frame and the player in another (an embedded player from a
// different domain). Each frame reports what it knows; the background combines them per tab.
(() => {
  if (globalThis.__bingersScrobblerStarted) return; // injected twice (e.g. "Track this site")
  globalThis.__bingersScrobblerStarted = true;

  const POLL_MS = 5000;
  const MIN_DURATION = 60; // seconds; skips trailers, previews and ads

  /** The main video in this frame: playing first, then the longest. */
  function pickVideo() {
    const videos = [...document.querySelectorAll("video")].filter(
      (v) => Number.isFinite(v.duration) && v.duration >= MIN_DURATION
    );
    videos.sort((a, b) => Number(!b.paused) - Number(!a.paused) || b.duration - a.duration);
    return videos[0] || null;
  }

  function send(message) {
    if (!chrome.runtime?.id) return; // extension was reloaded or removed
    chrome.runtime.sendMessage({ type: "report", ...message }).catch(() => {});
  }

  /**
   * @param {{service: string, getMedia?: (video: HTMLVideoElement|null) => object|null,
   *          getVideo?: () => HTMLVideoElement|null, allowTitle?: boolean}} adapter
   */
  function start(adapter) {
    let lastUrl = location.href;
    let lastDuration = 0;
    let lastMedia = null;

    setInterval(() => {
      const video = (adapter.getVideo && adapter.getVideo()) || pickVideo();

      // A new page or a new video (different length) means the old title no longer applies.
      const duration = video ? video.duration : 0;
      if (location.href !== lastUrl || (video && Math.abs(duration - lastDuration) > 2)) {
        lastUrl = location.href;
        lastDuration = duration;
        lastMedia = null;
      }

      let fromAdapter = null;
      try {
        fromAdapter = adapter.getMedia ? adapter.getMedia(video) : null;
      } catch (err) {
        console.debug("[Bingers Scrobbler] reader failed", err);
      }
      let media = BSParse.detect(fromAdapter, { allowTitle: Boolean(adapter.allowTitle) && window === window.top });
      // Player overlays hide when idle; keep the last title we saw for this video.
      if (media) lastMedia = media;
      else media = lastMedia;

      if (!video) {
        // No player in this frame, but it may know the title (the player lives in another frame).
        if (media) send({ service: adapter.service, media, noVideo: true });
        return;
      }
      send({
        service: adapter.service,
        media,
        progress: duration > 0 ? (video.currentTime / duration) * 100 : 0,
        duration,
        playing: !video.paused && !video.ended && video.readyState >= 2,
      });
    }, POLL_MS);
  }

  globalThis.BingersScrobbler = { start, pickVideo };
})();
