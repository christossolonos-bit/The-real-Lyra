@echo off
rem Signs Lyra in to YouTube once (her own channel's Google account). See src\youtube-signin.js.
cd /d "%~dp0"
node src\youtube-signin.js
pause
