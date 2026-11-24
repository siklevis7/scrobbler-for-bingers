// Sites the user turned on themselves: optional permissions plus dynamically registered
// content scripts, so new streaming services work without an extension update.

import { getSettings, saveSettings } from "./storage.js";

export const UNIVERSAL_SCRIPTS = ["content/parse.js", "content/common.js", "content/sites/universal.js"];

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
  const entry = {
    id: scriptId(site.origin),
    matches: [site.origin, ...(site.frameOrigins || [])].map(originPattern),
    js: UNIVERSAL_SCRIPTS,
    allFrames: true,
    runAt: "document_idle",
    persistAcrossSessions: true,
  };
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [entry.id] });
  if (existing.length) await chrome.scripting.updateContentScripts([entry]);
  else await chrome.scripting.registerContentScripts([entry]);
}

/** Call after chrome.permissions.request() granted access to the site (and its player frames). */
export async function addSite(origin, frameOrigins = []) {
  const site = { origin, frameOrigins: [...new Set(frameOrigins)].filter((o) => o !== origin), addedAt: Date.now() };
  await register(site);
  const others = (await getCustomSites()).filter((s) => s.origin !== origin);
  await saveSettings({ customSites: [...others, site] });
  return site;
}

export async function removeSite(origin) {
  const sites = await getCustomSites();
  const site = sites.find((s) => s.origin === origin);
  await chrome.scripting.unregisterContentScripts({ ids: [scriptId(origin)] }).catch(() => {});
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
      await chrome.scripting.unregisterContentScripts({ ids: [scriptId(site.origin)] }).catch(() => {});
    }
  }
  await saveSettings({ customSites: kept });
}
