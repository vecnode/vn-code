# Building vncode

Two verbs, deliberately separate: `scripts\run-desktop.bat` (or
`./scripts/run-desktop.sh`) is the developer loop - build the Rust app when it is missing
and run it from the checkout, where the package folders are already live-linked into the
profile; `scripts/checks/` is what says whether the change is sound.

## No JavaScript build step

There is no JavaScript/TypeScript build here; the packages are hand-written:

- `packages/*/lib/client.js` is the shipped browser bundle, loaded by the harness as a live
  link - which is what makes a plugin edit visible on a reload.
- Vendored engines keep their own `vendor/build.mjs` and the tracked hashes in
  `lib/vendor/VERSION.json`. Regenerate them, never hand-edit.
- `app/` is a **cargo workspace** of three crates, each with its own `cargo test`, and
  `scripts/checks/` is the build gate: a build that fails a check is not a build.

## The three entry points

| | what it does |
|---|---|
| `scripts\run-web.bat` / `./scripts/run-web.sh` | starts the pinned harness and opens it in a browser tab. **The web half - it needs no `vncode` binary at all** |
| `scripts\run-desktop.bat` / `./scripts/run-desktop.sh` | builds `vncode` when there is none and runs it: install the pack if this home lacks it, ask for the key if there is none, then run the web launcher |
| `scripts\setup\install.bat` / `./scripts/setup/install.sh` | adds this folder's bundles to the `web` profile - and the same pair under `uninstall` takes them out again |

There is no distributer, no self-contained folder and no vendored runtime any more. The
distribution is this repository plus (optionally) a built `vncode`, and the app installs
the pack itself by running the two `setup/` entry points above.

## The app

`cargo build --release --locked --manifest-path app/Cargo.toml` produces
`app/target/release/vncode` (~0.5 MB). No GUI toolkit, no web engine, no linker surprises:
the only dependencies are `serde_json` and `rpassword`, so nothing has to be installed
before a build and nothing has to be installed beside the binary.

The size is a **budget, not a result**: `.github/workflows/ci.yml` fails the build over
6 MB, and `check-shell.mjs` fails over 12 MB. A dependency that draws a window - `eframe`,
`egui`, `wgpu`, `winit` - or a web view - `wry` and its three OS engines - is the only way
to get back over either line, and it is the change this project exists to prevent.

## Runtime and launch path

The app does not run node. It resolves the root, the home, the pin and the child's
environment, and then it runs `scripts/run-web.*` **in the foreground** - the same file a
person double-clicks, with `-DshHome <the home it chose>` so both halves agree, and with a
composed environment (`vn_shell_runtime::env`): `DSH_HOME` set, the console markers and
`VNCODE_HOME` removed, a writable npm cache and temp chosen by write probe.

Everything about *which* harness runs lives in that launcher, not here: `npx --yes
@deepseek-ai/dsh@<pin> web --no-open`, the ready line, the loopback check and the browser
hand-off (Chrome first, the OS opener as the floor). `scripts\run-web.bat` is therefore the
single source of truth for the harness command, and the app cannot disagree with it.

## Signing, and Windows SmartScreen

Authenticode covers the exact bytes of a file, so sign the binary you are about to publish
and nothing else: `signtool` on `app/target/release/vncode.exe`, with a certificate named
by the environment (never committed). Nothing in this repository signs anything, and there
is no build step that appends a payload to a binary - the app is one file as cargo produced
it.

UAC is not a concern: nothing elevates and there is no installer. SmartScreen is: a
downloaded `.exe` warns until that file or publisher has reputation, and a self-signed
certificate fixes nothing for other people. Until a real certificate exists, the honest
thing is to say so in the release notes and publish `SHA256SUMS.txt` beside the binary, so
a reader who checks the hash is not relying on the warning being wrong.

## CI

`.github/workflows/ci.yml` runs clippy (`-D warnings`), the workspace tests, a release
build, the size budget and a smoke run - on all three OSes for a pull request, the Monday
schedule, a manual dispatch, and `release.yml`, which calls the same workflow as its gate.
**A push to `main` runs no CI at all** - that trigger is deliberately absent, so commits
and pushes are free and the checks that must not be skipped run at the boundaries. There is
no per-package JavaScript build to run in CI; the checks in `scripts/checks/` remain the
contract and are run by hand.

## Checks

Run the one that owns the area; a check that cannot run on this host skips loudly and exits
0. [scripts/checks/README.md](../scripts/checks/README.md) lists them all.

```sh
node scripts/checks/check-no-secrets.mjs       # before anything is pushed
node scripts/checks/check-scripts.mjs          # the scripts layout, the console contract, the two workflows
node scripts/checks/check-node-routes.mjs      # every Node route, the manifest, the patches
node scripts/checks/check-client-bundles.mjs   # every browser bundle, driven for real
node scripts/checks/check-media-node.mjs       # dsh-media's host half and its ffmpeg pin
node scripts/checks/check-pdf-node.mjs         # the five pdf tools and their routes
node scripts/checks/check-skill-examples.mjs   # every example in the shipped skills
node scripts/checks/check-shell.mjs            # the app, driven: verbs, the bridge, the env
```
