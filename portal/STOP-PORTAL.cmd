@echo off
REM Double-click this to stop the VRX portal server running on :3011.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-portal.ps1"
echo.
pause >nul
