# Deploying vncode

What a distribution promises, the contract every launcher holds, and what it still depends
on outside itself. [PATHS.md](PATHS.md) is the location map, [RELEASE.md](RELEASE.md) how a
release is cut, [BUILD.md](BUILD.md) how the app is built.

**A distribution is two artefacts, and they are independent.**

| | | |
|---|---|---|
| **the web half** | this repository - the pack, the launchers, the console layer | runs with Node.js 22+ and nothing else. `scripts\run-web.bat` / `./scripts/run-web.sh` opens the browser interface on its own |
| **the app** | one small `vncode` per OS (~0.5 MB) | a front door: decide the home, take the key, install the pack, then run the web half |

Neither needs the other. The app adds "one command to a working instance"; dropping it
beside the web half changes nothing about how the harness is launched, because the app
calls the same `scripts/run-web.*` and passes it `-DshHome`.

## What the build gets right

| | |
|---|---|
| **The app installs the pack** | `vncode install` (and a plain `vncode start` over a home that lacks it) runs `scripts/setup/install.*` - the same entry point a person clicks - in the app's own console, with the composed environment and `-DshHome <the home it chose>` |
| **The app never draws the interface** | no `wry`, no WebView2 / WKWebView / WebKitGTK, no `egui`, no window. The page is the harness's and it opens in the browser the launcher found |
| **The web half stands alone** | `check-shell.mjs` runs `scripts/run-web.* -Help` with no binary involved, and it must answer |
| **`check-scripts.mjs` drives the entry points** | the layout, the console contract, `setup/install.bat -Help` and `setup/uninstall.bat -Help` (which install nothing), and the two release workflows |
| **`check-shell.mjs` drives the app** | the verbs, `-Mode embed` refused by name, and `start` against **stub scripts** in a throwaway tree: the installer is run because the home lacks the pack, the launcher is handed `-DshHome`, `-NoTerminal` and a composed environment, and the app's own root and the console markers are absent from the child |

## The launcher contract

| File | Host | Role |
|---|---|---|
| `scripts\setup\install.bat` / `scripts/setup/install.sh` | both | add this folder's bundles to the web profile; no admin, ever |
| `scripts\setup\uninstall.bat` / `scripts/setup/uninstall.sh` | both | remove only what this pack added |
| `scripts\run-web.bat` / `scripts/run-web.sh` | both | start the pinned harness and open it in Chrome (default browser as fallback) |
| `scripts\run-desktop.bat` / `scripts/run-desktop.sh` | both | build `vncode` when there is none and run it; it decides nothing about the instance itself |
| `scripts\console\adapt.cmd` + `theme.ps1` / `theme.sh` | both | the shared console layer (see below) |
| `scripts\tools\*` | maintainer only | the fork re-sync for the client bundles this pack vendors |

Everything under `scripts/` that is not one of those entry points lives in a folder:
`setup/` (install and uninstall), `console/` (the shared layer), `tools/`
(maintainer-only) and `checks/`. `check-scripts.mjs` fails on a stray file at the top
level, because "what I run" and "what it uses" must be tellable apart at a glance.

The Windows entry points share one console layer: `adapt.cmd` relaunches into Windows
Terminal when it exists and nothing is already inside one, runs the worker with `pwsh` 7
when present and Windows PowerShell 5.1 otherwise, and holds the window open on a
double-clicked failure (`-NoPause` / `VNCODE_NOPAUSE=1` never does); `theme.ps1` prints
colour only on a real terminal and never in a redirected log (`NO_COLOR` always wins). Exit
codes are `0` success, `1` own failure or usage error and `2` a missing prerequisite. The
POSIX halves mirror the behaviour in plain `/bin/sh`, never PowerShell, and nothing ever
asks for elevation.

**One trap, and every child of the app clears it.** The console layer marks a run it has
set up with `VNCODE_CONSOLE=1`, and an entry point that sees the marker keeps the arguments
from the relaunched shell instead of its own `%*`. The app is started BY that layer, so it
inherits the marker: `vn_shell_runtime::env` removes it (and `VNCODE_HOME`) from the
environment of the installer **and** the launcher. Measured, not assumed - without it,
`install.bat -Help` ran a full install - and `check-shell.mjs` reads the child's own answer
back.

## What a distribution still depends on

The profile is a set of live links into the npm/npx cache, so a folder that carries the
pack is not made self-contained by copying it: moving it does not move the installation,
`npm cache clean --force` (or another `npm_config_cache`) leaves every link dangling, and
the cache grows about **223 MB per pin, per user**. Installing needs the network twice -
`npx @deepseek-ai/dsh@<pin>` downloads that closure on first run, and the installer
bootstraps pnpm into `./tools` (about **13 MB**) because `dsh plugin add` spawns `pnpm`
from `PATH`. The target machine needs **Node.js 22+**, and Windows needs PowerShell, which
ships with it.

The app composes what it can of this. It picks an npm cache by writing where npm really
writes (`<cache>/_cacache/tmp`), hands the child a writable temp when the machine's is
refused, and puts the vendored runtime's `node` first on `PATH` when a folder carries one.

## Deferred and open

- **Deferred**: colour parity inside the POSIX workers' own messages; macOS double-click
  wrappers (`.command`); signing and notarization of the binaries.
- **Open**: whether the app should keep a cache of its own between runs; whether
  `vncode open` (a second tab for a running instance) is worth the URL it would need.
- Nothing in `packages/` learns that a distribution exists, and optional host engines (a
  TeX engine, poppler/mutool/Ghostscript and tesseract, ffmpeg) stay optional and degrade
  in a sentence when absent.
