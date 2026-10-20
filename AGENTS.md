# AGENTS.md — working in vncode

A plugin pack for **one install target**: the DeepSeek Harness **web** profile
(`npx @deepseek-ai/dsh web`; profile `web` under `$DSH_HOME`, default `~/.dsh`).
Everything ships as a standard dsh **bundle**.

Read `ARCHITECTURE.md` for the map, the plugin's own `packages/<name>/README.md`
for its behaviour, `SECURITY.md` before touching credentials or the launcher, and
`scripts/checks/README.md` for what proves a change.

## Hard rules — do not break these

1. **One install target.** The web profile only. No desktop edition, no
   `-Target desktop`, no desktop detection, **no window and no web view**. `app/` is a
   **front door** to the same pinned `dsh web`: it decides the root and the home, writes
   the key, runs this pack's own installer (`scripts/setup/install.*`, given `-DshHome
   <the home it chose>`) when that profile lacks the bundles, and then runs
   `scripts/run-web.*` — the same launcher a person double-clicks — in the foreground.
   It starts no node, binds no port, opens no tab and draws nothing: **the launcher owns
   the harness, the ready line and the browser tab.** Launching only the web must keep
   working on a machine with no `vncode` at all.
2. **Nothing patches core.** A row change is a new bundle layer.
   `dsh-vn-master` is the pack's final layer (it installs last), so pack-wide row
   patches belong there, and a package that *replaces* a row carries that row's
   disable with it.
3. **Platforms.** Plugin code is OS-neutral. Windows tooling is PowerShell and
   must work on **5.1 and 7** (`Join-Path`, `[System.IO.Path]::PathSeparator`,
   `$PSVersionTable`; never `$IsWindows` unguarded, never a hardcoded `npx.cmd`,
   `%USERPROFILE%` or `\`). macOS/Linux tooling is POSIX shell and must **never**
   require PowerShell — Node.js with npm/npx and nothing else.
4. **Launchers.** Every entry point lives in `scripts/`, one per action per host
   (`run-web.*`, `run-desktop.*`), and there are **no forwarders**. The install and
   uninstall pairs live one level down in `scripts/setup/`, beside the workers they
   call, and the app's `install` / `uninstall` verbs run those same entry points. Nothing
   else sits at
   the top level: `console/` is the shared console layer, `tools/` is
   maintainer-only, `checks/` is the contract, and `check-scripts.mjs` fails on a
   stray file. On Windows the entry point calls the PowerShell worker beside it (or
   the console layer, for the setup pair) and gets its console behaviour from the one
   shared layer:

       if not defined VNCODE_CONSOLE set "VNCODE_ARGV=%*"
       call "%~dp0console\adapt.cmd" "%~f0" "<window title>"
       if errorlevel 10 exit /b 0         :: a Windows Terminal window owns the run
       if errorlevel 2  goto :nopowershell :: no PowerShell on this machine

   An entry point forwards `%VNCODE_ARGS%` and **never** `%*`; `adapt.cmd` must
   not `setlocal`; colour lives in `scripts/console/theme.ps1` and its POSIX twin
   `theme.sh`.
5. **The launch token is a live credential.** It is read in memory, never written
   to a file, echoed, or handed to a shell, and a URL that is not loopback is
   refused rather than opened. It appears only in `scripts/run-web.ps1` /
   `scripts/run-web.sh` — **never in `app/`**, which starts the launcher and reads its
   exit code.
6. **No secrets, ever.** Run `node scripts/checks/check-no-secrets.mjs` before
   pushing. A vendored bundle can ship its author's own credentials: redact them
   in the **build** (a patch under that engine's `vendor/<name>/patches/`, read
   before the artifact is committed), never with an allowlist entry.
7. **Zero npm dependencies** in shipped packages, and no network egress a plugin
   starts on its own. Engines are vendored under `lib/vendor/` or resolved from
   the harness already on disk.
8. **CI builds the app; the checks prove it.** `.github/workflows/ci.yml` runs clippy
   with warnings denied, the workspace tests, a release build, a **6 MB size ceiling**
   and a smoke run - on all three OSes for a pull request, the Monday schedule, a manual
   dispatch, and `release.yml`, which calls it as its gate. **A push to `main` starts no
   CI at all**: commits and pushes are free, and CI runs at the boundaries (a PR, the
   weekly run, or the cut). A release
   publishes **two** artefacts: one `vncode` per OS, and one `vncode-web` for the
   node/JS half, which is the same bytes everywhere. The checks in `scripts/checks/`
   are still run by hand; they are the contract, and `scripts/checks/README.md` lists
   them.

## Layout

- `packages/<bundle>/` — one standalone bundle per plugin, each with its own
  one-page README: `dsh-vn-master` (final layer), `dsh-rightbar` +
  `dsh-rightbar-files` (the right bar and its Files tab), `dsh-editor`,
  `dsh-gittree` (History), `dsh-image`, `dsh-audio`, `dsh-video`, `dsh-media`
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
  `scripts/checks/`, never a replacement for it: today nine packages ship their own
  (`dsh-supercollider` with four checks, `dsh-research` with seven, plus
  `dsh-diagrams`, `dsh-frontend-craft`, `dsh-proto-lab`, `dsh-ocr`, `dsh-wsl`,
  `dsh-docker` and `dsh-ollama`), and the pack-wide checks still own the routes, the bundle and the
  manifest.
- `scripts/` — the launchers (`run-web.*`, `run-desktop.*`), and four folders:
  `console/` (the shared console layer), `setup/` (install and uninstall, which the
  app's verbs run), `tools/` (maintainer-only: the fork re-sync for the client bundles
  this pack vendors) and `checks/`.
- `app/` — the Rust **front door**: a cargo workspace of three crates whose binary is
  `vncode`, about 0.5 MB, with **no window and no web view**. It decides the root its
  harness home lives in (`$VNCODE_HOME`, with `DSH_HOME` at `<root>/home` unless a
  `-DshHome` or a writable inherited `DSH_HOME` says otherwise — **nothing outside its
  own root is ever the home it runs against**), composes every child's environment
  rather than inheriting one, cleans every path before it uses one, writes the DeepSeek
  key into `<home>/.env` when asked, runs `scripts/setup/install.*` when the profile
  lacks the pack, and then runs `scripts/run-web.*` in the foreground. Its verbs are
  `start` (default), `install`, `uninstall`, `status` and `key`; `-Mode embed` is
  refused **by name**, because there is no embedded browser to select.
  `app/README.md` explains it. `check-shell.mjs` is what proves it, and it drives
  the real binary.
- `docs/` — install, build, deploy, release, paths, compatibility. There is no
  distributer and no ship list: the distribution is this
  repository plus the binary, and the app installs the pack itself.
- `.dsh-version.json` — the pinned harness line and the pack manifest
  (its versions must match every `package.json`; `check-node-routes.mjs` enforces
  that).

## Verifying a change

Run the check that owns the area, and say which ones you ran:

- `check-no-secrets.mjs` — before anything is pushed;
- `check-scripts.mjs` — the `scripts/` layout, the console contract, and both setup
  entry points driven with `-Help` (which installs nothing);
- `check-node-routes.mjs` — every Node route, the manifest, the pack-wide patches;
- `check-client-bundles.mjs` — every browser bundle, loaded and driven for real;
- `check-media-node.mjs`, `check-pdf-node.mjs`,
  `check-browser-node.mjs` — the tool
  and host halves;
- `check-shell.mjs` — the app, **driven**: the verbs and `-Help`; `-Mode embed` refused
  BY NAME (the flag the deleted web view used to answer); a size ceiling a GUI stack
  cannot pass; and `start` run against **stub scripts** in a throwaway tree — the
  installer is run because that home lacks the pack, the launcher is handed `-DshHome`
  and `-NoTerminal` and a **composed** environment, the app's own root and the console
  markers are absent from both children, no key file is written with no terminal to ask
  at, and `status` names the same home. It also proves `scripts/run-web.* -Help` answers
  with no binary involved, and it skips loudly with no cargo and no built binary;
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
