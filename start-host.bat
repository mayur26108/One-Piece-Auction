@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
echo.
echo Grand Line Bounty Auction is starting...
echo Open http://localhost:3000
node server.js
pause
