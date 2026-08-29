$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

function Step($Index, $Total, $Label) {
  Write-Host ""
  Write-Host ("[{0}/{1}] {2}" -f $Index, $Total, $Label) -ForegroundColor Cyan
}

function Assert-NativeSuccess($Label) {
  if ($LASTEXITCODE -ne 0) {
    throw ("{0} failed with exit code {1}" -f $Label, $LASTEXITCODE)
  }
}

Write-Host ""
Write-Host "  MAKE & WATCH  /  QUALITY GATE" -ForegroundColor Magenta
Write-Host "  Full local foundation verification" -ForegroundColor DarkGray

Set-Location $Root

Step 1 7 "System doctor"
& "$PSScriptRoot/doctor.ps1"

Step 2 7 "Studio dependencies"
pnpm install --no-frozen-lockfile
Assert-NativeSuccess "pnpm install"

Step 3 7 "Local bridge syntax"
pnpm bridge:check
Assert-NativeSuccess "pnpm bridge:check"

Step 4 7 "Strict TypeScript contracts"
pnpm typecheck
Assert-NativeSuccess "pnpm typecheck"

Step 5 7 "Studio production build"
pnpm build:web
Assert-NativeSuccess "pnpm build:web"

Step 6 7 "Native configure + build"
cmake --preset dev
Assert-NativeSuccess "cmake configure"
cmake --build --preset dev
Assert-NativeSuccess "cmake build"

Step 7 7 "Native test suite"
ctest --preset dev --output-on-failure
Assert-NativeSuccess "ctest"

Write-Host ""
Write-Host "  QUALITY GATE PASSED" -ForegroundColor Green
Write-Host "  Studio + bridge + contracts + native engine + persistence/runtime tests are green." -ForegroundColor DarkGray
Write-Host ""
