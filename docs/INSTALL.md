# Installing vncode (Windows, macOS, Linux)

| | Windows | macOS / Linux |
|---|---|---|
| **Install** | `scripts\setup\install.bat` | `./scripts/setup/install.sh` |
| **Run** | `scripts\run-web.bat` | `./scripts/run-web.sh` |
| **Remove** | `scripts\setup\uninstall.bat` | `./scripts/setup/uninstall.sh` |
| **The app** | `scripts\run-desktop.bat` | `./scripts/run-desktop.sh` |

Double-click the `.bat` files on Windows; run the `.sh` files from anywhere (each resolves
the repository root from its own location). **The app can do the install for you**: its
`install` verb runs the same `setup/install.*` entry point with the same output, and its
plain `start` installs the pack first when the home in use does not list it. The two are
interchangeable, and neither needs an administrator.

**Launching only the web is a supported thing to do.** `scripts\run-web.bat` /
`./scripts/run-web.sh` is the whole browser experience and needs no `vncode` binary: the
app is a front door (key, install, then this same file), not a requirement.

`scripts/` carries the entry points a person runs (`run-web.*`, `run-desktop.*`) at its top
level, and everything else in a folder: `setup/` (install and uninstall, with their
workers), `console/` (the shared console layer), `tools/` (maintainer-only) and `checks/`.
The repository root carries no `.bat` and no `.sh`.

| | |
|---|---|
| Requirements | **Node.js 22+** on every platform; **Windows** uses Windows PowerShell 5.1 (shipped) or PowerShell 7, **macOS / Linux** a POSIX shell and never PowerShell; `pnpm` is reused when the system copy is new enough, else bootstrapped into `./tools` |
| Install target | the **web profile** only, `$DSH_HOME/profiles/web` (`$DSH_HOME` = env var, else `~/.dsh`). `-Target web` and `-Target cli` both mean it; there is no desktop target. Overrides: `-DshHome <home>`, `-ProfileName <profile>` |
| State | model credentials in `$DSH_HOME/.credentials.yaml` or the home's `.env`; sessions, settings, attachments and the pack's own caches under the same home |

## The app: `vncode`

A small console program - no window, no embedded web view - that decides the root, the key
and the pack and then runs the web launcher.

```
vncode                install the pack if this home lacks it, ask for the key if there
                      is none, then start the harness and open it (scripts\run-web.bat)
vncode start          the same thing, spelled out
vncode install        run scripts/setup/install.* against the home in use
vncode uninstall      run scripts/setup/uninstall.* against it
vncode status         the pin, the home and why it was chosen, the pack, the key layer,
                      where the launcher is; start nothing
vncode key            ask for the DeepSeek key and write it into <home>/.env (0600)
```

Flags: `-Port <n>`, `-DshHome <dir>`, `-DshVersion <ver>`, `-Help`, `-Version`. The key is
asked for only when there is none and only at a terminal; a piped run never blocks on it.
`start` gives the launcher a free loopback port **of its own** - never the shared `3080`,
which is what every `dsh web` on the machine reaches for - and `-Port 3080` is how to ask
for the shared origin on purpose.

**The app owns a root** (`$VNCODE_HOME`, default the platform's per-user data directory
plus `vncode`) and the harness home is `<root>/home` inside it. A folder that carries
`.vncode/PORTABLE` - or already holds a home - is a portable installation and uses its own
`.vncode` instead, so everything travels with the folder. [PATHS.md](PATHS.md) is the map.

## Launchers

On Windows each entry point calls the PowerShell worker beside it (`install.bat` ->
`install-all.ps1`, `uninstall.bat` -> `uninstall-all.ps1`, `run-web.bat` -> `run-web.ps1`),
and `run-desktop.bat` builds `vncode` when it is missing and then runs it. `run-desktop.sh`
is the same on macOS/Linux, in plain POSIX shell. The POSIX `.sh` files do the work
themselves and need Node.js with npm/npx only. Direct calls: `powershell -NoProfile
-ExecutionPolicy Bypass -File scripts\setup\install-all.ps1 -Force` and `sh
scripts/setup/install-all.sh -Force` (the same with `uninstall-all.*` and `run-web.*`).

Flags on both halves: `-Force`, `-Plugin <name>`, `-DshHome`, `-ProfileName`,
`-DshVersion`, `-Target web|cli`, `-NoPause`, and `-NoTerminal` on Windows; `-Help`, `-h`,
`--help` and `/?` print the usage. The `-all` in a worker's name means it installs **every
bundle the pack carries**; `-Plugin` narrows it to one.

