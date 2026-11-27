"""Find the Bingers title for a parsed file name, with a disk cache and manual overrides."""

from __future__ import annotations

import json
import logging
import os
import re
import unicodedata
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from .api import BingersClient
from .parser import ParsedMedia

log = logging.getLogger(__name__)

MIN_SIMILARITY = 0.85
CACHE_VERSION = 2  # bump to forget matches saved by older, less careful versions
MAX_ALTERNATES = 3
# When the best two fits are this close, ask Bingers which ones you follow and prefer those.
LIBRARY_MARGIN = 0.35
WATCHED_BONUS = 0.3  # you've watched some of it
FOLLOWED_BONUS = 0.15  # it's in your library
_NOT_FOLLOWED = {None, "", "not_in_library", "none"}

_NUMBER_WORDS = {
    "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
    "i": "1", "ii": "2", "iii": "3", "iv": "4", "volume": "vol",
}

# Bingers tells same-name titles apart inside the name: "Dark Matter (2024)", "The Office (US)".
_TAG = re.compile(r"\s*\((?P<tag>(?:19|20)\d{2}|US|UK|AU|CA|NZ|IE)\)\s*$", re.I)
_COUNTRIES = {"US", "UK", "AU", "CA", "NZ", "IE"}


@dataclass(frozen=True)
class Match:
    ref: str  # anything POST /scrobble accepts as "title": a Bingers id, "tvdb:…", "imdb:…"
    name: str
    year: int | None = None


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = text.lower().replace("&", " and ")
    words = re.sub(r"[^a-z0-9]+", " ", text).split()
    words = [_NUMBER_WORDS.get(w, w) for w in words]
    if words[:1] == ["the"]:
        words = words[1:]
    return " ".join(words)


def split_tag(name: str) -> tuple[str, str | None]:
    """'Dark Matter (2024)' -> ('Dark Matter', '2024'); 'The Office (US)' -> ('The Office', 'US')."""
    m = _TAG.search(name or "")
    if not m:
        return name or "", None
    return name[: m.start()], m.group("tag").upper()


def _head(name: str) -> str:
    """The part before a colon: 'Frieren: Beyond Journey's End' -> 'frieren'."""
    base, _ = split_tag(name or "")
    return normalize(base.split(":", 1)[0]) if ":" in base else ""


def _shared_heads(candidates: list[dict[str, Any]]) -> set[str]:
    """Prefixes several results share ("Star Wars: …"): too vague to match a bare name."""
    counts: dict[str, int] = {}
    for c in candidates:
        h = _head(c.get("title") or "")
        if h:
            counts[h] = counts.get(h, 0) + 1
    return {h for h, n in counts.items() if n > 1}


def _score(media: ParsedMedia, candidate: dict[str, Any], shared: frozenset[str] | set[str] = frozenset()) -> float | None:
    """How well a search result fits the file name; None if it doesn't fit at all."""
    want_kind = "show" if media.kind == "episode" else "movie"
    if candidate.get("kind") != want_kind:
        return None
    target = normalize(media.title)
    best_sim = 0.0
    tag = None
    for name in (candidate.get("title"), candidate.get("original_title")):
        if not name:
            continue
        base, t = split_tag(name)
        tag = tag or t
        best_sim = max(best_sim, SequenceMatcher(None, target, normalize(base)).ratio())
        best_sim = max(best_sim, SequenceMatcher(None, target, normalize(name)).ratio())
        # Files often drop the subtitle: "Frieren" for "Frieren: Beyond Journey's End".
        # Slightly below an exact name, so "Attack on Titan" still beats "Attack on Titan: Junior High".
        if ":" in base:
            head = normalize(base.split(":", 1)[0])
            if head and head not in shared:
                best_sim = max(best_sim, 0.95 * SequenceMatcher(None, target, head).ratio())
    if best_sim < MIN_SIMILARITY:
        return None

    score = best_sim
    year = candidate.get("year")
    if not isinstance(year, int) and tag and tag.isdigit():
        year = int(tag)
    if media.year and isinstance(year, int):
        diff = abs(year - media.year)
        if diff == 0:
            score += 0.5
        elif diff == 1:
            score += 0.3  # premiered in December, listed as January, and the like
        elif media.kind == "movie":
            return None  # a remake or a different film with the same name
        else:
            score -= 0.6  # a different show with the same name (e.g. a 1968 one vs 2020)
    if media.country and tag in _COUNTRIES:
        score += 0.3 if tag == media.country else -0.3
    return score


