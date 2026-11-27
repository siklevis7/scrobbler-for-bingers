// Service worker: receives playback reports from the streaming pages, matches titles on
// Bingers, counts real watch time, and marks things watched at the threshold.

import * as api from "./lib/api.js";
import { buildItems, findEpisodeByName, isCloseCall, mediaLabel, normalize, rankCandidates, searchVariants, splitTag } from "./lib/match.js";
import { afterMark, applyEntries, describeWeek, dueWeek, markOutcome, watchItems, watchTotal, weekBounds, weekKey, whereToWatch } from "./lib/insights.js";
import { MIN_VIDEO_SECONDS, applyReport, expired, isReady, mediaKey, neededSeconds, newSession } from "./lib/tracker.js";
import { syncSites } from "./lib/sites.js";
import * as store from "./lib/storage.js";

const RESOLVE_RETRY_MS = 60_000;
const WATCHLIST_FRESH_MS = 10 * 60_000;
const MAX_FEED_PAGES = 20;
const FRAME_MEDIA_FRESH_MS = 60_000; // how long a title from another frame of the tab stays valid

// In memory while the worker is alive, mirrored to session storage so a restart keeps them.
let sessions = {}; // `${tabId}|${mediaKey}` -> session
let tabInfo = {}; // tabId -> { service, sessionId, noMedia, lastSeen, site }
let tabMedia = {}; // tabId -> { media, at }: latest title any frame of the tab reported
let tabManual = {}; // tabId -> { media, match, url }: what the user picked with "Fix it"
const resolving = new Set();
const loaded = chrome.storage.session.get(["sessions", "tabInfo", "tabMedia", "tabManual"]).then((d) => {
  sessions = d.sessions || {};
  tabInfo = d.tabInfo || {};
  tabMedia = d.tabMedia || {};
  tabManual = d.tabManual || {};
});

function persist() {
  chrome.storage.session.set({ sessions, tabInfo, tabMedia, tabManual }).catch(() => {});
}

// "v2": matches saved before same-name shows were told apart by year are ignored.
function cacheKeyFor(media) {
  const kind = media.kind === "episode" ? "show" : "movie";
  return `v2|${kind}|${normalize(media.title)}|${media.year || ""}`;
}

function siteOf(sender) {
  try {
    return new URL(sender.tab?.url || sender.url || "").hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// -- messages ----------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true; // keep the channel open for the async answer
});

async function handle(msg, sender) {
  await loaded;
  switch (msg?.type) {
    case "report":
      return onReport(msg, sender.tab?.id, siteOf(sender));
    case "getTabState":
      return getTabState(msg.tabId);
    case "markNow":
      return markNow(msg.tabId);
    case "flushBacklog":
      return flushBacklog();
    case "checkToken":
      return checkToken(msg.token);
    case "signOut":
      await store.saveSettings({ token: "", account: "" });
      await resetLibraryData();
      return { ok: true };
    case "searchTitles":
      return searchTitles(msg.query);
    case "chooseTitle":
      return chooseTitle(msg);
    case "getWatchlist":
      return getWatchlist(Boolean(msg.refresh));
    case "titleDetails":
      return titleDetails(msg.id);
    case "getWeek":
      return getWeek();
    default:
      return { error: "unknown message" };
  }
}

function toMedia(raw) {
  const title = String(raw?.title || "").replace(/\s+/g, " ").trim();
  if (!title) return null;
  const source = raw.source || "player";
  const year = Number.isInteger(raw.year) ? raw.year : null;
  const episode = Number.isInteger(raw.episode) ? raw.episode : null;
  // An episode with no number but its name ("Trouble the Water" by "Ozark"): looked up on Bingers.
  const lookup = episode === null && raw.lookup === true && Boolean(raw.episodeTitle);
  if (episode !== null || lookup) {
    return {
      kind: "episode",
      title,
      season: Number.isInteger(raw.season) ? raw.season : null,
      episode,
      episodeTitle: raw.episodeTitle || "",
      lookup,
      year,
      country: raw.country || null,
      source,
    };
  }
  return { kind: "movie", title, year, country: raw.country || null, source };
}

