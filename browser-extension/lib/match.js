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
export function pickBest(media, candidates) {
  const wantKind = media.kind === "episode" ? "show" : "movie";
  const target = normalize(media.title);
  let best = null;
  for (const c of candidates || []) {
    if (c.kind !== wantKind) continue;
    const names = [c.title, c.original_title].filter(Boolean);
    const sim = Math.max(0, ...names.map((n) => similarity(target, normalize(n))));
    if (sim < MIN_SIMILARITY) continue;
    let score = sim;
    if (media.year && Number.isInteger(c.year)) {
      if (c.year === media.year) score += 0.5;
      else if (wantKind === "movie" && Math.abs(c.year - media.year) > 1) continue;
      else score -= 0.3;
    }
    if (!best || score > best.score) best = { score, candidate: c };
  }
  return best ? best.candidate : null;
}

export function mediaLabel(media) {
  if (!media) return "";
  let text = media.title;
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
