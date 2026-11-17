@echo off
rem Lyra character creator - opens the page and serves this folder on http://localhost:8765
cd /d "%~dp0"
start "" http://localhost:8765/
python -m http.server 8765