async function onReport(msg, tabId, site) {
  if (tabId === undefined) return {};
  const now = Date.now();

  // Any frame that knows the title shares it with the tab, for a player in another frame.
  if (msg.media && msg.media.title) tabMedia[tabId] = { media: msg.media, at: now };
  if (msg.noVideo) {
    persist();
    return {};
  }

  const settings = await store.getSettings();
  if (!settings.services[msg.service]) {
    tabInfo[tabId] = { service: msg.service, site, disabled: true, lastSeen: now };
    setBadge(tabId, null);
    persist();
    return {};
  }

  // What the user picked with "Fix it" wins, for as long as the tab stays on the same page.
  let manual = tabManual[tabId];
  if (manual && manual.url && msg.url && manual.url !== msg.url) {
    delete tabManual[tabId];
    manual = null;
  }

  const shared = tabMedia[tabId];
  const raw = manual
    ? manual.media
    : msg.media || (shared && now - shared.at < FRAME_MEDIA_FRESH_MS ? shared.media : null);
  const media = toMedia(raw);
  const url = msg.url || tabInfo[tabId]?.url || "";
  if (!media) {
    const prev = tabInfo[tabId];
    tabInfo[tabId] = {
      service: msg.service,
      site,
      url,
      noMedia: true,
      hint: msg.hint || "",
      diag: msg.diag || (prev?.noMedia ? prev.diag : null), // what each source saw, for "Copy details"
      lastSeen: now,
    };
    setBadge(tabId, null);
    persist();
    return {};
  }

  const id = `${tabId}|${mediaKey(msg.service, media)}`;
  let session = sessions[id];
  if (!session) {
    session = newSession(tabId, msg.service, media, now);
    session.site = site;
    sessions[id] = session;
  }
  if (manual && !session.match) {
    session.match = manual.match;
    session.state = "tracking";
    session.message = "";
  }
  session.media.source = manual ? "you" : media.source;
  applyReport(session, { ...msg, tabId }, now);
  // Why watch time isn't counting, shown in the pop-up.
  session.note =
    session.duration > 0 && session.duration < MIN_VIDEO_SECONDS
      ? "This video is under 4 minutes, so it's treated as a trailer or clip and not marked."
      : !session.counting
        ? "Muted video that started by itself (likely a preview): click the page to count it."
        : "";
  tabInfo[tabId] = { service: msg.service, site, url, sessionId: id, lastSeen: now };

  if (!settings.token) {
    session.state = session.state === "done" ? "done" : "error";
    session.message = "Not signed in. Open the extension's settings to sign in.";
  } else if (session.state === "error" && session.message.startsWith("Not signed in")) {
    session.state = "matching";
    session.message = "";
  }
  if (session.state === "matching" && settings.token && !resolving.has(id) && now >= (session.retryAt || 0)) {
    resolve(id, settings.token); // not awaited: matching runs alongside the reports
  }
  if (isReady(session, settings)) await send(session, settings);

  setBadge(tabId, session);
  persist();
  return {};
}

// -- matching ----------------------------------------------------------------

