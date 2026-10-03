# Installing vncode (Windows, macOS, Linux)

Three launchers, one per job:

| | Windows | macOS / Linux |
|---|---|---|
| **Install** | `scripts\install.bat` | `./scripts/install.sh` |
| **Run** | `scripts\run-web.bat` | `./scripts/run-web.sh` |
| **Remove** | `scripts\uninstall.bat` | `./scripts/uninstall.sh` |

Double-click the `.bat` files on Windows; run the `.sh` files from anywhere on
macOS/Linux (each resolves the repository root from its own location). **Every
launcher lives in `scripts/`** — the entry points, the workers and the shared
console layer together, so the repository root carries no `.bat` and no `.sh`.
Windows runs PowerShell for install/uninstall
(`scripts/install-all.ps1`) and for the run launcher's worker
(`scripts\run-web.ps1`, which the double-clickable `scripts\run-web.bat` beside it calls — the
wrapper itself is batch only, so Windows never asks an execution-policy question
before starting the GUI). macOS/Linux run the POSIX shell scripts and need
**no PowerShell at all**.

## Requirements

- **Windows 10/11**: the built-in Windows PowerShell 5.1 (or PowerShell 7)
- **macOS / Linux**: a POSIX shell (the system `sh` is enough) — nothing else
- **Node.js 22+** on every platform (it runs dsh, pnpm and the JSON parsing)
  — https://nodejs.org
- `pnpm` is reused when the system one is new enough for the profile, otherwise
  bootstrapped automatically into `./tools`
- macOS/Linux only: the launchers need the executable bit, which git preserves
  (`chmod +x scripts/install.sh scripts/uninstall.sh scripts/run-web.sh scripts/*.sh` if you copied the files
  by hand)

> `scripts/sync-vendored.ps1` (the maintainer fork re-sync) is the one script
> here that is PowerShell-only; the installers never call it.

## What gets targeted

| Target | Profile | Location |
|---|---|---|
| web / CLI (`npx @deepseek-ai/dsh web`) | `web` | `$DSH_HOME/profiles/web` (`$DSH_HOME` = env var, else `~/.dsh`) |

This is the **only** target. DSH Desktop is deliberately not supported any more
(the desktop app launches a frozen snapshot of its plugin set, so live edits
never showed up there); `-Target desktop` is rejected on purpose.

Overrides if the profile lives somewhere else:
`-DshHome <harness home> -ProfileName <profile>`.

> Upgrading from an older build of this pack: the installer prunes the retired
> bundle names (`dsh-focus`, and `dsh-files` - the pack's own Files panel, which
> the harness now ships natively) from the profile before adding the current
> bundles, so you never end up with two docks.

## The launchers

One entry point per action per host, plus the worker each one calls. There are
deliberately no `install-all.bat` / `uninstall-all.bat` twins: those called the
PowerShell worker **directly**, which meant skipping the shared console layer
(`scripts/console/adapt.cmd` - the Windows Terminal relaunch, the pause rule and
the real-argument handling), so they were a second, worse way to do what
`install.bat` already does. `install.bat` and `uninstall.bat` ARE that path.

