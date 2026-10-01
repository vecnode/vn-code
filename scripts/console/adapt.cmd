@echo off
rem ============================================================================
rem  scripts/console/adapt.cmd - the console half of EVERY Windows entry point
rem  in this repository.
rem
rem  WHY THIS FILE EXISTS
rem  --------------------
rem  scripts\install.bat, scripts\uninstall.bat, scripts\run-web.bat,
rem  scripts\run-desktop.bat and scripts\run-dist.bat all have to answer the
rem  same five questions before they do any work: which
rem  window am I in, which PowerShell do I have, can this console show colour,
rem  should I hold the window open at the end, and what were my real arguments?
rem  Five batch files that each answered those themselves would drift, and the
rem  drift would only show up on somebody else's machine.
rem
rem  Batch has no `include` - but it has `call`, and it has `exit /b`. This is
rem  the include. It is deliberately tiny, and it must NOT use `setlocal`, so
rem  that everything it decides is still set when it returns.
rem
rem  HOW A CALLER USES IT (exactly three lines, always in this order). The path
rem  differs by where the caller lives: a launcher in scripts\ reaches this file
rem  as `%~dp0console\adapt.cmd`, while the generated START-HERE.bat at a
rem  distribution root uses `%~dp0scripts\console\adapt.cmd`.
rem  ----------------------------------------------------------------
rem      if not defined VNCODE_CONSOLE set "VNCODE_ARGV=%*"
rem      call "%~dp0console\adapt.cmd" "%~f0" "vncode installer"
rem      if errorlevel 10 exit /b 0
rem      if errorlevel 2 goto :nopowershell
rem
rem  THE FIRST LINE IS NOT OPTIONAL AND ITS GUARD IS THE POINT. On the way back
rem  in - the relaunched window - `%*` is only the `--from-terminal` marker, so
rem  re-deriving the arguments there would replace the caller's real flags with
rem  that marker. The guard keeps the inherited value instead. This is also why
rem  an argumentless double-click works: `%*` is empty, VNCODE_ARGV stays
rem  undefined, and "undefined" reads as "no arguments" on both sides.
rem
rem  WHAT IT LEAVES BEHIND
rem  ---------------------
rem    VNCODE_ARGS   the caller's ORIGINAL arguments - ALWAYS use this to
rem                      forward flags, never `%*`
rem    VNCODE_PS     absolute path of the PowerShell that runs the workers
rem    VNCODE_PAUSE  1 when a failure should hold the window open, else 0
rem
rem  EXIT CODES (the caller acts on these; they are not the script's own result)
rem    0   continue in this window
rem    2   preflight failed - no PowerShell on this machine
rem    10  a Windows Terminal window owns this run now: exit immediately and do
rem        NOT print a banner or pause, because that window already will
rem
rem  THE WINDOW, AND WHY IT IS WORTH RELAUNCHING INTO
rem  ------------------------------------------------
rem  Windows 11 already opens a double-clicked .bat in Windows Terminal when that
rem  is the default terminal application, and then this is a no-op (WT_SESSION is
rem  already set). On Windows 10, or on a machine where the default was changed
rem  back to the legacy console host, it is the difference between a 1995 install
rem  and a current one - so a real wt.exe is used when there is one, with `-w new`
rem  so a new window is created rather than a tab injected into whatever the user
rem  is working in. `-NoTerminal` in the arguments, or VNCODE_NO_WT in the
rem  environment, opts out; a wt.exe that fails to launch falls through to the
rem  console we are in rather than losing the run.
rem
rem  WHAT THIS FILE DELIBERATELY DOES NOT DO
rem  ---------------------------------------
rem  It does not run `chcp`. Changing the code page mutates the whole console for
rem  the rest of its life, and reading the old one back means parsing localized
rem  output. The worker sets `[Console]::OutputEncoding` instead
rem  (scripts\console\theme.ps1) - the same result, scoped to the process that
rem  needs it, and harmless when the console cannot render a glyph anyway.
rem
rem  It does not print a banner or pause: the caller owns the words and the
rem  window. It does not forward flags: it resolves the environment they run in.
rem ============================================================================

rem --- the caller's identity, as passed in -----------------------------------
set "VN_ENTRY=%~1"
set "VN_TITLE=%~2"

rem --- the arguments to act on ------------------------------------------------
rem Derived from the caller's VNCODE_ARGV, never from `%*`: on the relaunched
rem pass `%*` is the marker only. Refreshed on every call so a caller that
rem exported nothing still reads as "no arguments".
rem
rem AN ABSENT ARGUMENT STRING IS STORED AS ONE SPACE, AND EVERY LAUNCHER DEPENDS ON
rem THAT. cmd has no empty variable: `set "X="` REMOVES X, and a `%X:-flag=%`
rem substitution on an UNDEFINED X is not an empty string - cmd emits the modifier
rem as literal text instead. So on a DOUBLE-CLICK, where both names are derived
rem from an empty `%*`, the pause rule below became
rem   if not "-NoPause=VNCODE_ARGS"=="VNCODE_ARGS" set "VNCODE_PAUSE=0"
rem an `if` with ONE token, which cmd answers with "set was unexpected at this
rem time." and which aborts the WHOLE FILE on the spot: the window flashed and
rem closed having printed nothing at all, while every run WITH flags worked
rem perfectly. An `if defined ...` on the same line cannot repair it either - cmd
rem expands every `%VAR%` on a line BEFORE it runs any of that line, so the garbage
rem appears even inside a branch that is skipped (measured).
rem
rem One space is the defined value that fixes it: it holds no flag, so every test
rem below reads it exactly as it reads a flagged run, and it is harmless wherever
rem it is forwarded - cmd and Rust both split argv on whitespace, so a lone space
rem never arrives as an argument (measured: scripts\run-desktop.bat with none
rem starts the shell normally). This file is the ONLY place that has to know,
rem because it must NOT setlocal - its decisions stay visible to the caller by
rem design - so repairing both names here, once, covers all five entry points.
rem check-dist-layout.mjs asserts this normalisation is still here.
if not defined VNCODE_ARGV set "VNCODE_ARGV= "
set "VNCODE_ARGS=%VNCODE_ARGV%"

rem --- the PowerShell that will run the work ---------------------------------
rem pwsh (7) first: real UTF-8 by default and no 5.1 string quirks. Windows
rem PowerShell 5.1 second. Every worker in scripts\ is written to run on BOTH -
rem that is a standing rule in AGENTS.md, not a courtesy - so the fallback is a
rem first-class path, not a degraded one. `%%~$PATH:P` searches PATH for the
rem literal name, which is how this stays free of a subshell per lookup.
if not defined VNCODE_PS for %%P in (pwsh.exe) do set "VNCODE_PS=%%~$PATH:P"
if not defined VNCODE_PS for %%P in (powershell.exe) do set "VNCODE_PS=%%~$PATH:P"
if not defined VNCODE_PS exit /b 2

rem --- the pause rule ---------------------------------------------------------
rem A double-clicked installer must hold its window open so the result can be
rem read; a scripted run must not, or it hangs a pipeline. VNCODE_PAUSE is
rem therefore about the WINDOW, not about success: callers pause on failure (and
rem on success where a summary is worth reading) only when this is 1.
rem
rem The test is cmd's own substring substitution rather than `echo | findstr`.
rem That matters: `%VAR:...=%` is quoted end to end, so an argument holding `&`,
rem `|`, `>` or a quote - a -DshHome with a space and an ampersand in it - is
rem data, while the same value piped through echo would be re-parsed as syntax.
rem The substitution is case-insensitive, so -nopause works too - and it is safe on
rem the double-click path because VNCODE_ARGS is guaranteed DEFINED above.
set "VNCODE_PAUSE=1"
if defined VNCODE_NOPAUSE set "VNCODE_PAUSE=0"
if defined VNCODE_QUIET set "VNCODE_PAUSE=0"
if not "%VNCODE_ARGS:-NoPause=%"=="%VNCODE_ARGS%" set "VNCODE_PAUSE=0"

rem --- the window -------------------------------------------------------------
rem Order matters and each line is a reason to stop:
rem   already relaunched  - the marker is set, we are the child, do not loop
rem   already in Terminal - WT_SESSION is set, this IS the window
rem   asked not to        - -NoTerminal, VNCODE_NO_WT
rem   no Terminal at all  - wt.exe did not resolve
if defined VNCODE_CONSOLE exit /b 0
if defined WT_SESSION exit /b 0
if defined VNCODE_NO_WT exit /b 0
if not "%VNCODE_ARGS:-NoTerminal=%"=="%VNCODE_ARGS%" exit /b 0
set "VNCODE_WT="
for %%P in (wt.exe) do set "VNCODE_WT=%%~$PATH:P"
if not defined VNCODE_WT exit /b 0

rem Relaunch THIS entry point in a new Windows Terminal window. The marker tells
rem the child not to repeat any of this; `cmd /c` runs the batch and closes the
rem tab when it is done, so the tab's lifetime is the run's lifetime.
set "VNCODE_CONSOLE=1"
"%VNCODE_WT%" -w new nt --title "%VN_TITLE%" cmd.exe /c ""%VN_ENTRY%" --from-terminal"
rem Only a wt.exe that actually failed brings us back here. Anything else means
rem the run belongs to the new window, and this console must leave quietly -
rem exit 10 tells the caller so, and keeps it from printing a second banner or
rem pausing a window the user is about to close.
if errorlevel 1 goto :fellthrough
exit /b 10

:fellthrough
rem wt.exe exists but would not launch: undo the marker so the run continues in
rem THIS console rather than believing it was relaunched.
set "VNCODE_CONSOLE="
echo [vncode] Windows Terminal would not start; continuing in this window.
exit /b 0
