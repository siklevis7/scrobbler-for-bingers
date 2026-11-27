"""Weekly summary of everything you watched on Bingers (not only what this app marked).

Bingers' change feed (GET /entries) is read once in full, then only what changed since, using
the cursor it hands back. Only the last few weeks are kept on disk, which is all a weekly
summary needs, so the file stays small however long your history is.
"""

from __future__ import annotations

import json
import logging
import os
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .api import BingersClient

log = logging.getLogger(__name__)

KEEP_DAYS = 21
MAX_PAGES = 20  # Bingers allows about 20 full loads a day; one page is up to 10,000 rows
SUMMARY_DAY = 6  # Sunday
SUMMARY_HOUR = 18  # the week's summary is shown from Sunday 18:00


def _parse_time(text: Any) -> datetime | None:
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


@dataclass
class Summary:
    start: datetime
    end: datetime
    episodes: int = 0
    shows: int = 0
    movies: int = 0
    minutes: int = 0
    top: list[tuple[str, int]] = field(default_factory=list)  # (show, episodes), most first

    @property
    def empty(self) -> bool:
        return self.episodes == 0 and self.movies == 0

    def headline(self) -> str:
        if self.empty:
            return "Nothing marked watched."
        parts = []
        if self.episodes:
            parts.append(
                f"{self.episodes} episode{'s' if self.episodes != 1 else ''} of "
                f"{self.shows} show{'s' if self.shows != 1 else ''}"
            )
        if self.movies:
            parts.append(f"{self.movies} movie{'s' if self.movies != 1 else ''}")
        text = " and ".join(parts)
        if self.minutes:
            text += f", about {format_minutes(self.minutes)}"
        return text + "."


def format_minutes(minutes: int) -> str:
    hours, mins = divmod(int(minutes), 60)
    if not hours:
        return f"{mins} min"
    return f"{hours} h" + (f" {mins} min" if mins else "")


def week_bounds(now: datetime) -> tuple[datetime, datetime]:
    """Monday 00:00 to the next Monday 00:00 (local time) around `now`."""
    start = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=7)


def due_week(now: datetime, last_shown: str | None) -> tuple[datetime, datetime] | None:
    """The week whose summary should pop up now, or None.

    From Sunday 18:00 the current week is due; on later days it's the week just ended
    (for when the computer was off on Sunday evening). Each week is shown once.
    """
    start, end = week_bounds(now)
    if now.weekday() == SUMMARY_DAY and now.hour >= SUMMARY_HOUR:
        week = (start, end)
    else:
        week = (start - timedelta(days=7), start)
    if last_shown == week[0].date().isoformat():
        return None
    return week


class WatchStats:
    def __init__(self, path: Path):
        self.path = path
        self.cursor: str | None = None
        self.rows: dict[str, dict[str, Any]] = {}  # entity id -> {kind, title, at}
        self.titles: dict[str, dict[str, Any]] = {}  # title id -> {name, kind, runtime}
        self.last_shown: str | None = None  # Monday (ISO date) of the last week shown
        self._load()

    # -- syncing -------------------------------------------------------------

    def sync(self, client: BingersClient, now: datetime | None = None) -> None:
        """Bring the recent history up to date. Raises api errors."""
        now = now or datetime.now(timezone.utc)
        cutoff = now - timedelta(days=KEEP_DAYS)
        for _ in range(MAX_PAGES):
            page = client.entries(self.cursor)
            for row in page.get("items") or []:
                self._apply(row, cutoff)
            if page.get("next_cursor"):
                self.cursor = page["next_cursor"]
            if not page.get("has_more"):
                break
        self.rows = {k: v for k, v in self.rows.items() if (_parse_time(v["at"]) or now) >= cutoff}
        missing = sorted({r["title"] for r in self.rows.values()} - set(self.titles))
        for i in range(0, len(missing), 100):
            for t in client.titles(missing[i : i + 100]):
                self.titles[str(t.get("id"))] = {
                    "name": t.get("title") or "?",
                    "kind": t.get("kind"),
                    "runtime": t.get("runtime_minutes") or 0,
                }
        keep = {r["title"] for r in self.rows.values()}
        self.titles = {k: v for k, v in self.titles.items() if k in keep}
        self.save()

    def _apply(self, row: dict[str, Any], cutoff: datetime) -> None:
        key = f"{row.get('entity_kind')}:{row.get('entity_id')}"
        at = _parse_time(row.get("last_watched_at"))
        if row.get("deleted") or not row.get("watched") or at is None or at < cutoff:
            self.rows.pop(key, None)
            return
        self.rows[key] = {
            "kind": row.get("entity_kind"),
            "title": str(row.get("title_id") or row.get("entity_id")),
            "at": at.isoformat(),
        }

    # -- summaries -----------------------------------------------------------

    def summary(self, start: datetime, end: datetime) -> Summary:
        result = Summary(start, end)
        per_show: Counter[str] = Counter()
        for row in self.rows.values():
            at = _parse_time(row["at"])
            if at is None or not (start <= at < end):
                continue
            info = self.titles.get(row["title"], {})
            result.minutes += int(info.get("runtime") or 0)
            if row["kind"] == "episode":
                result.episodes += 1
                per_show[info.get("name") or "?"] += 1
            else:
                result.movies += 1
        result.shows = len(per_show)
        result.top = per_show.most_common(3)
        return result

    def describe(self, start: datetime, end: datetime, title: str) -> str:
        current = self.summary(start, end)
        before = self.summary(start - (end - start), start)
        lines = [f"{title}: {current.headline()}"]
        if current.top and current.top[0][1] > 1:
            name, count = current.top[0]
            lines.append(f"Most watched: {name} ({count} episodes).")
        if not before.empty or not current.empty:
            diff = current.episodes - before.episodes
            if diff:
                lines.append(f"{abs(diff)} episode{'s' if abs(diff) != 1 else ''} "
                             f"{'more' if diff > 0 else 'fewer'} than the week before.")
        return "\n".join(lines)

    # -- storage ---------------------------------------------------------------

    def _load(self) -> None:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(data, dict):
            return
        self.cursor = data.get("cursor")
        self.rows = data.get("rows") or {}
        self.titles = data.get("titles") or {}
        self.last_shown = data.get("last_shown")

    def save(self) -> None:
        data = {"cursor": self.cursor, "rows": self.rows, "titles": self.titles, "last_shown": self.last_shown}
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self.path)
