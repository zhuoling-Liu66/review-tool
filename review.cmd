@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required. Install it from https://nodejs.org/ and try again.
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)

if not exist "dist\cli.js" (
  echo Building the CLI...
  call npm run build
  if errorlevel 1 exit /b 1
)

node "dist\cli.js" %*
exit /b %ERRORLEVEL%
