// Settings, match cache, backlog and history in chrome.storage.local.

export const SERVICES = {
  netflix: { name: "Netflix" },
  prime: { name: "Prime Video" },
  disney: { name: "Disney+" },
  max: { name: "Max / HBO Max" },
  generic: { name: "Apple TV+, Hulu, Paramount+, Peacock (experimental)" },
  custom: { name: "Sites you added yourself" },
};

export const DEFAULT_SETTINGS = {
  token: "",
  account: "",
  threshold: 80,
  minWatchedMinutes: 5,
  notifications: true,
  services: Object.fromEntries(Object.keys(SERVICES).map((k) => [k, true])),
  customSites: [], // [{ origin, frameOrigins, addedAt }] turned on with "Track videos on this site"
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return {
    ...DEFAULT_SETTINGS,
    ...(settings || {}),
    services: { ...DEFAULT_SETTINGS.services, ...(settings?.services || {}) },
  };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch, services: { ...current.services, ...(patch.services || {}) } };
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function getList(key) {
  const data = await chrome.storage.local.get(key);
  return Array.isArray(data[key]) ? data[key] : [];
}

export const getBacklog = () => getList("backlog");
export const setBacklog = (items) => chrome.storage.local.set({ backlog: items });

export async function addHistory(what, result) {
  const history = await getList("history");
  history.unshift({ time: new Date().toISOString(), what, result });
  await chrome.storage.local.set({ history: history.slice(0, 200) });
}
export const getHistory = () => getList("history");

export async function getCachedMatch(key) {
  const { matchCache } = await chrome.storage.local.get("matchCache");
  return matchCache?.[key] || null;
}

export async function setCachedMatch(key, match) {
  const { matchCache } = await chrome.storage.local.get("matchCache");
  const cache = matchCache || {};
  cache[key] = match;
  const keys = Object.keys(cache);
  if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete cache[k];
  await chrome.storage.local.set({ matchCache: cache });
}
