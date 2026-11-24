# Bingers Scrobbler

Watch something in **VLC** or **mpv** on your computer, and it gets marked as watched on
[Bingers](https://bingers.app) automatically, so you never update episodes by hand.

It sits in the Windows tray (by the clock), reads the file name
(`The.Office.S02E03.720p.mkv`), finds the show on Bingers, follows your playback, and marks the
episode watched once you're past 80%.

> An unofficial, open-source project, inspired by
> [Media-Player-Scrobbler-for-Simkl](https://github.com/ByteTrix/Media-Player-Scrobbler-for-Simkl).
> The code here is written from scratch.

## What you need

- Windows 10 or 11
- A Bingers **Legend** or **Icon** plan. The Bingers API is only available on those plans.
  Subscribe in the Bingers app: Profile > Settings > Support Bingers.
- VLC (or mpv)

## Install

1. Go to the [latest release](https://github.com/siklevis7/scrobbler-for-bingers/releases/latest).
2. Under **Assets**, download `BingersScrobbler_Setup_<version>.exe`.
3. Run it. Windows may show "Windows protected your PC" because the app isn't signed: click
   **More info**, then **Run anyway**.
4. Leave **Start Bingers Scrobbler when I sign in to Windows** ticked, and finish the installer.

No admin rights are needed. If you'd rather not install anything, download
`BingersScrobbler_Portable_<version>.zip`, unzip it, and run `BingersScrobbler.exe`.

## Set up

When the app starts for the first time, it walks you through the following.

### 1. Sign in to Bingers

1. Click **Open token page**. It opens <https://bingers.app/integrations>.
2. Sign in, go to **Personal tokens**, click **Create**, and choose **read + write**.
3. Copy the token (it starts with `bng_pat_`), paste it into the app, and click **OK**.

Treat the token like a password. The app stores it in `%APPDATA%\bingers-scrobbler\credentials.json`.

### 2. Let the app see VLC

1. In VLC, open **Tools > Preferences**.
2. Bottom left, under **Show settings**, click **All**.
3. Click **Interface > Main interfaces**, and tick **Web**.
4. Expand **Main interfaces**, click **Lua**, and type a password under **Lua HTTP**.
   Make up a new one; it only protects VLC's web interface.
5. Click **Save**, then close and reopen VLC.
6. Type the same password into the app. Later you can change it from the tray icon:
   **Players > Set VLC Password...**

### 3. mpv (optional)

Add this line to `%APPDATA%\mpv\mpv.conf`:

```
input-ipc-server=\\.\pipe\mpv-pipe
```

## Using it

Just watch. The tray icon's tooltip and status show what's going on, for example
"Watching Ozark S04E12". When an episode is marked, you get a notification.

Right-click the tray icon for the menu:

| Menu | What it does |
|---|---|
| **Pause / Resume Tracking** | Stop marking things for a while. The icon turns grey while paused. |
| **Scrobbling > Retry Last Scrobble** | Send the last mark again. |
| **Scrobbling > Sync Backlog Now** | Send marks saved while you were offline. |
| **Scrobbling > Completion Threshold** | 65%, 80% (default), 90%, or a custom value. |
| **Scrobbling > Notifications** | Turn the pop-ups on or off. |
| **Scrobbling > Open Watch History** | Everything the app has marked. |
| **Bingers** | Shows who you're signed in as, plus Sign In, Change Token and Sign Out. |
| **Players** | Turn VLC or mpv on or off, and set the VLC password. |
| **Settings** | Start with Windows, open the settings file or the logs folder. |
| **More** | Check for updates, project page, about. |

### How it decides something was watched

- An item counts as watched when **both** are true:
  - you're past the **completion threshold** (80% by default), and
  - you actually played it for at least 5 minutes (or half the length for short files).
- Paused time and skipping ahead don't count toward that time.
- If you're offline, the mark is saved with the time you watched it, and it's sent later.

### When it picks the wrong show

Right-click the tray icon > **Settings > Open Settings File**, and pin the title under
`[overrides]`:

```toml
[overrides]
"Doctor Who 2005" = "tvdb:78804"
```

The key is the title as it appears in the file name. The value can be `tvdb:…`, `imdb:…`,
`tmdb:show:…` / `tmdb:movie:…`, or a Bingers id. Then restart the app: right-click >
**Exit**, and open it again from the Start menu.

## For developers

### Run from source

Open Command Prompt, then run each line:

```
git clone https://github.com/siklevis7/scrobbler-for-bingers.git
cd scrobbler-for-bingers
python -m venv .venv
.venv\Scripts\activate
pip install -e ".[dev]"
```

- `bingers-scrobbler tray` starts the tray app.
- `bingers-scrobbler run` scrobbles in the console instead.
- `bingers-scrobbler status` checks the token and the players.
- `bingers-scrobbler match "file name.mkv"` shows how a file name would be matched, using a
  dry run that writes nothing.
- `pytest` runs the tests. No network or players are needed.

### Build the Windows app

```
pyinstaller --noconfirm --clean packaging/bingers-scrobbler.spec
```

This creates `dist\BingersScrobbler\BingersScrobbler.exe`. To wrap it in an installer,
install [Inno Setup 6](https://jrsoftware.org/isinfo.php), then run:

```
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" /DAppVersion=0.2.0 packaging\installer.iss
```

### Publish a release

1. Set the version in `src/bingers_scrobbler/__init__.py` and `pyproject.toml`.
2. Commit and push.
3. Push a matching tag:

```
git tag v0.2.0
git push origin v0.2.0
```

GitHub Actions ([release.yml](.github/workflows/release.yml)) then runs the tests, builds the
app, checks the packaged exe, and attaches the installer and portable zip to a new release.

### Project layout

```
src/bingers_scrobbler/
  tray.py         tray icon, menu and first-run setup
  dialogs.py      sign-in, password, threshold and history windows
  cli.py          commands: login, run, match, status, tray
  config.py       config.toml and the token file
  api.py          Bingers API client (search, scrobble, me)
  parser.py       file name -> show/movie, season, episode (guessit)
  matcher.py      parsed name -> Bingers title (search, cache, overrides)
  tracker.py      the loop: watched-time counting, threshold, events
  backlog.py      offline queue
  history.py      local watch history
  winutil.py      start with Windows, single instance
  icons.py        draws the app icon
  players/        VLC web interface, mpv JSON IPC
packaging/        PyInstaller recipe and Inno Setup installer
tests/            pytest suite
```

## Roadmap ideas

- More players: MPC-HC/MPC-BE, PotPlayer, and a window-title fallback
- Anime absolute numbering, through `/titles/{ref}/episodes`
- Code signing, so Windows stops warning about the installer

## License

[GPL-3.0](LICENSE). You're free to use, change and share this code. If you distribute a
changed version, it has to stay open source under the same license.
