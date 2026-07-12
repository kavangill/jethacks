@echo off
REM Install Dependencies for jethacks (Windows - Batch)
REM This script installs Node.js dependencies for the Electron overlay app

setlocal enabledelayedexpansion

echo.
echo Installing dependencies for Halo...
echo.

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Node.js is not installed.
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
for /f "tokens=*" %%i in ('npm --version') do set NPM_VERSION=%%i

echo.

echo Installing npm packages...
call npm install

if %ERRORLEVEL% NEQ 0 (
    echo Something went wrong
    pause
    exit /b 1
)

echo.
echo To run the app, use: npm start
pause