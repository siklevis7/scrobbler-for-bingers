"""Settings file and token storage.

Everything lives in one per-user folder:
  Windows: %APPDATA%\\bingers-scrobbler
  macOS:   ~/Library/Application Support/bingers-scrobbler
  Linux:   ~/.config/bingers-scrobbler
Set BINGERS_SCROBBLER_HOME to use another folder.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tomllib
from dataclasses import dataclass, field, fields
from pathlib import Path

APP_NAME = "bingers-scrobbler"
TOKEN_ENV = "BINGERS_TOKEN"


def app_dir() -> Path:
    override = os.environ.get("BINGERS_SCROBBLER_HOME")
    if override:
        base = Path(override)
    elif sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / APP_NAME
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / APP_NAME
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / APP_NAME
    base.mkdir(parents=True, exist_ok=True)
    return base


def default_mpv_ipc_path() -> str:
    return r"\\.\pipe\mpv-pipe" if sys.platform == "win32" else "/tmp/mpv-socket"


DEFAULT_CONFIG = """\
# Bingers Scrobbler settings

[app]
# Show a Windows notification when something is marked watched.
notifications = true
# Look for a new version once a day and download it in the background.
check_updates = true
# After a mark, add the next episode (or when it airs) to the notification.
up_next = true
# After the last episode of a show, suggest a few similar ones.
suggestions = true
# On Sunday evening, show what you watched this week.
weekly_summary = true

[scrobble]
# How far into a file (percent) you must get before it counts as watched.
threshold = 80
# Seconds you must actually spend playing it, so skipping to the end doesn't count.
# Files shorter than twice this only need half their length.
min_watched_seconds = 300
# How often to check the players, in seconds.
poll_interval = 5

[players.vlc]
enabled = true
host = "127.0.0.1"
port = 8080
# The password you set in VLC: Tools > Preferences > Show settings: All >
# Interface > Main interfaces > Lua > Lua HTTP > Password.
password = ""

[players.mpv]
enabled = true
# Must match input-ipc-server in your mpv.conf.
ipc_path = '{mpv_ipc}'

[overrides]
# When search picks the wrong show or movie, pin a title from your filenames to a Bingers id.
# The key is the title as it appears in the filename (case and punctuation don't matter).
# "Doctor Who 2005" = "tvdb:78804"
# "The Office" = "tvdb:73244"
"""


@dataclass
class AppSettings:
    notifications: bool = True
    check_updates: bool = True
    up_next: bool = True
    suggestions: bool = True
    weekly_summary: bool = True


@dataclass
class ScrobbleSettings:
    threshold: float = 80.0
    min_watched_seconds: float = 300.0
    poll_interval: float = 5.0


@dataclass
class VlcSettings:
    enabled: bool = True
    host: str = "127.0.0.1"
    port: int = 8080
    password: str = ""


@dataclass
class MpvSettings:
    enabled: bool = True
    ipc_path: str = field(default_factory=default_mpv_ipc_path)


@dataclass
class Config:
    app: AppSettings = field(default_factory=AppSettings)
    scrobble: ScrobbleSettings = field(default_factory=ScrobbleSettings)
    vlc: VlcSettings = field(default_factory=VlcSettings)
    mpv: MpvSettings = field(default_factory=MpvSettings)
    overrides: dict[str, str] = field(default_factory=dict)
    path: Path | None = None


def config_path() -> Path:
    return app_dir() / "config.toml"


def _build(cls, data: dict):
    known = {f.name for f in fields(cls)}
    return cls(**{k: v for k, v in data.items() if k in known})


def load_config(path: Path | None = None) -> Config:
    path = path or config_path()
    if not path.exists():
        path.write_text(DEFAULT_CONFIG.format(mpv_ipc=default_mpv_ipc_path()), encoding="utf-8")
    with path.open("rb") as fh:
        raw = tomllib.load(fh)

    players = raw.get("players", {})
    cfg = Config(
        app=_build(AppSettings, raw.get("app", {})),
        scrobble=_build(ScrobbleSettings, raw.get("scrobble", {})),
        vlc=_build(VlcSettings, players.get("vlc", {})),
        mpv=_build(MpvSettings, players.get("mpv", {})),
        overrides={str(k): str(v) for k, v in raw.get("overrides", {}).items()},
        path=path,
    )
    cfg.scrobble.threshold = min(100.0, max(50.0, float(cfg.scrobble.threshold)))
    cfg.scrobble.min_watched_seconds = max(0.0, float(cfg.scrobble.min_watched_seconds))
    cfg.scrobble.poll_interval = max(1.0, float(cfg.scrobble.poll_interval))
    return cfg


def _toml_value(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    return json.dumps(str(value), ensure_ascii=False)  # a valid TOML basic string


def set_value(section: str, key: str, value: object, path: Path | None = None) -> None:
    """Change one setting in config.toml, keeping the user's comments and layout."""
    path = path or config_path()
    if not path.exists():
        load_config(path)
    lines = path.read_text(encoding="utf-8").splitlines()
    new_line = f"{key} = {_toml_value(value)}"
    header = f"[{section}]"

    start = next((i for i, line in enumerate(lines) if line.strip() == header), None)
    if start is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines += [header, new_line]
    else:
        end = next(
            (i for i in range(start + 1, len(lines)) if lines[i].lstrip().startswith("[")),
            len(lines),
        )
        key_re = re.compile(rf"^\s*{re.escape(key)}\s*=")
        hit = next((i for i in range(start + 1, end) if key_re.match(lines[i])), None)
        if hit is not None:
            lines[hit] = new_line
        else:
            lines.insert(start + 1, new_line)

    tmp = path.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def delete_token() -> None:
    try:
        credentials_path().unlink()
    except FileNotFoundError:
        pass


def credentials_path() -> Path:
    return app_dir() / "credentials.json"


def load_token() -> str | None:
    env = os.environ.get(TOKEN_ENV, "").strip()
    if env:
        return env
    path = credentials_path()
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("token") or None
    except (OSError, ValueError):
        return None


def save_token(token: str) -> Path:
    path = credentials_path()
    path.write_text(json.dumps({"token": token}), encoding="utf-8")
    if sys.platform != "win32":
        path.chmod(0o600)
    return path
