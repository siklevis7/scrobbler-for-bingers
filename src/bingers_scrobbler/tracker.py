"""The scrobble loop: watch the players, count real viewing time, mark watched at the threshold."""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Callable

from .api import AuthError, BingersClient, BingersError, TransientError, describe_result
from .backlog import Backlog
from .config import ScrobbleSettings
from .history import History
from .insights import after_mark
from .matcher import Match, Matcher
from .parser import ParsedMedia, parse_filename
from .players import PlaybackState, Player

log = logging.getLogger(__name__)

SESSION_EXPIRY_SECONDS = 6 * 3600  # keep counted time if you close a file and come back to it
RESOLVE_RETRY_SECONDS = 60
BACKLOG_FLUSH_SECONDS = 60
MIN_VIDEO_SECONDS = 240  # shorter files are samples, trailers or clips: never marked

# Event kinds passed to Tracker.on_event(kind, message)
EVENT_PLAYING = "playing"  # a new file started and was matched
EVENT_SCROBBLED = "scrobbled"  # marked watched on Bingers
EVENT_QUEUED = "queued"  # couldn't send, saved to the backlog
EVENT_UNMATCHED = "unmatched"  # no Bingers title for this file
EVENT_ERROR = "error"  # Bingers rejected something
EVENT_AUTH = "auth"  # token refused
EVENT_FINISHED = "finished"  # the last episode of a show: similar titles to try next


@dataclass
class Session:
    player: str
    file: str
    media: ParsedMedia | None
    last_seen: float
    last_paused: bool = True
    watched_seconds: float = 0.0
    match: Match | None = None
    matches: list[Match] = field(default_factory=list)  # best first, then runner-ups
    resolved: bool = False
    next_resolve_at: float = 0.0
    done: bool = False  # scrobbled, queued, or given up on


def build_items(media: ParsedMedia, match: Match) -> list[dict[str, Any]]:
    if media.kind == "movie":
        return [{"title": match.ref}]
    # No season in the name ("Show - 03.mkv") usually means season 1.
    season = media.season if media.season is not None else 1
    return [{"title": match.ref, "season": season, "episode": ep} for ep in media.episodes]