| Platform | Entry point (double-click / run) | The worker it calls |
|---|---|---|
| Windows | `scripts\install.bat` / `scripts\uninstall.bat` / `scripts\run-web.bat` / `scripts\run-desktop.bat` | `scripts\install-all.ps1` / `uninstall-all.ps1` / `run-web.ps1` |
| macOS / Linux | `./scripts/install.sh` / `./scripts/uninstall.sh` / `./scripts/run-web.sh` | `./scripts/install-all.sh` / `uninstall-all.sh` (the `.sh` entry points do the work themselves) |
| Windows (direct) | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-all.ps1 -Force` | same with `uninstall-all.ps1`, and `-File scripts\run-web.ps1` for the app |
| macOS / Linux (direct) | `sh scripts/install-all.sh -Force` | `sh scripts/uninstall-all.sh`, and `sh scripts/run-web.sh` for the app |

The `-all` in the worker names is not a duplicate of the entry point: it says the
worker installs **every bundle this pack carries**, as opposed to one (`-Plugin`
narrows it). The entry point and its worker are one chain, not two names for one
thing.

The install and uninstall launchers pass the force flag unless you already did,
so running them again always installs the latest edits. Running the worker
directly behaves like a plain script run: it skips bundles that are already
installed at the same version. Both halves accept the same flags (`-Force`,
`-Plugin`, `-DshHome`, `-ProfileName`, `-DshVersion`, `-Target web|cli`), plus
`-NoPause` (never hold the window open) and `-NoTerminal` on the Windows side;
`-Help`, `-h`, `--help` and `/?` all print them. The run launcher is
`scripts\run-web.bat` (which drives `scripts\run-web.ps1`, the worker beside it)
plus `./scripts/run-web.sh`. Both take their own flags (see **Running it** below).

**How the Windows entry points present themselves.** They all share ONE console
layer, `scripts\console\`:

- `adapt.cmd` picks the window - a double-click opens in **Windows Terminal**
  when it is installed and the default terminal application is not already
  Terminal (a no-op on a stock Windows 11), so `-NoTerminal` or
  `VNCODE_NO_WT=1` opts out - and the PowerShell: **`pwsh` 7 when the machine
  has it, Windows PowerShell 5.1 otherwise.** Both are supported on purpose, and
  5.1 is what a stock Windows 10/11 ships;
- it also decides whether the window is held open at the end. A double-clicked
  failure pauses so it can be read; a scripted run does not. `-NoPause`, or
  `VNCODE_NOPAUSE=1`, never pauses;
- `theme.ps1` / `theme.sh` own the colour policy: **colour only on a real
  terminal, never in a redirected log, and `NO_COLOR` always wins.** Output is
  UTF-8, so a path with an accent survives the trip;
- exit codes mean the same thing everywhere: `0` success, `1` the run's own
  failure or a usage error, `2` a missing prerequisite (no PowerShell, no Node),
  `3`/`4` reserved for install and verify failures.

No entry point ever asks for administrator rights, and the macOS/Linux half never
runs PowerShell at all.

## Running it

Once the pack is installed, start the app with the run launcher — it *is* the
`npx @deepseek-ai/dsh web` command, with the browser hand-off attached. On Windows
that is `scripts\run-web.bat`, which forwards to `scripts\run-web.ps1` beside it; on macOS/Linux
it is `scripts/run-web.sh`, one file that does the whole job.

```bat
:: Windows - just double-click scripts\run-web.bat, or run it with flags
scripts\run-web.bat
scripts\run-web.bat -Port 3099
scripts\run-web.bat -DefaultBrowser
scripts\run-web.bat -NoBrowser
```

```sh
# macOS / Linux
./scripts/run-web.sh                     # start + open the URL in Google Chrome
./scripts/run-web.sh -Port 3099          # 3080 already taken
./scripts/run-web.sh -DefaultBrowser     # skip Chrome, use the default browser
./scripts/run-web.sh -NoBrowser          # start the server only
```

What it does, in order:

1. runs `npx --yes @deepseek-ai/dsh@<pin> web --no-open` (plus `--port <n>` when
   you passed `-Port`). `--no-open` stops the app from also starting a browser:
   the launcher owns the hand-off, so the URL opens exactly once;
2. streams the app's own output to the terminal — nothing is swallowed — and
   watches it for the ready line the app prints once the server is listening:

   ```
   dsh web: http://127.0.0.1:3080/?token=<launch token>
   ```

3. opens **that** URL, token included, in **Google Chrome** — found on `PATH`,
   in the standard install folders, or through Windows' `App Paths` registry
   entry. When Chrome is not installed the platform's default browser is used
   instead (`open` on macOS, `xdg-open` on Linux, the shell's own handler on
   Windows);
4. keeps running in the foreground. The harness lives in that terminal, so
   **Ctrl+C stops it**; the terminal prints the exit status when it ends.

Two properties worth knowing:

- **The launch token is a live credential.** It is the value the server
  exchanges for the browser session cookie, so it is read from the app's output
  **in memory only**: the launchers never write it to a file, never echo it
  themselves, and never build a command string out of it — it reaches the browser
  as a single argument, handed over with `Start-Process -ArgumentList` on Windows
  and as an argv element of `open`/`xdg-open` on macOS/Linux. `scripts\run-web.bat`
  never even sees the URL. The terminal still
  shows the token, because the app prints it; treat a copy of that pane (a
  screenshot, a pasted log) the way you would treat the session cookie itself.
- **Only a loopback URL is opened.** If the ready line ever named anything but
  `127.0.0.1`, `::1` or `localhost`, the launcher refuses and says so rather
  than handing the token to a browser pointed at another host.

If the app never prints a ready line (a profile with `printUrl` disabled),
nothing is opened and the launcher says so; the URL is in the app's own output.

## Manual path (no script)

```bat
:: Windows
set DSH_HOME=C:\Users\you\.dsh
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add C:\path\to\vncode\packages\dsh-editor
```

```sh
# macOS / Linux
export DSH_HOME="$HOME/.dsh"
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add /path/to/vncode/packages/dsh-editor
```

(Requires `pnpm` on PATH.) Remove with the same command but `remove dsh-editor`.
If the profile still lists a retired name, `remove dsh-files` (and
`remove dsh-focus`) first - the scripts do this automatically.

Start it by hand with the command the run launchers wrap (the app prints its
`dsh web: http://127.0.0.1:<port>/?token=<token>` URL either way):

