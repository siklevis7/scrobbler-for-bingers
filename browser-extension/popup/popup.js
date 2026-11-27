import { SERVICES } from "../lib/storage.js";
import { addSite, getCustomSite, injectNow, isBuiltIn, originPattern, removeSite } from "../lib/sites.js";

const $ = (id) => document.getElementById(id);

const SOURCES = {
  player: "read from the player",
  "page data": "read from the page's info",
  "player software": "read from the video player's settings",
  "media controls": "read from the browser's media controls",
  "tab title": "read from the tab title",
  "player overlay": "read from the text on the player",
  "app data": "read from the page's app data",
  "video label": "read from the video's label",
  "web address": "read from the web address",
  "page heading": "read from the page heading",
  you: "picked by you",
};

let fixOpened = false; // the panel keeps what you typed while the popup refreshes

let siteState = { kind: "none" }; // none | builtin | custom | untracked

const STATES = {
  matching: ["Finding on Bingers…", "live"],
  tracking: ["Tracking", "live"],
  done: ["Marked watched", "ok"],
  queued: ["Saved, will send", "warn"],
  unmatched: ["Not found", "bad"],
  error: ["Problem", "bad"],
};

function minutes(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const st = await chrome.runtime.sendMessage({ type: "getTabState", tabId: tab?.id });

  $("account").textContent = st.signedIn ? `Signed in as ${st.account}` : "Not signed in";
  const s = st.session;
  const info = st.info;

  const serviceName = info?.service === "custom" ? info.site : SERVICES[info?.service]?.name || info?.service;
  $("service").textContent = info ? serviceName : "This tab";
  $("progressBox").hidden = true;
  $("markNow").hidden = true;
  $("openFix").hidden = true;
  $("matched").textContent = "";
  $("message").textContent = "";

  if (!st.signedIn) {
    $("state").textContent = "Sign in needed";
    $("state").className = "pill warn";
    $("label").textContent = "Open Settings and paste your Bingers token.";
  } else if (!info) {
    $("state").textContent = siteState.kind === "untracked" ? "Not tracked" : "Idle";
    $("state").className = "pill";
    $("label").textContent = "Nothing playing here";
    $("message").textContent = {
      untracked: "Turn this site on below to track what you watch here.",
      custom: "This site is turned on. Play an episode or movie: it shows up here within a few seconds (reload the page if it doesn't).",
    }[siteState.kind] || "Play an episode or movie, then open this again. On a site that isn't built in, use 'Track videos on this site'.";
  } else if (info.disabled) {
    $("state").textContent = "Off";
    $("state").className = "pill";
    $("label").textContent = "This service is turned off in Settings.";
  } else if (info.noMedia || !s) {
    $("state").textContent = "Can't read title";
    $("state").className = "pill warn";
    $("label").textContent = "A video is playing, but the extension can't tell what it is.";
    $("message").textContent = "Tell it below: search Bingers and pick the right one. It's remembered next time.";
    openFix(st);
  } else {
    const [text, cls] = STATES[s.state] || [s.state, ""];
    $("state").textContent = text;
    $("state").className = `pill ${cls}`;
    $("label").textContent = st.label;
    const how = SOURCES[s.media?.source] ? ` · ${SOURCES[s.media.source]}` : "";
    if (s.match) {
      $("matched").textContent = `Bingers: ${s.match.name}${s.match.year ? ` (${s.match.year})` : ""}${how}`;
    } else if (how) {
      $("matched").textContent = how.slice(3);
    }
    $("message").textContent = [s.message, s.state === "tracking" ? s.note : ""].filter(Boolean).join(" ");
    if (s.state === "tracking" || s.state === "matching") {
      $("progressBox").hidden = false;
      $("bar").style.width = `${Math.min(100, s.progress)}%`;
      $("mark").style.left = `${st.threshold}%`;
      $("progressText").textContent = `${Math.floor(s.progress)}% (marks at ${st.threshold}%)`;
      $("watchedText").textContent = `watched ${minutes(s.watchedSeconds)} / ${minutes(st.needed)}`;
    }
    $("markNow").hidden = !(s.match && (s.state === "tracking" || s.state === "error"));
    if (s.state === "unmatched") openFix(st);
    else $("openFix").hidden = fixOpened;
  }

  $("backlog").hidden = !st.backlog;
  $("backlog").textContent = `${st.backlog} saved mark(s) waiting to be sent.`;
  lastState = st;
  return tab;
}

