from datetime import date, datetime, timedelta, timezone

from bingers_scrobbler import insights
from bingers_scrobbler.api import BingersClient
from bingers_scrobbler.backlog import Backlog
from bingers_scrobbler.config import ScrobbleSettings
from bingers_scrobbler.matcher import Matcher, is_close_call, rank_candidates
from bingers_scrobbler.parser import parse_filename
from bingers_scrobbler.players import PlaybackState
from bingers_scrobbler.stats import WatchStats, due_week, week_bounds
from bingers_scrobbler.tracker import EVENT_FINISHED, EVENT_SCROBBLED, Tracker, mark_outcome

from test_tracker import Clock, FakeMatcher, FakePlayer


def show(id_, title, year):
    return {"id": id_, "kind": "show", "title": title, "year": year}


# -- matching ---------------------------------------------------------------------


def test_get_requests_ask_for_english_names():
    sent = []

    class Session:
        headers: dict = {}

        def request(self, method, url, **kwargs):
            sent.append((method, kwargs.get("params")))

            class R:
                status_code = 200
                content = b"{}"

                def json(self):
                    return {"items": []}

            return R()

    client = BingersClient("t", session=Session())
    client.search("Money Heist")
    client.search("La casa de papel", original_names=True)
    client.scrobble([{"title": "x"}])
    assert sent[0][1]["lang"] == "en"
    assert "lang" not in sent[1][1]
    assert sent[2][0] == "POST" and not sent[2][1]


class LibraryClient:
    def __init__(self, results, library=None, local=None):
        self.results, self.library, self.local = results, library or {}, local or []
        self.checked = []

    def search(self, query, kind=None, limit=10, original_names=False):
        return self.local if original_names else self.results

    def check(self, refs):
        self.checked.append(refs)
        return {r: self.library[r] for r in refs if r in self.library}


def test_same_name_show_you_follow_wins_a_close_call(tmp_path):
    results = [show("old", "Dark Matter", 2015), show("new", "Dark Matter (2024)", 2024)]
    library = {"new": {"status": "watch_next", "last_watched_at": "2026-11-01T00:00:00Z"}}
    client = LibraryClient(results, library)
    matcher = Matcher(client, tmp_path / "cache.json")
    assert matcher.resolve(parse_filename("Dark.Matter.S01E03.mkv")).ref == "new"
    assert client.checked  # asked Bingers

    # A clear year in the name is never overruled by the library.
    client2 = LibraryClient(results, library)
    m2 = Matcher(client2, tmp_path / "cache2.json")
    assert m2.resolve(parse_filename("Dark.Matter.2015.S01E03.mkv")).ref == "old"
    assert client2.checked == []  # not a close call: no extra request


def test_original_language_names_are_tried_when_english_finds_nothing(tmp_path):
    client = LibraryClient([], local=[show("lcdp", "La casa de papel", 2017)])
    matcher = Matcher(client, tmp_path / "cache.json")
    assert matcher.resolve(parse_filename("La.Casa.De.Papel.S01E01.mkv")).ref == "lcdp"


def test_dropped_subtitle_matches_unless_the_prefix_is_shared():
    media = parse_filename("[SubsPlease] Frieren - 12 (1080p).mkv")
    assert rank_candidates(media, [show("f", "Frieren: Beyond Journey's End", 2023)])[0]["id"] == "f"
    star = parse_filename("Star.Wars.S01E01.mkv")
    assert rank_candidates(star, [show("a", "Star Wars: Andor", 2022), show("b", "Star Wars: Skeleton Crew", 2024)]) == []
    aot = parse_filename("Attack.on.Titan.S04E28.mkv")
    ranked = rank_candidates(aot, [show("jh", "Attack on Titan: Junior High", 2015), show("aot", "Attack on Titan", 2013)])
    assert ranked[0]["id"] == "aot"
    assert not is_close_call(aot, ranked[:1])


# -- after a mark ------------------------------------------------------------------

EPISODES = [
    {"season": 0, "number": 1, "title": "Special", "aired_at": "2024-01-01"},
    {"season": 1, "number": 1, "title": "One", "aired_at": "2024-05-08"},
    {"season": 1, "number": 2, "title": "Two", "aired_at": "2024-05-15"},
    {"season": 2, "number": 1, "title": "Back", "aired_at": "2026-12-04"},
    {"season": 2, "number": 2, "title": "", "aired_at": None},
]
TODAY = date(2026, 11, 27)  # a Friday