```sh
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 web
```

## Uninstall

`scripts\uninstall.bat` (Windows) or `./scripts/uninstall.sh` (macOS/Linux) — removes the bundles
from the web profile, plus any retired bundle name (`dsh-files`, `dsh-focus`).

## After installing

1. Start (or restart) the app with **`scripts\run-web.bat`** (Windows) or **`./scripts/run-web.sh`**
   (macOS/Linux) — or `npx @deepseek-ai/dsh web` by hand — and open/select a
   conversation.
2. Open the right Sidebar with the **expand button** in the conversation header
   (top right). It opens on the shipped **Start** page, whose capsules list the
   Files tab, the new **Editor** and **History** — the workspace’s commit
   history — it needs `git` on the `PATH` of the host running `dsh web`). The tab
   strip’s **"+"** opens that Start page again at any time.
3. The header’s **Terminal** button (the last one in that group, right of
   **Open In…**) opens the **bottom dock**: a real shell in the conversation’s
   folder, under the conversation and the right bar, which make room for it.
   Drag its top edge to resize it, `+` in its bar opens more terminals, and
   `Ctrl+Shift+C` / `Ctrl+Shift+V` copy and paste (a bare `Ctrl+C` still
   interrupts). It closes with the same button or its `×`; the shell is kept
   briefly, so reopening the dock in that conversation reattaches to it. The
   dock's left edge follows the left bar when that is collapsed or expanded —
   the bar itself never moves.
4. The left bar's top row wears the pack's branding: the **app icon** (a black
   disc, `assets/vncode.svg`) and **vncode** where the shipped mark and
   wordmark were — and the same icon replaces the whale beside **Into the
   Unknown** on the new-session screen.

## Troubleshooting

- **The run launcher says the port is already in use** — an app is already
  listening on 3080 (another terminal, or this one). Use the running one, stop
  it, or start a second instance on another port: `scripts\run-web.bat -Port 3099` /
  `./scripts/run-web.sh -Port 3099`.
- **`scripts\run-web.bat` refuses to start / the window flashes and closes** — the wrapper
  pauses on the worker's own failures, so read the window; run it from the repo
  root (the worker reads `.dsh-version.json` from there) and check that `node` and
  `npx` are on the `PATH`. The double-click works because the entry point is
  batch; the wrapper passes `-ExecutionPolicy Bypass` to the PowerShell worker, so
  a restrictive policy does not block it either.
- **No browser opened, but the app is running** — the ready line was never
  printed (a profile with `printUrl` disabled) or the launcher said why. The URL
  is in the app's own output; `-NoBrowser` turns the hand-off off on purpose.
- **The browser opened but Chrome is not installed** — that is the fallback
  working: the launcher reports "the default browser" instead of Chrome. Pass
  `-DefaultBrowser` to skip the Chrome lookup entirely.
- **The launcher refused to open the URL** — the ready line did not name a
  loopback address, so the token was not handed to a browser. That should never
  happen with the pinned line; check what prints the `dsh web:` line.
- **`./scripts/run-web.sh: Permission denied`** — `chmod +x scripts/run-web.sh scripts/install.sh scripts/uninstall.sh
  scripts/*.sh`.
