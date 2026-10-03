# Deploying vncode

What a distribution promises, the contract every launcher holds, and what it still
depends on outside itself. [PATHS.md](PATHS.md) is the location map,
[DISTRIBUTE.md](DISTRIBUTE.md) how the folder is assembled, [RELEASE.md](RELEASE.md)
how a release is cut.

## What the current build gets right

| | |
|---|---|
| **One ship list** | `scripts/dist-manifest.txt`, read by both halves, with a tracked check that fails when a bundle under `packages/` is not on it |
| **`-Verify` is a real proof** | copies the folder, installs from the copy into a throwaway home, asserts the profile lists every bundle the folder carries, boots the pinned harness, waits for the ready line and proves the port is free again |

## The launcher contract

| File | Host | Role |
|---|---|---|
| `scripts\install.bat` / `scripts/install.sh` | both | add this folder's bundles to the web profile; no admin, ever |
| `scripts\uninstall.bat` / `scripts/uninstall.sh` | both | remove only what this pack added |
| `scripts\run-web.bat` / `scripts/run-web.sh` | both | start the pinned harness and open it in Chrome (default browser as fallback) |
| `scripts\run-desktop.bat` | Windows | the same harness in the native window |
| `scripts\run-dist.bat` / `scripts/dist.sh` | both | maintainer only - assemble and verify a distribution; not shipped |
| `START-HERE.bat` / `START-HERE.sh` | generated | install, then run - the one file a recipient clicks |

The Windows entry points share one console layer. `adapt.cmd` relaunches into
Windows Terminal when it exists and nothing is already inside one, runs the worker
with `pwsh` 7 when present and Windows PowerShell 5.1 otherwise, and holds the
window open on a double-clicked failure (`-NoPause` / `VNCODE_NOPAUSE=1` never
does); `theme.ps1` prints colour only on a real terminal and never in a redirected
log (`NO_COLOR` always wins). Exit codes are `0` success, `1` own failure or usage
error and `2` a missing prerequisite - and every file answers `-Help`, `--help`, `-h`
and `/?` with the same text. The POSIX halves mirror the behaviour in plain `/bin/sh`,
never PowerShell, and nothing ever asks for elevation.

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

What the shell launches, and what the browser launchers do. `scripts/dsh/vendor.ps1`
materialises `runtime/<rid>/{node,harness,VENDOR.json}` once, and `choose_launch()` in
`app/src-tauri/src/main.rs` prefers it: `node runtime/<rid>/node/node[.exe]
runtime/<rid>/harness/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port N`,
with no npm, no npx, no cache and no network at start-up. All three pieces must be
present or it falls back to `npx --yes @deepseek-ai/dsh@<pin> web`, and the browser
launchers (`scripts\run-web.bat` / `run-web.sh`) call npx directly today.

`runtime/` is a distribution tree, never a repository tree: gitignored and absent from a
clone, so a checkout takes the npx path and everything works as it does today.

## The intended shape

Each rung is independently verifiable, and the target is **L2**: **L1** vendors the
harness closure into the folder so the profile's junctions point inside it and the npm
cache leaves the map; **L2** vendors a Node runtime per RID, checksum-verified against
the official `SHASUMS256.txt` with npm/npx/corepack trimmed, so a machine with nothing
installed can run the folder; **L3** vendors pnpm and pins its store inside `$DSH_HOME`.
Native modules (`node-pty`, `sharp`, `koffi`) must be installed on the target OS, so the
closure is built per OS rather than copied between them. `-Offline` does not exist yet:
when a rung lands, the gate is `-Verify` with the network closed on purpose, so a warm
cache cannot hide the dependency.

## Deferred and open
- **Deferred**: `-Quiet`, and colour parity inside the POSIX workers' own messages.
- **Open**: macOS double-click wrappers (`.command`); signing and notarization; a
  single portable archive for every RID; whether Windows Terminal should always win
  over a user's chosen default console.
- Nothing in `packages/` learns that a distribution exists, and optional host engines
  (a TeX engine, poppler/mutool/Ghostscript and tesseract, ffmpeg) stay optional and
  degrade in a sentence when absent.