/** Work out whether this tab's site is built in, added by the user, or not tracked yet. */
async function setupSiteCard(tab) {
  let url;
  try {
    url = new URL(tab?.url || "");
  } catch {
    return;
  }
  if (!/^https?:$/.test(url.protocol)) return;
  const origin = url.origin;

  if (isBuiltIn(url.href)) {
    siteState = { kind: "builtin", origin };
    return;
  }

  // Look for the video player: it may sit in a frame from another domain, which needs access too.
  const frameOrigins = await scanPlayerFrames(tab.id);
  const site = await getCustomSite(origin);
  if (site) {
    siteState = { kind: "custom", origin, tabId: tab.id };
    $("siteAdded").hidden = false;
    // A player from a domain we don't have access to yet (the site may have changed players).
    const missing = [];
    for (const o of frameOrigins) {
      if (!(await chrome.permissions.contains({ origins: [originPattern(o)] }))) missing.push(o);
    }
    if (missing.length) {
      siteState.missing = missing;
      $("playerHosts").textContent = missing.map((o) => new URL(o).hostname).join(", ");
      $("playerCard").hidden = false;
    }
    return;
  }

  siteState = { kind: "untracked", origin, frameOrigins, tabId: tab.id };
  $("siteName").textContent = url.hostname.replace(/^www\./, "");
  $("siteCard").hidden = false;
}

/** Domains of player-sized frames on the page (not ads or trackers). */
async function scanPlayerFrames(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        [...document.querySelectorAll("iframe")]
          .filter((f) => {
            const r = f.getBoundingClientRect();
            return r.width >= 300 && r.height >= 150;
          })
          .map((f) => {
            try {
              return new URL(f.src, location.href).origin;
            } catch {
              return null;
            }
          })
          .filter((o) => o && /^https?:/.test(o) && o !== location.origin),
    });
    return [...new Set(res?.result || [])].slice(0, 3);
  } catch {
    return []; // pages like the browser's own can't be scripted
  }
}

$("trackSite").addEventListener("click", async () => {
  const { origin, frameOrigins, tabId } = siteState;
  const origins = [origin, ...frameOrigins].map(originPattern);
  // Must be the first thing in the click handler: browsers only show the prompt for a user action.
  const granted = await chrome.permissions.request({ origins });
  if (!granted) {
    $("siteMessage").textContent = "Not turned on: the browser's permission was declined.";
    return;
  }
  await addSite(origin, frameOrigins);
  await injectNow(tabId);
  siteState = { kind: "custom", origin, tabId };
  $("siteCard").hidden = true;
  $("siteAdded").hidden = false;
  $("message").textContent =
    "Turned on. Play the video; if nothing shows up within 10 seconds, reload the page.";
});

$("allowPlayer").addEventListener("click", async () => {
  const { origin, missing, tabId } = siteState;
  const granted = await chrome.permissions.request({ origins: missing.map(originPattern) });
  if (!granted) return;
  await addSite(origin, missing);
  await injectNow(tabId);
  $("playerCard").hidden = true;
  $("message").textContent = "Player allowed. If nothing shows up within 10 seconds, reload the page.";
});

