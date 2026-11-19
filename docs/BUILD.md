# Building vncode

**There is nothing to build.** The repository is pure Node/TypeScript/JavaScript: no
compiler, no build step, no native code, and zero npm dependencies in the packages it
ships. The harness is run through `npx` and the pack is loaded from this folder as a live
link, so a change is a file save.

That is the rule behind every other page here: a change is proved by RUNNING it, not by
compiling it, and the only toolchain any machine needs is **Node.js >= 22**.

The one exception is a vendored engine: each keeps its own `vendor/build.mjs` and the
tracked hashes in its `lib/vendor/VERSION.json`. Regenerate those, never hand-edit them.

## The two ways to run it

| | what it does |
|---|---|
| `install`, once, then `run-web` | the everyday path. `scripts\setup\install.bat` / `./scripts/setup/install.sh` adds this folder's bundles to the `web` profile, and `scripts\run-web.bat` / `./scripts/run-web.sh` starts the pinned harness with the pack and opens it |
| `npx --yes @deepseek-ai/dsh@<pin> web` | the harness alone: no pack and no launcher. Useful for telling a plugin bug from a launcher one |

`run-web` never installs. It nags when the profile at the home in use does not list the
pack, and the installer is its own entry point.

## The three entry points

| | what it does |
|---|---|
| `scripts\run-web.bat` | the Windows double-click entry: it forwards every flag to the worker beside it and holds the window open on a double-clicked failure |
| `scripts\run-web.ps1` | the Windows worker: the home ladder, `npx`, the ready line, the browser hand-off |
| `scripts/run-web.sh` | macOS / Linux: the whole job in one file, in POSIX `sh`, never PowerShell |

There are no other launchers and no forwarders. Both workers do the same work in the same
order: run `npx --yes @deepseek-ai/dsh@<pin> web --no-open [--port <n>]`, watch stdout for
the `dsh web: <url>` ready line, refuse a URL that is not loopback, and open THAT url in
Google Chrome, falling back to the platform default browser. `-DefaultBrowser` skips
Chrome; `-NoBrowser` opens nothing. The harness runs in the foreground and Ctrl+C stops it.

Install and uninstall are their own entry points one level down, in `scripts/setup/`:
`install.bat` / `install.sh` and `uninstall.bat` / `uninstall.sh`, with the workers
`install-all.*` / `uninstall-all.*` beside them.

## How to check a change

Run the check that owns the area. A check that cannot run on this host skips loudly and
exits 0, and [scripts/checks/README.md](../scripts/checks/README.md) lists them all.

```sh
node scripts/checks/check-no-secrets.mjs       # before anything is pushed
node scripts/checks/check-scripts.mjs          # the scripts layout, the console contract, the two workflows
node scripts/checks/check-node-routes.mjs      # every Node route, tool, the manifest, the patches
node scripts/checks/check-client-bundles.mjs   # every browser bundle, driven for real
node scripts/checks/check-media-node.mjs       # dsh-media's host half and its ffmpeg pin
node scripts/checks/check-pdf-node.mjs         # the five pdf tools and their routes
node scripts/checks/check-skill-examples.mjs   # every example in the shipped skills
```

A plugin edit needs no restart: the host stat-polls each `client.js` every 500 ms and
republishes it, so a reload shows the change. A `lib/index.js` change (routes, tools) or a
row/profile change does need a host restart.

## CI

`.github/workflows/ci.yml` is ONE job on `ubuntu-latest` in a `node:22` container: it
installs `git`, which `check-no-secrets.mjs` reads the repository with, and runs
`check-no-secrets.mjs` and `check-scripts.mjs`. There is no compiler and no per-OS matrix,
because there is nothing to compile and the files are the same on every platform.

It stays callable through `workflow_call` and runs at the boundaries only - a pull request,
a manual dispatch, and a release's gate. **A push to `main` starts no CI at all**, so
commits and pushes are free and the checks that must not be skipped run where they matter.

## How a release is cut

One artefact: `vncode-<version>.zip`, a `git archive` of the repository at the tag. The zip
IS the distribution - the pack, the launchers and the docs - and there is no second
artefact and no ship list. [RELEASE.md](RELEASE.md) has the tag flow and what the gate
refuses.
