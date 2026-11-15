@echo off
rem keeps one lavalink node alive, restarts it if it ever stops
title Tempestune %1 node
cd /d "%~dp0%1"
:loop
"%JAVA%" -Xms256M -Xmx1G -jar "%~dp0Lavalink.jar"
echo %1 node stopped, starting again in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
