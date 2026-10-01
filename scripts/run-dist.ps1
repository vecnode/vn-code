<#
    scripts/run-dist.ps1 - build the vncode distribution, quickly.

    THE ONE VERB. scripts\run-dist.bat calls this file, scripts\run-dist.bat
    forwards to that same batch, and .github\workflows\distribute.yml will call
    scripts\dist.ps1 on every runner when the workflow is restored (it is parked
    for now). One implementation, three doors.

    WHAT IT ADDS OVER scripts\dist.ps1, AND WHY THAT MATTERS
    --------------------------------------------------------
    dist.ps1 DOES the work - the ship list, the generated files, the zip, the
    single-file build, -Verify. This file decides WHAT IS WORTH DOING, because
    the maintainer runs it on every change and a distributer that takes minutes
    for a one-line plugin edit is a distributer nobody runs. Two caches, both
    keyed on inputs that did not change:

      1. THE SHELL. If nothing under app\src-tauri, app\ui or the icon generator
         is newer than the built binary, cargo is never invoked (-ForceBuild
         overrides). Cargo's own freshness check would reach the same answer, but
         only after paying for a cargo process and a workspace resolve every
         time.

      2. THE ASSEMBLED FOLDER. dist.ps1 records a fingerprint of the inputs that
         decide the folder's contents - the shell binary's hash, the version, the
         ship list, the last commit - and skips the ~100 MB copy, the hashing and
         the zip when the fingerprint still matches. See New-DistFingerprint in
         dist.ps1: it is a cache, and it is only ever trusted for EXACTLY those
         inputs.

    WHAT IT REFUSES TO DO
    ---------------------
    It will not assemble a distribution that fails the repository's own checks.
    A distribution is the artifact somebody installs, and shipping one that
    check-dist-layout or check-no-secrets rejects is how a broken or leaking
    folder reaches a user. -SkipChecks is available and says so out loud.

    FLAGS
      -Version <v>      override the pack version used in the names
      -SkipBuild        reuse the binary under app/src-tauri/target/release
      -ForceBuild       run cargo even when nothing looks stale
      -NoZip            assemble the folder only (no .zip, no single file)
      -Run              assemble, then run the folder's own START-HERE.bat - the
                        whole new-user path: install, then open
      -RunApp           assemble, then run just the packed vncode.exe
      -Verify           assemble, then install into a throwaway DSH_HOME and boot
      -KeepVerifyHome   keep that throwaway home for inspection
      -Sign             sign the shell and the one-file build (off by default)
      -SkipChecks       do not run scripts\checks first
      -OutDir <dir>     assemble under this folder instead of dist/
      -Clean            delete the output folder first
      -NoPause          never hold this window open
      -Help
#>
[CmdletBinding()]
param(
    [string]$Version = '',
    [switch]$SkipBuild,
    [switch]$ForceBuild,
    [switch]$NoZip,
    [switch]$Run,
    [switch]$RunApp,
    [switch]$Verify,
    [switch]$KeepVerifyHome,
    [switch]$Sign,
    [switch]$SkipChecks,
    [string]$OutDir,
    [switch]$Clean,
    [switch]$NoPause,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

# The console contract - UTF-8 output, the colour policy, the shared wording -
# is defined ONCE, in scripts\console\theme.ps1, and dot-sourced by every worker.
. (Join-Path $PSScriptRoot 'console\theme.ps1')
Initialize-VnConsole

# ---------------------------------------------------------------------------
# Host facts. Windows PowerShell 5.1 has no $IsWindows, so the edition is the
# reliable signal - the same shape dist.ps1 and install-all.ps1 use.
# ---------------------------------------------------------------------------
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:Worker = Join-Path $PSScriptRoot 'dist.ps1'
$script:IsWindowsHost = $true
if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) { $script:IsWindowsHost = $false }

function Write-Step($Message) { Write-VnStep $Message }
function Write-Note($Message) { Write-VnNote $Message }
function Write-Warn($Message) { Write-VnWarn $Message }

