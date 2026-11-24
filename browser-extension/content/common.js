// The loop every site reader shares: find the video, read what's playing, report every 5 s.
(() => {
  const POLL_MS = 5000;
  const MIN_DURATION = 60; // seconds; skips trailers, previews and ads

  /** The main video on the page: playing first, then the longest. */
  function pickVideo() {
    const videos = [...document.querySelectorAll("video")].filter(
      (v) => Number.isFinite(v.duration) && v.duration >= MIN_DURATION
    );
    videos.sort((a, b) => Number(!b.paused) - Number(!a.paused) || b.duration - a.duration);
    return videos[0] || null;
  }

  function start(adapter) {
    let lastUrl = location.href;
    let lastDuration = 0;
    let lastMedia = null;

    setInterval(() => {
      if (!chrome.runtime?.id) return; // extension was reloaded or removed

      const video = (adapter.getVideo && adapter.getVideo()) || pickVideo();
      if (!video) return;

      // A new page or a new video (different length) means the old title no longer applies.
      if (location.href !== lastUrl || Math.abs(video.duration - lastDuration) > 2) {
        lastUrl = location.href;
        lastDuration = video.duration;
        lastMedia = null;
      }

      let media = null;
      try {
        media = adapter.getMedia(video);
      } catch (err) {
        console.debug("[Bingers Scrobbler] reader failed", err);
      }
      if (!media || !media.title) media = BSParse.fromMediaSession();
      // Player overlays hide when idle; keep the last title we saw for this video.
      if (media && media.title) lastMedia = media;
      else media = lastMedia;

      const duration = video.duration;
      chrome.runtime
        .sendMessage({
          type: "report",
          service: adapter.service,
          media,
          progress: duration > 0 ? (video.currentTime / duration) * 100 : 0,
          duration,
          playing: !video.paused && !video.ended && video.readyState >= 2,
        })
        .catch(() => {});
    }, POLL_MS);
  }

  globalThis.BingersScrobbler = { start, pickVideo };
})();
