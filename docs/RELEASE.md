# Cutting a vncode release

A release is **two artefacts**, because the project is two things:

| artefact | what it is | built |
|---|---|---|
| `vncode-<ver>-<os>-<arch>.zip` / `.tar.gz` | the Rust app: the front door that installs the pack, takes the key and runs the web launcher. **One per OS** - the only per-OS artefact in the project | `release.yml`, one matrix leg each |
| `vncode-web-<ver>.tar.gz` | the node/JS half: `packages/`, `scripts/`, the pin and the docs. **The same bytes on every platform** | `release.yml`, once, on Linux |

The web half is the product and it stands alone: `scripts/run-web.bat` /
`./scripts/run-web.sh` starts the harness and opens the tab with no `vncode` binary
anywhere on the machine. The app is a front door that calls it. That is why only the Rust
half is per-OS, and why one leg failing cannot withhold the other.

## What publishing a tag does

`.github/workflows/release.yml`, on `v*` (or `workflow_dispatch` with an existing tag):

1. **gate** - calls `ci.yml`, the same workflow a pull request runs. Three OSes, clippy
   with warnings denied, the tests, a release build, a 6 MB size ceiling, and a smoke run.
   A red gate stops the release **before** a draft exists.
2. **prepare** - creates the Release as a **draft**. Nothing is visible while it is half
   built.
3. **build** - the matrix: `windows-latest` (x86_64, static CRT so no redistributable is
   needed), `ubuntu-22.04` (x86_64, for the glibc floor), `macos-latest` (arm64). Each leg
   packages `vncode` + `README.md` + `LICENSE` and uploads it.
4. **web** - packs the pack, the launchers and the pin into `vncode-web-<ver>.tar.gz`,
   after checking that `scripts/run-web.sh -Help` answers *with no app involved*.
5. **checksums** - waits for every upload, **re-downloads what was actually published**,
   and writes `SHA256SUMS.txt`. A hash computed before the last upload is a lie.
6. **publish** - flips the draft. The release becomes visible only with every artefact and
   its checksums attached.

## Cutting one by hand

The workflow is the only ritual that ships. If it is unavailable, the same steps run
locally:

```powershell
git status --porcelain            # expect: empty
Get-ChildItem scripts/checks/*.mjs | ForEach-Object { node $_.FullName }
cargo build --release --locked --manifest-path app/Cargo.toml
```

**Smoke it as a user would.** From a checkout, on each OS:

```powershell
scripts\run-desktop.bat status    # the pin, the home, the pack, the key, the launcher
scripts\run-desktop.bat           # install if needed, key if needed, then run-web
```

`status` must name the home and the launcher and start nothing. `start` must reach a
served page in a browser, and Ctrl+C must stop it. On a machine with no pack installed,
the same run installs it first and says so.

Then tag and push; the workflow does the rest:

```powershell
$v = node -p "require('./package.json').version"
git add -A; git commit -m "release: vncode $v"
git tag -a "v$v" -m "vncode $v"; git push origin main "v$v"
```

## What NOT to do

- **Do not label a binary for an OS it was not built on.** A renamed `.exe` is not a macOS
  or Linux binary; each leg runs on its own runner.
- **Do not publish the web half per platform.** It has no native modules of its own - one
  artefact, three OSes, the same bytes.
- **Do not re-cut a tag** once an archive has been handed to somebody.
- **Do not attach an artefact after `checksums` has run** - `SHA256SUMS.txt` would no
  longer describe the release. Re-run the workflow instead; it re-hashes what is there.

Signing is not wired up yet: an Authenticode or Developer ID certificate would cover the
exact bytes of each binary, and the honest interim is the `SHA256SUMS.txt` above plus a
note in the release notes (BUILD.md has the details).

[BUILD.md](BUILD.md) is the build itself; [DEPLOY.md](DEPLOY.md) is what a distribution
promises; [scripts/checks/README.md](../scripts/checks/README.md) lists every check.
