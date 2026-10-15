# Where vncode keeps things

Two roots, and the second one lives inside the first - and **one** of the first: the
window record, `prefs.json`, the npm cache and the home all live under the single root
the ladder chose, so a root that cannot be written never splits the app's memory in two.

## `$VNCODE_HOME` — the app's own root

The app creates it, proves it by writing, and it is the one directory a person can
move, back up or delete without touching a harness. The harness home is a folder
*inside* it, which is why the keys and the sessions live somewhere this app actually
controls:

```text
$VNCODE_HOME                     portable: <tree>\.vncode
  ├── window.json                default: %LOCALAPPDATA%\vncode
  ├── prefs.json                 the browser id and the home you chose
  ├── npm-cache/                 the npx fallback's cache - and nothing else's
  ├── browser/                   a Chromium THIS app starts, when its own profile is refused
  ├── webview/                   the pane's engine profile, in a build that has the pane
  └── home/                      DSH_HOME by default: everything that matters
      ├── profiles/  sessions/  storages/  attachments/  skills/
      ├── .credentials.yaml      the model key
      └── dsh-pdf/  dsh-diagrams/  dsh-media/   the pack's caches
```

`browser/` and `webview/` are the two directories the app writes for **programs it starts**,
and they live under this root for the same reason the npm cache does: a session that refuses
the machine's own data directory does not refuse this one, so a browser or an engine that
cannot keep its profile where it normally would can keep it here. They are kept **apart** on
purpose - a Chromium profile and a WebView2 profile in one directory is a way to lose both -
and neither is a cache: deleting one costs the browser its history, not the app any state.

The root ladder, in order, each rung proved by writing:

