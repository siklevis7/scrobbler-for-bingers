// Minimal Bingers API client (https://bingers.app/developers.md).

export const BASE_URL = "https://api.bingers.app/v1";

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, transient?: boolean, auth?: boolean, retryAfter?: number}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.status = info.status;
    this.transient = Boolean(info.transient); // safe to retry later
    this.auth = Boolean(info.auth); // token missing, revoked, read-only, or no plan
    this.retryAfter = info.retryAfter;
  }
}

async function errorMessage(resp) {
  try {
    const data = await resp.json();
    return data?.error?.message || `HTTP ${resp.status}`;
  } catch {
    return `HTTP ${resp.status}`;
  }
}

const LANG_PATHS = new Set(["/search", "/similar", "/watchlist", "/library/check", "/titles", "/entries", "/recent", "/library"]);

/** True for the endpoints whose contract lists a `lang` parameter. */
export function takesLang(path) {
  const p = String(path).split("?")[0];
  // /titles/{ref} takes it, /titles/{ref}/episodes doesn't.
  return LANG_PATHS.has(p) || (p.startsWith("/titles/") && p.split("/").length === 3);
}

export async function request(token, method, path, { params, body } = {}, fetchImpl = fetch) {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  // Names in English. Without it Bingers answers with original names ("La casa de papel",
  // "進撃の巨人"), which the English names on most sites never match. lang: "" turns it off.
  // Only where the contract allows it: /me and episode lists answer 400 to an unknown parameter.
  if (method === "GET" && takesLang(path) && !(params && "lang" in params)) url.searchParams.set("lang", "en");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let resp;
  try {
    resp = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    throw new ApiError(`Network error: ${err.message}`, { transient: true });
  }
  if (resp.status === 429) {
    const retryAfter = Number(resp.headers.get("Retry-After")) || 60;
    throw new ApiError("Rate limited by Bingers", { status: 429, transient: true, retryAfter });
  }
  if (resp.status >= 500) throw new ApiError(`Bingers server error (${resp.status})`, { status: resp.status, transient: true });
  if (resp.status === 401 || resp.status === 403) {
    throw new ApiError(await errorMessage(resp), { status: resp.status, auth: true });
  }
  if (resp.status >= 400) throw new ApiError(await errorMessage(resp), { status: resp.status });
  if (resp.status === 204) return {};
  try {
    return await resp.json();
  } catch {
    return {};
  }
}

export const me = (token, f) => request(token, "GET", "/me", {}, f);

export async function search(token, query, kind, f) {
  const data = await request(token, "GET", "/search", { params: { q: query, kind, limit: 10 } }, f);
  return data.items || [];
}

/** Search with titles in their own language, for pages that show the original name. */
export async function searchOriginal(token, query, kind, f) {
  const data = await request(token, "GET", "/search", { params: { q: query, kind, limit: 10, lang: "" } }, f);
  return data.items || [];
}

/** Your status with up to 100 titles: { ref: { status, last_watched_at, furthest, title } }. */
export async function check(token, refs, f) {
  const list = [...new Set((refs || []).filter(Boolean))].slice(0, 100);
  if (!list.length) return {};
  const data = await request(token, "GET", "/library/check", { params: { titles: list.join(",") } }, f);
  return Object.fromEntries((data.items || []).map((i) => [String(i.ref), i]));
}

/** One title, with where to watch it in your country. */
export const title = (token, ref, f) => request(token, "GET", `/titles/${encodeURIComponent(ref)}`, {}, f);

/** Catalog details for up to 100 titles. */
export async function titles(token, ids, f) {
  const list = [...new Set((ids || []).filter(Boolean))].slice(0, 100);
  if (!list.length) return [];
  const data = await request(token, "GET", "/titles", { params: { ids: list.join(",") } }, f);
  return data.items || [];
}

/** Titles like this one, minus what's already in your library. */
export async function similar(token, ref, limit = 3, f) {
  const params = { title: ref, exclude_library: "true", limit };
  const data = await request(token, "GET", "/similar", { params }, f);
  return data.items || [];
}

/** The watch list as the app shows it: { sections: { watch_next: { count, items }, … } }. */
export const watchlist = (token, limit = 10, f) => request(token, "GET", "/watchlist", { params: { limit } }, f);

/** Change feed of the watch history; always pass back next_cursor. */
export const entries = (token, cursor, f) =>
  request(token, "GET", "/entries", { params: { cursor: cursor || undefined, limit: 10000 } }, f);

/** A show's episodes: [{ id, season, number, title, aired_at }]. */
export async function episodes(token, ref, season, f) {
  const params = Number.isInteger(season) ? { season } : {};
  const data = await request(token, "GET", `/titles/${encodeURIComponent(ref)}/episodes`, { params }, f);
  return Array.isArray(data.items) ? data.items : [];
}

export async function scrobble(token, items, dryRun = false, f) {
  const body = { items };
  if (dryRun) body.dry_run = true;
  const data = await request(token, "POST", "/scrobble", { body }, f);
  return data.results || [];
}

export function displayName(meResponse) {
  const user = meResponse?.user || {};
  if (user.name && user.handle) return `${user.name} (@${user.handle})`;
  return user.name || (user.handle ? `@${user.handle}` : "your account");
}

export function describeResult(r) {
  let text = r?.title?.title || "?";
  const ep = r?.episode;
  if (ep && ep.season != null && ep.number != null) {
    text += ` S${String(ep.season).padStart(2, "0")}E${String(ep.number).padStart(2, "0")}`;
  }
  text += `: ${r?.status || "?"}`;
  if (r?.outcome) text += ` (${r.outcome})`;
  if (r?.message) text += ` - ${r.message}`;
  return text;
}
