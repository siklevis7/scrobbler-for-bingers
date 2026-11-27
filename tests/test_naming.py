"""File names and same-name shows seen in real use (see the scrobbler log of 2026-11-26)."""

from bingers_scrobbler.matcher import Matcher, pick_best, split_tag
from bingers_scrobbler.parser import ParsedMedia, parse_filename
from bingers_scrobbler.players.vlc import find_current_path


def c(id, title, year, kind="show"):
    return {"id": id, "title": title, "year": year, "kind": kind}


# What Bingers' search really returned for these names.
DARK_MATTER = [c("dm24", "Dark Matter (2024)", 2024), c("dm15", "Dark Matter", 2015), c("x", "Dark Matters", 2011)]
OUTSIDER = [c("o20", "The Outsider (2020)", 2020), c("o68", "The Outsider", 1968), c("o83", "The Outsider (1983)", 1983)]


def test_year_in_bingers_name_is_understood():
    assert split_tag("Dark Matter (2024)") == ("Dark Matter", "2024")
    assert split_tag("The Office (US)") == ("The Office", "US")
    assert split_tag("Severance") == ("Severance", None)


def test_dark_matter_2024_not_2015():
    media = parse_filename("Dark.Matter.2024.S01E02.1080p.WEB.h264.mkv")
    assert (media.title, media.year) == ("Dark Matter", 2024)
    assert pick_best(media, DARK_MATTER)["id"] == "dm24"


def test_the_outsider_2020_not_1968():
    media = parse_filename("The.Outsider.2020.S01E03.720p.mkv")
    assert pick_best(media, OUTSIDER)["id"] == "o20"


def test_without_year_the_plain_name_still_works():
    media = ParsedMedia("episode", "The Outsider", None, 1, (1,))
    assert pick_best(media, OUTSIDER)["id"] in {"o20", "o68"}  # ambiguous: API order decides


def test_year_off_by_one_still_preferred():
    media = ParsedMedia("episode", "Dark Matter", 2023, 1, (1,))
    assert pick_best(media, DARK_MATTER)["id"] == "dm24"


def test_country_in_file_name():
    shows = [c("uk", "The Office (UK)", 2001), c("us", "The Office (US)", 2005)]
    media = parse_filename("The.Office.US.S02E03.720p.mkv")
    assert media.country == "US"
    assert pick_best(media, shows)["id"] == "us"


def test_shows_named_after_numbers_and_dates():
    cases = {
        "12.12.12.S01E04.720p.10bit.WEBRip.2CH.x265.HEVC-PSA.mkv": ("12 12 12", 1, (4,)),
        "1883.S01E02.1080p.mkv": ("1883", 1, (2,)),
        "9-1-1.S07E01.720p.mkv": ("9-1-1", 7, (1,)),
        "24.S01E01.mkv": ("24", 1, (1,)),
        "Blade.Runner.2099.S01E01.mkv": ("Blade Runner 2099", 1, (1,)),
    }
    for name, (title, season, episodes) in cases.items():
        media = parse_filename(name)
        assert media is not None, name
        assert media.kind == "episode", name
        assert (media.season, media.episodes) == (season, episodes), name
        assert media.title.replace(".", " ").replace("-", " ") == title.replace("-", " "), name


def test_daily_show_by_date():
    media = parse_filename("The.Daily.Show.2024.03.15.Guest.Name.720p.WEB.mkv")
    assert media.kind == "episode"
    assert media.air_date == "2024-03-15"
    assert media.label().endswith("2024-03-15")


def test_anime_absolute_numbering_and_samples():
    media = parse_filename("[SubsPlease] Frieren - 12 (1080p) [A1B2C3D4].mkv")
    assert (media.title, media.season, media.episodes) == ("Frieren", None, (12,))
    assert parse_filename("Ozark.S04E01.sample.mkv") is None
    assert parse_filename("Dune.Part.Two.Trailer.2024.mkv") is None


def test_folders_help_when_the_file_name_is_short():
    media = parse_filename(r"D:\TV\Severance\Season 1\03 - In Perpetuity.mkv")
    assert media is not None and media.kind == "episode"
    assert (media.title, media.season, media.episodes) == ("Severance", 1, (3,))


def test_vlc_playlist_gives_the_full_path():
    playlist = {"children": [{"name": "Playlist", "children": [
        {"name": "a.mkv", "uri": "file:///D:/TV/Other/a.mkv"},
        {"name": "03 - In Perpetuity.mkv", "current": "current", "uri": "file:///D:/TV/Severance/Season%201/03%20-%20In%20Perpetuity.mkv"},
    ]}]}
    assert find_current_path(playlist) == "D:/TV/Severance/Season 1/03 - In Perpetuity.mkv"


class FakeClient:
    def __init__(self, first, second=()):
        self.first, self.second, self.queries = list(first), list(second), []

    def search(self, q, kind=None, limit=10):
        self.queries.append(q)
        return self.first if len(self.queries) == 1 else self.second


def test_searches_again_with_the_year_when_needed(tmp_path):
    # First search has only the old show; searching "Dark Matter 2024" finds the new one.
    client = FakeClient([c("dm15", "Dark Matter", 2015)], [c("dm24", "Dark Matter (2024)", 2024)])
    m = Matcher(client, tmp_path / "match_cache.json")
    matches = m.resolve_all(ParsedMedia("episode", "Dark Matter", 2024, 1, (2,)))
    assert matches[0].ref == "dm24"
    assert client.queries == ["Dark Matter", "Dark Matter 2024"]
    assert [x.ref for x in matches] == ["dm24", "dm15"]  # the old one kept as a fallback


def test_old_cache_is_ignored(tmp_path):
    (tmp_path / "match_cache.json").write_text('{"show|dark matter|2024": {"ref": "dm15", "name": "Dark Matter", "year": 2015}}')
    m = Matcher(FakeClient(DARK_MATTER), tmp_path / "match_cache.json")
    assert m.resolve(ParsedMedia("episode", "Dark Matter", 2024, 1, (2,))).ref == "dm24"
