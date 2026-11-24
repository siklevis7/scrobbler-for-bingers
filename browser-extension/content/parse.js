// Works out what's playing from whatever text a page offers. Shared by every site reader.
// Loaded as a plain script (content scripts can't be modules), so it publishes globalThis.BSParse.
(() => {
  // -- patterns --------------------------------------------------------------------------

  // "Part"/"Vol"/"Book" count as a season only when an episode follows ("Part 3: Episode 2"),
  // so film titles like "Dune Part Two" are untouched.
  const SEASON_WORDS = "S|T|P|Season|Series|Temporada|Saison|Staffel|Stagione|Sezon|Seizoen|Säsong|Sæson|Sesong|Kausi|Évad|Part|Pt|Partie|Parte|Teil|Vol|Volume|Book|Сезон";
  const EP_WORDS = "E|Ep|Eps|Episode|Épisode|Episodio|Episódio|Folge|Aflevering|Avsnitt|Afsnit|Jakso|Rész|Odcinek|Bölüm|Capitulo|Capítulo|Cap|Chapter|Chapitre|Серия|Эпизод";
  const SEP = "[\\s._:,\\-–—]*"; // what may sit between "Season", "2", "Episode", "3"
  const START = "(?<![A-Za-z0-9])"; // like \b, but "_" counts as a separator (file names)

  // "S02E11", "S2 E11", "S1:E3", "S02.E03", "Season 1, Ep. 3", "Season 2 Episode 10", "T2:E5", "Staffel 3 Folge 4"
  const SEASON_EPISODE = new RegExp(
    `${START}(?:${SEASON_WORDS})${SEP}(\\d{1,3})${SEP}(?:${EP_WORDS})\\.?${SEP}(\\d{1,4})(?!\\d)`,
    "i"
  );
  // "1x04"; the look-behind keeps "1920x1080" from matching
  const X_FORMAT = /(?<![A-Za-z0-9])(\d{1,2})x(\d{1,3})(?!\d)/i;
  // "E05", "Ep. 7", "Episode 3" with no season
  const EPISODE_ONLY = new RegExp(`${START}(?:${EP_WORDS})\\.?${SEP}(\\d{1,4})(?!\\d)`, "i");
  // Scripts without spaces or with the number first: Chinese, Japanese, Korean, Russian, Arabic.
  const OTHER_SCRIPTS = [
    [/第\s*(\d{1,3})\s*[季期部]\s*第?\s*(\d{1,4})\s*[集話话回]/, 1, 2], // 第2季 第3集 / 第2期 第3話
    [/(?:シーズン|시즌)\s*(\d{1,3})[\s第]*(\d{1,4})\s*[話回화]/, 1, 2], // シーズン2 第3話 / 시즌 2 3화
    [/(\d{1,3})\s*сезон[\s,.:-]*(\d{1,4})\s*(?:серия|эпизод)/i, 1, 2], // 2 сезон 3 серия
    [/الموسم\s*(\d{1,3}).{0,20}?الحلقة\s*(\d{1,4})/, 1, 2], // الموسم 2 الحلقة 3
    [/第\s*(\d{1,4})\s*[集話话回]/, null, 1], // 第3集
    [/(?<![\d])(\d{1,4})\s*화(?![가-힣])/, null, 1], // 3화
    [/الحلقة\s*(\d{1,4})/, null, 1], // الحلقة 3
  ];
  // "Season 2" on its own (e.g. a Jellyfin album name) gives just the season.
  const SEASON_ONLY = new RegExp(`${START}(?:Season|Series|Saison|Temporada|Staffel|Stagione|Sezon|Seizoen|Сезон)${SEP}(\\d{1,3})(?!\\d)|第\\s*(\\d{1,3})\\s*季`, "i");
  // "Episode One", "Season Two", "Chapter Three"
  const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
  // Not "Part"/"Volume": "Dune: Part Two" is a film title and must stay as it is.
  const WORD_NUMBER = new RegExp(`\\b(Season|Series|Episode|Chapter)\\s+(${NUMBER_WORDS.join("|")})\\b`, "gi");
  const wordsToNumbers = (s) => String(s || "").replace(WORD_NUMBER, (_, w, n) => `${w} ${NUMBER_WORDS.indexOf(n.toLowerCase())}`);

  const FILE_EXT = /\.(mkv|mp4|m4v|avi|mov|wmv|webm|flv|ts|mpg|mpeg)$/i;
  const words = (list) => new RegExp(`(?<![A-Za-z0-9])(?:${list.join("|")})(?![A-Za-z0-9])`, "i");
  // Release details that end a title in file names. Words like "web" only count in file names,
  // so a title such as "Charlotte's Web" survives in normal text.
  const STRONG_JUNK = words(["\\d{3,4}p", "4k", "x26[45]", "h[ .]?26[45]", "hevc", "web[ .-]?dl", "web[ .-]?rip", "blu[ .-]?ray", "bdrip", "brrip", "hdtv", "hdrip", "dvdrip"]);
  const FILE_JUNK = words([
    "\\d{3,4}p", "4k", "uhd", "hdr(?:10)?\\+?", "dv", "dolby[ .]?vision", "web[ .-]?dl", "web[ .-]?rip", "web",
    "blu[ .-]?ray", "bdrip", "brrip", "hdtv", "hdrip", "dvdrip", "dvd", "x26[45]", "h[ .]?26[45]", "hevc", "avc",
    "10[ .]?bit", "8[ .]?bit", "aac\\d?", "ddp?\\d?", "eac3", "ac3", "dts", "atmos", "\\dch", "proper", "repack",
    "extended", "remastered", "unrated", "imax", "nf", "amzn", "dsnp", "hmax", "atvp", "multi", "dual[ .-]?audio",
    "subbed", "dubbed", "esubs?", "internal", "complete",
  ]);
  const LEADING_FILLER = /^(?:(?:watch(?:ing)?|now playing|now streaming|streaming|you(?:'re| are) watching)\s*[:\-–—]?\s+|playing\s*:\s*)/i;
  const TRAILING_FILLER = /\s+(?:online(?: for)?(?: free)?|free online|full (?:episodes?|movie)|in hd|hd|streaming)\s*$/i;
  const BRANDS = /^(netflix|prime video|amazon(?: prime)?(?: video)?|disney\+?|max|hbo max|hulu|apple tv\+?|paramount\+?|peacock|crunchyroll|youtube|telegram|official site|home)$/i;
  const PART_SPLIT = /\s+[|•·]\s+|\s+[-–—]\s+/;

  const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
  const trimSeparators = (s) => clean(String(s || "").replace(/^[\s:\-–—|·•.,_]+|[\s:\-–—|·•.,_(]+$/g, ""));

  function matchEpisode(text) {
    const s = String(text || "");
    let m = s.match(SEASON_EPISODE);
    if (m) return { index: m.index, length: m[0].length, season: Number(m[1]), episode: Number(m[2]) };
    m = s.match(X_FORMAT);
    if (m) return { index: m.index, length: m[0].length, season: Number(m[1]), episode: Number(m[2]) };
    for (const [re, si, ei] of OTHER_SCRIPTS) {
      m = s.match(re);
      if (m) return { index: m.index, length: m[0].length, season: si ? Number(m[si]) : null, episode: Number(m[ei]) };
    }
    m = s.match(EPISODE_ONLY);
    if (m) return { index: m.index, length: m[0].length, season: null, episode: Number(m[1]) };
    return null;
  }

  /** Find a season and episode number in a piece of text. */
  function parseEpisode(text) {
    const m = matchEpisode(wordsToNumbers(String(text || "").replace(/_/g, " ")));
    return m ? { season: m.season, episode: m.episode } : null;
  }

  /** Just a season number ("Season 2"), or null. */
  function parseSeason(text) {
    const m = String(text || "").match(SEASON_ONLY);
    return m ? Number(m[1] ?? m[2]) : null;
  }

  /** "Doctor Who (2005)" -> { title: "Doctor Who", year: 2005 } */
  function splitYear(title) {
    const m = String(title || "").match(/^(.+?)\s*\(((?:19|20)\d{2})\)$/);
    return m ? { title: trimSeparators(m[1]), year: Number(m[2]) } : { title, year: null };
  }

  /** The text left after removing the season/episode marker, e.g. the episode's own title. */
  function stripEpisode(text) {
    const s = String(text || "");
    const m = matchEpisode(s);
    return m ? trimSeparators(s.slice(0, m.index) + " " + s.slice(m.index + m.length)) : trimSeparators(s);
  }

  function cutAtJunk(s, filename) {
    const m = s.match(filename ? FILE_JUNK : STRONG_JUNK);
    return m ? s.slice(0, m.index) : s;
  }

  /** The site's own name from its address: "play.max.com" -> "max", "www.bbc.co.uk" -> "bbc". */
  function siteKey(site) {
    const labels = String(site || "").toLowerCase().split(".").filter(Boolean);
    if (labels.length < 2) return labels[0] || "";
    let i = labels.length - 2;
    if (labels[i].length <= 3 && i > 0 && labels[labels.length - 1].length <= 2) i -= 1; // co.uk, com.br
    return labels[i].replace(/[^a-z0-9]/g, "");
  }

  /**
   * The workhorse: turn any title-ish text into { title, season, episode, episodeTitle } or
   * { title, year }. Handles file names ("Most_Dangerous_Game_S02E11_720p_x265.mkv"),
   * tab titles ("Watch Ozark Season 2 Episode 3 | SomeSite"), and plain names.
   * @param {string} text
   * @param {{site?: string, strong?: boolean}} opts  strong: trust a bare name as a movie title
   *   (only for sources that are clearly about the video, e.g. the media controls)
   */
  function parseMediaText(text, { site = "", strong = false } = {}) {
    let s = clean(wordsToNumbers(text));
    if (!s) return null;

    const filename = FILE_EXT.test(s) || (!/\s/.test(s) && /[._]/.test(s)) || (s.match(/_/g) || []).length >= 2;
    s = s.replace(FILE_EXT, "");
    if (filename) s = s.replace(/[._]+/g, " ");
    s = clean(s.replace(/\[[^\]]*\]|\{[^}]*\}/g, " ")); // [release group], {tags}

    // Split "Show - Season 1 Episode 2 - Name | Site" into parts and drop the site's own name.
    const key = siteKey(site);
    const parts = s
      .split(PART_SPLIT)
      .map((p) => clean(p.replace(LEADING_FILLER, "").replace(TRAILING_FILLER, "")))
      .filter((p) => p && !BRANDS.test(p) && !(key.length > 2 && p.toLowerCase().replace(/[^a-z0-9]/g, "") === key))
      // "SomeSite.com", "SomeSite TV": drop parts that are about the site, if there's more to keep
      .filter((p) => !(key.length > 3 && PART_SPLIT.test(s) && p.toLowerCase().replace(/[^a-z0-9]/g, "").includes(key)));
    if (!parts.length) return null;
    const joined = parts.join(" | ");

    const ep = matchEpisode(joined);
    if (ep) {
      let title = trimSeparators(cutAtJunk(joined.slice(0, ep.index), filename));
      if (title.includes(" | ")) title = trimSeparators(title.split(" | ").pop());
      let rest = joined.slice(ep.index + ep.length);
      let episodeTitle = trimSeparators(cutAtJunk(rest.split(" | ").find((x) => trimSeparators(x)) || "", filename));
      if (!title) {
        // "S4:E12 Trouble the Water | Ozark": the show is another part
        const others = parts.filter((p) => !matchEpisode(p));
        title = trimSeparators(others[others.length - 1] || "");
        if (title === episodeTitle) episodeTitle = "";
      }
      if (!title) return null;
      const { title: name, year } = splitYear(title);
      const out = { title: name, season: ep.season, episode: ep.episode, episodeTitle };
      if (year) out.year = year;
      return out;
    }

    // Anime-style file names: "[Group] Frieren - 12 (1080p).mkv" (a bare number after the title).
    if (filename && parts.length >= 2) {
      const num = trimSeparators(cutAtJunk(parts[1], true)).match(/^(\d{1,4})(?:v\d)?$/);
      const show = trimSeparators(cutAtJunk(parts[0], true));
      if (num && show && !/^(19|20)\d{2}$/.test(num[1])) return { title: show, season: null, episode: Number(num[1]), episodeTitle: "" };
    }

    // No episode: a movie, ideally with a year at the end ("Heat (1995)", "Dune Part Two 2024 2160p").
    const base = trimSeparators(cutAtJunk(parts[0], filename));
    const year = base.match(/^(.+?)[\s.(\[]*((?:19|20)\d{2})[)\]]?$/);
    if (year && trimSeparators(year[1])) return { title: trimSeparators(year[1]), year: Number(year[2]) };
    if (strong && base) return { title: base };
    return null;
  }

  // -- DOM helpers -----------------------------------------------------------------------

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

  /** Media info from a show/movie title and an optional "S1:E3 Episode name" line. */
  function fromTitleAndSubtitle(title, subtitle) {
    title = clean(title);
    if (!title) return null;
    const ep = parseEpisode(subtitle);
    if (ep) return { title, season: ep.season, episode: ep.episode, episodeTitle: stripEpisode(subtitle) };
    // The title line itself may hold everything ("Ozark: S2 E3").
    const inTitle = parseMediaText(title, { strong: true });
    return inTitle || { title };
  }

  // -- readers, from most to least reliable -----------------------------------------------

  /**
   * What the page told the browser it's playing (the Media Session API, shown in the
   * Windows media controls and on media keys).
   */
  function fromMediaSession(site = "") {
    const md = typeof navigator !== "undefined" && navigator.mediaSession && navigator.mediaSession.metadata;
    if (!md || !clean(md.title)) return null;
    const [title, artist, album] = [md.title, md.artist, md.album].map(clean);

    // A field that holds everything, e.g. a file name "Show_S02E11_720p.mkv" or "Ozark S2 E3".
    for (const f of [title, album, artist]) {
      const r = f && parseMediaText(f, { site });
      if (r && r.episode != null) return r;
    }
    // Episode marker in one field ("S4:E12 Trouble the Water"), show name in another.
    const fields = [title, artist, album];
    const epField = fields.findIndex((f) => parseEpisode(f));
    if (epField !== -1) {
      const ep = parseEpisode(fields[epField]);
      const order = [2, 0, 1]; // album, then title, then artist
      const showIdx = order.find((i) => i !== epField && fields[i]);
      const show = showIdx !== undefined ? parseMediaText(fields[showIdx], { site, strong: true })?.title : "";
      const name = show || stripEpisode(fields[epField]);
      if (name) return { title: name, season: ep.season, episode: ep.episode, episodeTitle: stripEpisode(fields[epField]) };
    }
    // A movie: trust the title only when nothing else is filled in (otherwise it's often an
    // episode name with the show in "artist").
    if (!artist && !album) return parseMediaText(title, { site, strong: true });
    const withYearOnly = parseMediaText(title, { site }); // "Heat (1995)"
    if (withYearOnly) return withYearOnly;
    // "Trouble the Water" by "Ozark" (Jellyfin, Plex and others): the show and the episode's name,
    // with no numbers. The background looks the episode up on Bingers by its name.
    const season = parseSeason(album) ?? parseSeason(artist);
    const show = [artist, album].find((f) => f && parseSeason(f) === null && f !== title);
    if (show) return { title: show, episodeTitle: title, season, episode: null, lookup: true };
    return null;
  }

  const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const typesOf = (node) => asArray(node && node["@type"]).map((t) => String(t).toLowerCase());
  const nameOf = (v) => clean(typeof v === "string" ? v : v && v.name);
  const yearOf = (v) => {
    const m = String(v || "").match(/\b(19|20)\d{2}\b/);
    return m ? Number(m[0]) : null;
  };
  const withYear = (title, year) => (year ? { title, year } : { title });

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
      if (typesOf(n).some((t) => t === "tvepisode" || t === "episode")) {
        const series = nameOf(n.partOfSeries) || nameOf(n.partOfTVSeries) || nameOf(n.partOfSeason?.partOfSeries);
        const episode = Number(n.episodeNumber);
        if (series && Number.isInteger(episode)) {
          const season = Number(n.partOfSeason?.seasonNumber ?? n.seasonNumber);
          return { title: series, season: Number.isInteger(season) ? season : null, episode, episodeTitle: nameOf(n.name) };
        }
        // Some sites only give the episode's own name; its title text may still say "Show S1E2".
        const fromName = parseMediaText(nameOf(n.name));
        if (fromName && fromName.episode != null) return fromName;
      }
    }
    for (const n of nodes) {
      if (typesOf(n).includes("movie") && nameOf(n.name)) {
        return withYear(nameOf(n.name), yearOf(n.datePublished || n.dateCreated || n.releasedEvent?.startDate));
      }
    }

    const ogType = String(meta["og:type"] || "").toLowerCase();
    const ogTitle = clean(meta["og:title"]);
    if (ogType === "video.episode" && ogTitle) {
      const parsed = parseMediaText(ogTitle);
      const series = clean(meta["video:series"]);
      if (parsed && parsed.episode != null) return series ? { ...parsed, title: series } : parsed;
    }
    if (ogType === "video.movie" && ogTitle) {
      const parsed = parseMediaText(ogTitle, { strong: true });
      if (parsed) return withYear(parsed.title, parsed.year || yearOf(meta["video:release_date"]));
    }
    // Any page: a title tag that clearly names an episode or a film year.
    for (const key of ["og:title", "twitter:title", "title", "itemprop:name"]) {
      const parsed = meta[key] && parseMediaText(meta[key]);
      if (parsed) return parsed;
    }
    return null;
  }

  // Keys sites use in their embedded app data, including Plex (grandparentTitle/parentIndex/index)
  // and Jellyfin/Emby (SeriesName/ParentIndexNumber/IndexNumber).
  const SERIES_KEYS = ["seriesTitle", "series_title", "seriesName", "series_name", "SeriesName", "showTitle", "show_title", "showName", "show_name", "tvShowTitle", "programTitle", "grandparentTitle", "series", "show", "tvShow", "program"];
  const SEASON_KEYS = ["seasonNumber", "season_number", "seasonNum", "ParentIndexNumber", "parentIndex", "season"];
  const EPISODE_KEYS = ["episodeNumber", "episode_number", "episodeNum", "IndexNumber", "episode", "index", "number"];
  const ID_KEYS = ["id", "Id", "guid", "slug", "videoId", "video_id", "contentId", "content_id", "episodeId", "assetId", "ratingKey", "urlName"];

  const asText = (v) => (typeof v === "string" ? clean(v) : v && typeof v === "object" ? clean(v.title || v.name || v.Name || "") : "");
  const asInt = (v) => {
    const n = typeof v === "object" && v ? Number(v.number ?? v.seasonNumber ?? v.index) : Number(v);
    return Number.isInteger(n) && n >= 0 && n < 10000 ? n : null;
  };

  /**
   * Episode info from the JSON app data modern sites embed (Next.js __NEXT_DATA__, Nuxt, Plex,
   * Jellyfin…). Pages often list many episodes, so a candidate only wins if it's the only one or
   * its id appears in the web address.
   * @param {string[]} jsonTexts
   * @param {string} href  the page address
   */
  function parseAppData(jsonTexts, href = "") {
    const found = [];
    const seen = new Set();
    const visit = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 40 || found.length > 200 || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) return node.slice(0, 500).forEach((n) => visit(n, depth + 1));
      const series = SERIES_KEYS.map((k) => asText(node[k])).find(Boolean);
      const episode = EPISODE_KEYS.map((k) => asInt(node[k])).find((n) => n !== null);
      if (series && episode !== null && episode !== undefined) {
        const season = SEASON_KEYS.map((k) => asInt(node[k])).find((n) => n !== null) ?? null;
        const ids = ID_KEYS.map((k) => node[k]).filter((v) => (typeof v === "string" && v.length >= 3) || typeof v === "number");
        found.push({ title: series, season, episode, episodeTitle: asText(node.title || node.name || node.Name), ids });
      }
      for (const v of Object.values(node)) if (v && typeof v === "object") visit(v, depth + 1);
    };
    for (const text of jsonTexts || []) {
      if (!text || text.length > 3_000_000) continue;
      try {
        visit(JSON.parse(text), 0);
      } catch {
        /* not JSON */
      }
    }
    if (!found.length) return null;
    const inUrl = found.filter((f) => f.ids.some((id) => String(href).includes(String(id))));
    const pick = inUrl.length ? inUrl[0] : found.length === 1 ? found[0] : null;
    if (!pick) return null;
    const { ids, ...media } = pick;
    if (media.episodeTitle === media.title) media.episodeTitle = "";
    return media;
  }

  /** The tab title, e.g. "Watch Ozark Season 2 Episode 3 | SomeSite" or "Heat (1995) - Site". */
  function parseDocumentTitle(title, site = "") {
    return parseMediaText(title, { site });
  }

  const URL_FILLER = new Set(["watch", "tv", "show", "shows", "series", "movie", "movies", "film", "films", "video", "videos", "play", "player", "title", "titles", "detail", "details", "embed", "stream", "streaming", "en", "us", "uk", "gb", "de", "fr", "es", "it", "vod", "media", "content", "browse", "k", "a"]);

  /** The web address, e.g. "/watch/ozark-season-2-episode-3" or "/tv/ozark/s02e03". */
  function parseUrl(pathname) {
    const tokens = decodeURIComponent(String(pathname || ""))
      .split("/")
      .flatMap((seg) => seg.split(/[-_+.]+/))
      .map((t) => t.trim())
      .filter((t) => t && !URL_FILLER.has(t.toLowerCase()))
      .filter((t) => !/^\d{5,}$/.test(t) && !(/\d/.test(t) && /[a-z]/i.test(t) && t.length >= 8 && !SEASON_EPISODE.test(t)));
    if (!tokens.length) return null;
    const parsed = parseMediaText(tokens.join(" "));
    if (!parsed) return null;
    // URLs are lower-case; make the title readable for display.
    parsed.title = parsed.title.replace(/\b\w/g, (c) => c.toUpperCase());
    return parsed;
  }

  // DOM wrappers ------------------------------------------------------------------------

  function pageMeta() {
    const meta = {};
    for (const el of document.querySelectorAll("meta[property], meta[name], meta[itemprop]")) {
      const raw = el.getAttribute("property") || el.getAttribute("name") || "";
      const key = raw ? raw.toLowerCase() : `itemprop:${(el.getAttribute("itemprop") || "").toLowerCase()}`;
      if (/^(og:|video:|twitter:title|title$|itemprop:name)/.test(key) && !meta[key]) meta[key] = el.getAttribute("content") || "";
    }
    return meta;
  }

  /** schema.org microdata: <div itemscope itemtype="https://schema.org/TVEpisode">… */
  function fromMicrodata() {
    const ep = document.querySelector('[itemtype*="schema.org/TVEpisode" i], [itemtype*="schema.org/Episode" i]');
    if (ep) {
      const prop = (root, name) => {
        const el = root && root.querySelector(`[itemprop="${name}"]`);
        return el ? clean(el.getAttribute("content") || el.textContent) : "";
      };
      const seriesEl = ep.querySelector('[itemprop="partOfSeries"], [itemprop="partOfTVSeries"]') ||
        document.querySelector('[itemtype*="schema.org/TVSeries" i]');
      const seasonEl = ep.querySelector('[itemprop="partOfSeason"]');
      const series = prop(seriesEl, "name");
      const episode = Number(prop(ep, "episodeNumber"));
      if (series && Number.isInteger(episode)) {
        const season = Number(prop(seasonEl, "seasonNumber"));
        return { title: series, season: Number.isInteger(season) ? season : null, episode, episodeTitle: prop(ep, "name") };
      }
    }
    const movie = document.querySelector('[itemtype*="schema.org/Movie" i]');
    if (movie) {
      const nameEl = movie.querySelector('[itemprop="name"]');
      const name = nameEl && clean(nameEl.getAttribute("content") || nameEl.textContent);
      if (name) return { title: name };
    }
    return null;
  }

  function fromStructuredData() {
    const texts = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent);
    return parseStructuredData(texts, pageMeta()) || fromMicrodata();
  }

  /** The JSON app data many sites embed (Next.js, Nuxt, Plex, Jellyfin…). */
  function fromAppData() {
    const texts = [...document.querySelectorAll('script#__NEXT_DATA__, script[type="application/json"]')]
      .map((s) => s.textContent)
      .filter((t) => t && t.length < 3_000_000);
    return parseAppData(texts, location.href);
  }

  function fromDocumentTitle() {
    return parseDocumentTitle(document.title, location.hostname);
  }

  /** Labels on the video element or the player around it, and the video file's name. */
  function fromVideoElement(video) {
    if (!video) return null;
    const texts = [];
    for (let el = video, depth = 0; el && depth < 4; el = el.parentElement, depth++) {
      for (const attr of ["title", "aria-label", "data-title", "data-name", "alt"]) {
        const v = el.getAttribute && el.getAttribute(attr);
        if (v) texts.push(v);
      }
    }
    const fileName = (src) => {
      try {
        return decodeURIComponent(String(src).split(/[?#]/)[0].split("/").pop() || "");
      } catch {
        return "";
      }
    };
    for (const src of [video.currentSrc, video.getAttribute("src"), ...[...video.querySelectorAll("source")].map((s) => s.src), video.poster]) {
      if (src && !String(src).startsWith("blob:") && !String(src).startsWith("data:")) texts.push(fileName(src));
    }
    for (const t of texts) {
      const r = parseMediaText(t, { site: location.hostname });
      if (r) return r;
    }
    return null;
  }

  /** The smallest element around the video that's about the same size: the player. */
  function playerContainer(video) {
    if (!video || !video.getBoundingClientRect) return null;
    const v = video.getBoundingClientRect();
    const area = Math.max(1, v.width * v.height);
    let best = video.parentElement;
    for (let el = video.parentElement, depth = 0; el && depth < 8; el = el.parentElement, depth++) {
      const r = el.getBoundingClientRect();
      if (r.width * r.height > area * 3) break;
      best = el;
    }
    return best;
  }

  const NEXT_UP = /\b(next|up ?next|suivant|siguiente|próximo|nächste|prossimo)\b/i;
  const UI_TEXT = /^(\d{1,2}:)?\d{1,2}:\d{2}$|^(skip|play|pause|resume|back|forward|subtitles|audio|settings|full ?screen|volume|mute|cc)\b/i;

  /**
   * Text inside the player overlay, including the parts hidden while you don't move the mouse.
   * Ignores "Next episode" cards so the next episode isn't mistaken for the current one.
   */
  function fromPlayerOverlay(video) {
    const box = playerContainer(video);
    if (!box) return null;
    const lines = [];
    const isNextUp = (el) => {
      for (let e = el, d = 0; e && e !== box && d < 6; e = e.parentElement, d++) {
        const label = `${e.getAttribute?.("aria-label") || ""} ${e.className || ""} ${e.getAttribute?.("data-uia") || ""} ${e.getAttribute?.("data-testid") || ""}`;
        if (NEXT_UP.test(label)) return true;
      }
      return false;
    };
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(), count = 0; n && count < 400; n = walker.nextNode(), count++) {
      const t = clean(n.textContent);
      if (t.length >= 2 && t.length <= 160 && !UI_TEXT.test(t) && !isNextUp(n.parentElement)) lines.push(t);
    }
    for (const el of box.querySelectorAll("[aria-label], [title]")) {
      if (lines.length > 500) break;
      const t = clean(el.getAttribute("aria-label") || el.getAttribute("title"));
      if (t && t.length <= 160 && !isNextUp(el)) lines.push(t);
    }
    for (let i = 0; i < lines.length; i++) {
      const whole = parseMediaText(lines[i], { site: location.hostname });
      if (whole) return whole;
      const ep = parseEpisode(lines[i]);
      if (ep) {
        // "Ozark" on one line and "S2:E3 Trouble the Water" on the next.
        const show = [lines[i - 1], lines[i - 2]].find((l) => l && !parseEpisode(l) && !UI_TEXT.test(l));
        if (show) return { title: show, season: ep.season, episode: ep.episode, episodeTitle: stripEpisode(lines[i]) };
      }
    }
    return null;
  }

  /** The web address, and the page's own "canonical" address (often more descriptive). */
  function fromUrl() {
    const addresses = [location.pathname];
    for (const sel of ['link[rel="canonical"]', 'meta[property="og:url"]']) {
      const el = document.querySelector(sel);
      const href = el && (el.getAttribute("href") || el.getAttribute("content"));
      try {
        if (href) addresses.push(new URL(href, location.href).pathname);
      } catch {
        /* bad URL */
      }
    }
    for (const a of addresses) {
      const r = parseUrl(a);
      if (r) return r;
    }
    return null;
  }

  // Titles reported by the page's own video player software (see page-probe.js).
  let probeItems = [];
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("message", (e) => {
      if (e.source === window && e.data && e.data.__bingersProbe && Array.isArray(e.data.items)) {
        probeItems = e.data.items.filter((x) => typeof x === "string").slice(0, 10);
      }
    });
  }
  function fromPlayerData() {
    for (const t of probeItems) {
      const r = parseMediaText(t, { site: location.hostname });
      if (r) return r;
    }
    return null;
  }

  /** Headings on the page ("Ozark: Season 2, Episode 3" above the player). */
  function fromHeadings() {
    const els = document.querySelectorAll('h1, h2, h3, [itemprop="name"], [class*="title" i], [data-testid*="title" i]');
    let checked = 0;
    for (const el of els) {
      const text = clean(el.textContent);
      if (!text || text.length > 160) continue;
      const r = parseMediaText(text, { site: location.hostname });
      if (r) return r;
      if (++checked > 60) break;
    }
    return null;
  }

  /** Raw text the popup can show and pre-fill when nothing could be worked out. */
  function hint() {
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const candidates = [md && [md.title, md.artist].filter(Boolean).join(" - "), probeItems[0], document.title];
    return clean(candidates.find((c) => clean(c)) || "").slice(0, 200);
  }

  /** What every source saw, for "Copy details" in the popup (so one bug report is enough). */
  function diagnose(video) {
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const cut = (s, n = 200) => clean(s).slice(0, n);
    const box = playerContainer(video);
    return {
      frame: window === window.top ? "top" : "embedded",
      host: location.hostname,
      path: cut(location.pathname, 150),
      tabTitle: cut(document.title),
      mediaSession: md ? { title: cut(md.title), artist: cut(md.artist), album: cut(md.album) } : null,
      meta: Object.fromEntries(Object.entries(pageMeta()).filter(([k]) => /title|type|series/.test(k)).map(([k, v]) => [k, cut(v)])),
      jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => {
        try {
          return asArray(JSON.parse(s.textContent)["@type"]).join(",");
        } catch {
          return "invalid";
        }
      }).slice(0, 8),
      appData: document.querySelectorAll('script#__NEXT_DATA__, script[type="application/json"]').length,
      playerSoftware: probeItems.map((t) => cut(t)),
      overlay: box ? cut(box.innerText || "", 400) : "",
      video: video ? { duration: Math.round(video.duration), muted: video.muted, src: cut(video.currentSrc, 120) } : null,
    };
  }

  // Sources from most to least reliable. The order also decides which one wins when two disagree.
  const SOURCES = [
    "player",
    "page data",
    "player software",
    "media controls",
    "tab title",
    "player overlay",
    "app data",
    "video label",
    "web address",
    "page heading",
  ];

  /**
   * Try every way of finding out what's playing, most reliable first, and note where it came from.
   * @param {object|null} adapterMedia  what a site-specific reader found
   * @param {HTMLVideoElement|null} video
   * @param {{topFrame?: boolean}} opts
   */
  function detect(adapterMedia, video, { topFrame = true } = {}) {
    const site = location.hostname;
    const readers = {
      player: () => adapterMedia,
      "page data": fromStructuredData,
      "player software": fromPlayerData,
      "media controls": () => fromMediaSession(site),
      // In an embedded player, its own page title often names the video.
      "tab title": fromDocumentTitle,
      "player overlay": () => fromPlayerOverlay(video),
      "app data": fromAppData,
      "video label": () => fromVideoElement(video),
      "web address": () => (topFrame ? fromUrl() : null),
      "page heading": () => (topFrame ? fromHeadings() : null),
    };
    for (const source of SOURCES) {
      let media = null;
      try {
        media = readers[source]();
      } catch {
        media = null;
      }
      if (media && media.title) return { ...media, source, rank: SOURCES.indexOf(source) };
    }
    return null;
  }

  globalThis.BSParse = {
    parseEpisode,
    parseSeason,
    stripEpisode,
    clean,
    deepQuery,
    firstText,
    fromTitleAndSubtitle,
    parseMediaText,
    fromMediaSession,
    parseStructuredData,
    parseAppData,
    parseDocumentTitle,
    parseUrl,
    fromStructuredData,
    fromDocumentTitle,
    fromVideoElement,
    fromPlayerOverlay,
    fromHeadings,
    fromUrl,
    hint,
    diagnose,
    detect,
  };
})();
