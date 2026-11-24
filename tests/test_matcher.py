from bingers_scrobbler.matcher import Matcher, normalize, pick_best
from bingers_scrobbler.parser import ParsedMedia


def show(id, title, year=None, kind="show"):
    return {"id": id, "kind": kind, "title": title, "year": year}


def test_normalize():
    assert normalize("The Office (US)") == "office us"
    assert normalize("Amélie & Co.") == "amelie and co"


def test_prefers_matching_year():
    media = ParsedMedia("episode", "Doctor Who", 2005, 1, (1,))
    cands = [show("a", "Doctor Who", 1963), show("b", "Doctor Who", 2005)]
    assert pick_best(media, cands)["id"] == "b"


def test_skips_wrong_kind_and_far_names():
    media = ParsedMedia("movie", "Inception", 2010)
    cands = [show("x", "Inception", 2010, kind="show"), show("y", "Insomnia", 2002, kind="movie")]
    assert pick_best(media, cands) is None


def test_sequel_matches_spelled_out_part():
    media = ParsedMedia("movie", "Dune Part 2", 2024)
    cands = [show("one", "Dune", 2021, kind="movie"), show("two", "Dune: Part Two", 2024, kind="movie")]
    assert pick_best(media, cands)["id"] == "two"
    assert normalize("Kill Bill: Volume 2") == normalize("Kill Bill Vol 2")


def test_movie_rejects_remake_year():
    media = ParsedMedia("movie", "Dune", 2021)
    cands = [show("old", "Dune", 1984, kind="movie"), show("new", "Dune", 2021, kind="movie")]
    assert pick_best(media, cands)["id"] == "new"


class FakeClient:
    def __init__(self, results):
        self.results = results
        self.calls = 0

    def search(self, q, kind=None, limit=10):
        self.calls += 1
        return self.results


def test_cache_and_override(tmp_path):
    client = FakeClient([show("uuid-1", "Severance", 2022)])
    m = Matcher(client, tmp_path / "cache.json", {"The Office": "tvdb:73244"})
    media = ParsedMedia("episode", "Severance", None, 1, (1,))
    assert m.resolve(media).ref == "uuid-1"
    assert m.resolve(media).ref == "uuid-1"
    assert client.calls == 1  # second lookup came from the cache

    # A fresh matcher reads the cache from disk.
    assert Matcher(client, tmp_path / "cache.json").resolve(media).ref == "uuid-1"
    assert client.calls == 1

    office = ParsedMedia("episode", "the office", None, 2, (3,))
    assert m.resolve(office).ref == "tvdb:73244"
    assert client.calls == 1
