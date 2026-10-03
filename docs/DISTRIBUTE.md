# Building a vncode distribution

A distribution is **one folder you can click** and a **zip of it**, with no
compiled file in it: the plugin pack, the launchers and the shell's source. A
release is three of those zips, one per operating system, cut by hand - there is
no CI ([RELEASE.md](RELEASE.md) is the whole ritual).

| | Windows | macOS / Linux |
|---|---|---|
| **Build it** | double-click `scripts\run-dist.bat` | `./scripts/dist.sh` |
| **The work** | `scripts/run-dist.ps1` -> `scripts/dist.ps1` | `scripts/dist.sh` |
| **Help** | `scripts\run-dist.bat -Help` | `./scripts/dist.sh -Help` |
| **A release** | `scripts\run-dist.bat -NoShell -Verify -Clean` | `sh scripts/dist.sh -NoShell -Verify -Clean` |

`dist/vncode-<version>-<os>/` is the folder you click and its `.zip` the artifact
beside it. Inside: generated `START-HERE.bat` / `START-HERE.sh`, `DIST-README.txt`,
`BUILD-INFO.json`, `SHA256SUMS.txt`; `.dsh-version.json` (the pin the launcher
reads); `packages/`, `scripts/` and its `console/`; `app/` as SOURCE; `docs/`,
`assets/vncode.svg`, `README.md`, `LICENSE`, `SECURITY.md`.

`<os>` is `win`, `mac` or `linux`; `<version>` is `package.json`'s version unless
`-Version` overrides it. There is no architecture in the name: the payload is
OS-neutral, so **one assembly is what all three OS releases download**, and a
source release has no `.exe` or `.run` - there is no compiled file to append to.

## What ships, and what never does

`scripts/dist-manifest.txt` is the one list, read by both halves; skip rules win,
and `check-dist-layout.mjs` fails when the list and `packages/` disagree.

| Ships | Never ships |
|---|---|
| `packages/`, `scripts/` (minus the right column), `docs/`, `app/` as source, `assets/vncode.svg`, `.dsh-version.json`, `README.md`, `LICENSE`, `SECURITY.md` | `node_modules/` (the `packages/*/vendor` trees are 200 MB of build inputs), `app/src-tauri/target/` and `gen/`, `tools/`, `.scratch/`, `.git/`, `dist/`, `docs/diagrams/` |
| the entry points, the workers and `scripts/console/` (`adapt.cmd`, `theme.ps1`, `theme.sh`) | the distributer (`run-dist.bat`, `run-dist.ps1`, `dist.ps1`, `dist.sh`), `scripts/checks/`, `scripts/sync-vendored.ps1`, `scripts/make-desktop-icon.mjs` |
| - | `.env`, `.env.*`, `*.pem`, `*.key`, `.credentials.yaml`, `*.log`, `.DS_Store`, `Thumbs.db`, `desktop.ini` |

## Local use

Every run prints the folder and the archive to click. `-NoShell` is the release
mode; `-SkipBuild` reuses a binary under `app/src-tauri/target/release`; `-OutDir
<dir>` assembles beside `dist/` (needed while a distribution is running, since
Windows will not let a live binary be overwritten); `-Run` assembles and runs the
folder's own `START-HERE`. `check-dist-layout.mjs` and `check-no-secrets.mjs` run
first, and `Assert-NoSecrets` re-scans what shipped; `-SkipChecks` builds anyway.

`scripts/dist.ps1` writes a build fingerprint recording the shell hash, the
version, the ship list, the last commit **and a sha256 plus byte length for every
shipped file**; the next run reuses the folder and zip only when all of those still
match, in both directions, so an edit is caught even when its size and timestamp
are unchanged. `-Clean` rebuilds from scratch.

`-Verify` is the release check: it copies the folder to a temp directory and runs
that copy's own installer against a throwaway `DSH_HOME` (the copy is the thing
being promised, and this also asserts the profile lists every bundle the folder
carries), boots the pinned harness, waits up to 180 s for the
`dsh web: http://127.0.0.1:<port>/?token=...` ready line, stops the process tree,
proves the port is free again, and prints the URL with **`token=REDACTED`** -
refusing a ready line that does not name a loopback address. The throwaway home is
deleted afterwards; `-KeepVerifyHome` keeps it.

## Limits and failures

- **No compiled binary ships**: the native window is a `cargo build` away from the
  shipped source, and the browser path (`START-HERE` -> `scripts/run-web`) needs
  only Node.js 22+ and, on the first run, the network for the pinned harness.
- **Unsigned zips, no installers**: `tauri.conf.json` keeps `bundle.active: false`;
  a distribution is a snapshot, and optional host engines (TeX, tesseract, ffmpeg)
  are neither shipped nor required - the plugins degrade in a sentence without them.

| Symptom | What it means |
|---|---|
| `cargo was not found on PATH` | binary mode: install Rust, pass `-SkipBuild`, or use `-NoShell` |
| `cargo build failed ..., and vncode is RUNNING` | Windows locks a running binary; close the window or pass `-SkipBuild` |
| `The assembled distribution is missing: ...` | the copy lost a file - the sentinel guard fired |
| `npm error code EPERM` during `-Verify` | npm writes to a cache outside the folder: point `npm_config_cache` at `%CD%\.scratch\npm-cache` |
| no `dsh web:` ready line within 180 seconds | no network on the first `npx` run, an unwritable `DSH_HOME`, or a profile problem |

[RELEASE.md](RELEASE.md) cuts a release; [BUILD.md](BUILD.md) has the distributer's
flags, the runtime and signing; [app/README.md](../app/README.md) is the shell;
[scripts/checks/README.md](../scripts/checks/README.md) lists every check.
