# Installing vncode (Windows, macOS, Linux)

| | Windows | macOS / Linux |
|---|---|---|
| **Install** | `scripts\install.bat` | `./scripts/install.sh` |
| **Run** | `scripts\run-web.bat` | `./scripts/run-web.sh` |
| **Remove** | `scripts\uninstall.bat` | `./scripts/uninstall.sh` |

Double-click the `.bat` files on Windows; run the `.sh` files from anywhere (each
resolves the repository root from its own location). Every entry point, its worker
and the shared console layer live in `scripts/`; the repository root carries no
`.bat` and no `.sh`.

| | |
|---|---|
| Requirements | **Node.js 22+** on every platform; **Windows** uses Windows PowerShell 5.1 (shipped) or PowerShell 7, **macOS / Linux** a POSIX shell and never PowerShell; `pnpm` is reused when the system copy is new enough, else bootstrapped into `./tools` |
| Install target | the **web profile** only, `$DSH_HOME/profiles/web` (`$DSH_HOME` = env var, else `~/.dsh`). `-Target web` and `-Target cli` both mean it; there is no desktop target. Overrides: `-DshHome <home>`, `-ProfileName <profile>` |
| State | model credentials in `$DSH_HOME/.credentials.yaml`; sessions, settings, attachments and the pack's own caches under the same home |

## Launchers

On Windows each entry point calls the PowerShell worker beside it (`install.bat`
-> `install-all.ps1`, `uninstall.bat` -> `uninstall-all.ps1`, `run-web.bat` ->
`run-web.ps1`), and `run-desktop.bat` opens the same pinned harness in a native
window. The POSIX `.sh` files do the work themselves and need Node.js with npm/npx
only. Direct calls: `powershell -NoProfile -ExecutionPolicy Bypass -File
scripts\install-all.ps1 -Force` and `sh scripts/install-all.sh -Force` (the same
with `uninstall-all.*` and `run-web.*`).

Flags on both halves: `-Force`, `-Plugin <name>`, `-DshHome`, `-ProfileName`,
`-DshVersion`, `-Target web|cli`, `-NoPause`, and `-NoTerminal` on Windows;
`-Help`, `-h`, `--help` and `/?` print the usage. The `-all` in a worker's name
means it installs **every bundle the pack carries**; `-Plugin` narrows it to one.

The Windows entry points share `scripts\console\`: `adapt.cmd` relaunches into
Windows Terminal when it exists and nothing is already inside one (`-NoTerminal`
or `VNCODE_NO_WT=1` opts out), runs the worker with `pwsh` 7 when present and
Windows PowerShell 5.1 otherwise, and holds the window open on a double-clicked
failure (`-NoPause` / `VNCODE_NOPAUSE=1` never pauses). `theme.ps1` / `theme.sh`
own the colour policy: colour only on a real terminal, never in a redirected log,
`NO_COLOR` always wins. Exit codes: `0` success, `1` own failure or usage error, `2` a
missing prerequisite (no PowerShell, no Node). Nothing asks for administrator rights.

## Running it

`scripts\run-web.bat` / `./scripts/run-web.sh` starts the pinned harness with the
browser hand-off attached. Flags: `-Port <n>`, `-DshHome <dir>`, `-DshVersion
<ver>`, `-NoBrowser` (server only), `-DefaultBrowser` (skip Chrome). It runs
`npx --yes @deepseek-ai/dsh@<pin> web --no-open` (plus `--port <n>`), streams the
app's own output, watches for the ready line
`dsh web: http://127.0.0.1:<port>/?token=<launch token>` and opens **that** URL in
Google Chrome (`PATH`, the standard install folders, Windows' `App Paths`,
`/Applications/Google Chrome.app`, `google-chrome`/`chromium`), falling back to
the platform default browser. It stays in the foreground: Ctrl+C stops it and the
terminal prints the app's exit status.

- **The launch token is a live credential.** It is read from the app's output in
  memory only - never written to a file, never echoed, never built into a command
  string; it reaches the browser as one argv element. Treat a screenshot or a
  pasted log of that pane like the session cookie itself.
- **Only a loopback URL is opened.** A ready line naming anything but `127.0.0.1`,
  `::1` or `localhost` is refused and reported instead of opened.

## Manual path and uninstall

`npx --yes @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add <bundle>` (with
`pnpm` on `PATH`) installs one bundle by hand, and `remove <bundle>` takes it out.
`scripts\uninstall.bat` / `./scripts/uninstall.sh` removes every bundle this pack
added; both installers prune the retired names `dsh-files` and `dsh-focus` first.

## Troubleshooting

| Symptom | What it means |
|---|---|
| the run launcher says the port is in use | 3080 is taken; use that instance or pass `-Port 3099` |
| `scripts\run-web.bat` flashes and closes, or no browser opens | run it from the repo root (the worker reads `.dsh-version.json` there) with `node`/`npx` on `PATH`; the URL is in the app's own output |
| `Permission denied` on a `.sh` | `chmod +x scripts/*.sh` |
| an edited plugin never appears after a refresh | the host snapshots every `client.js` at boot: restart the process serving the page, then reload |