function Show-Usage {
    Write-Host ''
    Write-Host 'Usage: scripts\run-dist.bat [flags]'
    Write-Host ''
    Write-Host '  -Version <v>      override the pack version used in the names'
    Write-Host '  -SkipBuild        reuse the binary already under app\src-tauri\target\release'
    Write-Host '  -ForceBuild       run cargo even when nothing looks stale'
    Write-Host '  -NoZip            assemble the folder only (no .zip, no single file)'
    Write-Host '  -Run              assemble, then run the produced folder''s START-HERE.bat'
    Write-Host '                    (the whole new-user path: install, then open)'
    Write-Host '  -RunApp           assemble, then run just the packed vncode.exe'
    Write-Host '  -Verify           assemble, then install into a throwaway DSH_HOME and boot'
    Write-Host '  -KeepVerifyHome   keep that throwaway home for inspection'
    Write-Host '  -Sign             sign the shell and the one-file build (off by default;'
    Write-Host '                    see docs\BUILD.md for what this does and does not fix)'
    Write-Host '  -SkipChecks       do not run scripts\checks before assembling'
    Write-Host '  -OutDir <dir>     assemble under this folder instead of dist\'
    Write-Host '  -Clean            delete the output folder first'
    Write-Host '  -NoPause          never hold this window open'
    Write-Host '  -Help / -h / /?   print this help'
    Write-Host ''
    Write-Host 'Builds dist\vncode-<version>-<rid>\ plus the .zip and the one-file .exe,'
    Write-Host 'using scripts\dist.ps1. Nothing changed means nothing rebuilt: the shell is'
    Write-Host 'not recompiled when its source is older than the binary, and the folder,'
    Write-Host 'zip and single file are not rebuilt when their inputs are unchanged.'
    Write-Host ''
    Write-Host 'macOS/Linux: ./scripts/dist.sh is the same work in POSIX shell.'
    Write-Host ''
}

if ($Help) { Show-Usage; exit 0 }

if (-not (Test-Path -LiteralPath $script:Worker)) {
    Write-VnFail "scripts\dist.ps1 is missing from $PSScriptRoot - it is the worker that assembles the distribution."
    exit 1
}

# ---------------------------------------------------------------------------
# 0. One distributer at a time
# ---------------------------------------------------------------------------
# The output folder is deleted and rewritten in place, and a running vncode.exe
# holds its own binary open, so two concurrent runs would fight over the same
# paths and the second would fail somewhere deep with "Access is denied" rather
# than here with a sentence. A named mutex is the whole guard; it is released by
# the OS even if this process is killed outright.
$script:DistMutex = $null
try {
    $script:DistMutex = New-Object System.Threading.Mutex($false, 'Global\vncode-dist')
    if (-not $script:DistMutex.WaitOne(0)) {
        Write-VnFail 'Another vncode distributer is already running (or a previous one is still holding the output folder).'
        Write-Note 'Close the other run - or the vncode window it started - and try again.'
        exit 1
    }
}
catch {
    # A machine policy can forbid a named mutex. That is not a reason to refuse
    # to build; it only costs the guard.
    Write-Note 'Could not take the single-run guard; continuing without it.'
    $script:DistMutex = $null
}

Write-Step 'vncode dist (build the distribution you run and hand over)'
Write-Step "Repo: $script:RepoRoot"

if (-not $script:IsWindowsHost) {
    Write-Warn 'This PowerShell half targets Windows. On macOS and Linux use ./scripts/dist.sh.'
}

