"""Media player readers. Each one answers: what file is open, where are we, is it paused?"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from ..config import Config


@dataclass(frozen=True)
class PlaybackState:
    player: str
    file: str  # full path when the player gives one, otherwise the file name
    position: float  # seconds
    duration: float  # seconds
    paused: bool

    @property
    def progress(self) -> float:
        """Percent of the file reached, 0-100."""
        if self.duration <= 0:
            return 0.0
        return max(0.0, min(100.0, self.position / self.duration * 100.0))


class Player(Protocol):
    name: str

    def poll(self) -> PlaybackState | None:
        """Current playback, or None if the player isn't running or has nothing loaded."""
        ...


def build_players(config: Config) -> list[Player]:
    from .mpv import MpvPlayer
    from .vlc import VlcPlayer

    players: list[Player] = []
    if config.vlc.enabled:
        players.append(VlcPlayer(config.vlc.host, config.vlc.port, config.vlc.password))
    if config.mpv.enabled:
        players.append(MpvPlayer(config.mpv.ipc_path))
    return players
