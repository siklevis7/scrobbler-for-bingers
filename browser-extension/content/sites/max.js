// Max / HBO Max: the player shows the title and "S1 E3: Episode name".
BingersScrobbler.start({
  service: "max",
  getMedia() {
    const title = BSParse.firstText([
      '[data-testid="player-ux-asset-title"]',
      '[data-testid="player-ux-title"]',
    ]);
    const subtitle = BSParse.firstText([
      '[data-testid="player-ux-season-episode"]',
      '[data-testid="player-ux-asset-subtitle"]',
    ]);
    return BSParse.fromTitleAndSubtitle(title, subtitle);
  },
});
