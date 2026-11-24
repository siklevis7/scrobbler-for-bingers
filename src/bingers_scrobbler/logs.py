"""Logging to %APPDATA%\\bingers-scrobbler\\logs, plus the console when there is one."""

from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

from .config import app_dir


def logs_dir() -> Path:
    path = app_dir() / "logs"
    path.mkdir(exist_ok=True)
    return path


def setup_logging(verbose: bool = False) -> None:
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", "%Y-%m-%d %H:%M:%S")
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if verbose else logging.INFO)

    file = RotatingFileHandler(logs_dir() / "scrobbler.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    file.setFormatter(fmt)
    root.addHandler(file)

    # The windowed .exe and pythonw have no console: sys.stdout is None there.
    if sys.stdout is not None:
        console = logging.StreamHandler(sys.stdout)
        console.setFormatter(fmt)
        root.addHandler(console)

    for noisy in ("urllib3", "rebulk", "PIL"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