async function resolve(id, token) {
  resolving.add(id);
  try {
    const session = sessions[id];
    if (!session) return;
    const { media } = session;
    const kind = media.kind === "episode" ? "show" : "movie";
    const cacheKey = cacheKeyFor(media);
    let match = await store.getCachedMatch(cacheKey);
    if (!match) {
      try {
        // The exact name first, then variants ("Dark Matter 2024", "Star Wars: Andor" -> "Andor").
        // A result from the wrong year is only kept as a fallback while other searches run.
        const yearFits = (c) => {
          const tagYear = Number(splitTag(c.title)[1]) || null;
          const y = Number.isInteger(c.year) ? c.year : tagYear;
          return !media.year || (y && Math.abs(y - media.year) <= 1);
        };
        let fallback = null;
        for (const query of searchVariants(media.title, media.year)) {
          // For the "Dark Matter 2024" search, still compare names as "Dark Matter".
          const searchAs = media.year && query === `${media.title} ${media.year}` ? media : { ...media, title: query };
          const candidate = await bestCandidate(token, searchAs, await api.search(token, query, kind));
          if (candidate && yearFits(candidate)) {
            match = { ref: candidate.id, name: candidate.title || media.title, year: candidate.year ?? null };
            break;
          }
          fallback = fallback || candidate;
        }
        if (!match && fallback) match = { ref: fallback.id, name: fallback.title || media.title, year: fallback.year ?? null };
        if (!match) {
          // The page may show the show's own name ("La casa de papel"): Bingers answers in English
          // unless asked for original names.
          const local = await bestCandidate(token, media, await api.searchOriginal(token, media.title, kind));
          if (local) match = { ref: local.id, name: local.title || media.title, year: local.year ?? null };
        }
        if (match) await store.setCachedMatch(cacheKey, match);
      } catch (err) {
        if (err.transient) {
          session.retryAt = Date.now() + RESOLVE_RETRY_MS;
          session.message = "Bingers isn't reachable right now; retrying in a minute.";
        } else if (err.auth) {
          session.state = "error";
          session.message = `Bingers refused your token: ${err.message}`;
          notify(session.message);
        } else {
          session.state = "error";
          session.message = `Lookup failed: ${err.message}`;
        }
        return;
      }
    }
    if (match && media.kind === "episode" && media.episode == null) {
      // The site gave the episode's name but no numbers: find it in the show's episode list.
      try {
        const list = await api.episodes(token, match.ref, media.season ?? undefined);
        const ep = findEpisodeByName(list, media.episodeTitle, media.season);
        if (ep) {
          media.season = ep.season;
          media.episode = ep.number;
        } else {
          session.match = match;
          session.state = "unmatched";
          session.message = `Found ${match.name}, but not an episode called "${media.episodeTitle}". Pick it below.`;
          return;
        }
      } catch (err) {
        session.retryAt = Date.now() + RESOLVE_RETRY_MS;
        session.message = "Couldn't load the episode list yet; retrying in a minute.";
        return;
      }
    }
    if (match) {
      session.match = match;
      session.state = "tracking";
      session.message = "";
    } else {
      session.state = "unmatched";
      session.message = `Couldn't find "${media.title}" on Bingers. Pick the right title below.`;
      notify(`Couldn't find "${media.title}" on Bingers. Click the extension's icon to pick the right title.`);
    }
  } finally {
    resolving.delete(id);
    const s = sessions[id];
    if (s) setBadge(s.tabId, s);
    persist();
  }
}

/** The best fit; when two same-name titles are close, the one in your library wins. */
async function bestCandidate(token, media, results) {
  let ranked = rankCandidates(media, results);
  if (isCloseCall(media, ranked)) {
    const top = ranked.slice(0, 4);
    try {
      const library = await api.check(token, top.map((c) => c.id));
      ranked = rankCandidates(media, top, library).concat(ranked.slice(4));
    } catch (err) {
      console.info("Couldn't check the library; using the search order", err);
    }
  }
  return ranked[0] || null;
}

// -- scrobbling --------------------------------------------------------------

async function send(session, settings) {
  const items = buildItems(session.media, session.match.ref);
  const label = mediaLabel(session.media);
  session.state = "done"; // set first so a second report can't send it twice
  try {
    const results = await api.scrobble(settings.token, items);
    const statuses = new Set(results.map((r) => r.status));
    const ok = results.length > 0 && [...statuses].every((s) => s === "ok" || s === "already");
    if (ok) {
      const outcome = markOutcome(results);
      session.message = {
        "already watched": "Already marked on Bingers",
        "marked as a rewatch": "Marked on Bingers as a rewatch",
      }[outcome] || "Marked watched on Bingers";
      await store.addHistory(label, outcome);
      const extra = await whatsNext(results, settings);
      if (extra?.note && settings.upNext) session.message += `. ${extra.note}`;
      notify(`${label} ${outcome}${extra?.note && settings.upNext ? `\n${extra.note}` : ""}`);
      if (extra?.finished && extra.suggestions.length) {
        notify(`You finished ${extra.show || label}! You might like: ${extra.suggestions.join(", ")}`);
      }
      chrome.storage.session.remove("watchlist").catch(() => {}); // the next episode moved
    } else {
      const detail = results.map(api.describeResult).join("; ") || "no result";
      session.state = "error";
      session.message = detail;
      await store.addHistory(label, detail);
      notify(`${label}: ${detail}`);
    }
  } catch (err) {
    if (err.transient || err.auth) {
      const watchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      await store.setBacklog([...(await store.getBacklog()), ...items.map((i) => ({ ...i, watched_at: watchedAt }))]);
      session.state = "queued";
      session.message = err.auth
        ? "Bingers refused your token. Saved; it will be sent after you sign in again."
        : "Bingers isn't reachable. Saved; it will be sent automatically.";
      await store.addHistory(label, "saved to backlog");
      notify(`${label}: ${session.message}`);
    } else {
      session.state = "error";
      session.message = `Bingers rejected it: ${err.message}`;
      await store.addHistory(label, `rejected: ${err.message}`);
      notify(`${label}: ${session.message}`);
    }
  }
}

