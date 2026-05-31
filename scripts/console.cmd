@echo off
REM Double-click to open the guild console on the laptop (sends intents to the executor).
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0console.ps1"
