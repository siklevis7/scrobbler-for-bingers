import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, describeResult, displayName, request } from "../lib/api.js";
import { buildItems, mediaLabel, normalize, pickBest, similarity } from "../lib/match.js";
import { applyReport, isReady, mediaKey, newSession } from "../lib/tracker.js";

const show = (id, title, year, kind = "show") => ({ id, title, year, kind });

test("normalize and similarity", () => {
  assert.equal(normalize("The Office (US)"), "office us");
  assert.equal(normalize("Dune: Part Two"), normalize("Dune Part 2"));
  assert.equal(similarity("abc", "abc"), 1);
  assert.ok(similarity("severance", "severence") > 0.85);
});

test("pickBest prefers the right kind and year", () => {
  const ep = { kind: "episode", title: "Doctor Who", year: 2005 };
  assert.equal(pickBest(ep, [show("a", "Doctor Who", 1963), show("b", "Doctor Who", 2005)]).id, "b");
  const movie = { kind: "movie", title: "Inception" };
  assert.equal(pickBest(movie, [show("x", "Inception", 2010), show("y", "Insomnia", 2002, "movie")]), null);
  assert.equal(pickBest(movie, [show("m", "Inception", 2010, "movie")]).id, "m");
});

test("same-name shows: the year or country Bingers puts in the name decides", async () => {
  const { splitTag } = await import("../lib/match.js");
  assert.deepEqual(splitTag("Dark Matter (2024)"), ["Dark Matter", "2024"]);
  const darkMatter = [show("dm24", "Dark Matter (2024)", 2024), show("dm15", "Dark Matter", 2015)];
  assert.equal(pickBest({ kind: "episode", title: "Dark Matter", year: 2024 }, darkMatter).id, "dm24");
  assert.equal(pickBest({ kind: "episode", title: "Dark Matter", year: 2023 }, darkMatter).id, "dm24"); // off by one
  const outsider = [show("o20", "The Outsider (2020)", 2020), show("o68", "The Outsider", 1968)];
  assert.equal(pickBest({ kind: "episode", title: "The Outsider", year: 2020 }, outsider).id, "o20");
  const office = [show("uk", "The Office (UK)", 2001), show("us", "The Office (US)", 2005)];
  assert.equal(pickBest({ kind: "episode", title: "The Office", country: "US" }, office).id, "us");
  // A title that really contains a year still matches.
  assert.equal(pickBest({ kind: "movie", title: "Blade Runner 2049" }, [show("br", "Blade Runner 2049", 2017, "movie")]).id, "br");
});

test("labels and scrobble items", () => {
  const ep = { kind: "episode", title: "Ozark", season: 4, episode: 12 };
  assert.equal(mediaLabel(ep), "Ozark S04E12");
  assert.deepEqual(buildItems(ep, "uuid"), [{ title: "uuid", season: 4, episode: 12 }]);
  assert.deepEqual(buildItems({ kind: "movie", title: "Heat" }, "imdb:tt0113277"), [{ title: "imdb:tt0113277" }]);
  assert.deepEqual(buildItems({ kind: "episode", title: "X", season: null, episode: 3 }, "r")[0].season, 1);
});

const settings = { threshold: 80, minWatchedMinutes: 5 };
const media = { kind: "episode", title: "Severance", season: 1, episode: 4 };

function play(session, startPct, seconds, { playing = true, duration = 2400, t0 = 0 } = {}) {
  let t = t0;
  let pct = startPct;
  for (let i = 0; i <= seconds / 5; i++) {
    applyReport(session, { playing, progress: pct, duration }, t);
    t += 5000;
    if (playing) pct += (5 / duration) * 100;
  }
  return t;
}

test("ready only after threshold and real watch time", () => {
  const s = newSession(1, "netflix", media, 0);
  s.state = "tracking";
  s.match = { ref: "r" };
  play(s, 60, 120);
  assert.equal(isReady(s, settings), false); // 120 s watched, below 80%
  const s2 = newSession(1, "netflix", media, 0);
  Object.assign(s2, { state: "tracking", match: { ref: "r" } });
  play(s2, 70, 600);
  assert.equal(isReady(s2, settings), true);
});

test("skipping to the end or pausing doesn't count", () => {
  const s = newSession(1, "netflix", media, 0);
  Object.assign(s, { state: "tracking", match: { ref: "r" } });
  const t = play(s, 0, 60);
  play(s, 95, 30, { t0: t });
  assert.equal(isReady(s, settings), false);

  const p = newSession(1, "netflix", media, 0);
  Object.assign(p, { state: "tracking", match: { ref: "r" } });
  play(p, 90, 900, { playing: false });
  assert.equal(p.watchedSeconds, 0);
});

