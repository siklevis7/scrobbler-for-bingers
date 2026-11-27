"""Turn a file name like "The.Office.US.S02E03.720p.mkv" into a show/movie, season and episode.

guessit does most of the work. A small pattern-based parser backs it up for names guessit gets
wrong, such as shows named after numbers or dates ("12.12.12", "1883", "9-1-1").
"""

from __future__ import annotations

import datetime as dt
import os
import re
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
    country: str | None = None  # "US", "UK"… from names like "The.Office.US.S01E01"
    air_date: str | None = None  # "2024-03-15" for daily shows named by date

    def label(self) -> str:
        text = self.title + (f" ({self.year})" if self.year else "")
        if self.kind == "episode":
            if self.air_date and not self.episodes:
                return f"{text} {self.air_date}"
            season = self.season if self.season is not None else 1
            text += " " + "".join(f"S{season:02d}E{ep:02d}" for ep in self.episodes)
        return text


def _first(value: Any) -> Any:
    return value[0] if isinstance(value, list) and value else value


_COUNTRY_TAGS = {"GB": "UK"}


def _from_guessit(name: str) -> ParsedMedia | None:
    try:
        info = guessit(name)
    except Exception:  # guessit can choke on unusual names
        return None
    title = _first(info.get("title"))
    if not title:
        return None
    year = _first(info.get("year"))
    year = year if isinstance(year, int) else None
    country = info.get("country")
    country_code = None
    if country is not None:
        code = str(getattr(country, "alpha2", country)).upper()
        country_code = _COUNTRY_TAGS.get(code, code)

    if info.get("type") == "episode":
        episode = info.get("episode")
        if episode is None:
            date = info.get("date")
            if isinstance(date, dt.date):  # "The.Daily.Show.2024.03.15"
                return ParsedMedia("episode", str(title), year, None, (), country_code, date.isoformat())
            return None
        episodes = tuple(int(e) for e in (episode if isinstance(episode, list) else [episode]))
        season = _first(info.get("season"))
        return ParsedMedia(
            "episode",
            str(title),
            year,
            int(season) if season is not None else None,
            episodes,
            country_code,
        )

    # guessit splits "Dune.Part.Two" into title "Dune" + part 2; put it back so search finds the sequel.
    title = str(title)
    for key, word in (("part", "Part"), ("volume", "Vol")):
        number = _first(info.get(key))
        if isinstance(number, int):
            title = f"{title} {word} {number}"
    return ParsedMedia("movie", title, year, country=country_code)


# -- backup parser ----------------------------------------------------------------------

_SEASON_EPISODE = re.compile(
    r"(?<![A-Za-z0-9])(?:S|Season|Series)[\s._-]*(\d{1,3})[\s._-]*(?:E|Ep|Episode)[\s._-]*(\d{1,4})(?!\d)", re.I
)
_X_FORMAT = re.compile(r"(?<![A-Za-z0-9])(\d{1,2})x(\d{1,3})(?!\d)", re.I)
_EPISODE_ONLY = re.compile(r"(?<![A-Za-z0-9])(?:E|Ep|Episode)[\s._-]*(\d{1,4})(?!\d)", re.I)
_JUNK = re.compile(
    r"(?<![A-Za-z0-9])(?:\d{3,4}p|4k|uhd|hdr\d*|web[ .-]?dl|web[ .-]?rip|web|blu[ .-]?ray|bdrip|brrip|hdtv|"
    r"dvdrip|x26[45]|h[ .]?26[45]|hevc|avc|10bit|8bit|aac\d?|ddp?\d?|\dch|proper|repack|amzn|nf|dsnp|hmax)"
    r"(?![A-Za-z0-9])",
    re.I,
)
_VIDEO_EXT = re.compile(r"\.(mkv|mp4|m4v|avi|mov|wmv|webm|flv|ts|mpg|mpeg)$", re.I)


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip(" -_.:|")


def _from_patterns(name: str) -> ParsedMedia | None:
    base = _VIDEO_EXT.sub("", os.path.basename(name))
    base = re.sub(r"\[[^\]]*\]|\{[^}]*\}", " ", base)  # [release group]
    text = re.sub(r"[._]+", " ", base)
    for pattern in (_SEASON_EPISODE, _X_FORMAT):
        m = pattern.search(text)
        if m:
            title = _clean(text[: m.start()])
            if title:
                return ParsedMedia("episode", title, None, int(m.group(1)), (int(m.group(2)),))
    m = _EPISODE_ONLY.search(text)
    if m and _clean(text[: m.start()]):
        return ParsedMedia("episode", _clean(text[: m.start()]), None, None, (int(m.group(1)),))
    # Anime: "Frieren - 12 (1080p)"
    m = re.match(r"^(.+?)\s+-\s+(\d{1,4})(?:v\d)?(?:\s|$|\()", text)
    if m and not re.fullmatch(r"(19|20)\d{2}", m.group(2)):
        return ParsedMedia("episode", _clean(m.group(1)), None, None, (int(m.group(2)),))
    return None


def parse_filename(name: str) -> ParsedMedia | None:
    """Parse a file name or path. Returns None when there's no usable title or episode number."""
    if not name:
        return None
    if re.search(r"(?<![A-Za-z])(sample|trailer|teaser)(?![A-Za-z])", os.path.basename(name), re.I):
        return None  # sample clips and trailers are never marked
    guessed = _from_guessit(name)
    backup = _from_patterns(name)
    if guessed is None:
        return backup
    # guessit sometimes reads an episode file as a movie (e.g. shows named after numbers).
    if backup is not None and guessed.kind == "movie" and backup.kind == "episode":
        return backup
    return guessed
