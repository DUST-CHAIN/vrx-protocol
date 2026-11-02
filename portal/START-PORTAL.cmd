@echo off
REM Double-click this to (re)start the VRX portal cleanly on http://localhost:3011
REM It frees the port, clears the .next cache, then runs the dev server in this window.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-portal.ps1"
echo.
echo The dev server has stopped. Press any key to close this window.
pause >nul
