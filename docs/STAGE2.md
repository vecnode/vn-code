# Stage 2 - the self-contained build

This supersedes §1-3 of `BUILD.md` for stage 2. Everything here was **measured on
2026-10-01** on this machine, and the measurement scripts are kept so each number
can be reproduced:

| Script | What it proves |
|---|---|
| `.scratch/measure-dsh.ps1` | the production closure and its size |
| `.scratch/measure-prunable.ps1` | what is foreign-arch or non-runtime |
| `.scratch/test-boot-without-libreoffice.ps1` | the boot test that gates a removal |

## The decision

**ONE `.exe`, fully offline. The network is for the chat and search only - never
to start the application.** LibreOffice IS bundled, on purpose, so office
documents stay editable. The payload is shipped **whole**: no trimming, nothing
removed, so nothing can be missing.

## What ships, measured

| | Raw | Compressed |
|---|---|---|
| `@deepseek-ai/dsh` production closure | 463.0 MB / 26 646 files | ~150 MB |
| `node.exe` (pinned runtime) | 81.6 MB | 31.2 MB |
| **one `.exe`** | 544.6 MB | **~176 MB** |

The deflate ratio is **32.4%**, measured by actually compressing the 461.5 MB
tree (149.7 MB, 556 s) and separately compressing `node.exe` (38%). Today's
distribution is 15.4 MB, so this is ~11x - accepted deliberately.

**`--omit=dev` saves nothing.** The production closure measured 461.5 MB / 26 642
files, the SAME as the maintainer's development tree. 461 MB *is* what `dsh web`
needs; there is no dev-only fat to drop.

## The finding that shapes the design

Booting the pinned harness against a **completely empty `DSH_HOME`** produced a
ready line, and across the whole transcript the strings `npm`, `npx`, `pnpm`,
`registry` and `install` appeared **zero times**. It created, on its own:

```text
profiles/web/package.json         2 bundles: @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app
profiles/web/cordis.yml
profiles/web/cordis.patch.yml
profiles/web/pnpm-workspace.yaml
```

**No `node_modules`. No dependencies. No package manager. 9 files, ~0 MB.**

The profile is a *patch layer*, not an installation: its bundles resolve from the
harness's own tree. Two consequences:

1. **No pnpm is needed at runtime.** `tools/pnpm<N>/` and the npm cache exist
   only for `dsh plugin add`, which is an INSTALL-TIME action, not a boot-time
   one. Bundling them is optional, and shipping `npx` satisfies the "inside, not
   fetched" requirement either way - nothing will ever call it at boot.
2. **`node <runtime>/…/bin.js web --no-open --port N` is the whole launch.** That
   is exactly how this session runs today:

   ```text
   "node" "...\_npx\7eff65a5cfe9d1d1\node_modules\.bin\..\@deepseek-ai\dsh\lib\bin.js" web --no-open --port 3080
   ```

   Note the cache it reads from: `%LOCALAPPDATA%\vncode\npm-cache`, the
   app-local cache introduced in `payload::npm_cache_dir`. The cache fix is
   already live in production.

## The architecture this forces

The current split is **install and run are separate, and the shell only RUNS** -
`app/src-tauri/src/main.rs` never installs anything; it *warns* when the profile
does not list the pack (`Run scripts\install.bat first if you expected…`). The
pre-built profile keeps that property rather than fighting it:

```text
BUILD TIME (maintainer)
  scripts/dsh/vendor        resolve the pinned Node + the FULL closure (with
                            LibreOffice) into the runtime cache, hash-verified
  compose the profile       profiles/web + the 18 pack bundles as live links
  package                   the folder, the zip, and the one-file .exe

FIRST RUN (recipient)
  unpack                    → %LOCALAPPDATA%\vncode\<version>-<rid>\
  copy the shipped profile  → $DSH_HOME\profiles\web          (only if absent)
  boot                      node <runtime>\bin.js web --no-open --port <free>

EVERY LATER RUN
  reuse the unpacked folder (payload identity, already in payload.rs)
  boot                       no copy, no install, no npm, no pnpm, no network
```

