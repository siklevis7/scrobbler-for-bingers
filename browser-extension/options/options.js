import { getCustomSites, removeSite } from "../lib/sites.js";
import { SERVICES, getBacklog, getHistory, getSettings, saveSettings } from "../lib/storage.js";

const $ = (id) => document.getElementById(id);

async function renderCustomSites() {
  const sites = await getCustomSites();
  const rows = sites.map((site) => {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = new URL(site.origin).hostname.replace(/^www\./, "");
    if (site.frameOrigins?.length) {
      const small = document.createElement("div");
      small.className = "small muted";
      small.textContent = `plus its player: ${site.frameOrigins.map((o) => new URL(o).hostname).join(", ")}`;
      name.append(small);
    }
    const action = document.createElement("td");
    action.style.textAlign = "right";
    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.textContent = "Remove";
    btn.addEventListener("click", async () => {
      await removeSite(site.origin);
      await renderCustomSites();
    });
    action.append(btn);
    tr.append(name, action);
    return tr;
  });
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td class="muted">No sites added yet.</td>';
    rows.push(tr);
  }
  $("customSites").replaceChildren(...rows);
}

function flash(text) {
  $("saved").textContent = text;
  setTimeout(() => ($("saved").textContent = ""), 1500);
}

async function renderAccount() {
  const s = await getSettings();
  $("signedIn").textContent = s.token ? `Signed in as ${s.account}.` : "Not signed in.";
  $("signedIn").className = s.token ? "" : "muted";
  $("signOut").hidden = !s.token;
  $("howto").hidden = Boolean(s.token);
}

async function renderHistory() {
  const backlog = await getBacklog();
  $("backlog").textContent = backlog.length
    ? `${backlog.length} mark(s) saved while Bingers was unreachable; they're sent automatically every minute.`
    : "";
  $("flush").hidden = !backlog.length;
  const rows = (await getHistory()).slice(0, 50).map((h) => {
    const tr = document.createElement("tr");
    for (const v of [new Date(h.time).toLocaleString(), h.what, h.result]) {
      const td = document.createElement("td");
      td.textContent = v;
      tr.append(td);
    }
    return tr;
  });
  $("history").replaceChildren(...rows);
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="3" class="muted">Nothing marked yet.</td>';
    $("history").append(tr);
  }
}

async function init() {
  const s = await getSettings();
  await renderAccount();

  const threshold = $("threshold");
  if (![...threshold.options].some((o) => Number(o.value) === s.threshold)) {
    threshold.add(new Option(`${s.threshold}%`, String(s.threshold)));
  }
  threshold.value = String(s.threshold);
  $("minWatched").value = String(s.minWatchedMinutes);
  $("notifications").checked = s.notifications;
  for (const key of ["upNext", "suggestions", "weeklySummary"]) {
    $(key).checked = s[key] !== false;
    $(key).addEventListener("change", async () => {
      await saveSettings({ [key]: $(key).checked });
      flash("Saved");
    });
  }

  const box = $("services");
  for (const [key, svc] of Object.entries(SERVICES)) {
    const label = document.createElement("label");
    label.className = "check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = s.services[key] !== false;
    input.addEventListener("change", async () => {
      await saveSettings({ services: { [key]: input.checked } });
      flash("Saved");
    });
    label.append(input, document.createTextNode(` ${svc.name}`));
    box.append(label);
  }

  threshold.addEventListener("change", async () => {
    await saveSettings({ threshold: Number(threshold.value) });
    flash("Saved");
  });
  $("minWatched").addEventListener("change", async () => {
    const v = Math.max(0, Math.min(60, Number($("minWatched").value) || 0));
    $("minWatched").value = String(v);
    await saveSettings({ minWatchedMinutes: v });
  });
  $("notifications").addEventListener("change", async () => {
    await saveSettings({ notifications: $("notifications").checked });
  });

  $("save").addEventListener("click", async () => {
    $("save").disabled = true;
    $("status").style.color = "";
    $("status").textContent = "Checking with Bingers…";
    const res = await chrome.runtime.sendMessage({ type: "checkToken", token: $("token").value });
    $("save").disabled = false;
    if (res?.ok) {
      $("token").value = "";
      $("status").style.color = "var(--ok)";
      $("status").textContent = `Signed in as ${res.account}. You're all set: play something on a streaming site.`;
    } else {
      $("status").style.color = "var(--bad)";
      $("status").textContent =
        `${res?.error || "Something went wrong."} Check that the token is "read + write" and your plan is Legend or Icon.`;
    }
    await renderAccount();
  });
  $("token").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("save").click();
  });
  $("signOut").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "signOut" });
    $("status").textContent = "Signed out.";
    await renderAccount();
  });
  $("flush").addEventListener("click", async () => {
    const res = await chrome.runtime.sendMessage({ type: "flushBacklog" });
    $("backlog").textContent = `Sent ${res.sent}; ${res.waiting} still waiting.`;
    await renderHistory();
  });

  await renderCustomSites();
  await renderHistory();
  setInterval(renderHistory, 5000);
}

init();
