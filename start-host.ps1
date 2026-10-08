$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (!(Test-Path node_modules)) { npm install }
Write-Host "Grand Line Bounty Auction is starting..."
Write-Host "Open http://localhost:3000"
node server.js
