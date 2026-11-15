@echo off
rem stops the tray, the lavalink nodes and the bot, leaves other bots alone
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lavalink\stop.ps1"
