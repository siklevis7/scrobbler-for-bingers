"""Command line: login, run, match, status, tray."""

from __future__ import annotations

import argparse
import getpass
import logging
import sys

from . import __version__
from .api import AuthError, BingersClient, BingersError, TransientError, describe_result
from .api import display_name as _who
from .backlog import Backlog
from .config import app_dir, config_path, load_config, load_token, save_token
from .history import History
from .logs import setup_logging
from .matcher import Matcher
from .parser import parse_filename
from .players import build_players
from .tracker import Tracker, build_items

log = logging.getLogger("bingers_scrobbler")


def _client_or_exit() -> BingersClient:
    token = load_token()
    if not token:
        print("No Bingers token yet. Run:  bingers-scrobbler login", file=sys.stderr)
        raise SystemExit(2)
    return BingersClient(token)


def cmd_login(_args: argparse.Namespace) -> int:
    print("Create a personal token at https://bingers.app/integrations")
    print("(Personal tokens > Create, choose 'read + write'). Needs the Legend or Icon plan.")
    token = getpass.getpass("Paste your token (input is hidden): ").strip()
    if not token:
        print("No token entered.")
        return 1
    if not token.startswith("bng_pat_"):
        print("Note: personal tokens usually start with 'bng_pat_'. Checking it anyway...")
    try:
        me = BingersClient(token).me()
    except AuthError as exc:
        print(f"Bingers refused that token: {exc}")
        print("Check that it's 'read + write' and that your account has the Legend or Icon plan.")
        return 1
    except BingersError as exc:
        print(f"Couldn't check the token: {exc}")
        return 1
    path = save_token(token)
    print(f"Signed in as {_who(me)}. Token saved to {path}")
    scopes = me.get("scopes")
    if scopes and not any("write" in str(s) for s in scopes):
        print("Warning: this token looks read-only, so it can't mark anything watched.")
    return 0


def cmd_run(_args: argparse.Namespace) -> int:
    config = load_config()
    client = _client_or_exit()
    try:
        me = client.me()
        log.info("Signed in to Bingers as %s", _who(me))
    except AuthError as exc:
        log.error("Bingers refused the token: %s. Run `bingers-scrobbler login` again.", exc)
        return 1
    except TransientError as exc:
        log.warning("Bingers isn't reachable right now (%s); scrobbles will wait in the backlog", exc)

    players = build_players(config)
    if not players:
        log.error("No players are enabled in %s", config.path)
        return 1
    data = app_dir()
    tracker = Tracker(
        players,
        client,
        Matcher(client, data / "match_cache.json", config.overrides),
        Backlog(data / "backlog.json"),
        config.scrobble,
        history=History(data / "history.jsonl"),
    )
    log.info(
        "Watching %s. Marks watched at %.0f%%. Press Ctrl+C to stop.",
        ", ".join(p.name for p in players),
        config.scrobble.threshold,
    )
    try:
        tracker.run_forever()
    except KeyboardInterrupt:
        log.info("Stopped.")
    return 0


def cmd_match(args: argparse.Namespace) -> int:
    media = parse_filename(args.filename)
    if media is None:
        print("Couldn't tell what this is from the name.")
        return 1
    print(f"Parsed:  {media.label()}  [{media.kind}]")
    token = load_token()
    if not token:
        print("(Run `bingers-scrobbler login` to also look it up on Bingers.)")
        return 0
    config = load_config()
    client = BingersClient(token)
    try:
        match = Matcher(client, app_dir() / "match_cache.json", config.overrides).resolve(media)
        if match is None:
            print("Bingers: no matching title. Add one under [overrides] in config.toml.")
            return 1
        print(f"Bingers: {match.name}" + (f" ({match.year})" if match.year else "") + f"  [{match.ref}]")
        for result in client.scrobble(build_items(media, match), dry_run=True):
            print(f"Dry run: {describe_result(result)}")
    except BingersError as exc:
        print(f"Bingers error: {exc}")
        return 1
    return 0


def cmd_status(_args: argparse.Namespace) -> int:
    config = load_config()
    print(f"Settings: {config_path()}")
    print(f"Token:    {'set' if load_token() else 'missing (run: bingers-scrobbler login)'}")
    print(f"Backlog:  {len(Backlog(app_dir() / 'backlog.json'))} item(s) waiting")
    for player in build_players(config):
        state = player.poll()
        if state is None:
            print(f"{player.name:>8}: not reachable or nothing playing")
        else:
            flag = "paused" if state.paused else "playing"
            print(f"{player.name:>8}: {flag} {state.file!r} at {state.progress:.0f}%")
    return 0


def cmd_tray(args: argparse.Namespace) -> int:
    from .tray import main as tray_main

    return tray_main(["--verbose"] if args.verbose else [])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bingers-scrobbler", description="Scrobble local playback to Bingers.")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    parser.add_argument("-v", "--verbose", action="store_true", help="more detailed logs")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("login", help="save your Bingers personal token").set_defaults(func=cmd_login)
    sub.add_parser("run", help="watch your players and scrobble").set_defaults(func=cmd_run)
    match = sub.add_parser("match", help="show how a file name would be matched (nothing is written)")
    match.add_argument("filename")
    match.set_defaults(func=cmd_match)
    sub.add_parser("status", help="show settings, token, backlog and player status").set_defaults(func=cmd_status)
    sub.add_parser("tray", help="run as a tray icon (the normal way on Windows)").set_defaults(func=cmd_tray)

    args = parser.parse_args(argv)
    if args.command == "run":
        setup_logging(args.verbose)
    return args.func(args)
