# Cutting a vncode release

**There is no CI in this repository, and that is deliberate.** `.github/workflows/`
does not exist, GitHub Actions is disabled, and `check-dist-layout.mjs` fails if a
workflow directory comes back.

A release is **one tag, one Release, three archives**:
`vncode-<version>-win.zip`, `vncode-<version>-mac.zip`,
`vncode-<version>-linux.zip`, plus `SHA256SUMS.txt`. Each is a source distribution
([DISTRIBUTE.md](DISTRIBUTE.md)): the plugin pack, the launchers and the shell's
Rust source, with **no compiled file anywhere**. `START-HERE` starts the app in a
browser tab and needs only Node.js 22+; the native window is a `cargo build
--release` away in the shipped `app/src-tauri`. The three are **the same payload
under three names**, differing only in the `artifact`/`rid`/`targetOs` fields in
`BUILD-INFO.json`.

Needs **Node.js 22+**, **network** for `-Verify`'s one install of the pinned
harness, **a clean tree** (`BUILD-INFO.json` records `dirty`) and **`gh` logged in**
(`gh auth status`). The macOS and Linux archives are *labelled* by `-TargetOs`, not
compiled on those systems - everything runs on the maintainer's machine.

## The ritual

**1. Set the version.** `package.json`'s `version` is what the artifact names, the
release title and the tag follow; never pass `-Version` to make them disagree.

```powershell
node -p "require('./package.json').version"
```

**2. Check the tree, then build all three legs separately** - each must print
`Verify PASSED`. `-TargetOs` stops the mac and linux zips claiming
`platform: windows`, and is refused without `-NoShell`.

```powershell
git status --porcelain          # expect: empty
node scripts/checks/check-no-secrets.mjs; node scripts/checks/check-dist-layout.mjs
foreach ($os in 'win','mac','linux') {
  scripts\run-dist.bat -NoShell -TargetOs $os -Verify -Clean
}
```

**3. Collect and name the assets, then write `SHA256SUMS.txt`** (two spaces separate
the hash and the name):

```powershell
$v = node -p "require('./package.json').version"
New-Item -ItemType Directory -Force -Path dist/release | Out-Null
foreach ($os in 'win','mac','linux') { Copy-Item "dist/vncode-$v-$os.zip" "dist/release/vncode-$v-$os.zip" -Force }
Push-Location dist/release
Get-ChildItem *.zip | Sort-Object Name | ForEach-Object { "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name } | Set-Content -LiteralPath SHA256SUMS.txt -Encoding ascii
sha256sum -c SHA256SUMS.txt; Pop-Location
```

**4. Commit, tag, push.** Nothing runs on the push - that is the intended state.

```powershell
git add -A; git commit -m "release: vncode $v"
git tag -a "v$v" -m "vncode $v"; git push origin main "v$v"
```

**5. Publish the Release and look at it.** Expect exactly four assets and a title of
`vncode <version>` - about twenty megabytes, because no archive carries a binary.

```powershell
gh release create "v$v" --title "vncode $v" --generate-notes `
  "dist/release/vncode-$v-win.zip" "dist/release/vncode-$v-mac.zip" `
  "dist/release/vncode-$v-linux.zip" "dist/release/SHA256SUMS.txt"
gh release view "v$v"
```

## What NOT to do
- **Do not add a workflow** - the layout check fails on the directory, and a push is meant to cost nothing.
- **Do not publish `.exe` or `.run` assets**: those were the single-file builds, and a source release has nothing to append a payload to.
- **Do not ship one zip under three names with the same `BUILD-INFO.json`** - use `-TargetOs` per OS.
- **Do not tag a version `package.json` does not have**, or rewrite an old tag once an archive has been handed to somebody.

If CI ever comes back these say so: `gh api repos/vecnode/vncode/actions/permissions` (expect `enabled = false`), `0` from its `caches` and `artifacts`, and `Test-Path .github/workflows` = `False`.

[DISTRIBUTE.md](DISTRIBUTE.md) has what a distribution contains; [BUILD.md](BUILD.md) the distributer's flags and signing; [scripts/checks/README.md](../scripts/checks/README.md) every tracked check.
