# Installing vncode (Windows, macOS, Linux)

| | Windows | macOS / Linux |
|---|---|---|
| **Install** | `scripts\setup\install.bat` | `./scripts/setup/install.sh` |
| **Run** | `scripts\run-web.bat` | `./scripts/run-web.sh` |
| **Remove** | `scripts\setup\uninstall.bat` | `./scripts/setup/uninstall.sh` |

Double-click the `.bat` files on Windows; run the `.sh` files from anywhere (each resolves
the repository root from its own location). A fresh machine runs **install once, then
`run-web`** - the two are separate entry points on purpose, so starting the harness never
rewrites a profile. Neither needs an administrator.

`scripts/` carries the three entry points a person runs (`run-web.bat`, `run-web.ps1`,
`run-web.sh`) at its top level, and everything else in a folder: `setup/` (install and
uninstall, with their workers), `console/` (the shared console layer), `tools/`
(maintainer-only) and `checks/`. The repository root carries no `.bat` and no `.sh`.

| | |
|---|---|
| Requirements | **Node.js 24.9+** on every platform, with `npx`. **Windows** runs the launcher on Windows PowerShell 5.1 (shipped) or PowerShell 7; **macOS / Linux** uses a POSIX shell and never PowerShell |
| Install target | the **web profile** only, `$DSH_HOME/profiles/web` (`$DSH_HOME` = env var, else the portable root below, else `~/.dsh`). Overrides: `-DshHome <home>`, `-ProfileName <profile>` |
| State | the DeepSeek key in `$DSH_HOME/.env` or `$DSH_HOME/.credentials.yaml`; sessions, settings, attachments and the pack's own caches under the same home |

## Launchers

On Windows each entry point calls the worker beside it (`install.bat` ->
`install-all.ps1`, `uninstall.bat` -> `uninstall-all.ps1`, `run-web.bat` ->
`run-web.ps1`). The POSIX `.sh` files do the work themselves and need Node.js with
npm/npx only. Direct calls: `powershell -NoProfile -ExecutionPolicy Bypass -File
scripts\setup\install-all.ps1 -Force` and `sh scripts/setup/install-all.sh -Force` (the
same with `uninstall-all.*` and `run-web.*`).

Flags on both halves: `-Force`, `-Plugin <name>`, `-DshHome`, `-ProfileName`,
`-DshVersion`, `-NoPause`, and `-NoTerminal` on Windows; `-Help`, `-h`, `--help` and `/?`
print the usage. The `-all` in a worker's name means it installs **every bundle the pack
carries**; `-Plugin` narrows it to one.

The Windows entry points share `scripts\console\`: `adapt.cmd` relaunches into Windows
Terminal when it exists and nothing is already inside one (`-NoTerminal` or
`VNCODE_NO_WT=1` opts out), runs the worker with `pwsh` 7 when present and Windows
PowerShell 5.1 otherwise, and holds the window open on a double-clicked failure
(`-NoPause` / `VNCODE_NOPAUSE=1` never pauses). `theme.ps1` / `theme.sh` own the colour
policy: colour only on a real terminal, never in a redirected log, `NO_COLOR` always wins.
Exit codes: `0` success, `1` own failure or usage error, `2` a missing prerequisite (no
PowerShell, no Node). Nothing asks for administrator rights.

`adapt.cmd` marks a run it has set up with `VNCODE_CONSOLE`, and an entry point that sees
the marker takes its arguments from the relaunched shell rather than its own `%*` - which
is why an entry point forwards `%VNCODE_ARGS%` and never `%*`. Measured, not assumed:
without that rule, `install.bat -Help` ran a full install.

## Which home a run uses

Both workers implement the same ladder, in this order:

| # | candidate | when it is used |
|---|---|---|
| 1 | `-DshHome <dir>` | the person named it for this run |
| 2 | an inherited `DSH_HOME` | a harness session started this shell, and the run JOINS it |
| 3 | **`<tree>/.vncode/home`** | this folder is a **portable installation**: it carries the `PORTABLE` marker, or it already holds a `home` folder. The pack, the sessions and the key then need nothing in the user's profile |
| 4 | `~/.dsh` | the harness's own default, for a folder that is not portable |

`run-web` prints the home it chose and **only nags** when the profile there does not list
the pack; it never installs. [PATHS.md](PATHS.md) is the full map.

## Running it

`scripts\run-web.bat` / `./scripts/run-web.sh` starts the pinned harness with the browser
hand-off attached. Flags: `-Port <n>`, `-DshHome <dir>`, `-DshVersion <ver>`, `-NoBrowser`
(server only), `-DefaultBrowser` (skip Chrome). It runs `npx --yes
@deepseek-ai/dsh@<pin> web --no-open` (plus `--port <n>`), streams the harness's own
output, watches for the ready line `dsh web: http://127.0.0.1:<port>/?token=<launch token>`
and opens **that** URL in Google Chrome - `PATH`, then the standard install folders, then
the `App Paths` registry on Windows; `open -a 'Google Chrome'` then
`google-chrome`/`chromium` on macOS and Linux - falling back to the platform default
browser. It stays in the foreground: Ctrl+C stops it and the terminal prints the harness's
exit status.

- **The launch token is a live credential.** It is read from the harness's output in memory
  only - never written to a file, never echoed, never built into a command string; it
  reaches the browser as one argv element. Treat a screenshot or a pasted log of that pane
  like the session cookie itself.
- **Only a loopback URL is opened.** A ready line naming anything but `127.0.0.1`, `::1` or
  `localhost` is refused and reported instead of opened.

## The DeepSeek key

There is no key prompt: the harness resolves the key itself, in this order - `DEEPSEEK_API_KEY`
in the environment, then a `.env` beside where the launcher was started, then
`<home>/.env`. Two ways to give it one:

- in the harness UI, under **Settings > Models**;
- or by putting the line `DEEPSEEK_API_KEY=...` in `<home>/.env`.

## Manual path and uninstall

`npx --yes @deepseek-ai/dsh@<pin> plugin --profile web add <bundle>` installs one bundle by
hand, and `remove <bundle>` takes it out.
`scripts\setup\uninstall.bat` / `./scripts/setup/uninstall.sh` removes every bundle this
pack added; both installers prune the retired names `dsh-files` and `dsh-focus` first.

## Troubleshooting

| Symptom | What it means |
|---|---|
| the launcher says the port is in use | 3080 is taken; use that instance or pass `-Port 3099` |
| the harness dies with `EADDRINUSE 127.0.0.1:3080` | something already answers on 3080 - usually the harness this very session is open in. Pass another port |
| `scripts\run-web.bat` flashes and closes, or no browser opens | run it from a folder that carries `scripts/` and `.dsh-version.json` with `node`/`npx` on `PATH`; the URL is in the harness's own output |
| a run started against a home you did not expect | that is the ladder above: a `-DshHome` you typed wins, an inherited `DSH_HOME` is joined, then the portable root, then `~/.dsh`. `run-web` prints the one it chose |
| `Permission denied` on a `.sh` | `chmod +x scripts/*.sh scripts/setup/*.sh` |
| the profile "does not list this pack" | run the installer once for that home: `scripts\setup\install.bat` / `./scripts/setup/install.sh`, with `-DshHome` if the home is not the default |
| an edited plugin never appears after a refresh | it should: the host stat-polls every plugin's `client.js` (500 ms) and republishes it, so reload the page - and hard-reload if it still shows the old build, because the index ships no cache headers. A `lib/index.js` change (routes, tools) and any row/profile change DO need a host restart. `document.querySelector('[data-dsh-cmdbar-dock]').dataset.dshCmdbarVersion` names the build a page is running |
