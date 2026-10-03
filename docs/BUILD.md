# Building vncode

Two verbs, deliberately separate: `scripts\run-desktop.bat` is the developer loop
(build the Rust shell when it is stale and run it from the source checkout, where
the profile's live links already point); `scripts\run-dist.bat` produces `dist/`.

## No JavaScript build step

There is no JavaScript/TypeScript build here; the packages are hand-written:

- `packages/*/lib/client.js` is the shipped browser bundle, loaded by the harness
  as a live link - which is what makes a plugin edit visible on a reload.
- Vendored engines keep their own `vendor/build.mjs` and the tracked hashes in
  `lib/vendor/VERSION.json`. Regenerate them, never hand-edit.
- `app/ui/` is one splash page inlined by `tauri-build`, and `scripts/checks/` is
  the build gate: a build that fails a check is not a build.

## The distribution entry points

| Flag | Effect |
|---|---|
| `-NoShell` | source-only release: compile nothing, ship `app/` as source, name the artifact `vncode-<version>-<os>` |
| `-TargetOs win\|mac\|linux` | label the artifact and `BUILD-INFO.json` for that OS; refused without `-NoShell` |
| `-SkipBuild` / `-ForceBuild` | reuse `app/src-tauri/target/release/vncode-desktop[.exe]` / run cargo even when nothing looks stale |
| `-SkipChecks` | do not run `scripts/checks/` first (and say the result is unverified) |
| `-Verify` / `-KeepVerifyHome` | install the assembled copy into a throwaway `DSH_HOME` and boot the pinned harness, waiting for the ready line / keep that home |
| `-Run` / `-RunApp` | assemble, then run the folder's `START-HERE` / the packed binary |
| `-NoZip`, `-OutDir <dir>`, `-Clean` | assemble the folder only / assemble elsewhere / delete the output folder first |
| `-Sign` | sign the shell and the final one-file build (off by default) |

`scripts\run-dist.ps1` is the Windows worker and `scripts/dist.ps1` the engine it
calls; `scripts/dist.sh` is the POSIX half doing the same work itself. The output is
`dist/vncode-<version>-<os>/` plus its `.zip`, and `dist/` is gitignored.

## Runtime and launch path

`scripts/dsh/vendor.ps1` produces a complete vendored runtime under
`runtime/<rid>/` (`node/`, `harness/`, `VENDOR.json`) from the pinned tree the
machine already has, falling back to the registry only when nothing local carries
the pin. `choose_launch()` in `app/src-tauri/src/main.rs` prefers it and launches
`node <runtime>/harness/.../lib/bin.js web --no-open --port N`, with no npm, no npx
and no cache touched; when no complete runtime exists it falls back to
`npx --yes @deepseek-ai/dsh@<pin> web` and sets `npm_config_cache` on that branch
alone. All three pieces must be present or the fallback is taken, and `runtime/` is
a distribution tree, never a repository tree: gitignored, absent from a clone.

## Signing, and Windows SmartScreen

Authenticode covers the exact bytes of a file, so the order matters: build the
shell, sign it, append the payload zip and the `VNHRNS01` trailer, then sign the
final file. `-Sign` takes a certificate named by the environment (never committed)
and is off by default so a local run stays fast. UAC is not a concern - nothing
elevates and there is no installer. SmartScreen is: a downloaded file warns until
that file or publisher has reputation, and a self-signed certificate fixes nothing
for other people; until one exists, ship the `.zip` ("extract, then run" drops the
mark) and publish `SHA256SUMS.txt`.

## No CI

`.github/workflows/` does not exist, GitHub Actions is disabled on the repository,
and `scripts/checks/check-dist-layout.mjs` **fails** if a workflow directory comes
back - a deleted CI cannot quietly return on a push. A release is cut by hand with
`scripts\run-dist.bat -NoShell -Verify` ([RELEASE.md](RELEASE.md) is the ritual),
and any pipeline added later must call that same script.

## Checks

Run the one that owns the area; a check that cannot run on this host skips loudly
and exits 0. [scripts/checks/README.md](../scripts/checks/README.md) lists them all.

```sh
node scripts/checks/check-no-secrets.mjs       # before anything is pushed
node scripts/checks/check-dist-layout.mjs      # ship list, console contract, no CI
node scripts/checks/check-node-routes.mjs      # every Node route, the manifest, the patches
node scripts/checks/check-client-bundles.mjs   # every browser bundle, driven for real
node scripts/checks/check-media-node.mjs       # dsh-media's host half and its ffmpeg pin
node scripts/checks/check-pdf-node.mjs         # the five pdf tools and their routes
node scripts/checks/check-canvas-node.mjs      # the canvas host half, tools and routes
node scripts/checks/check-skill-examples.mjs   # every example in the shipped skills
```
