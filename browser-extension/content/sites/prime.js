// Prime Video (primevideo.com and Amazon's own sites): the web player shows the title and a
// subtitle like "Season 1, Ep. 3 Episode name".
BingersScrobbler.start({
  service: "prime",
  getVideo() {
    const container = document.querySelector(".webPlayerSDKContainer, #dv-web-player");
    if (!container) return null; // not on a video page (e.g. shopping on amazon.com)
    const videos = [...container.querySelectorAll("video")].filter(
      (v) => Number.isFinite(v.duration) && v.duration >= 60
    );
    videos.sort((a, b) => b.duration - a.duration);
    return videos[0] || null;
  },
  getMedia() {
    const title = BSParse.firstText([".atvwebplayersdk-title-text", '[data-testid="title-text"]']);
    const subtitle = BSParse.firstText([".atvwebplayersdk-subtitle-text", '[data-testid="subtitle-text"]']);
    return BSParse.fromTitleAndSubtitle(title, subtitle);
  },
});