def test_next_episode_and_when_it_airs():
    nxt = insights.next_episode
    assert insights.describe_next(nxt(EPISODES, 1, 1), TODAY) == "Up next: S01E02 · Two"
    assert insights.describe_next(nxt(EPISODES, 1, 2), TODAY) == "Next episode, S02E01, airs on 4 December"
    assert insights.describe_next({"season": 2, "number": 1, "aired_at": "2026-11-28"}, TODAY).endswith("airs tomorrow")
    assert insights.describe_next({"season": 2, "number": 1, "aired_at": "2026-12-01"}, TODAY).endswith("airs on Tuesday")
    assert insights.describe_next(nxt(EPISODES, 2, 1), TODAY) == "Next: S02E02 (no air date yet)"
    assert nxt(EPISODES, 2, 2) is None


class ShowClient:
    """Bingers for one show; records scrobbles."""

    def __init__(self, episodes, status="completed", catalog="Ended", outcome="watched"):
        self.eps, self.status, self.catalog, self.outcome = episodes, status, catalog, outcome
        self.sent = []

    def episodes(self, ref, season=None):
        return self.eps

    def check(self, refs):
        return {refs[0]: {"status": self.status, "title": {"title": "Severance", "catalog_status": self.catalog}}}

    def similar(self, ref, limit=3):
        return [{"title": "Fringe", "my_status": "not_in_library"}, {"title": "Seen", "my_status": "completed"}]

    def scrobble(self, items, dry_run=False):
        self.sent.append(items)
        it = items[-1]
        return [
            {
                "status": "ok",
                "outcome": self.outcome,
                "title": {"id": "sev", "title": "Severance"},
                "episode": {"season": it["season"], "number": it["episode"]},
            }
        ]


def test_after_mark_finished_show_suggests_similar():
    out = insights.after_mark(ShowClient(EPISODES[:3]), "sev", 1, 2, TODAY)
    assert out.finished and out.suggestions == ["Fringe"]
    running = insights.after_mark(ShowClient(EPISODES[:3], "caught_up", "Continuing"), "sev", 1, 2, TODAY)
    assert not running.finished and "caught up" in running.note

    class Broken:
        def episodes(self, *a, **k):
            raise OSError("offline")

    assert insights.after_mark(Broken(), "sev", 1, 1, TODAY) == insights.AfterMark()


def run_to_end(tracker, player, clock, file):
    pos = 1500.0
    for _ in range(130):
        player.state = PlaybackState("fake", file, pos, 2400.0, False)
        tracker.tick()
        clock.t += 5
        pos += 5


def make_tracker(tmp_path, client):
    events = []
    player, clock = FakePlayer(), Clock()
    settings = ScrobbleSettings(threshold=80, min_watched_seconds=300, poll_interval=5)
    tracker = Tracker(
        [player], client, FakeMatcher(), Backlog(tmp_path / "b.json"), settings, clock,
        on_event=lambda kind, msg: events.append((kind, msg)),
    )
    return tracker, player, clock, events


def test_notification_has_the_next_episode_and_names_rewatches(tmp_path):
    client = ShowClient(EPISODES, outcome="rewatched")
    tracker, player, clock, events = make_tracker(tmp_path, client)
    run_to_end(tracker, player, clock, "Severance.S01E01.mkv")
    marked = [m for k, m in events if k == EVENT_SCROBBLED]
    assert marked and marked[0].startswith("Severance S01E01 marked as a rewatch")
    assert marked[0].endswith("Up next: S01E02 · Two")


def test_last_episode_brings_suggestions_and_can_be_turned_off(tmp_path):
    client = ShowClient(EPISODES[:3])
    tracker, player, clock, events = make_tracker(tmp_path, client)
    run_to_end(tracker, player, clock, "Severance.S01E02.mkv")
    finished = [m for k, m in events if k == EVENT_FINISHED]
    assert finished == ["You finished Severance! You might like: Fringe"]

    tracker2, player2, clock2, events2 = make_tracker(tmp_path, ShowClient(EPISODES[:3]))
    tracker2.up_next = tracker2.suggest = False
    run_to_end(tracker2, player2, clock2, "Severance.S01E02.mkv")
    assert [m for k, m in events2 if k == EVENT_SCROBBLED] == ["Severance S01E02 marked watched"]
    assert not [k for k, _ in events2 if k == EVENT_FINISHED]


