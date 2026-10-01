# scripts/dsh/vendor.ps1 - materialise the runtime the shell launches.
#
# WHAT THIS PRODUCES, and why it is the end of the npm problems:
#
#   runtime/<rid>/node/node.exe                       the pinned Node
#   runtime/<rid>/harness/node_modules/@deepseek-ai/dsh/lib/bin.js
#   runtime/<rid>/VENDOR.json                         versions + a file count
#
# The shell launches `node <bin.js> web --no-open --port N` from this folder -
# no npx, no npm, and nothing fetched at start-up. That matters beyond speed:
#
#   npm error code EPERM
#   npm error path ...\npm-cache\_cacache\tmp\b143f96f
#   npm error Log files were not written due to an error writing to the directory
#
# is what `npx` does on this machine. The folder above is owned by
# BUILTIN\Administradores (an earlier elevated run created it), so npm's
# temp-file dance fails with EPERM and its own message tells the reader to run
# as Administrator - which makes the ownership problem worse, not better. With
# the harness resolved once at BUILD time, npm is never invoked to start the app
# and that whole failure mode stops existing rather than being worked around.
#
# THE SOURCE IS LOCAL FIRST, and that is deliberate rather than lazy: this
# machine already holds the exact pinned tree (npx put it there, and it is the
# tree the running session boots from), so the first cut copies it instead of
# re-downloading ~461 MB. A tree is accepted only when its version matches the
# pin AND it carries bin.js, and every candidate is tried in order, so a fresh
# machine with none of them falls through to a registry install by name.
#
# FLAGS
#   -Rid <rid>        target (default: the host's, win-x64)
#   -Node <path>      the node.exe to vendor (default: the one on PATH)
#   -Force            re-materialise even when the runtime is already complete
#   -Help
[CmdletBinding()]
param(
    [string]$Rid = '',
    [string]$Node = '',
    [switch]$Force,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'console\theme.ps1')
Initialize-VnConsole

$script:RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # scripts/dsh -> repo

function Show-Usage {
    Write-Host ''
    Write-Host 'Usage: powershell -File scripts\dsh\vendor.ps1 [flags]'
    Write-Host ''
    Write-Host '  -Rid <rid>     target runtime (default: this host, e.g. win-x64)'
    Write-Host '  -Node <path>   the node executable to vendor (default: node on PATH)'
    Write-Host '  -Force         rebuild even when runtime\<rid> is already complete'
    Write-Host '  -Help          print this help'
    Write-Host ''
    Write-Host 'Produces runtime\<rid>\{node,harness} so the shell can launch the pinned'
    Write-Host 'harness WITHOUT npx, npm or any network access at start-up.'
    Write-Host ''
}

if ($Help) { Show-Usage; exit 0 }

# --- the pin, from the one place that owns it -------------------------------
$pinFile = Join-Path $script:RepoRoot '.dsh-version.json'
if (-not (Test-Path -LiteralPath $pinFile)) { throw ".dsh-version.json is missing from $script:RepoRoot - the shell has no fallback pin." }
$pin = [string](Get-Content -LiteralPath $pinFile -Raw | ConvertFrom-Json).dsh
if (-not $pin) { throw '.dsh-version.json has no "dsh" pin.' }

# --- the target, derived from the host when not given -----------------------
function Get-HostRid {
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { return 'win-arm64' }
    if ($env:PROCESSOR_ARCHITECTURE -eq 'x86') { return 'win-ia32' }
    return 'win-x64'
}
if (-not $Rid) { $Rid = Get-HostRid }
$runtimeRoot = Join-Path $script:RepoRoot (Join-Path 'runtime' $Rid)
$nodeDir = Join-Path $runtimeRoot 'node'
$harnessDir = Join-Path $runtimeRoot 'harness'
$stamp = Join-Path $runtimeRoot 'VENDOR.json'
$binRel = '@deepseek-ai\dsh\lib\bin.js'

