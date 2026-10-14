# Building vncode

Two verbs, deliberately separate: `scripts\run-desktop.bat` (or
`./scripts/run-desktop.sh`) is the developer loop - build the Rust shell when it is
stale and run it from the source checkout, where the profile's live links already
point; `scripts/checks/` is what says whether the change is sound.

## No JavaScript build step

There is no JavaScript/TypeScript build here; the packages are hand-written:

- `packages/*/lib/client.js` is the shipped browser bundle, loaded by the harness
  as a live link - which is what makes a plugin edit visible on a reload.
- Vendored engines keep their own `vendor/build.mjs` and the tracked hashes in
  `lib/vendor/VERSION.json`. Regenerate them, never hand-edit.
- `app/` is a **cargo workspace** - the shell's crates, each with its own
  `cargo test` - and `scripts/checks/` is the build gate: a build that fails a
  check is not a build.

## The three entry points, and why there is no distributer

| | what it does |
|---|---|
| `scripts\run-web.bat` / `./scripts/run-web.sh` | starts the pinned harness and opens it in a browser tab |
| `scripts\run-desktop.bat` / `./scripts/run-desktop.sh` | builds the shell when it is stale and runs it: the control panel that starts, watches and stops the harness |
| `scripts\setup\install.bat` / `./scripts/setup/install.sh` | adds this folder's bundles to the `web` profile - and the same pair under `uninstall` takes them out again |

There is no `dist.ps1`, no `run-dist.*` and no ship list. **The distribution is
this repository** (or this repository plus a built `vncode`), because the app
installs the pack itself: the panel's Install and Uninstall buttons run the two
`setup/` entry points above, with their output streaming into the app's own log.
`check-scripts.mjs` asserts the layout and drives both of them with `-Help`, which
installs nothing.

A folder that carries a built binary beside it needs neither Rust nor a build step:
`run-desktop.*` runs what is there. `scripts/run-web.*` needs only Node.js 22+.

## Runtime and launch path

`scripts/tools/vendor.ps1` produces a complete vendored runtime under
`runtime/<rid>/` (`node/`, `harness/`, `VENDOR.json`) from the pinned tree the
machine already has, falling back to the registry only when nothing local carries
the pin. `choose_launch()` in `app/crates/vn-shell-core/src/launch.rs` then picks the
BEST of four rungs, in this order:

| rung | what it runs | needs |
|---|---|---|
| vendored runtime | `runtime/<rid>/node/node <runtime>/harness/…/lib/bin.js web --no-open --port N` | the three pieces present; no npm, no cache, no network |
| **already installed here** | `node <npm cache>/_npx/…/@deepseek-ai/dsh/lib/bin.js web …` | the Node on PATH. This is the installation a browser tab is ALREADY running, resolved through the profile's own link first |
| `npx` fallback | `npx --yes @deepseek-ai/dsh@<pin> web --no-open --port N` | a writable npm cache and, on a first run, the network |
| the test seam | whatever `VNCODE_STUB_CLI` names | nothing; a check only |

The second rung is the one that matters when npm itself is broken: a cache an elevated
run made unwritable, a machine that asks for an administrator, or no network at all
are every one of them a reason to run what is ALREADY on disk rather than ask npm for
it. It is skipped unless its `package.json` names the pin, because a machine can have
several harness installations cached (this one has four) and the shell must not
quietly run a different harness than `scripts\run-web.bat` does.

When npm IS used, it is pointed at a cache the shell has checked it can write in -
`<cache>/_cacache/tmp`, which is where npm really writes, not the cache root. See
`appdata::choose_npm_cache`.

`runtime/` is a distribution tree, never a repository tree: gitignored and absent
from a clone.

The supervisor that runs that command lives in
`app/crates/vn-shell-runtime/src/lib.rs`, and the control panel that decides when to
start it - and stops the whole tree again - is
`app/crates/vn-shell-egui/src/lib.rs`.

## Signing, and Windows SmartScreen

Authenticode covers the exact bytes of a file, so sign the binary you are about to
publish and nothing else: `signtool` on `app/target/release/vncode.exe`, with a
certificate named by the environment (never committed). Nothing in this repository
signs anything, and there is no longer a build step that appends a payload to a
binary - the shell is one file as cargo produced it.

UAC is not a concern: nothing elevates and there is no installer. SmartScreen is: a
downloaded `.exe` warns until that file or publisher has reputation, and a
self-signed certificate fixes nothing for other people. Until a real certificate
exists, the honest thing is to say so in the Release notes and publish
`SHA256SUMS.txt` beside the binary, so a reader who checks the hash is not relying
on the warning being wrong.

## No CI

`.github/workflows/` does not exist, GitHub Actions is disabled on the repository,
and `scripts/checks/check-scripts.mjs` **fails** if a workflow directory comes back
- a deleted CI cannot quietly return on a push. A release is cut by hand
([RELEASE.md](RELEASE.md) is the ritual), and any pipeline added later must run the
same checks that ritual runs.

## Checks

Run the one that owns the area; a check that cannot run on this host skips loudly
and exits 0. [scripts/checks/README.md](../scripts/checks/README.md) lists them all.

```sh
node scripts/checks/check-no-secrets.mjs       # before anything is pushed
node scripts/checks/check-scripts.mjs          # the scripts layout, the console contract, no CI
node scripts/checks/check-node-routes.mjs      # every Node route, the manifest, the patches
node scripts/checks/check-client-bundles.mjs   # every browser bundle, driven for real
node scripts/checks/check-media-node.mjs       # dsh-media's host half and its ffmpeg pin
node scripts/checks/check-pdf-node.mjs         # the five pdf tools and their routes
node scripts/checks/check-skill-examples.mjs   # every example in the shipped skills
node scripts/checks/check-shell.mjs            # the native shell: ready line, token, stop, install
```
