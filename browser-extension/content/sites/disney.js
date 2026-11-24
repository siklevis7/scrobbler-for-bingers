// Disney+: the player shows the title and a subtitle like "S1:E3 Episode name".
// Newer players put these inside web components, so deepQuery looks into shadow DOM.
BingersScrobbler.start({
  service: "disney",
  getMedia() {
    if (!/\/(play|video)\//.test(location.pathname)) return null;
    const title = BSParse.firstText([
      ".title-field",
      '[data-testid="title-field"]',
      '[data-testid="playback-title"]',
    ]);
    const subtitle = BSParse.firstText([
      ".subtitle-field",
      '[data-testid="subtitle-field"]',
      '[data-testid="playback-subtitle"]',
    ]);
    return BSParse.fromTitleAndSubtitle(title, subtitle);
  },
});