def test_mark_outcome():
    assert mark_outcome([{"status": "already"}]) == "already watched"
    assert mark_outcome([{"status": "ok", "outcome": "rewatched"}]) == "marked as a rewatch"
    assert mark_outcome([{"status": "ok", "outcome": "watched"}]) == "marked watched"


def test_watch_items_and_where_to_watch():
    data = {
        "sections": {
            "watch_next": {
                "count": 2,
                "items": [{"id": "a", "title": "Ozark", "url": "u", "kind": "show",
                           "progress": {"next": {"season": 4, "number": 13, "title": "Fin", "aired_at": "2022-04-29"}}}],
            },
            "collecting_dust": {"count": 1, "items": [{"id": "b", "title": "Lost", "kind": "show", "progress": None}]},
        }
    }
    items = insights.watch_items(data, ("watch_next", "collecting_dust"))
    assert [i.label() for i in items] == ["Ozark - S04E13 Fin", "Lost"]
    wtw = {"where_to_watch": {"country": "US", "streaming": ["Netflix", "Netflix"], "rent": ["Apple TV"]}}
    assert insights.where_to_watch(wtw) == "In US: Netflix (streaming) · Apple TV (rent)"
    assert insights.where_to_watch({}) == ""


# -- weekly summary ------------------------------------------------------------------


class FeedClient:
    def __init__(self, pages):
        self.pages = pages
        self.cursors = []

    def entries(self, cursor=None, limit=10000):
        self.cursors.append(cursor)
        return self.pages.pop(0)

    def titles(self, ids):
        names = {"s": ("Ozark", "show", 60), "m": ("Dune", "movie", 155)}
        return [{"id": i, "title": names[i][0], "kind": names[i][1], "runtime_minutes": names[i][2]} for i in ids]


def test_weekly_summary_from_the_change_feed(tmp_path):
    tz = timezone.utc
    now = datetime(2026, 11, 29, 19, 0, tzinfo=tz)  # Sunday evening
    at = lambda d: datetime(2026, 11, d, 20, tzinfo=tz).isoformat()  # noqa: E731
    row = lambda e, t, d, kind="episode", **kw: {  # noqa: E731
        "entity_kind": kind, "entity_id": e, "title_id": t, "watched": True, "last_watched_at": at(d), **kw
    }
    feed = FeedClient([
        {"items": [row("e1", "s", 24), row("e0", "s", 18), row("old", "s", 1)], "next_cursor": "c1", "has_more": True},
        {"items": [row("e2", "s", 25), row("m", "m", 26, "movie"), row("gone", "s", 24, deleted=True)],
         "next_cursor": "c2", "has_more": False},
    ])
    stats = WatchStats(tmp_path / "w.json")
    stats.sync(feed, now)
    assert feed.cursors == [None, "c1"]
    assert stats.cursor == "c2"
    start, end = week_bounds(now)
    text = stats.describe(start, end, "This week")
    assert text.startswith("This week: 2 episodes of 1 show and 1 movie, about 4 h 35 min.")
    assert "Most watched: Ozark (2 episodes)." in text
    assert "1 episode more than the week before." in text

    again = WatchStats(tmp_path / "w.json")  # kept on disk; the next sync continues from the cursor
    feed2 = FeedClient([{"items": [], "next_cursor": "c2", "has_more": False}])
    again.sync(feed2, now)
    assert feed2.cursors == ["c2"]
    assert again.summary(start, end).episodes == 2


def test_weekly_summary_is_shown_once():
    sunday = datetime(2026, 11, 29, 19, 0).astimezone()
    start, end = week_bounds(sunday)
    assert start.weekday() == 0 and start.day == 23
    assert due_week(sunday, None) == (start, end)
    assert due_week(sunday, "2026-11-23") is None
    assert due_week(sunday + timedelta(hours=14), "2026-11-23") is None  # Monday: already shown
    friday = datetime(2026, 11, 27, 12, 0).astimezone()
    assert due_week(friday, "2026-11-09")[0].day == 16  # the week that just ended