# ---------------------------------------------------------------------------
# 1. Is the Rust shell stale?
# ---------------------------------------------------------------------------
# Everything cargo would consider an input, and nothing else. `target` is
# excluded because it is the OUTPUT and would otherwise always be the newest
# thing in the tree, making every check answer "stale".
$script:ShellBinary = Join-Path $script:RepoRoot (Join-Path 'app/src-tauri' (Join-Path 'target/release' 'vncode-desktop.exe'))
$script:ShellInputs = @(
    (Join-Path $script:RepoRoot 'app/src-tauri'),
    (Join-Path $script:RepoRoot 'app/ui')
)
# The icon generator writes app/src-tauri/icons, which tauri-build compiles into
# the binary's resources, so a regenerated icon is a reason to rebuild - and it
# is one directory away from either input above.
$script:IconGenerator = Join-Path $script:RepoRoot 'scripts/make-desktop-icon.mjs'

function Test-ShellStale {
    param([string]$Binary)
    if (-not (Test-Path -LiteralPath $Binary)) { return $true }
    $built = (Get-Item -LiteralPath $Binary).LastWriteTimeUtc
    foreach ($root in $script:ShellInputs) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $newer = Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch '[\\/]target[\\/]' -and $_.LastWriteTimeUtc -gt $built } |
            Select-Object -First 1
        if ($newer) {
            Write-Note "Newer than the built shell: $($newer.FullName.Substring($script:RepoRoot.Length).TrimStart('\', '/'))"
            return $true
        }
    }
    if ((Test-Path -LiteralPath $script:IconGenerator) -and
        ((Get-Item -LiteralPath $script:IconGenerator).LastWriteTimeUtc -gt $built)) {
        Write-Note 'Newer than the built shell: scripts/make-desktop-icon.mjs'
        return $true
    }
    return $false
}

$script:SkipBuildInWorker = [bool]$SkipBuild
if (-not $SkipBuild -and -not $ForceBuild) {
    if (Test-ShellStale -Binary $script:ShellBinary) {
        Write-Step 'The shell is stale (or not built yet) - cargo will run.'
    }
    else {
        # Measured, then stated: this is the difference between a distributer
        # that costs a cargo process on every run and one that costs nothing.
        Write-Step 'The shell is current - cargo will not run (-ForceBuild overrides).'
        $script:SkipBuildInWorker = $true
    }
}
elseif ($ForceBuild) {
    Write-Step 'Building the shell unconditionally (-ForceBuild).'
}
else {
    Write-Step 'Skipping the shell build (-SkipBuild).'
}

# ---------------------------------------------------------------------------
# 2. The repository's own checks
# ---------------------------------------------------------------------------
# Two of them, chosen because they are the two whose failure a distribution
# would SHIP rather than merely fail to build:
#   check-no-secrets     - a credential in a distributed file
#   check-dist-layout    - the ship list, the launchers, the console contract
# They need Node, and they run against the SOURCE tree, before anything is
# copied - which is the point: the folder is never assembled from a state the
# checks have rejected.
if ($SkipChecks) {
    Write-Warn 'Skipping the repository checks (-SkipChecks). The distribution is NOT verified against them.'
}
else {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Warn 'Node.js was not found on PATH, so the checks cannot run.'
        Write-Note 'Install Node.js 22 or newer (https://nodejs.org), or pass -SkipChecks to build without them.'
        Write-VnFail 'Refusing to assemble an unchecked distribution.'
        exit 1
    }
    $checkNames = @('check-no-secrets.mjs', 'check-dist-layout.mjs')
    foreach ($name in $checkNames) {
        $checkPath = Join-Path (Join-Path $PSScriptRoot 'checks') $name
        if (-not (Test-Path -LiteralPath $checkPath)) {
            Write-VnFail "scripts\checks\$name is missing - it is one of the two checks that gate a distribution."
            exit 1
        }
        Write-Step "check: $name"
        # Judged by exit code alone, and its own output is NOT captured: the
        # check prints what it found, and a native command writing to stderr
        # would otherwise become a terminating error under 'Stop'.
        $previousEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & $node.Source $checkPath
            $checkExit = $LASTEXITCODE
        }
        finally { $ErrorActionPreference = $previousEap }
        if ($checkExit -ne 0) {
            Write-Host ''
            Write-VnFail "$name failed (exit $checkExit) - the distribution was NOT assembled."
            Write-Note 'Fix what it reports, or pass -SkipChecks to build an unverified folder on purpose.'
            exit 1
        }
    }
    Write-VnGood 'The repository checks passed.'
}

