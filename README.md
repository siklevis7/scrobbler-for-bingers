# Bingers Scrobbler

Watch something in **VLC** or **mpv** on your computer, and it gets marked as watched on
[Bingers](https://bingers.app) automatically, so you never update episodes by hand.

It reads the file name (`The.Office.S02E03.720p.mkv`), finds the show on Bingers, follows your
playback, and marks the episode watched once you're past 80%.

> Inspired by [Media-Player-Scrobbler-for-Simkl](https://github.com/ByteTrix/Media-Player-Scrobbler-for-Simkl).
> The code here is written from scratch.

## Requirements

- Python 3.11 or newer
- A Bingers **Legend** or **Icon** plan. The Bingers API is only available on those plans.
  Subscribe in the app: Profile > Settings > Support Bingers.

## Install

```powershell
cd scrobbler-for-bingers
python -m venv .venv
.venv\Scripts\activate
pip install -e ".[dev]"
```

## Set up

### 1. Bingers token

Create a personal token at <https://bingers.app/integrations> (Personal tokens > Create,
choose **read + write**), then:

```powershell
bingers-scrobbler login
```

The token is saved in `%APPDATA%\bingers-scrobbler\credentials.json`. You can set the
`BINGERS_TOKEN` environment variable instead.

### 2. VLC

1. Tools > Preferences > at the bottom pick **Show settings: All**.
2. Interface > Main interfaces: tick **Web**.
3. Interface > Main interfaces > Lua: set a **Lua HTTP password**.
4. Restart VLC.
5. Put the same password in `%APPDATA%\bingers-scrobbler\config.toml` under `[players.vlc]`.

### 3. mpv (or mpv.net)

Add this line to `%APPDATA%\mpv\mpv.conf`:

```
input-ipc-server=\\.\pipe\mpv-pipe
```

### 4. Check and run

```powershell
bingers-scrobbler status
bingers-scrobbler match "Severance.S01E04.1080p.mkv"
bingers-scrobbler run
```

- `status` shows whether the token is set and whether each player can be reached.
- `match` shows how a file name would be matched, using a Bingers dry run that writes nothing.
- `run` keeps going until you press Ctrl+C. Logs go to `%APPDATA%\bingers-scrobbler\logs\`.

## How it decides something was watched

- It checks the players every 5 seconds.
- An item counts as watched when **both** are true:
  - you're past the **threshold** (80% by default), and
  - you actually played it for at least **min_watched_seconds** (5 minutes by default, or half
    the length for short files).
- Paused time and skipping ahead don't count toward the watched time.
- Each file is marked once. Bingers ignores repeats within 12 hours anyway.
- If you're offline, the mark is saved to `backlog.json` with the time you watched it, and
  it's sent later.

## When it picks the wrong show

Pin the title in `config.toml`:

```toml
[overrides]
"Doctor Who 2005" = "tvdb:78804"
```

The key is the title as it appears in the file name. The value can be `tvdb:…`, `imdb:…`,
`tmdb:show:…` / `tmdb:movie:…`, or a Bingers id.

## Project layout

```
src/bingers_scrobbler/
  cli.py          commands: login, run, match, status
  config.py       config.toml and the token file
  api.py          Bingers API client (search, scrobble, me)
  parser.py       file name -> show/movie, season, episode (guessit)
  matcher.py      parsed name -> Bingers title (search, cache, overrides)
  tracker.py      the loop: watched-time counting and threshold
  backlog.py      offline queue
  players/vlc.py  VLC web interface
  players/mpv.py  mpv JSON IPC
tests/            pytest suite (no network or players needed)
```

## Roadmap ideas

- Tray icon, and starting with Windows
- OAuth device-code login so other people can use it without a personal token
- More players: MPC-HC/MPC-BE (web interface), PotPlayer, and window-title fallback
- Anime absolute numbering, through `/titles/{ref}/episodes`
