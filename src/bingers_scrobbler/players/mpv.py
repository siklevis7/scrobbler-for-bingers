"""mpv, through its JSON IPC (also works for mpv.net and other mpv front ends that expose it).

Add this line to mpv.conf (Windows: %APPDATA%\\mpv\\mpv.conf):
    input-ipc-server=\\\\.\\pipe\\mpv-pipe
On macOS/Linux use a socket path instead, e.g. input-ipc-server=/tmp/mpv-socket
"""

from __future__ import annotations

import json
import logging
import socket
import sys
import threading
from typing import Any

from . import PlaybackState

log = logging.getLogger(__name__)


class MpvPlayer:
    name = "mpv"

    def __init__(self, ipc_path: str, timeout: float = 2.0):
        self.ipc_path = ipc_path
        self.timeout = timeout
        self._request_id = 0

    def poll(self) -> PlaybackState | None:
        # A Windows named pipe has no read timeout, so query from a helper thread
        # and give up if mpv doesn't answer in time.
        result: list[PlaybackState | None] = [None]

        def work() -> None:
            result[0] = self._query()

        thread = threading.Thread(target=work, daemon=True)
        thread.start()
        thread.join(self.timeout + 1)
        if thread.is_alive():
            log.debug("mpv: no answer within %.0fs", self.timeout + 1)
            return None
        return result[0]

    def _query(self) -> PlaybackState | None:
        try:
            conn = _IpcConnection(self.ipc_path, self.timeout)
        except OSError:
            return None  # mpv isn't running, or IPC isn't turned on
        try:
            path = self._get(conn, "path")
            if not path:
                return None
            duration = self._get(conn, "duration")
            position = self._get(conn, "time-pos")
            paused = self._get(conn, "pause")
        except (OSError, ValueError):
            return None
        finally:
            conn.close()
        if not isinstance(duration, (int, float)) or duration <= 0:
            return None
        if not isinstance(position, (int, float)):
            position = 0.0
        return PlaybackState("mpv", str(path), float(position), float(duration), paused=bool(paused))

    def _get(self, conn: _IpcConnection, prop: str) -> Any:
        self._request_id += 1
        request_id = self._request_id
        conn.send({"command": ["get_property", prop], "request_id": request_id})
        # mpv may interleave event messages; skip until our answer arrives.
        for _ in range(100):
            msg = conn.receive()
            if msg.get("request_id") == request_id:
                if msg.get("error") != "success":
                    return None  # e.g. "property unavailable" while nothing is loaded
                return msg.get("data")
        raise ValueError("mpv never answered")


class _IpcConnection:
    def __init__(self, path: str, timeout: float):
        if sys.platform == "win32":
            self._sock = None
            self._file = open(path, "r+b", buffering=0)  # noqa: SIM115 - closed in close()
        else:
            self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self._sock.settimeout(timeout)
            self._sock.connect(path)
            self._file = self._sock.makefile("rwb", buffering=0)

    def send(self, payload: dict) -> None:
        self._file.write(json.dumps(payload).encode("utf-8") + b"\n")

    def receive(self) -> dict:
        line = self._file.readline()
        if not line:
            raise OSError("mpv closed the connection")
        msg = json.loads(line)
        return msg if isinstance(msg, dict) else {}

    def close(self) -> None:
        try:
            self._file.close()
        finally:
            if self._sock is not None:
                self._sock.close()
