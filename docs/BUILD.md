# Building vncode

> **Stage 2 is specified in [`STAGE2.md`](STAGE2.md), and its measurements
> supersede §1–3 of this file.** The measurement changed the design: the pinned
> harness's production closure is **461.5 MB / 26 642 files**, and `--omit=dev`
> saves nothing - 461 MB *is* the runtime - so "one lightweight `.exe`" was never
> achievable. The decision taken is **one `.exe`, fully offline, ~176 MB, shipped
> whole with LibreOffice included**, because a recipient must be able to start
> the app with no network and no prerequisites. Read `STAGE2.md` before starting
> stage 2's work items.

This document is the **build plan** for the vncode distribution. It describes the
target pipeline, why each decision was made, and the order the work has to happen
in. It is a specification, not a description of what exists today - see
*Current state* for the delta.

Read `ARCHITECTURE.md` for what the application **is**. This file is only about
turning it into artifacts.

---

## The four decisions

| Decision | Choice |
|---|---|
| What `run-dist` leaves in `dist/` | **Both** - the folder (dev, live-linked) and one self-extracting `.exe` (the thing you hand over) |
| Runtime | **Vendor the harness AND bundle a pinned Node runtime**, shipped whole (~176 MB). No `npx`, no `PATH` lookup, and **no network at startup** - the network is for the chat and search only. See `STAGE2.md` |
| Profile | **Pre-built into the payload** and copied on first run, so every launch is pure Node: no npm, no pnpm, no registry |
| Signing | **Wired behind `-Sign`, off by default** - local builds stay fast and unsigned; CI turns it on with a secret |
| JavaScript/TypeScript build | **No bundler for `packages/`** - hand-written client bundles, live-linked, preserved as the fast dev loop |

---

## 1. Two verbs, not one

`scripts\run-desktop.bat` stays the **developer loop** and must never assemble a
distribution: it builds the Rust shell when it is stale and runs it from the
source checkout, where the web profile's live links already point. That loop is
seconds and it is the reason plugin edits appear on a reload.

The distribution gets its own entry point.

```bat
scripts\run-dist.bat [flags]        :: new - the one verb that produces dist/
scripts\run-dist.bat              :: becomes a thin alias, so nothing breaks
```

`scripts\run-dist.ps1` is the worker (Windows). `scripts/dist.sh` is the POSIX
twin; both call the same shared steps so the halves cannot drift.

Build only what changed:

| Flag | Effect |
|---|---|
| `-SkipRuntime` | reuse the vendored runtime tree (the common case) |
| `-SkipBuild` | reuse `app/src-tauri/target/release/vncode-desktop.exe` (already exists) |
| `-NoZip` | assemble the folder only |
| `-Sign` | sign the shell **and** the final one-file build |
| `-Verify` | assemble, install into a throwaway `DSH_HOME`, boot, await the ready line |
| `-Clean` | delete `dist/` first |

A day-to-day release run is therefore `-SkipRuntime` and takes seconds.

---

## 2. DSH becomes a build input, not a runtime pull

The shell **used to** run `npx.cmd --yes @deepseek-ai/dsh@<pin> web --no-open` and
no longer does when a runtime is vendored: that was a network dependency, a `PATH`
dependency, one extra process on every launch, and - on this machine - the source
of an `npm error code EPERM` in a cache owned by another account, whose own message
advised running as Administrator.

`scripts/dsh/vendor.ps1` is **delivered** and works differently from the sketch
below, in one deliberate way: it is **local-first**. It looks for the pinned tree
the machine already has (the app-local and shared npm caches, `.upgrade/`,
`.scratch/`) and copies it, so a first run needs no network at all - on this
machine it copied the very tree the running session boots from. Only when no local
tree carries the pin does it fall back to resolving the pin by name from the
registry. What is left of this sketch is that fallback and a tracked lock file.
It also stamps `runtime/<rid>/VENDOR.json` **only after** running the copied pair
and watching it report a version, so a half-copy can never be resolved.

```jsonc
// tools/dsh-vendor.lock.json  - NOT YET WRITTEN; the pin in .dsh-version.json is
// what today's vendor.ps1 reads, and VENDOR.json records what it actually copied.
{
  "dsh": "0.2.0-rc.2",
  "resolved": "0.2.0-rc.2",
  "integrity": "sha512-...",
  "node": { "version": "22.x.y", "rid": "win-x64", "sha256": "..." },
  "tree": { "files": 0, "bytes": 0, "digest": "sha256:..." }
}
```

