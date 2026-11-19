# AGENTS.md — working in vncode

A plugin pack for **one install target**: the DeepSeek Harness **web** profile
(`npx @deepseek-ai/dsh web`; profile `web` under `$DSH_HOME`, default `~/.dsh`).
Everything ships as a standard dsh **bundle**.

Read `ARCHITECTURE.md` for the map, the plugin's own `packages/<name>/README.md`
for its behaviour, `SECURITY.md` before touching credentials or the launcher, and
`scripts/checks/README.md` for what proves a change.

## Hard rules — do not break these

1. **One install target.** The web profile only. No desktop edition, no
   `-Target desktop`, no desktop detection, **no window and no web view** — and no
   native code at all: this repository is Node/TS/JS, and a compiler is not among its
   build dependencies. `scripts/run-web.*` IS the front door: it decides the home, runs
   the pinned `dsh web --no-open`, watches the ready line and opens the tab in Chrome. It
   starts no second server, holds no port of its own and draws nothing, and it must keep
   working on a machine that has nothing but Node.js and npm.
2. **Nothing patches core.** A row change is a new bundle layer.
   `dsh-vn-master` is the pack's final layer (it installs last), so pack-wide row
   patches belong there, and a package that *replaces* a row carries that row's
   disable with it.
3. **Platforms.** Plugin code is OS-neutral. Windows tooling is PowerShell and
   must work on **5.1 and 7** (`Join-Path`, `[System.IO.Path]::PathSeparator`,
   `$PSVersionTable`; never `$IsWindows` unguarded, never a hardcoded `npx.cmd`,
   `%USERPROFILE%` or `\`). macOS/Linux tooling is POSIX shell and must **never**
   require PowerShell — Node.js with npm/npx and nothing else.
4. **Launchers.** Every entry point lives in `scripts/`, one per host (`run-web.bat`
   and `run-web.ps1` on Windows, `run-web.sh` on macOS/Linux), and there are **no
   forwarders**. The install and uninstall pairs live one level down in
   `scripts/setup/`, beside the workers they call. Nothing else sits at the top level:
   `console/` is the shared console layer, `tools/` is maintainer-only, `checks/` is the
   contract, and `check-scripts.mjs` fails on a stray file. On Windows the entry point
   calls the PowerShell worker beside it (or the console layer, for the setup pair) and
   gets its console behaviour from the one shared layer:

       if not defined VNCODE_CONSOLE set "VNCODE_ARGV=%*"
       call "%~dp0console\adapt.cmd" "%~f0" "<window title>"
       if errorlevel 10 exit /b 0         :: a Windows Terminal window owns the run
       if errorlevel 2  goto :nopowershell :: no PowerShell on this machine

   An entry point forwards `%VNCODE_ARGS%` and **never** `%*`; `adapt.cmd` must
   not `setlocal`; colour lives in `scripts/console/theme.ps1` and its POSIX twin
   `theme.sh`.
5. **The launch token is a live credential.** It is read in memory, never written
   to a file, echoed, or handed to a shell, and a URL that is not loopback is
   refused rather than opened. It appears in exactly two files, `scripts/run-web.ps1`
   and `scripts/run-web.sh`, and nowhere else.
6. **No secrets, ever.** Run `node scripts/checks/check-no-secrets.mjs` before
   pushing. A vendored bundle can ship its author's own credentials: redact them
   in the **build** (a patch under that engine's `vendor/<name>/patches/`, read
   before the artifact is committed), never with an allowlist entry.
7. **Zero npm dependencies** in shipped packages, and no network egress a plugin
   starts on its own. Engines are vendored under `lib/vendor/` or resolved from
   the harness already on disk.
8. **CI proves the tree; the checks prove the change.** `.github/workflows/ci.yml` is
   one job in a `node:22` container - the runtime `package.json` declares - running
   `check-no-secrets.mjs` and `check-scripts.mjs` behind a Node floor assertion. There is
   no compiler, no build and no per-OS matrix, because nothing here is native. **A push
   to `main` starts no CI at all**: commits and pushes are free, and CI runs at the
   boundaries (a PR, a manual dispatch, or the cut). A release publishes **one**
   artefact: `vncode-<version>.zip`, a zip of this repository at the tag, which is the
   whole distribution. The checks in `scripts/checks/` are still run by hand; they are
   the contract, and `scripts/checks/README.md` lists them.

## Layout

- `packages/<bundle>/` — one standalone bundle per plugin, each with its own
  one-page README: `dsh-vn-master` (final layer), `dsh-rightbar` +
  `dsh-rightbar-files` (the right bar and its Files tab), `dsh-editor`,
  `dsh-gittree` (History), `dsh-image`, `dsh-image-upscale` (Real-ESRGAN over the
  Python and torch the machine already has: four `upscale_*` tools, a NEW file per
  image and never the original, a manifest batch that is a dry run by default, and a
  weight fetch that refuses without `confirm` — host-only, zero npm dependencies, no
  bundled engine), `dsh-audio`, `dsh-video`, `dsh-media`
  (the only owner of ffmpeg), `dsh-supercollider` (SuperCollider: eleven `sc_*` tools
  over a warm `sclang` session and a hand-written OSC client, the `.schelp`
  reference indexed, five skills whose every example a check compiles, one small
  console tab — host half plus UI, no bundled binary), `dsh-diagrams`,
  `dsh-frontend-craft` (front-end design: Impeccable's Apache-2.0 corpus vendored
  at a pinned commit plus its 61-rule detector built to WebAssembly inside the
  package, five `fe_*` tools including a headless-browser render that measures
  contrast/tap targets/overflow, one Frontend tab — no network, no install, no
  engine download), `dsh-shaders` (GLSL that compiles for real: seven `shader_*`
  tools over the machine's own browser through ANGLE/SwiftShader, a rung ladder
  that is always stated — `v1-static` / `v2-compiled` / `v3-drawn` /
  `v4-measured` — with diagnostics mapped onto the author's line numbers, five
  dialects kept apart because they are not interchangeable, emit for web / `.frag`
  / ISF / an FFGL **scaffold** / Shadertoy, a Shaders tab with a live WebGL preview
  and `@param` sliders, five skills whose every example a check compiles, and 106
  vendored Radiant pages plus 20 GLSL modules, 11 templates, 11 pieces and a
  48-link index, each re-derivable offline), `dsh-pdf`,
  `dsh-screenshot` (screenshots that are worth publishing: four tools over three
  surfaces and one placement pass - `shot_url` renders a page in a disposable
  headless Chrome/Edge, a loopback dev server or a workspace file with every other
  name resolved to `NOTFOUND` and a public site only with `remote: true`, at a
  named viewport with dpr / dark / full page / an element clip, reporting the PNG's
  own IHDR as its size; `shot_window` and `shot_screen` capture a real application
  window or the display on Windows through Win32 `PrintWindow` plus a screen
  fallback that names itself and `GetDpiForWindow` as the scale, and answer in one
  sentence elsewhere; `shot_place` writes a deterministic
  `<slug>-<viewport>[-dark].png` and a merged manifest and returns the README
  `<img>`/`<picture>` block with alt text required, a dry run by default; it never
  runs git and holds no credential, ships no engine, adds no dependency, and
  carries three skills; host-only, two routes reserved for its tab),
  `dsh-wsl` (the POSIX half testable on Windows: `wsl_status` / `wsl_run` /
  `wsl_path` over the machine's own WSL — one argv array, no shell string, a
  deadline with a tree kill, the launcher's UTF-16 table decoded, and the
  distribution NAMED because a Docker Desktop machine defaults to
  `docker-desktop-data`; host-only, inert and honest off Windows),
  `dsh-docker` (Docker or Podman as a surface: nine `docker_*` tools over the
  machine's own CLI, argv-only with every removal confirmed by repeating the
  target, a `docker_start` that launches Docker Desktop or a podman machine and
  then waits for the **daemon**, and a Docker tab of containers and images with
  their logs; no `exec`, no `system prune`, no free-form `run`; zero npm
  dependencies and no bundled engine),
  `dsh-sql-server` (SQL Server as a surface: seven `sql_*` tools over a container
  this row owns or the `sqlcmd` already on the PATH, keeping apart the four facts
  that fail independently - a server, a client, a listening port and the
  machine-wide ODBC driver an application connects with; a `sql_server` start that
  waits until the server ANSWERS a statement, a `sql_driver` whose machine-wide
  install runs only with `confirm: "install"`, and a `sql_script` that loads a dump
  through `sqlcmd -i` with BOM-aware code pages and an optional filter for the
  dump's own `CREATE DATABASE` header; host-only, zero npm dependencies, no
  bundled engine),
  `dsh-ollama` (Ollama as a measured surface: five `ollama_*` tools over the
  machine's own daemon - status that names `ollama serve` when nothing answers,
  one bounded inference with the daemon's token counts and nanosecond durations,
  a benchmark that refuses fewer than 3 runs and reports a median with spread,
  confirmed pull/delete, embeddings with cosine similarity - three skills whose
  examples a check parses/compiles, and a loopback fence that refuses a daemon on
  another machine before any request; host-only, zero npm dependencies),
  `dsh-research` (a run is a folder with a `passport.json` recording the user's own
  words; nine `rs_*` tools over an append-only claim and source ledger, a claim's
  numbers recorded as a validated `statistic` rather than left in the prose, a
  structured method record whose screening counts cannot increase, a disclosure
  record whose every statement must be complete before a submission prints it, a
  verification ladder whose every rung names what it reached plus a calibration set
  that measures the READER rather than the run, the review with its enforced
  concession protocol, frame gates a PERSON answers in the right bar, eight skills
  that teach the tool surface, the method layer and the ethics layer, and a Research
  tab that also edits the document — host half plus UI, no socket, no vendored
  engine),
  `dsh-browser`, `dsh-themes`, `dsh-cmdbar`, `dsh-modal`, `dsh-skills`,
  `dsh-ui-state`, `dsh-open-in-app`.
- A package may carry its OWN checks under `packages/<name>/checks/`, run with
  `npm run check` in that folder. They travel with the package (which is what
  makes them useful outside this repository) and they are ADDITIONAL to
  `scripts/checks/`, never a replacement for it: today ten packages ship their own
  (`dsh-supercollider` with four checks, `dsh-research` with seven, plus
  `dsh-diagrams`, `dsh-frontend-craft`, `dsh-proto-lab`, `dsh-ocr`, `dsh-wsl`,
  `dsh-docker`, `dsh-ollama` and `dsh-image-upscale`), and the pack-wide checks
  still own the routes, the bundle and the manifest.
- `scripts/` — the launcher (`run-web.*`), and four folders: `console/` (the shared
  console layer), `setup/` (install and uninstall, which a fresh machine runs once),
  `tools/` (maintainer-only: the fork re-sync for the client bundles this pack vendors)
  and `checks/`.
- `docs/` — install, build, deploy, release, paths, compatibility. There is no
  distributer and no ship list: the distribution is this repository, zipped at the tag,
  and the pack installs itself with `scripts/setup/install.*`.
- `.dsh-version.json` — the pinned harness line and the pack manifest
  (its versions must match every `package.json`; `check-node-routes.mjs` enforces
  that).

## Verifying a change

Run the check that owns the area, and say which ones you ran:

- `check-no-secrets.mjs` — before anything is pushed;
- `check-scripts.mjs` — the `scripts/` layout, the console contract, `run-web.*` and both
  setup entry points driven with `-Help` (which starts nothing and installs nothing), and
  the two workflows;
- `check-node-routes.mjs` — every Node route, the manifest, the pack-wide patches;
- `check-client-bundles.mjs` — every browser bundle, loaded and driven for real;
- `check-media-node.mjs`, `check-pdf-node.mjs`,
  `check-browser-node.mjs` — the tool
  and host halves;
- `check-skill-examples.mjs`, `check-media-examples.mjs` — every fenced example in
  the shipped skills (parsed, compiled, or actually run);
- `npm run check` **in a package folder that ships its own** — today
  `packages/dsh-supercollider`, whose four checks cover the engine's OSC codec
  and discovery, the skill examples against a real SuperCollider, the committed
  library of examples, and the row's own contract (eleven tools, three routes,
  five skills, the classic-script client bundle and its CSS prefix). They are
  additional to the list above, not a substitute for it.

A check that cannot run on this host says so loudly and exits 0. Never silence a
check, and never weaken one to make a change pass.

## Style

Comments and docs state the rule and the measurement behind it — the fact a
future editor must not break — not the changelog. Docs are **one page each**: no
alpha-by-alpha history, no re-explaining what the harness used to do.