/** Next episode / finished show for the episode marked last; null for movies or when turned off. */
async function whatsNext(results, settings) {
  if (!settings.upNext && !settings.suggestions) return null;
  const last = results[results.length - 1] || {};
  const ref = last.title?.id;
  const ep = last.episode || {};
  if (!ref || !Number.isInteger(ep.season) || !Number.isInteger(ep.number)) return null;
  return afterMark(api, settings.token, ref, ep.season, ep.number, { suggestions: settings.suggestions });
}

// -- the watch list and the weekly summary ------------------------------------------

async function getWatchlist(refresh) {
  const settings = await store.getSettings();
  if (!settings.token) return { error: "Sign in to see your watch list." };
  const { watchlist } = await chrome.storage.session.get("watchlist");
  if (!refresh && watchlist && Date.now() - watchlist.at < WATCHLIST_FRESH_MS) return watchlist;
  try {
    const data = await api.watchlist(settings.token, 8);
    const fresh = { at: Date.now(), items: watchItems(data), total: watchTotal(data) };
    await chrome.storage.session.set({ watchlist: fresh });
    return fresh;
  } catch (err) {
    return watchlist ? { ...watchlist, stale: true } : { error: err.message };
  }
}

async function titleDetails(id) {
  const settings = await store.getSettings();
  if (!settings.token) return { error: "Sign in first." };
  try {
    const details = await api.title(settings.token, id);
    return { where: whereToWatch(details), url: details.url || null };
  } catch (err) {
    return { error: err.message };
  }
}

async function loadWeekly() {
  const { weekly } = await chrome.storage.local.get("weekly");
  return { cursor: null, rows: {}, titles: {}, lastShown: null, ...(weekly || {}) };
}

async function resetLibraryData() {
  await chrome.storage.local.remove("weekly");
  await chrome.storage.session.remove("watchlist").catch(() => {});
}

// One weekly-data job at a time (the pop-up's "Your week" and the Sunday alarm can overlap).
let weeklyChain = Promise.resolve();
function withWeekly(job) {
  const run = weeklyChain.then(job, job);
  weeklyChain = run.catch(() => {});
  return run;
}

async function feedPage(token, weekly) {
  try {
    return await api.entries(token, weekly.cursor);
  } catch (err) {
    if (err.transient || err.auth || !weekly.cursor) throw err;
    // The saved position was refused (expired or reset): start over once.
    weekly.cursor = null;
    weekly.rows = {};
    return api.entries(token, null);
  }
}

/** Bring the last few weeks of history up to date from Bingers' change feed. */
async function syncWeekly(token) {
  const weekly = await loadWeekly();
  for (let i = 0; i < MAX_FEED_PAGES; i++) {
    const page = await feedPage(token, weekly);
    applyEntries(weekly.rows, page.items);
    if (page.next_cursor) weekly.cursor = page.next_cursor;
    if (!page.has_more) break;
  }
  applyEntries(weekly.rows, []); // drop rows older than the window
  const wanted = new Set(Object.values(weekly.rows).map((r) => r.title));
  const missing = [...wanted].filter((id) => !weekly.titles[id]);
  for (let i = 0; i < missing.length; i += 100) {
    for (const t of await api.titles(token, missing.slice(i, i + 100))) {
      weekly.titles[String(t.id)] = { name: t.title || "?", runtime: t.runtime_minutes || 0 };
    }
  }
  for (const id of Object.keys(weekly.titles)) if (!wanted.has(id)) delete weekly.titles[id];
  await chrome.storage.local.set({ weekly });
  return weekly;
}

