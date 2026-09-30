@echo off
rem ============================================================
rem  vncode installer (double-click friendly)
rem
rem  Installs the plugin pack into the DeepSeek Harness WEB
rem  profile only - the raw install used by "npx dsh web"
rem  (DSH_HOME or %USERPROFILE%\.dsh, profile web).
rem  DSH Desktop is not supported by this pack.
rem
rem  A plain run always (re-)adds the bundles from this repo at
rem  their current version - i.e. it behaves as if -Force had been
rem  passed - so a double-click always installs the latest edits,
rem  even when the profile already lists the same version. Passing
rem  -Force yourself is still accepted (it is not duplicated), and
rem  neither is added to a help request.
rem
rem  No administrator rights are needed or requested: the pack
rem  installs into the current user's harness home.
rem
rem  Flags (forwarded to scripts\install-all.ps1 - run with -Help
rem  for the full list):
rem    -Plugin <name>     install only the matching bundle(s)
rem    -DshHome <dir>     use this harness home instead of $DSH_HOME
rem    -ProfileName <n>   install into this profile (default: web)
rem    -DshVersion <ver>  override the pinned dsh version
rem    -Force             re-add even when the version is unchanged
rem    -NoPause           never hold this window open
rem    -NoTerminal        stay in this console; do not relaunch
rem    -Help / -h / /?    print the help and stop
rem
rem  The console this runs in - which window, which PowerShell, whether the
rem  window is held open - is decided in ONE place for every entry point in
rem  this repository: console\adapt.cmd. Read its header for why.
rem
rem  This file lives in scripts\, beside install.sh and the PowerShell worker,
rem  so every path below is `%~dp0`-relative and a run works from any directory.
rem
rem  macOS and Linux: ./install.sh is the same installer in POSIX sh.
rem ============================================================
setlocal

rem The three lines adapt.cmd documents. The guard on the first one is what keeps
rem the real flags when Windows Terminal relaunches this file.
if not defined VNCODE_CONSOLE set "VNCODE_ARGV=%*"
call "%~dp0console\adapt.cmd" "%~f0" "vncode installer"
if errorlevel 10 exit /b 0
if errorlevel 2 goto :nopowershell

rem The two help spellings PowerShell itself cannot bind (-h would be read as a
rem parameter prefix, /? as a stray argument) are translated here. Only the FIRST
rem argument is inspected, so a -DshHome path that happens to contain "-h" cannot
rem turn an install into a help screen. -Help and --help need no translation.
set "VN_HELPREQ="
set "VN_FIRST="
for /f "tokens=1 delims= " %%A in ("%VNCODE_ARGV%") do set "VN_FIRST=%%A"
if /I "%VN_FIRST%"=="-h" set "VN_HELPREQ=-Help"
if /I "%VN_FIRST%"=="/?" set "VN_HELPREQ=-Help"
if /I "%VN_FIRST%"=="--help" set "VN_HELPREQ=-Help"

rem If one of those was found, forward -Help and NOTHING else. Two reasons: the
rem spelling that was there cannot be bound by PowerShell at all, so leaving it in
rem would make it bind positionally and fail; and a help request has no use for
rem the other flags. Rewriting the whole argument string (rather than deleting the
rem spelling from it) is also what keeps this safe for a -DshHome path that
rem legitimately contains "-h".
if defined VN_HELPREQ set "VNCODE_ARGS=-Help"

rem The implied -Force, skipped for a help request. Safe with no arguments at all
rem (where VNCODE_ARGV used to be undefined and this line aborted the whole
rem file) because console\adapt.cmd stores "no arguments" as ONE SPACE: a
rem defined value holding no flag, so this test reads it exactly as it reads an
rem argument string that merely lacks -Force - which is the answer wanted here.
set "VN_EXTRA="
if not defined VN_HELPREQ if "%VNCODE_ARGV:-Force=%"=="%VNCODE_ARGV%" set "VN_EXTRA=-Force"

rem -NoTerminal belongs to the LAUNCHER, not to the install: console\adapt.cmd
rem is the file that acts on it, deciding whether to relaunch into Windows Terminal.
rem install-all.ps1 declares no such parameter, and PowerShell stops on an
rem argument it cannot bind - so forwarding it would turn a documented flag into a
rem failed install. Only that one flag is dropped; -NoPause IS the worker's own.
rem (Safe with no arguments at all: adapt.cmd guarantees the variable is defined.)
set "VN_SHELL_ARGS=%VNCODE_ARGS%"
set "VN_SHELL_ARGS=%VN_SHELL_ARGS:-NoTerminal=%"

"%VNCODE_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-all.ps1" %VN_SHELL_ARGS% %VN_EXTRA%
set "VN_EXIT=%ERRORLEVEL%"

echo.
echo ============================================================
if "%VN_EXIT%"=="0" (
  echo [vncode] installed successfully.
) else (
  echo [vncode] install FAILED - see the messages above.
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
echo  PowerShell was not found on PATH, and this installer needs it.
echo  Windows PowerShell 5.1 ships with every supported version of
echo  Windows; if it is missing, install PowerShell 7 from
echo  https://aka.ms/powershell and run this file again.
echo.
echo  (macOS and Linux do not use PowerShell at all: run ./scripts/install.sh.)
echo.
if "%VNCODE_PAUSE%"=="1" pause
exit /b 2
