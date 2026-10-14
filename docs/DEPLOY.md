# Deploying vncode

What a distribution promises, the contract every launcher holds, and what it still
depends on outside itself. [PATHS.md](PATHS.md) is the location map,
[RELEASE.md](RELEASE.md) how a release is cut, [BUILD.md](BUILD.md) how the shell is
built.

**A distribution is this repository.** There is no assembler and no ship list any
more: the app beside the pack installs it. So "deploying" means putting the folder
somewhere (or building `app/` and putting `vncode` beside it) and opening the app -
its panel has the Install button.

## What the current build gets right

| | |
|---|---|
| **The app installs the pack** | the panel's **Install pack** / **Uninstall pack** buttons run `scripts/setup/install.*` and `scripts/setup/uninstall.*` - the same entry points a person clicks - with their output streaming into the app's own log, and they are disabled while a harness is running |
| **`check-scripts.mjs` drives them** | the layout, the console contract, and both entry points answering `-Help` (which installs nothing) |
| **`check-shell.mjs` drives the whole path** | the ready line and its refusals, the launch token in no stream and no file, Stop freeing the port and killing the tree, and `install -Help` / `uninstall -Help` through the app's own runner |

## The launcher contract

| File | Host | Role |
|---|---|---|
| `scripts\setup\install.bat` / `scripts/setup/install.sh` | both | add this folder's bundles to the web profile; no admin, ever |
| `scripts\setup\uninstall.bat` / `scripts/setup/uninstall.sh` | both | remove only what this pack added |
| `scripts\run-web.bat` / `scripts/run-web.sh` | both | start the pinned harness and open it in Chrome (default browser as fallback) |
| `scripts\run-desktop.bat` / `scripts/run-desktop.sh` | both | the same harness in the native shell: a control panel that opens idle, starts it on **Start** and ends it on **Stop** |
| `scripts\console\adapt.cmd` + `theme.ps1` / `theme.sh` | both | the shared console layer (see below) |
| `scripts\tools\*` | maintainer only | the vendored-runtime builder, the fork sync, the icon generator |

Everything under `scripts/` that is not one of those entry points lives in a folder:
`setup/` (install and uninstall), `console/` (the shared layer), `tools/`
(maintainer-only) and `checks/`. `check-scripts.mjs` fails on a stray file at the
top level, because "what I run" and "what it uses" must be tellable apart at a
glance.

The Windows entry points share one console layer. `adapt.cmd` relaunches into
Windows Terminal when it exists and nothing is already inside one, runs the worker
with `pwsh` 7 when present and Windows PowerShell 5.1 otherwise, and holds the
window open on a double-clicked failure (`-NoPause` / `VNCODE_NOPAUSE=1` never
does); `theme.ps1` prints colour only on a real terminal and never in a redirected
log (`NO_COLOR` always wins). Exit codes are `0` success, `1` own failure or usage
error and `2` a missing prerequisite - and every file answers `-Help`, `--help`, `-h`
and `/?` with the same text. The POSIX halves mirror the behaviour in plain `/bin/sh`,
never PowerShell, and nothing ever asks for elevation.

**One trap, and the app clears it.** The console layer marks a run it has set up with
`VNCODE_CONSOLE=1`, and an entry point that sees the marker keeps the arguments from
the relaunched shell instead of its own `%*`. The app is started BY that layer, so it
inherits the marker: every console variable is removed from the environment of the
installer it spawns, which puts the entry point back on its first-entry path.
Measured, not assumed - the first version of the Install button ran
`install.bat -NoTerminal -NoPause -Help` and started a full install. `check-shell.mjs`
drives that path, and `check-scripts.mjs` clears the same variables before it runs
either entry point.

## What a distribution still depends on

`$DSH_HOME/profiles/node_modules` is a set of junctions into the npm/npx cache, so
the folder is not self-contained: moving it does not move the installation,
`npm cache clean --force` (or another `npm_config_cache`) leaves every junction
dangling, and the cache grows about **223 MB per pin, per user**. Installing needs
the network twice - `npx @deepseek-ai/dsh@<pin>` downloads that closure on first run,
and the installer bootstraps pnpm into `./tools` (about **13 MB**) because
`dsh plugin add` spawns `pnpm` from `PATH`. The registry itself is never consulted:
`profiles/web/pnpm-lock.yaml` holds only `link:` specs, so a profile install needs
the installation closure and a pnpm - but the target machine needs **Node.js 22+**.

What the shell launches, and what the browser launchers do. `scripts/tools/vendor.ps1`
materialises `runtime/<rid>/{node,harness,VENDOR.json}` once, and `choose_launch()` in
`app/crates/vn-shell-core/src/launch.rs` picks the best of four rungs: the vendored
runtime; the harness this machine ALREADY has, run with the Node on PATH straight from
the npm cache the profile live-links (`node …/@deepseek-ai/dsh/lib/bin.js web
--no-open --port N`, no npm, no network); then `npx --yes @deepseek-ai/dsh@<pin> web`.
The second rung is what a machine with a broken npm cache - or an administrator
prompt - falls to, and it is why Start works without npm at all. The browser
launchers (`scripts\run-web.bat` / `run-web.sh`) still call npx directly.

`runtime/` is a distribution tree, never a repository tree: gitignored and absent from a
clone, so a checkout takes the installed-or-npx path and everything works as it does today.

## The intended shape

Each rung is independently verifiable, and the target is **L2**: **L1** vendors the
harness closure into the folder so the profile's junctions point inside it and the npm
cache leaves the map; **L2** vendors a Node runtime per RID, checksum-verified against
the official `SHASUMS256.txt` with npm/npx/corepack trimmed, so a machine with nothing
installed can run the folder; **L3** vendors pnpm and pins its store inside `$DSH_HOME`.
Native modules (`node-pty`, `sharp`, `koffi`) must be installed on the target OS, so the
closure is built per OS rather than copied between them. A rung is proved by installing
from the folder into a throwaway `DSH_HOME` **with the network closed on purpose**, so a
warm cache cannot hide the dependency - the distributer's `-Verify` used to be that gate
and it left with the distributer, so the next rung has to bring its own.
`scripts/tools/vendor.ps1` builds L2's `runtime/<rid>/` today.

## Deferred and open
- **Deferred**: colour parity inside the POSIX workers' own messages.
- **Open**: macOS double-click wrappers (`.command`); signing and notarization of the
  binary; whether Windows Terminal should always win over a user's chosen default
  console; and a `run-desktop.sh` that finds a system-wide install rather than the
  binary beside the tree.
- Nothing in `packages/` learns that a distribution exists, and optional host engines
  (a TeX engine, poppler/mutool/Ghostscript and tesseract, ffmpeg) stay optional and
  degrade in a sentence when absent.