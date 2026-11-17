@echo off
rem The real Lyra. Closes any Lyra that's running, then starts her fresh with no windows:
rem her mind (memory, Discord, dashboard), her ears (PC microphone) and her hologram run hidden,
rem each writing to companion\logs\. Her page opens in your browser.
rem To put her to sleep: Stop Lyra.bat.
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-lyra.ps1"
