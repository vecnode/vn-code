@echo off
rem ============================================================
rem  vncode DESKTOP launcher - Windows (double-click friendly).
rem
rem  The same harness scripts/run-web.bat shows in a Chrome tab, in a
rem  native window instead. The shell does the work scripts/run-web.ps1 does
rem  for the browser: it starts the pinned
rem  "npx @deepseek-ai/dsh@<pin> web --no-open" on a free loopback
rem  port, watches for the "dsh web:" ready line and shows THAT url in
rem  a WebView2 / WKWebView / WebKitGTK window. The launch token is a
rem  live credential: it is read IN MEMORY in Rust, never written to a
rem  file, never echoed (the ready line is printed with the token
rem  redacted) and never handed to a shell. A URL that does not name a
rem  loopback address is refused instead of opened.
rem
rem  This is deliberately ONE file, unlike run-web.bat -> run-web.ps1:
rem  the watching half is Rust here, so cmd never has to
rem  read a running child's output, and there is no PowerShell worker
rem  left to hold. The commands are the same either way - only the
rem  window differs.
rem
rem  WHERE IT RUNS FROM, AND WHY THAT IS CHECKED FIRST
rem  ------------------------------------------------
rem  A DISTRIBUTION has the built shell in the folder ABOVE this one, so
rem  it runs it and needs nothing else - not even Rust. A SOURCE CHECKOUT
rem  has no built shell, so it builds one with cargo (a no-op while it is
rem  current, because cargo's own freshness check IS the cache).
rem
rem  The order is not a preference. Both kinds of folder have an app\ -
rem  a distribution ships the shell's README there, a source checkout
rem  ships the Rust source - so "is there a Cargo.toml?" cannot tell the
rem  two apart. Only the presence of the built executable can, and
rem  building inside a distribution would demand a Rust toolchain from
rem  somebody who was only ever asked to click a file.
rem
rem  Flags (forwarded to the shell; the same set as scripts/run-web.bat):
rem    -Port <n>          listen on this port instead of a free one
rem    -DshHome <dir>     override DSH_HOME (default: $DSH_HOME, else ~/.dsh)
rem    -DshVersion <ver>  override the pinned dsh version from .dsh-version.json
rem    -Help / -h / /?    print the help and stop
rem  Plus three this launcher owns and never forwards:
rem    -NoBuild           never run cargo; use the binary already built
rem    -NoPause           never hold this window open
rem    -NoTerminal        stay in this console; do not relaunch
rem
rem  Requirements in a SOURCE CHECKOUT: the Rust toolchain
rem  (https://rustup.rs) and Node.js >= 22 on PATH. The FIRST build
rem  compiles the shell's dependencies and takes a few minutes. In a
rem  DISTRIBUTION: nothing - the folder carries its own runtime.
rem
rem  The console this runs in is decided in ONE place for every entry
rem  point: console\adapt.cmd. This file lives in scripts\ beside that
rem  shared layer and resolves everything else from `%~dp0..`.
rem ============================================================
setlocal

if not defined VNCODE_CONSOLE set "VNCODE_ARGV=%*"
call "%~dp0console\adapt.cmd" "%~f0" "vncode"
if errorlevel 10 exit /b 0
if errorlevel 2 goto :nopowershell

rem --- help, in every spelling ----------------------------------------------
rem -Help is unambiguous wherever it appears; -h and /? are checked on the FIRST
rem argument only, so a -DshHome path containing "-h" cannot print help instead
rem of starting the app.
rem It is safe on the double-click path - where VNCODE_ARGS used to be
rem UNDEFINED and this very line aborted the whole file with "set was unexpected
rem at this time." - because console\adapt.cmd stores "no arguments" as ONE
rem SPACE, a defined value that holds no flag. The full account is there.
if not "%VNCODE_ARGS:-Help=%"=="%VNCODE_ARGS%" goto :help
set "VN_FIRST="
for /f "tokens=1 delims= " %%A in ("%VNCODE_ARGS%") do set "VN_FIRST=%%A"
if /I "%VN_FIRST%"=="-h" goto :help
if /I "%VN_FIRST%"=="/?" goto :help

rem --- the launcher's own flags must not reach the shell ---------------------
rem The Rust shell takes -Port/-DshHome/-DshVersion and nothing else: an unknown
rem flag exits 1 with the flag named (deliberately, so a typo is never ignored).
rem These three are ours, so they are removed before the hand-over.
set "VN_SHELL_ARGS=%VNCODE_ARGS%"
set "VN_SHELL_ARGS=%VN_SHELL_ARGS:-NoPause=%"
set "VN_SHELL_ARGS=%VN_SHELL_ARGS:-NoTerminal=%"
set "VN_NOBUILD="
if not "%VNCODE_ARGS:-NoBuild=%"=="%VNCODE_ARGS%" set "VN_NOBUILD=1"
if not defined VN_NOBUILD goto :haverbuild
set "VN_SHELL_ARGS=%VN_SHELL_ARGS:-NoBuild=%"

:haverbuild
rem --- which artefact runs ---------------------------------------------------
set "VN_BUILT=%~dp0..\vncode.exe"
if exist "%VN_BUILT%" goto :run

set "VN_MANIFEST=%~dp0..\app\src-tauri\Cargo.toml"
if not exist "%VN_MANIFEST%" (
  echo [vncode] Neither vncode.exe nor app\src-tauri\Cargo.toml is in the
  echo   folder above this one. Run scripts\run-desktop.bat from a repository
  echo   checkout, or from a distribution folder assembled by scripts\run-dist.bat.
  goto :failed
)

if defined VN_NOBUILD goto :afterbuild

rem The source checkout's own artefact, resolved ONCE, so the build leg and the
rem failure leg below name the same file - and so the fallback at :buildfailed
rem has something to run.
set "VN_APP=%~dp0..\app\src-tauri\target\release\vncode-desktop.exe"

where cargo >nul 2>nul
if errorlevel 1 (
  echo [vncode] cargo was not found on PATH, so the desktop shell cannot
  echo   be built. Install the Rust toolchain from https://rustup.rs and run
  echo   this file again - or run it from a distribution folder, which carries
  echo   the shell already built and needs no Rust at all.
  goto :failed
)

echo [vncode] Building app\src-tauri in the folder above ^(cargo does nothing when it is current^)...
cargo build --release --manifest-path "%VN_MANIFEST%"
if errorlevel 1 goto :buildfailed

:afterbuild
rem -NoBuild LANDED HERE, before the line above ever ran, so resolve it again.
if not defined VN_APP set "VN_APP=%~dp0..\app\src-tauri\target\release\vncode-desktop.exe"
set "VN_BUILT=%VN_APP%"
if not exist "%VN_BUILT%" (
  echo [vncode] The build reported success but the program is not at
  echo   %VN_BUILT%
  goto :failed
)

:run
echo.
echo [vncode] Starting the desktop shell. Ctrl+C stops it.
echo.
"%VN_BUILT%" %VN_SHELL_ARGS%
set "VN_EXIT=%ERRORLEVEL%"
if "%VN_EXIT%"=="1" goto :failed
exit /b %VN_EXIT%

:help
echo.
echo Usage: scripts\run-desktop.bat [flags]
echo.
echo   -Port ^<n^>          listen on this port instead of a free one
echo   -DshHome ^<dir^>     override DSH_HOME (default: %%DSH_HOME%%, else %%USERPROFILE%%\.dsh)
echo   -DshVersion ^<ver^>  override the pinned dsh version from .dsh-version.json
echo   -NoBuild           never run cargo; use the binary already built
echo   -NoPause           never hold this window open
echo   -NoTerminal        stay in this console; do not relaunch
echo   -Help              print this help
echo.
echo Runs the harness from the pinned dsh version in a native window instead of
echo a Chrome tab - same pin, same profile and same flags as scripts\run-web.bat.
echo.
echo From a distribution folder it runs the vncode.exe in the folder above
echo this one and needs nothing installed. From a source checkout it builds
echo app\src-tauri there with cargo first, which needs the Rust toolchain and
echo Node.js 22 or newer.
echo.
echo macOS and Linux: the same shell builds with "cargo build --release" in
echo app/src-tauri and runs beside ./scripts/run-web.sh, the browser launcher.
echo.
if "%VNCODE_PAUSE%"=="1" pause
exit /b 0

:buildfailed
rem A build can fail for one reason this launcher can do nothing about and the
rem reader can fix in one step: THE SHELL IT IS REPLACING IS STILL RUNNING.
rem Windows will not let cargo remove a program that is still mapped by a live
rem process, so `cargo build` stops at
rem   failed to remove file ...\vncode-desktop.exe: Access is denied. (os error 5)
rem - and the launch used to end there, even though a perfectly good shell was
rem sitting on disk. Reported from the machine this was written on, where the
rem window was simply reopened from a second double-click. So: warn, name the
rem cause, and RUN the artefact that is already there. `-NoBuild` skips the build
rem entirely for the same reason.
echo.
echo [vncode] cargo build failed - see the errors above.
if not exist "%VN_APP%" goto :failed
echo.
echo [vncode] A shell is already built at
echo   %VN_APP%
echo [vncode] Running that one. The usual reason a build stops here is that the
echo   shell is still RUNNING: Windows will not let cargo replace a program that
echo   is in use. Close the vncode window and run this file again to rebuild.
set "VN_BUILT=%VN_APP%"
goto :run

:nopowershell
echo.
echo ============================================================
echo  vncode could not start.
echo ============================================================
echo.
echo  PowerShell was not found on PATH, and this launcher needs it to
echo  set the console up. Windows PowerShell 5.1 ships with every
echo  supported version of Windows; if it is missing, install
echo  PowerShell 7 from https://aka.ms/powershell and run this again.
echo.
if "%VNCODE_PAUSE%"=="1" pause
exit /b 2

:failed
echo.
echo ============================================================
echo  vncode desktop FAILED - see the messages above.
echo ============================================================
echo.
if "%VNCODE_PAUSE%"=="1" pause
exit /b 1
