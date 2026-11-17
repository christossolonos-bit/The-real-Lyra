@echo off
rem Puts Lyra to sleep: closes her mind, her ears, her hologram and their windows.
title Stopping Lyra
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-lyra.ps1"
echo.
echo Lyra is asleep.
timeout /t 3 >nul
