import { SERVICES } from "../lib/storage.js";

const $ = (id) => document.getElementById(id);

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

  $("service").textContent = info ? SERVICES[info.service]?.name || info.service : "This tab";
  $("progressBox").hidden = true;
  $("markNow").hidden = true;
  $("matched").textContent = "";
  $("message").textContent = "";

  if (!st.signedIn) {
    $("state").textContent = "Sign in needed";
    $("state").className = "pill warn";
    $("label").textContent = "Open Settings and paste your Bingers token.";
  } else if (!info) {
    $("state").textContent = "Idle";
    $("state").className = "pill";
    $("label").textContent = "Nothing playing here";
    $("message").textContent =
      "Play an episode or movie on Netflix, Prime Video, Disney+ or Max, then open this again.";
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
    if (s.match) {
      $("matched").textContent = `Bingers: ${s.match.name}${s.match.year ? ` (${s.match.year})` : ""}`;
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

currentTab = await render();
setInterval(async () => {
  currentTab = await render();
}, 2000);