def rank_candidates(
    media: ParsedMedia,
    candidates: list[dict[str, Any]],
    library: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Search results that fit, best first. Ties keep the API's own order.

    `library` is GET /library/check's answer for some of them: shows you follow, and above all
    shows you've watched, get a small bonus, enough to break a tie between same-name titles
    but not enough to beat a year that clearly matches.
    """
    shared = _shared_heads(candidates)
    scored = [(s, i, c) for i, c in enumerate(candidates) if (s := _score(media, c, shared)) is not None]
    if library:
        scored = [(s + library_bonus(library.get(c.get("id"))), i, c) for s, i, c in scored]
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [c for _, _, c in scored]


def library_bonus(entry: dict[str, Any] | None) -> float:
    if not entry:
        return 0.0
    if entry.get("last_watched_at") or entry.get("furthest"):
        return WATCHED_BONUS
    if entry.get("status") not in _NOT_FOLLOWED:
        return FOLLOWED_BONUS
    return 0.0


def is_close_call(media: ParsedMedia, ranked: list[dict[str, Any]]) -> bool:
    """True when the top two fits are near enough that your library should decide."""
    if len(ranked) < 2:
        return False
    shared = _shared_heads(ranked)
    first, second = _score(media, ranked[0], shared), _score(media, ranked[1], shared)
    return first is not None and second is not None and first - second <= LIBRARY_MARGIN


def pick_best(media: ParsedMedia, candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    ranked = rank_candidates(media, candidates)
    return ranked[0] if ranked else None


def _year_fits(media: ParsedMedia, candidate: dict[str, Any]) -> bool:
    year = candidate.get("year")
    if not isinstance(year, int):
        _, tag = split_tag(candidate.get("title") or "")
        year = int(tag) if tag and tag.isdigit() else None
    return media.year is None or (isinstance(year, int) and abs(year - media.year) <= 1)


def _to_match(c: dict[str, Any], fallback_name: str) -> Match:
    return Match(c["id"], c.get("title") or fallback_name, c.get("year"))


class Matcher:
    def __init__(self, client: BingersClient, cache_path: Path, overrides: dict[str, str] | None = None):
        self.client = client
        # A new file name per cache version, so wrong matches saved by older versions are dropped.
        self.cache_path = cache_path.with_name(f"{cache_path.stem}_v{CACHE_VERSION}{cache_path.suffix}")
        self.overrides = {normalize(k): v for k, v in (overrides or {}).items()}
        self._cache: dict[str, dict[str, Any]] = self._load()

    def resolve(self, media: ParsedMedia) -> Match | None:
        """The best Bingers title. Raises api.TransientError when Bingers can't be reached."""
        matches = self.resolve_all(media)
        return matches[0] if matches else None

    def resolve_all(self, media: ParsedMedia) -> list[Match]:
        """The best title first, then a few runner-ups to try if Bingers can't find the episode."""
        kind = "show" if media.kind == "episode" else "movie"
        norm = normalize(media.title)

        for key in (f"{norm} {media.year}" if media.year else None, norm):
            if key and key in self.overrides:
                return [Match(self.overrides[key], media.title, media.year)]

        cache_key = f"{kind}|{norm}|{media.year or ''}|{media.country or ''}"
        if cache_key in self._cache:
            return [Match(**m) for m in self._cache[cache_key]["matches"]]

        results = self.client.search(media.title, kind=kind, limit=20)
        ranked = rank_candidates(media, results)
        # The right one may not be in the first results for a common name: search with the year too.
        if media.year and not any(_year_fits(media, c) for c in ranked):
            more = self.client.search(f"{media.title} {media.year}", kind=kind, limit=20)
            seen = {c.get("id") for c in results}
            ranked = rank_candidates(media, results + [c for c in more if c.get("id") not in seen])
        if not ranked:
            # A file named in the show's own language ("La.Casa.De.Papel.S01E01"): Bingers
            # answers in English by default, so look again with original names.
            try:
                local = self.client.search(media.title, kind=kind, limit=20, original_names=True)
            except TypeError:  # a client without that option
                local = []
            ranked = rank_candidates(media, local)
        if not ranked:
            return []
        if is_close_call(media, ranked):
            ranked = self._prefer_library(media, ranked)
        matches = [_to_match(c, media.title) for c in ranked[: 1 + MAX_ALTERNATES]]
        self._cache[cache_key] = {"matches": [asdict(m) for m in matches]}
        self._save()
        return matches

    def _prefer_library(self, media: ParsedMedia, ranked: list[dict[str, Any]]) -> list[dict[str, Any]]:
        top = ranked[: 1 + MAX_ALTERNATES]
        try:
            library = self.client.check([c["id"] for c in top if c.get("id")])
        except Exception as exc:  # only a tie-breaker: carry on without it
            log.info("  couldn't check your library (%s)", exc)
            return ranked
        reordered = rank_candidates(media, top, library)
        if reordered and reordered[0] is not top[0]:
            log.info("  preferring %s, which is in your library", reordered[0].get("title"))
        return reordered + ranked[len(top):]

    def _load(self) -> dict[str, dict[str, Any]]:
        if not self.cache_path.exists():
            return {}
        try:
            data = json.loads(self.cache_path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save(self) -> None:
        tmp = self.cache_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._cache, indent=1, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self.cache_path)
