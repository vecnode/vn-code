<#
    scripts/dist.ps1 - build a vncode DISTRIBUTION folder and its zip.

    WHAT IT PRODUCES
        dist/vncode-<version>-<rid>/       the folder you CLICK: the built
                                               shell (vncode.exe) beside the
                                               whole pack it live-links from
        dist/vncode-<version>-<rid>.zip    the same folder, for handing to
                                               somebody else

    SOURCE-ONLY MODE (-NoShell), WHICH IS WHAT A RELEASE USES
        -NoShell assembles the SAME folder with the shell left as SOURCE
        (app/src-tauri + app/ui, which dist-manifest.txt ships) and no built
        binary. Nothing is compiled anywhere, so the result is reproducible on
        any machine and the artifact is named for the OPERATING SYSTEM alone
        (vncode-<version>-win|mac|linux) rather than for an architecture: the
        payload is plain JavaScript with both entry-point halves in it, so one
        assembly is what every OS downloads. The browser path
        (START-HERE -> scripts/run-web) needs nothing but Node.js; the native
        window is still available to anyone who runs cargo build in the shipped
        app/src-tauri. This is why no release compiles anything.

    WHY A FOLDER AND NOT JUST AN .exe
        app/ is a LAUNCHER, not a bundle. The shell walks up for
        .dsh-version.json, runs the pinned `npx @deepseek-ai/dsh@<pin> web
        --no-open` and shows THAT url in a native window; the plugins are
        installed into the web profile as LIVE LINKS into packages/. So the
        distribution IS this repository plus the built binary - nothing is
        compiled into it, and the folder has to stay where it is. Move it and the
        profile's links point at folders that are no longer there; re-running
        START-HERE.bat re-installs from wherever the folder now lives.

    NO CI, ON PURPOSE
        There is no .github/workflows in this repository and GitHub Actions is
        disabled on it. A release is cut HERE, on the maintainer's machine, with
        `run-dist.bat -NoShell -Verify`; docs/RELEASE.md is the whole ritual.
        scripts/checks/check-dist-layout.mjs fails if a workflow directory ever
        comes back, so a deleted CI cannot quietly return.

    WHAT SHIPS is not decided here: it is scripts/dist-manifest.txt, read by both
    halves of this feature (and pinned by scripts/checks/check-dist-layout.mjs).

    FLAGS (dist.sh takes the same ones)
        -Version <v>      override the pack version used in the names
                          (default: package.json's version)
        -NoShell          SOURCE-ONLY: build no shell binary and ship app/ as
                          source instead, naming the artifact for the OS alone
                          (vncode-<version>-win|mac|linux). This is the release
                          mode - nothing is compiled
        -TargetOs <os>    name and label the artifact for this operating system
                          (win|mac|linux) instead of the host's own. The payload
                          is OS-neutral, so one assembly can be published as the
                          three OS releases; this is what stops the mac and
                          linux zips from claiming `platform: windows`. Without
                          -NoShell it is refused, because a compiled shell really
                          is platform-specific
        -SkipBuild        reuse the binary under app/src-tauri/target/release
        -NoZip            assemble the folder only (no .zip, no single file)
        -Run              assemble, then RUN the produced distribution
                          (foreground: the shell's console output stays here)
        -Verify           assemble, then install into a throwaway DSH_HOME and
                          boot the pinned harness from it, waiting for the ready
                          line - the end-to-end check a release runs
        -KeepVerifyHome   keep that throwaway home for inspection
        -Clean            delete dist/ first
        -Help

    THE LAUNCH TOKEN IS A LIVE CREDENTIAL. The ready line the harness prints
    carries one, so everything this script reports from that line goes through
    the same redaction app/src-tauri/src/readyline.rs applies: the value becomes
    REDACTED, and a line that does not name a loopback address is refused rather
    than reported as good.
#>
[CmdletBinding()]
param(
    [string]$Version = '',
    [switch]$NoShell,
    [string]$TargetOs = '',
    [switch]$SkipBuild,
    [switch]$NoZip,
    [switch]$Run,
    [switch]$Verify,
    [switch]$KeepVerifyHome,
    # Signing is OFF by default so a local build stays fast: see docs/BUILD.md
    # for the sequencing rule (the shell and the FINAL one-file build are two
    # separate signatures) and for what a certificate does and does not fix.
    [switch]$Sign,
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
# Host facts. Windows PowerShell 5.1 has no $IsWindows ($IsMacOS/$IsLinux), so
# the edition is the reliable signal for 5.1 - the same shape install-all.ps1
# uses, for the same reason.
# ---------------------------------------------------------------------------
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:Platform = 'linux'
if ($PSVersionTable.PSEdition -ne 'Core') { $script:Platform = 'windows' }
elseif ($IsWindows) { $script:Platform = 'windows' }
elseif ($IsMacOS) { $script:Platform = 'macos' }
$script:IsWindowsHost = $script:Platform -eq 'windows'
$script:Sep = [System.IO.Path]::DirectorySeparatorChar

# The shipped name of the binary: Windows needs the suffix, and the pack's docs
# name the folder launcher without it.
$script:BinaryName = 'vncode.exe'
if (-not $script:IsWindowsHost) { $script:BinaryName = 'vncode' }
# What cargo names it (Cargo.toml's package name).
$script:CargoBinaryName = 'vncode-desktop.exe'
if (-not $script:IsWindowsHost) { $script:CargoBinaryName = 'vncode-desktop' }
# The suffix of the single-file build that sits BESIDE the folder and the zip.
# Windows gets an `.exe`; on macOS and Linux the bare artifact name is already
# the FOLDER's, so the self-extracting file takes the conventional `.run`.
$script:OneFileSuffix = '.exe'
if (-not $script:IsWindowsHost) { $script:OneFileSuffix = '.run' }

function Write-Step($Message) { Write-VnStep $Message }
function Write-Note($Message) { Write-VnNote $Message }

function Assert-Tool {
    param([string]$Name)
    $found = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $found) {
        throw "$Name was not found on PATH. Node.js 22 or newer is required (https://nodejs.org)."
    }
    return $found.Source
}

# The command names one tool goes by on this platform: npx.cmd before npx on
# Windows, the bare name elsewhere.
function Get-ToolPath {
    param([string[]]$Names)
    foreach ($name in $Names) {
        $found = Get-Command $name -ErrorAction SilentlyContinue
        if ($found) { return $found.Source }
    }
    return $null
}

function Get-ToolNames {
    param([string]$Name)
    if ($script:IsWindowsHost) { return @("$Name.cmd", "$Name.exe", $Name) }
    return @($Name)
}

function Show-Usage {
    Write-Host ''
    Write-Host 'Usage: scripts\run-dist.bat [flags]'
    Write-Host ''
    Write-Host '  -Version <v>      override the pack version used in the names'
    Write-Host '  -NoShell          SOURCE-ONLY release: compile nothing, ship app/ as source,'
    Write-Host '                    and name the artifact vncode-<version>-win|mac|linux'
    Write-Host '  -TargetOs <os>    win|mac|linux - name and label the artifact for this OS'
    Write-Host '                    instead of the host (the payload is OS-neutral, so one'
    Write-Host '                    assembly is published as the three OS releases)'
    Write-Host '  -SkipBuild        reuse the binary already under app/src-tauri/target/release'
    Write-Host '  -NoZip            assemble the folder only (no .zip, no single file)'
    Write-Host '  -Run              assemble, then run the produced distribution'
    Write-Host '  -Verify           assemble, then install into a throwaway DSH_HOME and boot'
    Write-Host '                    the pinned harness from it (the end-to-end release check)'
    Write-Host '  -KeepVerifyHome   keep that throwaway home for inspection'
    Write-Host '  -OutDir <dir>     assemble under this folder instead of dist/ (a relative'
    Write-Host '                    path resolves against the repository root)'
    Write-Host '  -Clean            delete the output folder first'
    Write-Host '  -NoPause          never hold this window open'
    Write-Host '  -Help / -h / /?   print this help'
    Write-Host ''
    Write-Host 'Builds dist/vncode-<version>-<rid>/ from scripts/dist-manifest.txt plus the'
    Write-Host 'built shell, and zips it beside itself. dist/ is never committed.'
    Write-Host 'With -NoShell the shell is shipped as SOURCE and nothing is compiled, which'
    Write-Host 'is what a release uses: three archives, one per operating system.'
    Write-Host 'macOS/Linux: ./scripts/dist.sh is the same thing in POSIX shell.'
    Write-Host 'Run it from anywhere: it lives in scripts/ and resolves the repository root'
    Write-Host 'as the folder above.'
    Write-Host ''
}

# ---------------------------------------------------------------------------
# The repository facts a distribution has to carry
# ---------------------------------------------------------------------------
function Get-DshPin {
    $manifest = Join-Path $script:RepoRoot '.dsh-version.json'
    if (-not (Test-Path -LiteralPath $manifest)) {
        throw ".dsh-version.json is missing from $script:RepoRoot - the shell reads its pin from the folder it is run in, and it has no fallback."
    }
    $json = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if (-not $json.dsh) { throw '.dsh-version.json has no "dsh" pin.' }
    return [string]$json.dsh
}

function Get-PackVersion {
    $manifest = Join-Path $script:RepoRoot 'package.json'
    if (-not (Test-Path -LiteralPath $manifest)) { throw "package.json is missing from $script:RepoRoot." }
    $json = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if (-not $json.version) { throw 'package.json has no "version".' }
    return [string]$json.version
}

# windows-x64, mac-arm64, linux-x64 ... - the suffix that tells two artifacts of
# the same version apart in a download folder.
function Get-HostRid {
    $arch = ''
    if ($script:IsWindowsHost) {
        $arch = [string]$env:PROCESSOR_ARCHITECTURE
        if ($arch -eq 'ARM64') { return 'win-arm64' }
        return 'win-x64'
    }
    $machine = (& uname -m 2>$null)
    if (-not $machine) { $machine = 'x86_64' }
    $machine = ([string]$machine).Trim().ToLowerInvariant()
    $isArm = $machine -eq 'arm64' -or $machine -eq 'aarch64'
    if ($script:Platform -eq 'macos') {
        if ($isArm) { return 'mac-arm64' }
        return 'mac-x64'
    }
    if ($isArm) { return 'linux-arm64' }
    return 'linux-x64'
}

# The OPERATING SYSTEM alone, with no architecture in it - 'win', 'mac' or
# 'linux'. This is the artifact label in -NoShell mode and the reason is the
# payload: source-only ships app/ as source and no compiled file at all, so the
# folder has no architecture in it to tell two downloads apart. One assembly is
# what every OS downloads, and the name says which OS it is for.
function Get-HostOsFamily {
    if ($script:Platform -eq 'windows') { return 'win' }
    if ($script:Platform -eq 'macos') { return 'mac' }
    return 'linux'
}

function Get-UtcStamp { return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }

function Invoke-Quiet {
    param([string]$File, [string[]]$Arguments)
    try {
        $output = & $File @Arguments 2>$null
        if ($LASTEXITCODE -ne 0) { return '' }
        return ([string]($output | Select-Object -First 1)).Trim()
    }
    catch { return '' }
}

# ---------------------------------------------------------------------------
# The ship list
# ---------------------------------------------------------------------------
function Get-ManifestRules {
    $file = Join-Path $script:RepoRoot 'scripts/dist-manifest.txt'
    if (-not (Test-Path -LiteralPath $file)) { throw "scripts/dist-manifest.txt is missing - it is the one list of what ships." }
    $rules = New-Object System.Collections.ArrayList
    foreach ($line in (Get-Content -LiteralPath $file)) {
        $text = ([string]$line).Trim()
        if (-not $text) { continue }
        if ($text.StartsWith('#')) { continue }
        $parts = $text -split '\s+', 2
        if ($parts.Count -lt 2) { throw "dist-manifest.txt: cannot read the rule '$text' (expected '<include|skipdir|skippath|skipfile> <path>')." }
        $kind = $parts[0].ToLowerInvariant()
        if (@('include', 'skipdir', 'skippath', 'skipfile') -notcontains $kind) {
            throw "dist-manifest.txt: unknown rule kind '$kind' on the line '$text'."
        }
        $path = $parts[1].Trim().Replace('\', '/')
        if ($path.Contains('..')) { throw "dist-manifest.txt: '$path' reaches outside the repository." }
        [void]$rules.Add([pscustomobject]@{ Kind = $kind; Path = $path })
    }
    if ($rules.Count -eq 0) { throw 'dist-manifest.txt has no rules in it.' }
    return $rules
}

# Skip rules win over include rules, whatever order they appear in the file.
function Test-Skip {
    param([string]$Relative, [bool]$IsDirectory, [object[]]$Rules)
    $name = $Relative
    $slash = $Relative.LastIndexOf('/')
    if ($slash -ge 0) { $name = $Relative.Substring($slash + 1) }
    foreach ($rule in $Rules) {
        if ($rule.Kind -eq 'skipdir') {
            if ($IsDirectory -and ($name -eq $rule.Path)) { return $true }
        }
        elseif ($rule.Kind -eq 'skippath') {
            if (($Relative -eq $rule.Path) -or $Relative.StartsWith("$($rule.Path)/")) { return $true }
        }
        elseif ($rule.Kind -eq 'skipfile') {
            if ((-not $IsDirectory) -and ($name -like $rule.Path)) { return $true }
        }
    }
    return $false
}

# The relative paths are kept POSIX-shaped ('/') for rule matching, and turned
# back into the host's separator only when a file is written.
#
# `Prefix` is where this include rule's root sits inside the distribution
# ('packages' for `include packages`), and it is part of the DESTINATION as well
# as the name the skip rules see - without it a walked tree would be flattened
# into the distribution root.
function Copy-Tree {
    param([string]$SourceRoot, [string]$Prefix, [string]$Relative, [string]$Destination, [object[]]$Rules)
    $source = $SourceRoot
    if ($Relative) { $source = Join-Path $SourceRoot $Relative }
    foreach ($entry in (Get-ChildItem -LiteralPath $source -Force)) {
        $walk = $entry.Name
        if ($Relative) { $walk = "$Relative/$($entry.Name)" }
        $rel = $walk
        if ($Prefix) { $rel = "$Prefix/$walk" }
        if ($entry.PSIsContainer) {
            if (Test-Skip -Relative $rel -IsDirectory $true -Rules $Rules) { continue }
            Copy-Tree -SourceRoot $SourceRoot -Prefix $Prefix -Relative $walk -Destination $Destination -Rules $Rules
        }
        else {
            if (Test-Skip -Relative $rel -IsDirectory $false -Rules $Rules) { continue }
            $target = Join-Path $Destination $rel.Replace('/', $script:Sep)
            $parent = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
            Copy-Item -LiteralPath $entry.FullName -Destination $target -Force
        }
    }
}

function Copy-Payload {
    param([string]$Destination, [object[]]$Rules)
    $copied = 0
    foreach ($rule in $Rules) {
        if ($rule.Kind -ne 'include') { continue }
        $source = Join-Path $script:RepoRoot $rule.Path.Replace('/', $script:Sep)
        if (-not (Test-Path -LiteralPath $source)) {
            throw "dist-manifest.txt includes '$($rule.Path)', which does not exist in this repository."
        }
        $item = Get-Item -LiteralPath $source -Force
        if ($item.PSIsContainer) {
            Copy-Tree -SourceRoot $source -Prefix $rule.Path -Relative '' -Destination $Destination -Rules $Rules
        }
        else {
            if (Test-Skip -Relative $rule.Path -IsDirectory $false -Rules $Rules) { continue }
            $target = Join-Path $Destination $rule.Path.Replace('/', $script:Sep)
            $parent = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
            Copy-Item -LiteralPath $source -Destination $target -Force
        }
        $copied = $copied + 1
    }
    return $copied
}

# The bundle names this distribution carries - read from the copies themselves,
# so the list is the shipped tree's own claim and not a second manifest.
# The assembled folder has to look like the repository, not like a copy of it
# that went wrong: one sentinel per shipped family, so a walk that flattens or
# nests a tree fails HERE instead of shipping. The POSIX half checks the same
# list (scripts/checks/check-dist-layout.mjs fails when the two lists drift).
function Assert-Sentinels {
    param([string]$DistDir, [switch]$NoShell)
    $sentinels = @(
        '.dsh-version.json',
        'README.md',
        'scripts/install-all.ps1',
        'scripts/install-all.sh',
        'docs/INSTALL.md',
        'assets/vncode.svg',
        # The shell family's sentinel. app/README.md is in every distribution;
        # the Rust source is in a SOURCE-ONLY one (-NoShell, the release mode),
        # which is why the manifest ships it. Asserting on the source here is
        # right: a source-only folder without it is a folder whose native window
        # can never be built, and that is a broken release rather than a lean one.
        'app/README.md',
        'packages/dsh-vn-master/package.json',
        'packages/dsh-vn-master/cordis.patch.yml',
        'packages/dsh-rightbar/lib/client.js',
        'packages/dsh-editor/lib/vendor/cm6.min.js',
        'packages/dsh-cmdbar/lib/client.js',
        'packages/dsh-diagrams/lib/vendor/mermaid.min.js',
        'packages/dsh-pdf/lib/vendor/pdf.min.mjs',
        'packages/dsh-pdf/skills/pdf-analysis/SKILL.md',
        # The build fingerprint. Its presence is what tells a later run that this
        # folder was assembled from inputs it can vouch for - a folder missing it
        # is a folder this build did not produce, and is reassembled rather than
        # trusted.
        '.vncode-fingerprint.json'
    )
    if ($NoShell) {
        # The release shape: the shell is source, so its source has to be here.
        $sentinels += 'app/src-tauri/Cargo.toml'
        $sentinels += 'app/src-tauri/src/main.rs'
    }
    $missing = New-Object System.Collections.ArrayList
    foreach ($sentinel in $sentinels) {
        if (-not (Test-Path -LiteralPath (Join-Path $DistDir $sentinel.Replace('/', $script:Sep)))) {
            [void]$missing.Add($sentinel)
        }
    }
    if ($missing.Count -gt 0) {
        throw "The assembled distribution is missing: $($missing -join ', ') (dist-manifest.txt and the copy disagree)."
    }
}

function Get-DistBundleNames {
    param([string]$DistDir)
    $names = New-Object System.Collections.ArrayList
    $packages = Join-Path $DistDir (Join-Path 'packages' '*')
    foreach ($dir in (Get-ChildItem -Path $packages -Directory -Force -ErrorAction SilentlyContinue)) {
        $manifest = Join-Path $dir.FullName 'package.json'
        if (-not (Test-Path -LiteralPath $manifest)) { continue }
        try {
            $json = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
        }
        catch { continue }
        if ($json.dsh -and $json.dsh.bundle -and $json.name) { [void]$names.Add([string]$json.name) }
    }
    return $names
}

function Measure-Tree {
    param([string]$Root)
    $files = 0
    $bytes = 0
    foreach ($item in (Get-ChildItem -LiteralPath $Root -Recurse -File -Force)) {
        $files = $files + 1
        $bytes = $bytes + $item.Length
    }
    return [pscustomobject]@{ Files = $files; Bytes = $bytes }
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

<#
    Line endings are part of the artefact, not a detail:
      - a .bat file wants CRLF (cmd.exe's own parser and `goto :label` are
        unhappy with a lone LF),
      - a .sh file and SHA256SUMS.txt want LF (a CRLF shebang breaks `sh`, and
        sha256sum reads a trailing CR as part of the file name),
    so every generated file says which one it wants instead of taking whatever
    Set-Content happens to do on this PowerShell version.
#>
function Write-TextFile {
    param([string]$Path, [string[]]$Lines, [string]$Newline)
    $text = ($Lines -join $Newline) + $Newline
    [System.IO.File]::WriteAllText($Path, $text, (New-Object System.Text.ASCIIEncoding))
}

# ---------------------------------------------------------------------------
# The files a distribution generates for itself
# ---------------------------------------------------------------------------
function New-StartHere {
    param([string]$DistDir, [string]$DshPin)
    if ($script:IsWindowsHost) {
        $lines = @(
            '@echo off',
            'rem ============================================================',
            'rem  vncode - START HERE',
            'rem  Generated by scripts/dist.ps1 - do not edit; re-run the',
            'rem  distributer in the source repository to change it.',
            'rem',
            'rem  Double-click this file. It makes sure the DeepSeek Harness',
            "rem  web profile has this pack installed from THIS folder, then",
            'rem  opens vncode in its own window.',
            'rem',
            'rem  Requirements: Node.js 22 or newer on PATH, and network',
            "rem  access on the first run (the shell downloads the pinned",
            "rem  harness $DshPin through npx, once).",
            'rem',
            'rem  It is safe to run again: the installer skips the bundles it',
            'rem  already has at their current version and re-adds the ones',
            'rem  whose version moved. If you installed the pack already and',
            'rem  want to skip the check, run vncode.exe directly - or',
            'rem  scripts\run-desktop.bat, which finds and runs that same binary.',
            'rem',
            'rem  The console this runs in is decided by the shipped',
            'rem  scripts\console\adapt.cmd, exactly as it is for the other',
            'rem  launchers: Windows Terminal when it is there, colour only on a',
            'rem  real terminal, and the window held open only when it would',
            'rem  otherwise vanish.',
            'rem ============================================================',
            'setlocal',
            'cd /d "%~dp0"',
            'where node >nul 2>nul',
            'if errorlevel 1 (',
            '  echo [vncode] Node.js 22 or newer was not found on PATH.',
            '  echo   Install it from https://nodejs.org and run this file again.',
            '  goto :failed',
            ')',
            'if not defined VNCODE_CONSOLE set "VNCODE_ARGV=%*"',
            'call "%~dp0scripts\console\adapt.cmd" "%~f0" "vncode"',
            'if errorlevel 10 exit /b 0',
            'if errorlevel 2 (',
            '  echo [vncode] PowerShell was not found on PATH, and the installer',
            '  echo   needs it. It ships with every supported version of Windows.',
            '  goto :failed',
            ')',
            'echo [vncode] Making sure the harness web profile has this pack...',
            'rem -NoTerminal is the LAUNCHER''s flag: scripts\console\adapt.cmd already',
            'rem acted on it, it is not a flag of the installer or of vncode.exe, and',
            'rem both refuse an argument they do not declare.',
            'set "VN_SHELL_ARGS=%VNCODE_ARGS%"',
            'rem Safe with no arguments at all: scripts\console\adapt.cmd stores',
            'rem "no arguments" as one space, so VN_SHELL_ARGS is always defined.',
            'set "VN_SHELL_ARGS=%VN_SHELL_ARGS:-NoTerminal=%"',
            '"%VNCODE_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-all.ps1" %VN_SHELL_ARGS%',
            'if errorlevel 1 goto :failed',
            'echo.',
            'echo [vncode] Starting vncode. Close the window to stop it.',
            'echo.',
            'rem The shell takes -Port / -DshHome / -DshVersion / -Help and NOTHING',
            'rem else: it NAMES an unknown flag and exits 1 rather than ignoring it, so',
            'rem that a typo is never silently dropped. -NoPause is this launcher''s own',
            'rem flag (-NoTerminal is already gone above), and scripts\run-desktop.bat',
            'rem drops the same set before the shell sees it.',
            'set "VN_APP_ARGS=%VN_SHELL_ARGS%"',
            'set "VN_APP_ARGS=%VN_APP_ARGS:-NoPause=%"',
            '"%~dp0vncode.exe" %VN_APP_ARGS%',
            'if errorlevel 1 goto :failed',
            'exit /b 0',
            ':failed',
            'echo.',
            'echo ============================================================',
            'echo  vncode FAILED - see the messages above.',
            'echo ============================================================',
            'echo.',
            'if "%VNCODE_PAUSE%"=="1" pause',
            'exit /b 1'
        )
        Write-TextFile -Path (Join-Path $DistDir 'START-HERE.bat') -Lines $lines -Newline "`r`n"
        return
    }

    $lines = @(
        '#!/bin/sh',
        '# ============================================================',
        '#  vncode - START HERE',
        '#  Generated by scripts/dist.sh - do not edit; re-run the',
        '#  distributer in the source repository to change it.',
        '#',
        '#  Run it:  ./START-HERE.sh',
        '#  It makes sure the DeepSeek Harness web profile has this pack',
        '#  installed from THIS folder, then opens vncode in its own',
        '#  window.',
        '#',
        '#  Requirements: Node.js 22 or newer on PATH, and network access',
        '#  on the first run (the shell downloads the pinned harness',
        "#  $DshPin through npx, once).",
        '#',
        '#  It is safe to run again: the installer skips the bundles it',
        '#  already has at their current version and re-adds the ones',
        '#  whose version moved. If you installed the pack already and',
        '#  want to skip the check, run ./vncode directly.',
        '#',
        '#  The colour decision and the window rule come from the shipped',
        '#  scripts/console/theme.sh, exactly as they do for the other',
        '#  launchers: colour only on a real terminal, never in a',
        '#  redirected log, and the window held open only when it would',
        '#  otherwise vanish.',
        '# ============================================================',
        'set -u',
        'dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
        'cd "$dir" || exit 1',
        '. ./scripts/console/theme.sh',
        'command -v node >/dev/null 2>&1 || {',
        '  vn_fail "Node.js 22 or newer is required - https://nodejs.org"',
        '  vn_pause',
        '  exit 1',
        '}',
        'vn_step "Making sure the harness web profile has this pack..."',
        'sh ./scripts/install-all.sh "$@" || {',
        '  vn_fail "install FAILED - see the messages above."',
        '  vn_pause',
        '  exit 1',
        '}',
        'vn_step "Starting vncode. Close the window to stop it."',
        'exec ./vncode "$@"'
    )
    $target = Join-Path $DistDir 'START-HERE.sh'
    Write-TextFile -Path $target -Lines $lines -Newline "`n"
    try { & chmod 755 $target | Out-Null } catch { }
}

function New-DistReadme {
    param([string]$DistDir, [string]$Version, [string]$DshPin, [string]$Rid, [string]$BuiltAt, [string]$Commit,
          [switch]$NoShell)
    # The two shapes this README describes differ in ONE fact - whether a built
    # shell is in the folder - and a source-only release must not tell its reader
    # to double-click a vncode.exe that is not there. So the paragraphs that
    # mention the binary are chosen rather than left to contradict the folder.
    $oneFile = @(
        'TWO WAYS TO GET THIS',
        '  If you were handed ONE file - vncode-<version>-<rid>.exe on',
        '  Windows, vncode-<version>-<rid>.run on macOS and Linux - just run',
        '  it. That file IS this folder: it unpacks itself into your own user',
        '  data folder (<local app data>/vncode/<version>-<rid>, so the live',
        '  links the pack installs have somewhere permanent to point) and then',
        '  does everything CLICK THIS describes. You never handle the files.',
        '',
        '  If you have this folder, or the .zip, use CLICK THIS instead. Either',
        '  way the result is the same: the pack is installed into the harness web',
        '  profile and the window opens.',
        ''
    )
    $sourceOnly = @(
        'WHAT YOU WERE GIVEN',
        '  This is a SOURCE release: nothing in it is compiled, and nothing has to',
        '  be compiled to use it. It is the vncode repository itself - the plugin',
        '  pack plus the launchers - so the whole thing is plain readable',
        '  JavaScript. The one thing NOT in it is a built vncode.exe: the native',
        '  window is built from the app/src-tauri source that ships beside it, by',
        '  anyone who wants it, with the Rust toolchain.',
        '',
        '  Use CLICK THIS below. It installs the pack into the harness web profile',
        '  and opens the same application in a browser tab, which needs nothing but',
        '  Node.js.',
        ''
    )
    $windowBinary = @(
        '  The window is a LAUNCHER: vncode.exe (./vncode on macOS and',
        '  Linux) starts the pinned harness',
        '',
        "      npx @deepseek-ai/dsh@$DshPin web --no-open",
        '',
        '  on a free loopback port, reads the ready line it prints once the',
        '  server is listening, and shows THAT url in a WebView2 / WKWebView /',
        '  WebKitGTK window. The plugins are not compiled into the binary - the',
        '  harness web profile installs every bundle in packages/ as a LIVE LINK,',
        '  which is why this folder must stay where it is.',
        ''
    )
    $windowBrowser = @(
        '  There is no window binary here, and none is needed: scripts/run-web',
        '  starts the pinned harness',
        '',
        "      npx @deepseek-ai/dsh@$DshPin web --no-open",
        '',
        '  on a free loopback port, reads the ready line it prints once the server',
        '  is listening, and opens THAT url in your browser. The plugins are not',
        '  compiled into anything - the harness web profile installs every bundle',
        '  in packages/ as a LIVE LINK, which is why this folder must stay where it',
        '  is. To get the native window instead, build it from the shipped source:',
        '',
        '      cd app/src-tauri && cargo build --release',
        '',
        '  then copy the binary beside this README as vncode.exe (Windows) or',
        '  ./vncode (macOS/Linux) and run scripts/run-desktop.bat.',
        ''
    )
    $launcherBinary = @(
        '  vncode.exe | ./vncode    the app in its native window',
        '  scripts\run-desktop.bat  the same, started from a console - and it',
        '                           needs no Rust, because it runs the binary in',
        '                           the folder ABOVE scripts/',
        '  scripts\run-web.bat | ./scripts/run-web.sh',
        '                           the app in a browser tab instead',
        '  scripts\install.bat | ./scripts/install.sh',
        '                           install/re-install the pack, no window',
        '  scripts\uninstall.bat | ./scripts/uninstall.sh',
        '                           remove what this pack installed',
        ''
    )
    $launcherSource = @(
        '  START-HERE.bat | ./START-HERE.sh',
        '                           install the pack, then open the app',
        '  scripts\run-web.bat | ./scripts/run-web.sh',
        '                           the same, in a browser tab, any time after',
        '  scripts\run-desktop.bat  the native window - builds app/src-tauri with',
        '                           cargo the first time, then runs it',
        '  scripts\install.bat | ./scripts/install.sh',
        '                           install/re-install the pack, no window',
        '  scripts\uninstall.bat | ./scripts/uninstall.sh',
        '                           remove what this pack installed',
        ''
    )
    $firstRun = @(
        '  Both install this pack into the harness web profile (from THIS',
        '  folder, wherever it now is) and then open the window. Already',
        '  installed? Run vncode.exe (./vncode) and skip the check.',
        ''
    )
    $firstRunSource = @(
        '  Both install this pack into the harness web profile (from THIS',
        '  folder, wherever it now is) and then open the app. Already installed?',
        '  Run scripts/run-web.bat (./scripts/run-web.sh) and skip the check.',
        ''
    )
    $noShellNote = @(
        'BUILDING THE NATIVE WINDOW (OPTIONAL)',
        '  The only thing this release does not carry ready-made is the window',
        '  binary - and compiling it is a choice, not a requirement, because the',
        '  browser path above is the same application. If you want the window:',
        '',
        '      cd app/src-tauri && cargo build --release',
        '',
        '  which needs the Rust toolchain (https://rustup.rs) and, on Linux, the',
        '  WebKitGTK development packages. The result lands in',
        '  app/src-tauri/target/release/ as vncode-desktop (vncode-desktop.exe on',
        '  Windows); copy it beside this README as vncode (vncode.exe) and',
        '  scripts/run-desktop.bat will run it instead of building again.',
        ''
    )
    $lines = @(
        "vncode $Version - $Rid",
        "Built $BuiltAt from commit $Commit.",
        ''
    ) + $(if ($NoShell) { $sourceOnly } else { $oneFile }) + @(
        'WHAT THIS IS',
        '  vncode - an agent application that runs on the DeepSeek Harness',
        '  (DSH). A native cross-platform app plus a pack of standard dsh',
        '  bundles: the plugins are plain JavaScript with ZERO npm dependencies,',
        '  and the launchers run on Windows, macOS and Linux.',
        ''
    ) + $(if ($NoShell) { $windowBrowser } else { $windowBinary }) + @(
        'WHAT THE AGENT CAN DO',
        '  Every surface below comes from this pack (all alpha), and it opens the',
        '  files that are in the conversation workspace:',
        '',
        '  - Files / Editor ....... text and code tabs (CodeMirror 6), a rendered',
        '                           Markdown preview, and create/save',
        '  - History .............. the git commits of the workspace - read-only',
        '  - Images ............... fit, zoom and pan, plus the source pixel and',
        '                           its colour under the pointer',
        '  - Audio ................ a waveform: WAV/AIFF/FLAC, one track per',
        '                           channel, dBFS, selection and playback',
        '  - Diagrams ............. Mermaid and TikZ as tabs AND as agent tools,',
        '                           every diagram validated before it is stored',
        '  - PDF .................. read, search and SCAN documents (OCR), with a',
        '                           reader tab carrying thumbnails and bookmarks',
        '  - Terminal ............. a real shell in a bottom dock',
        '  - Themes / zoom / shot . header controls, incl. Nord, Monokai, Hacker',
        '',
        'REQUIREMENTS',
        '  - Node.js 22 or newer on PATH .......... https://nodejs.org',
        '  - Network access on the first run ...... the pinned harness',
        "    $DshPin is fetched through npx, once (it is cached",
        '    afterwards).',
        '  - Windows: the WebView2 runtime (present on Windows 10 and 11).',
        '  - macOS/Linux: nothing beyond Node.js.',
        '',
        'CLICK THIS',
        '  Windows:      START-HERE.bat',
        '  macOS/Linux:  ./START-HERE.sh',
        ''
    ) + $(if ($NoShell) { $firstRunSource } else { $firstRun }) + @(
        '  The app shows the SAME profile a scripts/run-web.bat or a',
        '  ./scripts/run-web.sh browser tab shows, so sessions, settings and',
        '  everything the pack remembers are shared with it.',
        '',
        'THE LAUNCHERS',
        '  Every launcher lives in scripts/; the repository root carries none.',
        ''
    ) + $(if ($NoShell) { $launcherSource } else { $launcherBinary }) + @(
        '  All of them take -Help (also -h and /?), -NoPause and -NoTerminal, and',
        '  all of them decide their console in ONE shared place (scripts/console/):',
        '  a double-click opens in Windows Terminal when it is installed, colour',
        '  appears only on a real terminal and never in a redirected log, and the',
        '  launch token is never written down.',
        '',
        '  The launch token in the ready line is a live credential for the',
        '  running process: whoever reads that line holds a login for it. The',
        '  launchers print the line with the token REDACTED, hold the real one in',
        '  memory only, and refuse to open a url that is not a loopback address.',
        ''
    ) + $(if ($NoShell) { $noShellNote } else { @() }) + @(
        'BUILDING ANOTHER COPY',
        '  This folder is the product, not the workshop: run-dist.bat is',
        '  deliberately NOT here. A distribution is assembled in the repository it',
        '  came from (scripts/dist-manifest.txt lists exactly what ships).',
        '',
        'VERIFY THIS COPY',
        '  SHA256SUMS.txt holds the SHA-256 of every file beside it.',
        '      Windows:        Get-FileHash (or certutil -hashfile <file> SHA256)',
        '      macOS/Linux:    sha256sum -c SHA256SUMS.txt  (shasum -a 256 -c)',
        '  BUILD-INFO.json records the pack version, the harness pin, the commit',
        '  it was built from and the toolchain that built it.',
        '',
        'UNINSTALL',
        '  Windows:      scripts\uninstall.bat',
        '  macOS/Linux:  ./scripts/uninstall.sh',
        '  Both remove only what this pack installed; your sessions and settings',
        '  are untouched. Deleting this folder afterwards is the rest of it.'
    )
    Write-TextFile -Path (Join-Path $DistDir 'DIST-README.txt') -Lines $lines -Newline "`n"
}

# One flat JSON object, written with an explicit key order so the Windows and
# the POSIX half produce the same document for the same facts.
function New-BuildInfo {
    param([string]$DistDir, [string]$Version, [string]$DshPin, [string]$Rid, [string]$Artifact,
        [string]$Commit, [bool]$Dirty, [string]$BuiltAt, [string]$Builder, [string]$Rustc,
        [string]$Node, [int]$PayloadFiles, [long]$PayloadBytes, [string]$ShellSha,
        [string]$TargetOs, [switch]$NoShell)
    # `shell` is the field a reader uses to tell the two shapes apart, and it is
    # written rather than inferred: a source-only release has no binary, so
    # saying "vncode.exe" there would be a claim the folder cannot honour.
    #
    # `platform` stays the HOST that assembled this folder and `targetOs` is the
    # operating system the artifact is published FOR. In a release they differ on
    # purpose - one assembly is published as the win, mac and linux archives - and
    # recording both is what keeps that honest instead of confusing the two.
    $shellKind = 'binary'
    $shellBinaryName = $script:BinaryName
    if ($NoShell) {
        $shellKind = 'source'
        $shellBinaryName = ''
    }
    $lines = @(
        '{',
        "  `"name`": `"vncode`",",
        "  `"packVersion`": `"$Version`",",
        "  `"artifact`": `"$Artifact`",",
        "  `"dshPin`": `"$DshPin`",",
        "  `"rid`": `"$Rid`",",
        "  `"platform`": `"$script:Platform`",",
        "  `"targetOs`": `"$TargetOs`",",
        "  `"arch`": `"$($Rid.Split('-')[-1])`",",
        "  `"commit`": `"$Commit`",",
        "  `"dirty`": $(if ($Dirty) { 'true' } else { 'false' }),",
        "  `"builtAt`": `"$BuiltAt`",",
        "  `"builtBy`": `"$Builder`",",
        "  `"rustc`": `"$Rustc`",",
        "  `"node`": `"$Node`",",
        "  `"shell`": `"$shellKind`",",
        "  `"shellBinary`": `"$shellBinaryName`",",
        "  `"shellSha256`": `"$ShellSha`",",
        "  `"payloadFiles`": $PayloadFiles,",
        "  `"payloadBytes`": $PayloadBytes",
        '}'
    )
    Write-TextFile -Path (Join-Path $DistDir 'BUILD-INFO.json') -Lines $lines -Newline "`n"
}

function New-Sums {
    param([string]$DistDir)
    $lines = New-Object System.Collections.ArrayList
    foreach ($item in (Get-ChildItem -LiteralPath $DistDir -Recurse -File -Force | Sort-Object FullName)) {
        $rel = $item.FullName.Substring($DistDir.Length).TrimStart('\', '/').Replace('\', '/')
        if ($rel -eq 'SHA256SUMS.txt') { continue }
        [void]$lines.Add("$(Get-Sha256 -Path $item.FullName)  $rel")
    }
    Write-TextFile -Path (Join-Path $DistDir 'SHA256SUMS.txt') -Lines ([string[]]$lines) -Newline "`n"
    return $lines.Count
}

# Forward slashes in the entry names, and the top folder inside the archive, so
# extracting the zip makes one folder and never a puddle of files.
function New-ZipArchive {
    param([string]$SourceDir, [string]$ZipPath, [string]$RootName)
    if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
    # Two assemblies on Windows PowerShell 5.1: ZipFile lives in
    # System.IO.Compression.FileSystem, ZipArchiveMode in System.IO.Compression
    # (on PowerShell 7 the type is already loaded and both are no-ops).
    try { Add-Type -AssemblyName System.IO.Compression } catch { }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $prefix = "$RootName/"
        foreach ($file in (Get-ChildItem -LiteralPath $SourceDir -Recurse -File -Force | Sort-Object FullName)) {
            $rel = $file.FullName.Substring($SourceDir.Length).TrimStart('\', '/').Replace('\', '/')
            $entry = $archive.CreateEntry($prefix + $rel, [System.IO.Compression.CompressionLevel]::Optimal)
            try { $entry.LastWriteTime = [System.DateTimeOffset]$file.LastWriteTime } catch { }
            $target = $entry.Open()
            try {
                $source = [System.IO.File]::OpenRead($file.FullName)
                try { $source.CopyTo($target) } finally { $source.Dispose() }
            }
            finally { $target.Dispose() }
        }
    }
    finally { $archive.Dispose() }
}

# ---------------------------------------------------------------------------
# The single-file build
# ---------------------------------------------------------------------------
<#
    Append the distribution zip - and a trailer describing it - to a copy of the
    shell binary, so the whole distribution is ONE file to hand somebody.

    This cannot replace the folder, and does not try to: the web profile
    installs every bundle as a LIVE LINK into packages/, so the payload has to
    exist as a real directory somewhere the user will not move. The single-file
    build therefore unpacks itself into a stable per-user directory on its first
    run (src/payload.rs decides where and does the unpacking) and then runs that
    folder's own START-HERE, exactly as if the folder had been extracted by hand.

    THE LAYOUT IS A CONTRACT WITH src/payload.rs - change one half and the other
    stops working, which the tests there will not catch and the verify step will:

        [ the shell binary          ]
        [ the distribution zip      ]   zipStart, zipLen
        [ trailer JSON, utf-8       ]   its own byte length
        [ that length as u64 LE     ]
        [ "VNHRNS01"                ]   the last 8 bytes of the file

    The trailer is what makes the payload findable without a signature scan: the
    shell's own bytes can contain anything at all, this repository's zip
    included. The ONLY thing that decides whether a file is a single-file build
    is that magic in its last eight bytes.
#>
function New-StandaloneExecutable {
    param([string]$Binary, [string]$ZipPath, [string]$OutPath, [string]$Version, [string]$Rid)
    if (Test-Path -LiteralPath $OutPath) {
        try { Remove-Item -LiteralPath $OutPath -Force }
        catch {
            throw "Could not replace $OutPath ($($_.Exception.Message)). The single-file build that is RUNNING holds itself open - close the vncode window it started and run this again."
        }
    }

    $shell = [System.IO.File]::ReadAllBytes($Binary)
    $start = [int64]$shell.Length
    $length = [int64](Get-Item -LiteralPath $ZipPath).Length
    $json = '{"version":"' + $Version + '","rid":"' + $Rid + '","zipStart":' + $start + ',"zipLen":' + $length + '}'
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $magic = [System.Text.Encoding]::ASCII.GetBytes('VNHRNS01')
    # Little-endian, and written byte by byte rather than with BitConverter,
    # which follows the machine: the reader is little-endian by definition and
    # this script has to produce the same bytes whichever host runs it.
    $tail = New-Object byte[] 8
    $size = [uint64]$bytes.Length
    for ($i = 0; $i -lt 8; $i++) { $tail[$i] = [byte](($size -shr (8 * $i)) -band 0xFF) }

    # ONE handle, opened once and held to the end. Copying the binary and then
    # REOPENING it to append is the obvious shape and the one that failed here:
    # the close between those two steps is a window in which a virus scanner
    # takes a freshly written 8 MB .exe, and the reopen then dies with "being
    # used by another process".
    $target = [System.IO.File]::Open($OutPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
    try {
        $target.Write($shell, 0, $shell.Length)
        $source = [System.IO.File]::OpenRead($ZipPath)
        try { $source.CopyTo($target) }
        finally { $source.Dispose() }
        $written = $target.Position - $start
        if ($written -ne $length) {
            throw "Copied $written bytes of a $length byte payload into the single-file build."
        }
        $target.Write($bytes, 0, $bytes.Length)
        $target.Write($tail, 0, $tail.Length)
        $target.Write($magic, 0, $magic.Length)
    }
    finally { $target.Dispose() }

    if (-not $script:IsWindowsHost) { try { & chmod 755 $OutPath | Out-Null } catch { } }

    # What was written is exactly as long as its three parts say it should be. A
    # short write would otherwise only show up as "not a payload" on a user's
    # machine, where nothing can be done about it.
    $expected = $start + $length + $bytes.Length + 16
    $actual = (Get-Item -LiteralPath $OutPath).Length
    if ($actual -ne $expected) {
        throw "The single-file build is $actual bytes, not the $expected its parts add up to."
    }
}

# ---------------------------------------------------------------------------
# The ready line, and the two rules that are load-bearing
# ---------------------------------------------------------------------------
<#
    The harness prints one ready line, on stdout, once the server is listening:

        dsh web: http://127.0.0.1:3080/?token=<token> (LAN: http://<ip>:<port>/?token=<token>)

    ANSI colour codes are stripped first (a profile can colour its own console
    output) and only a line naming `dsh web:` is considered, so no unrelated url
    is ever mistaken for it. This is the same reader scripts/run-web.ps1 uses.
#>
function Get-ReadyUrl {
    param([string]$Text)
    if (-not $Text) { return $null }
    $clean = [regex]::Replace($Text, ([string][char]27 + '\[[0-9;]*[A-Za-z]'), '')
    if ($clean.IndexOf('dsh web:') -lt 0) { return $null }
    $match = [regex]::Match($clean, 'https?://[^\s"'']+')
    if (-not $match.Success) { return $null }
    return $match.Value.TrimEnd('.', ',', ')', ']', '"', "'")
}

function Test-LoopbackUrl {
    param([string]$Url)
    try { $uri = [System.Uri]$Url } catch { return $false }
    if ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https') { return $false }
    if ($uri.Host -eq 'localhost') { return $true }
    $address = $null
    if ([System.Net.IPAddress]::TryParse($uri.Host, [ref]$address)) {
        return [System.Net.IPAddress]::IsLoopback($address)
    }
    return $false
}

# The token is a live credential: it is replaced wherever this script prints a
# ready line, so a scrollback buffer or a CI log never holds one.
function Get-Redacted {
    param([string]$Text)
    if (-not $Text) { return '' }
    return [regex]::Replace($Text, 'token=[^\s&"'']*', 'token=REDACTED')
}

function Get-FreePort {
    $listener = New-Object -TypeName System.Net.Sockets.TcpListener -ArgumentList @([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    return $port
}

function Test-PortFree {
    param([int]$Port)
    try {
        $listener = New-Object -TypeName System.Net.Sockets.TcpListener -ArgumentList @([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        $listener.Stop()
        return $true
    }
    catch { return $false }
}

# ---------------------------------------------------------------------------
# -Verify: install this distribution into a throwaway home and boot it
# ---------------------------------------------------------------------------
<#
    The one check that proves the FOLDER works rather than the build: it runs the
    distribution's own installer against a temporary DSH_HOME, asserts the
    profile now lists every bundle the folder carries, then starts the pinned
    harness with that home and waits for the ready line. It never opens a window
    (a CI runner has no screen) - the window is what `-Run` is for - so this is
    the same check a local run and the workflow can both afford.
#>
function Invoke-Verify {
    param([string]$DistDir, [string]$DshPin)

    # The distribution's OWN installer, in the host's own flavour: verifying the
    # other half's installer would prove nothing about this folder.
    $installerName = 'install-all.ps1'
    if (-not $script:IsWindowsHost) { $installerName = 'install-all.sh' }

    $tempHome = Join-Path ([System.IO.Path]::GetTempPath()) ('vncode-dist-verify-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $tempHome | Out-Null
    Write-Step "Verify: throwaway DSH_HOME $tempHome"

    <#
        The check runs against a COPY of the distribution, and that is the point:
        a distribution is a folder somebody extracts somewhere else, so a copy in
        a temp folder is exactly the thing being promised. It also keeps the real
        folder pristine - the installer bootstraps its own pnpm under a LOCAL
        tools/ when the machine has none, and running it in place would leave
        that tree inside the distribution after the archive was already made.
    #>
    $probe = Join-Path $tempHome 'distribution'
    Copy-Item -LiteralPath $DistDir -Destination $probe -Recurse -Force
    Write-Step 'Verify: copied the distribution to a temp folder (as if it had been moved).'

    $installer = Join-Path $probe (Join-Path 'scripts' $installerName)
    if (-not (Test-Path -LiteralPath $installer)) { throw "The distribution has no scripts/$installerName in it." }

    $savedHome = $env:DSH_HOME
    try {
        Write-Step 'Verify: installing the distribution into that home...'
        # A native command writing to stderr becomes a terminating
        # NativeCommandError under 'Stop' - and the installer drives npx, which
        # reports progress on stderr. Judged by its exit code alone, exactly as
        # scripts/run-web.ps1 does around the same call.
        $previousEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            if ($script:IsWindowsHost) {
                & powershell -NoProfile -ExecutionPolicy Bypass -File $installer -DshHome $tempHome
            }
            else {
                & sh $installer -DshHome $tempHome
            }
            $installExit = $LASTEXITCODE
        }
        finally { $ErrorActionPreference = $previousEap }
        if ($installExit -ne 0) { throw "The distribution's installer exited with code $installExit." }

        $profileManifest = Join-Path (Join-Path (Join-Path $tempHome 'profiles') 'web') 'package.json'
        if (-not (Test-Path -LiteralPath $profileManifest)) { throw "The installer did not create a web profile at $profileManifest." }
        $profile = Get-Content -LiteralPath $profileManifest -Raw | ConvertFrom-Json
        $installed = @($profile.dsh.profile.bundles)
        $missing = New-Object System.Collections.ArrayList
        foreach ($bundle in (Get-DistBundleNames -DistDir $DistDir)) {
            if ($installed -notcontains $bundle) { [void]$missing.Add($bundle) }
        }
        if ($missing.Count -gt 0) {
            throw "The profile did not end up listing: $($missing -join ', ')."
        }
        Write-Step "Verify: the profile lists all $(@(Get-DistBundleNames -DistDir $DistDir).Count) bundles this folder carries."

        Assert-Tool 'node' | Out-Null
        $npx = Get-ToolPath -Names (Get-ToolNames -Name 'npx')
        if (-not $npx) { throw 'npx was not found on PATH.' }

        $port = Get-FreePort
        $log = Join-Path $tempHome 'boot.log'
        $err = Join-Path $tempHome 'boot.err'
        $spec = "@deepseek-ai/dsh@$DshPin"
        Write-Step "Verify: booting the pinned harness from the distribution (port $port)..."

        $env:DSH_HOME = $tempHome
        $arguments = @('--yes', $spec, 'web', '--no-open', '--port', [string]$port)
        $process = Start-Process -FilePath $npx -ArgumentList $arguments -RedirectStandardOutput $log -RedirectStandardError $err -PassThru -NoNewWindow

        $deadline = (Get-Date).AddSeconds(180)
        $ready = $null
        while ((Get-Date) -lt $deadline) {
            if (Test-Path -LiteralPath $log) {
                $text = Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
                $ready = Get-ReadyUrl -Text $text
                if ($ready) { break }
            }
            $process.Refresh()
            if ($process.HasExited) { break }
            Start-Sleep -Milliseconds 750
        }

        try {
            if ($script:IsWindowsHost) { & taskkill /PID $process.Id /T /F 2>$null | Out-Null }
            else { & kill -TERM $process.Id 2>$null | Out-Null }
            Start-Sleep -Milliseconds 700
            try { $process.Kill() } catch { }
        }
        catch { }        # The window is gone; make sure nothing is still holding the port, or a
        # CI runner would carry a listening server into the next step.
        $free = $false
        for ($i = 0; $i -lt 20; $i++) {
            if (Test-PortFree -Port $port) { $free = $true; break }
            if ($script:IsWindowsHost) {
                try {
                    foreach ($owner in (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
                        & taskkill /PID $owner.OwningProcess /T /F 2>$null | Out-Null
                    }
                }
                catch { }
            }
            Start-Sleep -Milliseconds 500
        }

        if (-not $ready) {
            Write-Host ''
            Write-Step 'Verify FAILED: no "dsh web:" ready line within 180 seconds.'
            if (Test-Path -LiteralPath $log) {
                $tail = Get-Content -LiteralPath $log -Tail 20 -ErrorAction SilentlyContinue
                if ($tail) { Write-Note (Get-Redacted ($tail -join "`n")) }
            }
            if (Test-Path -LiteralPath $err) {
                $tail = Get-Content -LiteralPath $err -Tail 20 -ErrorAction SilentlyContinue
                if ($tail) { Write-Note (Get-Redacted ($tail -join "`n")) }
            }
            throw 'The distribution never became ready.'
        }

        if (-not (Test-LoopbackUrl -Url $ready)) {
            throw "The ready line did not name a loopback address (refused rather than trusted): $(Get-Redacted $ready)"
        }
        $uri = [System.Uri]$ready
        Write-Step "Verify PASSED: the distribution booted and answered at $($uri.Scheme)://$($uri.Host):$($uri.Port)/?token=REDACTED"
        Write-Note "The harness served the web profile installed from this folder."
        if (-not $free) {
            Write-Note "Warning: 127.0.0.1:$port was still listening after the stop; check for a stray node process."
        }
    }
    finally {
        if ($null -eq $savedHome) { Remove-Item Env:\DSH_HOME -ErrorAction SilentlyContinue }
        else { $env:DSH_HOME = $savedHome }
        if ($KeepVerifyHome) {
            Write-Note "Kept the throwaway home: $tempHome"
        }
        else {
            Remove-Item -LiteralPath $tempHome -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# ---------------------------------------------------------------------------
# The build fingerprint - the cache that makes a second run cheap
# ---------------------------------------------------------------------------
<#
    WHY THIS EXISTS
    ---------------
    Assembling a distribution copies roughly a hundred megabytes, hashes every
    file and zips the result. Doing that when NOTHING changed is the difference
    between a distributer the maintainer runs on every edit and one they avoid -
    and `scripts\run-dist.bat` is the entry point that is meant to be run on
    every edit, precisely so the app is exercised the way a recipient gets it.

    WHAT IT IS KEYED ON, AND WHY THAT IS THE WHOLE LIST
    ---------------------------------------------------
    A fingerprint is compared ONLY when every input that decides what the folder
    would contain is identical:

      version, rid, platform       the names and the paths inside it
      dshPin                       written into START-HERE and DIST-README
      shellSha256                  an input directory, not build output
      manifestSha256               the ship list, byte for byte
      commit, dirty                recorded in BUILD-INFO.json
      files                        the tree the PREVIOUS run hashed, each with
                                   its own sha256 and byte length

    That last line is what makes this a cache rather than a guess. The
    fingerprint does not merely assert "I built something once"; it carries the
    listing - path, hash and size for every shipped file - and it is trusted
    only when the tree ON DISK still matches that listing exactly, in both
    directions: nothing listed has been changed, and nothing exists that is not
    listed. A rebuilt or edited plugin has a different sha256, so the whole
    fingerprint misses. A stray file is not in the listing, so it misses too.

    So the cached answer and the slower answer are computed from the same bytes.
    When they disagree the copy happens, which is the safe direction.

    The generated files - START-HERE, DIST-README.txt, BUILD-INFO.json,
    SHA256SUMS.txt - are deliberately NOT part of the listing: they are written
    on every run from the fingerprint's own facts, so they are always current,
    and the zip beside the folder is rebuilt from them.
#>
function Get-DistFingerprint {
    param([string]$DistDir)
    $file = Join-Path $DistDir '.vncode-fingerprint.json'
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    try {
        $text = Get-Content -LiteralPath $file -Raw
        if (-not $text) { return $null }
        return ($text | ConvertFrom-Json)
    }
    catch {
        # An unreadable or unparsable fingerprint is exactly the "cannot vouch
        # for it" case: discard it and do the work.
        return $null
    }
}

function Test-FingerprintMatches {
    param([object]$Previous, [string]$Version, [string]$Rid, [string]$DshPin, [string]$ShellSha,
          [string]$ManifestSha, [string]$Commit, [bool]$Dirty, [string]$DistDir)
    if ($null -eq $Previous) { return $false }
    if ($Previous.version -ne $Version) { return $false }
    if ($Previous.rid -ne $Rid) { return $false }
    if ($Previous.platform -ne $script:Platform) { return $false }
    if ($Previous.dshPin -ne $DshPin) { return $false }
    if ($Previous.shellSha256 -ne $ShellSha) { return $false }
    if ($Previous.manifestSha256 -ne $ManifestSha) { return $false }
    if ($Previous.commit -ne $Commit) { return $false }
    if ([bool]$Previous.dirty -ne $Dirty) { return $false }

    # The listing, checked against the tree as it stands. `recorded` is what the
    # last run hashed; `onDisk` is what is there now. Both directions matter.
    $recorded = @{}
    foreach ($entry in @($Previous.files)) {
        if (-not $entry -or -not $entry.path) { return $false }
        $recorded[[string]$entry.path] = $entry
    }
    if ($recorded.Count -eq 0) { return $false }

    $onDisk = @{}
    foreach ($item in (Get-ChildItem -LiteralPath $DistDir -Recurse -File -Force)) {
        $rel = $item.FullName.Substring($DistDir.Length).TrimStart('\', '/').Replace('\', '/')
        # Generated per run, so they are never part of the listing.
        if ($rel -eq '.vncode-fingerprint.json') { continue }
        if ($rel -eq 'SHA256SUMS.txt') { continue }
        if ($rel -eq 'BUILD-INFO.json') { continue }
        if ($rel -eq 'DIST-README.txt') { continue }
        if ($rel -eq 'START-HERE.bat') { continue }
        if ($rel -eq 'START-HERE.sh') { continue }
        $onDisk[$rel] = $item
    }

    if ($onDisk.Count -ne $recorded.Count) { return $false }
    foreach ($rel in $onDisk.Keys) {
        if (-not $recorded.ContainsKey($rel)) { return $false }
        $entry = $recorded[$rel]
        if ([int64]$entry.bytes -ne [int64]$onDisk[$rel].Length) { return $false }
        if ((Get-Sha256 -Path $onDisk[$rel].FullName) -ne [string]$entry.sha256) { return $false }
    }
    return $true
}

# One flat JSON object with an explicit key order, for the same reason
# BUILD-INFO.json is written that way: the Windows and the POSIX half have to
# produce the same document for the same facts.
function New-DistFingerprint {
    param([string]$DistDir, [string]$Version, [string]$Rid, [string]$DshPin, [string]$ShellSha,
          [string]$ManifestSha, [string]$Commit, [bool]$Dirty, [int]$PayloadFiles, [long]$PayloadBytes)
    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add('{')
    [void]$lines.Add("  `"version`": `"$Version`",")
    [void]$lines.Add("  `"rid`": `"$Rid`",")
    [void]$lines.Add("  `"platform`": `"$script:Platform`",")
    [void]$lines.Add("  `"dshPin`": `"$DshPin`",")
    [void]$lines.Add("  `"shellSha256`": `"$ShellSha`",")
    [void]$lines.Add("  `"manifestSha256`": `"$ManifestSha`",")
    [void]$lines.Add("  `"commit`": `"$Commit`",")
    [void]$lines.Add("  `"dirty`": $(if ($Dirty) { 'true' } else { 'false' }),")
    # The measured size of the payload, carried so a reused folder does not have
    # to be walked again just to report a number that cannot have changed.
    [void]$lines.Add("  `"payloadFiles`": $PayloadFiles,")
    [void]$lines.Add("  `"payloadBytes`": $PayloadBytes,")
    [void]$lines.Add('  "files": [')
    $items = @(Get-ChildItem -LiteralPath $DistDir -Recurse -File -Force |
        Where-Object { $_.Name -ne '.vncode-fingerprint.json' -and $_.Name -ne 'SHA256SUMS.txt' -and
                       $_.Name -ne 'BUILD-INFO.json' -and $_.Name -ne 'DIST-README.txt' -and
                       $_.Name -ne 'START-HERE.bat' -and $_.Name -ne 'START-HERE.sh' } |
        Sort-Object FullName)
    for ($i = 0; $i -lt $items.Count; $i++) {
        $item = $items[$i]
        $rel = $item.FullName.Substring($DistDir.Length).TrimStart('\', '/').Replace('\', '/')
        $comma = ','
        if ($i -eq $items.Count - 1) { $comma = '' }
        [void]$lines.Add("    { `"path`": `"$rel`", `"bytes`": $($item.Length), `"sha256`": `"$(Get-Sha256 -Path $item.FullName)`" }$comma")
    }
    [void]$lines.Add('  ]')
    [void]$lines.Add('}')
    Write-TextFile -Path (Join-Path $DistDir '.vncode-fingerprint.json') -Lines ([string[]]$lines) -Newline "`n"
    return $items.Count
}

# ---------------------------------------------------------------------------
# The secret-shaped names a distribution must never contain
# ---------------------------------------------------------------------------
<#
    check-no-secrets.mjs already scans the SOURCE tree and is run as a gate
    before assembly (see scripts/run-dist.ps1). This is the second half, and it
    exists because the two see different things: the check reads what `git add
    -A` would stage and SKIPS binaries, while this reads the ASSEMBLED folder -
    which is what actually ships, and which a future manifest rule could pull a
    credential-shaped file into by accident.

    It is filename-shaped on purpose. Scanning 100 MB of text here would make
    every build slower to catch what the source check already catches earlier;
    what this catches is the file that should never have been copied at all.
#>
function Assert-NoSecrets {
    param([string]$DistDir)
    $banned = @(
        '.env', '.credentials.yaml', 'credentials.json', 'credentials.yaml',
        'id_rsa', 'id_ed25519', '.netrc', '.npmrc', '.git-credentials'
    )
    $bannedSuffix = @('.pem', '.key', '.pfx', '.p12', '.keystore', '.jks')
    $hits = New-Object System.Collections.ArrayList
    foreach ($item in (Get-ChildItem -LiteralPath $DistDir -Recurse -File -Force)) {
        $name = $item.Name.ToLowerInvariant()
        if ($banned -contains $name) { [void]$hits.Add($item.FullName.Substring($DistDir.Length).TrimStart('\', '/')) ; continue }
        foreach ($suffix in $bannedSuffix) {
            if ($name.EndsWith($suffix)) { [void]$hits.Add($item.FullName.Substring($DistDir.Length).TrimStart('\', '/')) ; break }
        }
    }
    if ($hits.Count -gt 0) {
        throw "The assembled distribution contains credential-shaped file(s): $($hits -join ', '). Nothing is being shipped; fix scripts/dist-manifest.txt."
    }
}

# ===========================================================================
# main
# ===========================================================================
if ($Help) { Show-Usage; exit 0 }

Write-Step 'vncode distributer (build a distribution folder)'
Write-Step "Platform: $script:Platform (PowerShell $($PSVersionTable.PSVersion))"
Write-Step "Repo: $script:RepoRoot"

$pin = Get-DshPin
$packVersion = $Version
if (-not $packVersion) { $packVersion = Get-PackVersion }
# The host's own architecture label, recorded in BUILD-INFO.json so a reader can
# always tell which machine assembled the folder.
$hostRid = Get-HostRid
$hostOs = Get-HostOsFamily
# The OS the ARTIFACT is for - the host's own unless -TargetOs named another.
$artifactOs = $hostOs
if ($TargetOs) {
    $wanted = $TargetOs.Trim().ToLowerInvariant()
    # Accept the three spellings a person actually types, and nothing else: a
    # typo must not silently produce a fourth artifact nobody downloads.
    if ($wanted -eq 'windows') { $wanted = 'win' }
    if ($wanted -eq 'macos' -or $wanted -eq 'darwin' -or $wanted -eq 'osx') { $wanted = 'mac' }
    if ($wanted -notin @('win', 'mac', 'linux')) {
        throw "-TargetOs '$TargetOs' is not one of win, mac or linux."
    }
    if (-not $NoShell) {
        # A compiled shell is built FOR the host it was compiled on; labelling it
        # as another OS would be a lie a recipient would discover by running it.
        throw "-TargetOs only makes sense with -NoShell. A built shell is platform-specific, so it can only be labelled as the host that built it ($hostRid)."
    }
    $artifactOs = $wanted
}
# The label in the ARTIFACT NAME. -NoShell ships no compiled file at all, so
# there is no architecture in the payload to tell two downloads apart: the name
# says which operating system it is for and nothing else, which is what makes
# one assembly the thing all three OS releases download. The fingerprint uses
# the same label, so re-running the release for a second OS reuses the assembled
# folder rather than copying 12 MB again.
$rid = $hostRid
if ($NoShell) { $rid = $artifactOs }
$artifact = "vncode-$packVersion-$rid"
# The output root. `dist/` unless -OutDir chose somewhere else, and the reason it
# exists is not tidiness: a distribution that is RUNNING holds its own
# vncode.exe open, and Windows will not let that file be overwritten or
# deleted - so the folder this script is being read from cannot also be the
# folder it assembles into. A relative -OutDir resolves against the repository
# root, so `-OutDir dist2` means `<repo>/dist2`.
$distRoot = Join-Path $script:RepoRoot 'dist'
if ($OutDir) {
    $distRoot = $OutDir
    if (-not [System.IO.Path]::IsPathRooted($distRoot)) { $distRoot = Join-Path $script:RepoRoot $distRoot }
}
$distRoot = [System.IO.Path]::GetFullPath($distRoot)
$distDir = Join-Path $distRoot $artifact
$zipPath = Join-Path $distRoot "$artifact.zip"
$oneFilePath = Join-Path $distRoot ($artifact + $script:OneFileSuffix)

Write-Step "Pack version: $packVersion   Harness pin: $pin   Target: $rid"

if ($Clean -and (Test-Path -LiteralPath $distRoot)) {
    Write-Step "Cleaning $distRoot ..."
    Remove-Item -LiteralPath $distRoot -Recurse -Force
}

# --- 1. the shell binary ---------------------------------------------------
# In -NoShell mode there is no step 1 at all: nothing is compiled, nothing is
# copied in, and what the folder carries instead is the shell's SOURCE, brought
# in by scripts/dist-manifest.txt like any other shipped file. This is the whole
# of "a release compiles nothing". $shellSha256 stays EMPTY rather than absent,
# so the fingerprint and BUILD-INFO.json keep one shape across both modes - and
# an empty hash can never collide with a real one, so a folder built one way is
# never reused as the other.
$binary = Join-Path $script:RepoRoot (Join-Path 'app/src-tauri' (Join-Path 'target/release' $script:CargoBinaryName))
$shellSha = ''
if ($NoShell) {
    Write-Step 'Source-only build (-NoShell): nothing is compiled and app/ ships as source.'
    if ($SkipBuild) { Write-Note '-SkipBuild means nothing here; -NoShell already builds no binary.' }
}
else {
    if (-not $SkipBuild) {
        $cargo = Get-Command cargo -ErrorAction SilentlyContinue
        if (-not $cargo) {
            throw 'cargo was not found on PATH. Install the Rust toolchain from https://rustup.rs, or pass -SkipBuild to reuse an existing build - or -NoShell for a source-only release, which compiles nothing at all.'
        }
        Write-Step 'Building app/src-tauri (cargo does nothing when it is current)...'
        $manifest = Join-Path $script:RepoRoot 'app/src-tauri/Cargo.toml'
        & cargo build --release --manifest-path $manifest
        if ($LASTEXITCODE -ne 0) {
            # The failure a person actually hits: Windows locks a RUNNING binary, so
            # a window that is open makes cargo's relink fail with a bare "Access is
            # denied" that names the .exe and nothing else. Say what it means.
            $running = @(Get-Process -Name 'vncode-desktop' -ErrorAction SilentlyContinue)
            if ($running.Count -gt 0) {
                $pids = ($running | ForEach-Object { $_.Id }) -join ', '
                throw "cargo build failed (exit $LASTEXITCODE), and vncode is RUNNING right now (PID $pids). Windows does not let a build replace a binary that is in use, which is what 'Access is denied' on vncode-desktop.exe means. Close the vncode window and run this again, or pass -SkipBuild to package the binary already under app/src-tauri/target/release."
            }
            throw "cargo build failed (exit $LASTEXITCODE) - see the errors above."
        }
    }
    else {
        Write-Step 'Skipping the build (-SkipBuild).'
    }
    if (-not (Test-Path -LiteralPath $binary)) {
        throw "The shell binary is not at $binary. Drop -SkipBuild so it gets built."
    }
    $shellSha = Get-Sha256 -Path $binary
    Write-Step "Shell binary: $binary ($([math]::Round((Get-Item -LiteralPath $binary).Length / 1MB, 1)) MB)"
}

# --- 2. the payload --------------------------------------------------------
# The facts that decide what the folder WOULD contain are all known before
# anything is copied, which is what lets the copy be skipped entirely.
$rules = Get-ManifestRules
$rulesPath = Join-Path $script:RepoRoot 'scripts/dist-manifest.txt'
$manifestSha = Get-Sha256 -Path $rulesPath
$node = (Invoke-Quiet -File 'node' -Arguments @('--version'))
$rustc = (Invoke-Quiet -File 'rustc' -Arguments @('--version'))
$commit = (Invoke-Quiet -File 'git' -Arguments @('-C', $script:RepoRoot, 'rev-parse', '--short', 'HEAD'))
if (-not $commit) { $commit = 'unknown' }
$status = (Invoke-Quiet -File 'git' -Arguments @('-C', $script:RepoRoot, 'status', '--porcelain'))
$dirty = [bool]$status
$builtAt = Get-UtcStamp

# Was there a previous build at these paths, and was it assembled from exactly
# these inputs? scripts\run-dist.ps1 reads this file too: it NAMES no path, so
# this run is also how a source-checkout user gets the reuse.
$previousFprint = Get-DistFingerprint -DistDir $distDir
$reuse = $false
if (-not $Clean) {
    $reuse = Test-FingerprintMatches -Previous $previousFprint -Version $packVersion -Rid $rid `
        -DshPin $pin -ShellSha $shellSha -ManifestSha $manifestSha -Commit $commit -Dirty $dirty -DistDir $distDir
}

if ($reuse) {
    # Nothing to copy: prove the folder is still the one the last run vouched
    # for, then reuse its own measured size rather than walking it again.
    Assert-Sentinels -DistDir $distDir -NoShell:$NoShell
    $payload = [pscustomobject]@{ Files = [int]$previousFprint.payloadFiles; Bytes = [long]$previousFprint.payloadBytes }
    Write-Step 'The payload is unchanged since the last build - reusing the assembled folder.'
}
else {
    if ($Clean -and (Test-Path -LiteralPath $distDir)) {
        Write-Note 'Rebuilding everything (-Clean).'
    }
    elseif ($null -eq $previousFprint) {
        Write-Note 'No usable fingerprint from a previous build - assembling in full.'
    }
    else {
        Write-Note 'An input changed since the last build - assembling in full.'
    }
    if (Test-Path -LiteralPath $distDir) { Remove-Item -LiteralPath $distDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $distDir | Out-Null
    Write-Step "Assembling $distDir from scripts/dist-manifest.txt ..."
    $included = Copy-Payload -Destination $distDir -Rules $rules
    if ($NoShell) {
        Write-Note "$included include rules applied; no shell binary - app/ ships as source, so nothing is compiled."
    }
    else {
        Copy-Item -LiteralPath $binary -Destination (Join-Path $distDir $script:BinaryName) -Force
        if (-not $script:IsWindowsHost) { try { & chmod 755 (Join-Path $distDir $script:BinaryName) | Out-Null } catch { } }
        Write-Note "$included include rules applied; the shell binary copied in as $($script:BinaryName)."
    }
    # Written FIRST, and rewritten at the end with the measured payload facts.
    # Assert-Sentinels below asserts the fingerprint is present, and that is the
    # right order: the sentinel list is what proves the assembly copied what it
    # promised, so it must run against the assembled folder rather than after the
    # assembly has been decorated with its own metadata.
    $null = New-DistFingerprint -DistDir $distDir -Version $packVersion -Rid $rid -DshPin $pin `
        -ShellSha $shellSha -ManifestSha $manifestSha -Commit $commit -Dirty $dirty `
        -PayloadFiles 0 -PayloadBytes 0
    Assert-Sentinels -DistDir $distDir -NoShell:$NoShell
    # A credential-shaped file that reached the folder is not shipped. The
    # source-side scan is the gate; this is the second half, on what actually
    # ships (see Assert-NoSecrets).
    Assert-NoSecrets -DistDir $distDir
    $payload = Measure-Tree -Root $distDir
}

# --- 3. the files it generates for itself ----------------------------------
# Written on EVERY run, reused folder or not: they are derived from the
# fingerprint's own facts, so they are always current by construction.
New-StartHere -DistDir $distDir -DshPin $pin
New-DistReadme -DistDir $distDir -Version $packVersion -DshPin $pin -Rid $rid -BuiltAt $builtAt -Commit $commit -NoShell:$NoShell
$buildInfoArgs = @{
    DistDir      = $distDir
    Version      = $packVersion
    DshPin       = $pin
    Rid          = $hostRid
    TargetOs     = $artifactOs
    Artifact     = $artifact
    Commit       = $commit
    Dirty        = $dirty
    BuiltAt      = $builtAt
    Builder      = 'scripts/dist.ps1'
    Rustc        = $rustc
    Node         = $node
    PayloadFiles = $payload.Files
    PayloadBytes = $payload.Bytes
    ShellSha     = $shellSha
    NoShell      = $NoShell
}
New-BuildInfo @buildInfoArgs
# The fingerprint is written BEFORE the sums, so the sums cover it - and it is
# read back on the next run to decide whether any of this work is needed.
$fingerprinted = New-DistFingerprint -DistDir $distDir -Version $packVersion -Rid $rid -DshPin $pin `
    -ShellSha $shellSha -ManifestSha $manifestSha -Commit $commit -Dirty $dirty `
    -PayloadFiles $payload.Files -PayloadBytes $payload.Bytes
$summed = New-Sums -DistDir $distDir
Write-Note "Generated START-HERE, DIST-README.txt, BUILD-INFO.json, the build fingerprint and SHA256SUMS.txt ($summed files hashed)."

$total = Measure-Tree -Root $distDir
Write-Step ("Distribution: {0} files, {1:N1} MB" -f $total.Files, ($total.Bytes / 1MB))

# --- 4. the zip, and the single file built from it -------------------------
# A CHANGED folder invalidates both, whichever route produced it. A file that
# changed under a reused folder is a file the zip no longer describes, so it is
# dropped rather than shipped stale - the fingerprint is what notices.
#
# There is NO single-file build in -NoShell mode, and this is structural rather
# than a saving: that artifact IS the zip appended to the shell binary, so with
# no binary there is nothing to append it to. The release ships the .zip alone.
if (-not $NoZip -and -not $reuse) {
    $previousArtifacts = (@($zipPath) + $(if ($NoShell) { @() } else { @($oneFilePath) })) |
        Where-Object { Test-Path -LiteralPath $_ }
    if ($previousArtifacts.Count -gt 0) {
        Write-Note 'The folder changed, so the previous artifact(s) were dropped rather than shipped stale.'
        foreach ($path in $previousArtifacts) {
            try { Remove-Item -LiteralPath $path -Force }
            catch { throw "Could not remove the stale artifact $path ($($_.Exception.Message)). Close any running copy and run this again." }
        }
    }
}

if ($NoZip) {
    Write-Step 'Skipping the zip (-NoZip).'
}
elseif ($reuse -and (Test-Path -LiteralPath $zipPath) -and
        ($NoShell -or (Test-Path -LiteralPath $oneFilePath))) {
    $zipStamp = (Get-Item -LiteralPath $zipPath).LastWriteTimeUtc
    if ($zipStamp -ge (Get-Item -LiteralPath $distDir).LastWriteTimeUtc) {
        Write-Step 'The zip is up to date - not rebuilding it.'
        Write-Note ("Zip: {0} ({1:N1} MB)" -f $zipPath, ((Get-Item -LiteralPath $zipPath).Length / 1MB))
    }
    else {
        # The folder's own generated files were rewritten, so "the zip exists"
        # is not enough - rebuild it from the folder that is there now.
        Write-Step 'Refreshing the zip ...'
        New-ZipArchive -SourceDir $distDir -ZipPath $zipPath -RootName $artifact
        Write-Step ("Zip: {0} ({1:N1} MB)" -f $zipPath, ((Get-Item -LiteralPath $zipPath).Length / 1MB))
    }
}
else {
    Write-Step "Zipping into $zipPath ..."
    New-ZipArchive -SourceDir $distDir -ZipPath $zipPath -RootName $artifact
    Write-Step ("Zip: {0} ({1:N1} MB)" -f $zipPath, ((Get-Item -LiteralPath $zipPath).Length / 1MB))

    if (-not $NoShell) {
        # Built from the zip that ships, in the same run, so the two can never
        # describe different folders.
        Write-Step "Building the single-file build $oneFilePath ..."
        New-StandaloneExecutable -Binary $binary -ZipPath $zipPath -OutPath $oneFilePath -Version $packVersion -Rid $rid
        Write-Step ("One file: {0} ({1:N1} MB)" -f $oneFilePath, ((Get-Item -LiteralPath $oneFilePath).Length / 1MB))
    }
}

# --- 5. what was asked for next -------------------------------------------
if ($Verify) {
    Write-Host ''
    Invoke-Verify -DistDir $distDir -DshPin $pin
}

Write-Host ''
Write-Step 'Done.'
Write-Note "Folder to click: $distDir"
Write-Note "  START-HERE.bat (Windows) / ./START-HERE.sh (macOS, Linux) - it installs the pack, then opens the app"
if ($NoShell) { Write-Note '  Source-only: no compiled shell here. The browser path needs only Node.js.' }
if (-not $NoZip) { Write-Note "Zip to hand over: $zipPath" }
if (-not $NoZip -and -not $NoShell) { Write-Note "One file to hand over: $oneFilePath  (it unpacks itself into your user folder, then starts)" }
Write-Note 'The output folder is build output, never content - re-run this after editing a plugin.'

if ($Run) {
    Write-Host ''
    if ($NoShell) {
        # -Run means "run the shell binary". A source-only folder has none, and
        # silently opening the browser instead would be a different thing than
        # the flag promises - so this says so and points at the real entry point.
        Write-Note 'There is no shell binary here to run (-NoShell), so -Run has nothing to do.'
        Write-Note "Run the distribution's own entry point instead: $(Join-Path $distDir 'START-HERE.bat')"
    }
    else {
        Write-Step "Running the distribution: $(Join-Path $distDir $script:BinaryName)"
        & (Join-Path $distDir $script:BinaryName)
        exit $LASTEXITCODE
    }
}
exit 0
