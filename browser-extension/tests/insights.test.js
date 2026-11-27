import assert from "node:assert/strict";
import { test } from "node:test";

import { request } from "../lib/api.js";
import {
  afterMark,
  applyEntries,
  describeNext,
  describeWeek,
  dueWeek,
  markOutcome,
  nextEpisode,
  watchItems,
  weekBounds,
  whereToWatch,
} from "../lib/insights.js";
import { isCloseCall, rankCandidates } from "../lib/match.js";

const show = (id, title, year) => ({ id, kind: "show", title, year });

test("GET requests ask for English names unless told not to", async () => {
  const urls = [];
  const fake = async (url) => {
    urls.push(String(url));
    return { status: 200, json: async () => ({}) };
  };
  await request("t", "GET", "/search", { params: { q: "x" } }, fake);
  await request("t", "GET", "/search", { params: { q: "x", lang: "" } }, fake);
  await request("t", "POST", "/scrobble", { body: {} }, fake);
  assert.match(urls[0], /lang=en/);
  assert.doesNotMatch(urls[1], /lang=/);
  assert.doesNotMatch(urls[2], /lang=/);
  // Bingers answers 400 "Unknown query parameter 'lang'" on these: never send it there.
  await request("t", "GET", "/me", {}, fake);
  await request("t", "GET", "/titles/tvdb%3A1/episodes", { params: { season: 1 } }, fake);
  await request("t", "GET", "/titles/tvdb%3A1", {}, fake);
  assert.doesNotMatch(urls[3], /lang=/);
  assert.doesNotMatch(urls[4], /lang=/);
  assert.match(urls[5], /lang=en/);
});

test("same-name shows: the one in your library wins a close call, not a clear year", () => {
  const media = { kind: "episode", title: "Dark Matter" };
  const results = [show("old", "Dark Matter", 2015), show("new", "Dark Matter (2024)", 2024)];
  assert.ok(isCloseCall(media, rankCandidates(media, results)));
  const library = { new: { status: "watch_next", last_watched_at: "2026-11-01T00:00:00Z" } };
  assert.equal(rankCandidates(media, results, library)[0].id, "new");

  const withYear = { ...media, year: 2015 };
  assert.ok(!isCloseCall(withYear, rankCandidates(withYear, results)));
  assert.equal(rankCandidates(withYear, results, library)[0].id, "old");
});

test("a dropped subtitle still matches, unless the prefix is shared", () => {
  const frieren = rankCandidates({ kind: "episode", title: "Frieren" }, [show("f", "Frieren: Beyond Journey's End", 2023)]);
  assert.equal(frieren[0]?.id, "f");
  const starWars = rankCandidates({ kind: "episode", title: "Star Wars" }, [
    show("a", "Star Wars: Andor", 2022),
    show("b", "Star Wars: Skeleton Crew", 2024),
  ]);
  assert.equal(starWars.length, 0);
  const aot = rankCandidates({ kind: "episode", title: "Attack on Titan" }, [
    show("jh", "Attack on Titan: Junior High", 2015),
    show("aot", "Attack on Titan", 2013),
  ]);
  assert.equal(aot[0].id, "aot");
});

test("rewatches are named", () => {
  assert.equal(markOutcome([{ status: "ok", outcome: "rewatched" }]), "marked as a rewatch");
  assert.equal(markOutcome([{ status: "already" }]), "already watched");
  assert.equal(markOutcome([{ status: "ok", outcome: "watched" }]), "marked watched");
});

const EPISODES = [
  { season: 0, number: 1, title: "Special", aired_at: "2024-01-01" },
  { season: 1, number: 1, title: "One", aired_at: "2024-05-08" },
  { season: 1, number: 2, title: "Two", aired_at: "2024-05-15" },
  { season: 2, number: 1, title: "Back", aired_at: "2026-12-04" },
  { season: 2, number: 2, title: "", aired_at: null },
];

test("the next episode, and when it airs", () => {
  const today = new Date(2026, 10, 27); // Friday 27 November 2026
  assert.equal(describeNext(nextEpisode(EPISODES, 1, 1), today), "Up next: S01E02 · Two");
  assert.equal(describeNext(nextEpisode(EPISODES, 1, 2), today), "Next episode, S02E01, airs on 4 December");
  assert.equal(describeNext({ season: 2, number: 1, aired_at: "2026-11-28" }, today), "Next episode, S02E01, airs tomorrow");
  assert.equal(describeNext({ season: 2, number: 1, aired_at: "2026-12-01" }, today), "Next episode, S02E01, airs on Tuesday");
  assert.equal(describeNext(nextEpisode(EPISODES, 2, 1), today), "Next: S02E02 (no air date yet)");
  assert.equal(nextEpisode(EPISODES, 2, 2), null);
});

