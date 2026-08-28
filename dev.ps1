$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

if (-not (Test-Path "$Root/node_modules")) {
  & "$Root/scripts/bootstrap.ps1"
}

Set-Location $Root
pnpm dev
