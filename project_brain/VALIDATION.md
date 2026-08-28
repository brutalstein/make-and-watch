# Validation Record

This file records what was actually executed, not what is merely expected to work.

## 2026-08-28 — Initial native foundation

The committed native foundation was reconstructed in an isolated local environment with GCC 14.2.0, CMake 3.31.6, and Ninja 1.12.1. The initial CTest suite passed 1/1.

## 2026-08-28 — Studio foundation CI

Draft PR #1 established GitHub Actions checks for native and Studio code. CI exposed and we fixed two legitimate bootstrap/type-system defects without reducing strictness: pnpm cache configuration before a lockfile existed and an invalid TypeScript emit setting. Studio install, strict typecheck, and production build then passed.

## 2026-08-29 — Transactional graph, runtime guard, and SQLite

GitHub Actions passed the expanded native foundation covering atomic command batches, optimistic revisions, lock/stale separation, dependency cycles, transitive invalidation, impact preview, deterministic snapshots/hydration, VRAM/RAM/CPU admission, exclusivity, duplicate workload protection, and embedded SQLite transactional save/load.

When SQLite persistence first landed, CI found that `sqlite_snapshot_store.cpp` used `ProjectGraph` without its explicit definition include. The include was fixed; warning policy was not relaxed.

## 2026-08-29 — Primary Windows foundation gate

The user executed `git pull` followed by `./verify.ps1` on the primary Windows/NVIDIA development machine.

Observed environment:

- Node v24.11.0
- pnpm 10.15.0
- CMake 4.1.2
- Ninja 1.13.1
- GNU C and C++ 15.2.0 via MSYS2 UCRT64
- NVIDIA GeForce RTX 5070 Laptop GPU, 8151 MB reported by system doctor

Observed results:

- pnpm workspace installation: passed;
- strict shared-contract TypeScript: passed;
- Studio TypeScript project build: passed;
- Vite production build: passed (1740 transformed modules);
- native C/C++ configure: passed;
- native build: passed;
- CTest: 4/4 passed, 0 failed.

This proved the project graph, resource manager, SQLite persistence, and Studio static build foundation on the real Windows toolchain before native IPC was introduced.

## 2026-08-29 — ProjectSession and IPC

The native application layer was expanded with `ProjectSession` and protocol-v1 `ipc::Dispatcher`.

CI passed tests proving:

- mutation is applied to staged native state first;
- a persistence failure does not advance live project revision or mutate live graph;
- invalid project replacement is rejected before persistence;
- load failure preserves existing live state;
- health/snapshot/apply/impact RPC calls route through the native engine;
- protocol mismatch, malformed JSON, and unknown methods return typed failures.

## 2026-08-29 — Live Studio bridge

Studio hardcoded workflow state was replaced by a native snapshot client. CI passes:

- localhost bridge JavaScript syntax validation;
- shared strict TypeScript contracts;
- Studio strict typecheck;
- Vite production build.

The bridge is transport-only: native project state remains authoritative. Real NVIDIA telemetry is observational and does not replace native resource admission.

CI caught a missing Vite `ImportMeta.env` type declaration on the first bridge build. A typed `vite-env.d.ts` was added instead of weakening TypeScript.

## 2026-08-29 — Native executable process smoke

CTest now launches the real `makewatch_engine_host` executable, feeds JSONL through stdin, performs an SQLite-backed `node.create`, requests a snapshot, verifies three successful RPC responses, verifies the persisted node is returned, and confirms the project database was created. GitHub Actions passed the complete native suite including this process boundary.

## Current required product-machine gate

The latest code-level CI is green. The new native-host + Node bridge + live Studio integration must now be pulled and exercised on the primary Windows machine:

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

The current `verify.ps1` additionally validates local bridge syntax and the expanded native suite. After it passes, perform the interaction/restart persistence checks listed in `HANDOFF.md` before beginning local media-provider integration.