Write-VnStep "vncode runtime vendor"
Write-VnStep "Repo:  $script:RepoRoot"
Write-VnStep "Pin:   $pin"
Write-VnStep "Rid:   $Rid"
Write-VnStep "Into:  $runtimeRoot"

# --- completeness: a runtime is usable ONLY as a whole ----------------------
# A half-copied runtime is worse than none, because the shell would resolve it,
# fail to find bin.js, and report a broken install. So completeness is checked
# as one predicate over all three pieces.
function Test-RuntimeComplete {
    param([string]$Root, [string]$BinRel)
    $node = Join-Path (Join-Path $Root 'node') 'node.exe'
    $bin = Join-Path (Join-Path (Join-Path $Root 'harness') 'node_modules') $BinRel
    $stampFile = Join-Path $Root 'VENDOR.json'
    if (-not (Test-Path -LiteralPath $node)) { return $false }
    if (-not (Test-Path -LiteralPath $bin)) { return $false }
    if (-not (Test-Path -LiteralPath $stampFile)) { return $false }
    try {
        $j = Get-Content -LiteralPath $stampFile -Raw | ConvertFrom-Json
        if ([string]$j.dsh -ne $pin) { return $false }
        if ([string]$j.rid -ne $Rid) { return $false }
    }
    catch { return $false }
    return $true
}

if (-not $Force -and (Test-RuntimeComplete -Root $runtimeRoot -BinRel $binRel)) {
    $s = Get-ChildItem -LiteralPath $runtimeRoot -Recurse -File -Force | Measure-Object -Sum Length
    Write-VnGood "Runtime is already complete for pin $pin - nothing to do (-Force rebuilds)."
    Write-VnNote ("{0} files, {1:N1} MB at {2}" -f $s.Count, ($s.Sum / 1MB), $runtimeRoot)
    exit 0
}

if ($Force -and (Test-Path -LiteralPath $runtimeRoot)) {
    Write-VnNote 'Removing the existing runtime (-Force).'
    Remove-Item -LiteralPath $runtimeRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $runtimeRoot, $nodeDir | Out-Null

# --- 1. the Node runtime ----------------------------------------------------
$nodeExe = if ($Node) { $Node } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $nodeExe -or -not (Test-Path -LiteralPath $nodeExe)) {
    throw "node was not found. Install Node.js 22+ or pass -Node <path to node.exe>."
}
$nodeVersion = (& $nodeExe --version) 2>$null
Write-VnStep "Vendoring Node $nodeVersion from $nodeExe"
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $nodeDir 'node.exe') -Force