$("copyDetails").addEventListener("click", async (e) => {
  e.preventDefault();
  const st = lastState || {};
  const details = {
    extension: chrome.runtime.getManifest().version,
    browser: navigator.userAgent.replace(/^.*?(Chrome|Edg|Firefox)\//, "$1/"),
    site: st.info?.site,
    state: st.session ? { state: st.session.state, message: st.session.message, media: st.session.media } : "can't read title",
    pageSays: st.info?.hint,
    sources: st.info?.diag || "not collected yet (keep the video playing for 30 seconds)",
  };
  await navigator.clipboard.writeText("```json\n" + JSON.stringify(details, null, 2) + "\n```");
  $("fixMessage").textContent = "Details copied. Paste them into the bug report.";
});

$("untrackSite").addEventListener("click", async (e) => {
  e.preventDefault();
  await removeSite(siteState.origin);
  $("siteAdded").hidden = true;
  $("message").textContent = "Stopped tracking this site.";
});

// -- "Fix it": search Bingers and pick the right title ---------------------------------

let lastState = null;

/** Show the panel, pre-filled from what was detected (or the page's raw text), once. */
function openFix(st) {
  lastState = st;
  if (fixOpened) return;
  fixOpened = true;
  $("fixCard").hidden = false;
  $("openFix").hidden = true;

  const media = st.session?.media;
  const hint = st.info?.hint || "";
  // Make the most of the page's raw text, e.g. a file name, even if it wasn't confident.
  const guess = !media && hint ? globalThis.BSParse?.parseMediaText(hint, { site: st.info?.site, strong: true }) : null;
  const from = media || guess;
  $("fixQuery").value = from?.title || hint;
  $("fixSeason").value = from?.season ?? "";
  $("fixEpisode").value = from?.episode ?? "";
  $("fixHint").textContent = hint ? `The page says: "${hint}"` : "";
  if ($("fixQuery").value) search();
  else $("fixQuery").focus();
}

async function search() {
  const query = $("fixQuery").value.trim();
  $("fixMessage").textContent = "Searching Bingers…";
  $("fixResults").replaceChildren();
  const res = await chrome.runtime.sendMessage({ type: "searchTitles", query });
  if (res?.error) {
    $("fixMessage").textContent = res.error;
    return;
  }
  if (!res.items.length) {
    $("fixMessage").textContent = "No results. Try a shorter or different name.";
    return;
  }
  $("fixMessage").textContent = "Tap the right one:";
  $("fixResults").replaceChildren(
    ...res.items.map((item) => {
      const b = document.createElement("button");
      b.className = "result";
      const name = document.createElement("span");
      name.textContent = item.title;
      const meta = document.createElement("small");
      meta.textContent = `${item.kind === "show" ? "Show" : "Movie"}${item.year ? ` · ${item.year}` : ""}`;
      b.append(name, meta);
      b.addEventListener("click", () => choose(item));
      return b;
    })
  );
}

async function choose(item) {
  const res = await chrome.runtime.sendMessage({
    type: "chooseTitle",
    tabId: currentTab?.id,
    candidate: item,
    season: $("fixSeason").value,
    episode: $("fixEpisode").value,
  });
  if (res?.error) {
    $("fixMessage").textContent = res.error;
    if (res.error.includes("episode")) $("fixEpisode").focus();
    return;
  }
  $("fixCard").hidden = true;
  fixOpened = false;
  currentTab = await render();
  $("message").textContent = `Got it: tracking ${res.label}. Next time this name shows up, it's matched automatically.`;
}

$("fixSearch").addEventListener("click", search);
$("fixQuery").addEventListener("keydown", (e) => {
  if (e.key === "Enter") search();
});
$("openFix").addEventListener("click", (e) => {
  e.preventDefault();
  fixOpened = false;
  openFix(lastState || {});
});

let currentTab;
$("settings").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
$("markNow").addEventListener("click", async () => {
  $("markNow").disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "markNow", tabId: currentTab?.id });
  $("markNow").disabled = false;
  if (res?.error) $("message").textContent = res.error;
  currentTab = await render();
});

const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
await setupSiteCard(activeTab);
// -- What to watch ------------------------------------------------------------

async function loadWatchlist() {
  const res = await chrome.runtime.sendMessage({ type: "getWatchlist" });
  if (!res || res.error) return; // signed out or offline: the card stays hidden
  const list = $("watchList");
  list.replaceChildren();
  if (!res.items.length) {
    const p = document.createElement("p");
    p.className = "small muted";
    p.style.margin = "4px 0 0";
    p.textContent = "Nothing waiting: you're all caught up.";
    list.append(p);
  }
  for (const item of res.items) {
    const btn = document.createElement("button");
    btn.className = "watch";
    const name = document.createElement("b");
    name.textContent = item.name;
    const next = document.createElement("small");
    next.textContent = item.next ? `${item.next}${item.nextTitle ? ` · ${item.nextTitle}` : ""}` : "Not started";
    const where = document.createElement("small");
    where.className = "where";
    where.hidden = true;
    btn.append(name, next, where);
    btn.title = "Click: where to watch it. Click again: open it on Bingers.";
    btn.addEventListener("click", async () => {
      if (!where.hidden) {
        if (item.url) chrome.tabs.create({ url: item.url });
        return;
      }
      where.hidden = false;
      where.textContent = "Looking up where to watch it…";
      const d = await chrome.runtime.sendMessage({ type: "titleDetails", id: item.id });
      where.textContent = d.error
        ? `Couldn't load it: ${d.error}`
        : `${d.where || "No streaming info for your country."} Click again to open it on Bingers.`;
    });
    list.append(btn);
  }
  const more = res.total - res.items.length;
  $("watchMore").hidden = more <= 0;
  $("watchMore").textContent = `…and ${more} more on Bingers.`;
  $("watchCard").hidden = false;
}

$("weekLink").addEventListener("click", async (e) => {
  e.preventDefault();
  const box = $("weekText");
  box.hidden = false;
  box.textContent = "Adding up your week…";
  const res = await chrome.runtime.sendMessage({ type: "getWeek" });
  box.textContent = res.error ? `Couldn't load it: ${res.error}` : res.text;
});

loadWatchlist().catch(() => {});

currentTab = await render();
setInterval(async () => {
  currentTab = await render();
}, 2000);
