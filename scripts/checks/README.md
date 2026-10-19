# scripts/checks

Standalone verification for everything this pack ships. No check needs a running
harness, none is part of the installers, and all of them are written in Node and
run the same way on Windows, macOS and Linux. Two assertions reach past Node on
purpose and skip loudly when the tool is missing: `check-shell.mjs` needs `cargo`,
and `check-client-bundles.mjs` drives the vendored-fork re-sync through PowerShell.
Run the one that owns the area you touched, before you claim a fix.

```sh
node scripts/checks/check-no-secrets.mjs        # before anything is pushed
node scripts/checks/check-client-bundles.mjs    # every browser bundle, loaded and driven
node scripts/checks/check-node-routes.mjs       # every Node route, tool, the manifest, the pack-wide patches
node scripts/checks/check-scripts.mjs          # the scripts tree, the console contract, the two workflows
node scripts/checks/check-media-node.mjs        # dsh-media: tools, routes, the ffmpeg pin
node scripts/checks/check-pdf-node.mjs          # dsh-pdf: the five tools and the routes
node scripts/checks/check-skill-examples.mjs    # every fenced example in the shipped skills
node scripts/checks/check-media-examples.mjs    # every media/PDF example, shaped and really RUN
node scripts/checks/check-browser-node.mjs      # dsh-browser: the host renderer and its policy
node scripts/checks/check-shell.mjs            # the app, DRIVEN: verbs, the bridge, the child env
DSH_CHECK_LAUNCH=1 node scripts/checks/check-node-routes.mjs   # also opens a real directory picker
```

Windows PowerShell: `$env:DSH_CHECK_LAUNCH='1'; node scripts/checks/check-node-routes.mjs`.

## What each check covers

| script | what it proves |
|---|---|
| `check-no-secrets.mjs` | nothing credential-shaped would be staged by `git add -A`; the `.gitignore` credential rules are present; the scanner fires on a synthetic key, hides the value and stays quiet on clean text |
| `check-client-bundles.mjs` | every browser half loads through the real module table (`window.__ModuleLoader__.load`), activates against a stub cordis context, and is rendered/driven with a **real React runtime**; the exported `__internals` pure halves are driven directly (e.g. the audio/image byte decode in every shape a carrier could use); and it runs `scripts/tools/sync-vendored.ps1 -Check`, so each generated fork is proved to be what its patch list still produces (a host with no PowerShell skips that one assertion loudly) |
| `check-node-routes.mjs` | every Node route and tool of every host half, the git routes against a real repository, the skills registry, the manifest ⇄ `package.json` agreement, and the master's pack-wide row patches |
| `check-scripts.mjs` | the `scripts/` layout (`run-web.*` and `run-desktop.*` at the top, everything else in `console/`, `setup/`, `tools/`, `checks/`), the console contract every Windows entry point must hold, **`setup/install.bat -Help` and `setup/uninstall.bat -Help` really run** with the console variables cleared the way the app clears them (they must print their usage, exit 0, and change nothing), and that the two release workflows exist and name three OSes + a separate `vncode-web` artefact |
| `check-media-node.mjs` | `dsh-media`'s pin against a **synthetic archive** built and served over loopback (download, hash verification, mismatch refusal, atomic install, resolution order), plus the ffmpeg-dependent half, which skips loudly without ffmpeg |
| `check-pdf-node.mjs` | the five `pdf_*` tools and the PDF routes against documents the check builds itself, including the engine's buffer semantics |
| `check-skill-examples.mjs` | every fenced example in the shipped skills parses or compiles (Mermaid, TikZ) |
| `check-media-examples.mjs` | every media/PDF example is a well-formed tool call and, where this host can run one, actually runs |
| `check-browser-node.mjs` | `dsh-browser`'s host half: the disposable sandboxed renderer and the fetch policy in front of it |
| `check-shell.mjs` | the app, **driven rather than read**: `-Version` and `-Help` answer; `-Mode embed` - the flag the deleted web view used to answer - is refused BY NAME; the binary is kept under a size ceiling a GUI stack cannot sneak past; and `start` is run against a **throwaway tree with stub scripts**, so the whole bridge is exercised without starting node: a home with no pack makes it run `scripts/setup/install.*` first, the launcher is handed `-DshHome` and, on Windows, `-NoTerminal`, both children's own environments are read back to prove `DSH_HOME` was composed and that the app's root and the console markers were REMOVED, no key file is written when there is no terminal to ask at, and `status` names the same home. It also proves `scripts/run-web.* -Help` answers with nothing but the web half present. Fixtures live under `.scratch/`, never in a temp directory the host may deny, and it runs `cargo test --workspace` with a scratch root it controls |

## The checks that live inside a package

`dsh-docker`, `dsh-wsl`, `dsh-ocr`, `dsh-diagrams`, `dsh-frontend-craft`,
`dsh-research`, `dsh-supercollider` and `dsh-proto-lab` each ship their own under
`packages/<name>/checks/`, run with `npm run check` in that folder. They are
additional to the list above, never a replacement for it: a host half's fixtures
and its live skips belong beside the package (see
`packages/dsh-docker/checks/check-docker-node.mjs`, which drives the runner
against a real child process and every engine state against a scripted one), and
the pack-wide checks still own the routes, the bundle and the manifest.

`dsh-proto-lab`'s three carry the pack's **verification ladder** — the claim that a
run was checked is always stated with how deeply: `t0-structure` (always),
`t1-parse`, `t2-compile` (a real openFrameworks compile), `t3-render`,
`t4-measure` (pixels read back, two seeds compared).

| script | what it proves |
|---|---|
| `check-lab-node.mjs` | the runtime contract, the path policy (`..`, absolute, symlink, NUL each refused with its own code), a scaffold + instantiate + lint round for every runtime, the lint **firing** on a deliberately broken run, and the capability model (the ladder, the frame budget, defaults scaled to the host) |
| `check-lab-examples.mjs` | every committed example and every `lab-run` fenced snippet in the skills, EXECUTED against a stub p5; C++ snippets checked against the openFrameworks vocabulary |
| `check-lab-render.mjs` | a real browser opens each run's own `index.html` and the canvas is measured: non-blank, more than one colour, the same seed reproduces the same signature, a different seed does not |

## The standard a check follows

1. **Drive behaviour, don't grep a call shape.** A source-text assertion is only
   acceptable next to a test that runs the same code; the pack has shipped a bug
   (a Remote method that does not exist) precisely because a grep stood in for a
   call.
2. **Build your own input.** A check makes the PDF, WAV, archive or design it
   needs instead of depending on a fixture that can rot.
3. **Skip loudly, never silently.** A missing browser, `git`, ffmpeg or TeX engine
   is reported as a skip with the reason; it must never read as a pass.
4. **Never weaken a check to make a change fit.** Fix the code, or change the
   check deliberately and say why in the commit.

**CI does not run these.** They are run by hand, because most of them need a browser, a
SuperCollider, ffmpeg or TeX that a runner does not have. `.github/workflows/ci.yml` runs
what a runner *can* own - clippy with warnings denied, the workspace tests, a release build
and the size budget - and `release.yml` calls that same workflow as its gate, so a tag is
checked on all three OSes before anything is published. `check-scripts.mjs` asserts both
workflows exist, so a deleted release pipeline cannot come back silently either.