The Windows entry points share `scripts\console\`: `adapt.cmd` relaunches into Windows
Terminal when it exists and nothing is already inside one (`-NoTerminal` or
`VNCODE_NO_WT=1` opts out), runs the worker with `pwsh` 7 when present and Windows
PowerShell 5.1 otherwise, and holds the window open on a double-clicked failure
(`-NoPause` / `VNCODE_NOPAUSE=1` never pauses). `theme.ps1` / `theme.sh` own the colour
policy: colour only on a real terminal, never in a redirected log, `NO_COLOR` always wins.
Exit codes: `0` success, `1` own failure or usage error, `2` a missing prerequisite (no
PowerShell, no Node). Nothing asks for administrator rights.

**The app clears that layer's markers for every child it starts.** `adapt.cmd` marks a run
it has set up with `VNCODE_CONSOLE`, and an entry point that sees the marker takes its
arguments from the relaunched shell instead of `%*`. Because the app is started *by* that
layer, it inherits the marker - so it is removed from the launcher's and the installer's
environment. Measured, not assumed: without that, `install.bat -Help` ran a full install.

## Running it

`scripts\run-web.bat` / `./scripts/run-web.sh` starts the pinned harness with the browser
hand-off attached. Flags: `-Port <n>`, `-DshHome <dir>`, `-DshVersion <ver>`, `-NoBrowser`
(server only), `-DefaultBrowser` (skip Chrome). It runs `npx --yes
@deepseek-ai/dsh@<pin> web --no-open` (plus `--port <n>`), streams the app's own output,
watches for the ready line `dsh web: http://127.0.0.1:<port>/?token=<launch token>` and
opens **that** URL in Google Chrome (`PATH`, the standard install folders, Windows' `App
Paths`, `/Applications/Google Chrome.app`, `google-chrome`/`chromium`), falling back to the
platform default browser. It stays in the foreground: Ctrl+C stops it and the terminal
prints the app's exit status.

- **The launch token is a live credential.** It is read from the app's output in memory
  only - never written to a file, never echoed, never built into a command string; it
  reaches the browser as one argv element. Treat a screenshot or a pasted log of that pane
  like the session cookie itself.
- **Only a loopback URL is opened.** A ready line naming anything but `127.0.0.1`, `::1` or
  `localhost` is refused and reported instead of opened.

## Manual path and uninstall

`npx --yes @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add <bundle>` (with `pnpm` on
`PATH`) installs one bundle by hand, and `remove <bundle>` takes it out.
`scripts\setup\uninstall.bat` / `./scripts/setup/uninstall.sh` removes every bundle this
pack added; both installers prune the retired names `dsh-files` and `dsh-focus` first.

## Troubleshooting

| Symptom | What it means |
|---|---|
| the run launcher says the port is in use | 3080 is taken; use that instance or pass `-Port 3099` |
| the harness dies with `EADDRINUSE 127.0.0.1:3080` | something already answers on 3080 - usually the harness this very session is open in. `vncode` picks a free port of its own, so this only happens when `-Port 3080` was asked for on purpose: drop the flag, or pass another port |
| `scripts\run-web.bat` flashes and closes, or no browser opens | run it from the repo root (the worker reads `.dsh-version.json` there) with `node`/`npx` on `PATH`; the URL is in the app's own output |
| `vncode` says the web launcher is missing | it starts `scripts/run-web.*`, so it must run from its folder: the git archive, or a folder that carries `scripts/` and `.dsh-version.json` beside the binary |
| the app came up in a home you did not expect | that is the ladder in [PATHS.md](PATHS.md): a `-DshHome` you typed is used or refused by name, a writable inherited `DSH_HOME` is joined, and otherwise the app creates `$VNCODE_HOME/home`. `vncode status` names the path, the reason, and every candidate it refused |
| the app's own data is somewhere you did not expect | `$VNCODE_HOME` names it. The default is the platform's per-user data directory plus `vncode`; `<tree>\.vncode` is used only when even that cannot be written (a workspace-scoped confinement) |
| no browser opens | the launcher's own log says which rung took the page, and the URL is printed either way, so it can be pasted into a browser by hand. `-DefaultBrowser` skips Chrome |
| `Permission denied` on a `.sh` | `chmod +x scripts/*.sh` |
| an edited plugin never appears after a refresh | it should: the host stat-polls every plugin's `client.js` (500 ms) and republishes it, so reload the page - and hard-reload if it still shows the old build, because the index ships no cache headers. A `lib/index.js` change (routes, tools) and any row/profile change DO need a host restart. `document.querySelector('[data-dsh-cmdbar-dock]').dataset.dshCmdbarVersion` names the build a page is running |
