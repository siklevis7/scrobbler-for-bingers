// What to say after a mark (rewatch, next episode, finished show), the watch list for the
// pop-up, and the weekly summary. Mirrors the desktop app's insights.py and stats.py.

export const episodeCode = (season, number) =>
  `S${String(season).padStart(2, "0")}E${String(number).padStart(2, "0")}`;

/** How to say what Bingers did: marked, re-marked as a rewatch, or nothing new. */
export function markOutcome(results) {
  const statuses = new Set(results.map((r) => r.status));
  if (statuses.size === 1 && statuses.has("already")) return "already watched";
  if (results.some((r) => r.outcome === "rewatched")) return "marked as a rewatch";
  return "marked watched";
}

/** The regular episode right after season/number (specials, season 0, are skipped). */
export function nextEpisode(episodes, season, number) {
  const regular = (episodes || [])
    .filter((e) => Number.isInteger(e.season) && e.season > 0 && Number.isInteger(e.number))
    .sort((a, b) => a.season - b.season || a.number - b.number);
  return regular.find((e) => e.season > season || (e.season === season && e.number > number)) || null;
}

function dayOf(text) {
  const m = String(text || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function friendlyDate(day, today) {
  const delta = Math.round((day - today) / 86_400_000);
  if (delta === 0) return "today";
  if (delta === 1) return "tomorrow";
  if (delta > 1 && delta < 7) return `on ${day.toLocaleDateString("en-GB", { weekday: "long" })}`;
  const opts = { day: "numeric", month: "long" };
  if (day.getFullYear() !== today.getFullYear()) opts.year = "numeric";
  return `on ${day.toLocaleDateString("en-GB", opts)}`;
}

export function describeNext(episode, today = new Date()) {
  if (!episode) return null;
  const code = episodeCode(episode.season, episode.number);
  const name = String(episode.title || "").trim();
  const aired = dayOf(episode.aired_at);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!aired) return `Next: ${code} (no air date yet)`;
  if (aired <= midnight) return `Up next: ${code}${name ? ` · ${name}` : ""}`;
  return `Next episode, ${code}, airs ${friendlyDate(aired, midnight)}`;
}

const FINISHED_CATALOG = new Set(["ended", "canceled", "cancelled"]);

/**
 * After the last item of a mark: { note, finished, show, suggestions }. Never throws.
 * `api` is lib/api.js (passed in so tests can fake it).
 */
export async function afterMark(api, token, ref, season, number, { suggestions = true, today = new Date() } = {}) {
  const out = { note: null, finished: false, show: null, suggestions: [] };
  try {
    let list = await api.episodes(token, ref).catch((err) => {
      if (err.transient || err.auth) throw err;
      return []; // very long shows may insist on a season
    });
    if (!list.length) {
      list = await api.episodes(token, ref, season);
      if (!nextEpisode(list, season, number)) list = list.concat(await api.episodes(token, ref, season + 1));
    }
    const upcoming = nextEpisode(list, season, number);
    if (upcoming) {
      out.note = describeNext(upcoming, today);
      return out;
    }
    const entry = (await api.check(token, [ref]))[ref] || {};
    const title = entry.title || {};
    out.show = title.title || null;
    if (FINISHED_CATALOG.has(String(title.catalog_status || "").toLowerCase()) || entry.status === "completed") {
      out.finished = true;
      out.note = "That was the last episode.";
      if (suggestions) {
        const items = await api.similar(token, ref, 3).catch(() => []);
        out.suggestions = items
          .filter((i) => i.title && [undefined, null, "not_in_library", "not_started", "to_watch"].includes(i.my_status))
          .map((i) => i.title)
          .slice(0, 3);
      }
    } else {
      out.note = "You're caught up. No date yet for the next episode.";
    }
  } catch (err) {
    console.info("Couldn't look up what's next", err);
  }
  return out;
}

/** Watch list rows for the pop-up: [{ id, name, url, next, nextTitle, aired }]. */
export function watchItems(data, sections = ["watch_next", "collecting_dust"], limit = 8) {
  const out = [];
  for (const section of sections) {
    for (const item of data?.sections?.[section]?.items || []) {
      const n = item.progress?.next || {};
      const has = Number.isInteger(n.season) && Number.isInteger(n.number);
      out.push({
        id: String(item.id),
        name: String(item.title || "?"),
        url: item.url || null,
        next: has ? episodeCode(n.season, n.number) : null,
        nextTitle: has ? n.title || "" : "",
        aired: has ? n.aired_at || null : null,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function watchTotal(data, sections = ["watch_next", "collecting_dust"]) {
  return sections.reduce((sum, k) => sum + (Number(data?.sections?.[k]?.count) || 0), 0);
}

/** "In US: Netflix (streaming) · Apple TV (rent)", or "". */
export function whereToWatch(details) {
  const w = details?.where_to_watch || {};
  const parts = [];
  for (const [key, label] of [["streaming", "streaming"], ["free", "free"], ["rent", "rent"], ["buy", "buy"]]) {
    const names = [...new Set((w[key] || []).filter(Boolean))];
    if (names.length) parts.push(`${names.join(", ")} (${label})`);
  }
  if (!parts.length) return "";
  return (w.country ? `In ${w.country}: ` : "") + parts.join(" · ");
}

// -- weekly summary -------------------------------------------------------------

export const KEEP_DAYS = 21;

/** Monday 00:00 to the next Monday 00:00, local time, around `now`. */
export function weekBounds(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  return [start, end];
}

const isoDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The week to show now ([start, end]) or null. From Sunday 18:00 it's this week; later, last week. */
export function dueWeek(now, lastShown) {
  const [start, end] = weekBounds(now);
  let week;
  if (now.getDay() === 0 && now.getHours() >= 18) week = [start, end];
  else week = [new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7), start];
  return lastShown === isoDay(week[0]) ? null : week;
}

export const weekKey = (week) => isoDay(week[0]);

/** Apply a page of GET /entries to the kept rows ({ "episode:id": { kind, title, at } }). */
export function applyEntries(rows, items, now = new Date()) {
  const cutoff = now.getTime() - KEEP_DAYS * 86_400_000;
  for (const row of items || []) {
    const key = `${row.entity_kind}:${row.entity_id}`;
    const at = Date.parse(row.last_watched_at || "");
    if (row.deleted || !row.watched || !Number.isFinite(at) || at < cutoff) delete rows[key];
    else rows[key] = { kind: row.entity_kind, title: String(row.title_id || row.entity_id), at };
  }
  for (const [k, v] of Object.entries(rows)) if (v.at < cutoff) delete rows[k];
  return rows;
}

export function summarize(rows, titles, start, end) {
  const s = { episodes: 0, shows: 0, movies: 0, minutes: 0, top: [] };
  const perShow = {};
  for (const r of Object.values(rows || {})) {
    if (r.at < start.getTime() || r.at >= end.getTime()) continue;
    const info = titles?.[r.title] || {};
    s.minutes += Number(info.runtime) || 0;
    if (r.kind === "episode") {
      s.episodes += 1;
      const name = info.name || "?";
      perShow[name] = (perShow[name] || 0) + 1;
    } else {
      s.movies += 1;
    }
  }
  s.shows = Object.keys(perShow).length;
  s.top = Object.entries(perShow).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return s;
}

export function formatMinutes(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (!h) return `${m} min`;
  return `${h} h${m ? ` ${m} min` : ""}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function headline(s) {
  if (!s.episodes && !s.movies) return "Nothing marked watched.";
  const parts = [];
  if (s.episodes) parts.push(`${plural(s.episodes, "episode")} of ${plural(s.shows, "show")}`);
  if (s.movies) parts.push(plural(s.movies, "movie"));
  return `${parts.join(" and ")}${s.minutes ? `, about ${formatMinutes(s.minutes)}` : ""}.`;
}

export function describeWeek(rows, titles, start, end, label) {
  const cur = summarize(rows, titles, start, end);
  const span = end.getTime() - start.getTime();
  const before = summarize(rows, titles, new Date(start.getTime() - span), start);
  const lines = [`${label}: ${headline(cur)}`];
  if (cur.top.length && cur.top[0][1] > 1) lines.push(`Most watched: ${cur.top[0][0]} (${cur.top[0][1]} episodes).`);
  const diff = cur.episodes - before.episodes;
  if (diff && (cur.episodes || before.episodes)) {
    lines.push(`${plural(Math.abs(diff), "episode")} ${diff > 0 ? "more" : "fewer"} than the week before.`);
  }
  return { text: lines.join("\n"), empty: !cur.episodes && !cur.movies };
}
