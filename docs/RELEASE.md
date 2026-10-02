# Cutting a vncode release

**There is no CI in this repository, and that is deliberate.** `.github/workflows/`
does not exist, GitHub Actions is **disabled** on the repository, and
`scripts/checks/check-dist-layout.mjs` *fails* if a workflow directory ever comes
back — so a deleted CI cannot quietly return on somebody's push. A release is cut
here, by hand, with the commands below, and it takes about a minute.

This is the trade the owner made deliberately: nothing runs on a push, nothing
accumulates in the Actions cache or artifact store, and no runner has to compile
anything. What it costs is that the steps below are a checklist rather than a
pipeline — so run them in order.

---

## What a release is

**One tag, one Release, three archives** — one per operating system:

```
vncode-<version>-win.zip
vncode-<version>-mac.zip
vncode-<version>-linux.zip
SHA256SUMS.txt
```

Each archive is a **source distribution** (see [`DISTRIBUTE.md`](DISTRIBUTE.md)):
the plugin pack, the launchers, and the shell's Rust source, with **no compiled
file anywhere**. Nothing has to be compiled to use it — `START-HERE` starts the
app in a browser tab and needs only Node.js 22+ — and the native window remains
available to anyone who runs `cargo build --release` in the shipped
`app/src-tauri`.

The three archives are **the same payload under three names**, differing only in
the `artifact`/`rid`/`targetOs` fields inside `BUILD-INFO.json`. That is not a
shortcut: the payload is OS-neutral plain JavaScript carrying both entry-point
halves, so "three releases" is about which file a visitor should pick, not about
three different builds.

---

## Before you start

| Need | Why |
|---|---|
| **Node.js 22+** | the distributer reads JSON with it, and `-Verify` boots the pinned harness |
| **Network** | `-Verify` installs the pinned harness through npm/pnpm once |
| **A clean tree** | `BUILD-INFO.json` records `dirty`, and a release should not be cut from uncommitted edits |
| **`gh` logged in** | to publish (`gh auth status`) |

**Everything runs on the maintainer's machine.** macOS and Linux archives are
*labelled* by `-TargetOs`, not compiled on those systems — which is the whole
point of the source-only shape. There is nothing platform-specific left to
produce.

---

## The ritual

### 1. Set the version

`package.json`'s `version` is the version everything else follows: the artifact
names, the release title, and the guard below.

```powershell
node -p "require('./package.json').version"
```

To release a new version, edit that field and commit it — e.g. `0.1.1`. Do **not**
pass `-Version` to make the artifacts disagree with `package.json`: a tag must
name the version that was built.

### 2. Check the tree, then build all three

```powershell
git status --porcelain          # expect: empty
node scripts/checks/check-no-secrets.mjs
node scripts/checks/check-dist-layout.mjs

foreach ($os in 'win','mac','linux') {
  scripts\run-dist.bat -NoShell -TargetOs $os -Verify -Clean
}
```

Each leg assembles `dist/vncode-<version>-<os>/`, zips it, and then **proves it
runs**: installs that copy into a throwaway `DSH_HOME`, asserts the profile lists
every bundle the folder carries, boots the pinned harness, waits for the real
`dsh web:` ready line and prints it with **`token=REDACTED`**.

`-TargetOs` is what stops the mac and linux zips from claiming
`platform: windows` in their `BUILD-INFO.json`; it is refused without `-NoShell`,
because a *compiled* shell really is platform-specific.

> **If `-Verify` fails with `npm error code EPERM`.** npm is writing to a cache
> outside the folder and this account cannot write there — the same failure the
> vendored runtime exists to avoid. Point it somewhere it can:
> `$env:npm_config_cache = "$PWD\.scratch\npm-cache"`. A sandboxed shell that
> blocks npm's nested spawns fails the same way; run it in a normal terminal.

Run the three legs **separately** rather than in one loop you do not read: each
one must print `Verify PASSED` before you move on.

### 3. Collect and name the assets

```powershell
$v = node -p "require('./package.json').version"
New-Item -ItemType Directory -Force -Path dist/release | Out-Null
foreach ($os in 'win','mac','linux') {
  Copy-Item "dist/vncode-$v-$os.zip" "dist/release/vncode-$v-$os.zip" -Force
}
```

