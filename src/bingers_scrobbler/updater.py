"""Checks GitHub for a newer release, downloads it, and starts the installer.

How it works:
  1. GET the latest release from GitHub (drafts and pre-releases are never offered).
  2. Compare its tag (v0.5.0) with this app's version.
  3. Download the asset that fits how the app was installed:
       installed with Setup  -> BingersScrobbler_Setup_<v>.exe into the app's data folder
       portable copy         -> BingersScrobbler_Portable_<v>.zip into Downloads
  4. Check the download's size and SHA-256 (GitHub publishes the digest of each file).
  5. Installed copies: run the installer silently, then the app exits; the installer
     replaces the files and starts the new version.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import requests

from . import __version__

log = logging.getLogger(__name__)

REPO = "siklevis7/scrobbler-for-bingers"
LATEST_URL = f"https://api.github.com/repos/{REPO}/releases/latest"
RELEASES_PAGE = f"https://github.com/{REPO}/releases/latest"

MODE_INSTALLED = "installed"
MODE_PORTABLE = "portable"
MODE_SOURCE = "source"


class UpdateError(Exception):
    """Checking or downloading failed; the message is fit to show to the user."""


@dataclass
class Release:
    version: str
    page_url: str
    asset_name: str | None = None
    asset_url: str | None = None
    asset_size: int | None = None
    sha256: str | None = None


def parse_version(text: str) -> tuple[int, ...]:
    """'v0.4.2' -> (0, 4, 2). Anything after the numbers (-beta, +build) is ignored."""
    match = re.match(r"\s*v?(\d+(?:\.\d+)*)", text or "")
    if not match:
        return ()
    parts = [int(p) for p in match.group(1).split(".")]
    while len(parts) > 1 and parts[-1] == 0:  # 0.5 == 0.5.0
        parts.pop()
    return tuple(parts)


def is_newer(candidate: str, current: str = __version__) -> bool:
    new, old = parse_version(candidate), parse_version(current)
    return bool(new) and new > old


def install_mode() -> str:
    """How this copy runs, which decides what an update looks like."""
    if not getattr(sys, "frozen", False):
        return MODE_SOURCE
    folder = Path(sys.executable).parent
    if any(folder.glob("unins*.exe")):  # Inno Setup puts its uninstaller next to the app
        return MODE_INSTALLED
    return MODE_PORTABLE


def _asset_pattern(mode: str) -> re.Pattern[str]:
    if mode == MODE_PORTABLE:
        return re.compile(r"^BingersScrobbler_Portable_.*\.zip$", re.I)
    return re.compile(r"^BingersScrobbler_Setup_.*\.exe$", re.I)


def release_from_json(data: dict, mode: str) -> Release:
    tag = str(data.get("tag_name") or "")
    if not parse_version(tag):
        raise UpdateError(f"GitHub's latest release has an unexpected name: {tag!r}")
    release = Release(version=tag.lstrip("vV"), page_url=data.get("html_url") or RELEASES_PAGE)
    pattern = _asset_pattern(mode)
    for asset in data.get("assets") or []:
        name = str(asset.get("name") or "")
        if pattern.match(name):
            release.asset_name = name
            release.asset_url = asset.get("browser_download_url")
            release.asset_size = asset.get("size")
            digest = str(asset.get("digest") or "")
            if digest.lower().startswith("sha256:"):
                release.sha256 = digest.split(":", 1)[1].lower()
            break
    return release


def check_latest(session: requests.Session | None = None, mode: str | None = None) -> Release:
    """The newest published release. Raises UpdateError when GitHub can't be asked."""
    session = session or requests.Session()
    try:
        resp = session.get(
            LATEST_URL,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": f"bingers-scrobbler/{__version__}",
            },
            timeout=15,
        )
    except requests.RequestException as exc:
        raise UpdateError(f"Couldn't reach GitHub ({exc.__class__.__name__})") from exc
    if resp.status_code == 404:
        raise UpdateError("No release has been published yet")
    if resp.status_code in (403, 429):
        raise UpdateError("GitHub is limiting requests right now; try again in an hour")
    if resp.status_code != 200:
        raise UpdateError(f"GitHub answered {resp.status_code}")
    try:
        data = resp.json()
    except ValueError as exc:
        raise UpdateError("GitHub sent an answer that couldn't be read") from exc
    return release_from_json(data, mode or install_mode())


