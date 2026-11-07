@echo off
rem Starts the Liahona Manager and opens it in the browser.
rem Data lives in Documents\Liahona Data, separate from the code, so updating
rem the code (git pull) never touches it.
title Liahona Manager
cd /d "%~dp0"

if not defined LIAHONA_DATA (
  for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('MyDocuments')"`) do set "LIAHONA_DATA=%%D\Liahona Data\liahona.json"
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)

node server.js --open
echo.
echo The Liahona Manager has stopped.
pause
