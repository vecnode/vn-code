# Where vncode keeps things

The app owns exactly one directory: the harness keeps all user data under a single
root, with the same shape on all three operating systems and no XDG or
`%APPDATA%`/`%LOCALAPPDATA%` split. `@deepseek-ai/dsh-home-paths`
(`resolveDshHome`) resolves it, highest precedence first:

| Precedence | Source | Windows | macOS / Linux |
|---|---|---|---|
| 1 | an explicit configured path (CLI `-DshHome`, the desktop launcher's `-DshHome`) | as given | as given |
| 2 | `$DSH_HOME` (empty or whitespace counts as unset) | as given | as given |
| 3 | the default | `%USERPROFILE%\.dsh` | `$HOME/.dsh` |

It is Node's `homedir()`, so the Windows half is `%USERPROFILE%` and never
`%APPDATA%`, and a `~`/`~/` prefix in a configured path expands against it.

## What lives under it
| Path (relative to the home) | What it is |
|---|---|
| `sessions/` | one file per conversation (the durable transcript) |
| `storages/` | `workspace.json` and session projection caches - host-side UI state |
| `settings.yaml.imported` | the harness's legacy preference file, imported once and renamed; the pack's own state is not here |
| `.credentials.yaml` | the model API key |
| `.anonymous-user-id` | one random id, created on first run |
| `attachments/v1/files/…` | files pasted or attached into a conversation |
| `skills/` | the pack's copied skills (`mermaid-diagrams`, `tikz-diagrams`, `pdf-analysis`, `ffmpeg-cli`, `ffprobe-cli`, `canvas-design`, `social-banners`, `web-render`), each under a `.vncode-<package>` marker |
| `profiles/<name>/` | the profile: `package.json`, `cordis.yml`, `cordis.patch.yml`, `pnpm-lock.yaml`, `node_modules/`, `.dsh-module-fallback/` |
| `profiles/node_modules/` | junctions/symlinks into the installation (below) |
| `dsh-pdf/artifacts/<sha256>/…` | PDF parse cache, LRU at 512 MiB |
| `dsh-diagrams/sessions/<session>.json`, `library.json`, `artifacts/…` | diagram state, the shared library, the artifact cache (200 MiB) |
| `dsh-media/bin/<platform>-<arch>/` | the provisioned ffmpeg/ffprobe copy and its `install.json` stamp - absent where ffmpeg is already on `PATH` |
| `dsh-media/playable/<key>.mp4` | the browser-playable remux/transcode cache, LRU at 8 GiB |
| `vncode/window.json` | the desktop window's size and position |

The pack's own trees are the last five, and they follow the harness's rule: a
plugin's state goes under the harness home and nowhere else. Three are caches with a
ceiling (512 MiB, 200 MiB, 8 GiB), and `dsh-media/bin` is the one **program** the
pack writes - only after the bytes match the SHA-256 it pins.

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
## Outside the home

| Location | Windows | macOS / Linux | Why |
|---|---|---|---|
| npm / npx cache | `%LOCALAPPDATA%\npm-cache\_npx\<hash>` | `~/.npm/_npx/<hash>` | `npx @deepseek-ai/dsh@<pin>` unpacks the installation here, and the profile's junctions point into it |
| pnpm store | `%LOCALAPPDATA%\pnpm\store\v3` | `~/Library/pnpm/store`, `~/.local/share/pnpm/store` | the store the profile was verified against (`node_modules/.modules.yaml`) |
| pnpm itself | `<repo>/tools/pnpm<N>/` | same | the installer bootstraps it when the system copy is too old |

Two are outside on purpose: the **Desktop** (resolved per request - Windows plain or
OneDrive-redirected, `$XDG_DESKTOP_DIR`, the home folder last) for the `dsh-themes`
screenshot and `dsh-diagrams` exports, and **temp** (`os.tmpdir()`) for `-Verify`,
`pdf_render` and TikZ compiles.
## Per OS, in one place

| | Windows | macOS | Linux |
|---|---|---|---|
| npm cache root | `%LOCALAPPDATA%\npm-cache` | `~/.npm` | `~/.npm` |
| pnpm store root | `%LOCALAPPDATA%\pnpm\store` | `~/Library/pnpm/store` | `~/.local/share/pnpm/store` |
| link kind | directory junction | symlink | symlink |
| webview runtime | WebView2 | WKWebView | WebKitGTK 4.1 |

## The rule this page states
A distribution must be movable, and the only directory it may depend on outside
itself is the harness home - which is why the profile needs no registry and why
`runtime/` is a distribution tree rather than a repository one.
