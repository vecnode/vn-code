# ARCHITECTURE.md — the pack on one page

A plugin pack for **one install target**: the DeepSeek Harness **web** profile
(`npx @deepseek-ai/dsh web`, profile `web` under `$DSH_HOME`, default `~/.dsh`).
Every plugin here is a standard dsh **bundle**; nothing patches a harness file,
and there is no desktop edition. (`app/` is a *front door*: a small Rust console
program with no window and no web view that decides the root its harness home lives
in — `$VNCODE_HOME`, with the harness's `DSH_HOME` at `<root>/home` unless `-DshHome`
or a writable inherited `DSH_HOME` says otherwise — takes the key, installs the pack,
and then runs `scripts/run-web.*`, the same launcher a person double-clicks. That
launcher owns the harness, the ready line and the browser tab; the app owns none of
them.)

The three planes below are the whole system — what npm ships, what the `web`
profile boots, and what the page renders:

![Three planes of one install target: npm ships the bundle and its pinned vendor trees; the web profile live-links them and composes its rows at boot from the pinned line plus the pack's layers, the host half mounting the services behind the session cookie; the page loads the client bundle into the module table and calls back over authenticated exact-path routes](./assets/architecture.svg)

## How a plugin ships

- An npm package with `dsh.bundle` plus `cordis.patch.yml`. A UI plugin adds
  `dsh.client` and an `exports["./client"]` browser bundle.
- The browser bundle is a hand-written **module table** entry
  (`window.__ModuleLoader__.load({ id, factory })`) — no build step — except the
  few bundles marked GENERATED, which are forks of shipped ones or vendored
  engines.
- The installer live-links the package folders into the profile. A bundle edit
  shows up on a **page refresh** — the host stat-polls every client bundle
  (`dsh-client-hmr`, 500 ms) and republishes it through `rebuilt()`, re-reading
  the file, so nothing has to be restarted for it; a change to a *row*, or to a
  package's `lib/index.js` host half, is composed at boot, so it needs a
  **restart**.

## Rows, and who owns them

Core rows come from the pinned line. The pack adds its own rows and may
disable/replace a core row **in its own layer** — a later layer wins per row.

- `dsh-vn-master` installs **last**, so it is the pack's final word on any row.
  Pack-wide patches belong there: today it disables the four feedback/telemetry
  rows **and** the pack's own `browser` row (built, shipped and deliberately off —
  only this layer's two lines re-enable it).
- A package that **replaces** a row carries that row's disable with it
  (`dsh-rightbar` disables `ui-sidebar-right` / `ui-sidebar-files`,
  `dsh-open-in-app` disables `ui-open-in-app`), so a partial install still mounts
  exactly one of each surface.

## The plugins

| package | row | what it is |
|---|---|---|
| `dsh-vn-master` | `master` | the final layer: no-op host row + pack-wide row patches |
| `dsh-rightbar` | `rightbar` | the right bar: tab strip, docking panel, Start page, `sidebarRightTabs` registry + `sidebarRight` controller |
| `dsh-rightbar-files` | `rightbar-files` | the Files tab type on that bar (fork of the shipped file tree) |
| `dsh-editor` | `editor` | text/code editor tab (vendored CodeMirror 6), create-on-save, Markdown preview hand-off |
| `dsh-gittree` | `gittree` | read-only **History** tab: commit graph, message, changed files |
| `dsh-image` | `image` | image viewer tab: fit/zoom/pan, pixel readout |
| `dsh-audio` | `audio` | waveform tab (WAV/AIFF/FLAC) + the left column's **Media** panel (every audio, image, video and GIF file in the workspace, previewed and handed to the tab that owns it); no microphone, no device list, no output routing |
| `dsh-video` | `video` | video player tab; the bytes stay on the host and stream through a Range route |
| `dsh-media` | `media` | the pack's ffmpeg owner: `media_probe` / `media_run` / `media_frames`, the Range file route, remux jobs |
| `dsh-supercollider` | `supercollider` | SuperCollider the agent can play: ten `sc_*` tools over one warm `sclang` session (~31 ms a call, state kept) and a hand-written OSC client to `scsynth`, the installed `.schelp` reference indexed for `sc_help`, the `.scd` file workflow, five skills whose every example is compiled by a check, and one small console tab |
| `dsh-diagrams` | `diagrams` | Mermaid + TikZ + the vendored **Diagram Design** kit (204 examples, 44 documented types) and the seven `diagram_*` tools, validated on the host |
| `dsh-frontend-craft` | `frontend-craft` | front-end design craft: Impeccable's Apache-2.0 corpus (24 commands, 41 references) vendored at a pinned commit, its 61-rule detector built to a 4.5 MB WebAssembly module shipped in the package, `fe_context` / `fe_detect` / `fe_direction` / `fe_render` / `fe_artifact`, and a **Frontend** tab of findings, artifacts, directions and rendered previews. No network, no install, no engine download |
| `dsh-pdf` | `pdf` | PDF reader tab + `pdf_info` / `pdf_read` / `pdf_find` / `pdf_render` / `pdf_scan` over vendored pdf.js |
| `dsh-research` | `research` | research as a folder the agent fills and the right bar shows: a run is `RUN.json` + a `passport.json` that records the user's instructions and every gate answer **verbatim**, three `rs_*` tools, four routes, and the Research tab where a **person** — never the model — answers the two frame gates (`g1-rq`, `g2-intake`). No socket, no child process, no vendored engine |
| `dsh-ocr` | `ocr` | the pack's OCR owner: one tool, `ocr`, over `tesseract` from PATH or the OCR engine Windows itself ships (`lib/win-ocr.ps1` + `Windows.Media.Ocr`, which rasterizes a PDF page through `Windows.Data.Pdf`). Host-only — no client, no route |
| `dsh-docker` | `docker` | Docker (or Podman) as a surface: nine `docker_*` tools over the machine's CLI, a `docker_start` that launches Docker Desktop or a podman machine and waits for its **daemon**, and a Docker tab of containers and images. argv-only and validated; no `exec`, no `system prune`, no free-form `run` |
| `dsh-ollama` | `ollama` | Ollama as a **measured** surface: five `ollama_*` tools over the machine's own daemon — status (models on disk, what is loaded, and `ollama serve` when nothing answers), one bounded inference with the daemon's token counts and nanosecond durations, a benchmark that **refuses fewer than 3 runs** and reports a median with spread (cold vs warm stated at the first token), models with pull/delete confirmed by repeating the tag, embeddings with cosine similarity — three skills whose examples a check parses, and a **loopback fence** that refuses a daemon on another machine before any request. Host-only, no route, no browser half |
| `dsh-proto-lab` | `proto-lab` | the **prototyping lab**: five `lab_*` tools write a run into the lab root (`~/Desktop/vncode-lab/runs/<runtime>/<slug>/` on a machine with a Desktop, `<workspace>/lab` otherwise, `DSH_PROTO_LAB_ROOT` to move it; gitignored — the bundle ships the generator, not the runs), a runtime registry (`p5js`, `openframeworks`, and a template for the third) whose every module the checks drive, a committed example library beside each skill, an offline-vendored p5.js, and verification as an explicit ladder — `t0-structure` → `t4-measure` — that always names the tier it reached |
| `dsh-browser` | `browser` | web surface: the host fetches and renders a page in a disposable sandboxed browser (**currently disabled by the master**) |
| `dsh-themes` | `themes` | extra palettes (Nord, Monokai, Hacker, Cyber), header controls, branding, account-menu trimming |
| `dsh-cmdbar` | `cmdbar` | the command bar: a read-only transcript of the agent's own commands |
| `dsh-modal` | `modal` | the shared dialog surface (`modals` service) |
| `dsh-skills` | `skills` | the Skills browser: list, read and edit the skills the harness loads |
| `dsh-ui-state` | `ui-state` | UI state that outlives the process (column widths, dock height, zoom) |
| `dsh-open-in-app` | `native-open-in-app` | the file-manager half of Open In |

## Rules that hold everywhere

- **Zero npm dependencies.** Every engine is vendored in `lib/vendor/` or resolved
  from the harness already on disk. No plugin reaches the network on its own.
- **OS-neutral JavaScript.** The only per-OS code allowed is a launcher choosing a
  command: Windows runs PowerShell (5.1 *and* 7 — never assume 7), macOS/Linux run
  POSIX shell and never PowerShell.
- **Client-only by default.** Bytes and paths come from the harness's own
  `remote.workspaceFiles` (`readBytes`) or from the plugin's own authenticated
  route under `/api`. A plugin publishes a path policy only when it must, and then
  it realpath-checks on the host side.
- **Routes are exact paths, `GET`/`HEAD`/`POST` only** (plus the editor's `PUT`),
  registered through the connection's fetch registry, all behind the harness's
  session auth.
- **State** lives under `$DSH_HOME/<package>/`, scoped per conversation where that
  is the scope, written atomically, with an LRU cap where it can grow.
- **Everything is a bundle**: to change a row, add a layer; never edit core.

## Where the detail lives

- one page per plugin: `packages/<name>/README.md`;
- operations: `docs/INSTALL.md`, `docs/BUILD.md`, `docs/DEPLOY.md`,
  `docs/RELEASE.md`, `docs/PATHS.md`,
  `docs/COMPATIBILITY.md`;
- the app: `app/README.md` (the verbs, the bridge to `scripts/run-web.*`, the app's own
  root and the harness home inside it, and the three crates);
- security: `SECURITY.md`;
- **the checks are the contract**: `scripts/checks/*.mjs` pin route registrations, bundle
  wiring, budgets, the launcher contract and the credential rules. They are run by hand;
  CI runs the build, the tests and the size budget. `scripts/checks/README.md` lists them.
