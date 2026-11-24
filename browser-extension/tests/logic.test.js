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
