import hashlib

import pytest
import requests

from bingers_scrobbler import updater
from bingers_scrobbler.updater import Release, UpdateError


def test_versions_compare_as_numbers():
    assert updater.is_newer("v0.10.0", "0.9.9")
    assert updater.is_newer("0.4.3", "0.4.2")
    assert updater.is_newer("1.0", "0.99.1")
    assert not updater.is_newer("v0.4.2", "0.4.2")
    assert not updater.is_newer("0.5", "0.5.0")
    assert not updater.is_newer("0.4.1", "0.4.2")
    assert not updater.is_newer("nightly", "0.4.2")
    assert updater.parse_version("v1.2.3-beta") == (1, 2, 3)


RELEASE_JSON = {
    "tag_name": "v0.5.0",
    "html_url": "https://github.com/x/y/releases/tag/v0.5.0",
    "assets": [
        {"name": "BingersScrobbler_Extension_0.5.0.zip", "browser_download_url": "https://dl/ext", "size": 1},
        {
            "name": "BingersScrobbler_Portable_0.5.0.zip",
            "browser_download_url": "https://dl/portable",
            "size": 2,
        },
        {
            "name": "BingersScrobbler_Setup_0.5.0.exe",
            "browser_download_url": "https://dl/setup",
            "size": 3,
            "digest": "sha256:ABC",
        },
    ],
}


def test_picks_the_file_for_how_the_app_was_installed():
    installed = updater.release_from_json(RELEASE_JSON, updater.MODE_INSTALLED)
    assert installed.version == "0.5.0"
    assert installed.asset_url == "https://dl/setup"
    assert installed.sha256 == "abc"
    portable = updater.release_from_json(RELEASE_JSON, updater.MODE_PORTABLE)
    assert portable.asset_url == "https://dl/portable"
    assert portable.sha256 is None


def test_odd_tag_is_an_error():
    with pytest.raises(UpdateError):
        updater.release_from_json({"tag_name": "latest", "assets": []}, updater.MODE_INSTALLED)


class FakeResponse:
    def __init__(self, status=200, body=b"", data=None):
        self.status_code = status
        self.body = body
        self.data = data

    def json(self):
        return self.data

    def iter_content(self, chunk_size):
        for i in range(0, len(self.body), 4):
            yield self.body[i : i + 4]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeSession:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = 0

    def get(self, url, **kwargs):
        self.calls += 1
        if self.error:
            raise self.error
        return self.response


def test_check_latest_reports_github_problems():
    with pytest.raises(UpdateError, match="limiting"):
        updater.check_latest(FakeSession(FakeResponse(403)), mode=updater.MODE_INSTALLED)
    with pytest.raises(UpdateError, match="reach GitHub"):
        updater.check_latest(FakeSession(error=requests.ConnectionError()), mode=updater.MODE_INSTALLED)
    release = updater.check_latest(FakeSession(FakeResponse(data=RELEASE_JSON)), mode=updater.MODE_INSTALLED)
    assert release.asset_name == "BingersScrobbler_Setup_0.5.0.exe"


def _release(body: bytes, sha: str | None = None, size: int | None = None) -> Release:
    return Release(
        version="0.5.0",
        page_url="https://x",
        asset_name="BingersScrobbler_Setup_0.5.0.exe",
        asset_url="https://dl/setup",
        asset_size=len(body) if size is None else size,
        sha256=sha if sha is not None else hashlib.sha256(body).hexdigest(),
    )


def test_download_checks_checksum_and_reuses_file(tmp_path):
    body = b"installer bytes here"
    release = _release(body)
    path = updater.download(release, tmp_path, FakeSession(FakeResponse(body=body)))
    assert path.read_bytes() == body
    assert not list(tmp_path.glob("*.part"))

    again = FakeSession(FakeResponse(body=body))
    assert updater.download(release, tmp_path, again) == path
    assert again.calls == 0  # already there and matching


def test_download_rejects_tampered_or_short_files(tmp_path):
    body = b"installer bytes here"
    with pytest.raises(UpdateError, match="checksum"):
        updater.download(_release(body, sha="0" * 64), tmp_path, FakeSession(FakeResponse(body=body)))
    with pytest.raises(UpdateError, match="incomplete"):
        updater.download(_release(body, size=999), tmp_path, FakeSession(FakeResponse(body=body)))
    assert list(tmp_path.iterdir()) == []  # nothing half-written is left behind


def test_download_ignores_folders_in_the_asset_name(tmp_path):
    body = b"x" * 10
    release = _release(body)
    release.asset_name = "..\\..\\evil\\BingersScrobbler_Setup_0.5.0.exe"
    path = updater.download(release, tmp_path, FakeSession(FakeResponse(body=body)))
    assert path.parent == tmp_path


def test_installer_runs_silently_and_relaunches(tmp_path):
    cmd = updater.installer_command(tmp_path / "setup.exe")
    assert "/SILENT" in cmd and "/RELAUNCH=1" in cmd


def test_note_version_says_when_just_updated(tmp_path):
    state = tmp_path / "state.json"
    assert updater.note_version(state, "0.4.2") is None  # first run
    assert updater.note_version(state, "0.4.2") is None
    assert updater.note_version(state, "0.5.0") == "0.4.2"
    assert updater.note_version(state, "0.5.0") is None
