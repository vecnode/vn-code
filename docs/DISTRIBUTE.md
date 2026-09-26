# Building a vn-harness distribution

A distribution is **one folder you can click** and, optionally, a zip of it. This
page is the local story and the CI story, side by side, because they are the
same story: the GitHub workflow calls the very scripts you run on your machine.

| | Windows | macOS / Linux |
|---|---|---|
| **Build it** | double-click `distribute.bat` | `./distribute.sh` |
| **The work** | `scripts/dist.ps1` | `scripts/dist.sh` |
| **Logs / flags** | `distribute.bat -Help` | `./distribute.sh -Help` |
| **CI equivalent** | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dist.ps1 -Verify` | `sh scripts/dist.sh -Verify` |

---

## 1. Why a distribution is a folder and not an `.exe`

`app/` is a **launcher**, not a bundle:

1. the shell binary walks up from itself for `.dsh-version.json` and reads the
   pinned harness version from it (there is no built-in fallback pin);
2. it runs `npx @deepseek-ai/dsh@<pin> web --no-open` on a free loopback port;
3. it reads the `dsh web:` ready line and shows **that** url in a WebView2 /
   WKWebView / WebKitGTK window, holding the launch token in memory only.

The plugins are not compiled into it. The harness **web profile** installs every
bundle as a **live link** into `packages/`, so the folder *is* the application.
That is why:

- the distribution carries `packages/`, `.dsh-version.json` and the installer
  scripts beside the binary;
- the folder must stay where it is - move it and the profile's links point at
  folders that no longer exist. Re-running `START-HERE.bat` /
  `./START-HERE.sh` re-installs from wherever it now lives;
- the target machine needs **Node.js 22+** and, on the first run, **network
  access** (the pinned harness is fetched through `npx` once and cached).

## 2. What comes out

```text
dist/
  vn-harness-<version>-<rid>/          <- the folder you click
    vn-harness.exe  |  vn-harness      <- the built shell
    START-HERE.bat  |  START-HERE.sh   <- generated: install, then open
    DIST-README.txt                    <- generated: requirements, flags, uninstall
    BUILD-INFO.json                    <- generated: version, pin, commit, toolchain
    SHA256SUMS.txt                     <- generated: SHA-256 of every file beside it
    .dsh-version.json                  <- the pin the shell reads (required)
    packages/                          <- every bundle, live-linked by the profile
    scripts/                           <- the installers the folder installs itself with,
                                          including scripts/console/ (the shared launcher
                                          console layer every entry point calls)
    app/README.md                      <- the shell's README; the shell itself
                                          ships built, so its source is not here
    assets/vn-harness.svg  docs/  README.md  LICENSE  SECURITY.md
    install.bat/.sh  uninstall.bat/.sh  run-web.bat/.sh  run-desktop.bat
  vn-harness-<version>-<rid>.zip       <- the same folder, archived