- **The launcher says the profile does not list this pack's bundles** — a
  friendly warning, not a failure: the app still starts. Run `scripts\install.bat` /
  `./scripts/install.sh` if you expected the pack in it.
- **`dsh` exits non-zero during install** — most often a network hiccup fetching
  the pinned CLI; re-run, and use `-Verbose` on the PowerShell half to see the
  exact command.
- **Profile not found** — pass `-DshHome`/`-ProfileName`, or run
  `npx @deepseek-ai/dsh web` once so the profile exists.
- **`./scripts/install.sh` says a command is missing** — install Node.js 22+
  (https://nodejs.org). The macOS/Linux half needs Node and npm/npx only; it
  never needs PowerShell.
- **`sh: scripts/install-all.sh: not found` (or a syntax error)** — run it from
  the repository root (its `scripts/`-relative path resolves there) or with its
  full path, and keep the POSIX half dash-compatible
  (`sh -n scripts/install-all.sh` is the syntax check).
- **`./scripts/install.sh: Permission denied`** — `chmod +x scripts/install.sh scripts/uninstall.sh
  scripts/*.sh`.
- **`-Target desktop` is rejected** — intentional: DSH Desktop is no longer a
  target of this pack; run without `-Target` (or with `-Target web`).
- **Two Files panels / a stray right-hand dock after upgrading** — the retired
  `dsh-files` (or `dsh-focus`) bundle is still in the profile; re-run the
  installer so its prune removes it.
- **No "Editor" capsule on the "+" / Start page** — pick an active
  conversation, restart and hard-refresh (Ctrl+F5); check the browser console
  for `[dsh-editor]` errors if it still does not show. The bar itself is the
  pack's own (`dsh-rightbar`), forked from the `0.2.0-rc.2` line.
- **A text file opens in the read-only preview** — that extension belongs to a
  shipped preview (`.html`, images, `.pdf`, …) or the path is outside the
  conversation folder; the editor deliberately leaves those alone. Markdown is
  *not* one of them: `.md` opens editable, and its toolbar's **Preview** button
  opens the rendered view.
- **Save-as says the name is taken / the folder is missing** — pick another name
  (`409 EXISTS`), or use a subfolder that already exists (`404 NO_FOLDER`):
  nothing creates directories.
- **The "Open In…" File Explorer entry does nothing** — confirm the boot HTML
  lists `dsh-open-in-app/client.js` and not
  `@deepseek-ai/dsh-client-ui-open-in-app`; the pack's launcher reports a real
  failure (HTTP 502 → the button's red state) instead of a silent success.
- **Editor says "Could not open the file" / keeps saving as changed on disk** —
  the session workspace root could not be resolved (open the conversation once),
  or the file changed under you: use **Reload** / **Save anyway** in the banner.
- **No Themes button in the header (or it is greyed out)** — the button sits
  immediately left of **Open In…**; a new package needs one install run
  (`scripts\install.bat` / `./scripts/install.sh`, or `-Force`), then a restart. Greyed out means
  the shipped `@deepseek-ai/dsh-client-ui-theme` service (row `ui-theme`) is not
  in the boot graph — the tooltip says "The theme service is unavailable".
- **A header icon button has no circle around it** — the group's round hairline
  ring arrives with `dsh-themes` alpha.9 (its own Themes button) plus that
  package's one-rule override for the right bar's collapse/expand toggle in the
  header corner; reinstall (`scripts\install.bat` / `./scripts/install.sh`, or `-Force`), restart
  and hard-refresh, and confirm the served `dsh-themes` bundle prints alpha.9 or
  later.
- **Code text looks black-on-dark in the light theme** — the editor follows the
  app's appearance; confirm the served `dsh-editor` bundle prints alpha.8 or
  later in a tab's file bar and hard-refresh (Ctrl+F5).
- **Blank lines in a Markdown file render as full empty lines, or the "Edit"
  button looks monospaced** — the preview's plain-text scrollport
  (`white-space:pre` + the mono font stack) leaking into the rendered page; fixed
  in `dsh-editor` alpha.8. Confirm the served bundle prints alpha.8 or later and
  hard-refresh (Ctrl+F5).
- **"Preview" says it is unavailable** — the right bar's controller could not be
  reached (the bar must be mounted, which it is while the editor tab is on
  screen) or the shipped document preview is not in the graph; the banner says
  which.
- **A Markdown tab still offers "Markdown" / "Plain text" in its header** — that
  viewer menu is hidden on Markdown tabs by `dsh-themes` alpha.3; reinstall so
  that version is in the profile, then restart.
- **The rendered Markdown page has no "Edit" button** — that button is the
  editor's own document body, which shadows the shipped one at a lower slot
  priority; confirm the boot HTML lists `dsh-editor/client.js` at alpha.7+ and
  restart.
- **The rendered Markdown view is still dark, or unreadable on white** — that is
  `dsh-themes`' Markdown paper: it copies ui-theme's light palette out of the
  theme's own stylesheets at boot, and it injects nothing when it cannot read
  them (forcing white without the tokens would be worse). Reinstall so
  `dsh-themes` alpha.3+ is in the profile, then restart.
- **No "History" capsule on the "+" / Start page** — `dsh-gittree` is not mounted;
  a new package needs one install run (`scripts\install.bat` / `./scripts/install.sh`, or
  `-Force`), then a restart. Check the console for `[dsh-gittree]` if it still
  does not show.
- **History sits on the "Reading the history…" and never stops** — that was
  alpha.1’s bug (an effect cleanup cancelled the request it had just
  started). alpha.2 guards every request with a token; confirm the served bundle
  prints alpha.2 or later in the file bar and hard-refresh (Ctrl+F5).
- **History says "Not a git repository"** — the conversation folder is not inside
  a repository. The tab reports that instead of guessing; open a session whose
  workspace is a repository (or run `git init` in it).
- **History says "git is not installed"** — `git` is missing from the `PATH` of
  the host running `dsh web` (the routes spawn it directly).
- **History opens a file in the wrong tab, or not at all** — the row hands the
  file to the ordinary address and lets the registry decide; with neither
  `dsh-editor` nor a shipped preview claiming that extension, nothing can draw
  it. That is the same rule the Files tab follows.
- **No command-bar button in the header** — `dsh-cmdbar` is not mounted; a new
  package needs one install run (`scripts\install.bat` / `./scripts/install.sh`, or `-Force`),
  then a restart. The button is the last one in the header group, immediately
  right of **Open In…**. Check the console for `[dsh-cmdbar]` if it still does
  not show. (The package was `dsh-terminal` through alpha.13, so a profile
  installed before alpha.14 names the old bundle in its list and its live links
  until that install run.)
- **The bar says the conversation's log cannot be read here** — the conversation
  is not live on **this** host (a stored conversation answers `NOT_LIVE`), or the
  activity route is unreachable. The host's own reason is in the tooltip, and
  `GET /api/dsh-cmdbar/activity?session=<id>` reports it directly. Nothing else in
  the pack is affected.
- **The panel disappears the moment a command line is clicked, or either copy
  button is used** — that was alpha.13, and alpha.14 repairs both: expanding a row
  asked for an identifier the bundle never declared, and the copy buttons called
  the clipboard primitive's name unqualified, and the shell's slot error boundary
  RETIRES an entry that crashes, so the dock vanished until a reload. Confirm the
  build string reads `dsh-cmdbar 0.1.0-alpha.14` or later and hard-refresh (Ctrl+F5).
  (alpha.15 moved that string out of the bar and into the **Agent** label's
  tooltip — hover it.)
- **A plugin edit does not show up, however many times you refresh** — this is the
  harness's own behaviour, not the plugin's: the host **snapshots** every
  `client.js` when it boots and republishes it only through its client-plugin HMR
  hook (`dsh-client-modules`: *bundle content changes reach the graph only through
  `rebuilt()`*), so a page refresh cannot pick up an edited bundle and neither can
  `Ctrl+F5`. **Restart the process serving the page** (`npx @deepseek-ai/dsh web`,
  or `scripts\run-web.bat` / `./scripts/run-web.sh`), then reload. Client-plugin
  changes reload without a restart only while `pnpm run dev:web` is running from the
  checkout that owns them. To find out WHICH bundle the running host is actually
  serving, without trusting your eyes, paste this in the page's console (F12):
  `document.querySelector('[data-dsh-cmdbar-dock]').dataset.dshCmdbarVersion` — it
  answers e.g. `0.1.0-alpha.15`, and every release prints the same string in the
  **Agent** label's tooltip.
- **The bar's header is too tall, or its text runs into itself** — that was through
  alpha.14, and it was worst on a narrow dock: the bar stacked two rows (its own and
  the view's toolbar), its count line could not shrink and ran over the version
  beside it, and the version — the only shrinkable item — wrapped into four lines,
  so the bar grew to 84px. alpha.15 is ONE row — 25px, on the app's own dense chip
  scale — the counts ellipsise, and the version moved to the **Agent** label's
  tooltip: hover it for `dsh-cmdbar 0.1.0-alpha.15`, then hard-refresh (Ctrl+F5). If
  the row still reads too tall or too tight for you, its height is ONE value,
  `--dsc-control-h` on the dock's own `.dsc-dock` rule in
  `packages/dsh-cmdbar/lib/client.js` — change the 20px and the chips and the close
  button follow it together.
- **Hovering a command line shows what the command is for, not the command** — that
  was through alpha.14 (the native tooltip held the agent's `description`). From
  alpha.15 the line's hover card carries the **whole command**, wrapped and
  scrollable, and the row still expands for keyboard readers.
- **The dock opens but the panel does not make room for itself** — something is
  writing the middle/right columns' inline `height`; the dock sets
  `calc(100% - <dock>px)` on those two while open and hands back what they had on
  close, and it never touches the left bar.
- **Opening the dock moves the items in the left bar up** — that was alpha.1
  (the room was taken from the frame, whose single grid row the left bar shares).
  alpha.2 takes it from the middle and right columns only. Confirm the served
  bundle prints alpha.2 or later.
- **The dock keeps the old left edge after collapsing or expanding the left
  bar** — that was alpha.2 (only the frame's `style` mutation was watched, and the
  left bar is *animated*, so it reported the pre-transition width and never fired
  again). alpha.3 follows the columns' size instead. Confirm the build string reads
  `dsh-cmdbar 0.1.0-alpha.3` or later — through alpha.14 it was printed at the right
  end of the bar; from alpha.15 it is in the **Agent** label's tooltip — and
  hard-refresh (Ctrl+F5).
- **The left bar still shows the fish and the "deepseek" wordmark** — the branding
  override arrives with `dsh-themes` alpha.6; reinstall (`scripts\install.bat` /
  `./scripts/install.sh`, or `-Force`) so that version is in the profile, then restart and
  hard-refresh. The row should show the app icon and **vncode**, at the chat
  title's size (alpha.7), with the same icon beside **Into the Unknown** (alpha.8).
- **The mark looks clipped or oval** — alpha.7 drew it as a CSS disc, which lost a
  fraction of a pixel inside the sidebar's `overflow:hidden` brand button.
  alpha.8 paints `assets/vncode.svg` instead, whose circle keeps a 1px
  transparent margin, so no container can shave it. Confirm the served
  `dsh-themes` bundle prints alpha.8 or later.
- **The left bar's branding looks unstyled or empty after a harness update** —
  the override is pinned to the sidebar's hashed class names (like the band above
  it). A harness line that renames them matches nothing; the fix is to re-read the
  new names in `dsh-themes/lib/client.js` (`installLeftTopBar`).
- **No download icon in the header (the three-dot button is still there)** —
  `dsh-themes` alpha.9 is not in the profile; a plain install run
  (`scripts\install.bat` / `./scripts/install.sh`, or `-Force`), a restart and a hard refresh put
  it there. The button takes the seat the three-dot "more actions" button had
  (after **Open In…**), so the old button disappearing IS the change.
- **The download icon is greyed out with "Session export is unavailable"** — the
  shipped `session-log-download` row (or at least its browser half's
  `sessionLogDownload` service) is not mounted, and that row owns the export. The
  pack does not reimplement it: re-enable/mount
  `@deepseek-ai/dsh-session-log-export` and hard-refresh.
- **`Ctrl+C` in the terminal copies instead of interrupting** — it must not: a
  bare `Ctrl+C` is SIGINT and the clipboard is `Ctrl+Shift+C` (`Cmd+C` on macOS).
  A single-key difference here is a bug, not a preference.
- **The terminal is a full shell with no sandbox** — that is what a terminal is.
  It does not pass through the file policy the model's tools obey; the server
  gate is the same authentication the Web GUI itself uses, checked before the
  socket ever reaches a PTY.
