$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

function Step($Index, $Total, $Label) {
  Write-Host ""
  Write-Host ("[{0}/{1}] {2}" -f $Index, $Total, $Label) -ForegroundColor Cyan
}

Write-Host ""
Write-Host "  MAKE & WATCH  /  QUALITY GATE" -ForegroundColor Magenta
Write-Host "  Full local foundation verification" -ForegroundColor DarkGray

Set-Location $Root

Step 1 7 "System doctor"
& "$PSScriptRoot/doctor.ps1"

Step 2 7 "Studio dependencies"
pnpm install --no-frozen-lockfile

Step 3 7 "Local bridge syntax"
pnpm bridge:check

Step 4 7 "Strict TypeScript contracts"
pnpm typecheck

Step 5 7 "Studio production build"
pnpm build:web

Step 6 7 "Native configure + build"
cmake --preset dev
cmake --build --preset dev

Step 7 7 "Native test suite"
ctest --preset dev --output-on-failure

Write-Host ""
Write-Host "  QUALITY GATE PASSED" -ForegroundColor Green
Write-Host "  Studio + bridge + contracts + native engine + persistence/runtime tests are green." -ForegroundColor DarkGray
Write-Host ""