# --- 2. the harness tree ----------------------------------------------------
# Candidates in order. The first two are the machine's OWN caches - the tree npx
# already resolved for the running app, then the maintainer's npm cache - and
# the third is a fresh resolve. Each is accepted only when its version matches
# the pin AND bin.js is really there.
function Find-LocalHarness {
    param([string]$Pin, [string]$BinRel)
    $roots = New-Object System.Collections.ArrayList
    [void]$roots.Add((Join-Path (Join-Path $env:LOCALAPPDATA 'vncode\npm-cache') '_npx'))
    [void]$roots.Add((Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'))
    [void]$roots.Add((Join-Path $script:RepoRoot '.upgrade'))
    [void]$roots.Add((Join-Path $script:RepoRoot '.scratch'))

    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        # Direct: <root>/node_modules/... and <root>/<hash>/node_modules/...
        $direct = @(
            (Join-Path $root 'node_modules'),
            (Join-Path (Join-Path (Join-Path $root 'dsh-prod') 'node_modules') '')
        )
        foreach ($d in $direct) {
            if (Test-Path -LiteralPath (Join-Path $d $BinRel)) { return (Split-Path -Parent (Split-Path -Parent $d)) }
        }
        # One level down: every _npx/<hash>/node_modules
        foreach ($child in (Get-ChildItem -LiteralPath $root -Directory -Force -ErrorAction SilentlyContinue)) {
            $nm = Join-Path $child.FullName 'node_modules'
            if (Test-Path -LiteralPath (Join-Path (Join-Path $nm 'node_modules') $BinRel)) {
                $pkgJson = Join-Path (Join-Path $nm 'node_modules') '@deepseek-ai\dsh\package.json'
                $pkgJson = Join-Path (Join-Path $nm '@deepseek-ai\dsh') 'package.json'
                if (Test-Path -LiteralPath $pkgJson) {
                    try {
                        $v = [string](Get-Content -LiteralPath $pkgJson -Raw | ConvertFrom-Json).version
                        if ($v -eq $Pin) { return (Split-Path -Parent $nm) }
                    }
                    catch { }
                }
            }
        }
    }
    return $null
}

# The layout this script wants is runtime/<rid>/harness/node_modules, so the
# source it copies is the folder that CONTAINS a node_modules holding the pin.
function Get-HarnessSource {
    param([string]$Pin, [string]$BinRel)
    # A) an npx/prefix tree: <root>/node_modules/@deepseek-ai/dsh
    $candidates = @()
    $npxRoots = @(
        (Join-Path (Join-Path $env:LOCALAPPDATA 'vncode\npm-cache') '_npx'),
        (Join-Path $env:LOCALAPPDATA 'npm-cache\_npx')
    )
    foreach ($r in $npxRoots) {
        if (-not (Test-Path -LiteralPath $r)) { continue }
        foreach ($c in (Get-ChildItem -LiteralPath $r -Directory -Force -ErrorAction SilentlyContinue)) {
            $nm = Join-Path $c.FullName 'node_modules'
            $pj = Join-Path $nm '@deepseek-ai\dsh\package.json'
            if (-not (Test-Path -LiteralPath (Join-Path $nm $BinRel))) { continue }
            if (-not (Test-Path -LiteralPath $pj)) { continue }
            try {
                $v = [string](Get-Content -LiteralPath $pj -Raw | ConvertFrom-Json).version
                if ($v -eq $Pin) { $candidates += [pscustomobject]@{ Prefix = $c.FullName; Version = $v; Where = $c.FullName } }
            }
            catch { }
        }
    }
    # B) the maintainer's own npm install of the pin
    foreach ($extra in @((Join-Path $script:RepoRoot '.upgrade\dsh020'), (Join-Path $script:RepoRoot '.scratch\dsh-prod'))) {
        $nm = Join-Path $extra 'node_modules'
        $pj = Join-Path $nm '@deepseek-ai\dsh\package.json'
        if ((Test-Path -LiteralPath (Join-Path $nm $BinRel)) -and (Test-Path -LiteralPath $pj)) {
            try {
                $v = [string](Get-Content -LiteralPath $pj -Raw | ConvertFrom-Json).version
                if ($v -eq $Pin) { $candidates += [pscustomobject]@{ Prefix = $extra; Version = $v; Where = $extra } }
            }
            catch { }
        }
    }
    return $candidates
}

$sources = @(Get-HarnessSource -Pin $pin -BinRel $binRel)
if ($sources.Count -gt 0) {
    $src = $sources[0]
    Write-VnStep "Found the pinned harness locally: $($src.Where)"
    Write-VnNote "Copying its node_modules (~461 MB) - no download, no npm, no network."
    New-Item -ItemType Directory -Force -Path $harnessDir | Out-Null
    $target = Join-Path $harnessDir 'node_modules'
    # -Force so a re-run replaces rather than nests.
    Copy-Item -LiteralPath (Join-Path $src.Prefix 'node_modules') -Destination $target -Recurse -Force
}
else {
    # Nothing local carries the pin: resolve it by name, once, at BUILD time -
    # which is the whole point. It needs a network, and it needs npm to work.
    Write-VnWarn "No local tree carries @deepseek-ai/dsh@$pin - resolving it from the registry."
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) { throw "npm is needed to resolve the pin and was not found. Install Node.js 22+, or build the runtime on a machine that has one." }
    $tmp = Join-Path $runtimeRoot '.resolve'
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $tmp 'package.json'), '{"name":"vncode-runtime","private":true,"version":"0.0.0"}')
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $npm.Source install --prefix $tmp --omit=dev --ignore-scripts --no-audit --no-fund "@deepseek-ai/dsh@$pin" 2>&1 |
        Select-Object -Last 5 | ForEach-Object { Write-VnNote $_ }
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previous
    if ($code -ne 0) { throw "npm could not resolve @deepseek-ai/dsh@$pin (exit $code)." }
    New-Item -ItemType Directory -Force -Path $harnessDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $tmp 'node_modules') -Destination (Join-Path $harnessDir 'node_modules') -Recurse -Force
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# --- 3. prove it is usable before writing the stamp -------------------------
# WAIT FOR THE COPY TO SETTLE FIRST. This is not defensive padding: a run of
# this script was measured failing here while `Copy-Item` still had files in
# flight, so the check reported "no bin.js" against a tree that was 216 MB of a
# 462 MB copy and landed correctly moments later. A copy that is still moving
# and a copy that has silently stopped look identical from the outside, so the
# destination is watched until its file count stops changing, with a cap so a
# copy that genuinely died cannot hang the build.
$harnessModules = Join-Path $harnessDir 'node_modules'
if (Test-Path -LiteralPath $harnessModules) {
    $last = -1
    for ($i = 0; $i -lt 60; $i++) {
        $now = (Get-ChildItem -LiteralPath $harnessModules -Recurse -File -Force -ErrorAction SilentlyContinue |
                Measure-Object).Count
        if ($now -gt 0 -and $now -eq $last) { break }
        $last = $now
        Start-Sleep -Milliseconds 500
    }
    Write-VnNote "Harness tree settled at $last files."
}

