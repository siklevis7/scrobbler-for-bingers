import { SERVICES } from "../lib/storage.js";
import { UNIVERSAL_SCRIPTS, addSite, isBuiltIn, isCustomSite, originPattern, removeSite } from "../lib/sites.js";

const $ = (id) => document.getElementById(id);

const SOURCES = {
  player: "read from the player",
  "media controls": "read from the browser's media controls",
  "page data": "read from the page's info",
  "tab title": "read from the tab title (less reliable)",
};

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
    $("label").textContent = "A video is playing, but its title isn't readable.";
    $("message").textContent =
      "Move your mouse over the video so the player shows the title, and wait a few seconds. " +
      "If it keeps happening, the site may have changed; please report it on GitHub.";
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
    $("message").textContent = s.message || "";
    if (s.state === "tracking" || s.state === "matching") {
      $("progressBox").hidden = false;
      $("bar").style.width = `${Math.min(100, s.progress)}%`;
      $("mark").style.left = `${st.threshold}%`;
      $("progressText").textContent = `${Math.floor(s.progress)}% (marks at ${st.threshold}%)`;
      $("watchedText").textContent = `watched ${minutes(s.watchedSeconds)} / ${minutes(st.needed)}`;
    }
    $("markNow").hidden = !(s.match && (s.state === "tracking" || s.state === "error"));
  }

  $("backlog").hidden = !st.backlog;
  $("backlog").textContent = `${st.backlog} saved mark(s) waiting to be sent.`;
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
  if (await isCustomSite(origin)) {
    siteState = { kind: "custom", origin };
    $("siteAdded").hidden = false;
    return;
  }

  // Look for the video player: it may sit in a frame from another domain, which needs access too.
  let frameOrigins = [];
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () =>
        [...document.querySelectorAll("iframe")]
          .filter((f) => {
            const r = f.getBoundingClientRect();
            return r.width >= 300 && r.height >= 150; // player-sized, not ads or trackers
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
    frameOrigins = [...new Set(res?.result || [])].slice(0, 3);
  } catch {
    // Some pages (e.g. the browser's own) can't be scripted; the button still works for the page itself.
  }

  siteState = { kind: "untracked", origin, frameOrigins, tabId: tab.id };
  $("siteName").textContent = url.hostname.replace(/^www\./, "");
  $("siteCard").hidden = false;
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
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: UNIVERSAL_SCRIPTS });
  } catch {
    // Fine: the scripts run on the next page load anyway.
  }
  siteState = { kind: "custom", origin };
  $("siteCard").hidden = true;
  $("siteAdded").hidden = false;
  $("message").textContent =
    "Turned on. Play the video; if nothing shows up within 10 seconds, reload the page.";
});

$("untrackSite").addEventListener("click", async (e) => {
  e.preventDefault();
  await removeSite(siteState.origin);
  $("siteAdded").hidden = true;
  $("message").textContent = "Stopped tracking this site.";
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
currentTab = await render();
setInterval(async () => {
  currentTab = await render();
}, 2000);
