@echo off
rem ============================================================
rem  vncode uninstaller (double-click friendly)
rem
rem  Removes what this pack installed into the DeepSeek Harness
rem  web profile: the bundles it added and the patch layer that
rem  came with them, plus the skill folders it copied. It removes
rem  ONLY what it wrote - a bundle or skill a person added
rem  themselves is left alone, and no session, setting or
rem  credential is touched.
rem
rem  No administrator rights are needed or requested.
rem
rem  Flags (forwarded to scripts\uninstall-all.ps1 - run with
rem  -Help for the full list):
rem    -Plugin <name>     remove only the matching bundle(s)
rem    -DshHome <dir>     use this harness home instead of $DSH_HOME
rem    -ProfileName <n>   remove from this profile (default: web)
rem    -DshVersion <ver>  override the pinned dsh version
rem    -NoPause           never hold this window open
rem    -NoTerminal        stay in this console; do not relaunch
rem    -Help / -h / /?    print the help and stop
rem
rem  The console this runs in is decided in ONE place for every
rem  entry point: console\adapt.cmd.
rem
rem  macOS and Linux: ./scripts/uninstall.sh is the same remover in POSIX sh.
rem
rem  This file lives in scripts\, beside uninstall.sh and the PowerShell worker,
rem  so every path below is `%~dp0`-relative and a run works from any directory.
rem ============================================================
setlocal

if not defined VNCODE_CONSOLE set "VNCODE_ARGV=%*"
call "%~dp0console\adapt.cmd" "%~f0" "vncode uninstaller"
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

rem -NoTerminal is the LAUNCHER's flag and uninstall-all.ps1 declares no
rem such parameter; forwarding it would make PowerShell stop on an argument it
rem cannot bind. See install.bat for the whole reason. Safe with no arguments at
rem all: console\adapt.cmd stores "no arguments" as one space, so
rem VN_SHELL_ARGS is always defined.
set "VN_SHELL_ARGS=%VNCODE_ARGS%"
set "VN_SHELL_ARGS=%VN_SHELL_ARGS:-NoTerminal=%"

"%VNCODE_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-all.ps1" %VN_SHELL_ARGS%
set "VN_EXIT=%ERRORLEVEL%"

echo.
echo ============================================================
if "%VN_EXIT%"=="0" (
  echo [vncode] removed successfully.
) else (
  echo [vncode] removal FAILED - see the messages above.
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
echo  PowerShell was not found on PATH, and this remover needs it.
echo  Windows PowerShell 5.1 ships with every supported version of
echo  Windows; if it is missing, install PowerShell 7 from
echo  https://aka.ms/powershell and run this file again.
echo.
echo  (macOS and Linux do not use PowerShell at all: run ./scripts/uninstall.sh.)
echo.
if "%VNCODE_PAUSE%"=="1" pause
exit /b 2
