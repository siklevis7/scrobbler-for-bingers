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

export async function request(token, method, path, { params, body } = {}, fetchImpl = fetch) {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
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
