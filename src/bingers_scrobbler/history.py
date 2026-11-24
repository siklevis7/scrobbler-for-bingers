"""Local watch history: one JSON line per scrobble attempt, newest last."""

from __future__ import annotations

import json
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

MAX_LINES = 2000


class History:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()

    def add(self, what: str, result: str) -> None:
        entry = {"time": datetime.now().astimezone().isoformat(timespec="seconds"), "what": what, "result": result}
        with self._lock:
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
            self._trim()

    def recent(self, limit: int = 200) -> list[dict[str, Any]]:
        """Newest first."""
        with self._lock:
            lines = self._read_lines()
        entries = []
        for line in reversed(lines[-limit:]):
            try:
                entries.append(json.loads(line))
            except ValueError:
                continue
        return entries

    def _read_lines(self) -> list[str]:
        if not self.path.exists():
            return []
        return [line for line in self.path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def _trim(self) -> None:
        lines = self._read_lines()
        if len(lines) > MAX_LINES * 1.25:
            self.path.write_text("\n".join(lines[-MAX_LINES:]) + "\n", encoding="utf-8")