$vendoredBin = Join-Path $harnessModules $binRel
if (-not (Test-Path -LiteralPath $vendoredBin)) {
    throw "The vendored harness has no bin.js at $vendoredBin - the runtime would be resolved and then fail to start."
}
$vendoredNode = Join-Path $nodeDir 'node.exe'

# Ask the vendored pair for its own version. This is the cheapest proof that the
# copied Node can actually execute the copied harness, and it is the check that
# would catch a half-copy, a wrong architecture or a missing dependency at the
# one moment somebody can still do something about it.
Write-VnStep "Verifying the runtime by running the vendored harness..."
$previous2 = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$reported = (& $vendoredNode $vendoredBin --version) 2>&1 | Select-Object -First 1
$verifyCode = $LASTEXITCODE
$ErrorActionPreference = $previous2
if ($verifyCode -ne 0) {
    throw "The vendored runtime could not report its version (exit $verifyCode): $reported"
}
Write-VnGood "The vendored harness reports: $reported"

$measured = Get-ChildItem -LiteralPath $runtimeRoot -Recurse -File -Force | Measure-Object -Sum Length

# --- 4. the stamp, written LAST --------------------------------------------
# Its presence is what the shell and this script treat as "complete", so it is
# written only after the runtime has been proven to run.
$stampLines = @(
    '{',
    "  `"dsh`": `"$pin`",",
    "  `"rid`": `"$Rid`",",
    "  `"node`": `"$nodeVersion`",",
    "  `"reported`": `"$reported`",",
    "  `"bin`": `"$($binRel.Replace('\', '/'))`",",
    "  `"files`": $($measured.Count),",
    "  `"bytes`": $($measured.Sum),",
    "  `"vendoredAt`": `"$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))`"",
    '}'
)
[System.IO.File]::WriteAllText($stamp, (($stampLines -join "`n") + "`n"))

Write-Host ''
Write-VnGood "Runtime ready: $runtimeRoot"
Write-VnNote ("{0} files, {1:N1} MB" -f $measured.Count, ($measured.Sum / 1MB))
Write-VnNote "node:    $(Join-Path $nodeDir 'node.exe')"
Write-VnNote "harness: $vendoredBin"
Write-VnNote 'The shell resolves this FIRST, so no npx, no npm and no network at start-up.'
