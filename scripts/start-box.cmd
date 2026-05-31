@echo off
REM Double-click to start the agent on the 32 GB box (executor + bridge handoff).
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0start-box.ps1"
echo.
pause
