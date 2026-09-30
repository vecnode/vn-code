@echo off
rem ============================================================
rem  vncode DISTRIBUTER - Windows (double-click friendly).
rem
rem  Builds the distribution you can hand to somebody (or run
rem  yourself) three ways:
rem
rem    dist\vncode-<version>-win-x64\      <- click this one
rem    dist\vncode-<version>-win-x64.zip    <- or hand this over
rem    dist\vncode-<version>-win-x64.exe    <- or hand over ONE file,
rem                                              which unpacks itself and starts
rem
rem  The folder holds the built shell (vncode.exe) beside the
rem  whole plugin pack it live-links from, plus START-HERE.bat,
rem  DIST-README.txt, BUILD-INFO.json and SHA256SUMS.txt. dist\
rem  is gitignored on purpose: it is a COPY of this repository
rem  (minus the trees named in scripts\dist-manifest.txt) plus the
rem  built binary, so it is build output and never content.
rem
rem  This file is batch only, so Windows asks no execution-policy
rem  question before starting; the work is dist.ps1 beside this file - the
rem  SAME file .github\workflows\distribute.yml runs on
rem  windows-2022, so a local run and a CI run cannot drift.
rem  macOS/Linux: ./scripts/distribute.sh is the same thing in POSIX sh.
rem
rem  Flags (forwarded to the worker; the full list is in its help):
rem    -Version <v>      override the pack version used in the names
rem    -SkipBuild        reuse the binary already under app\src-tauri
rem    -NoZip            assemble the folder only
rem    -Run              assemble, then run the produced distribution
rem    -Verify           assemble, then install into a throwaway
rem                      DSH_HOME and boot the pinned harness from it
rem                      (the end-to-end check the CI job also runs)
rem    -KeepVerifyHome   keep that throwaway home for inspection
rem    -Clean            delete dist\ first
rem    -NoPause          never hold this window open
rem    -NoTerminal       stay in this console; do not relaunch
rem    -Help / -h / /?   print the help and stop
rem
rem  Requirements: the Rust toolchain (https://rustup.rs) for the
rem  build step (skip it with -SkipBuild), Node.js 22+ for -Verify,
rem  and git/node only for the version stamps.
rem
rem  The console this runs in is decided in ONE place for every
rem  entry point: console\adapt.cmd.
rem ============================================================
setlocal

if not defined VNCODE_CONSOLE set "VNCODE_ARGV=%*"
call "%~dp0console\adapt.cmd" "%~f0" "vncode distributer"
if errorlevel 10 exit /b 0
if errorlevel 2 goto :nopowershell

rem -h and /? are the two spellings PowerShell cannot bind; see install.bat for
rem why only the first argument is inspected.
set "VN_HELPREQ="
set "VN_FIRST="
for /f "tokens=1 delims= " %%A in ("%VNCODE_ARGV%") do set "VN_FIRST=%%A"
if /I "%VN_FIRST%"=="-h" set "VN_HELPREQ=-Help"
if /I "%VN_FIRST%"=="/?" set "VN_HELPREQ=-Help"
if /I "%VN_FIRST%"=="--help" set "VN_HELPREQ=-Help"

rem If one of those was found, forward -Help and NOTHING else: the spelling that
rem was there cannot be bound by PowerShell, and a help request has no use for the
rem other flags. Rewriting the whole string is what keeps this safe for a -DshHome
rem path that legitimately contains "-h". See install.bat.
if defined VN_HELPREQ set "VNCODE_ARGS=-Help"

rem -NoTerminal is the LAUNCHER's flag and dist.ps1 declares no such
rem parameter; forwarding it would make PowerShell stop on an argument it cannot
rem bind. See install.bat for the whole reason. Safe with no arguments at all:
rem console\adapt.cmd stores "no arguments" as one space, so VN_SHELL_ARGS
rem is always defined.
set "VN_SHELL_ARGS=%VNCODE_ARGS%"
set "VN_SHELL_ARGS=%VN_SHELL_ARGS:-NoTerminal=%"

"%VNCODE_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0dist.ps1" %VN_SHELL_ARGS%
set "VN_EXIT=%ERRORLEVEL%"

echo.
echo ============================================================
if "%VN_EXIT%"=="0" (
  echo [vncode] distribution built - see the paths above.
) else (
  echo [vncode] distribution FAILED - see the messages above.
)
echo ============================================================
echo.
if "%VNCODE_PAUSE%"=="1" pause
exit /b %VN_EXIT%

:nopowershell
echo.
echo ============================================================
echo  vncode could not start.
echo ============================================================
echo.
echo  PowerShell was not found on PATH, and the distributer needs it.
echo  Windows PowerShell 5.1 ships with every supported version of
echo  Windows; if it is missing, install PowerShell 7 from
echo  https://aka.ms/powershell and run this file again.
echo.
echo  (macOS and Linux do not use PowerShell for this: run ./scripts/distribute.sh.)
echo.
if "%VNCODE_PAUSE%"=="1" pause
exit /b 2