| # | candidate | when it is used |
|---|---|---|
| 1 | `VNCODE_HOME` | the environment named it |
| 2 | **`<tree>/.vncode`** | this folder is a **portable installation**: it carries the marker (`PORTABLE`, written by `Keep everything in this folder` in the panel's `Details`), **or** it already holds a home - the app has put this person's sessions there, and preferring the platform directory now would start a second installation beside them |
| 3 | platform data root + `vncode` | the default |
| 4 | `<tree>/.vncode` | the last resort, where even the data root cannot be written (a workspace-scoped confinement, which is what this repository's own checks run inside). It is gitignored |

| platform | the default root (rung 3) |
|---|---|
| Windows | `%LOCALAPPDATA%\vncode` |
| macOS | `~/Library/Application Support/vncode` |
| Linux | `$XDG_DATA_HOME/vncode`, else `~/.local/share/vncode` |

`prefs.json` is read from the root this ladder chose, with the platform copy as a
**read-only fallback** for one migration: an earlier build wrote the file under the
platform root while the root in use was beside the checkout, so the home somebody chose
could not be read back and the first-run question returned on every launch. Every save
goes to the ladder's root.

**Every path a person or a parent gives is cleaned before it is used** (`userpath.rs`):
a leading `~` is expanded the way the harness expands it, a relative path is resolved
against the directory the app was started in, `.` and `..` are folded lexically, a path
that is rooted without a drive (`/tmp/x` on Windows) is attached to the current drive, an
empty value or one containing a NUL is refused by name, and what is exported to a child is
the REAL path - with the Windows `\\?\` verbatim form stripped, because `cmd`, PowerShell,
JSON consumers and this pack's own checks all disagree with it. A directory the app
CREATED is hardened to `0700` on Unix (the home holds `.credentials.yaml`; the root holds
an npm cache that can hold registry credentials); a directory it merely JOINED is never
touched, which is why the write probe reports whether it created it.

**Why the furniture is outside the home.** `-DshHome` may point the harness home at
`~/.dsh`, or at a folder shared with `scripts\run-web.bat`, and this app's own records
must survive that - the argument [app/crates/vn-shell-core/src/appdata.rs](../app/crates/vn-shell-core/src/appdata.rs)
records for the npm cache, applied to the window record too.

## `$DSH_HOME` — the harness home

The harness keeps all its user data in one folder, with the same shape on all three
operating systems and no `%APPDATA%`/XDG split. The app hands it over explicitly, and
its own ladder decides which folder that is:

| # | candidate | when it is used |
|---|---|---|
| 1 | `-DshHome <dir>` | the person named it. **A refusal here ends the run** — an explicit instruction is never silently ignored |
| 2 | the home chosen in the panel (`prefs.json`) | a click outranks an environment variable; if it has moved or gone, the ladder continues and says so |
| 3 | an inherited `DSH_HOME` | it is writable: the app JOINS the home of the session that started it, sharing its sessions and its key |
| 4 | `<VNCODE_HOME>/home` | **the default**, created and proved by the app |
A candidate is used only after a real write probe, and every refused candidate is
named in the log and in the panel — see `docs/PLAN-egui-shell.md` §2.

**Nothing outside the app's own root is ever the home it runs against.** The harness's own
default (`~/.dsh`) was once row 4 here — a one-time courtesy, used while the app's own home
was still empty — and it is gone: a folder that carries everything it needs must not reach
into a person's profile to START. The two things that rung answered are answered here: Start
installs this pack into the home in use, and the key row asks for the key. That directory
survives as the READ-ONLY SOURCE of the first-run COPY, which brings a person's own
sessions and key into the folder and never runs against it.

The same rule makes the first-run screen's source safe to offer: the harness's own
first-boot furniture (a composed `profiles/`, an empty `.credentials.yaml`, a `storages/`)
cannot make a home look used, and a home that IS used is never overwritten by a copy.

For a harness started by **anything else** (`npx dsh web`, the CLI by hand), the harness's
own resolver is still what decides, highest precedence first — and it is
`@deepseek-ai/dsh-home-paths` (`resolveDshHome`) that decides it:

| Precedence | Source | Windows | macOS / Linux |
|---|---|---|---|
| 1 | an explicit configured path (CLI `-DshHome`) | as given | as given |
| 2 | `$DSH_HOME` (empty or whitespace counts as unset) | as given | as given |
| 3 | the default | `%USERPROFILE%\.dsh` | `$HOME/.dsh` |

The pack's OWN launcher, `scripts\run-web.bat` / `./scripts/run-web.sh`, resolves the home
before it starts anything, and it agrees with the app rather than with the default above:

| # | candidate | when it is used |
|---|---|---|
| 1 | `-DshHome <dir>` | the person named it for this run |
| 2 | an inherited `DSH_HOME` | a harness session started this shell, and the run JOINS it |
| 3 | **`<tree>/.vncode/home`** | this folder is a **portable installation**: it carries the `PORTABLE` marker, or it already holds a home. The pack, the sessions and the key then need nothing in the user's profile, and `run-web` starts the SAME home the panel does — two launchers pointing at two homes is how a pack ends up installed in one and missing in the other |
| 4 | `~/.dsh` (`%USERPROFILE%\.dsh`) | the harness's own default, for a folder that is not portable |

It is Node's `homedir()`, so the Windows half is `%USERPROFILE%` and never
`%APPDATA%`, and a `~`/`~/` prefix in a configured path expands against it. A portable run
also points `npm_config_cache` at `<root>/npm-cache` (unless the caller set one), so the
npx cache does not land in the user's profile either. The portable test is the same rule
`vn_shell_core::appdata::portable_root` applies, and `check-scripts.mjs` reads both
launcher workers for the marker and the `home` folder so the three copies cannot drift.

## What lives under the harness home
| Path (relative to the home) | What it is |
|---|---|
| `sessions/` | one file per conversation (the durable transcript) |
| `storages/` | `workspace.json` and session projection caches - host-side UI state |
| `settings.yaml.imported` | the harness's legacy preference file, imported once and renamed; the pack's own state is not here |
| `.credentials.yaml` | the model API key |
| `.anonymous-user-id` | one random id, created on first run |
| `attachments/v1/files/…` | files pasted or attached into a conversation |
| `skills/` | the pack's copied skills (`mermaid-diagrams`, `tikz-diagrams`, `diagram-design`, `pdf-analysis`, `ffmpeg-cli`, `ffprobe-cli`, `web-render` and SuperCollider's five), each under a `.vncode-<package>` marker |
| `profiles/<name>/` | the profile: `package.json`, `cordis.yml`, `cordis.patch.yml`, `pnpm-lock.yaml`, `node_modules/`, `.dsh-module-fallback/` |
| `profiles/node_modules/` | junctions/symlinks into the installation (below) |
| `dsh-pdf/artifacts/<sha256>/…` | PDF parse cache, LRU at 512 MiB |
| `dsh-diagrams/sessions/<session>.json`, `library.json`, `artifacts/…` | diagram state, the shared library, the artifact cache (200 MiB) |
| `dsh-media/bin/<platform>-<arch>/` | the provisioned ffmpeg/ffprobe copy and its `install.json` stamp - absent where ffmpeg is already on `PATH` |
| `dsh-media/playable/<key>.mp4` | the browser-playable remux/transcode cache, LRU at 8 GiB |

The pack's own trees are the last five, and they follow the harness's rule: a
plugin's state goes under the harness home and nowhere else. Three are caches with a
ceiling (512 MiB, 200 MiB, 8 GiB), and `dsh-media/bin` is the one **program** the
pack writes - only after the bytes match the SHA-256 it pins. **Adopt never copies
any of them**: they are reproducible, and the credentials file is the only thing
outside `sessions/`, `storages/`, `attachments/` and `skills/` that a person may
choose to bring across.

## The profile is mostly links

`$DSH_HOME/profiles/web/node_modules` holds one `link:` junction per bundle under
`packages/`, plus `.pnpm/` holding only `lock.yaml`; `pnpm-lock.yaml` contains
`link:` specs alone, with no registry resolution anywhere, and the base bundles
(`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`) resolve through the
installation fallback. **A profile install therefore needs no registry** - only the
installation closure and a pnpm to write the links.

`$DSH_HOME/profiles/node_modules/` is a set of junctions (symlinks on macOS/Linux)
into the installation, rebuilt at every boot by `healProfilesModuleFallback` from an
anchor relative to the harness itself
(`const INSTALL_ANCHOR = fileURLToPath(new URL("../package.json", import.meta.url))`).
Wherever `@deepseek-ai/dsh` is run from *is* the installation, so vendoring the
harness into a distribution folder makes that folder the installation with no
harness change; today that anchor points into the npm cache below.

## Outside both roots

| Location | Windows | macOS / Linux | Why |
|---|---|---|---|
| the app's own npm cache | `<VNCODE_HOME>\npm-cache` | `<VNCODE_HOME>/npm-cache` | `npx` writes wherever `npm_config_cache` points, and a cache an ELEVATED run made unwritable is the measured `EPERM` that moved this out of the machine-wide directory |
| npm / npx cache | `%LOCALAPPDATA%\npm-cache\_npx\<hash>` | `~/.npm/_npx/<hash>` | `npx` unpacks the installation here, and the profile's junctions point into it |
| pnpm store | `%LOCALAPPDATA%\pnpm\store\v3` | `~/Library/pnpm/store`, `~/.local/share/pnpm/store` | the store the profile was verified against (`node_modules/.modules.yaml`) |
| pnpm itself | `<repo>/tools/pnpm<N>/` | same | the installer bootstraps it when the system copy is too old |

Two are outside on purpose: the **Desktop** (resolved per request - Windows plain or
OneDrive-redirected, `$XDG_DESKTOP_DIR`, the home folder last) for the `dsh-themes`
screenshot and `dsh-diagrams` exports, and **temp** (`os.tmpdir()`) for TikZ compiles
and `pdf_render`.

## Per OS, in one place

| | Windows | macOS | Linux |
|---|---|---|---|
| npm cache root | `%LOCALAPPDATA%\npm-cache` | `~/.npm` | `~/.npm` |
| pnpm store root | `%LOCALAPPDATA%\pnpm\store` | `~/Library/pnpm/store` | `~/.local/share/pnpm/store` |
| link kind | directory junction | symlink | symlink |
| webview runtime | WebView2 | WKWebView | WebKitGTK 4.1 |

## The rule this page states
A distribution must be movable, and the only directories it may depend on outside
itself are the app's own root and the harness home - which is why the profile needs no
registry, and why `runtime/` is a distribution tree rather than a repository one.
