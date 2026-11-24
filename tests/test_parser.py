from bingers_scrobbler.parser import parse_filename


def test_episode():
    m = parse_filename("The.Office.US.S02E03.720p.WEB-DL.x264.mkv")
    assert m.kind == "episode"
    assert m.season == 2
    assert m.episodes == (3,)
    assert "office" in m.title.lower()


def test_multi_episode():
    m = parse_filename("Breaking.Bad.S01E01E02.1080p.mkv")
    assert m.kind == "episode"
    assert m.episodes == (1, 2)


def test_episode_from_path_folder():
    m = parse_filename(r"D:\TV\Severance\Season 1\Severance - 1x04 - The You You Are.mkv")
    assert m.kind == "episode"
    assert (m.season, m.episodes) == (1, (4,))


def test_movie_with_year():
    m = parse_filename("Inception.2010.1080p.BluRay.x264.mkv")
    assert m.kind == "movie"
    assert m.title == "Inception"
    assert m.year == 2010


def test_movie_sequel_keeps_part():
    assert parse_filename("Dune.Part.Two.2024.2160p.mkv").title == "Dune Part 2"
    assert parse_filename("Kill.Bill.Vol.2.2004.mkv").title == "Kill Bill Vol 2"


def test_label():
    m = parse_filename("Dark.S03E08.mkv")
    assert m.label() == "Dark S03E08"


def test_garbage():
    assert parse_filename("") is None
