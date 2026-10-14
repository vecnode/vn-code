# Cutting a vncode release

**There is no CI in this repository, and that is deliberate.** `.github/workflows/`
does not exist, GitHub Actions is disabled, and `check-scripts.mjs` fails if a
workflow directory comes back.

Since the distributer was erased, a release is **two things**, and neither of them
is assembled by a script in this tree:

1. **the source** - this repository at a tag. That is the whole application: the
   plugin pack, the launchers, the shell's Rust workspace, and the panel that
   installs the pack into the harness profile; and
2. **the built shell**, one per OS, attached to the Release for anyone who would
   rather not install a Rust toolchain. `scripts/run-desktop.bat` (Windows) and
   `scripts/run-desktop.sh` (macOS/Linux) already prefer a built binary beside the
   tree and build one only when there is none, so a binary dropped next to the
   checkout is used as it stands.

A release is therefore **one tag, one Release**, with `SHA256SUMS.txt` and, when
the maintainer has built them, three assets: `vncode-<version>-win.exe`,
`vncode-<version>-mac`, `vncode-<version>-linux`.

Needs **Node.js 22+** and **the Rust toolchain** for the binaries, **`gh` logged
in** (`gh auth status`), a **clean tree**, and - for a Windows binary - the MSVC
toolchain and Windows SDK that `rustup` installs by default. The macOS and Linux
binaries are *built on those systems*, not cross-compiled and labelled: a binary is
the one artifact whose provenance a label cannot fake.

## The ritual

**1. Set the version.** `package.json`'s `version` names the tag and the release
title; `.dsh-version.json`'s `packages` block must agree with every package's own
`package.json` (a check enforces it), and its `dsh` pin is the harness line the
release is tested against.

```powershell
node -p "require('./package.json').version"
node -p "require('./.dsh-version.json').dsh"
```

**2. Run the checks, then build the shell.** Every check must pass, and
`check-shell.mjs` builds and drives the shell itself:

```powershell
git status --porcelain          # expect: empty
Get-ChildItem scripts/checks/*.mjs | ForEach-Object { node $_.FullName }
cargo build --release --manifest-path app/Cargo.toml
```

**3. Smoke it once, as a user would.** From a source checkout on each OS:

```powershell
scripts\run-desktop.bat          # Windows: builds if needed, then the panel
./scripts/run-desktop.sh         # macOS / Linux
```

The panel must open **idle** - no child process, no port bound - say where the
harness home is, and offer Install. Press **Install pack**, watch the installer's
own output arrive in the log, then **Start**: the harness opens in the browser and
Stop ends it and frees the port.

**4. Collect and name the binaries, then write `SHA256SUMS.txt`** (two spaces
separate the hash and the name):

```powershell
$v = node -p "require('./package.json').version"
New-Item -ItemType Directory -Force -Path dist/release | Out-Null
Copy-Item app/target/release/vncode.exe "dist/release/vncode-$v-win.exe" -Force
Push-Location dist/release
Get-ChildItem vncode-* | Sort-Object Name | ForEach-Object { "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name } | Set-Content -LiteralPath SHA256SUMS.txt -Encoding ascii
Pop-Location
```

**5. Commit, tag, push.** Nothing runs on the push - that is the intended state.

```powershell
git add -A; git commit -m "release: vncode $v"
git tag -a "v$v" -m "vncode $v"; git push origin main "v$v"
```

**6. Publish the Release and look at it.** Attach whatever was built and hashed.
GitHub's own source archives carry the rest, so a Release with no binaries is still
a complete release of a source distribution.

```powershell
$assets = @(Get-ChildItem dist/release/vncode-*) + @(Get-Item dist/release/SHA256SUMS.txt)
gh release create "v$v" --title "vncode $v" --generate-notes @($assets.FullName)
gh release view "v$v"
```

## What NOT to do

- **Do not add a workflow** - the layout check fails on the directory, and a push is
  meant to cost nothing.
- **Do not resurrect the distributer.** There is no `scripts/dist.ps1`, no
  `run-dist.*` and no ship list any more: the distribution is this repository (or
  this repository plus a built binary), and the app installs the pack itself.
- **Do not label a binary for an OS it was not built on.** A `.dmg`, an `.AppImage`
  or a renamed `.exe` is not a macOS or Linux binary.
- **Do not tag a version `package.json` does not have**, and do not rewrite an old
  tag once an archive has been handed to somebody.

If CI ever comes back these say so: `gh api repos/vecnode/vncode/actions/permissions`
(expect `enabled = false`), `0` from its `caches` and `artifacts`, and
`Test-Path .github/workflows` = `False`.

[BUILD.md](BUILD.md) is the build and the checks; [DEPLOY.md](DEPLOY.md) what a
distribution promises; [scripts/checks/README.md](../scripts/checks/README.md)
every tracked check.
