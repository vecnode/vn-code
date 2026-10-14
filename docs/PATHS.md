# Where vncode keeps things

Two roots, and the second one lives inside the first.

## `$VNCODE_HOME` — the app's own root

The app creates it, proves it by writing, and it is the one directory a person can
move, back up or delete without touching a harness. The harness home is a folder
*inside* it, which is why the keys and the sessions live somewhere this app actually
controls:

```text
$VNCODE_HOME                     default: %LOCALAPPDATA%\vncode
  ├── window.json                the window's size and position
  ├── prefs.json                 the browser id and the home you chose
  ├── npm-cache/                 the npx fallback's cache - and nothing else's
  └── home/                      DSH_HOME by default: everything that matters
      ├── profiles/  sessions/  storages/  attachments/  skills/
      ├── .credentials.yaml      the model key
      └── dsh-pdf/  dsh-diagrams/  dsh-media/   the pack's caches
```

| platform | the default root |
|---|---|
| Windows | `%LOCALAPPDATA%\vncode` |
| macOS | `~/Library/Application Support/vncode` |
| Linux | `$XDG_DATA_HOME/vncode`, else `~/.local/share/vncode` |

`VNCODE_HOME` in the environment names another root; `<tree>/.vncode` is the last
resort, used only where even the data root cannot be written (a workspace-scoped
confinement, which is what this repository's own checks run inside). It is gitignored.

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
| — | `~/.dsh` | never a default: it belongs to whichever harness used it first. The panel offers **Use it** (share it, remembered) or **Adopt** (copy the durable things here) |

A candidate is used only after a real write probe, and every refused candidate is
named in the log and in the panel — see `docs/PLAN-egui-shell.md` §2.

For a harness started by **anything else** (`scripts\run-web.bat`, `npx dsh web`, the
CLI by hand), the harness's own resolver is still what decides, highest precedence
first — and it is `@deepseek-ai/dsh-home-paths` (`resolveDshHome`) that decides it:

| Precedence | Source | Windows | macOS / Linux |
|---|---|---|---|
| 1 | an explicit configured path (CLI `-DshHome`) | as given | as given |
| 2 | `$DSH_HOME` (empty or whitespace counts as unset) | as given | as given |
| 3 | the default | `%USERPROFILE%\.dsh` | `$HOME/.dsh` |

It is Node's `homedir()`, so the Windows half is `%USERPROFILE%` and never
`%APPDATA%`, and a `~`/`~/` prefix in a configured path expands against it.

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
