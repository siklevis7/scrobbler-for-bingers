// Runs in the page itself (not the extension's isolated world), so it can ask the site's video
// player software what it's playing. Many smaller streaming sites use off-the-shelf players
// that keep the title in their settings. It only reads, and posts what it finds to the
// extension's content script on the same page.
(() => {
  if (window.__bingersProbe) return;
  window.__bingersProbe = true;

  const text = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);

  function collect() {
    const out = [];
    const add = (...values) => values.forEach((v) => text(v) && out.push(text(v)));
    const attempt = (fn) => {
      try {
        fn();
      } catch {
        /* that player isn't on this page */
      }
    };

    // JW Player
    attempt(() => {
      if (typeof window.jwplayer !== "function") return;
      for (let i = 0; i < 4; i++) {
        const p = window.jwplayer(i);
        if (!p || typeof p.getPlaylistItem !== "function") break;
        const item = p.getPlaylistItem() || {};
        add(item.title, item.name);
      }
    });
    // Video.js (also Brightcove)
    attempt(() => {
      const vjs = window.videojs;
      if (!vjs || typeof vjs.getPlayers !== "function") return;
      for (const p of Object.values(vjs.getPlayers())) {
        if (!p) continue;
        add(p.mediainfo && p.mediainfo.name, p.options_ && p.options_.title);
        const item = typeof p.playlist === "function" && typeof p.playlist.currentItem === "function" ? p.playlist()[p.playlist.currentItem()] : null;
        if (item) add(item.name, item.title);
      }
    });
    // Plyr
    attempt(() => {
      for (const el of document.querySelectorAll(".plyr, [data-plyr-provider]")) {
        const p = el.plyr || (el.querySelector("video") || {}).plyr;
        if (p && p.config) add(p.config.title);
      }
    });
    // Flowplayer
    attempt(() => {
      const fp = window.flowplayer;
      if (fp && Array.isArray(fp.instances)) for (const i of fp.instances) add(i.video && i.video.title, i.opts && i.opts.title);
    });
    // Bitmovin, Clappr, DPlayer, ArtPlayer, Shaka UIs often live in a global variable.
    for (const name of ["player", "bitmovinPlayer", "dp", "art", "clappr", "videoPlayer"]) {
      attempt(() => {
        const p = window[name];
        if (!p || typeof p !== "object") return;
        if (typeof p.getSource === "function") add((p.getSource() || {}).title);
        if (p.options) add(p.options.title, p.options.video && p.options.video.title);
        if (p.option) add(p.option.title);
        if (p.config) add(p.config.title);
      });
    }
    return [...new Set(out)].slice(0, 10);
  }

  setInterval(() => {
    const items = collect();
    window.postMessage({ __bingersProbe: true, items }, "*");
  }, 5000);
})();
