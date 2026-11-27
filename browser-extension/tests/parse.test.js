import assert from "node:assert/strict";
import { test } from "node:test";

await import("../content/parse.js");
const P = globalThis.BSParse;

test("season and episode formats used by streaming players", () => {
  const cases = {
    "S1:E3": [1, 3],
    "S4:E12 Trouble the Water": [4, 12],
    "S1 E3: Pilot": [1, 3],
    S01E03: [1, 3],
    "Season 1, Ep. 3 The Whole Truth": [1, 3],
    "Season 2 Episode 10": [2, 10],
    "T2:E5": [2, 5],
    "Staffel 3 Folge 4": [3, 4],
  };
  for (const [text, [season, episode]] of Object.entries(cases)) {
    assert.deepEqual(P.parseEpisode(text), { season, episode }, text);
  }
});

test("episode without season, and no episode at all", () => {
  assert.deepEqual(P.parseEpisode("Ep. 7"), { season: null, episode: 7 });
  assert.equal(P.parseEpisode("Inception"), null);
  assert.equal(P.parseEpisode(""), null);
});

test("title + subtitle", () => {
  assert.deepEqual(P.fromTitleAndSubtitle("The Bear", "S2 E3: Sundae"), {
    title: "The Bear",
    season: 2,
    episode: 3,
    episodeTitle: "Sundae",
  });
  assert.deepEqual(P.fromTitleAndSubtitle(" Dune: Part Two ", ""), { title: "Dune: Part Two" });
  assert.equal(P.fromTitleAndSubtitle("", "S1:E1"), null);
});

test("structured data: schema.org episode and movie", () => {
  const episode = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "TVEpisode",
    name: "The You You Are",
    episodeNumber: 4,
    partOfSeason: { "@type": "TVSeason", seasonNumber: 1 },
    partOfSeries: { "@type": "TVSeries", name: "Severance" },
  });
  assert.deepEqual(P.parseStructuredData([episode]), {
    title: "Severance",
    season: 1,
    episode: 4,
    episodeTitle: "The You You Are",
  });

  const graph = JSON.stringify({
    "@graph": [{ "@type": "WebPage", name: "Watch" }, { "@type": "Movie", name: "Heat", datePublished: "1995-12-15" }],
  });
  assert.deepEqual(P.parseStructuredData(["{broken json", graph]), { title: "Heat", year: 1995 });
});

test("structured data: Open Graph tags", () => {
  assert.deepEqual(
    P.parseStructuredData([], { "og:type": "video.episode", "og:title": "Dark S03E08", "video:series": "Dark" }),
    { title: "Dark", season: 3, episode: 8, episodeTitle: "" }
  );
  assert.deepEqual(P.parseStructuredData([], { "og:type": "video.movie", "og:title": "Oppenheimer (2023)" }), {
    title: "Oppenheimer",
    year: 2023,
  });
  assert.equal(P.parseStructuredData([], { "og:type": "website", "og:title": "Home" }), null);
});

test("tab title: only trusted with an episode number or a film year", () => {
  assert.deepEqual(P.parseDocumentTitle("Watch Severance S1E4 | StreamSite", "www.streamsite.com"), {
    title: "Severance",
    season: 1,
    episode: 4,
    episodeTitle: "",
  });
  assert.deepEqual(P.parseDocumentTitle("Shogun - Season 1 Episode 2 - Servants of Two Masters - Flix", "flix.tv"), {
    title: "Shogun",
    season: 1,
    episode: 2,
    episodeTitle: "Servants of Two Masters",
  });
  assert.deepEqual(P.parseDocumentTitle("Heat (1995) - MovieBox", "moviebox.example"), { title: "Heat", year: 1995 });
  assert.equal(P.parseDocumentTitle("Home | StreamSite", "streamsite.com"), null);
  assert.equal(P.parseDocumentTitle("My cat video", "videos.example"), null);
});