async function getWeek() {
  const settings = await store.getSettings();
  if (!settings.token) return { error: "Sign in first." };
  try {
    const weekly = await withWeekly(() => syncWeekly(settings.token));
    const [start, end] = weekBounds(new Date());
    return { text: describeWeek(weekly.rows, weekly.titles, start, end, "This week so far").text };
  } catch (err) {
    return { error: err.message };
  }
}

const maybeWeeklySummary = () => withWeekly(weeklySummaryJob);

async function weeklySummaryJob() {
  const settings = await store.getSettings();
  if (!settings.token || !settings.weeklySummary) return;
  const now = new Date();
  let weekly = await loadWeekly();
  const week = dueWeek(now, weekly.lastShown);
  if (!week) return;
  if (!weekly.lastShown) {
    // First run: start from here rather than greeting you with an old summary.
    await chrome.storage.local.set({ weekly: { ...weekly, lastShown: weekKey(week) } });
    return;
  }
  weekly = await syncWeekly(settings.token);
  const label = week[1] > now ? "This week" : "Last week";
  const { text, empty } = describeWeek(weekly.rows, weekly.titles, week[0], week[1], label);
  await chrome.storage.local.set({ weekly: { ...weekly, lastShown: weekKey(week) } });
  if (!empty) notify(text, { force: true });
}

// -- "Fix it": the user searches Bingers and picks the right title --------------------

