@echo off
setlocal EnableDelayedExpansion
title Tempestune
cd /d "%~dp0"

set "LAVALINK_VERSION=4.2.2"

if not exist .env (echo .env is missing. Copy .env.example to .env and fill it in. & pause & exit /b 1)
for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do if not "%%b"=="" set "%%a=%%b"

where java >nul 2>&1 || (echo Java is not installed. Run: winget install EclipseAdoptium.Temurin.25.JDK & pause & exit /b 1)
where npm >nul 2>&1 || (echo Node.js is not installed. See README.md & pause & exit /b 1)

echo [1/5] Checking lavalink...
set "have="
if exist lavalink\version.txt set /p have=<lavalink\version.txt
if not "!have!"=="%LAVALINK_VERSION%" (
  echo Downloading Lavalink %LAVALINK_VERSION%...
  curl -fL --retry 3 -o lavalink\Lavalink.jar https://github.com/lavalink-devs/Lavalink/releases/download/%LAVALINK_VERSION%/Lavalink.jar || (echo Download failed & pause & exit /b 1)
  > lavalink\version.txt echo %LAVALINK_VERSION%
)

echo [2/5] Getting the bot ready...
call npm install --no-audit --no-fund --loglevel=error || (echo npm install failed & pause & exit /b 1)
call npm run build --silent || (echo Build failed & pause & exit /b 1)

echo [3/5] Starting lavalink...
start "Tempestune main node" /min cmd /c lavalink\run.cmd main
if /i "%YOUTUBE%"=="on" start "Tempestune youtube node" /min cmd /c lavalink\run.cmd youtube

echo [4/5] Waiting for the main node...
for /l %%i in (1,1,90) do (
  curl -s -o nul -H "Authorization: %LAVALINK_PASSWORD%" http://127.0.0.1:2333/version && goto ready
  timeout /t 1 /nobreak >nul
)
echo The main node didn't start. Check the "Tempestune main node" window.
pause
exit /b 1

:ready
echo [5/5] Starting the bot...
start "Tempestune bot" /min cmd /c "for /l %%n in () do (node --env-file=.env dist\index.js & echo bot stopped, starting again in 5 seconds... & timeout /t 5 /nobreak >nul)"
echo Tempestune is running. Close the minimised windows to stop it.
timeout /t 5 >nul
