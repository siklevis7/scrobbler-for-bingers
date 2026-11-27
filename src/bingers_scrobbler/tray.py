"""The tray app: an icon by the clock with a right-click menu, and small windows for settings.

Threads:
  main thread    Tkinter (all windows and dialogs)
  icon thread    pystray (the tray icon and its menu)
  worker thread  the Tracker loop (polls players, talks to Bingers)
Menu clicks arrive on the icon thread and hand any window work to the main thread via a queue.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta
import json
import logging
import queue
import sys
import threading
import tkinter as tk
import webbrowser
from pathlib import Path
from typing import Callable

import pystray
from PIL import ImageTk
from pystray import Menu
from pystray import MenuItem as Item

from . import __version__, dialogs, insights, updater, winutil
from .api import AuthError, BingersClient, BingersError, TransientError, display_name
from .backlog import Backlog
from .config import app_dir, config_path, delete_token, load_config, load_token, save_token, set_value
from .history import History
from .icons import load_icon
from .logs import logs_dir, setup_logging
from .matcher import Matcher
from .players import build_players
from .stats import WatchStats, due_week, week_bounds
from .tracker import (
    EVENT_AUTH,
    EVENT_ERROR,
    EVENT_FINISHED,
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
UPDATE_FIRST_CHECK_MS = 60 * 1000  # a minute after start, so start-up stays quick
UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
LIBRARY_REFRESH_MS = 30 * 60 * 1000  # the watch list and the weekly summary check
WATCH_SECTIONS = ("watch_next", "collecting_dust")
WATCH_MENU_SIZE = 12

VLC_HELP = (
    "To let the scrobbler see what VLC is playing, turn on VLC's web interface:\n\n"
    "1. In VLC, open Tools > Preferences.\n"
    "2. Bottom left, under 'Show settings', click 'All'.\n"
    "3. Click Interface > Main interfaces, and tick 'Web'.\n"
    "4. Expand Main interfaces, click 'Lua', and type a password under 'Lua HTTP'.\n"
    "5. Click Save, then close and reopen VLC.\n\n"
    "Then type the same password here:"
)


class _TrayIcon(pystray.Icon):
    """pystray icon that builds its menu only at the moment it opens.

    pystray rebuilds the menu whenever update_menu() is called. Doing that from another
    thread while the menu is open destroys it under Windows' feet, which leaves highlights
    stuck on submenus. Here the menu is rebuilt only on right-click, on the icon's own
    thread, just before Windows shows it, so the status and check marks are always fresh.
    """

    _WM_RBUTTONUP = 0x0205
    _WM_NULL = 0x0000

    def _on_notify(self, wparam, lparam):  # noqa: ANN001 - pystray's signature
        if sys.platform == "win32" and lparam == self._WM_RBUTTONUP:
            self._update_menu()
        result = super()._on_notify(wparam, lparam)
        if sys.platform == "win32" and lparam == self._WM_RBUTTONUP:
            # Microsoft's advice after TrackPopupMenu: lets the menu close cleanly
            # when you click elsewhere.
            from pystray._util import win32

            win32.PostMessage(self._hwnd, self._WM_NULL, 0, 0)
        return result


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
        self.update_release: updater.Release | None = None
        self.update_file: Path | None = None  # a downloaded installer waiting to be run
        self.update_busy = threading.Lock()
        self.portable_notified: str | None = None
        self.watch: list[insights.WatchItem] = []  # "What to Watch", refreshed in the background
        self.watch_total = 0
        self.watch_loaded = False
        self.library_busy = threading.Lock()
        self.stats = WatchStats(data / "weekly_stats.json")

        self.ui_queue: queue.Queue[Callable[[], None]] = queue.Queue()
        self.root = tk.Tk()
        self.root.withdraw()
        self.root.title(APP_TITLE)
        self._icon_image = load_icon()
        self._tk_icon = ImageTk.PhotoImage(self._icon_image.resize((64, 64)))
        self.root.iconphoto(True, self._tk_icon)  # every window gets the app icon
        self._paused_image = load_icon(paused=True)
        self.icon = _TrayIcon("bingers_scrobbler", self._icon_image, APP_TITLE, menu=self._build_menu())

    # -- life cycle ----------------------------------------------------------

    def run(self) -> None:
        threading.Thread(target=self.icon.run, name="tray-icon", daemon=True).start()
        self.root.after(100, self._pump)
        self.root.after(5000, self._refresh)
        self.root.after(UPDATE_FIRST_CHECK_MS, self._auto_update_tick)
        self.root.after(20 * 1000, self._library_tick)
        old = updater.note_version(app_dir() / "app_state.json")
        if old:
            log.info("Updated from %s to %s", old, __version__)
            self.root.after(3000, lambda: self._notify(f"Updated to version {__version__}.", force=True))
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
            image = self._paused_image if paused or not self.tracker else self._icon_image
            if self.icon.icon is not image:  # only touch the tray when something changed
                self.icon.icon = image
            title = f"{APP_TITLE} - {self._status()}"[:127]
            if self.icon.title != title:
                self.icon.title = title
            if sys.platform != "win32":  # Windows rebuilds the menu on right-click instead
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
        self.client = None  # signed out or a new token: background refreshes stop using the old one

    def _tracker_main(self, token: str, stop: threading.Event) -> None:
        try:
            self._run_tracker(token, stop)
        except Exception as exc:  # never sit on "Starting" without saying why
            log.exception("The tracker stopped")
            self.problem = f"Stopped by an error - see the log ({exc.__class__.__name__})"
            self._notify("Bingers Scrobbler hit an error and stopped tracking. Settings > Open Logs Folder shows why.")
            self._update_icon()

    def _run_tracker(self, token: str, stop: threading.Event) -> None:
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
        except Exception as exc:  # anything unexpected: still track, and say so in the log
            log.exception("Couldn't check the account with Bingers (%s); tracking anyway", exc)
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
        self.tracker.up_next = self.config.app.up_next
        self.tracker.suggest = self.config.app.suggestions
        self._update_icon()
        log.info("Tracking started (threshold %.0f%%)", self.config.scrobble.threshold)
        self.tracker.run_forever(stop)

    def _on_event(self, kind: str, message: str) -> None:
        if kind == EVENT_AUTH:
            self.problem = "Token refused - sign in again"
        if kind in (EVENT_SCROBBLED, EVENT_QUEUED, EVENT_UNMATCHED, EVENT_ERROR, EVENT_AUTH, EVENT_FINISHED):
            self._notify(message)
        if kind == EVENT_SCROBBLED:
            self._start_library_refresh(summary=False)  # the next episode moved
        self._update_icon()

    def _notify(self, message: str, force: bool = False) -> None:
        """Show a Windows notification. `force` shows it even when notifications are off
        (for answers to something the user just asked for)."""
        if not (self.config.app.notifications or force):
            return
        try:
            # Windows cuts notifications at 255 characters; end with an ellipsis instead.
            text = message if len(message) <= 250 else message[:247].rstrip() + "..."
            self.icon.notify(text, APP_TITLE)
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
            Item(
                lambda _i: f"Install Update ({self.update_release.version})" if self.update_release else "Install Update",
                lambda: self._ui(self._install_update),
                visible=lambda _i: self.update_file is not None,
            ),
            Menu.SEPARATOR,
            Item(
                lambda _i: "Resume Tracking" if self.tracker and self.tracker.paused else "Pause Tracking",
                self._toggle_pause,
                enabled=lambda _i: self.tracker is not None,
            ),
            Item("What to Watch", Menu(self._watch_menu_items)),
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
                    Item("This Week's Summary", self._show_week),
                    Menu.SEPARATOR,
                    Item(
                        "Show Next Episode After a Mark",
                        lambda: self._toggle_app("up_next"),
                        checked=lambda _i: self.config.app.up_next,
                    ),
                    Item(
                        "Suggest Shows When I Finish One",
                        lambda: self._toggle_app("suggestions"),
                        checked=lambda _i: self.config.app.suggestions,
                    ),
                    Item(
                        "Weekly Summary on Sundays",
                        lambda: self._toggle_app("weekly_summary"),
                        checked=lambda _i: self.config.app.weekly_summary,
                    ),
                ),
            ),
            Item(
                "Bingers",
                Menu(
                    Item(
                        lambda _i: f"Signed in as {self.account}"
                        if self.account
                        else ("Signed in (checking account...)" if load_token() else "Not signed in"),
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
                    Item(
                        lambda _i: "Checking for Updates..." if self.update_busy.locked() else "Check for Updates",
                        lambda: self._start_update_check(manual=True),
                        enabled=lambda _i: not self.update_busy.locked(),
                    ),
                    Item(
                        "Check for Updates Automatically",
                        self._toggle_check_updates,
                        checked=lambda _i: self.config.app.check_updates,
                    ),
                    Menu.SEPARATOR,
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

    def _toggle_app(self, key: str) -> None:
        value = not getattr(self.config.app, key)
        setattr(self.config.app, key, value)
        set_value("app", key, value)
        if self.tracker:
            self.tracker.up_next = self.config.app.up_next
            self.tracker.suggest = self.config.app.suggestions
        self._update_icon()

    # -- what to watch and the weekly summary ------------------------------------

    def _watch_menu_items(self) -> list[Item]:
        """Built each time the menu opens, from the list fetched in the background."""
        if not load_token():
            return [Item("Sign in to see your watch list", None, enabled=False)]
        if not self.watch_loaded:
            return [Item("Loading your watch list...", None, enabled=False)]
        items: list[Item] = []
        if not self.watch:
            items.append(Item("Nothing waiting: you're all caught up", None, enabled=False))
        for entry in self.watch:
            items.append(Item(entry.label(), self._watch_action(entry)))
        if self.watch_total > len(self.watch):
            items.append(Item(f"...and {self.watch_total - len(self.watch)} more", None, enabled=False))
        items += [
            Menu.SEPARATOR,
            Item("Open Bingers", lambda: webbrowser.open("https://bingers.app")),
            Item("Refresh", lambda: self._start_library_refresh(summary=False)),
        ]
        return items

    def _watch_action(self, entry: insights.WatchItem) -> Callable[[], None]:
        return lambda: self._start_watch_details(entry)

    def _library_tick(self) -> None:
        self._start_library_refresh(summary=True)
        self.root.after(LIBRARY_REFRESH_MS, self._library_tick)

    def _start_library_refresh(self, summary: bool) -> None:
        threading.Thread(target=self._library_refresh, args=(summary,), name="library", daemon=True).start()

    def _library_refresh(self, summary: bool) -> None:
        """Runs on its own thread: fetch the watch list; on schedule, the weekly summary."""
        client = self.client
        if client is None or not self.library_busy.acquire(blocking=False):
            return
        try:
            try:
                data = client.watchlist(limit=WATCH_MENU_SIZE)
                self.watch = insights.watch_items(data, WATCH_SECTIONS, WATCH_MENU_SIZE)
                sections = data.get("sections") or {}
                self.watch_total = sum(int((sections.get(k) or {}).get("count") or 0) for k in WATCH_SECTIONS)
                self.watch_loaded = True
            except BingersError as exc:
                log.info("Couldn't load the watch list (%s)", exc)
            if summary and self.config.app.weekly_summary:
                self._maybe_weekly_summary(client)
        except Exception:
            log.exception("Library refresh failed")
        finally:
            self.library_busy.release()
            self._update_icon()

    def _maybe_weekly_summary(self, client: BingersClient) -> None:
        now = datetime.now().astimezone()
        week = due_week(now, self.stats.last_shown)
        if week is None:
            return
        if self.stats.last_shown is None and week[1] <= now - timedelta(days=1):
            # First run: start from this week rather than greeting you with an old summary.
            self.stats.last_shown = week[0].date().isoformat()
            self.stats.save()
            return
        try:
            self.stats.sync(client)
        except BingersError as exc:
            log.info("Couldn't load your history for the weekly summary (%s)", exc)
            return
        start, end = week
        title = "This week" if end > now else "Last week"
        text = self.stats.describe(start, end, title)
        self.stats.last_shown = start.date().isoformat()
        self.stats.save()
        log.info("Weekly summary: %s", text.replace("\n", " "))
        if not self.stats.summary(start, end).empty:
            self._notify(text, force=True)

    def _show_week(self) -> None:
        client = self.client
        if client is None:
            self._ui(lambda: dialogs.info(self.root, "Sign in first to see your weekly summary."))
            return

        def work() -> None:
            try:
                with self.library_busy:
                    self.stats.sync(client)
                now = datetime.now().astimezone()
                start, end = week_bounds(now)
                text = (
                    self.stats.describe(start, end, "This week so far")
                    + "\n\n"
                    + self.stats.describe(start - timedelta(days=7), start, "Last week")
                )
            except Exception as exc:
                log.warning("Weekly summary failed: %s", exc)
                text = f"Couldn't load your history from Bingers right now:\n{exc}"
            self._ui(lambda: dialogs.message(self.root, "Your week", text))

        threading.Thread(target=work, name="weekly", daemon=True).start()

    def _start_watch_details(self, entry: insights.WatchItem) -> None:
        client = self.client

        def work() -> None:
            lines = []
            if entry.next_code:
                nxt = f"Next: {entry.next_code}" + (f" · {entry.next_title}" if entry.next_title else "")
                if entry.next_aired:
                    nxt += f" (aired {entry.next_aired[:10]})"
                lines.append(nxt)
            try:
                details = client.title(entry.id) if client else {}
                where = insights.where_to_watch(details)
                lines.append(where or "No streaming info for your country.")
                overview = str(details.get("overview") or "").strip()
                if overview:
                    lines.append("")
                    lines.append(overview[:400] + ("..." if len(overview) > 400 else ""))
            except Exception as exc:
                lines.append(f"(Couldn't load where to watch it: {exc})")
            links = [("Open on Bingers", entry.url)] if entry.url else []
            self._ui(lambda: dialogs.message(self.root, entry.name, "\n".join(lines), links))

        threading.Thread(target=work, name="watch-details", daemon=True).start()

    def _toggle_check_updates(self) -> None:
        self.config.app.check_updates = not self.config.app.check_updates
        set_value("app", "check_updates", self.config.app.check_updates)
        self._update_icon()

    # -- updates -------------------------------------------------------------

    def _auto_update_tick(self) -> None:
        if self.config.app.check_updates and self.update_file is None:
            self._start_update_check(manual=False)
        self.root.after(UPDATE_INTERVAL_MS, self._auto_update_tick)

    def _start_update_check(self, manual: bool) -> None:
        if self.update_busy.locked():
            return
        threading.Thread(target=self._update_check, args=(manual,), name="update-check", daemon=True).start()

    def _update_check(self, manual: bool) -> None:
        """Runs on its own thread: ask GitHub, download if newer, then offer to install."""
        if not self.update_busy.acquire(blocking=False):
            return
        try:
            self._run_update_check(manual)
        except Exception:
            log.exception("Update check crashed")
        finally:
            self.update_busy.release()
            self._update_icon()

    def _run_update_check(self, manual: bool) -> None:
        mode = updater.install_mode()
        try:
            release = updater.check_latest(mode=mode)
        except updater.UpdateError as exc:
            log.warning("Update check failed: %s", exc)
            if manual:
                text = f"Couldn't check for updates:\n{exc}"  # exc is gone once the except block ends
                self._ui(lambda: self._update_failed(text))
            return

        if not updater.is_newer(release.version):
            log.info("Update check: %s is the latest version", __version__)
            if manual:
                self._notify(f"You have the latest version ({__version__}).", force=True)
            return

        log.info("Update check: version %s is available (%s copy)", release.version, mode)
        self.update_release = release

        if mode == updater.MODE_SOURCE:
            self._notify(
                f"Version {release.version} is out. You're running from source: "
                "update with git pull, then pip install -e .",
                force=manual,
            )
            if manual:
                webbrowser.open(release.page_url)
            return

        self._notify(f"Version {release.version} is out. Downloading it now...", force=manual)
        folder = updater.downloads_dir() if mode == updater.MODE_PORTABLE else app_dir() / "updates"
        try:
            path = updater.download(release, folder)
        except updater.UpdateError as exc:
            log.warning("Update download failed: %s", exc)
            if manual:
                text = f"Couldn't download version {release.version}:\n{exc}"
                self._ui(lambda: self._update_failed(text))
            else:
                self._notify(
                    f"Version {release.version} is out, but the download failed. "
                    "Try More > Check for Updates."
                )
            return
        log.info("Downloaded %s", path)

        if mode == updater.MODE_PORTABLE:
            # Once per version unless you asked: the daily check mustn't nag or open windows.
            if manual or self.portable_notified != release.version:
                self.portable_notified = release.version
                self._notify(
                    f"Version {release.version} was saved to your Downloads folder as {path.name}. "
                    "Exit the scrobbler, then unzip it over your current copy.",
                    force=True,
                )
            if manual:
                winutil.open_path(path.parent)
            return

        updater.clean_old(folder, keep=path)
        self.update_file = path
        self._update_icon()
        if manual:
            self._ui(self._install_update)
        else:
            self._notify(
                f"Version {release.version} is ready. Right-click the tray icon and choose Install Update.",
                force=True,
            )

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
            text = f"Couldn't change 'Start with Windows':\n{exc}"
            self._ui(lambda: dialogs.error(self.root, text))
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
            self.stats.path.unlink(missing_ok=True)
            self.stats = WatchStats(self.stats.path)
            self.watch, self.watch_loaded = [], False
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

    def _update_failed(self, message: str) -> None:
        if dialogs.confirm(self.root, f"{message}\n\nOpen the download page instead?"):
            webbrowser.open(updater.RELEASES_PAGE)

    def _install_update(self) -> None:
        path, release = self.update_file, self.update_release
        if path is None or release is None:
            return
        if not path.exists():  # cleaned up meanwhile: fetch it again
            self.update_file = None
            self._start_update_check(manual=True)
            return
        watching = self.tracker.now_playing if self.tracker else None
        message = (
            f"Version {release.version} is downloaded (you have {__version__}).\n\n"
            "Install it now? The scrobbler closes for a few seconds and starts again by itself. "
            "Your sign-in, settings and history are kept."
        )
        if watching:
            message += (
                f"\n\nYou're watching {watching}. Its progress so far will be lost, so you may "
                "prefer to install when it's done (Install Update stays in the menu)."
            )
        if not dialogs.confirm(self.root, message):
            return
        try:
            updater.start_installer(path)
        except OSError as exc:
            log.error("Couldn't start the installer: %s", exc)
            dialogs.error(self.root, f"Couldn't start the installer:\n{exc}\n\nIt's saved at:\n{path}")
            return
        log.info("Installer started; exiting so it can replace the files")
        self._exit()

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
