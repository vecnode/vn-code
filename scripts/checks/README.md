# scripts/checks

Standalone verification for everything this pack ships. No check needs a running
harness, none is part of the installers, and all of them are written in Node and
run the same way on Windows, macOS and Linux. A few reach past Node on purpose and
skip loudly when the tool is missing: `check-client-bundles.mjs` drives the
vendored-fork re-sync through PowerShell, `check-shader-examples.mjs` and
`check-browser-node.mjs` need a real browser, and `check-media-node.mjs` needs
ffmpeg. Run the one that owns the area you touched, before you claim a fix.

```sh
node scripts/checks/check-no-secrets.mjs        # before anything is pushed
node scripts/checks/check-client-bundles.mjs    # every browser bundle, loaded and driven
node scripts/checks/check-node-routes.mjs       # every Node route, tool, the manifest, the pack-wide patches
node scripts/checks/check-scripts.mjs          # the scripts tree, the console contract, the two workflows
node scripts/checks/check-media-node.mjs        # dsh-media: tools, routes, the ffmpeg pin
node scripts/checks/check-pdf-node.mjs          # dsh-pdf: the five tools and the routes
node scripts/checks/check-skill-examples.mjs    # every fenced example in the shipped skills
node scripts/checks/check-shader-examples.mjs   # every fenced GLSL in the shader skills, COMPILED
node scripts/checks/check-media-examples.mjs    # every media/PDF example, shaped and really RUN
node scripts/checks/check-browser-node.mjs      # dsh-browser: the host renderer and its policy
DSH_CHECK_LAUNCH=1 node scripts/checks/check-node-routes.mjs   # also opens a real directory picker
```

Windows PowerShell: `$env:DSH_CHECK_LAUNCH='1'; node scripts/checks/check-node-routes.mjs`.

## What each check covers

| script | what it proves |
|---|---|
| `check-no-secrets.mjs` | nothing credential-shaped would be staged by `git add -A`; the `.gitignore` credential rules are present; the scanner fires on a synthetic key, hides the value and stays quiet on clean text |
| `check-client-bundles.mjs` | every browser half loads through the real module table (`window.__ModuleLoader__.load`), activates against a stub cordis context, and is rendered/driven with a **real React runtime**; the exported `__internals` pure halves are driven directly (e.g. the audio/image byte decode in every shape a carrier could use); and it runs `scripts/tools/sync-vendored.ps1 -Check`, so each generated fork is proved to be what its patch list still produces (a host with no PowerShell skips that one assertion loudly) |
| `check-node-routes.mjs` | every Node route and tool of every host half, the git routes against a real repository, the skills registry, the manifest ⇄ `package.json` agreement, and the master's pack-wide row patches |
| `check-scripts.mjs` | the `scripts/` layout (`run-web.*` at the top, everything else in `console/`, `setup/`, `tools/`, `checks/`), the console contract every Windows entry point must hold, that both `run-web` workers join the folder's own home when it is portable, and the entry points **really run in their `-Help` form**: `run-web.* -Help` must print its usage without starting the harness, and `setup/install.bat -Help` / `setup/uninstall.bat -Help` must print theirs, exit 0 and change nothing. It also asserts the two workflows exist, `ci.yml` callable through `workflow_call` and `release.yml` gating on it and publishing one artefact |
| `check-media-node.mjs` | `dsh-media`'s pin against a **synthetic archive** built and served over loopback (download, hash verification, mismatch refusal, atomic install, resolution order), plus the ffmpeg-dependent half, which skips loudly without ffmpeg |
| `check-pdf-node.mjs` | the five `pdf_*` tools and the PDF routes against documents the check builds itself, including the engine's buffer semantics |
| `check-skill-examples.mjs` | every fenced example in the shipped skills parses or compiles (Mermaid, TikZ) |
| `check-shader-examples.mjs` | every fenced **GLSL** example in `dsh-shaders`' five skills is COMPILED by a real headless browser, with vertex shaders recognised and a deliberately-broken example marked `no-check`; skips loudly on a host with no browser |
| `check-media-examples.mjs` | every media/PDF example is a well-formed tool call and, where this host can run one, actually runs |
| `check-browser-node.mjs` | `dsh-browser`'s host half: the disposable sandboxed renderer and the fetch policy in front of it |

## The checks that live inside a package

`dsh-docker`, `dsh-wsl`, `dsh-ocr`, `dsh-image-upscale`, `dsh-diagrams`,
`dsh-frontend-craft`, `dsh-shaders`, `dsh-research`, `dsh-supercollider`,
`dsh-proto-lab` and `dsh-ollama` each ship their own under
`packages/<name>/checks/`, run with `npm run check` in that folder. They are
additional to the list above, never a replacement for it: a host half's fixtures
and its live skips belong beside the package (see
`packages/dsh-docker/checks/check-docker-node.mjs`, which drives the runner
against a real child process and every engine state against a scripted one, and
`packages/dsh-ollama/checks/check-ollama-node.mjs`, which serves a **fake
daemon** on `127.0.0.1:0` with fixed nanosecond durations so tok/s and TTFT are
assertions rather than observations, parses every skill example, and runs one
generation against a real daemon only when one answers), and
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

**CI runs two of them.** `.github/workflows/ci.yml` is one job on `ubuntu-latest` in a
`node:22` container - it installs `git` and runs `check-no-secrets.mjs` and
`check-scripts.mjs`, the two that need nothing a bare container lacks. The rest are run by
hand, because most of them need a browser, a SuperCollider, ffmpeg or a TeX engine that a
runner does not have; `release.yml` calls that same workflow as its gate, so a tag is
checked before anything is published.
