// Netflix. First choice: Netflix's own metadata for the video in the address (/watch/<id>),
// the same source the Trakt extension uses; it doesn't depend on what's shown on screen.
// Backup: the player's title box (show in an h4, "S1:E3" and the episode name in spans).
(() => {
  const cache = new Map(); // watch id -> media, or null while loading / after a failure
  let buildId = null;

  function findBuildId() {
    if (buildId) return buildId;
    for (const s of document.querySelectorAll("script:not([src])")) {
      const m = s.textContent.match(/"BUILD_IDENTIFIER"\s*:\s*"([^"]+)"/);
      if (m) return (buildId = m[1]);
    }
    return null;
  }

  async function load(id) {
    cache.set(id, null);
    const build = findBuildId();
    if (!build) return;
    try {
      const resp = await fetch(`/nq/website/memberapi/${build}/metadata?movieid=${id}`, { credentials: "include" });
      if (!resp.ok) return;
      const video = (await resp.json()).video;
      if (!video || !video.title) return;
      if (video.type === "movie") {
        cache.set(id, { title: video.title, ...(video.year ? { year: video.year } : {}) });
        return;
      }
      const wanted = [Number(id), Number(video.currentEpisode)];
      for (const season of video.seasons || []) {
        for (const ep of season.episodes || []) {
          if (wanted.includes(Number(ep.id ?? ep.episodeId))) {
            cache.set(id, { title: video.title, season: season.seq, episode: ep.seq, episodeTitle: ep.title || "" });
            return;
          }
        }
      }
    } catch {
      /* Netflix changed something: the on-screen reader below takes over */
    }
  }

  function fromScreen() {
    const box = BSParse.deepQuery('[data-uia="video-title"]');
    if (!box) return null;
    const show = BSParse.clean(box.querySelector("h4")?.textContent || "");
    const parts = [...box.querySelectorAll("span")].map((s) => BSParse.clean(s.textContent));
    if (show) {
      const epText = parts.find((p) => BSParse.parseEpisode(p));
      if (!epText) return { title: show }; // a movie
      const ep = BSParse.parseEpisode(epText);
      const episodeTitle = parts.find((p) => p && p !== epText) || "";
      return { title: show, season: ep.season, episode: ep.episode, episodeTitle };
    }
    const text = BSParse.clean(box.textContent);
    return text ? BSParse.parseMediaText(text, { strong: true }) : null;
  }

  BingersScrobbler.start({
    service: "netflix",
    getMedia() {
      const m = location.pathname.match(/^\/watch\/(\d+)/);
      if (!m) return null; // browsing, previews and trailers on other pages are ignored
      if (!cache.has(m[1])) load(m[1]);
      return cache.get(m[1]) || fromScreen();
    },
  });
})();
