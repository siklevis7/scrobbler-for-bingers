// Sites the user turned on themselves: optional permissions plus dynamically registered
// content scripts, so new streaming services work without an extension update.

import { getSettings, saveSettings } from "./storage.js";

export const UNIVERSAL_SCRIPTS = ["content/parse.js", "content/common.js", "content/sites/universal.js"];
export const PROBE_SCRIPTS = ["content/page-probe.js"]; // runs in the page to ask its video player

/** Start tracking in an open tab right away, without a reload. */
export async function injectNow(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: PROBE_SCRIPTS, world: "MAIN" }).catch(() => {});
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: UNIVERSAL_SCRIPTS }).catch(() => {});
}

/** Turn a manifest match pattern like "https://www.amazon.*" into a RegExp. */
function patternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** True if a built-in reader already covers this URL. */
export function isBuiltIn(url) {
  const manifest = chrome.runtime.getManifest();
  const patterns = (manifest.content_scripts || []).flatMap((c) => c.matches || []);
  return patterns.some((p) => patternToRegExp(p).test(url));
}

export function originPattern(origin) {
  return `${origin}/*`;
}

function scriptId(origin) {
  return `site_${origin.replace(/[^a-z0-9]/gi, "_")}`;
}

export async function getCustomSites() {
  const settings = await getSettings();
  return Array.isArray(settings.customSites) ? settings.customSites : [];
}

export async function isCustomSite(origin) {
  return (await getCustomSites()).some((s) => s.origin === origin);
}

async function register(site) {
  const matches = [site.origin, ...(site.frameOrigins || [])].map(originPattern);
  const entries = [
    { id: scriptId(site.origin), js: UNIVERSAL_SCRIPTS },
    { id: `${scriptId(site.origin)}_probe`, js: PROBE_SCRIPTS, world: "MAIN" },
  ].map((e) => ({ ...e, matches, allFrames: true, runAt: "document_idle", persistAcrossSessions: true }));
  const ids = entries.map((e) => e.id);
  const existing = new Set((await chrome.scripting.getRegisteredContentScripts({ ids })).map((e) => e.id));
  for (const entry of entries) {
    if (existing.has(entry.id)) await chrome.scripting.updateContentScripts([entry]);
    else await chrome.scripting.registerContentScripts([entry]);
  }
}

async function unregister(origin) {
  await chrome.scripting.unregisterContentScripts({ ids: [scriptId(origin), `${scriptId(origin)}_probe`] }).catch(() => {});
}

/**
 * Call after chrome.permissions.request() granted access to the site (and its player frames).
 * Calling it again for the same site adds more player domains to it.
 */
export async function addSite(origin, frameOrigins = []) {
  const sites = await getCustomSites();
  const previous = sites.find((s) => s.origin === origin);
  const frames = [...new Set([...(previous?.frameOrigins || []), ...frameOrigins])].filter((o) => o !== origin);
  const site = { origin, frameOrigins: frames, addedAt: previous?.addedAt || Date.now() };
  await register(site);
  await saveSettings({ customSites: [...sites.filter((s) => s.origin !== origin), site] });
  return site;
}

export async function getCustomSite(origin) {
  return (await getCustomSites()).find((s) => s.origin === origin) || null;
}

export async function removeSite(origin) {
  const sites = await getCustomSites();
  const site = sites.find((s) => s.origin === origin);
  await unregister(origin);
  if (site) {
    const origins = [site.origin, ...(site.frameOrigins || [])].map(originPattern);
    await chrome.permissions.remove({ origins }).catch(() => {});
  }
  await saveSettings({ customSites: sites.filter((s) => s.origin !== origin) });
}

/** On start-up: re-register sites we still have permission for, forget the others. */
export async function syncSites() {
  const kept = [];
  for (const site of await getCustomSites()) {
    const has = await chrome.permissions.contains({ origins: [originPattern(site.origin)] });
    if (has) {
      await register(site).catch((e) => console.warn("Couldn't register", site.origin, e));
      kept.push(site);
    } else {
      await unregister(site.origin);
    }
  }
  await saveSettings({ customSites: kept });
}
