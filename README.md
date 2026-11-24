# Bingers Scrobbler

Watch something, and it gets marked as watched on [Bingers](https://bingers.app)
automatically, so you never update episodes by hand. There are two parts, and you can use
either or both:

| Part | For | Guide |
|---|---|---|
| **Desktop app** (Windows) | Video files you play in **VLC** or **mpv** | [Installation guide](#installation-guide) |
| **Browser extension** (Chrome, Edge) | **Netflix, Prime Video, Disney+, Max** and more | [Streaming services](#streaming-services-netflix-prime-video-disney-max) |

Both follow your playback and mark the episode watched once you're past 80%.

> An unofficial, open-source project, inspired by
> [Media-Player-Scrobbler-for-Simkl](https://github.com/ByteTrix/Media-Player-Scrobbler-for-Simkl).
> The code here is written from scratch.

## Before you start

You need three things:

1. **A Windows 10 or Windows 11 computer.**
2. **A Bingers Legend or Icon plan.** The app talks to Bingers through its API, and Bingers
   only allows that on these two plans. To subscribe, open the Bingers app on your phone and go
   to **Profile > Settings > Support Bingers**.
3. **VLC media player.** If you don't have it, download it free from
   [videolan.org](https://www.videolan.org/vlc/) and install it. mpv also works; see
   [Using mpv instead of VLC](#using-mpv-instead-of-vlc-optional).

The whole setup takes about 10 minutes. You only do it once.

## Installation guide

### Step 1: Download the installer

1. Open this page:
   **<https://github.com/siklevis7/scrobbler-for-bingers/releases/latest>**
2. Scroll down to the section called **Assets**. If you only see a few files, click
   **Show all assets**.
3. Click the file whose name starts with **`BingersScrobbler_Setup_`** and ends with **`.exe`**,
   for example `BingersScrobbler_Setup_0.2.0.exe`. The download starts.
4. Your browser may warn that the file "isn't commonly downloaded". That's normal for small
   apps. To keep the file:
   - **Microsoft Edge:** in the downloads list, hover over the file, click the **…** (three
     dots), click **Keep**, then **Show more**, then **Keep anyway**.
   - **Google Chrome:** in the downloads list, click **Keep**, or **Download insecure file**.

### Step 2: Run the installer

1. Open your **Downloads** folder. Press **Windows key + E** to open File Explorer, then click
   **Downloads** on the left.
2. Double-click **`BingersScrobbler_Setup_0.2.0.exe`**. The version number may differ.
3. A blue window may say **"Windows protected your PC"**. This appears because the app isn't
   code-signed, which costs money every year. The app is open source: anyone can read its
   code on this page. To continue:
   1. Click the small **More info** text.
   2. Click the **Run anyway** button that appears.
4. The installer opens. Go through its pages:
   1. **License Agreement:** select **I accept the agreement**, then click **Next**.
   2. **Select Destination Location:** leave it as it is, and click **Next**.
   3. **Select Additional Tasks:** leave **Start Bingers Scrobbler when I sign in to Windows**
      ticked, so it always runs in the background without you having to open it. Tick
      **Create a desktop shortcut** if you want one. Click **Next**.
   4. **Ready to Install:** click **Install**.
   5. **Completing the setup:** leave **Start Bingers Scrobbler now** ticked, and click
      **Finish**.

The installer doesn't ask for an administrator password. It installs only for your Windows user.

### Step 3: Find the app by the clock

Bingers Scrobbler has no main window. It lives as a small icon in the **system tray**: the
corner of the taskbar next to the clock, at the bottom right of your screen. The icon is a
white play button with a check mark, on a purple-to-orange square.

1. Look at the icons next to the clock.
2. If you don't see it, click the small **^** arrow next to those icons. Hidden icons
   appear in a small pop-up.
3. Optional, to always see it: drag the icon from that pop-up down onto the taskbar, next to
   the clock.

- **Right-click** the icon to open its menu.
- **Hover** over it to see what it's doing, for example "Running" or "Watching Ozark S04E12".

## Set up

The first time the app starts, it opens a **Welcome** window and walks you through the
following steps. Click **OK** on the Welcome window to begin.

### Step 4: Create your Bingers token

A token is a long secret code. It lets the app mark episodes on your Bingers account without
knowing your password.

1. In the **Sign in** window, click the **Open token page** button. Your browser opens
   <https://bingers.app/integrations>. Leave the Sign in window open.
2. Sign in to Bingers in the browser if it asks.
3. Find the **Personal tokens** section, and click **Create**.
4. When it asks what the token may do, choose **read + write**. A read-only token can't
   mark anything as watched.
5. Bingers shows your new token. It starts with **`bng_pat_`**. Click the copy button next to
   it, or select all of it and press **Ctrl + C**.

> **Keep your token secret.** Anyone who has it can change your Bingers library. Don't
> share it, post it, or send it in a message. If it ever leaks, delete it on the same page and
> create a new one.

### Step 5: Sign in to the app

1. Go back to the app's **Sign in** window. If it's hidden behind your browser, click it on
   the taskbar.
2. Click inside the text box, and press **Ctrl + V** to paste the token. It shows as dots,
   which is normal. Tick **Show** if you want to check it.
3. Click **OK**.
4. A message says **"Signed in as"** followed by your Bingers name. Click **OK**.

If it says **"Bingers refused that token"**, check two things:
- the token was created with **read + write**, and
- your Bingers account has the **Legend** or **Icon** plan.

Then paste the token again.

### Step 6: Turn on VLC's web interface

The app reads what VLC is playing through a small web interface that's built into VLC. It's
switched off by default, so you turn it on once:

1. Open **VLC**.
2. In the menu bar at the top, click **Tools**, then **Preferences**.
3. At the **bottom left** of the Preferences window, under **Show settings**, click **All**.
   The window changes to a long list of settings on the left.
4. In that list, find **Interface** near the top. Click the small arrow next to it to
   expand it.
5. Click the words **Main interfaces** (just under Interface).
6. On the right side, tick the box next to **Web**. Don't change anything else.
7. On the left, click the small arrow next to **Main interfaces** to expand it, then click
   **Lua**.
8. On the right, find **Lua HTTP**, and type a password in the **Password** box.
   - Make up a new, simple password, for example `bingers123`.
   - Don't use a real password from another account. This one only protects VLC's web
     interface on your own computer.
9. Click **Save** at the bottom right.
10. **Close VLC completely, then open it again.** The change only takes effect after a restart.
    If Windows then asks whether VLC may use the network, click **Allow** or **Cancel**.
    Either way works, because the app connects from your own computer.

### Step 7: Give the app your VLC password

1. Go back to the app's **VLC password** window. It opens by itself after you sign in, and
   repeats these VLC steps.
2. Type the **same password** you set in VLC in step 6.
3. Click **OK**.
   - If a video is playing in VLC, you'll see **"Connected to VLC"** with the file name.
   - Otherwise you'll see **"Password saved"**. That's fine too.

To change the password later: right-click the tray icon, then **Players > Set VLC Password...**

### Step 8: Start with Windows

If you unticked the start-with-Windows option in the installer, the app now asks
**"Start Bingers Scrobbler automatically when you sign in to Windows?"**:
- **Yes** (recommended): it runs every time you turn on your computer.
- **No:** you open it yourself from the Start menu whenever you want to scrobble.

You can change this any time: right-click the tray icon, then **Settings > Start with Windows**.

### Step 9: Check that it works

1. Open an episode of a show in VLC. The file name should include the show name and the
   episode number, for example `Ozark.S04E12.mkv` or `The Office - 2x03.mp4`.
2. After a few seconds, hover over the tray icon. It should say
   **"Watching Ozark S04E12"** (with your show and episode).
3. Watch until you're past **80%** of the episode. The app also needs at least **5 minutes**
   of real playback, so skipping straight to the end doesn't count.
4. A notification pops up: **"Ozark S04E12 marked watched"**.
5. Open Bingers. The episode is ticked.

**You're done.** From now on, just watch in VLC as usual, and your episodes get marked by
themselves.

### Using mpv instead of VLC (optional)

1. Open File Explorer, click the address bar at the top, type `%APPDATA%\mpv`, and press
   **Enter**. If the folder doesn't exist, create a folder named `mpv` inside `%APPDATA%`.
2. Open the file **`mpv.conf`** with Notepad. Create it if it isn't there.
3. Add this line on its own, then save the file:
   ```
   input-ipc-server=\\.\pipe\mpv-pipe
   ```
4. Close mpv completely and open it again.

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

## Streaming services (Netflix, Prime Video, Disney+, Max)

To scrobble what you watch on streaming sites, install the **Bingers Scrobbler browser
extension** in Google Chrome or Microsoft Edge. It works on its own: you don't need the
desktop app for it.

| Service | Status |
|---|---|
| Netflix | Supported (beta) |
| Prime Video | Supported (beta) |
| Disney+ | Supported (beta) |
| Max / HBO Max | Supported (beta) |
| Apple TV+, Hulu, Paramount+, Peacock | Experimental: works only if the site reports what's playing to the browser |
| **Any other site** | Turn it on yourself with one click: see [Any other streaming site](#any-other-streaming-site) |

It only works when you watch **in the browser on your computer**. It can't see the apps on a
smart TV, console, phone or tablet.

### Step 1: Download the extension

1. Open the [latest release](https://github.com/siklevis7/scrobbler-for-bingers/releases/latest)
   page.
2. Under **Assets**, click **`BingersScrobbler_Extension_<version>.zip`** to download it.

### Step 2: Unzip it to a permanent place

1. Open your **Downloads** folder (press **Windows key + E**, then click **Downloads**).
2. Right-click **`BingersScrobbler_Extension_<version>.zip`**, and choose **Extract All...**
3. In the window that opens, click **Browse...**, choose your **Documents** folder, and click
   **Select Folder**.
4. Click **Extract**. You now have a folder called **`BingersScrobbler_Extension`** inside
   Documents.

> **Don't delete or move this folder later.** The browser loads the extension from it every
> time it starts.

### Step 3: Add it to your browser

**In Google Chrome:**

1. Click the address bar at the top, type `chrome://extensions`, and press **Enter**.
2. At the top right, turn on the **Developer mode** switch.
3. Three new buttons appear at the top left. Click **Load unpacked**.
4. Go to **Documents**, click the **`BingersScrobbler_Extension`** folder once, then click
   **Select Folder**.
5. A card called **Bingers Scrobbler** appears in the list. The extension is installed.

**In Microsoft Edge:**

1. Click the address bar, type `edge://extensions`, and press **Enter**.
2. On the left, turn on the **Developer mode** switch. If you don't see the left side, make the
   window wider.
3. Click **Load unpacked**.
4. Go to **Documents**, click the **`BingersScrobbler_Extension`** folder once, then click
   **Select Folder**.

The browser may sometimes show a message about "developer mode extensions" when it starts.
That's normal for extensions installed this way: close the message, and don't click **Turn off**.

### Step 4: Pin it to the toolbar

1. At the top right of the browser, click the **puzzle-piece** icon (Extensions).
2. Next to **Bingers Scrobbler**, click the **pin** icon.

The extension's icon (the play button with a check mark) now stays next to the address bar.

### Step 5: Sign in

The extension's **Settings** page opens by itself after installing. If it doesn't, click the
extension's icon, then click **Settings**.

1. Click **Open token page**, sign in to Bingers, go to **Personal tokens**, click **Create**,
   and choose **read + write**. You can also reuse the token you made for the desktop app.
2. Copy the token (it starts with `bng_pat_`).
3. Go back to the Settings page, paste the token into the box, and click **Save**.
4. It says **"Signed in as"** followed by your Bingers name.

On the same page you can choose the completion threshold, turn notifications on or off, and
turn individual streaming services on or off.

### Step 6: Watch something

1. Open Netflix (or another supported service) in the browser, and start an episode.
2. **Move your mouse over the video** for a moment. The player then shows the show's title,
   which is where the extension reads it from.
3. After a few seconds, the extension's icon shows a percentage, for example **12%**. That
   means it's tracking.
4. Click the icon at any time to see what it detected, which Bingers title it matched, and how
   close you are to being marked.
5. Once you're past 80%, with at least 5 minutes of real watching, the icon shows a green
   **✓** and a notification says it was marked watched.

What the icon shows:

| Icon shows | Meaning |
|---|---|
| **12%** | Tracking this episode |
| green **✓** | Marked watched on Bingers |
| orange **…** | Bingers wasn't reachable; it's saved and will be sent automatically |
| red **!** | A problem: click the icon to see what happened |

If the pop-up says **"Can't read title"**, move your mouse over the video so the title
appears, and wait a few seconds. If it keeps happening on one service, that site has probably
changed its player. Please [open an issue](https://github.com/siklevis7/scrobbler-for-bingers/issues)
saying which service.

If the episode isn't finished but you want to mark it anyway, click the icon, then
**Mark watched now**.

### Any other streaming site

Watching somewhere that isn't in the list above? You can turn the extension on for any site
yourself, with no update needed:

1. Open the site, and go to the page where the video plays.
2. Click the extension's icon (the play button with a check mark).
3. The pop-up says **"Track videos on [site name]?"**. Click **Track videos on this site**.
4. Your browser asks: **"Bingers Scrobbler wants to read and change your data on [site]"**.
   This permission is for **that one site only**. Click **Allow**.
   - If the site plays its video inside a player from another company, the request names that
     player's site too. Allow both, or the extension can't see the video.
5. Start or keep playing the video. Within a few seconds, the icon shows a percentage, the same
   as on Netflix. If it doesn't, reload the page once.

How it works out what you're watching on these sites, from most to least reliable:
1. **The browser's media controls:** many sites tell the browser the show and episode, for
   the pop-up you see when you press a media key.
2. **The page's hidden info:** many streaming sites describe each episode or film for search
   engines (show name, season, episode number).
3. **The tab title,** but only when it clearly contains an episode number (like `S2E5` or
   `Season 2 Episode 5`) or a film year (like `Heat (1995)`). A title like "Home" is ignored.

Click the icon to see which of these it used. If it says **"Can't read title"**, that site
doesn't share enough information. Please
[open an issue](https://github.com/siklevis7/scrobbler-for-bingers/issues) with the site's name.

**To stop tracking a site:** open it, click the icon, then **Stop tracking it**. Or go to
the extension's **Settings > 4. Other sites**, and click **Remove**. This also removes the
site's permission.

### Updating the extension

1. Download the new **`BingersScrobbler_Extension_<version>.zip`** from the latest release.
2. Extract it to **Documents** again. When Windows asks, choose **Replace the files in the
   destination**.
3. Open `chrome://extensions` (or `edge://extensions`), and click the **reload** arrow on the
   Bingers Scrobbler card.

Your token and settings are kept.

## Troubleshooting

**I can't find the tray icon.**
Click the **^** arrow next to the clock. If it isn't there either, open the Start menu, type
**Bingers Scrobbler**, and press **Enter**.

**The status says "Running", but it never says "Watching …" while VLC plays.**
The app can't see VLC. Check that:
1. **Web** is ticked in VLC (step 6), and you **closed and reopened VLC** afterwards.
2. The password in VLC and the one in the app are exactly the same. To retype it: right-click
   the tray icon, then **Players > Set VLC Password...**
3. **VLC** is ticked under **Players** in the tray menu.

**It says "Watching …" but never marks the episode.**
Keep watching until you're past 80%, with at least 5 minutes of real playback. Paused time and
skipping ahead don't count. If you only need part of an episode to count, lower the
percentage: right-click the tray icon, then **Scrobbling > Completion Threshold**.

**I got a notification saying it couldn't find a show on Bingers.**
The file name is unusual, or the show has a different name on Bingers. See
[When it picks the wrong show](#when-it-picks-the-wrong-show).

**The status says "Token refused - sign in again".**
The token was deleted, or your plan ended. Create a new token (step 4), then right-click the
tray icon, and choose **Bingers > Change Token...**

**I was offline while watching.**
Nothing is lost. The mark is saved and sent automatically when you're back online. To send it
right away: right-click the tray icon, then **Scrobbling > Sync Backlog Now**.

**Something else went wrong.**
Right-click the tray icon, then **Settings > Open Logs Folder**, and open `scrobbler.log`. It
shows what the app did, step by step. You can also
[open an issue](https://github.com/siklevis7/scrobbler-for-bingers/issues). Never paste your
token there.

## Portable version (no install)

1. On the [latest release](https://github.com/siklevis7/scrobbler-for-bingers/releases/latest)
   page, download **`BingersScrobbler_Portable_<version>.zip`**.
2. Right-click the downloaded file, choose **Extract All...**, then click **Extract**.
3. Open the extracted folder, and double-click **`BingersScrobbler.exe`**.
4. Follow [Set up](#set-up) from step 4.

Keep the folder somewhere permanent, such as `Documents`. "Start with Windows" points at the
`.exe` wherever it was when you turned that option on.

## Uninstall

1. Right-click the tray icon, and click **Exit**.
2. Open the Start menu, and go to **Settings > Apps** (on Windows 11: **Settings > Apps >
   Installed apps**).
3. Find **Bingers Scrobbler**, click it (or the **…** next to it), then click **Uninstall**.

Uninstalling keeps your settings, token and watch history, so a reinstall picks up where you
left off. To remove them too, open File Explorer, type `%APPDATA%\bingers-scrobbler` in the
address bar, press **Enter**, and delete that folder. Also delete your token on
<https://bingers.app/integrations>.

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

1. Set the same version in `src/bingers_scrobbler/__init__.py`, `pyproject.toml` and
   `browser-extension/manifest.json`.
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
browser-extension/
  manifest.json   Chrome/Edge extension (Manifest V3)
  background.js   matching, watch-time counting, scrobbling, backlog
  content/        readers that run inside each streaming site
  lib/            Bingers API client, matcher, tracker (shared logic)
  popup/ options/ the toolbar pop-up and the settings page
  tests/          Node tests: `cd browser-extension` then `node --test`
```

## Roadmap ideas

- More players: MPC-HC/MPC-BE, PotPlayer, and a window-title fallback
- Anime absolute numbering, through `/titles/{ref}/episodes`
- Code signing, so Windows stops warning about the installer

## License

[GPL-3.0](LICENSE). You're free to use, change and share this code. If you distribute a
changed version, it has to stay open source under the same license.
