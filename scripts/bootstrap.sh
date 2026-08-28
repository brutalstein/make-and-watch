#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

printf '\n\033[35m  MAKE & WATCH  /  BOOTSTRAP\033[0m\n\n'
"$ROOT/scripts/doctor.sh"

cd "$ROOT"
printf '\n\033[36m[1/2] Installing Studio workspace...\033[0m\n'
pnpm install

printf '\033[36m[2/2] Configuring native engine...\033[0m\n'
cmake --preset dev

printf '\n\033[32mBootstrap complete. Run ./dev.sh to open the Studio dev server.\033[0m\n'