It writes `runtime/<rid>/` (gitignored). A rebuild with the same pin re-copies the
local tree rather than re-resolving it.

**Nothing is pruned and nothing is deduplicated**: the payload ships the harness
whole, by decision - see `STAGE2.md`. `vendor/` never enters the payload, but the
full production closure does.

---

## 3. The shell runs the bundled Node

`app/src-tauri/src/main.rs` **no longer resolves only `npx.cmd`** - that is
delivered. `choose_launch()` prefers a complete vendored runtime and falls back to
npx only when there is none, so the "make sure npx.cmd is on PATH" sentence is
reachable only from a source checkout that has not vendored anything yet.

The resolver order, as shipped:

```text
> <root>/runtime/<rid>/{node/node.exe, harness/…/bin.js, VENDOR.json}   the vendored path
> npx --yes @deepseek-ai/dsh@<pin> web                                  the source-checkout fallback
```

All THREE vendored pieces must exist or the fallback is taken - a half-copied
runtime that the shell resolved would report a broken install instead of starting.

The launch becomes, in effect:

```text
<root>/runtime/<rid>/node/node.exe <root>/runtime/<rid>/harness/…/@deepseek-ai/dsh/lib/bin.js web --no-open --port <n>
```

One process fewer than `npx`, no registry lookup, no npm cache, no PowerShell. This is the main
cold-start win, and it should be **measured before and after** rather than
asserted.

The shell keeps everything it already owns: the port choice, `DSH_HOME` (still
never invented - see `app/README.md`), the ready-line watch, the job object, the
redaction, the geometry record.

---

## 4. Bootstrap without PowerShell

A first run on a clean machine has no web profile, so the pack must be installed
before the harness boots. Today that is `START-HERE.bat` -> `install-all.ps1`.

For the one-file build the shell does it itself, in the **bundled Node**:

- new `app/runtime/bootstrap.mjs`, run by the runtime Node. No PowerShell, no
  execution policy, and the same file works on macOS and Linux;
- `main.rs` runs it only when the profile manifest is absent or does not list
  every bundle, with a hard timeout and the same line-by-line redaction the
  harness's own output gets;
- it installs each bundle with the **local CLI** (`node <runtime>/.../dsh.js
  plugin add <bundle>`) instead of `npx`, so a first run needs no registry;
- the folder distribution keeps `START-HERE.bat`; the one-file build makes it
  unnecessary, which is what a double-click has to mean.

---

## 5. One file - and signing the right bytes

**This is a sequencing trap, not a detail.** Authenticode covers the exact bytes
of the file, so appending the payload to a signed shell *invalidates that
signature*. The order is load-bearing:

```text
1. cargo build --release
2. sign  app/src-tauri/target/release/vncode-desktop.exe     (-Sign)
3. append the payload zip + the VNHRNS01 trailer
4. sign  dist/vncode-<version>-<rid>.exe                     (-Sign, the FINAL file)
```

`scripts/dist.ps1`'s existing `New-StandaloneExecutable` is step 3 and already
writes one handle end to end (deliberately, so a virus scanner cannot grab the
half-written 8 MB exe between two opens). Steps 2 and 4 are new and belong on
either side of it.

Also new, and cheap: an embedded **application manifest** (DPI awareness, long
path awareness, `supportedOS` for Windows 10/11) and a **`VERSIONINFO`
resource** carrying company, product and version. The shell's resource currently
carries the Tauri icon only.

---

## 6. Windows will not complain - the truthful version

Two complaints, two answers. Do not conflate them.

**UAC is already fine.** Nothing here elevates: no installer, a per-user unpack
into `%LOCALAPPDATA%`, no `requestedExecutionLevel`. There is nothing to fix.

**SmartScreen is the real one**, and it splits three ways:

- *your own local build* is copied on disk, carries no `Zone.Identifier`, and
  will not prompt;
- *a file somebody downloads* carries the mark-of-the-web and shows "Windows
  protected your PC" until that file (or that publisher) has reputation;
- *a self-signed certificate fixes nothing for other people.* It helps only on
  machines where you installed the root. Say so rather than shipping one.

What actually fixes it: **EV** or **Azure Trusted Signing**. EV gains SmartScreen
reputation immediately; a plain OV certificate accumulates it over downloads.

