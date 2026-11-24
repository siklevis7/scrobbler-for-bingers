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
