@echo off
rem ============================================================
rem  vncode DIST - Windows (double-click friendly).
rem
rem  ONE verb that produces the distribution you actually run
rem  and hand over:
rem
rem    dist\vncode-<version>-win-x64\      <- the folder: click
rem                                            START-HERE.bat inside
rem    dist\vncode-<version>-win-x64.zip    <- or hand this over
rem    dist\vncode-<version>-win-x64.exe    <- or hand over ONE file,
rem                                            which unpacks itself and starts
rem
rem  This is the launcher the maintainer uses day to day. It is
rem  the SAME work .github\workflows\distribute.yml runs when the
rem  workflow is restored (it is parked for now), and the same
rem  worker scripts\run-dist.bat drives - that file now just
rem  forwards here, so there is one implementation and not two.
rem
rem  WHY THIS IS FAST ON THE SECOND RUN. Two caches, both keyed on
rem  things that did NOT change:
rem
rem    - the Rust shell: if no file under app\src-tauri or app\ui
rem      is newer than the built binary, cargo is not invoked at all
rem      (-ForceBuild builds anyway);
rem    - the assembled folder: if the shell's hash, the version, the
rem      ship list and the last commit are all the same as the run
rem      that produced dist\, the ~100 MB copy, the hashing and the
rem      zip are skipped and only what changed is rebuilt (-Clean
rem      rebuilds everything from scratch).
rem
rem  A no-change run is therefore a fraction of a second, and a run
rem  after a plugin edit re-copies and re-hashes only that - which
rem  is what makes it practical to run dist and test the app as a
rem  NEW USER would receive it.
rem
rem  Flags (forwarded to the worker; the full list is in its help):
rem    -Version <v>      override the pack version used in the names
rem    -SkipBuild        reuse the binary already under app\src-tauri
rem    -ForceBuild       run cargo even when nothing looks stale
rem    -NoZip            assemble the folder only
rem    -Run              assemble, then run the produced folder's
rem                      START-HERE.bat (the whole new-user path:
rem                      install into the profile, then open)
rem    -RunApp           assemble, then run just the packed vncode.exe
rem    -Verify           install into a throwaway DSH_HOME and boot
rem                      the pinned harness from it (CI's own check)
rem    -KeepVerifyHome   keep that throwaway home for inspection
rem    -Sign             sign the shell and the one-file build (needs
rem                      a certificate; off by default - see docs\BUILD.md)
rem    -SkipChecks       do not run scripts\checks before assembling
rem    -Clean            delete dist\ first
rem    -NoPause          never hold this window open
rem    -NoTerminal       stay in this console; do not relaunch
rem    -Help / -h / /?   print the help and stop
rem
rem  Requirements: the Rust toolchain (https://rustup.rs) for the
rem  build step (skip it with -SkipBuild), Node.js 22+ for the checks
rem  and -Verify, and git for the version stamps.
rem
rem  The console this runs in is decided in ONE place for every
rem  entry point: console\adapt.cmd.
rem ============================================================
setlocal

if not defined VNCODE_CONSOLE set "VNCODE_ARGV=%*"
call "%~dp0console\adapt.cmd" "%~f0" "vncode dist"
if errorlevel 10 exit /b 0
if errorlevel 2 goto :nopowershell

rem -h and /? are the two spellings PowerShell cannot bind; see install.bat for
rem why only the first argument is inspected, and why a help request forwards
rem -Help and NOTHING else (a -DshHome path may legitimately contain "-h").
set "VN_HELPREQ="
set "VN_FIRST="
for /f "tokens=1 delims= " %%A in ("%VNCODE_ARGV%") do set "VN_FIRST=%%A"
if /I "%VN_FIRST%"=="-h" set "VN_HELPREQ=-Help"
if /I "%VN_FIRST%"=="/?" set "VN_HELPREQ=-Help"
if /I "%VN_FIRST%"=="--help" set "VN_HELPREQ=-Help"
if defined VN_HELPREQ set "VNCODE_ARGS=-Help"

rem -NoTerminal is the LAUNCHER's flag: console\adapt.cmd already acted on it,
rem and run-dist.ps1 declares no such parameter, so forwarding it would make
rem PowerShell stop on an argument it cannot bind. Safe with no arguments at all:
rem console\adapt.cmd stores "no arguments" as one space, so VN_SHELL_ARGS is
rem always defined.
set "VN_SHELL_ARGS=%VNCODE_ARGS%"
set "VN_SHELL_ARGS=%VN_SHELL_ARGS:-NoTerminal=%"

"%VNCODE_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-dist.ps1" %VN_SHELL_ARGS%
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
echo  (macOS and Linux do not use PowerShell for this: run ./scripts/dist.sh.)
echo.
if "%VNCODE_PAUSE%"=="1" pause
exit /b 2
