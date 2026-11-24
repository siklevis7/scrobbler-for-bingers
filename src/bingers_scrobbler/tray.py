"""The tray app: an icon by the clock with a right-click menu, and small windows for settings.

Threads:
  main thread    Tkinter (all windows and dialogs)
  icon thread    pystray (the tray icon and its menu)
  worker thread  the Tracker loop (polls players, talks to Bingers)
Menu clicks arrive on the icon thread and hand any window work to the main thread via a queue.
"""

from __future__ import annotations

import argparse
import json
import logging
import queue
import sys
import threading
import tkinter as tk
import webbrowser
from typing import Callable

import pystray
from PIL import ImageTk
from pystray import Menu
from pystray import MenuItem as Item

from . import __version__, dialogs, winutil
from .api import AuthError, BingersClient, BingersError, TransientError, display_name
from .backlog import Backlog
from .config import app_dir, config_path, delete_token, load_config, load_token, save_token, set_value
from .history import History
from .icons import load_icon
from .logs import logs_dir, setup_logging
from .matcher import Matcher
from .players import build_players
from .tracker import (
    EVENT_AUTH,
    EVENT_ERROR,
    EVENT_QUEUED,
    EVENT_SCROBBLED,
    EVENT_UNMATCHED,
    Tracker,
)

log = logging.getLogger(__name__)

APP_TITLE = dialogs.APP_TITLE
REPO_URL = "https://github.com/siklevis7/scrobbler-for-bingers"
TOKEN_URL = "https://bingers.app/integrations"
PRESET_THRESHOLDS = (65, 80, 90)

VLC_HELP = (
    "To let the scrobbler see what VLC is playing, turn on VLC's web interface:\n\n"
    "1. In VLC, open Tools > Preferences.\n"
    "2. Bottom left, under 'Show settings', click 'All'.\n"
    "3. Click Interface > Main interfaces, and tick 'Web'.\n"
    "4. Expand Main interfaces, click 'Lua', and type a password under 'Lua HTTP'.\n"
    "5. Click Save, then close and reopen VLC.\n\n"
    "Then type the same password here:"
)