def downloads_dir() -> Path:
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            # FOLDERID_Downloads: the real Downloads folder, even if the user moved it.
            guid = (ctypes.c_byte * 16).from_buffer_copy(
                bytes.fromhex("90e24d373f126545916439c4925e467b")
            )
            path_ptr = wintypes.LPWSTR()
            if ctypes.windll.shell32.SHGetKnownFolderPath(guid, 0, None, ctypes.byref(path_ptr)) == 0:
                folder = Path(path_ptr.value)
                ctypes.windll.ole32.CoTaskMemFree(path_ptr)
                return folder
        except Exception:
            log.debug("Couldn't look up the Downloads folder", exc_info=True)
    return Path.home() / "Downloads"


def download(
    release: Release,
    folder: Path,
    session: requests.Session | None = None,
    progress: Callable[[int, int | None], None] | None = None,
) -> Path:
    """Download the release's file into `folder`, checking size and SHA-256. Returns its path."""
    if not release.asset_url or not release.asset_name:
        raise UpdateError(f"Version {release.version} has no file for this kind of install")
    folder.mkdir(parents=True, exist_ok=True)
    name = re.split(r"[\\/]", release.asset_name)[-1]  # never trust a path inside the name
    if not name or name in (".", ".."):
        raise UpdateError("The release file has an unexpected name")
    target = folder / name
    if target.exists() and _matches(target, release):
        return target  # downloaded earlier
    partial = target.with_name(target.name + ".part")
    session = session or requests.Session()
    sha = hashlib.sha256()
    received = 0
    try:
        with session.get(
            release.asset_url,
            headers={"User-Agent": f"bingers-scrobbler/{__version__}"},
            stream=True,
            timeout=30,
        ) as resp:
            if resp.status_code != 200:
                raise UpdateError(f"The download failed (GitHub answered {resp.status_code})")
            with partial.open("wb") as fh:
                for chunk in resp.iter_content(chunk_size=256 * 1024):
                    if not chunk:
                        continue
                    fh.write(chunk)
                    sha.update(chunk)
                    received += len(chunk)
                    if progress:
                        progress(received, release.asset_size)
    except requests.RequestException as exc:
        partial.unlink(missing_ok=True)
        raise UpdateError(f"The download was interrupted ({exc.__class__.__name__})") from exc
    except UpdateError:
        partial.unlink(missing_ok=True)
        raise
    except OSError as exc:  # disk full, folder not writable, antivirus lock…
        partial.unlink(missing_ok=True)
        raise UpdateError(f"Couldn't save the download ({exc})") from exc

    if release.asset_size is not None and received != release.asset_size:
        partial.unlink(missing_ok=True)
        raise UpdateError("The download was incomplete; try again")
    if release.sha256 and sha.hexdigest() != release.sha256:
        partial.unlink(missing_ok=True)
        raise UpdateError("The downloaded file didn't match GitHub's checksum, so it was deleted")
    try:
        os.replace(partial, target)
    except OSError as exc:
        partial.unlink(missing_ok=True)
        raise UpdateError(f"Couldn't save the download ({exc})") from exc
    return target


def _matches(path: Path, release: Release) -> bool:
    if release.asset_size is not None and path.stat().st_size != release.asset_size:
        return False
    if release.sha256:
        sha = hashlib.sha256()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                sha.update(chunk)
        return sha.hexdigest() == release.sha256
    return True


def clean_old(folder: Path, keep: Path | None = None) -> None:
    """Remove installers left from earlier updates."""
    if not folder.is_dir():
        return
    for item in folder.iterdir():
        if item != keep and item.name.startswith("BingersScrobbler_"):
            try:
                item.unlink()
            except OSError:
                pass


def installer_command(installer: Path) -> list[str]:
    # /RELAUNCH=1 is read by our installer script to start the app again when it's done.
    return [str(installer), "/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS", "/RELAUNCH=1"]


def start_installer(installer: Path) -> None:
    """Start the installer as its own process; the caller should exit right after."""
    flags = 0
    if sys.platform == "win32":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(installer_command(installer), creationflags=flags, close_fds=True)


# -- "just updated" notice ----------------------------------------------------


def note_version(state_file: Path, current: str = __version__) -> str | None:
    """Remember the version that ran last. Returns the old version if this one is newer."""
    previous = None
    try:
        previous = json.loads(state_file.read_text(encoding="utf-8")).get("last_version")
    except (OSError, ValueError, AttributeError):
        pass
    if previous != current:
        try:
            state_file.write_text(json.dumps({"last_version": current}), encoding="utf-8")
        except OSError:
            pass
    if previous and is_newer(current, previous):
        return previous
    return None
