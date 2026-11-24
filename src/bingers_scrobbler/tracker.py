"""The scrobble loop: watch the players, count real viewing time, mark watched at the threshold."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from .api import AuthError, BingersClient, BingersError, TransientError, describe_result
from .backlog import Backlog
from .config import ScrobbleSettings
from .matcher import Match, Matcher
from .parser import ParsedMedia, parse_filename
from .players import PlaybackState, Player

log = logging.getLogger(__name__)

SESSION_EXPIRY_SECONDS = 6 * 3600  # keep counted time if you close a file and come back to it
RESOLVE_RETRY_SECONDS = 60
BACKLOG_FLUSH_SECONDS = 60


@dataclass
class Session:
    player: str
    file: str
    media: ParsedMedia | None
    last_seen: float
    last_paused: bool = True
    watched_seconds: float = 0.0
    match: Match | None = None
    resolved: bool = False
    next_resolve_at: float = 0.0
    done: bool = False  # scrobbled, queued, or given up on


def build_items(media: ParsedMedia, match: Match) -> list[dict[str, Any]]:
    if media.kind == "movie":
        return [{"title": match.ref}]
    # No season in the name ("Show - 03.mkv") usually means season 1.
    season = media.season if media.season is not None else 1
    return [{"title": match.ref, "season": season, "episode": ep} for ep in media.episodes]


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Tracker:
    def __init__(
        self,
        players: list[Player],
        client: BingersClient,
        matcher: Matcher,
        backlog: Backlog,
        settings: ScrobbleSettings,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.players = players
        self.client = client
        self.matcher = matcher
        self.backlog = backlog
        self.settings = settings
        self.clock = clock
        self.sessions: dict[tuple[str, str], Session] = {}
        self._next_flush = 0.0

    def run_forever(self) -> None:
        while True:
            started = self.clock()
            self.tick()
            time.sleep(max(0.0, self.settings.poll_interval - (self.clock() - started)))

    def tick(self) -> None:
        now = self.clock()
        for player in self.players:
            try:
                state = player.poll()
            except Exception:  # one broken player must never stop the others
                log.exception("Reading %s failed", player.name)
                continue
            if state is not None:
                self._observe(state, now)

        self._expire(now)
        if len(self.backlog) and now >= self._next_flush:
            self._next_flush = now + BACKLOG_FLUSH_SECONDS
            self.backlog.flush(self.client)

    # -- internals -----------------------------------------------------------

    def _observe(self, state: PlaybackState, now: float) -> None:
        key = (state.player, state.file)
        session = self.sessions.get(key)
        if session is None:
            session = Session(state.player, state.file, parse_filename(state.file), last_seen=now)
            self.sessions[key] = session
            if session.media is None:
                log.info("%s: playing %r, but couldn't tell what it is from the name", state.player, state.file)
                session.done = True
            else:
                log.info("%s: playing %s", state.player, session.media.label())
        else:
            elapsed = now - session.last_seen
            # Count wall-clock time only while it kept playing between two polls.
            # Seeking moves the position without adding time, so skipping ahead doesn't count.
            if not state.paused and not session.last_paused and elapsed <= self.settings.poll_interval * 3:
                session.watched_seconds += elapsed
            session.last_seen = now
        session.last_paused = state.paused

        if session.done:
            return
        self._try_resolve(session, now)
        if self._ready(session, state):
            self._scrobble(session)

    def _try_resolve(self, session: Session, now: float) -> None:
        if session.resolved or now < session.next_resolve_at or session.media is None:
            return
        try:
            session.match = self.matcher.resolve(session.media)
        except TransientError as exc:
            session.next_resolve_at = now + RESOLVE_RETRY_SECONDS
            log.info("Couldn't look up %s yet (%s); will retry", session.media.label(), exc)
            return
        except BingersError as exc:
            log.error("Looking up %s failed: %s", session.media.label(), exc)
            session.done = True
            return
        session.resolved = True
        if session.match is None:
            log.warning(
                "No Bingers title matches %r. Add it under [overrides] in config.toml to fix this.",
                session.media.title,
            )
            session.done = True
        else:
            year = f" ({session.match.year})" if session.match.year else ""
            log.info("  matched to Bingers: %s%s [%s]", session.match.name, year, session.match.ref)

    def _ready(self, session: Session, state: PlaybackState) -> bool:
        if not session.resolved or session.match is None:
            return False
        if state.progress < self.settings.threshold:
            return False
        needed = min(self.settings.min_watched_seconds, state.duration * 0.5)
        return session.watched_seconds >= needed

    def _scrobble(self, session: Session) -> None:
        assert session.media is not None and session.match is not None
        items = build_items(session.media, session.match)
        label = session.media.label()
        session.done = True
        try:
            results = self.client.scrobble(items)
        except (TransientError, AuthError) as exc:
            stamped = [{**item, "watched_at": _now_iso()} for item in items]
            self.backlog.add(stamped)
            log.warning("Couldn't send %s now (%s); saved to the backlog", label, exc)
            return
        except BingersError as exc:
            log.error("Bingers rejected %s: %s", label, exc)
            return
        for result in results:
            log.info("Marked watched: %s", describe_result(result))

    def _expire(self, now: float) -> None:
        stale = [k for k, s in self.sessions.items() if now - s.last_seen > SESSION_EXPIRY_SECONDS]
        for key in stale:
            del self.sessions[key]
