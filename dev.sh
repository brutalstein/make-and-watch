#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -d "$ROOT/node_modules" ]]; then
  "$ROOT/scripts/bootstrap.sh"
fi

cd "$ROOT"
pnpm dev
