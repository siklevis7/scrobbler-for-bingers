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

  // -- universal readers: work on sites we have no specific code for ---------------------

  const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const typesOf = (node) => asArray(node && node["@type"]).map((t) => String(t).toLowerCase());
  const nameOf = (v) => clean(typeof v === "string" ? v : v && v.name);
  const yearOf = (v) => {
    const m = String(v || "").match(/\b(19|20)\d{2}\b/);
    return m ? Number(m[0]) : null;
  };

  /**
   * Show/movie info from the structured data streaming sites publish for search engines:
   * schema.org JSON-LD blocks and Open Graph meta tags. Pure function, so it's testable.
   * @param {string[]} jsonLdTexts  contents of <script type="application/ld+json"> tags
   * @param {Record<string,string>} meta  Open Graph / video meta tags by property name
   */
  function parseStructuredData(jsonLdTexts, meta = {}) {
    const nodes = [];
    const visit = (n) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(visit);
      nodes.push(n);
      if (n["@graph"]) visit(n["@graph"]);
    };
    for (const text of jsonLdTexts || []) {
      try {
        visit(JSON.parse(text));
      } catch {
        /* sites sometimes ship broken JSON; skip it */
      }
    }

    for (const n of nodes) {
      const types = typesOf(n);
      if (types.some((t) => t === "tvepisode" || t === "episode")) {
        const series = nameOf(n.partOfSeries) || nameOf(n.partOfTVSeries) || nameOf(n.partOfSeason?.partOfSeries);
        const episode = Number(n.episodeNumber);
        if (series && Number.isInteger(episode)) {
          const season = Number(n.partOfSeason?.seasonNumber ?? n.seasonNumber);
          return {
            title: series,
            season: Number.isInteger(season) ? season : null,
            episode,
            episodeTitle: nameOf(n.name),
          };
        }
      }
    }
    for (const n of nodes) {
      if (typesOf(n).includes("movie") && nameOf(n.name)) {
        return { title: nameOf(n.name), year: yearOf(n.datePublished || n.dateCreated || n.releasedEvent?.startDate) };
      }
    }

    const ogType = String(meta["og:type"] || "").toLowerCase();
    const ogTitle = clean(meta["og:title"]);
    if (ogType === "video.episode" && ogTitle) {
      const ep = parseEpisode(ogTitle);
      const series = clean(meta["video:series"]) || (ep ? clean(ogTitle.split(SEASON_EPISODE)[0]).replace(/[\s:\-–—|]+$/, "") : "");
      if (ep && series) return { title: series, season: ep.season, episode: ep.episode, episodeTitle: "" };
    }
    if (ogType === "video.movie" && ogTitle) {
      return { title: ogTitle.replace(/\s*\((19|20)\d{2}\)\s*$/, ""), year: yearOf(meta["video:release_date"] || ogTitle) };
    }
    return null;
  }

  /**
   * Last resort: the tab title, e.g. "Watch Severance S1E4 | SomeSite" or "Heat (1995) - SomeSite".
   * Only trusted when it clearly names an episode or a film year, so "Home | SomeSite" is ignored.
   */
  function parseDocumentTitle(title, siteName = "") {
    const site = String(siteName || "").toLowerCase().replace(/^www\./, "").split(".")[0];
    const parts = String(title || "")
      .split(/\s+[|•·]\s+|\s+[-–—]\s+(?=[^-–—]*$)/)
      .map((p) => clean(p.replace(/^(watch|now playing|streaming)\s*:?\s+/i, "")))
      .filter((p) => p && !(site && p.toLowerCase().replace(/[^a-z0-9]/g, "").includes(site.replace(/[^a-z0-9]/g, ""))));
    for (const part of parts) {
      const m = part.match(SEASON_EPISODE);
      if (m) {
        const show = clean(part.slice(0, m.index)).replace(/[\s:\-–—,]+$/, "");
        if (show) return { title: show, season: Number(m[1]), episode: Number(m[2]), episodeTitle: stripEpisode(part.slice(m.index)) };
      }
      const y = part.match(/^(.+?)\s*\(((?:19|20)\d{2})\)$/);
      if (y) return { title: clean(y[1]), year: Number(y[2]) };
    }
    return null;
  }

  /** DOM wrapper for parseStructuredData. */
  function fromStructuredData() {
    const texts = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent);
    const meta = {};
    for (const el of document.querySelectorAll("meta[property], meta[name]")) {
      const key = (el.getAttribute("property") || el.getAttribute("name") || "").toLowerCase();
      if (key.startsWith("og:") || key.startsWith("video:")) meta[key] = el.getAttribute("content") || "";
    }
    return parseStructuredData(texts, meta);
  }

  function fromDocumentTitle() {
    return parseDocumentTitle(document.title, location.hostname);
  }

  /**
   * Try every way of finding out what's playing, most reliable first, and note where it came from.
   * `allowTitle` enables the tab-title fallback (only for sites the user added themselves).
   */
  function detect(adapterMedia, { allowTitle = false } = {}) {
    const tries = [
      ["player", () => adapterMedia],
      ["media controls", fromMediaSession],
      ["page data", fromStructuredData],
      ["tab title", () => (allowTitle ? fromDocumentTitle() : null)],
    ];
    for (const [source, get] of tries) {
      let media = null;
      try {
        media = get();
      } catch {
        media = null;
      }
      if (media && media.title) return { ...media, source };
    }
    return null;
  }

  globalThis.BSParse = {
    parseEpisode,
    stripEpisode,
    clean,
    deepQuery,
    firstText,
    fromTitleAndSubtitle,
    fromMediaSession,
    parseStructuredData,
    parseDocumentTitle,
    fromStructuredData,
    fromDocumentTitle,
    detect,
  };
})();
