"""Turn a file name like "The.Office.US.S02E03.720p.mkv" into a show/movie, season and episode."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from guessit import guessit


@dataclass(frozen=True)
class ParsedMedia:
    kind: str  # "episode" or "movie"
    title: str  # show name for episodes, movie name for movies
    year: int | None = None
    season: int | None = None
    episodes: tuple[int, ...] = field(default=())

    def label(self) -> str:
        text = self.title + (f" ({self.year})" if self.year else "")
        if self.kind == "episode":
            season = self.season if self.season is not None else 1
            text += " " + "".join(f"S{season:02d}E{ep:02d}" for ep in self.episodes)
        return text


def _first(value: Any) -> Any:
    return value[0] if isinstance(value, list) and value else value


def parse_filename(name: str) -> ParsedMedia | None:
    """Parse a file name or path. Returns None when there's no usable title or episode number."""
    if not name:
        return None
    info = guessit(name)
    title = _first(info.get("title"))
    if not title:
        return None
    year = _first(info.get("year"))
    year = year if isinstance(year, int) else None

    if info.get("type") == "episode":
        episode = info.get("episode")
        if episode is None:
            return None  # date-based or unnumbered episodes can't be mapped yet
        episodes = tuple(int(e) for e in (episode if isinstance(episode, list) else [episode]))
        season = _first(info.get("season"))
        return ParsedMedia(
            "episode",
            str(title),
            year,
            int(season) if season is not None else None,
            episodes,
        )

    # guessit splits "Dune.Part.Two" into title "Dune" + part 2; put it back so search finds the sequel.
    title = str(title)
    for key, word in (("part", "Part"), ("volume", "Vol")):
        number = _first(info.get(key))
        if isinstance(number, int):
            title = f"{title} {word} {number}"
    return ParsedMedia("movie", title, year)
