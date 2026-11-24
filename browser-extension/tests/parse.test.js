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

  set(null);
  assert.equal(P.fromMediaSession(), null);
});
