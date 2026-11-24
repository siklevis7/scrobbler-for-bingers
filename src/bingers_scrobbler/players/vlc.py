"""VLC, through its built-in web interface (Lua HTTP).

Turn it on in VLC: Tools > Preferences > Show settings: All > Interface > Main interfaces,
tick "Web", then under Main interfaces > Lua set a Lua HTTP password. Restart VLC.
It then serves http://127.0.0.1:8080/requests/status.json.
"""

from __future__ import annotations

import logging

import requests

from . import PlaybackState

log = logging.getLogger(__name__)


class VlcPlayer:
    name = "vlc"

    def __init__(self, host: str = "127.0.0.1", port: int = 8080, password: str = "", timeout: float = 2.0):
        self.url = f"http://{host}:{port}/requests/status.json"
        self.password = password
        self.timeout = timeout
        self.session = requests.Session()
        self._warned: set[str] = set()

    def poll(self) -> PlaybackState | None:
        if not self.password:
            self._warn_once("no-password", "VLC: no password set in config, so VLC is skipped")
            return None
        try:
            resp = self.session.get(self.url, auth=("", self.password), timeout=self.timeout)
        except requests.RequestException:
            return None  # VLC isn't running, or its web interface is off
        if resp.status_code == 401:
            self._warn_once("bad-password", "VLC: the web interface refused the password in config")
            return None
        if not resp.ok:
            return None
        try:
            data = resp.json()
        except ValueError:
            return None
        return parse_status(data)

    def _warn_once(self, key: str, message: str) -> None:
        if key not in self._warned:
            self._warned.add(key)
            log.warning(message)


def parse_status(data: dict) -> PlaybackState | None:
    state = data.get("state")
    if state not in ("playing", "paused"):
        return None
    meta = ((data.get("information") or {}).get("category") or {}).get("meta") or {}
    name = meta.get("filename") or meta.get("title")
    length = float(data.get("length") or 0)
    if not name or length <= 0:
        return None
    # "position" is a 0-1 fraction and more precise than "time", which is whole seconds.
    fraction = data.get("position")
    if isinstance(fraction, (int, float)) and fraction > 0:
        position = float(fraction) * length
    else:
        position = float(data.get("time") or 0)
    return PlaybackState("vlc", str(name), position, length, paused=(state == "paused"))
