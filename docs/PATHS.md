# Where vncode keeps things

**One root matters: the harness home.** The harness keeps all its user data in one folder,
with the same shape on all three operating systems and no `%APPDATA%`/XDG split, and this
pack writes nothing of its own outside it. The launcher resolves that folder, prints the one
it chose and points the harness at it; everything below is a consequence of that one rule.

## The repository root

The checkout is the distribution. It carries the pack (`packages/`), the launchers
(`scripts/`), the docs and one manifest:

| Path | What it is |
|---|---|
| `.dsh-version.json` | the pinned harness line (`dsh`) and the pack manifest; `check-node-routes.mjs` enforces that its versions match every `package.json` |
| `.vncode/` | gitignored, and used only when this folder is a portable installation: it holds that installation's `home/` and `npm-cache/` |
| `tools/pnpm<N>/` | a pnpm the installer bootstrapped locally, when the system copy was too old for the profile |

## The harness home ladder

Both `run-web` workers implement this identically, each rung before the next:

| # | candidate | when it is used |
|---|---|---|
| 1 | `-DshHome <dir>` | the person named it for this run |
| 2 | an inherited `DSH_HOME` | a harness session started this shell, and the run JOINS that home, sharing its sessions and its key |
| 3 | **`<tree>/.vncode/home`** | this folder is a **portable installation**: it carries the `PORTABLE` marker (an empty file, written by hand), **or** it already has a `home` folder. The pack, the sessions and the key then need nothing in the user's profile |
| 4 | `~/.dsh` (`%USERPROFILE%\.dsh`) | the harness's own default, for a folder that is not portable |

Rung 3 exists so a folder that carries everything else carries its home too: the pack, the
sessions and the key stay together, and a run started from anywhere in that folder finds the
same one. A portable run also points `npm_config_cache` at `<tree>/.vncode/npm-cache` unless
the caller set one, so the npx cache does not land in the user's profile either.
`check-scripts.mjs` reads both workers for the marker and the `home` folder, so the two
copies of the rule cannot drift.

## `$DSH_HOME` — the harness home

For a harness started by anything else (`npx dsh web`, the CLI by hand), the harness's own
resolver is what decides, highest precedence first - it is `@deepseek-ai/dsh-home-paths`
(`resolveDshHome`) that answers:

| Precedence | Source | Windows | macOS / Linux |
|---|---|---|---|
| 1 | an explicit configured path (CLI `-DshHome`) | as given | as given |
| 2 | `$DSH_HOME` (empty or whitespace counts as unset) | as given | as given |
| 3 | the default | `%USERPROFILE%\.dsh` | `$HOME/.dsh` |

It is Node's `homedir()`, so the Windows half is `%USERPROFILE%` and never `%APPDATA%`, and
a `~`/`~/` prefix in a configured path expands against it.

## What lives under the harness home

| Path (relative to the home) | What it is |
|---|---|
| `sessions/` | one file per conversation (the durable transcript) |
| `storages/` | `workspace.json` and session projection caches - host-side UI state |
| `settings.yaml.imported` | the harness's legacy preference file, imported once and renamed; the pack's own state is not here |
| `.credentials.yaml` | the model API key, when the harness stored it there |
| `.env` | `DEEPSEEK_API_KEY=...`, the line the harness also reads |
| `.anonymous-user-id` | one random id, created on first run |
| `attachments/v1/files/…` | files pasted or attached into a conversation |
| `skills/` | the pack's copied skills (`mermaid-diagrams`, `tikz-diagrams`, `diagram-design`, `pdf-analysis`, `ffmpeg-cli`, `ffprobe-cli`, `web-render` and SuperCollider's five), each under a `.vncode-<package>` marker |
| `profiles/<name>/` | the profile: `package.json`, `cordis.yml`, `cordis.patch.yml`, `pnpm-lock.yaml`, `node_modules/`, `.dsh-module-fallback/` |
| `profiles/node_modules/` | junctions/symlinks into the installation (below) |
| `dsh-pdf/artifacts/<sha256>/…` | PDF parse cache, LRU at 512 MiB |
| `dsh-diagrams/sessions/<session>.json`, `library.json`, `artifacts/…` | diagram state, the shared library, the artifact cache (200 MiB) |
| `dsh-media/bin/<platform>-<arch>/` | the provisioned ffmpeg/ffprobe copy and its `install.json` stamp - absent where ffmpeg is already on `PATH` |
| `dsh-media/playable/<key>.mp4` | the browser-playable remux/transcode cache, LRU at 8 GiB |

The pack's own trees are the last four, and they follow the harness's rule: a plugin's
state goes under the harness home and nowhere else. Three are caches with a ceiling
(512 MiB, 200 MiB, 8 GiB), and `dsh-media/bin` is the one **program** the pack writes - and
only after the bytes match the SHA-256 it pins.

## The profile is mostly links

`$DSH_HOME/profiles/web/node_modules` holds one `link:` junction per bundle under
`packages/`, plus `.pnpm/` holding only `lock.yaml`; `pnpm-lock.yaml` contains `link:` specs
alone, with no registry resolution anywhere, and the base bundles
(`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`) resolve through the installation
fallback. **A profile install therefore needs no registry** - only the installation closure
and a pnpm to write the links.

`$DSH_HOME/profiles/node_modules/` is a set of junctions (symlinks on macOS/Linux) into the
installation, rebuilt at every boot by `healProfilesModuleFallback` from an anchor relative
to the harness itself (`const INSTALL_ANCHOR = fileURLToPath(new URL("../package.json",
import.meta.url))`). Wherever `@deepseek-ai/dsh` is run from *is* the installation, which is
why the anchor needs no configuration and today points into the npm cache below.

## Outside the home

| Location | Windows | macOS / Linux | Why |
|---|---|---|---|
| npm / npx cache | `%LOCALAPPDATA%\npm-cache\_npx\<hash>` | `~/.npm/_npx/<hash>` | `npx` unpacks the installation here, and the profile's junctions point into it |
| a portable folder's cache | `<tree>\.vncode\npm-cache` | `<tree>/.vncode/npm-cache` | the cache follows a portable installation, so a run leaves the user's profile alone. An explicit `npm_config_cache` always wins |
| pnpm store | `%LOCALAPPDATA%\pnpm\store\v3` | `~/Library/pnpm/store`, `~/.local/share/pnpm/store` | the store the profile was verified against (`node_modules/.modules.yaml`) |
| pnpm itself | `<repo>/tools/pnpm<N>/` | same | the installer bootstraps it when the system copy is too old |

Two more are outside on purpose: the **Desktop** (resolved per request - Windows plain or
OneDrive-redirected, `$XDG_DESKTOP_DIR`, the home folder last) for the `dsh-themes`
screenshot and `dsh-diagrams` exports, and **temp** (`os.tmpdir()`) for TikZ compiles and
`pdf_render`.

## Per OS, in one place

| | Windows | macOS | Linux |
|---|---|---|---|
| npm cache root | `%LOCALAPPDATA%\npm-cache` | `~/.npm` | `~/.npm` |
| pnpm store root | `%LOCALAPPDATA%\pnpm\store` | `~/Library/pnpm/store` | `~/.local/share/pnpm/store` |
| link kind | directory junction | symlink | symlink |
| the launcher's shell | PowerShell 5.1 or 7 (behind a `.bat` double-click) | POSIX `sh` | POSIX `sh` |

## The rule this page states

A distribution must be movable, and the only directories it may depend on outside itself are
the harness home and the npm cache. That is why the profile needs no registry, and why
unzipping a release anywhere is a working installation.
