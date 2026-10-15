# scripts/checks

Standalone verification for everything this pack ships. No check needs a running
harness, none is part of the installers, and all of them are Node-only — identical
on Windows, macOS and Linux. Run the one that owns the area you touched, before
you claim a fix.

```sh
node scripts/checks/check-no-secrets.mjs        # before anything is pushed
node scripts/checks/check-client-bundles.mjs    # every browser bundle, loaded and driven
node scripts/checks/check-node-routes.mjs       # every Node route, tool, the manifest, the pack-wide patches
node scripts/checks/check-scripts.mjs          # the scripts tree, the console contract, no CI
node scripts/checks/check-media-node.mjs        # dsh-media: tools, routes, the ffmpeg pin
node scripts/checks/check-pdf-node.mjs          # dsh-pdf: the five tools and the routes
node scripts/checks/check-skill-examples.mjs    # every fenced example in the shipped skills
node scripts/checks/check-media-examples.mjs    # every media/PDF example, shaped and really RUN
node scripts/checks/check-browser-node.mjs      # dsh-browser: the host renderer and its policy
node scripts/checks/check-shell.mjs            # the native shell, DRIVEN: ready line, token, stop
DSH_CHECK_LAUNCH=1 node scripts/checks/check-node-routes.mjs   # also opens a real directory picker
```

Windows PowerShell: `$env:DSH_CHECK_LAUNCH='1'; node scripts/checks/check-node-routes.mjs`.

## What each check covers

| script | what it proves |
|---|---|
| `check-no-secrets.mjs` | nothing credential-shaped would be staged by `git add -A`; the `.gitignore` credential rules are present; the scanner fires on a synthetic key, hides the value and stays quiet on clean text |
| `check-client-bundles.mjs` | every browser half loads through the real module table (`window.__ModuleLoader__.load`), activates against a stub cordis context, and is rendered/driven with a **real React runtime**; the exported `__internals` pure halves are driven directly (e.g. the audio/image byte decode in every shape a carrier could use) |
| `check-node-routes.mjs` | every Node route and tool of every host half, the git routes against a real repository, the skills registry, the manifest ⇄ `package.json` agreement, and the master's pack-wide row patches |
| `check-scripts.mjs` | the `scripts/` layout (`run-web.*` and `run-desktop.*` at the top, everything else in `console/`, `setup/`, `tools/`, `checks/`), the console contract every Windows entry point must hold, **`setup/install.bat -Help` and `setup/uninstall.bat -Help` really run** with the console variables cleared the way the app clears them (they must print their usage, exit 0, and change nothing), and that `.github/workflows` stays absent |
| `check-media-node.mjs` | `dsh-media`'s pin against a **synthetic archive** built and served over loopback (download, hash verification, mismatch refusal, atomic install, resolution order), plus the ffmpeg-dependent half, which skips loudly without ffmpeg |
| `check-pdf-node.mjs` | the five `pdf_*` tools and the PDF routes against documents the check builds itself, including the engine's buffer semantics |
| `check-skill-examples.mjs` | every fenced example in the shipped skills parses or compiles (Mermaid, TikZ) |
| `check-media-examples.mjs` | every media/PDF example is a well-formed tool call and, where this host can run one, actually runs |
| `check-browser-node.mjs` | `dsh-browser`'s host half: the disposable sandboxed renderer and the fetch policy in front of it |
| `check-shell.mjs` | the native shell, **driven rather than read**: `vncode -Mode headless` is started against a stub CLI that binds a real port, spawns a grandchild of its own and prints a ready line carrying a recognisable token — with the app's own root (`VNCODE_HOME`), the harness home, **the person's home (`USERPROFILE`/`HOME`)** and **the platform data root (`LOCALAPPDATA`/`XDG_DATA_HOME`, from which `prefs.json` is read as a fallback)** all pointed into scratch, so the check can never write into — or drive a harness against — a real `~/.dsh`. The check asserts a foreign ready line is refused, that the token reaches neither stream nor any file the run created (in BOTH roots), that `stop` frees the port and kills the grandchild, that the flags and their refusals behave — including a `-Mode` this build does not have (`embed`) being refused BY NAME, so no build can promise a web view it does not draw — **the home ladder** (an unwritable inherited `DSH_HOME` falls through to `<app root>/home` and is read back out of the CHILD's own environment, an impossible `-DshHome` refuses by name, a writable inherited one is joined and no second home is created, **an installation already on the machine is NOT used as the home in either state**, and **a home remembered in `prefs.json` is read from the root the ladder chose and used, with no second home created**), that a child whose `%TEMP%` is unwritable is handed `<app root>/tmp` instead (read back out of the child, with the reason in the log), that `install -Help` and `uninstall -Help` run through the SAME runner the panel's buttons use (the installer's own usage must reach the shell's log, and the profile must not change), that `app/src-tauri` is gone and the old distributer has not come back, and it runs `cargo test --workspace` with a scratch root it controls. It starts no browser: the hand-off is unit-tested instead — the argv (including the profile flag a Chromium may be given, with the URL still exactly one argument), the loopback refusal, the rung order (the person's browser, then the same browser with a profile inside this app's own root, then the platform's opener), and the settle-window verdict that reads an exited program (`Handed` on zero, `Died` on a failure status, `Running` while it lives, and `Unverified` for an opener whose zero proves nothing) — which is what stops a spawn, or a `rundll32` exit code, from being reported as a tab that opened. Needs the Rust toolchain; skips loudly without it |

## The checks that live inside a package

`dsh-proto-lab` ships three of its own under `packages/dsh-proto-lab/checks/`,
run with `npm run check` in that folder. They are additional to the list above,
and between them they carry the pack's **verification ladder** — the claim that a
run was checked is always stated with how deeply: `t0-structure` (always),
`t1-parse`, `t2-compile` (a real openFrameworks compile), `t3-render`,
`t4-measure` (pixels read back, two seeds compared).

| script | what it proves |
|---|---|
| `check-lab-node.mjs` | the runtime contract, the path policy (`..`, absolute, symlink, NUL each refused with its own code), a scaffold + instantiate + lint round for every runtime, the lint **firing** on a deliberately broken run, and the capability model (the ladder, the frame budget, defaults scaled to the host) |
| `check-lab-examples.mjs` | every committed example and every `lab-run` fenced snippet in the skills, EXECUTED against a stub p5; C++ snippets checked against the openFrameworks vocabulary |
| `check-lab-render.mjs` | a real browser opens each run's own `index.html` and the canvas is measured: non-blank, more than one colour, the same seed reproduces the same signature, a different seed does not |

## The checks that need a real browser

These drive the shipped bundles in a headless Chromium-family browser. With none
installed they **SKIP LOUDLY** and exit 0, so a green run on a machine without a
browser is not evidence — read the output.

| script | what it proves |
|---|---|
| `check-audio-browser.mjs` | the audio console's device/routing/tone claims against the real browser APIs |

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

There is **no CI on purpose**: these are run by hand. Wiring them into Actions
would re-add a workflow the maintainer deleted, and `check-scripts.mjs`
asserts that it has not come back.
