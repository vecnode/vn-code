# AGENTS.md — working in vncode

A plugin pack for **one install target**: the DeepSeek Harness **web** profile
(`npx @deepseek-ai/dsh web`; profile `web` under `$DSH_HOME`, default `~/.dsh`).
Everything ships as a standard dsh **bundle**.

Read `ARCHITECTURE.md` for the map, the plugin's own `packages/<name>/README.md`
for its behaviour, `SECURITY.md` before touching credentials or the launcher, and
`scripts/checks/README.md` for what proves a change.

## Hard rules — do not break these

1. **One install target.** The web profile only. No desktop edition, no
   `-Target desktop`, no desktop detection. `app/` plus `scripts/run-desktop.*` is a
   **launcher** of the same pinned `dsh web` on a free loopback port — it patches no
   core file and adds no second server. It installs exactly one thing, and only when
   asked: its panel's Install button runs this pack's own installer
   (`scripts/setup/install.*`), which adds these bundles to the `web` profile and
   nothing else — and it is given `-DshHome <the home the app chose>`, so the pack
   lands in the profile the app will actually run. Uninstall runs the matching pair.
   Both are disabled while a harness is running, and neither touches a row or a core
   file.
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
   call, and the app's own buttons run those same entry points. Nothing else sits at
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
   `scripts/run-web.sh`.
6. **No secrets, ever.** Run `node scripts/checks/check-no-secrets.mjs` before
   pushing. A vendored bundle can ship its author's own credentials: redact them
   in the **build** (a patch under that engine's `vendor/<name>/patches/`, read
   before the artifact is committed), never with an allowlist entry.
7. **Zero npm dependencies** in shipped packages, and no network egress a plugin
   starts on its own. Engines are vendored under `lib/vendor/` or resolved from
   the harness already on disk.
8. **No CI, on purpose.** The checks in `scripts/checks/` are run by hand; they
   are the contract, and `scripts/checks/README.md` lists them.

## Layout

- `packages/<bundle>/` — one standalone bundle per plugin, each with its own
  one-page README: `dsh-vn-master` (final layer), `dsh-rightbar` +
  `dsh-rightbar-files` (the right bar and its Files tab), `dsh-editor`,
  `dsh-gittree` (History), `dsh-image`, `dsh-audio`, `dsh-video`, `dsh-media`
  (the only owner of ffmpeg), `dsh-supercollider` (SuperCollider: ten `sc_*` tools
  over a warm `sclang` session and a hand-written OSC client, the `.schelp`
  reference indexed, five skills whose every example a check compiles, one small
  console tab — host half plus UI, no bundled binary), `dsh-diagrams`, `dsh-pdf`,
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
  `scripts/checks/`, never a replacement for it: `dsh-supercollider` ships three,
  and the pack-wide checks still own the routes, the bundle and the manifest.
- `scripts/` — the launchers (`run-web.*`, `run-desktop.*`), and three folders:
  `console/` (the shared console layer), `setup/` (install and uninstall, which the
  app's buttons run), `tools/` (maintainer-only) and `checks/`.
- `app/` — the Rust/**egui** shell: a cargo workspace whose binary is `vncode`, a
  control panel that opens on **the home question** when nobody has named a home — one screen,
  the cards that answer it (copy the machine's home here / make a fresh one in this folder),
  decided in `vn_shell_core::firstrun` and remembered
  only by a click — and then four rows (home, pack, key, browser) with every diagnostic behind
  one collapsed `Details`. It resolves and creates the root its harness home lives
  in (`$VNCODE_HOME`, with `DSH_HOME` at `<root>/home` unless `-DshHome`, a home chosen
  on that screen, or a writable inherited `DSH_HOME` says otherwise — **nothing outside its
  own root is ever the home it runs against**, so `~/.dsh` is the source of the copy offer
  and nothing else), starts the pinned
  harness on **Start** — installing the pack into that home first when its profile lists none of
  the pack's bundles, so one press reaches a real interface — and ends it on **Stop** (a
  launcher, not a desktop edition). It
  composes every child's environment rather than inheriting one, cleans every path before
  it uses one, and **draws no web view**: the interface opens in a browser it found
  (`browser.rs`), so there is no `embed`, no `Pane` and no engine vendored. `app/README.md`
  explains it and `docs/PLAN-egui-shell.md` is the plan it was built from. `check-shell.mjs`
  is what proves it, and it drives the real binary.
- `docs/` — install, build, deploy, release, paths, compatibility, and the shell's
  plan. There is no distributer and no ship list any more: the distribution is this
  repository, and the app installs the pack itself.
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
- `check-shell.mjs` — the native shell, **driven**: the ready line and its
  refusals, the launch token in no stream and no file (in both roots a run writes),
  Stop freeing the port and killing the tree, the flags (including a `-Mode` this build
  does not have being refused BY NAME, so no build can promise a web view it does not
  draw), the panel's install/uninstall path, the home ladder (an unwritable inherited
  `DSH_HOME` falls through, an impossible `-DshHome` refuses by name, a writable inherited
  one is joined, **an installation at `~/.dsh` is neither used nor offered as a home** in
  either state, and `VNCODE_HOME` reaches no child — every run
  confined on `VNCODE_HOME`, `DSH_HOME` and `USERPROFILE`/`HOME`), and that `app/src-tauri` is
  gone (it also runs `cargo test --workspace`; it skips loudly with no cargo and no built
  binary);
- `check-audio-browser.mjs` — the check that drives a
  real browser (with none installed it skips loudly);
- `check-skill-examples.mjs`, `check-media-examples.mjs` — every fenced example in
  the shipped skills (parsed, compiled, or actually run);
- `npm run check` **in a package folder that ships its own** — today
  `packages/dsh-supercollider`, whose three checks cover the engine's OSC codec
  and discovery, the skill examples against a real SuperCollider, and the row's
  own contract (ten tools, three routes, five skills, the classic-script client
  bundle and its CSS prefix). They are additional to the list above, not a
  substitute for it.

A check that cannot run on this host says so loudly and exits 0. Never silence a
check, and never weaken one to make a change pass.

## Style

Comments and docs state the rule and the measurement behind it — the fact a
future editor must not break — not the changelog. Docs are **one page each**: no
alpha-by-alpha history, no re-explaining what the harness used to do.
