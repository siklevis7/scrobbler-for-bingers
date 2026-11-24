"""Offline backlog: scrobbles that couldn't be sent yet, kept on disk until they go through."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from .api import MAX_ITEMS_PER_WRITE, AuthError, BingersClient, BingersError, TransientError, describe_result

log = logging.getLogger(__name__)


class Backlog:
    def __init__(self, path: Path):
        self.path = path
        self.items: list[dict[str, Any]] = self._load()

    def __len__(self) -> int:
        return len(self.items)

    def add(self, items: list[dict[str, Any]]) -> None:
        # Items must carry watched_at so a late send still records the real watch time.
        self.items.extend(items)
        self._save()

    def flush(self, client: BingersClient) -> int:
        """Send what's waiting, 100 at a time. Returns how many items were sent."""
        sent = 0
        while self.items:
            batch = self.items[:MAX_ITEMS_PER_WRITE]
            try:
                results = client.scrobble(batch)
            except (TransientError, AuthError) as exc:
                log.info("Backlog: %d item(s) still waiting (%s)", len(self.items), exc)
                break
            except BingersError as exc:
                # The API rejected the request outright; keeping it would block everything behind it.
                log.error("Backlog: dropping %d item(s) Bingers rejected: %s", len(batch), exc)
                for item in batch:
                    log.error("  dropped: %s", item)
            else:
                for result in results:
                    log.info("Backlog sent: %s", describe_result(result))
                sent += len(batch)
            del self.items[: len(batch)]
            self._save()
        return sent

    def _load(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except (OSError, ValueError):
            log.warning("Backlog file %s is unreadable; starting empty", self.path)
            return []

    def _save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.items, indent=1), encoding="utf-8")
        os.replace(tmp, self.path)
