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

_NUMBER_WORDS = {
    "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
    "i": "1", "ii": "2", "iii": "3", "iv": "4", "volume": "vol",
}


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


def pick_best(media: ParsedMedia, candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Choose the search result that best fits the file name, or None if nothing is close."""
    want_kind = "show" if media.kind == "episode" else "movie"
    target = normalize(media.title)
    best: tuple[float, dict[str, Any]] | None = None

    for candidate in candidates:
        if candidate.get("kind") != want_kind:
            continue
        names = [n for n in (candidate.get("title"), candidate.get("original_title")) if n]
        similarity = max((SequenceMatcher(None, target, normalize(n)).ratio() for n in names), default=0.0)
        if similarity < MIN_SIMILARITY:
            continue
        score = similarity
        year = candidate.get("year")
        if media.year and isinstance(year, int):
            if year == media.year:
                score += 0.5
            elif media.kind == "movie" and abs(year - media.year) > 1:
                continue  # a remake or a different film with the same name
            else:
                score -= 0.3
        # Strictly greater keeps the API's own ranking on ties.
        if best is None or score > best[0]:
            best = (score, candidate)

    return best[1] if best else None


class Matcher:
    def __init__(self, client: BingersClient, cache_path: Path, overrides: dict[str, str] | None = None):
        self.client = client
        self.cache_path = cache_path
        self.overrides = {normalize(k): v for k, v in (overrides or {}).items()}
        self._cache: dict[str, dict[str, Any]] = self._load()

    def resolve(self, media: ParsedMedia) -> Match | None:
        """Look up the title. Raises api.TransientError when Bingers can't be reached."""
        kind = "show" if media.kind == "episode" else "movie"
        norm = normalize(media.title)

        for key in (f"{norm} {media.year}" if media.year else None, norm):
            if key and key in self.overrides:
                return Match(self.overrides[key], media.title, media.year)

        cache_key = f"{kind}|{norm}|{media.year or ''}"
        if cache_key in self._cache:
            return Match(**self._cache[cache_key])

        candidate = pick_best(media, self.client.search(media.title, kind=kind, limit=10))
        if candidate is None:
            return None
        match = Match(candidate["id"], candidate.get("title") or media.title, candidate.get("year"))
        self._cache[cache_key] = asdict(match)
        self._save()
        return match

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
