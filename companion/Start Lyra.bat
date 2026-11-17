@echo off
rem The real Lyra: starts her mind and her ears (PC microphone) and opens her page.
rem Close this window to put her to sleep.
cd /d "%~dp0"
title Lyra - keep this window open while you talk to her
for /f "tokens=1,* delims==" %%a in ('findstr /b "OWNER_KEY=" .env') do set OWNER_KEY=%%b

rem Already awake (an older copy)? Put her to sleep first so the newest version starts.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":8770 .*LISTENING"') do (
  echo Restarting Lyra...
  taskkill /pid %%p /f >nul 2>&1
)
timeout /t 1 >nul

rem Her ears: listens on the PC microphone, transcribes locally (free). Own window.
start "Lyra ears - PC microphone" cmd /k python -u ears\ears.py

start "" "http://localhost:8770/?owner=%OWNER_KEY%"
echo Lyra is waking up. Keep this window open while you talk to her.
echo.
node --env-file=.env src/server.js
echo.
echo Lyra stopped. If there is an error above, send it to Claude.
pause