test("after the last episode of an ended show, similar titles are suggested", async () => {
  const fakeApi = {
    episodes: async () => EPISODES.slice(0, 3),
    check: async () => ({ s: { status: "completed", title: { title: "Show", catalog_status: "Ended" } } }),
    similar: async () => [
      { title: "Fringe", my_status: "not_in_library" },
      { title: "Seen It", my_status: "completed" },
      { title: "Lost", my_status: null },
    ],
  };
  const out = await afterMark(fakeApi, "t", "s", 1, 2);
  assert.equal(out.finished, true);
  assert.deepEqual(out.suggestions, ["Fringe", "Lost"]);

  const running = { ...fakeApi, check: async () => ({ s: { status: "caught_up", title: { catalog_status: "Continuing" } } }) };
  const caughtUp = await afterMark(running, "t", "s", 1, 2);
  assert.equal(caughtUp.finished, false);
  assert.match(caughtUp.note, /caught up/);

  const broken = { episodes: async () => { throw new Error("offline"); } };
  assert.deepEqual(await afterMark(broken, "t", "s", 1, 1), { note: null, finished: false, show: null, suggestions: [] });
});

test("watch list rows and where to watch", () => {
  const data = {
    sections: {
      watch_next: {
        count: 2,
        items: [{ id: "a", title: "Ozark", url: "u", progress: { next: { season: 4, number: 13, title: "Fin", aired_at: "2022-04-29" } } }],
      },
      collecting_dust: { count: 0, items: [] },
    },
  };
  assert.deepEqual(watchItems(data), [{ id: "a", name: "Ozark", url: "u", next: "S04E13", nextTitle: "Fin", aired: "2022-04-29" }]);
  assert.equal(
    whereToWatch({ where_to_watch: { country: "US", streaming: ["Netflix", "Netflix"], rent: ["Apple TV"], buy: [] } }),
    "In US: Netflix (streaming) · Apple TV (rent)",
  );
  assert.equal(whereToWatch({}), "");
});

test("weekly summary: counted from the change feed, shown once a week", () => {
  const now = new Date(2026, 10, 29, 19, 0); // Sunday 19:00
  const [start, end] = weekBounds(now);
  assert.equal(start.getDay(), 1);
  assert.equal(start.getDate(), 23);
  const at = (d, h = 20) => new Date(2026, 10, d, h).toISOString();
  const rows = applyEntries(
    {},
    [
      { entity_kind: "episode", entity_id: "e1", title_id: "s", watched: true, last_watched_at: at(24) },
      { entity_kind: "episode", entity_id: "e2", title_id: "s", watched: true, last_watched_at: at(25) },
      { entity_kind: "movie", entity_id: "m", title_id: "m", watched: true, last_watched_at: at(26) },
      { entity_kind: "episode", entity_id: "e0", title_id: "s", watched: true, last_watched_at: at(18) },
      { entity_kind: "episode", entity_id: "gone", title_id: "s", watched: true, last_watched_at: at(24), deleted: true },
      { entity_kind: "episode", entity_id: "ancient", title_id: "s", watched: true, last_watched_at: "2020-01-01T00:00:00Z" },
    ],
    now,
  );
  assert.equal(Object.keys(rows).length, 4);
  const titles = { s: { name: "Ozark", runtime: 60 }, m: { name: "Dune", runtime: 155 } };
  const { text, empty } = describeWeek(rows, titles, start, end, "This week");
  assert.equal(empty, false);
  assert.match(text, /^This week: 2 episodes of 1 show and 1 movie, about 4 h 35 min\./);
  assert.match(text, /Most watched: Ozark \(2 episodes\)/);
  assert.match(text, /1 episode more than the week before/);

  assert.deepEqual(dueWeek(now, null), [start, end]);
  assert.equal(dueWeek(now, "2026-11-23"), null);
  const monday = new Date(2026, 10, 30, 9);
  assert.equal(dueWeek(monday, "2026-11-23"), null); // already shown on Sunday
  assert.equal(dueWeek(new Date(2026, 10, 27, 12), "2026-11-09")[0].getDate(), 16); // Friday: last week
});
