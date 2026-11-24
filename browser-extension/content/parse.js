// Helpers shared by every streaming-site reader. Loaded as a plain script (content scripts
// can't be modules), so it publishes itself on globalThis.BSParse.
(() => {
  // "S1:E3", "S1 E3", "S01E03", "Season 1, Ep. 3", "Season 1 Episode 3", "T1:E3" (Spanish)
  const SEASON_EPISODE =
    /\b(?:S|T|Season|Temporada|Saison|Staffel)\s*(\d{1,3})\s*[:,.\-]?\s*(?:E|Ep|Episode|Épisode|Episodio|Folge|F)\.?\s*(\d{1,4})\b/i;
  // "E3", "Ep. 3", "Episode 3" with no season
  const EPISODE_ONLY = /\b(?:E|Ep|Episode|Épisode|Episodio|Folge)\.?\s*(\d{1,4})\b/i;

  /** Find a season and episode number in a piece of text. */
  function parseEpisode(text) {
    if (!text) return null;
    const s = String(text);
    let m = s.match(SEASON_EPISODE);
    if (m) return { season: Number(m[1]), episode: Number(m[2]) };
    m = s.match(EPISODE_ONLY);
    if (m) return { season: null, episode: Number(m[1]) };
    return null;
  }

  /** The text left after removing the season/episode marker, e.g. the episode's own title. */
  function stripEpisode(text) {
    return String(text || "")
      .replace(SEASON_EPISODE, "")
      .replace(EPISODE_ONLY, "")
      .replace(/^[\s:\-–—|·.,]+|[\s:\-–—|·.,]+$/g, "")
      .trim();
  }

  function clean(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  /** querySelector that also looks inside shadow DOM (some players use web components). */
  function deepQuery(selector, root = document) {
    const direct = root.querySelector(selector);
    if (direct) return direct;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.currentNode; node; node = walker.nextNode()) {
      if (node.shadowRoot) {
        const found = deepQuery(selector, node.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  /** First non-empty text among several selectors. */
  function firstText(selectors) {
    for (const sel of selectors) {
      const el = deepQuery(sel);
      const text = el && clean(el.textContent);
      if (text) return text;
    }
    return "";
  }

  /**
   * Build media info from a show/movie title and an optional "S1:E3 Episode name" line.
   * Returns null if there's no title.
   */
  function fromTitleAndSubtitle(title, subtitle) {
    title = clean(title);
    if (!title) return null;
    const ep = parseEpisode(subtitle);
    if (ep) return { title, season: ep.season, episode: ep.episode, episodeTitle: stripEpisode(subtitle) };
    return { title };
  }

  /**
   * What the page told the browser it's playing (the Media Session API, shown in the
   * Windows media controls). Used when a site reader finds nothing.
   */
  function fromMediaSession() {
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    if (!md || !clean(md.title)) return null;
    const fields = [md.title, md.artist, md.album].map(clean);
    const epField = fields.findIndex((f) => parseEpisode(f));
    if (epField === -1) return { title: fields[0] };
    const ep = parseEpisode(fields[epField]);
    // The show name is the field that isn't the "S1:E3 ..." one; prefer album, then title, then artist.
    const showName = [fields[2], fields[0], fields[1]].find((f, i) => f && [2, 0, 1][i] !== epField);
    const title = showName || stripEpisode(fields[epField]);
    if (!title) return null;
    return { title, season: ep.season, episode: ep.episode, episodeTitle: stripEpisode(fields[epField]) };
  }

  globalThis.BSParse = { parseEpisode, stripEpisode, clean, deepQuery, firstText, fromTitleAndSubtitle, fromMediaSession };
})();
