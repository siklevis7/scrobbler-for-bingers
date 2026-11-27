from bingers_scrobbler.api import TransientError
from bingers_scrobbler.backlog import Backlog
from bingers_scrobbler.config import ScrobbleSettings
from bingers_scrobbler.matcher import Match
from bingers_scrobbler.players import PlaybackState
from bingers_scrobbler.players.vlc import parse_status
from bingers_scrobbler.tracker import Tracker

FILE = "Severance.S01E04.1080p.mkv"
DURATION = 2400.0


class FakePlayer:
    name = "fake"

    def __init__(self):
        self.state = None

    def poll(self):
        return self.state


class FakeMatcher:
    def __init__(self, matches=None):
        self.matches = matches or [Match("tvdb:371980", "Severance", 2022)]

    def resolve(self, media):
        return self.matches[0]

    def resolve_all(self, media):
        return list(self.matches)


class FakeClient:
    def __init__(self, fail=False):
        self.fail = fail
        self.sent = []

    def scrobble(self, items, dry_run=False):
        if self.fail:
            raise TransientError("offline")
        self.sent.append(items)
        return [{"status": "ok", "outcome": "watched", "title": {"title": "Severance"}}]


class Clock:
    t = 1000.0

    def __call__(self):
        return self.t


def make(tmp_path, fail=False):
    player, client, clock = FakePlayer(), FakeClient(fail), Clock()
    settings = ScrobbleSettings(threshold=80, min_watched_seconds=300, poll_interval=5)
    tracker = Tracker([player], client, FakeMatcher(), Backlog(tmp_path / "backlog.json"), settings, clock)
    return tracker, player, client, clock


def play(tracker, player, clock, start, seconds, paused=False):
    """Simulate polling every 5s while the position advances in real time."""
    pos = start
    for _ in range(int(seconds // 5) + 1):
        player.state = PlaybackState("fake", FILE, pos, DURATION, paused)
        tracker.tick()
        clock.t += 5
        if not paused:
            pos += 5
    return pos


def test_scrobbles_once_after_threshold(tmp_path):
    tracker, player, client, clock = make(tmp_path)
    play(tracker, player, clock, start=1500, seconds=600)  # 62% -> 87%
    assert client.sent == [[{"title": "tvdb:371980", "season": 1, "episode": 4}]]
    play(tracker, player, clock, start=2100, seconds=100)
    assert len(client.sent) == 1


def test_seeking_to_the_end_does_not_count(tmp_path):
    tracker, player, client, clock = make(tmp_path)
    play(tracker, player, clock, start=0, seconds=60)
    play(tracker, player, clock, start=2300, seconds=30)  # jumped to 96%
    assert client.sent == []


def test_paused_time_does_not_count(tmp_path):
    tracker, player, client, clock = make(tmp_path)
    play(tracker, player, clock, start=2000, seconds=600, paused=True)
    assert client.sent == []


def test_offline_goes_to_backlog_then_flushes(tmp_path):
    tracker, player, client, clock = make(tmp_path, fail=True)
    play(tracker, player, clock, start=1500, seconds=600)
    assert len(tracker.backlog) == 1
    assert "watched_at" in tracker.backlog.items[0]

    client.fail = False
    clock.t += 120
    player.state = None
    tracker.tick()
    assert len(tracker.backlog) == 0
    assert client.sent and client.sent[0][0]["episode"] == 4


class SmartClient:
    """Answers like Bingers: only the listed (ref, season, episode) combinations exist."""

    def __init__(self, existing, episodes=None):
        self.existing = existing
        self.episode_list = episodes or []
        self.sent = []

    def _results(self, items):
        out = []
        for i in items:
            key = (i["title"], i.get("season"), i.get("episode"))
            out.append({"status": "ok" if key in self.existing else "unresolved", "title": {"title": i["title"]}})
        return out

    def scrobble(self, items, dry_run=False):
        if not dry_run:
            self.sent.append(items)
        return self._results(items)

    def episodes(self, ref, season=None):
        return self.episode_list


def run_until_marked(tmp_path, client, matcher, file):
    player, clock = FakePlayer(), Clock()
    settings = ScrobbleSettings(threshold=80, min_watched_seconds=300, poll_interval=5)
    tracker = Tracker([player], client, matcher, Backlog(tmp_path / "b.json"), settings, clock)
    pos = 1500
    for _ in range(130):
        player.state = PlaybackState("fake", file, pos, DURATION, False)
        tracker.tick()
        clock.t += 5
        pos += 5
    return tracker


def test_falls_back_to_the_runner_up_show(tmp_path):
    # The best name match is an older same-name show without this episode.
    client = SmartClient(existing={("new", 1, 4)})
    matcher = FakeMatcher([Match("old", "The Outsider", 1968), Match("new", "The Outsider (2020)", 2020)])
    run_until_marked(tmp_path, client, matcher, "The.Outsider.S01E04.mkv")
    assert client.sent[-1] == [{"title": "new", "season": 1, "episode": 4}]


def test_anime_absolute_number_mapped_to_season(tmp_path):
    episodes = [{"season": s, "number": n} for s in (1, 2) for n in range(1, 11)] + [{"season": 0, "number": 1}]
    client = SmartClient(existing={("fr", 2, 2)}, episodes=episodes)
    run_until_marked(tmp_path, client, FakeMatcher([Match("fr", "Frieren", 2023)]), "[Sub] Frieren - 12 (1080p).mkv")
    assert client.sent[-1] == [{"title": "fr", "season": 2, "episode": 2}]


def test_daily_show_found_by_air_date(tmp_path):
    episodes = [{"season": 29, "number": 70, "aired_at": "2024-03-14"}, {"season": 29, "number": 71, "aired_at": "2024-03-15"}]
    client = SmartClient(existing={("ds", 29, 71)}, episodes=episodes)
    run_until_marked(tmp_path, client, FakeMatcher([Match("ds", "The Daily Show", 1996)]), "The.Daily.Show.2024.03.15.720p.WEB.mkv")
    assert client.sent == [[{"title": "ds", "season": 29, "episode": 71}]]


def test_vlc_status_parsing():
    data = {
        "state": "playing",
        "time": 600,
        "length": 2400,
        "position": 0.25,
        "information": {"category": {"meta": {"filename": FILE}}},
    }
    state = parse_status(data)
    assert state.file == FILE and state.progress == 25.0 and not state.paused
    assert parse_status({"state": "stopped"}) is None