test("real-world titles: file names, 'Watch …' titles, many formats", () => {
  const ep = (title, season, episode) => ({ title, season, episode });
  const cases = [
    ["Most_Dangerous_Game_S02E11_720p_10bit_WEBRip_2CH_x265_HEVC_PSA.mkv", "", ep("Most Dangerous Game", 2, 11)],
    ["Watch Ozark Season 2 Episode 3", "", ep("Ozark", 2, 3)],
    ["Watch Ozark Season 2 Episode 3 Online Free | FlixHQ", "flixhq.to", ep("Ozark", 2, 3)],
    ["Ozark: Season 2, Episode 3 - Netflix", "www.netflix.com", ep("Ozark", 2, 3)],
    ["The.Bear.S02E03.1080p.WEB.h264-ETHEL.mkv", "", ep("The Bear", 2, 3)],
    ["Severance 1x04 The You You Are", "", ep("Severance", 1, 4)],
    ["Play Dates S01E01", "", ep("Play Dates", 1, 1)],
    ["You're watching: Shogun S1 E2 · Servants of Two Masters", "", ep("Shogun", 1, 2)],
    ["[SubsPlease] Frieren - 12 (1080p) [A1B2C3D4].mkv", "", ep("Frieren", null, 12)],
    ["House.of.the.Dragon.S02.E05.Regent.2160p.mkv", "", ep("House of the Dragon", 2, 5)],
  ];
  for (const [text, site, want] of cases) {
    const got = P.parseMediaText(text, { site });
    assert.ok(got, `nothing parsed from ${text}`);
    assert.deepEqual({ title: got.title, season: got.season, episode: got.episode }, want, text);
  }
  assert.equal(P.parseMediaText("Severance 1x04 The You You Are").episodeTitle, "The You You Are");
  assert.equal(P.parseMediaText("House.of.the.Dragon.S02.E05.Regent.2160p.mkv").episodeTitle, "Regent");
});

test("real-world movie titles", () => {
  assert.deepEqual(P.parseMediaText("Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.mkv"), { title: "Dune Part Two", year: 2024 });
  assert.deepEqual(P.parseMediaText("Blade Runner 2049 (2017) - MovieBox", { site: "moviebox.example" }), {
    title: "Blade Runner 2049",
    year: 2017,
  });
  assert.deepEqual(P.parseMediaText("Charlotte's Web (1973)"), { title: "Charlotte's Web", year: 1973 });
  // A bare name is only trusted from sources that are clearly about the video.
  assert.equal(P.parseMediaText("Oppenheimer"), null);
  assert.deepEqual(P.parseMediaText("Oppenheimer", { strong: true }), { title: "Oppenheimer" });
  assert.equal(P.parseMediaText("Netflix"), null);
});

test("other languages, number words, Part seasons, years", () => {
  const ep = (text) => {
    const r = P.parseMediaText(text);
    return r && [r.title, r.season, r.episode];
  };
  assert.deepEqual(ep("Lupin Saison 2 Épisode 3"), ["Lupin", 2, 3]);
  assert.deepEqual(ep("La casa de papel Temporada 2 Episodio 3"), ["La casa de papel", 2, 3]);
  assert.deepEqual(ep("Dark Staffel 3 Folge 8"), ["Dark", 3, 8]);
  assert.deepEqual(ep("Kuruluş Osman Sezon 2 Bölüm 3"), ["Kuruluş Osman", 2, 3]);
  assert.deepEqual(ep("Слово пацана 1 сезон 3 серия"), ["Слово пацана", 1, 3]);
  assert.deepEqual(ep("三体 第1季 第5集"), ["三体", 1, 5]);
  assert.deepEqual(ep("Stranger Things Chapter Three"), ["Stranger Things", null, 3]);
  assert.deepEqual(ep("Money Heist: Part 3: Episode 2"), ["Money Heist", 3, 2]);
  assert.deepEqual(ep("Money Heist P3:E2"), ["Money Heist", 3, 2]);
  assert.deepEqual(ep("Season One Episode Two"), null); // no show name: nothing to search for
  assert.equal(P.parseMediaText("Doctor Who (2005) S01E01").year, 2005);
  assert.equal(P.parseMediaText("Doctor Who (2005) S01E01").title, "Doctor Who");
  assert.deepEqual(P.parseMediaText("Dune: Part Two (2024)"), { title: "Dune: Part Two", year: 2024 });
  assert.equal(P.parseSeason("Season 4"), 4);
  assert.equal(P.parseSeason("Specials"), null);
});