### 4. Write `SHA256SUMS.txt`

```powershell
Push-Location dist/release
$lines = Get-ChildItem *.zip | Sort-Object Name | ForEach-Object {
  "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name
}
Set-Content -LiteralPath SHA256SUMS.txt -Value $lines -Encoding ascii
Get-Content SHA256SUMS.txt
Pop-Location
```

Two spaces between the hash and the name, LF endings are fine for `sha256sum -c`
and `Get-FileHash` alike. Verify it before publishing:

```sh
cd dist/release && sha256sum -c SHA256SUMS.txt
```

### 5. Commit, tag, push

```powershell
$v = node -p "require('./package.json').version"
git add -A
git commit -m "release: vncode $v"
git tag -a "v$v" -m "vncode $v"
git push origin main "v$v"
```

**Nothing will run on the push.** Actions is disabled, so there is no workflow to
trigger, no cache to fill and no artifact to accumulate. That is the intended
state; if you ever see a run appear, section "If CI comes back" below is the bug.

### 6. Publish the Release

```powershell
$v = node -p "require('./package.json').version"
gh release create "v$v" --title "vncode $v" --generate-notes `
  "dist/release/vncode-$v-win.zip" `
  "dist/release/vncode-$v-mac.zip" `
  "dist/release/vncode-$v-linux.zip" `
  "dist/release/SHA256SUMS.txt"
```

Then look at it, because a Release is the one step that cannot be quietly undone:

```powershell
gh release view "v$v"
```

Expect **exactly four assets** — three OS archives and the checksums file — and a
title of `vncode <version>`. Twenty-one megabytes, not three hundred: there is no
compiled binary in any of them.

---

## What NOT to do

- **Do not add a workflow.** Not "just a lint one": the layout check fails on the
  directory, and the whole point of this repository's shape is that a push costs
  nothing. Run the checks in step 2 by hand; they take seconds.
- **Do not publish `.exe` or `.run` assets.** Those were the single-file builds —
  the zip appended to a compiled shell binary. A source release has no binary, so
  there is nothing to append, and `scripts/dist.ps1 -NoShell` deliberately does not
  produce them.
- **Do not ship one zip under three names with the same `BUILD-INFO.json`.** Use
  `-TargetOs` per OS so each archive's own metadata names the OS it is for.
- **Do not tag a version `package.json` does not have.** The tag must name what
  was built; that is the one guard the old CI enforced and it is now on you.
- **Do not delete the old tags' history to "clean up".** Re-cutting a version is
  fine when nothing was ever downloaded (that is what happened for 0.1.0); once an
  archive has been handed to somebody, move forward instead.

## If CI comes back

It should not, and two things will tell you if it does:

```powershell
gh api repos/vecnode/vncode/actions/permissions        # expect: enabled = false
gh api repos/vecnode/vncode/actions/caches --jq .total_count      # expect: 0
gh api repos/vecnode/vncode/actions/artifacts --jq .total_count   # expect: 0
Test-Path .github/workflows                            # expect: False
```

If space has accumulated again, it is these two stores and nothing else:

```powershell
gh api -X PUT repos/vecnode/vncode/actions/permissions -F enabled=false

$c = gh api "repos/vecnode/vncode/actions/caches?per_page=100" | ConvertFrom-Json
foreach ($x in $c.actions_caches) { gh api -X DELETE "repos/vecnode/vncode/actions/caches/$($x.id)" }

$a = gh api "repos/vecnode/vncode/actions/artifacts?per_page=100" --paginate | ConvertFrom-Json
foreach ($x in $a.artifacts) { gh api -X DELETE "repos/vecnode/vncode/actions/artifacts/$($x.id)" }
```

Deleting by id, read fresh from the API, means each call names the exact object it
removes — never a pattern that could match something else.

## See also

- [`DISTRIBUTE.md`](DISTRIBUTE.md) — what a distribution contains and why.
- [`BUILD.md`](BUILD.md) — building the native shell, signing, and the toolchain.
- [`../scripts/checks/README.md`](../scripts/checks/README.md) — the tracked checks
  that gate a release.