**The profile is the only thing the recipient's machine has to be taught**, and
it is ~9 files. `$DSH_HOME` keeps every session, setting and credential, exactly
as it does today.

## Work items

Status is recorded here rather than in a commit message, because the whole point
of this file is that a reader can tell what is real from what is planned.

| # | Work | Status |
|---|---|---|
| 1 | `scripts/dsh/vendor.ps1`: materialise the pinned Node and the harness closure into `runtime/<rid>/{node,harness}` + `VENDOR.json` | **DELIVERED.** Local-first (it found and copied the tree this machine already had, so no download and no network), and it stamps ONLY after running the pair and watching it report a version |
| 2 | `main.rs`: `choose_launch()` / `vendored_runtime()` - launch `node <bin.js> web`, **no npx**; npx only as the source-checkout fallback | **DELIVERED in source; `cargo check` passes.** Not yet LINKED: cargo cannot replace `vncode-desktop.exe` while the running app holds it open, so it takes effect on the first rebuild after the window is closed |
| 3 | `payload.rs`: assemble the one-file `.exe` from shell + Node + closure + profile | **NOT STARTED.** This is what remains |
| 4 | `payload.rs`: first-run bootstrap - copy the shipped profile when absent | **NOT STARTED.** The behaviour is proven (an empty `DSH_HOME` bootstraps itself, see below) but the packaging is not written |
| 5 | Manifest + `check-dist-layout.mjs`: carry `runtime/` into the distribution | **NOT STARTED.** `dist/` was deleted as stale precisely because it does not carry the runtime yet |
| 6 | Zip at `CompressionLevel Optimal`, one-file build ~176 MB | **NOT STARTED** (depends on 3) |

### Delivered so far, and verified

```text
vendored pair reports        0.2.0-rc.2   (exit 0)
boots to a ready line        http://127.0.0.1:54872/
occurrences in transcript    npm 0   npx 0   pnpm 0   EPERM 0
runtime                      26,645 files, 544.2 MB
```

The runtime is accepted only when **all three** pieces exist - the Node, the
harness entry point and the stamp - because a half-copied runtime that the shell
resolved would report a broken install instead of falling back to the path that
works.

One measurement worth carrying forward: `Copy-Item -Recurse` over 26 644 files
returned in ~18 s with the tree complete, but a run was caught failing its own
verification against a **216 MB partial copy**. `vendor.ps1` therefore waits for
the destination's file count to stop changing before it checks anything.

### What is NOT in stage 2

- **Trimming** - explicitly out. The payload ships whole.
- **Signing** - already wired behind `-Sign` and off by default; it moves to
  stage 3 alongside the manifest and `VERSIONINFO`.
- **The CI workflow** - **removed, not parked.** There is no CI: Actions is
  disabled on the repository and the tracked check *fails* if a workflow directory
  comes back. A release is cut by hand (`docs/RELEASE.md`) and compiles nothing.

## Cost, stated plainly

- the `.exe` is ~176 MB instead of 15.4 MB;
- building it resolves 26 646 files and compresses ~545 MB, so a build is minutes,
  not the 9 s a folder-only build takes today - which is why the runtime lives at
  `runtime/<rid>/` **outside** `dist/` (a clean build wipes `dist/`, and a 545 MB
  cache inside it would be re-resolved on every rebuild);
- the unpacked folder on disk is ~545 MB, the same as today's `npx` cache.

## Reproducing the numbers

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .scratch\measure-dsh.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .scratch\measure-prunable.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .scratch\test-boot-without-libreoffice.ps1
```

`test-boot-without-libreoffice.ps1` is kept even though LibreOffice now ships: it
is the method that proves a removal is safe (park the thing, boot, read the ready
line), and any future "can we drop X?" question starts there.
