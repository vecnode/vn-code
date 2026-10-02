# Building a vncode distribution

A distribution is **one folder you can click** and a **zip of it**. It contains no
compiled file at all: it is the plugin pack, the launchers, and the shell's
source. This page is how you build one and what is in it.

**A release is three of those zips, one per operating system, cut by hand with the
commands below.** There is no CI in this repository, on purpose — the whole ritual,
including how the Release is published, is [`docs/RELEASE.md`](RELEASE.md).

| | Windows | macOS / Linux |
|---|---|---|
| **Build it** | double-click `scripts\run-dist.bat` | `./scripts/dist.sh` |
| **The work** | `scripts/dist.ps1` | `scripts/dist.sh` |
| **Logs / flags** | `scripts\run-dist.bat -Help` | `./scripts/dist.sh -Help` |
| **A release** | `scripts\run-dist.bat -NoShell -Verify` | `sh scripts/dist.sh -NoShell -Verify` |

---

## 1. Why a distribution is a folder

`app/` is a **launcher**:

1. the shell binary walks up from itself for `.dsh-version.json` and reads the
   pinned harness version from it (there is no built-in fallback pin);
2. it starts the harness on a free loopback port - **from the vendored runtime when
   one is present** (`runtime/<rid>/`, built once by `scripts\dsh\vendor.ps1`),
   which is `node <runtime>/harness/…/lib/bin.js web --no-open`: no npm, no npx and
   no cache touched. With no vendored runtime it falls back to
   `npx @deepseek-ai/dsh@<pin> web --no-open`. `choose_launch()` in
   `app/src-tauri/src/main.rs` is the whole decision, and `app/README.md` records
   why the vendored path exists (an `npm error code EPERM` in a cache this account
   does not own, whose own advice was to run as Administrator);
3. it reads the `dsh web:` ready line and shows **that** url in a WebView2 /
   WKWebView / WebKitGTK window, holding the launch token in memory only.

**The plugins are not compiled into it, and neither is anything else.** The harness
**web profile** installs every bundle as a **live link** into `packages/`, so the
folder *is* the application — plain readable JavaScript. That is why:

- the distribution carries `packages/`, `.dsh-version.json`, `app/src-tauri/` (the
  shell's source) and the installer scripts;
- the folder must stay where it is – move it and the profile's links point at
  folders that no longer exist. Re-running `START-HERE.bat` / `./START-HERE.sh`
  re-installs from wherever it now lives;
- the target machine needs **Node.js 22+** and, on the first run, **network
  access** (the pinned harness is fetched through `npx` once and cached).

## 2. What comes out

```text
dist/
  vncode-<version>-<os>/           <- the folder you click
    START-HERE.bat  |  START-HERE.sh   <- generated: install, then open
    DIST-README.txt                    <- generated: requirements, flags, uninstall
    BUILD-INFO.json                    <- generated: version, pin, commit, toolchain
    SHA256SUMS.txt                     <- generated: SHA-256 of every file beside it
    .dsh-version.json                  <- the pin the launcher reads (required)
    packages/                          <- every bundle, live-linked by the profile
    scripts/                           <- the installers the folder installs itself with,
                                          including scripts/console/ (the shared launcher
                                          console layer every entry point calls)
    app/README.md  app/ui/  app/src-tauri/   <- the native window, AS SOURCE
    assets/vncode.svg  docs/  README.md  LICENSE  SECURITY.md
    scripts/install.bat | scripts/install.sh       <- the launchers: one pair
    scripts/uninstall.bat | scripts/uninstall.sh      per host, plus
    scripts/run-web.bat | scripts/run-web.sh          run-desktop.bat
  vncode-<version>-<os>.zip        <- the same folder, archived. THE ARTIFACT
```

`<os>` is **`win`, `mac` or `linux`** and `<version>` is `package.json`'s version
unless `-Version` overrides it. There is no architecture in the name and no
per-architecture build: the payload is OS-neutral, so **one assembly is what all
three operating-system releases download**, and the three zips differ only in the
name they are published under. `BUILD-INFO.json` records the machine that
assembled it (`win-x64`, `mac-arm64`, …) so the provenance is never lost.

**There is no `.exe` and no `.run`.** Those were the *single-file* builds: the zip
appended to the compiled shell binary, which unpacked itself and started. With no
compiled binary there is nothing to append the zip to, so a release ships the zip
alone. The capability is still in the scripts for anyone building a distribution
*with* a shell (`-SkipBuild` / a cargo build produces them as before).

**The distributer is not in the folder.** `scripts/run-dist.bat` / `scripts/run-dist.ps1`
and their `.sh` twins are the FACTORY, not the product: a recipient gets
`START-HERE.bat` and never needs the tool that assembled the folder. Both are
named explicitly in `scripts/dist-manifest.txt`'s skip rules rather than merely
left out, because `include scripts` would otherwise sweep them in – and a build
tool inside the thing it builds invites a nested `dist/` inside a distribution.
`check-dist-layout.mjs` fails when that exclusion is dropped.

**Every launcher shares one console layer.** `scripts/console/adapt.cmd` decides
which window a Windows entry point runs in (relaunching into Windows Terminal
when it exists and we are not already inside one), which PowerShell runs the
worker (`pwsh` 7 first, else Windows PowerShell 5.1 – both are first class), and
whether the window is held open at the end; `scripts/console/theme.ps1` and its
POSIX twin `scripts/console/theme.sh` own the colour policy (a terminal gets
colour, a redirected log never does, `NO_COLOR` always wins). That layer is why
the generated `START-HERE.bat` behaves like the launchers beside it instead of
like a hand-written one-off, and it ships inside `scripts/`.

### The shell ships as SOURCE, and that is the release shape

`app/src-tauri/` (the Rust source, its Cargo manifests, `build.rs`,
`tauri.conf.json`, the icons) and `app/ui/` (the splash page) are **in** the
folder. Together they are 13 files and about 300 KB, and they are what makes the
native window available to anyone who wants it:

```sh
cd app/src-tauri && cargo build --release
# then copy target/release/vncode-desktop[.exe] to the folder root as vncode[.exe]
```

**Nothing has to be compiled to USE vncode.** `START-HERE` → `scripts/run-web`
starts the same application in a browser tab and needs only Node.js; the window is
an option, not a requirement. That is why a release can compile nothing at all.

`target/` (the Rust build tree) and `gen/` (tauri-build's regenerated ACL schemas)
are still skipped: they are OUTPUT, not source.

> The **plugins** are the other half of "source, not binary", and it is structural
> rather than a choice: the web profile installs every bundle as a **live link**
> into `packages/`, so `packages/` has to be there as readable JavaScript for the
> app to have plugins at all. Hiding the plugin source means giving up live links
> and installing copies instead – see section 1.

**What is deliberately NOT in it** (`scripts/dist-manifest.txt` is the one list,
read by both halves): `app/src-tauri/target/`, `app/src-tauri/gen/`, `tools/`
(where the installer bootstraps pnpm), `.scratch/`, `.git/`, `docs/diagrams/` and
every `node_modules/`. That last one matters: the three
`packages/*/vendor/node_modules` trees are 200 MB of build **inputs** for
artifacts that are already committed under `lib/vendor/`, so shipping them would
multiply the archive by twenty for nothing. A full distribution is ~12.6 MB
(~4.9 MB zipped).

`dist/` is gitignored. It is a copy – after editing a plugin, re-run the
distributer.

## 3. Local use

```bat
:: Windows - the whole thing: assemble the folder and zip it
scripts\run-dist.bat

:: A RELEASE: compile nothing, ship app/ as source, name it for the OS alone
scripts\run-dist.bat -NoShell

:: ...and prove it runs: install into a throwaway DSH_HOME and boot the harness
scripts\run-dist.bat -NoShell -Verify

:: assemble and RUN the distribution, in the foreground
scripts\run-dist.bat -Run

:: start over; name the version something else
scripts\run-dist.bat -Clean
scripts\run-dist.bat -Version 0.2.0

:: assemble somewhere else, leaving dist/ alone - the case that NEEDS it is a
:: distribution that is still RUNNING: Windows will not let a live vncode.exe
:: be overwritten, so the new cut is built beside it and swapped in after the
:: window is closed
scripts\run-dist.bat -OutDir dist2
```

```sh
# macOS / Linux - the same flags, one file
./scripts/dist.sh -NoShell -Verify
./scripts/dist.sh -OutDir dist2      # assemble beside dist/, leaving it alone
sh ./scripts/dist.sh -Help          # if the executable bit was lost
```

Every run prints the folder and the archive to click.

### Which flags matter

- **`-NoShell`** is the release mode. It compiles nothing, ships `app/` as source,
  and names the artifact `vncode-<version>-<os>`.
- **`-SkipBuild`** reuses a binary already under `app/src-tauri/target/release`
  instead of running cargo. It is the *other* mode – a distribution **with** a
  built shell – and it is what `run-dist.ps1` selects by itself when the shell is
  not stale.
- **`-Verify`** is the end-to-end check and the one worth running before a release
  (section 4).
- `-Run` assembles and then runs the produced folder's own `START-HERE`; `-RunApp`
  runs just the packed binary, so it needs the binary mode.

### Why the second run is fast, and when it is not

`scripts\run-dist.bat` is the entry point to use on every edit, so it refuses to
redo work whose inputs did not change:

- **the shell**: in binary mode, if nothing under `app\src-tauri`, `app\ui` or the
  icon generator is newer than the built binary, cargo is never invoked
  (`-ForceBuild` overrides, `-SkipBuild` skips the decision entirely). In
  `-NoShell` mode there is no shell to be stale, so cargo is never reached.
- **the payload and the zip**: `scripts/dist.ps1` writes a build fingerprint into
  the folder recording the shell hash, the version, the ship list, the last commit
  **and a sha256 plus byte length for every shipped file**. The next run reuses the
  assembled folder only when all of those still match – including the tree on disk,
  in both directions, so a changed file and a stray file both count as a change.

Measured on this machine: a full assemble is ~9 s, and a run with nothing changed
is ~2 s. An edit to one shipped file is detected even when its size and timestamp
are unchanged – the hash is what decides – and the stale zip is **dropped and
rebuilt** rather than shipped.

`-Clean` throws all of that away and rebuilds from scratch, which is also what
happens automatically when there is no usable fingerprint.

One guard runs before anything is copied: `scripts/checks/check-dist-layout.mjs`
(the ship list, the two halves in step, and that no CI has crept back). The source
scan for credentials is `scripts/checks/check-no-secrets.mjs`; `run-dist.ps1` runs
both. A distribution is the artifact somebody installs, so a folder the
repository's own checks reject is not assembled at all. `-SkipChecks` builds anyway
and says out loud that the result is unverified. After assembly, `Assert-NoSecrets`
in `scripts/dist.ps1` scans what actually shipped for credential-shaped names,
which is the half a source scan cannot see.

### What `-Verify` actually does

1. copies the assembled folder to a temp directory – a distribution is a folder
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
5. prints the url with **`token=REDACTED`** – the token is a live credential and
   never reaches a log or a scrollback – and refuses a ready line that does not
   name a loopback address.

The throwaway home is deleted afterwards; `-KeepVerifyHome` keeps it.

> **If `-Verify` fails with `npm error code EPERM`.** npm is writing to a cache
> outside this folder (`npm config get cache`, usually `%LOCALAPPDATA%\npm-cache`)
> and this account may not write there. Point it at somewhere it can:
> `set npm_config_cache=%CD%\.scratch\npm-cache` before the run. The vendored
> runtime exists for the same reason on the app's side (section 1). A sandboxed
> shell that blocks npm's nested lifecycle spawns fails the same way and needs a
> normal terminal.

## 4. Cutting a release

`docs/RELEASE.md` is the full ritual. In short, on this machine:

```bat
scripts\run-dist.bat -NoShell -Verify -Clean
```

then rename/copy `dist\vncode-0.1.0-win.zip` for the other two names, write
`SHA256SUMS.txt`, and publish. Nothing else runs: no workflow, no runner, no cache.

### The three zips are one payload

Because the payload carries both entry-point halves (`START-HERE.bat` and
`START-HERE.sh`, `install`/`uninstall`/`run-web` in both flavours) and no compiled
file, the three archives are byte-identical apart from the `artifact`/`rid` fields
inside `BUILD-INFO.json`. That is a property worth stating rather than hiding: "three
releases" is about which file a visitor to the releases page should pick, not about
three different builds.

## 5. Tradeoffs and known limits

- **No compiled binary ships.** The native window is a `cargo build` away from the
  shipped source, and the browser path needs nothing. This is the deliberate cost
  of a release that compiles nothing: there is no `vncode.exe` to double-click in a
  fresh download, so the entry point is `START-HERE`.
- **The zips are unsigned, as before.** Antivirus and SmartScreen heuristics look
  at downloaded archives; there is no signature on a zip. When a built shell *is*
  shipped, the signing rules in `docs/BUILD.md` still apply to the binary.
- **No installers.** `app/src-tauri/tauri.conf.json` keeps `bundle.active: false`,
  so there is no `.msi`, `.dmg`, `.deb` or `.AppImage` and no signing identity.
- **Node.js 22+ and network on the target machine** – the browser path is a
  launcher over `npx`, by design. The first run downloads the pinned harness.
- **Building the window needs the toolchain** if you choose to: Rust from
  <https://rustup.rs>, and on Linux the WebKitGTK development packages
  (`libwebkit2gtk-4.1-dev` and friends) that a binary built elsewhere would have
  demanded as *runtime* packages instead.
- **A distribution is a snapshot.** The plugins live-linked from
  `dist/.../packages` are copies; editing the repository does not change an
  already-built distribution.
- **`packages/` is readable JavaScript, and cannot not be.** A source release is a
  source release; there is nothing obfuscated here to pretend otherwise.
- **Optional host engines** (a TeX engine for TikZ, poppler/mutool/Ghostscript
  and tesseract for the PDF tools, ffmpeg for the media tools) are not shipped and
  not required: the plugins degrade in a sentence when they are absent.
  `docs/COMPATIBILITY.md` has the details.

## 6. When something goes wrong

| Symptom | What it means |
|---|---|
| `cargo was not found on PATH` | you are in binary mode. Install Rust (<https://rustup.rs>, or pass `-SkipBuild` to reuse a build) - or pass `-NoShell` for a release, which compiles nothing |
| `cargo build failed …, and vncode is RUNNING right now (PID …)` | a vncode window is open and **Windows locks a running binary**, so cargo cannot relink it. Close the window and run again, or pass `-SkipBuild` |
| `The shell binary is not at …` | `-SkipBuild` with nothing built yet |
| `dist-manifest.txt includes '<x>', which does not exist` | a rule names a path this repository does not have |
| `The assembled distribution is missing: …` | the copy lost a file – the sentinel guard fired. This is the check that catches a walk that flattened or nested a tree, and it has earned its place |
| `npm error code EPERM` during `-Verify` | npm is writing to a cache outside this folder, or the host blocks its nested spawns. `set npm_config_cache=%CD%\.scratch\npm-cache`, and run it in a normal terminal (section 3) |
| `no "dsh web:" ready line within 180 seconds` | the harness did not start: no network on the first `npx` run, a `DSH_HOME` it cannot write, or a profile problem. The tail of the boot log is printed with the token redacted |
| `The ready line did not name a loopback address` | the harness reported something other than `127.0.0.1` and the check refused it rather than trusting it |
| `Warning: 127.0.0.1:<port> was still listening` | a stray `node` survived the stop; kill it |
| `START-HERE.bat` opens a window that says the harness server did not start | read its console: `npx` missing, no free port, or the pin unreadable |
| `scripts\run-web.bat` works but the distribution looks unadorned | the pack is not installed in the profile yet – run `START-HERE.bat`, or check it installed from **this** folder with `scripts/install.bat -DshHome <home>` |
| `scripts\run-desktop.bat` says neither `vncode.exe` nor `Cargo.toml` is above it | the folder is neither a checkout nor a source distribution. Use `START-HERE` – the window is optional |

## 7. See also

- [`docs/RELEASE.md`](RELEASE.md) – cutting and publishing a release, with no CI.
- [`app/README.md`](../app/README.md) – what the shell is and the two rules it
  holds about the launch token.
- [`docs/INSTALL.md`](INSTALL.md) – installing the pack into a profile by hand.
- [`scripts/checks/README.md`](../scripts/checks/README.md) – every tracked
  check, including `check-dist-layout.mjs`.
- `scripts/dist-manifest.txt` – the ship list, with the reasoning inline.