Until a certificate exists, the honest mitigations - all of which already partly
exist:

- ship the **`.zip`** and say "extract, then run": extraction drops the mark;
- publish `SHA256SUMS.txt` and `BUILD-INFO.json` (both already generated);
- keep a stable publisher identity and version metadata.

`-Sign` takes a certificate from CI secrets so it is never in the repository, and
it is **off by default** so a local release run stays fast.

---

## 7. Keeping it light

The weight is real and it has to be fought deliberately. Measured signal: a
resolved DSH tree on this machine is **461 MB / 26 640 files**. That number is
discardable - it is not the pruned runtime - but it is the order of magnitude
being dealt with.

- **Resolve once.** The vendored tree lives in `dist/runtime-cache/`. It is never
  re-resolved for a rebuild, and it never enters the payload twice.
- **Prune at vendor time**, with the vendor step *printing* what it removed:
  docs, tests, source maps, TypeScript sources, and non-`win32-x64` prebuilds.
  The prune rule is data, so the POSIX half removes the same things.
- **Unpack once per payload identity.** `app/src-tauri/src/payload.rs` already
  keys the directory on `<version>-<rid>` and reuses it. The missing piece: once
  a **new** version has booted successfully, sweep older unpack directories,
  because each one is hundreds of MB.
- **`NODE_COMPILE_CACHE`**, pointed at a stable per-version directory under
  `%LOCALAPPDATA%\vncode\cache`, so V8's compile cost for the client bundles and
  vendored engines is not paid on every start. This needs a measurement before it
  is believed - it is a claim, not a fact.
- **Keep the folder product for development.** The live links are why editing a
  plugin and reloading is instant. Every "optimisation" that breaks that trade is
  the wrong trade.

---

## 8. The JavaScript/TypeScript position

There is **no JavaScript/TypeScript build step in this repository, and this plan
does not add one.**

- `packages/*/lib/client.js` is the shipped browser bundle: hand-written, loaded
  by the harness as a live link. That is what makes the dev loop fast, and it
  stays.
- Vendored engines keep their own `vendor/build.mjs` plus the tracked hash
  checks (`lib/vendor/VERSION.json`). Regenerate, never hand-edit.
- `app/ui/` is a single 5.4 KB splash page inlined into the Rust binary by
  `tauri-build`. It needs no bundler today. **If** the shell's window ever becomes
  a real typed application, that is the one place worth Vite + TypeScript
  (`frontendDist`, built at build time) - and it still would not disturb
  `packages/`.

`scripts/checks/` is the build gate: node-routes, client bundles, dist layout,
skill examples. A build that fails a check is not a build.

---

## 9. CI, compiled the same way as locally

`scripts/checks/check-dist-layout.mjs` already validates a distributer workflow in
detail, and it reads it **optionally and loudly**: the workflow
`.github/workflows/distribute.yml` was **parked on purpose** (commit `276b4ba`,
"no CI for now"), so the check prints a skip line and every assertion in it comes
back the moment the file does. Restore it with

```sh
git log --diff-filter=D --name-only -- .github/workflows/distribute.yml
git checkout <sha>^ -- .github/workflows/distribute.yml
```

and it will be held to the rules that are already written down for it: the
`windows-2022` / `macos-15-intel` / `macos-15` / `ubuntu-22.04` legs (plus the
`windows-11-arm` / `ubuntu-22.04-arm` ARM64 legs, which are required, not
experimental), `cargo test` so the shell's unit tests are not laptop-only,
`-Verify`, `upload-artifact` gated by event, `scripts/**` in the `paths:` filter,
and every GitHub-official action pinned to a commit SHA. One rule matters more
than the YAML:

> **CI calls the same script a person calls.** It never reimplements a build step.

`windows-latest`:

```text
actions/setup-node@<sha>       (Node 22, for the checks and the vendor step)
dtolnay/rust-toolchain@<sha>
Swatinem/rust-cache@<sha>      (cargo)
actions/cache@<sha>            (the vendored runtime tree, keyed on the lock hash)
scripts\run-dist.ps1 -Verify [-Sign]
upload-artifact                (.exe, .zip, SHA256SUMS.txt, BUILD-INFO.json)
```

The runtime cache key is the **vendor lock hash**, so a pin bump is the only thing
that re-downloads, and a normal run restores the tree from cache.