def mark_outcome(results: list[dict[str, Any]]) -> str:
    """How to say what Bingers did: marked, re-marked as a rewatch, or nothing new."""
    statuses = {r.get("status") for r in results}
    if statuses == {"already"}:
        return "already watched"
    if any(r.get("outcome") == "rewatched" for r in results):
        return "marked as a rewatch"
    return "marked watched"


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
        history: History | None = None,
        on_event: Callable[[str, str], None] | None = None,
    ):
        self.players = players
        self.client = client
        self.matcher = matcher
        self.backlog = backlog
        self.settings = settings
        self.clock = clock
        self.history = history
        self.on_event = on_event
        self.sessions: dict[tuple[str, str], Session] = {}
        self.paused = False
        self.up_next = True  # add the next episode to the "marked watched" notification
        self.suggest = True  # suggest similar titles after the last episode of a show
        self.now_playing: str | None = None
        self.last_scrobble: tuple[str, list[dict[str, Any]]] | None = None  # (label, items)
        self._next_flush = 0.0
        self._lock = threading.RLock()  # the tray menu calls in from other threads

    # -- running -------------------------------------------------------------

    def run_forever(self, stop: threading.Event | None = None) -> None:
        stop = stop or threading.Event()
        while not stop.is_set():
            started = self.clock()
            try:
                self.tick()
            except Exception:  # keep scrobbling even if one tick hits a bug
                log.exception("Unexpected error while checking players")
            stop.wait(max(0.0, self.settings.poll_interval - (self.clock() - started)))

    def tick(self) -> None:
        with self._lock:
            now = self.clock()
            if self.paused:
                self.now_playing = None
                return
            playing: list[str] = []
            for player in self.players:
                try:
                    state = player.poll()
                except Exception:  # one broken player must never stop the others
                    log.exception("Reading %s failed", player.name)
                    continue
                if state is not None:
                    session = self._observe(state, now)
                    if session.media is not None:
                        playing.append(session.media.label())
            self.now_playing = playing[0] if playing else None

            self._expire(now)
            if len(self.backlog) and now >= self._next_flush:
                self._next_flush = now + BACKLOG_FLUSH_SECONDS
                self.backlog.flush(self.client)

    # -- controls for the tray app -------------------------------------------

    def set_players(self, players: list[Player]) -> None:
        with self._lock:
            self.players = players

    def flush_backlog(self) -> tuple[int, int]:
        """Send the backlog now. Returns (sent, still waiting)."""
        with self._lock:
            sent = self.backlog.flush(self.client)
            return sent, len(self.backlog)

    def retry_last(self) -> bool:
        """Send the last scrobble again (Bingers ignores repeats within 12 hours)."""
        with self._lock:
            if self.last_scrobble is None:
                return False
            label, items = self.last_scrobble
            self._send(label, items)
            return True

    # -- internals -----------------------------------------------------------

    def _emit(self, kind: str, message: str) -> None:
        if self.on_event is not None:
            try:
                self.on_event(kind, message)
            except Exception:
                log.exception("Event handler failed")

    def _observe(self, state: PlaybackState, now: float) -> Session:
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

        if not session.done:
            self._try_resolve(session, now)
            if self._ready(session, state):
                self._scrobble(session)
        return session

    def _try_resolve(self, session: Session, now: float) -> None:
        if session.resolved or now < session.next_resolve_at or session.media is None:
            return
        try:
            session.matches = self.matcher.resolve_all(session.media)
            session.match = session.matches[0] if session.matches else None
            if session.match and session.media.air_date and not session.media.episodes:
                if not self._resolve_air_date(session):
                    session.resolved = True
                    session.done = True
                    return
        except TransientError as exc:
            session.next_resolve_at = now + RESOLVE_RETRY_SECONDS
            log.info("Couldn't look up %s yet (%s); will retry", session.media.label(), exc)
            return
        except AuthError as exc:
            session.next_resolve_at = now + RESOLVE_RETRY_SECONDS
            log.error("Bingers refused the token: %s", exc)
            self._emit(EVENT_AUTH, f"Bingers refused your token: {exc}")
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
            self._emit(EVENT_UNMATCHED, f"Couldn't find \"{session.media.title}\" on Bingers")
            session.done = True
        else:
            name, year = session.match.name, session.match.year
            shown = name if not year or name.endswith(f"({year})") else f"{name} ({year})"
            log.info("  matched to Bingers: %s [%s]", shown, session.match.ref)
            self._emit(EVENT_PLAYING, session.media.label())

    def _resolve_air_date(self, session: Session) -> bool:
        """Daily shows named by date ("Show.2024.03.15"): find the episode that aired that day."""
        media, match = session.media, session.match
        assert media is not None and match is not None and media.air_date
        episodes = self.client.episodes(match.ref)
        if not episodes:  # very long-running shows need a season; daily shows use the year
            episodes = self.client.episodes(match.ref, season=int(media.air_date[:4]))
        hit = next((e for e in episodes if str(e.get("aired_at") or "").startswith(media.air_date)), None)
        if hit is None:
            log.warning("%s has no episode that aired on %s on Bingers", match.name, media.air_date)
            self._emit(EVENT_UNMATCHED, f"No {match.name} episode aired on {media.air_date} on Bingers")
            return False
        session.media = replace(media, season=hit["season"], episodes=(hit["number"],))
        log.info("  %s aired as S%02dE%02d", media.air_date, hit["season"], hit["number"])
        return True

    def _ready(self, session: Session, state: PlaybackState) -> bool:
        if not session.resolved or session.match is None:
            return False
        if state.duration < MIN_VIDEO_SECONDS:
            return False
        if state.progress < self.settings.threshold:
            return False
        needed = min(self.settings.min_watched_seconds, state.duration * 0.5)
        return session.watched_seconds >= needed

    def _scrobble(self, session: Session) -> None:
        assert session.media is not None and session.match is not None
        session.done = True
        label = session.media.label()
        items = build_items(session.media, session.match)
        self.last_scrobble = (label, items)
        results = self._send(label, items, quiet_unresolved=True)
        if results and all(r.get("status") == "unresolved" for r in results):
            self._recover(session, label)

    def _recover(self, session: Session, label: str) -> None:
        """Bingers has no such episode on the matched show. Try the likely reasons, in order."""
        media, match = session.media, session.match
        assert media is not None and match is not None
        try:
            # Anime counted from the start of the show: "One Piece - 1071" -> S21E179.
            if media.season is None and len(media.episodes) == 1:
                regular = sorted(
                    (e for e in self.client.episodes(match.ref)
                     if isinstance(e.get("season"), int) and e["season"] > 0 and isinstance(e.get("number"), int)),
                    key=lambda e: (e["season"], e["number"]),
                )
                n = media.episodes[0]
                if 1 <= n <= len(regular):
                    e = regular[n - 1]
                    log.info("  episode %d from the start of %s is S%02dE%02d", n, match.name, e["season"], e["number"])
                    items = [{"title": match.ref, "season": e["season"], "episode": e["number"]}]
                    self.last_scrobble = (label, items)
                    self._send(label, items)
                    return
            # A same-name show was picked: try the runner-ups, checking first without writing.
            for alt in session.matches[1:]:
                items = build_items(media, alt)
                check = self.client.scrobble(items, dry_run=True)
                if check and all(r.get("status") in ("ok", "already") for r in check):
                    log.info("  %s has no such episode; it's %s (%s) instead", match.name, alt.name, alt.year or "?")
                    session.match = alt
                    self.last_scrobble = (label, items)
                    self._send(label, items)
                    return
        except BingersError as exc:
            log.warning("Couldn't double-check %s: %s", label, exc)
        log.warning("Bingers has no episode %s. Add the right title under [overrides] in config.toml.", label)
        self._record(label, "not found on Bingers")
        self._emit(EVENT_ERROR, f"Bingers couldn't find {label}")

    def _send(
        self, label: str, items: list[dict[str, Any]], quiet_unresolved: bool = False
    ) -> list[dict[str, Any]] | None:
        try:
            results = self.client.scrobble(items)
        except (TransientError, AuthError) as exc:
            stamped = [{**item, "watched_at": _now_iso()} for item in items]
            self.backlog.add(stamped)
            log.warning("Couldn't send %s now (%s); saved to the backlog", label, exc)
            self._record(label, "saved to backlog")
            if isinstance(exc, AuthError):
                self._emit(EVENT_AUTH, f"Bingers refused your token: {exc}")
            else:
                self._emit(EVENT_QUEUED, f"{label} will be sent when Bingers is reachable")
            return None
        except BingersError as exc:
            log.error("Bingers rejected %s: %s", label, exc)
            self._record(label, f"rejected: {exc}")
            self._emit(EVENT_ERROR, f"Bingers rejected {label}: {exc}")
            return None
        statuses = {r.get("status") for r in results}
        if quiet_unresolved and results and statuses == {"unresolved"}:
            return results  # the caller tries to recover before reporting a problem
        for result in results:
            log.info("Marked watched: %s", describe_result(result))
        if statuses <= {"ok", "already"} and results:
            outcome = mark_outcome(results)
            self._record(label, outcome)
            message = f"{label} {outcome}"
            extra = self._after_mark(results)
            if extra and extra.note:
                message += f"\n{extra.note}"
            self._emit(EVENT_SCROBBLED, message)
            if extra and extra.finished and extra.suggestions:
                show = extra.show or label
                self._emit(
                    EVENT_FINISHED,
                    f"You finished {show}! You might like: {', '.join(extra.suggestions)}",
                )
        else:
            detail = "; ".join(describe_result(r) for r in results) or "no result"
            self._record(label, detail)
            self._emit(EVENT_ERROR, f"{label}: {detail}")
        return results

    def _after_mark(self, results: list[dict[str, Any]]):
        """Next episode / finished show, for the episode marked last. None for movies."""
        if not self.up_next and not self.suggest:
            return None
        last = results[-1]
        ref = (last.get("title") or {}).get("id")
        ep = last.get("episode") or {}
        if not ref or not isinstance(ep.get("season"), int) or not isinstance(ep.get("number"), int):
            return None
        extra = after_mark(self.client, ref, ep["season"], ep["number"], want_suggestions=self.suggest)
        if extra.note:
            log.info("  %s", extra.note)
        if extra.suggestions:
            log.info("  similar titles: %s", ", ".join(extra.suggestions))
        if not self.up_next:
            extra.note = None
        return extra

    def _record(self, label: str, result: str) -> None:
        if self.history is not None:
            try:
                self.history.add(label, result)
            except OSError:
                log.exception("Couldn't write watch history")

    def _expire(self, now: float) -> None:
        stale = [k for k, s in self.sessions.items() if now - s.last_seen > SESSION_EXPIRY_SECONDS]
        for key in stale:
            del self.sessions[key]
