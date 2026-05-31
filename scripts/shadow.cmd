@echo off
REM Double-click on the LAPTOP to start the shadow loop (auto-follows you between zones).
REM Requires: playerwatch.lua running in your player client's MQ, and shadow.squads set in config.json.
node "%~dp0..\brain\shadow.js"
echo.
pause