`-Verify` is the end-to-end check both a local run and CI run: install into a
throwaway `DSH_HOME`, boot the pinned harness from the produced folder, and wait
for the ready line. It never opens a window, which is what makes it runnable on a
runner with no screen.

---

## 10. Verification

A build nobody tested is a guess. Beyond the existing `-Verify`:

| Check | What it proves |
|---|---|
| `runtime/node.exe` exists and runs | the artifact is self-contained |
| the launch path contains no `npx` | no registry and no `PATH` dependency at runtime |
| a second launch reuses the unpack directory | no re-unpack cost per start |
| the produced `.exe` ends with `VNHRNS01` | it is what it claims to be |
| `-Sign` then `Get-AuthenticodeSignature` = `Valid` | the signature survived the append |
| `check-dist-layout.mjs` learns `runtime/` | the tracked check does not fail the first build |

That last row is a **required edit**, not a nice-to-have: the manifest pins what
ships, and a `runtime/` tree it does not know about is a failing build.

---

## Current state - the delta to implement

| Path | Action |
|---|---|
| `scripts/run-dist.bat` | **new, and DELIVERED (stage 1)** - the entry point the maintainer double-clicks |
| `scripts/run-dist.ps1` | **new, and DELIVERED (stage 1)** - shell-staleness decision, the checks gate, the worker call, `-Run` / `-RunApp` |
| `scripts/run-dist.bat` | **DELIVERED (stage 1)** - forwards to `run-dist.bat`, so the console contract and the worker call exist once |
| `scripts/dist.ps1` | **DELIVERED (stage 1)** - build fingerprint (skip an unchanged copy, hashing and zip), `Assert-NoSecrets`, `-Sign` accepted. Still pending: signing itself, and the `runtime/` tree |
| `scripts/dist-manifest.txt` | **DELIVERED (stage 1)** - `node_modules` / `.env` / `*.pem` / `*.key` skip rules |
| `scripts/checks/check-dist-layout.mjs` | **DELIVERED (stage 1)** - the new entry point is held to the console contract and the worker rule; the forwarder is recognised |
| `scripts/dsh/vendor.ps1` | **DELIVERED** - local-first: copies the pinned tree the machine already has into `runtime/<rid>/`, falls back to a registry resolve only when nothing local carries the pin, and stamps only after running the pair |
| `tools/dsh-vendor.lock.json` | **new**, tracked |
| `app/runtime/bootstrap.mjs` | **new** - install the pack from the bundled Node |
| `app/src-tauri/src/main.rs` | Node resolver (bundled -> `PATH`), bootstrap call, launch with the local CLI |
| `app/src-tauri/src/payload.rs` | sweep older unpack directories after a good boot |
| `app/src-tauri/build.rs` + a `.manifest` / `.rc` | application manifest and `VERSIONINFO` |
| `.github/workflows/distribute.yml` | **parked on purpose** (commit `276b4ba`). The tracked check skips it loudly; restore it with `git checkout <sha>^ -- .github/workflows/distribute.yml` when CI comes back |

## What stage 1 measured

Run on this machine (Windows 11, PowerShell 5.1, Rust shell already built):

| | |
|---|---|
| Full assemble | **8.8 s** - 377 files, 20.5 MB folder, 7.2 MB zip, 15.4 MB single file |
| Nothing changed | **2.1 s** - the folder, zip and single file are all reused |
| One shipped file edited, **same size, same mtime** | cache **missed**, reassembled, dropped the stale zip and single file and rebuilt both |

That third row is the one worth keeping: a timestamp-only cache would have
shipped the edit inside a stale zip. The fingerprint carries a sha256 per shipped
file, so content is what decides.

`Assert-NoSecrets` was driven directly with a planted `sub\probe\.env` and
refused the folder; the single-file build's `VNHRNS01` trailer arithmetic was
verified against the file's real length (16110910 bytes, exact).

## Order of work

1. **Stage 1 - one entry point.** `run-dist` + folder + zip + one `.exe`, reusing
   today's `dist.ps1` steps. Gives you the build you asked for, quickly.
2. **Stage 2 - the local runtime.** Vendor DSH, bundle Node, launch from the
   runtime, bootstrap from Node. This is the offline/standalone answer.
3. **Stage 3 - release hardening.** Signing behind `-Sign`, manifest and version
   resource, pruning, the unpack sweep, CI, and the size numbers measured.