test("embedded app data (Next.js, Plex, Jellyfin)", () => {
  const plex = JSON.stringify({ MediaContainer: { Metadata: [{ ratingKey: "4821", grandparentTitle: "Ozark", parentIndex: 2, index: 3, title: "Kaleidoscope" }] } });
  assert.deepEqual(P.parseAppData([plex], "https://app.plex.tv/desktop/#!/server/x/details?key=%2Flibrary%2Fmetadata%2F4821"), {
    title: "Ozark",
    season: 2,
    episode: 3,
    episodeTitle: "Kaleidoscope",
  });
  const jellyfin = JSON.stringify({ Id: "ab12cd", SeriesName: "Severance", ParentIndexNumber: 1, IndexNumber: 4, Name: "The You You Are" });
  assert.equal(P.parseAppData([jellyfin]).episode, 4);
  // A season list with many episodes and nothing tying one to the address: don't guess.
  const list = JSON.stringify({ props: { episodes: [1, 2, 3].map((n) => ({ id: `ep${n}x`, seriesTitle: "Dark", seasonNumber: 1, episodeNumber: n })) } });
  assert.equal(P.parseAppData([list], "https://site.example/browse"), null);
  assert.equal(P.parseAppData([list], "https://site.example/watch/ep2x").episode, 2);
});

test("show year and country in file names", () => {
  const dm = P.parseMediaText("Dark.Matter.2024.S01E02.1080p.WEB.h264.mkv");
  assert.deepEqual([dm.title, dm.year, dm.season, dm.episode], ["Dark Matter", 2024, 1, 2]);
  const office = P.parseMediaText("The.Office.US.S02E03.720p.mkv");
  assert.deepEqual([office.title, office.country], ["The Office", "US"]);
  // Not years: a future-sounding title and a show named after a number.
  assert.equal(P.parseMediaText("Blade.Runner.2099.S01E01.mkv").title, "Blade Runner 2099");
  assert.equal(P.parseMediaText("1883.S01E02.1080p.mkv").title, "1883");
  assert.equal(P.parseMediaText("12.12.12.S01E04.720p.10bit.WEBRip.2CH.x265.HEVC-PSA.mkv").title, "12 12 12");
});

test("web addresses", () => {
  assert.deepEqual(P.parseUrl("/watch/ozark-season-2-episode-3"), { title: "Ozark", season: 2, episode: 3, episodeTitle: "" });
  assert.equal(P.parseUrl("/tv/the-bear/s02e03").title, "The Bear");
  assert.equal(P.parseUrl("/en/movie/heat-1995/8f3k2j9x1q").title, "Heat");
  assert.equal(P.parseUrl("/watch/80117552"), null);
});

test("media session fallback", () => {
  const set = (md) => {
    // Node has its own read-only navigator; replace it for this test.
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaSession: { metadata: md } },
      configurable: true,
    });
  };
  set({ title: "Ozark", artist: "S4:E12 Trouble the Water", album: "" });
  assert.deepEqual(P.fromMediaSession(), { title: "Ozark", season: 4, episode: 12, episodeTitle: "Trouble the Water" });

  set({ title: "Pilot", artist: "S1:E1", album: "Severance" });
  assert.equal(P.fromMediaSession().title, "Severance");

  set({ title: "Oppenheimer", artist: "", album: "" });
  assert.deepEqual(P.fromMediaSession(), { title: "Oppenheimer" });

  // Telegram and similar: the file name is the title
  set({ title: "Most_Dangerous_Game_S02E11_720p_10bit_WEBRip_2CH_x265_HEVC_PSA.mkv", artist: "", album: "" });
  assert.deepEqual(P.fromMediaSession(), { title: "Most Dangerous Game", season: 2, episode: 11, episodeTitle: "" });

  // An episode name with the show in "artist" and no numbers (Jellyfin, Plex): never a movie;
  // the background looks the episode up on Bingers by its name.
  set({ title: "Trouble the Water", artist: "Ozark", album: "Season 4" });
  assert.deepEqual(P.fromMediaSession(), { title: "Ozark", episodeTitle: "Trouble the Water", season: 4, episode: null, lookup: true });

  set(null);
  assert.equal(P.fromMediaSession(), null);
});
