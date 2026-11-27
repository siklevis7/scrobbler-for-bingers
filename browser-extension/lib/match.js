// Pick the Bingers search result that best fits what the streaming page shows.
// Mirrors the desktop app's matcher (src/bingers_scrobbler/matcher.py).

export const MIN_SIMILARITY = 0.85;

const NUMBER_WORDS = {
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  i: "1", ii: "2", iii: "3", iv: "4", volume: "vol",
};

export function normalize(text) {
  const ascii = String(text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ");
  let words = ascii.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  words = words.map((w) => NUMBER_WORDS[w] || w);
  if (words[0] === "the") words = words.slice(1);
  return words.join(" ");
}

/** Similarity 0..1, like Python's difflib ratio: 2 * common / total length. */
export function similarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1).fill(0);
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return (2 * prev[n]) / (m + n);
}

/**
 * @param {{kind: "episode"|"movie", title: string, year?: number|null}} media
 * @param {Array<object>} candidates  TitleSummary items from GET /search
 */
// Bingers tells same-name titles apart inside the name: "Dark Matter (2024)", "The Office (US)".
const TAG = /\s*\(((?:19|20)\d{2}|US|UK|AU|CA|NZ|IE)\)\s*$/i;
const COUNTRIES = new Set(["US", "UK", "AU", "CA", "NZ", "IE"]);

/** "Dark Matter (2024)" -> ["Dark Matter", "2024"]; "The Office (US)" -> ["The Office", "US"]. */
export function splitTag(name) {
  const m = String(name || "").match(TAG);
  return m ? [name.slice(0, m.index), m[1].toUpperCase()] : [name || "", null];
}

/** Search results that fit what the page shows, best first (ties keep the API's order). */
export function rankCandidates(media, candidates) {
  const wantKind = media.kind === "episode" ? "show" : "movie";
  const target = normalize(media.title);
  const scored = [];
  (candidates || []).forEach((c, index) => {
    if (c.kind !== wantKind) return;
    let sim = 0;
    let tag = null;
    for (const name of [c.title, c.original_title].filter(Boolean)) {
      const [base, t] = splitTag(name);
      tag = tag || t;
      sim = Math.max(sim, similarity(target, normalize(base)), similarity(target, normalize(name)));
    }
    if (sim < MIN_SIMILARITY) return;
    let score = sim;
    const year = Number.isInteger(c.year) ? c.year : tag && /^\d{4}$/.test(tag) ? Number(tag) : null;
    if (media.year && year) {
      const diff = Math.abs(year - media.year);
      if (diff === 0) score += 0.5;
      else if (diff === 1) score += 0.3; // premiered in December, listed as January, and the like
      else if (wantKind === "movie") return; // a remake or a different film with the same name
      else score -= 0.6; // a different show with the same name (a 1968 one vs 2020)
    }
    if (media.country && COUNTRIES.has(tag)) score += tag === media.country ? 0.3 : -0.3;
    scored.push({ score, index, c });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.c);
}

/**
 * @param {{kind: "episode"|"movie", title: string, year?: number|null, country?: string}} media
 * @param {Array<object>} candidates  TitleSummary items from GET /search
 */
export function pickBest(media, candidates) {
  return rankCandidates(media, candidates)[0] || null;
}

/**
 * Other ways a streaming site's name may differ from Bingers', tried in order when the exact
 * name finds nothing: "Star Wars: Andor" -> "Andor", "The Office (US)" -> "The Office",
 * "Doctor Who (2005)" -> "Doctor Who".
 */
export function searchVariants(title, year = null) {
  const t = String(title || "").trim();
  const out = [t];
  // A common name may not show the right one first: "Dark Matter 2024".
  if (year) out.push(`${t} ${year}`);
  const noTag = t.replace(/\s*\((?:US|UK|AU|CA|NZ|IE|\d{4})\)\s*$/i, "").trim();
  out.push(noTag);
  // Only the part after a colon (a franchise prefix); the part before is too broad
  // ("Avatar: The Last Airbender" must not become "Avatar").
  const colon = noTag.split(/\s*[:–—]\s+|\s+-\s+/);
  if (colon.length > 1) out.push(colon[colon.length - 1]);
  out.push(noTag.replace(/^(the|a|an)\s+/i, ""));
  return [...new Set(out.filter((v) => v && v.length >= 2))].slice(0, 5);
}

/** Find an episode by its name in Bingers' episode list (for sites that give no numbers). */
export function findEpisodeByName(list, name, season = null) {
  const target = normalize(name);
  if (!target) return null;
  let best = null;
  for (const ep of list || []) {
    if (season !== null && ep.season !== season) continue;
    const sim = similarity(target, normalize(ep.title));
    if (sim >= 0.85 && (!best || sim > best.sim)) best = { sim, ep };
  }
  return best ? best.ep : null;
}

export function mediaLabel(media) {
  if (!media) return "";
  let text = media.title;
  if (media.kind === "episode" && media.episode == null) {
    return media.episodeTitle ? `${text}: "${media.episodeTitle}"` : text;
  }
  if (media.kind === "episode") {
    const s = String(media.season ?? 1).padStart(2, "0");
    const e = String(media.episode).padStart(2, "0");
    text += ` S${s}E${e}`;
  } else if (media.year) {
    text += ` (${media.year})`;
  }
  return text;
}

export function buildItems(media, ref) {
  if (media.kind === "movie") return [{ title: ref }];
  return [{ title: ref, season: media.season ?? 1, episode: media.episode }];
}
