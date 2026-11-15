@echo off
rem stops the lavalink nodes and the bot, leaves other bots alone
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lavalink\stop.ps1"
timeout /t 2 /nobreak >nul