```

`<rid>` is `win-x64`, `win-arm64`, `mac-x64`, `mac-arm64`, `linux-x64` or
`linux-arm64` - derived from the host, never passed in. `<version>` is
`package.json`'s version unless `-Version` overrides it.

**The distributer is not in the folder.** `distribute.bat` / `scripts/dist.ps1`
and their `.sh` twins are the FACTORY, not the product: a recipient gets
`START-HERE.bat` and never needs the tool that assembled the folder. Both are
named explicitly in `scripts/dist-manifest.txt`'s skip rules rather than merely
left out, because `include scripts` would otherwise sweep them in - and a build
tool inside the thing it builds invites a nested `dist/` inside a distribution.
`check-dist-layout.mjs` fails when that exclusion is dropped.

**Every launcher shares one console layer.** `scripts/console/adapt.cmd` decides
which window a Windows entry point runs in (relaunching into Windows Terminal
when it exists and we are not already inside one), which PowerShell runs the
worker (`pwsh` 7 first, else Windows PowerShell 5.1 - both are first class), and
whether the window is held open at the end; `scripts/console/theme.ps1` and its
POSIX twin `scripts/console/theme.sh` own the colour policy (a terminal gets
colour, a redirected log never does, `NO_COLOR` always wins). That layer is why
the generated `START-HERE.bat` behaves like the launchers beside it instead of
like a hand-written one-off, and it ships inside `scripts/`. `run-desktop.bat` is
shipped for the same reason it exists: in this folder it runs `vn-harness.exe`
directly and needs no Rust toolchain, which is what `-NoBuild` pins down.

**The shell ships BUILT, not in source.** `app/src-tauri/` (the Rust source, its
Cargo manifests, `build.rs`, `tauri.conf.json`), `app/src-tauri/icons/` and
`app/ui/` are build **inputs**: tauri-build compiles the icons and the splash
page into the binary's own resources, so nothing at runtime ever opens one of
them, and `app/README.md` is the only file of `app/` in the folder. The same
rule takes the maintainer tooling out of `scripts/`: `scripts/checks/` runs
against a checkout (`packages/`, the Rust source, a git history),
`scripts/sync-vendored.ps1` moves the vendored forks forward and wants `pwsh` on
every host, and `scripts/make-desktop-icon.mjs` regenerates icons that are not
shipped either. `run-desktop.bat` does not miss them: it decides between "run
the binary beside me" and "build from source" on the presence of `vn-harness.exe`,
never on a `Cargo.toml`.

> The **plugins** are the exception, and it is structural rather than a choice:
> the web profile installs every bundle as a **live link** into `packages/`, so
> `packages/` has to be there as readable JavaScript for the app to have plugins
> at all. Hiding the plugin source means giving up live links and installing
> copies instead - see section 1.

**What is deliberately NOT in it** (`scripts/dist-manifest.txt` is the one list,
read by both halves): `app/src-tauri/target/` (the Rust build tree),
`app/src-tauri/gen/`, `tools/` (where the installer bootstraps pnpm),
`.scratch/`, `.git/`, `docs/diagrams/` and every `node_modules/`. That last one
matters: the three `packages/*/vendor/node_modules` trees are 200 MB of build
**inputs** for artifacts that are already committed under `lib/vendor/`, so
shipping them would multiply the archive by twenty for nothing. A full
distribution is ~20 MB (~7 MB zipped).

`dist/` is gitignored. It is a copy - after editing a plugin, re-run the
distributer.

## 3. Local use

```bat
:: Windows - the whole thing: build the shell, assemble, zip
distribute.bat

:: skip the cargo build (reuse app\src-tauri\target\release as it is)
distribute.bat -SkipBuild

:: assemble and RUN the distribution, in the foreground
distribute.bat -Run

:: assemble, then install into a throwaway DSH_HOME and boot the pinned
:: harness from a copy of the folder - the end-to-end check
distribute.bat -Verify

:: start over; name the version something else
distribute.bat -Clean
distribute.bat -Version 0.2.0

:: assemble somewhere else, leaving dist/ alone - the case that NEEDS it is a
:: distribution that is still RUNNING: Windows will not let a live
:: vn-harness.exe be overwritten, so the new cut is built beside it and swapped
:: in after the window is closed
distribute.bat -OutDir dist2
```

```sh
# macOS / Linux - the same flags, one file
./distribute.sh -SkipBuild
./distribute.sh -Verify
./distribute.sh -OutDir dist2      # assemble beside dist/, leaving it alone
sh ./distribute.sh -Help          # if the executable bit was lost
```

Every run prints the folder and the archive to click. `-OutDir` exists for the
one case that cannot be worked around: a distribution that is **running** holds
its own `vn-harness.exe` open, and Windows refuses to overwrite or delete a file
in use - so a new cut is assembled beside it and swapped in once the window is
closed (`dist2/` is gitignored for that reason). `-Verify` is the useful one
while you are changing something: it proves the **folder** works, not just that
it assembled, and it never opens a window (which is exactly why CI can run it
too).

### What `-Verify` actually does

1. copies the assembled folder to a temp directory - a distribution is a folder
   somebody extracts somewhere else, so a copy is the thing being promised.
   (It also keeps the real folder pristine: the installer bootstraps its own
   pnpm under a local `tools/` when the machine has none, and that bootstrap
   must not land inside the folder after the archive was made.)
2. runs that copy's **own** installer against a throwaway `DSH_HOME`;
3. asserts the profile now lists **every bundle the folder carries** (the names
   are read from the shipped `packages/*/package.json`, not from a second list);
4. boots the pinned harness with that home, waits up to 180 s for the
   `dsh web: http://127.0.0.1:<port>/?token=...` ready line, stops the whole
   process tree, and proves the port is free again;
5. prints the url with **`token=REDACTED`** - the token is a live credential and
   never reaches a log or a scrollback - and refuses a ready line that does not
   name a loopback address.

The throwaway home is deleted afterwards; `-KeepVerifyHome` keeps it.

## 4. CI: what it does, and how to see it

`.github/workflows/distribute.yml` has five jobs, and which of them run depends on
the event, because a push and a release want different things:

| Job | What it is |
|---|---|
| `checks` | `check-no-secrets.mjs` (nothing credential-shaped reaches a commit), `check-dist-layout.mjs` (ship list, every bundle carried, both halves' flags/sentinels in step, the matrix policy, the action pins), then a pinned `react` + `react-dom` 18.3.1 installed into `$DSH_HOME/profiles/node_modules` (the runtime the client check renders with - a fresh runner has none and that check throws rather than skipping), then the client-bundle, skill-example and startup-window checks, each of which skips its host-dependent sections loudly |
| `rust-tests` | `cargo test --locked` on the shell. This is the only job that EXECUTES `keystate.rs` / `readyline.rs` / `windowstate.rs`: the build legs run `cargo build --release`, which runs no test, and every check above reads the Rust as TEXT. It runs in parallel with the builds, and `release` waits on it |
| `build-core` | one leg per operating system - `windows-2022` → win-x64, `macos-15` → mac-arm64, `ubuntu-22.04` → linux-x64: checkout, Node 22, Rust 1.98.1, `Swatinem/rust-cache`, Linux webview deps, then **the same `dist.ps1` / `dist.sh` with `-Verify`** |
| `build-extra` | the legs no core leg can produce - `macos-15-intel` → mac-x64, `ubuntu-22.04-arm` → linux-arm64, `windows-11-arm` → win-arm64 - on the events that produce an artifact |
| `release` | waits on the builds **and** the tests, collects every artifact, writes a `SHA256SUMS.txt` over them, and attaches them to a GitHub Release |

Every leg writes a one-screen summary of what it produced - pack version, harness
pin, commit, toolchain, archive and size - to that run's own summary page.

`check-node-routes.mjs` and `check-pdf-node.mjs` are deliberately **not** part of
the CI job: they want a real harness profile installed, which this workflow does
not build. Run them locally.

### Which events run which legs

Standard GitHub-hosted runners are **free for a public repository**, so this split
is about wall-clock time and churn rather than the runner bill:

| Event | checks | rust-tests | core legs | extra legs | uploads |
|---|---|---|---|---|---|
| push to `main` / pull request | yes | yes | 3 of 6 | – | no |
| `workflow_dispatch` | yes | yes | 6 of 6 | yes | yes |
| `schedule` (weekly, Monday 06:17 UTC) | yes | yes | 6 of 6 | yes | yes |
| `release: published` | yes | yes | 6 of 6 | yes | yes |

A push is judged by one leg per operating system and uploads nothing: six
archives per push, expired unused, is the churn this removes. A superseded run is
cancelled (`concurrency`) - except a release, which is never cancelled mid-flight,
because a tag with half its assets attached is worse than a slow run.

The **weekly schedule** exists because the runner images move under us: the first
cut asked for `macos-13`, which had been retired, and only a runner can notice
that. The full matrix runs on a clock so an image change is caught before a
release rather than during one.

**Both ARM64 legs are required.** They were staged behind `experimental` /
continue-on-error while the newer toolchains settled; each has been green on every
run since, and a leg that may fail without failing the run is exactly how an ARM64
archive silently stops appearing. Making one optional again is a two-file act: the
matrix and the assertion in `check-dist-layout.mjs`.

### Triggers, one by one

- **`workflow_dispatch`** (Actions → distribute → *Run workflow*): the way to
  watch the whole thing and download the artifacts without pushing anything.
  Inputs: `version` (override the name), `release` (publish a Release when
  green), `tag` (which tag that release uses).
- **push to `main`** that touches anything that can change what ships: checks,
  tests and three build legs, publishes nothing.
- **pull request**: the same path as a push, with no `paths:` filter of its own -
  `check-dist-layout.mjs` reads the one tuned list out of this file, and two lists
  can drift.
- **`release: published`**: builds all six matrix targets and attaches their
  archives to the release. `gh release create v0.1.0 --generate-notes` is the
  whole ritual. The release build **fails** when the tag (minus a leading `v`)
  does not equal `package.json`'s version, so a tag can never name a version that
  was never built.

### Action pins

The four GitHub-official actions are pinned to a **commit SHA** (a tag is mutable,
a commit is not), each to the FIRST release of that action whose `runs.using` is
`node24` - checkout v5, setup-node v5, upload-artifact v6, download-artifact v7 -
because Node 20 actions are force-upgraded by GitHub and warn on every job, and
v5 of the artifact actions was still `node20` by default. `check-dist-layout.mjs`
fails on a mutable pin, so `@v4` cannot come back without the check failing too.

### Watching a run locally

You cannot run GitHub's Windows or macOS runners on your machine (`act` only
approximates Linux, and a container's WebKitGTK is not a runner's). What you can
do - and what this feature is built around - is make the local run and the CI run
**the same code and the same steps**:

| The workflow's step | What you run instead |
|---|---|
| `checks` job | `node scripts/checks/check-dist-layout.mjs`, `check-no-secrets.mjs`, `check-splash.mjs` |
| `rust-tests` job | `cargo test --manifest-path app/src-tauri/Cargo.toml` |
| Linux webview deps | nothing on Windows; on Linux, the `apt-get` line in the workflow |
| build + assemble + `-Verify` | `distribute.bat -Verify` / `./distribute.sh -Verify` |
| tag/version guard | `node -p "require('./package.json').version"` vs your tag |
| `upload-artifact` | the zip in `dist/` |
| `release` job | `gh release create <tag> --generate-notes`, then attach the zips |

So: run `distribute.bat -Verify` locally, and a green run means the CI step has
nothing new left to discover. What CI adds on top is only the *other* operating
systems and the artifact plumbing.

## 5. Tradeoffs and known limits

- **Unsigned binaries.** Windows SmartScreen will say "unknown publisher"
  (More info → Run anyway). macOS quarantines an unsigned binary - right-click →
  **Open**, or `xattr -d com.apple.quarantine ./vn-harness`, and the first launch
  from Finder rather than Terminal is the one that gets flagged.
- **No installers.** `app/src-tauri/tauri.conf.json` keeps `bundle.active: false`,
  so there is no `.msi`, `.dmg`, `.deb` or `.AppImage`, no Tauri CLI in CI, no
  icon ladder and no signing identity. Turning that on is the next step if the
  zip stops being enough.
- **macOS ships a bare binary**, not a `.app` bundle (see above), so there is no
  Dock icon or `Info.plist` identity yet.
- **Node.js 22+ and network on the target machine** - the shell is a launcher
  over `npx`, by design. The first run downloads the pinned harness.
- **Linux needs the WebKitGTK runtime** the binary was built against
  (`libwebkit2gtk-4.1`), which is what `ubuntu-22.04` in the matrix is for: a
  binary built there runs on anything at or above its glibc.
- **A distribution is a snapshot.** The plugins live-linked from `dist/.../packages`
  are copies; editing the repository does not change an already-built
  distribution.
- **Optional host engines** (a TeX engine for TikZ, poppler/mutool/Ghostscript
  and tesseract for the PDF tools) are not shipped and not required: the plugins
  degrade in a sentence when they are absent. `docs/COMPATIBILITY.md` has the
  details.

## 6. When something goes wrong

| Symptom | What it means |
|---|---|
| `cargo was not found on PATH` | install the Rust toolchain (https://rustup.rs) or pass `-SkipBuild` |
| `cargo build failed ..., and vn-harness is RUNNING right now (PID ...)` | a vn-harness window is open and **Windows locks a running binary**, so cargo cannot relink it. Close the window and run again, or pass `-SkipBuild` to package the binary already under `app/src-tauri/target/release` (check it is current first: nothing under `app/` newer than the `.exe`) |
| `The shell binary is not at ...` | you passed `-SkipBuild` with nothing built yet |
| `dist-manifest.txt includes '<x>', which does not exist` | a rule names a path this repository does not have |
| `The assembled distribution is missing: ...` | the copy lost a file - the sentinel guard fired. This is the check that catches a walk that flattened or nested a tree, and it has earned its place |
| `no "dsh web:" ready line within 180 seconds` | the harness did not start: no network on the first `npx` run, a `DSH_HOME` it cannot write, or a profile problem. The tail of the boot log is printed with the token redacted |
| `The ready line did not name a loopback address` | the harness reported something other than `127.0.0.1` and the check refused it rather than trusting it |
| `Warning: 127.0.0.1:<port> was still listening` | a stray `node` survived the stop; kill it |
| `START-HERE.bat` opens a window that says the harness server did not start | read its console: `npx` missing, no free port, or the pin unreadable |
| `run-web.bat` works but the distribution looks unadorned | the pack is not installed in the profile yet - run `START-HERE.bat`, or check it installed from **this** folder with `install.bat -DshHome <home>` |

## 7. See also

- [`app/README.md`](../app/README.md) - what the shell is and the two rules it
  holds about the launch token.
- [`docs/INSTALL.md`](INSTALL.md) - installing the pack into a profile by hand.
- [`scripts/checks/README.md`](../scripts/checks/README.md) - every tracked
  check, including `check-dist-layout.mjs`.
- `scripts/dist-manifest.txt` - the ship list, with the reasoning inline.
