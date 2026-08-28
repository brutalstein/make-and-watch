$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

Write-Host ""
Write-Host "  MAKE & WATCH  /  BOOTSTRAP" -ForegroundColor Magenta
Write-Host ""

& "$PSScriptRoot/doctor.ps1"

Set-Location $Root
Write-Host ""
Write-Host "[1/2] Installing Studio workspace..." -ForegroundColor Cyan
pnpm install

Write-Host "[2/2] Configuring native engine..." -ForegroundColor Cyan
cmake --preset dev

Write-Host ""
Write-Host "Bootstrap complete. Run .\dev.ps1 to open the Studio dev server." -ForegroundColor Green