# ---------------------------------------------------------------------------
# 3. Assemble - the worker owns the ship list, the zip and the one-file build
# ---------------------------------------------------------------------------
# The switches are passed as a splat and only when they were asked for, so a
# `-Version ''` can never reach dist.ps1 as an empty version, and dist.ps1 keeps
# owning every decision about WHAT ships.
$forward = @{}
if ($Version) { $forward['Version'] = $Version }
if ($script:SkipBuildInWorker) { $forward['SkipBuild'] = $true }
if ($NoZip) { $forward['NoZip'] = $true }
if ($Verify) { $forward['Verify'] = $true }
if ($KeepVerifyHome) { $forward['KeepVerifyHome'] = $true }
if ($Sign) { $forward['Sign'] = $true }
if ($OutDir) { $forward['OutDir'] = $OutDir }
if ($Clean) { $forward['Clean'] = $true }
# The INNER worker never pauses: this file owns the window, and two pauses on
# one failure would ask the reader to press a key twice.
$forward['NoPause'] = $true

& $script:Worker @forward
if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-VnFail "The distributer exited with code $LASTEXITCODE - see the messages above."
    exit $LASTEXITCODE
}

# ---------------------------------------------------------------------------
# 4. Run it, the way a new user would
# ---------------------------------------------------------------------------
if ($Run -or $RunApp) {
    # Resolve the folder the worker just produced rather than recomputing its
    # name: the version and the rid are the worker's to decide.
    $artifactRoot = Join-Path $script:RepoRoot 'dist'
    if ($OutDir) {
        $artifactRoot = $OutDir
        if (-not [System.IO.Path]::IsPathRooted($artifactRoot)) { $artifactRoot = Join-Path $script:RepoRoot $artifactRoot }
    }
    $folder = Get-ChildItem -LiteralPath $artifactRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'vncode-*' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $folder) {
        Write-VnFail "No assembled distribution folder was found under $artifactRoot."
        exit 1
    }

    if ($RunApp) {
        $app = Join-Path $folder.FullName 'vncode.exe'
        if (-not (Test-Path -LiteralPath $app)) {
            Write-VnFail "The distribution has no vncode.exe at $app."
            exit 1
        }
        Write-Host ''
        Write-Step "Running just the app: $app"
        Write-Note 'The pack is NOT installed first, so this tests the window only - use -Run for the whole new-user path.'
        & $app
        exit $LASTEXITCODE
    }

    $startHere = Join-Path $folder.FullName 'START-HERE.bat'
    if (-not (Test-Path -LiteralPath $startHere)) {
        Write-VnFail "The distribution has no START-HERE.bat at $startHere."
        exit 1
    }
    Write-Host ''
    Write-Step "Running the distribution as a new user would: $startHere"
    Write-Note 'This installs the pack into your profile and opens the window. Close it to stop the app.'
    # Run it in THIS console, with no arguments at all - which is the double-click
    # path a recipient takes, and the path the launcher's own no-argument repair
    # exists for (console\adapt.cmd stores "no arguments" as one space). `call` is
    # load-bearing: with `cmd /c "..."` alone, cmd would run the batch and then
    # terminate, taking this console with it before the exit code could be read.
    # -Wait so this window owns the run and reports its result; -NoNewWindow so
    # the harness output the reader wants to watch stays here rather than
    # flashing a second window that closes when the app does.
    $quoted = '"' + $startHere + '"'
    $process = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', "call $quoted") `
        -WorkingDirectory $folder.FullName -NoNewWindow -PassThru -Wait
    exit $process.ExitCode
}

exit 0