test("short videos need only half their length", () => {
  const s = newSession(1, "netflix", { kind: "movie", title: "Short" }, 0);
  Object.assign(s, { state: "tracking", match: { ref: "r" } });
  play(s, 50, 200, { duration: 400 });
  assert.equal(isReady(s, settings), true);
});

test("watch time follows the video's position: throttled tabs, 2x speed, seeking", () => {
  const ready = (s) => Object.assign(s, { state: "tracking", match: { ref: "r" } });
  // Background tab: Chrome only lets the page report once a minute.
  const bg = ready(newSession(1, "netflix", media, 0));
  for (let i = 0, pos = 1700; i <= 6; i++, pos += 60) applyReport(bg, { playing: true, position: pos, progress: (pos / 2400) * 100, duration: 2400 }, i * 60000);
  assert.equal(bg.watchedSeconds, 360);
  assert.equal(isReady(bg, settings), true);

  // 2x speed: 10 video-seconds per 5 real seconds counts as 5.
  const fast = ready(newSession(1, "netflix", media, 0));
  applyReport(fast, { playing: true, position: 100, progress: 4, duration: 2400 }, 0);
  applyReport(fast, { playing: true, position: 110, progress: 4.5, duration: 2400 }, 5000);
  assert.equal(fast.watchedSeconds, 5);

  // Skipping 20 minutes ahead adds nothing.
  const seek = ready(newSession(1, "netflix", media, 0));
  applyReport(seek, { playing: true, position: 100, progress: 4, duration: 2400 }, 0);
  applyReport(seek, { playing: true, position: 1300, progress: 54, duration: 2400 }, 5000);
  assert.equal(seek.watchedSeconds, 0);
});

test("trailers and previews are never marked", () => {
  const trailer = Object.assign(newSession(1, "custom", { kind: "movie", title: "Heat" }, 0), { state: "tracking", match: { ref: "r" } });
  for (let i = 0; i <= 30; i++) applyReport(trailer, { playing: true, position: i * 5, progress: (i * 5 / 150) * 100, duration: 150 }, i * 5000);
  assert.equal(isReady(trailer, settings), false); // 2.5-minute video

  const muted = Object.assign(newSession(1, "custom", media, 0), { state: "tracking", match: { ref: "r" } });
  for (let i = 0; i <= 120; i++) applyReport(muted, { playing: true, counting: false, position: 1900 + i * 5, progress: 90, duration: 2400 }, i * 5000);
  assert.equal(muted.watchedSeconds, 0);
  assert.equal(isReady(muted, settings), false);
});

test("search variants and episode lookup by name", async () => {
  const { searchVariants, findEpisodeByName } = await import("../lib/match.js");
  assert.deepEqual(searchVariants("Star Wars: Andor"), ["Star Wars: Andor", "Andor"]);
  assert.deepEqual(searchVariants("The Office (US)"), ["The Office (US)", "The Office", "Office"]);
  assert.ok(!searchVariants("Avatar: The Last Airbender").includes("Avatar"));
  const list = [
    { season: 4, number: 11, title: "Pound of Flesh and Still Kickin'" },
    { season: 4, number: 12, title: "Trouble the Water" },
  ];
  assert.equal(findEpisodeByName(list, "trouble the water", 4).number, 12);
  assert.equal(findEpisodeByName(list, "Trouble the Water", 3), null);
  assert.equal(findEpisodeByName(list, "Something else"), null);
});

test("media keys separate episodes", () => {
  assert.notEqual(mediaKey("netflix", media), mediaKey("netflix", { ...media, episode: 5 }));
});

test("API errors are classified", async () => {
  const fake = (status, body = {}, headers = {}) => async () => ({
    status,
    headers: { get: (k) => headers[k] ?? null },
    json: async () => body,
  });
  await assert.rejects(request("t", "GET", "/me", {}, fake(401, { error: { message: "bad token" } })), (e) => e.auth && e.message === "bad token");
  await assert.rejects(request("t", "GET", "/me", {}, fake(429, {}, { "Retry-After": "7" })), (e) => e.transient && e.retryAfter === 7);
  await assert.rejects(request("t", "GET", "/me", {}, fake(503)), (e) => e.transient);
  await assert.rejects(request("t", "GET", "/me", {}, async () => { throw new TypeError("offline"); }), (e) => e instanceof ApiError && e.transient);
  assert.deepEqual(await request("t", "GET", "/me", {}, fake(200, { user: { name: "A" } })), { user: { name: "A" } });
});

test("display helpers", () => {
  assert.equal(displayName({ user: { name: "Ann", handle: "ann" } }), "Ann (@ann)");
  assert.equal(displayName({}), "your account");
  assert.equal(
    describeResult({ status: "ok", outcome: "watched", title: { title: "Ozark" }, episode: { season: 4, number: 12 } }),
    "Ozark S04E12: ok (watched)"
  );
});