class TrayApp:
    def __init__(self) -> None:
        self.config = load_config()
        data = app_dir()
        self.backlog = Backlog(data / "backlog.json")
        self.history = History(data / "history.jsonl")
        self.cache_path = data / "match_cache.json"

        self.client: BingersClient | None = None
        self.tracker: Tracker | None = None
        self.worker: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.account: str | None = None
        self.problem: str | None = None  # shown as the status while something needs attention

        self.ui_queue: queue.Queue[Callable[[], None]] = queue.Queue()
        self.root = tk.Tk()
        self.root.withdraw()
        self.root.title(APP_TITLE)
        self._icon_image = load_icon()
        self._tk_icon = ImageTk.PhotoImage(self._icon_image.resize((64, 64)))
        self.root.iconphoto(True, self._tk_icon)  # every window gets the app icon
        self._paused_image = load_icon(paused=True)
        self.icon = pystray.Icon("bingers_scrobbler", self._icon_image, APP_TITLE, menu=self._build_menu())

    # -- life cycle ----------------------------------------------------------

    def run(self) -> None:
        threading.Thread(target=self.icon.run, name="tray-icon", daemon=True).start()
        self.root.after(100, self._pump)
        self.root.after(5000, self._refresh)
        if load_token():
            self._start_tracker()
        else:
            self._ui(self._first_run)
        self.root.mainloop()

    def _exit(self) -> None:
        log.info("Exiting")
        self._stop_tracker()
        self.icon.stop()
        self._ui(self.root.quit)

    def _ui(self, fn: Callable[[], None]) -> None:
        """Run fn on the Tk thread (menu clicks arrive on the icon thread)."""
        self.ui_queue.put(fn)

    def _pump(self) -> None:
        try:
            while True:
                fn = self.ui_queue.get_nowait()
                try:
                    fn()
                except Exception:
                    log.exception("UI action failed")
        except queue.Empty:
            pass
        self.root.after(100, self._pump)

    def _refresh(self) -> None:
        self._update_icon()
        self.root.after(5000, self._refresh)

    def _update_icon(self) -> None:
        paused = bool(self.tracker and self.tracker.paused)
        try:
            self.icon.icon = self._paused_image if paused or not self.tracker else self._icon_image
            self.icon.title = f"{APP_TITLE} - {self._status()}"[:127]
            self.icon.update_menu()
        except Exception:  # the icon may not be visible yet right at start-up
            log.debug("Tray icon update skipped", exc_info=True)

    # -- tracker -------------------------------------------------------------

    def _start_tracker(self) -> None:
        self._stop_tracker()
        token = load_token()
        if not token:
            return
        self.stop_event = threading.Event()
        self.worker = threading.Thread(target=self._tracker_main, args=(token, self.stop_event), daemon=True)
        self.worker.start()

    def _stop_tracker(self) -> None:
        if self.worker and self.worker.is_alive():
            self.stop_event.set()
            self.worker.join(timeout=self.config.scrobble.poll_interval + 20)
        self.worker = None
        self.tracker = None

    def _tracker_main(self, token: str, stop: threading.Event) -> None:
        client = BingersClient(token)
        try:
            self.account = display_name(client.me())
            self.problem = None
            log.info("Signed in to Bingers as %s", self.account)
        except AuthError as exc:
            log.error("Bingers refused the token: %s", exc)
            self.problem = "Token refused - sign in again"
            self._notify("Bingers refused your token. Right-click the tray icon > Bingers > Sign In.")
            self._update_icon()
            return
        except TransientError as exc:
            log.warning("Bingers isn't reachable right now (%s); scrobbles will wait in the backlog", exc)
        self.client = client
        self.tracker = Tracker(
            build_players(self.config),
            client,
            Matcher(client, self.cache_path, self.config.overrides),
            self.backlog,
            self.config.scrobble,
            history=self.history,
            on_event=self._on_event,
        )
        self._update_icon()
        log.info("Tracking started (threshold %.0f%%)", self.config.scrobble.threshold)
        self.tracker.run_forever(stop)

    def _on_event(self, kind: str, message: str) -> None:
        if kind == EVENT_AUTH:
            self.problem = "Token refused - sign in again"
        if kind in (EVENT_SCROBBLED, EVENT_QUEUED, EVENT_UNMATCHED, EVENT_ERROR, EVENT_AUTH):
            self._notify(message)
        self._update_icon()

    def _notify(self, message: str) -> None:
        if not self.config.app.notifications:
            return
        try:
            self.icon.notify(message, APP_TITLE)
        except Exception:
            log.debug("Notification failed", exc_info=True)

    # -- status --------------------------------------------------------------

    def _status(self) -> str:
        if not load_token():
            return "Not signed in"
        if self.problem:
            return self.problem
        if self.tracker is None:
            return "Starting"
        if self.tracker.paused:
            return "Paused"
        if self.tracker.now_playing:
            return f"Watching {self.tracker.now_playing}"
        return "Running"

    # -- menu ----------------------------------------------------------------

    def _build_menu(self) -> Menu:
        def threshold_item(value: int) -> Item:
            label = f"{value}%" + (" (Default)" if value == 80 else "")
            return Item(
                label,
                lambda: self._set_threshold(value),
                checked=lambda _i: self.config.scrobble.threshold == value,
                radio=True,
            )

        def custom_label(_i: Item) -> str:
            t = self.config.scrobble.threshold
            return "Custom..." if t in PRESET_THRESHOLDS else f"Custom ({t:g}%)..."

        return Menu(
            Item(APP_TITLE, None, enabled=False),
            Item(lambda _i: f"Status: {self._status()}", None, enabled=False),
            Menu.SEPARATOR,
            Item(
                lambda _i: "Resume Tracking" if self.tracker and self.tracker.paused else "Pause Tracking",
                self._toggle_pause,
                enabled=lambda _i: self.tracker is not None,
            ),
            Item(
                "Scrobbling",
                Menu(
                    Item(
                        "Retry Last Scrobble",
                        self._retry_last,
                        enabled=lambda _i: bool(self.tracker and self.tracker.last_scrobble),
                    ),
                    Item(
                        lambda _i: f"Sync Backlog Now ({len(self.backlog)} waiting)",
                        self._sync_backlog,
                        enabled=lambda _i: len(self.backlog) > 0 and self.tracker is not None,
                    ),
                    Item(
                        "Completion Threshold",
                        Menu(
                            *(threshold_item(v) for v in PRESET_THRESHOLDS),
                            Menu.SEPARATOR,
                            Item(
                                custom_label,
                                lambda: self._ui(self._custom_threshold),
                                checked=lambda _i: self.config.scrobble.threshold not in PRESET_THRESHOLDS,
                                radio=True,
                            ),
                        ),
                    ),
                    Menu.SEPARATOR,
                    Item(
                        "Notifications",
                        self._toggle_notifications,
                        checked=lambda _i: self.config.app.notifications,
                    ),
                    Item("Open Watch History", lambda: self._ui(self._show_history)),
                ),
            ),
            Item(
                "Bingers",
                Menu(
                    Item(
                        lambda _i: f"Signed in as {self.account}" if self.account else "Not signed in",
                        None,
                        enabled=False,
                    ),
                    Item(
                        lambda _i: "Change Token..." if load_token() else "Sign In...",
                        lambda: self._ui(self._sign_in),
                    ),
                    Item("Sign Out", lambda: self._ui(self._sign_out), enabled=lambda _i: bool(load_token())),
                    Menu.SEPARATOR,
                    Item("Open Bingers", lambda: webbrowser.open("https://bingers.app")),
                    Item("Manage Tokens", lambda: webbrowser.open(TOKEN_URL)),
                ),
            ),
            Item(
                "Players",
                Menu(
                    Item("VLC", self._toggle_vlc, checked=lambda _i: self.config.vlc.enabled),
                    Item("Set VLC Password...", lambda: self._ui(self._set_vlc_password)),
                    Menu.SEPARATOR,
                    Item("mpv", self._toggle_mpv, checked=lambda _i: self.config.mpv.enabled),
                    Menu.SEPARATOR,
                    Item("Player Setup Help", lambda: webbrowser.open(f"{REPO_URL}#set-up")),
                ),
            ),
            Item(
                "Settings",
                Menu(
                    Item(
                        "Start with Windows",
                        self._toggle_autostart,
                        checked=lambda _i: winutil.autostart_enabled(),
                        visible=sys.platform == "win32",
                    ),
                    Item("Open Settings File", lambda: winutil.open_path(config_path())),
                    Item("Open Logs Folder", lambda: winutil.open_path(logs_dir())),
                ),
            ),
            Item(
                "More",
                Menu(
                    Item("Check for Updates", lambda: webbrowser.open(f"{REPO_URL}/releases/latest")),
                    Item("Project Page", lambda: webbrowser.open(REPO_URL)),
                    Item("About", lambda: self._ui(self._about)),
                ),
            ),
            Menu.SEPARATOR,
            Item("Exit", self._exit),
        )

    # -- menu actions (icon thread) --------------------------------------------

    def _toggle_pause(self) -> None:
        if self.tracker:
            self.tracker.paused = not self.tracker.paused
            log.info("Tracking %s", "paused" if self.tracker.paused else "resumed")
        self._update_icon()

    def _retry_last(self) -> None:
        tracker = self.tracker
        if tracker:
            threading.Thread(target=lambda: (tracker.retry_last(), self._update_icon()), daemon=True).start()

    def _sync_backlog(self) -> None:
        tracker = self.tracker
        if not tracker:
            return

        def work() -> None:
            sent, waiting = tracker.flush_backlog()
            self._notify(f"Backlog: sent {sent}, {waiting} still waiting")
            self._update_icon()

        threading.Thread(target=work, daemon=True).start()

    def _set_threshold(self, value: float) -> None:
        self.config.scrobble.threshold = float(value)
        set_value("scrobble", "threshold", value)
        log.info("Completion threshold set to %g%%", value)
        self._update_icon()

    def _toggle_notifications(self) -> None:
        self.config.app.notifications = not self.config.app.notifications
        set_value("app", "notifications", self.config.app.notifications)
        self._update_icon()

    def _toggle_vlc(self) -> None:
        self.config.vlc.enabled = not self.config.vlc.enabled
        set_value("players.vlc", "enabled", self.config.vlc.enabled)
        self._apply_players()

    def _toggle_mpv(self) -> None:
        self.config.mpv.enabled = not self.config.mpv.enabled
        set_value("players.mpv", "enabled", self.config.mpv.enabled)
        self._apply_players()

    def _apply_players(self) -> None:
        if self.tracker:
            self.tracker.set_players(build_players(self.config))
        self._update_icon()

    def _toggle_autostart(self) -> None:
        try:
            winutil.set_autostart(not winutil.autostart_enabled())
        except OSError as exc:
            log.error("Couldn't change Start with Windows: %s", exc)
            self._ui(lambda: dialogs.error(self.root, f"Couldn't change 'Start with Windows':\n{exc}"))
        self._update_icon()

    # -- windows (Tk thread) ---------------------------------------------------

    def _first_run(self) -> None:
        dialogs.info(
            self.root,
            "Welcome to Bingers Scrobbler!\n\n"
            "It runs in the background (look for its icon by the clock) and marks what you "
            "watch in VLC or mpv as watched on Bingers.\n\n"
            "First, sign in with a Bingers personal token.",
        )
        if self._sign_in() and self.config.vlc.enabled and not self.config.vlc.password:
            self._set_vlc_password()
        if sys.platform == "win32" and not winutil.autostart_enabled():
            if dialogs.confirm(self.root, "Start Bingers Scrobbler automatically when you sign in to Windows?"):
                try:
                    winutil.set_autostart(True)
                except OSError as exc:
                    dialogs.error(self.root, f"Couldn't turn on 'Start with Windows':\n{exc}")
        self._update_icon()

    def _sign_in(self) -> bool:
        message = (
            "Paste your Bingers personal token.\n\n"
            "To create one: open the token page (button below), sign in, go to Personal tokens > "
            "Create, and choose 'read + write'. It starts with bng_pat_.\n\n"
            "Needs the Bingers Legend or Icon plan."
        )
        while True:
            token = dialogs.ask_string(
                self.root,
                "Sign in",
                message,
                secret=True,
                link=("Open token page", TOKEN_URL),
            )
            if not token:
                return False
            try:
                me = BingersClient(token).me()
            except AuthError as exc:
                dialogs.error(
                    self.root,
                    f"Bingers refused that token:\n{exc}\n\n"
                    "Check that it's 'read + write' and that your account has the Legend or Icon plan.",
                )
                continue
            except BingersError as exc:
                dialogs.error(self.root, f"Couldn't check the token right now:\n{exc}")
                return False
            save_token(token)
            self.account = display_name(me)
            self.problem = None
            dialogs.info(self.root, f"Signed in as {self.account}.")
            self._start_tracker()
            self._update_icon()
            return True

    def _sign_out(self) -> None:
        if not dialogs.confirm(self.root, "Sign out? The scrobbler stops until you sign in again."):
            return
        self._stop_tracker()
        delete_token()
        self.account = None
        self.problem = None
        self._update_icon()

    def _set_vlc_password(self) -> None:
        password = dialogs.ask_string(
            self.root, "VLC password", VLC_HELP, secret=True, initial=self.config.vlc.password
        )
        if password is None:
            return
        self.config.vlc.password = password
        set_value("players.vlc", "password", password)
        self._apply_players()
        if password:
            state = build_players(self.config)[0].poll() if self.config.vlc.enabled else None
            if state is not None:
                dialogs.info(self.root, f"Connected to VLC. It's playing:\n{state.file}")
            else:
                dialogs.info(
                    self.root,
                    "Password saved.\n\nTo check it: play a video in VLC, then look at the tray icon's "
                    "status. If it never shows 'Watching ...', make sure VLC was restarted after you "
                    "turned on 'Web', and that the passwords match.",
                )

    def _custom_threshold(self) -> None:
        while True:
            text = dialogs.ask_string(
                self.root,
                "Completion threshold",
                "Mark as watched after this percentage of the file (50-100):",
                initial=f"{self.config.scrobble.threshold:g}",
            )
            if text is None:
                return
            try:
                value = float(text.rstrip("%"))
            except ValueError:
                value = -1
            if 50 <= value <= 100:
                self._set_threshold(int(value) if value.is_integer() else value)
                return
            dialogs.error(self.root, "Please enter a number from 50 to 100.")

    def _show_history(self) -> None:
        dialogs.show_history(
            self.root,
            self.history.recent(300),
            open_file=lambda: winutil.open_path(self.history.path) if self.history.path.exists() else None,
        )

    def _about(self) -> None:
        dialogs.info(
            self.root,
            f"{APP_TITLE} {__version__}\n\n"
            "Marks what you watch in VLC and mpv as watched on Bingers.\n"
            "An unofficial, open-source project (GPL-3.0).\n\n"
            f"{REPO_URL}",
        )


def _self_test(out_path: str) -> int:
    """Used by the build to prove the packaged app can parse names and draw its icon."""
    from .parser import parse_filename

    samples = ["Ozark_S04E12_Trouble_The_Water_720p_NF_WEB_DL_x265.mkv", "Dune.Part.Two.2024.2160p.mkv"]
    result = {
        "version": __version__,
        "parsed": [m.label() if (m := parse_filename(s)) else None for s in samples],
        "icon": list(load_icon().size),
    }
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bingers-scrobbler-tray")
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("--self-test", metavar="OUTFILE", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    if args.self_test:
        return _self_test(args.self_test)

    setup_logging(args.verbose)
    if not winutil.acquire_single_instance():
        log.info("Another copy is already running; exiting")
        root = tk.Tk()
        root.withdraw()
        dialogs.info(root, "Bingers Scrobbler is already running.\nLook for its icon by the clock.")
        root.destroy()
        return 0

    log.info("%s %s starting", APP_TITLE, __version__)
    try:
        TrayApp().run()
    except Exception:
        log.exception("The tray app crashed")
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
