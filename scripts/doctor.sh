#!/usr/bin/env bash
set -euo pipefail

ok=1

status() {
  local state="$1" label="$2" detail="${3:-}"
  case "$state" in
    OK)   printf '\033[32m[%-4s]\033[0m %-18s \033[90m%s\033[0m\n' "$state" "$label" "$detail" ;;
    WARN) printf '\033[33m[%-4s]\033[0m %-18s \033[90m%s\033[0m\n' "$state" "$label" "$detail" ;;
    *)    printf '\033[31m[%-4s]\033[0m %-18s \033[90m%s\033[0m\n' "$state" "$label" "$detail" ;;
  esac
}

check() {
  local cmd="$1"
  shift
  if command -v "$cmd" >/dev/null 2>&1; then
    status OK "$cmd" "$("$cmd" "$@" 2>&1 | head -n 1)"
  else
    status MISS "$cmd" required
    ok=0
  fi
}

printf '\n\033[35m  MAKE & WATCH  /  SYSTEM DOCTOR\033[0m\n'
printf '\033[90m  Local-first production environment check\033[0m\n\n'

check node --version
check pnpm --version
check cmake --version
check ninja --version

if command -v nvidia-smi >/dev/null 2>&1; then
  gpu="$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null | head -n 1 || true)"
  status OK "NVIDIA GPU" "${gpu:-detected}"
else
  status WARN "NVIDIA GPU" "not detected; Studio can still run, media capability will be limited"
fi

printf '\n'
if [[ "$ok" -eq 1 ]]; then
  printf '\033[32mEnvironment foundation is ready.\033[0m\n'
  exit 0
fi

printf '\033[31mRequired development dependencies are missing.\033[0m\n'
exit 1
