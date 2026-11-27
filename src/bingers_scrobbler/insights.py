"""What to tell you after a mark: the next episode, and what to watch when a show is finished."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from .api import BingersClient

log = logging.getLogger(__name__)

FINISHED_CATALOG = {"ended", "canceled", "cancelled"}


@dataclass
class AfterMark:
    note: str | None = None  # one line for the notification, e.g. "Up next: S04E13 · Title"
    finished: bool = False  # the last episode of a show that has ended
    show: str | None = None
    suggestions: list[str] = field(default_factory=list)


def episode_code(season: int, number: int) -> str:
    return f"S{season:02d}E{number:02d}"


def _friendly_date(day: date, today: date) -> str:
    delta = (day - today).days
    if delta == 0:
        return "today"
    if delta == 1:
        return "tomorrow"
    if 1 < delta < 7:
        return day.strftime("on %A")  # "on Friday"
    fmt = "%d %B" if day.year == today.year else "%d %B %Y"
    return "on " + day.strftime(fmt).lstrip("0")


def _parse_day(text: Any) -> date | None:
    try:
        return date.fromisoformat(str(text)[:10])
    except (TypeError, ValueError):
        return None


def next_episode(episodes: list[dict[str, Any]], season: int, number: int) -> dict[str, Any] | None:
    """The regular episode right after season/number (specials, season 0, are skipped)."""
    regular = sorted(
        (
            e
            for e in episodes
            if isinstance(e.get("season"), int) and e["season"] > 0 and isinstance(e.get("number"), int)
        ),
        key=lambda e: (e["season"], e["number"]),
    )
    return next((e for e in regular if (e["season"], e["number"]) > (season, number)), None)


def describe_next(episode: dict[str, Any] | None, today: date) -> str | None:
    if episode is None:
        return None
    code = episode_code(episode["season"], episode["number"])
    name = str(episode.get("title") or "").strip()
    aired = _parse_day(episode.get("aired_at"))
    if aired is None:
        return f"Next: {code} (no air date yet)"
    if aired <= today:
        return f"Up next: {code}" + (f" · {name}" if name else "")
    return f"Next episode, {code}, airs {_friendly_date(aired, today)}"


def after_mark(
    client: BingersClient,
    ref: str,
    season: int,
    number: int,
    today: date | None = None,
    want_suggestions: bool = True,
) -> AfterMark:
    """Look up what comes after the episode just marked. Never raises."""
    today = today or date.today()
    result = AfterMark()
    try:
        episodes = client.episodes(ref)
        if not episodes:  # very long shows answer per season
            episodes = client.episodes(ref, season=season)
            if not next_episode(episodes, season, number):
                episodes += client.episodes(ref, season=season + 1)
        upcoming = next_episode(episodes, season, number)
        if upcoming is not None:
            result.note = describe_next(upcoming, today)
            return result

        # No episode after this one: finished, or caught up with a show that's still running.
        entry = client.check([ref]).get(ref) or {}
        title = entry.get("title") or {}
        result.show = title.get("title")
        catalog = str(title.get("catalog_status") or "").lower()
        if catalog in FINISHED_CATALOG or entry.get("status") == "completed":
            result.finished = True
            result.note = "That was the last episode."
            if want_suggestions:
                result.suggestions = suggestions(client, ref)
        else:
            result.note = "You're caught up. No date yet for the next episode."
    except Exception as exc:  # extras only: a failure here must never affect the mark
        log.info("  couldn't look up what's next (%s)", exc)
    return result


def suggestions(client: BingersClient, ref: str, limit: int = 3) -> list[str]:
    """Names of a few similar titles you haven't watched or started."""
    try:
        items = client.similar(ref, limit=limit)
    except Exception as exc:
        log.info("  couldn't get similar titles (%s)", exc)
        return []
    names = []
    for item in items:
        name = str(item.get("title") or "").strip()
        if name and item.get("my_status") in (None, "not_in_library", "not_started", "to_watch"):
            names.append(name)
    return names[:limit]


# -- the watch list, for the tray menu ------------------------------------------


@dataclass
class WatchItem:
    id: str
    name: str
    url: str | None
    kind: str
    section: str
    next_code: str | None = None
    next_title: str | None = None
    next_aired: str | None = None

    def label(self) -> str:
        if self.next_code:
            text = f"{self.name} - {self.next_code}"
            if self.next_title:
                text += f" {self.next_title}"
            return text[:80]
        return self.name[:80]


def watch_items(data: dict[str, Any], sections: tuple[str, ...], limit: int = 12) -> list[WatchItem]:
    out: list[WatchItem] = []
    for section in sections:
        for item in ((data.get("sections") or {}).get(section) or {}).get("items") or []:
            nxt = ((item.get("progress") or {}).get("next")) or {}
            code = (
                episode_code(nxt["season"], nxt["number"])
                if isinstance(nxt.get("season"), int) and isinstance(nxt.get("number"), int)
                else None
            )
            out.append(
                WatchItem(
                    id=str(item.get("id")),
                    name=str(item.get("title") or "?"),
                    url=item.get("url"),
                    kind=str(item.get("kind") or ""),
                    section=section,
                    next_code=code,
                    next_title=(nxt.get("title") or None) if code else None,
                    next_aired=nxt.get("aired_at") if code else None,
                )
            )
            if len(out) >= limit:
                return out
    return out


def where_to_watch(details: dict[str, Any]) -> str:
    """'Netflix, Max (streaming) · Apple TV (rent)' in the user's country, or ''."""
    wtw = details.get("where_to_watch") or {}
    parts = []
    for key, label in (("streaming", "streaming"), ("free", "free"), ("rent", "rent"), ("buy", "buy")):
        names = [str(n) for n in (wtw.get(key) or []) if n]
        if names:
            parts.append(f"{', '.join(dict.fromkeys(names))} ({label})")
    if not parts:
        return ""
    country = wtw.get("country")
    return (f"In {country}: " if country else "") + " · ".join(parts)
