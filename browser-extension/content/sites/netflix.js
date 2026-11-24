// Netflix: the player's title box holds the show (h4) and "S1:E3" + episode name (spans).
BingersScrobbler.start({
  service: "netflix",
  getMedia() {
    if (!location.pathname.startsWith("/watch")) return null;
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
    // Movies sometimes have just the title as text.
    const text = BSParse.clean(box.textContent);
    return text ? { title: text } : null;
  },
});
