# Deploying vncode

What a distribution is, the contract every launcher holds, and what it still depends on
outside itself. [PATHS.md](PATHS.md) is the location map, [INSTALL.md](INSTALL.md) the
steps, [RELEASE.md](RELEASE.md) how a release is cut and [BUILD.md](BUILD.md) how it runs.

**A distribution is this repository.** There is no second thing to deploy beside it: the
pack, the launchers and the docs are the same files on every platform, they need Node.js
24.9+ with `npx` and nothing else, and there is nothing to build or ship.

## What the distribution gets right

| | |
|---|---|
| **One artefact** | `vncode-<version>.zip`, a `git archive` of the repository at the tag. Unzip it and you have the whole distribution |
| **Nothing per OS** | nothing is compiled, so nothing can be compiled wrong for a host. The same zip runs on Windows, macOS and Linux |
| **The launcher is the interface** | `scripts\run-web.bat` / `./scripts/run-web.sh` runs the pinned harness, reads its ready line and opens that URL in Chrome. It needs no other file |
| **Install is its own entry point** | `scripts\setup\install.bat` / `install.sh` adds the bundles once, and `run-web` only nags when the profile lacks them - it never installs |
| **`check-scripts.mjs` drives the entry points** | the `scripts/` layout, the console contract every Windows entry point must hold, and each entry point's own `-Help` - `run-web.*` answers it without starting the harness, and the setup pair answers it without installing anything |

## The launcher contract

| File | Host | Role |
|---|---|---|
| `scripts\setup\install.bat` / `scripts/setup/install.sh` | both | add this folder's bundles to the web profile, once; no admin, ever |
| `scripts\setup\uninstall.bat` / `scripts/setup/uninstall.sh` | both | remove only what this pack added |
| `scripts\run-web.bat` / `scripts\run-web.ps1` | Windows | start the pinned harness and open it in Chrome (default browser as the fallback) |
| `scripts/run-web.sh` | macOS / Linux | the same, in POSIX `sh` |
| `scripts\console\adapt.cmd` + `theme.ps1` / `theme.sh` | both | the shared console layer (see below) |
| `scripts\tools\*` | maintainer only | the fork re-sync for the client bundles this pack vendors |

Everything under `scripts/` that is not one of those entry points lives in a folder:
`setup/` (install, uninstall and their workers), `console/` (the shared layer), `tools/`
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

**One trap, and every entry point respects it.** The console layer marks a run it has set
up with `VNCODE_CONSOLE=1`, and an entry point that sees the marker keeps the arguments
from the relaunched shell instead of its own `%*`. That is why an entry point forwards
`%VNCODE_ARGS%` and never `%*`, and why `adapt.cmd` must not `setlocal`. Measured, not
assumed: without it, `install.bat -Help` ran a full install.

## What a distribution still depends on

The profile is a set of live links into the npm/npx cache, so a folder that carries the
pack is not made self-contained by copying it: moving it does not move the installation,
`npm cache clean --force` (or another `npm_config_cache`) leaves every link dangling, and
the cache grows about **223 MB per pin, per user**. Installing needs the network twice -
`npx @deepseek-ai/dsh@<pin>` downloads that closure on first run, and the installer
bootstraps pnpm into `./tools` with the npm that ships with Node.js, because
`dsh plugin add` runs pnpm underneath. The target machine needs **Node.js 24.9+**, and
Windows needs PowerShell, which ships with it.

The launcher sets what it can of this. A portable folder points `npm_config_cache` at
`<tree>/.vncode/npm-cache` unless the caller set one, so neither the harness nor its cache
lands in the user's profile.

## Deferred

- Colour parity inside the POSIX workers' own messages.
- macOS double-click wrappers (`.command`).

Nothing in `packages/` learns that a distribution exists, and optional host engines (a TeX
engine, poppler/mutool/Ghostscript and tesseract, ffmpeg) stay optional and degrade in a
sentence when absent.