async function searchTitles(query) {
  const settings = await store.getSettings();
  if (!settings.token) return { error: "Sign in first (Settings)." };
  query = String(query || "").trim();
  if (!query) return { error: "Type a show or movie name first." };
  try {
    const items = await api.search(settings.token, query);
    return {
      items: items.slice(0, 8).map((i) => ({ id: i.id, title: i.title, year: i.year ?? null, kind: i.kind })),
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function chooseTitle({ tabId, candidate, season, episode }) {
  const settings = await store.getSettings();
  if (!settings.token) return { error: "Sign in first (Settings)." };
  const info = tabInfo[tabId];
  if (!info) return { error: "Start playing the video, then try again." };
  const old = info.sessionId ? sessions[info.sessionId] : null;
  const isShow = candidate.kind === "show";

  let media;
  if (isShow) {
    const ep = episode === "" || episode == null ? old?.media?.episode : Number(episode);
    if (!Number.isInteger(ep) || ep < 0) return { error: "Enter the episode number." };
    const se = season === "" || season == null ? old?.media?.season ?? 1 : Number(season);
    media = {
      kind: "episode",
      title: candidate.title,
      season: Number.isInteger(se) ? se : 1,
      episode: ep,
      episodeTitle: old?.media?.episodeTitle || "",
      source: "you",
    };
  } else {
    media = { kind: "movie", title: candidate.title, year: candidate.year ?? null, source: "you" };
  }
  const match = { ref: candidate.id, name: candidate.title, year: candidate.year ?? null };

  // Remember the correction: next time the page shows this name, it means this Bingers title.
  if (old?.media && (old.media.kind === "episode") === isShow) {
    await store.setCachedMatch(cacheKeyFor(old.media), match);
  }

  const id = `${tabId}|${mediaKey(info.service, media)}`;
  const session = sessions[id] || newSession(tabId, info.service, media, Date.now());
  if (old && old !== session) {
    // Keep the watch time already counted under the wrong title.
    session.watchedSeconds = Math.max(session.watchedSeconds, old.watchedSeconds);
    Object.assign(session, { progress: old.progress, duration: old.duration, playing: old.playing, lastSeen: old.lastSeen, site: old.site });
    if (old.state !== "done") delete sessions[info.sessionId];
  }
  session.match = match;
  session.state = "tracking";
  session.message = "";
  sessions[id] = session;
  tabManual[tabId] = { media, match, url: info.url || "" };
  tabInfo[tabId] = { ...info, noMedia: false, sessionId: id };
  setBadge(tabId, session);
  persist();
  return { ok: true, label: mediaLabel(media) };
}

async function markNow(tabId) {
  const session = sessions[tabInfo[tabId]?.sessionId];
  if (!session) return { error: "Nothing detected in this tab." };
  if (!session.match) return { error: session.message || "Not matched to a Bingers title yet." };
  const settings = await store.getSettings();
  if (!settings.token) return { error: "Not signed in." };
  await send(session, settings);
  setBadge(tabId, session);
  persist();
  return { ok: true, message: session.message };
}

async function flushBacklog() {
  const settings = await store.getSettings();
  let backlog = await store.getBacklog();
  if (!settings.token || backlog.length === 0) return { sent: 0, waiting: backlog.length };
  let sent = 0;
  while (backlog.length) {
    const batch = backlog.slice(0, 100);
    try {
      await api.scrobble(settings.token, batch);
      sent += batch.length;
    } catch (err) {
      if (err.transient || err.auth) break;
      console.warn("Dropping backlog items Bingers rejected", batch, err); // would block forever
    }
    backlog = backlog.slice(batch.length);
    await store.setBacklog(backlog);
  }
  if (sent) await store.addHistory(`${sent} saved item(s)`, "sent from backlog");
  return { sent, waiting: backlog.length };
}

async function checkToken(token) {
  token = String(token || "").trim();
  if (!token) return { ok: false, error: "Paste your token first." };
  try {
    const account = api.displayName(await api.me(token));
    const before = await store.getSettings();
    if (before.account !== account) await resetLibraryData();
    await store.saveSettings({ token, account });
    flushBacklog().catch(() => {});
    return { ok: true, account };
  } catch (err) {
    return { ok: false, error: err.auth ? `Bingers refused that token: ${err.message}` : err.message };
  }
}

async function getTabState(tabId) {
  const settings = await store.getSettings();
  const info = tabInfo[tabId] || null;
  const session = info?.sessionId ? sessions[info.sessionId] || null : null;
  return {
    signedIn: Boolean(settings.token),
    account: settings.account,
    threshold: settings.threshold,
    info,
    session,
    needed: session ? neededSeconds(session, settings) : 0,
    label: session ? mediaLabel(session.media) : "",
    backlog: (await store.getBacklog()).length,
  };
}

// -- badge and notifications ---------------------------------------------------

function setBadge(tabId, session) {
  let text = "";
  let color = "#7c3aed";
  if (session) {
    if (session.state === "done") [text, color] = ["✓", "#16a34a"];
    else if (session.state === "queued") [text, color] = ["…", "#d97706"];
    else if (session.state === "unmatched" || session.state === "error") [text, color] = ["!", "#dc2626"];
    else if (session.state === "tracking") text = `${Math.floor(session.progress)}%`;
  }
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

async function notify(message, { force = false } = {}) {
  const settings = await store.getSettings();
  if (!settings.notifications && !force) return;
  chrome.notifications.create("", {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/128.png"),
    title: "Bingers Scrobbler",
    message,
  });
}

// -- housekeeping --------------------------------------------------------------

function ensureAlarm() {
  chrome.alarms.create("housekeeping", { periodInMinutes: 1 });
  chrome.alarms.create("library", { delayInMinutes: 1, periodInMinutes: 30 });
}

chrome.runtime.onInstalled.addListener((details) => {
  ensureAlarm();
  syncSites().catch((e) => console.warn("syncSites failed", e));
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  syncSites().catch((e) => console.warn("syncSites failed", e));
});
// If the user removes a site's access in the browser's own settings, stop tracking it.
chrome.permissions.onRemoved.addListener(() => syncSites().catch(() => {}));

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "library") {
    await maybeWeeklySummary().catch((e) => console.info("Weekly summary skipped", e));
    return;
  }
  if (alarm.name !== "housekeeping") return;
  await loaded;
  const now = Date.now();
  for (const [id, s] of Object.entries(sessions)) if (expired(s, now)) delete sessions[id];
  persist();
  await flushBacklog().catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loaded;
  for (const [id, s] of Object.entries(sessions)) if (s.tabId === tabId) delete sessions[id];
  delete tabInfo[tabId];
  delete tabMedia[tabId];
  delete tabManual[tabId];
  persist();
});
