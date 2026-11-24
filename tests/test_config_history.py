from bingers_scrobbler.config import load_config, set_value
from bingers_scrobbler.history import History


def test_set_value_keeps_comments_and_updates(tmp_path):
    path = tmp_path / "config.toml"
    load_config(path)  # writes the default file
    set_value("scrobble", "threshold", 65, path)
    set_value("players.vlc", "password", 'p"w\\d', path)
    set_value("app", "notifications", False, path)

    text = path.read_text(encoding="utf-8")
    assert "# How far into a file" in text  # comments survive
    cfg = load_config(path)
    assert cfg.scrobble.threshold == 65
    assert cfg.vlc.password == 'p"w\\d'
    assert cfg.app.notifications is False
    assert cfg.mpv.enabled is True


def test_set_value_adds_missing_section_and_key(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text("[scrobble]\nthreshold = 80\n", encoding="utf-8")
    set_value("app", "notifications", False, path)
    set_value("scrobble", "poll_interval", 3, path)
    cfg = load_config(path)
    assert cfg.app.notifications is False
    assert cfg.scrobble.poll_interval == 3
    assert cfg.scrobble.threshold == 80


def test_history_newest_first(tmp_path):
    h = History(tmp_path / "history.jsonl")
    h.add("Dark S01E01", "marked watched")
    h.add("Dark S01E02", "saved to backlog")
    recent = h.recent()
    assert [e["what"] for e in recent] == ["Dark S01E02", "Dark S01E01"]
    assert recent[0]["result"] == "saved to backlog"
