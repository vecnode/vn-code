@echo off
rem vncode installer (console use). Double-click scripts\install.bat instead for a friendlier prompt.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-all.ps1" %*
exit /b %ERRORLEVEL%
