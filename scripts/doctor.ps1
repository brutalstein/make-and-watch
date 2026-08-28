$ErrorActionPreference = "Stop"

function Write-Status($State, $Label, $Detail) {
  $color = switch ($State) {
    "OK" { "Green" }
    "WARN" { "Yellow" }
    default { "Red" }
  }
  Write-Host ("[{0,-4}] " -f $State) -ForegroundColor $color -NoNewline
  Write-Host $Label -ForegroundColor White -NoNewline
  if ($Detail) { Write-Host "  $Detail" -ForegroundColor DarkGray } else { Write-Host "" }
}

function Test-Command($Name, $VersionArgs) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) {
    Write-Status "MISS" $Name "required"
    return $false
  }

  try {
    $detail = (& $Name @VersionArgs 2>&1 | Select-Object -First 1).ToString().Trim()
  } catch {
    $detail = $command.Source
  }
  Write-Status "OK" $Name $detail
  return $true
}

Write-Host ""
Write-Host "  MAKE & WATCH  /  SYSTEM DOCTOR" -ForegroundColor Magenta
Write-Host "  Local-first production environment check" -ForegroundColor DarkGray
Write-Host ""

$ok = $true
$ok = (Test-Command "node" @("--version")) -and $ok
$ok = (Test-Command "pnpm" @("--version")) -and $ok
$ok = (Test-Command "cmake" @("--version")) -and $ok
$ok = (Test-Command "ninja" @("--version")) -and $ok

$nvidia = Get-Command "nvidia-smi" -ErrorAction SilentlyContinue
if ($nvidia) {
  try {
    $gpu = (& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null | Select-Object -First 1).ToString().Trim()
    Write-Status "OK" "NVIDIA GPU" $gpu
  } catch {
    Write-Status "WARN" "NVIDIA GPU" "detected, telemetry unavailable"
  }
} else {
  Write-Status "WARN" "NVIDIA GPU" "not detected; Studio can still run, media capability will be limited"
}

Write-Host ""
if ($ok) {
  Write-Host "Environment foundation is ready." -ForegroundColor Green
  exit 0
}

Write-Host "Required development dependencies are missing." -ForegroundColor Red
exit 1
