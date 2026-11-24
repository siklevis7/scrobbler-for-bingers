// Service worker: receives playback reports from the streaming pages, matches titles on
// Bingers, counts real watch time, and marks things watched at the threshold.

import * as api from "./lib/api.js";
import { buildItems, mediaLabel, normalize, pickBest } from "./lib/match.js";
import { applyReport, expired, isReady, mediaKey, neededSeconds, newSession } from "./lib/tracker.js";
import { syncSites } from "./lib/sites.js";
import * as store from "./lib/storage.js";

const RESOLVE_RETRY_MS = 60_000;
const FRAME_MEDIA_FRESH_MS = 60_000; // how long a title from another frame of the tab stays valid

// In memory while the worker is alive, mirrored to session storage so a restart keeps them.
let sessions = {}; // `${tabId}|${mediaKey}` -> session
let tabInfo = {}; // tabId -> { service, sessionId, noMedia, lastSeen, site }
let tabMedia = {}; // tabId -> { media, at }: latest title any frame of the tab reported
const resolving = new Set();
const loaded = chrome.storage.session.get(["sessions", "tabInfo", "tabMedia"]).then((d) => {
  sessions = d.sessions || {};
  tabInfo = d.tabInfo || {};
  tabMedia = d.tabMedia || {};
});

function persist() {
  chrome.storage.session.set({ sessions, tabInfo, tabMedia }).catch(() => {});
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
      return { ok: true };
    default:
      return { error: "unknown message" };
  }
}

function toMedia(raw) {
  const title = String(raw?.title || "").replace(/\s+/g, " ").trim();
  if (!title) return null;
  const source = raw.source || "player";
  const episode = Number.isInteger(raw.episode) ? raw.episode : null;
  if (episode !== null) {
    return {
      kind: "episode",
      title,
      season: Number.isInteger(raw.season) ? raw.season : null,
      episode,
      episodeTitle: raw.episodeTitle || "",
      source,
    };
  }
  return { kind: "movie", title, year: Number.isInteger(raw.year) ? raw.year : null, source };
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

  const shared = tabMedia[tabId];
  const raw = msg.media || (shared && now - shared.at < FRAME_MEDIA_FRESH_MS ? shared.media : null);
  const media = toMedia(raw);
  if (!media) {
    tabInfo[tabId] = { service: msg.service, site, noMedia: true, lastSeen: now };
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
  session.media.source = media.source;
  applyReport(session, { ...msg, tabId }, now);
  tabInfo[tabId] = { service: msg.service, site, sessionId: id, lastSeen: now };

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
    const cacheKey = `${kind}|${normalize(media.title)}|${media.year || ""}`;
    let match = await store.getCachedMatch(cacheKey);
    if (!match) {
      try {
        const candidate = pickBest(media, await api.search(token, media.title, kind));
        if (candidate) {
          match = { ref: candidate.id, name: candidate.title || media.title, year: candidate.year ?? null };
          await store.setCachedMatch(cacheKey, match);
        }
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
    if (match) {
      session.match = match;
      session.state = "tracking";
      session.message = "";
    } else {
      session.state = "unmatched";
      session.message = `Couldn't find "${media.title}" on Bingers.`;
      notify(session.message);
    }
  } finally {
    resolving.delete(id);
    const s = sessions[id];
    if (s) setBadge(s.tabId, s);
    persist();
  }
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
      session.message = statuses.has("ok") ? "Marked watched on Bingers" : "Already marked on Bingers";
      await store.addHistory(label, statuses.has("ok") ? "marked watched" : "already watched");
      notify(`${label} marked watched`);
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

async function notify(message) {
  const settings = await store.getSettings();
  if (!settings.notifications) return;
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
  persist();
});
