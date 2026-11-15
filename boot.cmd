@echo off
title Tempestune
cd /d "%~dp0"

if not exist .env (echo .env is missing. Copy .env.example to .env and fill it in. & pause & exit /b 1)
where npm >nul 2>&1 || (echo Node.js is not installed. See README.md & pause & exit /b 1)

echo Getting everything ready (the first run downloads Java, Lavalink, yt-dlp and ffmpeg)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" || (echo Setup failed, see above. & pause & exit /b 1)

call "%~dp0stop.cmd"
start "" wscript.exe "%~dp0tray\tempestune-tray.vbs"
echo Tempestune is starting. Its icon is in the tray near the clock.
timeout /t 5 >nul
