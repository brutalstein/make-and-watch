# Validation Record

This file records what was actually executed, not what is merely expected to work.

## 2026-08-28 — Initial native foundation

The committed native foundation was reconstructed in an isolated local test directory and executed with GCC 14.2.0, CMake 3.31.6, and Ninja 1.12.1. The initial `ctest` suite passed 1/1 tests.

## 2026-08-28 — Studio foundation CI

Draft PR #1 established GitHub Actions checks for both native and Studio code. CI initially exposed two real setup defects and they were fixed without weakening strictness:

1. pnpm caching was requested before a lockfile existed.
2. `tsconfig.node.json` had an invalid `allowImportingTsExtensions`/emit combination.

The corrected Studio job passed:

- pnpm workspace install;
- strict TypeScript typecheck;
- Vite production build.

## 2026-08-29 — Transactional project graph

The native suite was expanded with a real in-memory project-state engine. CI passed tests covering:

- atomic command batches and rollback;
- project and node revisions;
- optimistic-concurrency conflicts;
- dependency cycle rejection;
- lock enforcement;
- lock/stale separation;
- transitive dependency invalidation;
- stale approval gate;
- removal/edge cleanup;
- non-mutating impact preview;
- deterministic snapshots;
- guarded hydration and atomic snapshot validation.

## 2026-08-29 — Runtime resource safety

CI passed the C++ `ResourceManager` tests covering:

- explicit VRAM and RAM reserves;
- CPU-thread admission budgets;
- rejection before unsafe overcommit;
- duplicate workload protection;
- exclusive-GPU workload policy;
- release/reuse accounting;
- refusal to reconfigure while work is active.

This is a generic hard safety layer, not the unpublished adaptive synthesis-selection algorithm.

## 2026-08-29 — Embedded SQLite persistence

The native project was extended to C + C++ and pins the official SQLite 3.53.4 amalgamation by SHA3-256. The first CI run correctly failed because `sqlite_snapshot_store.cpp` used `ProjectGraph` without an explicit definition include. That defect was fixed rather than hidden through compiler-policy changes.

The corrected GitHub Actions run then passed:

- C/C++ configure;
- embedded SQLite compilation;
- Make & Watch engine compilation under strict warnings;
- Director validation tests;
- project graph tests;
- resource admission tests;
- SQLite save/load round-trip and overwrite tests;
- Studio strict typecheck and production build.

Persistence behavior validated by tests includes schema bootstrap, transactional snapshot replacement, metadata/dependency round-trip, latest-revision overwrite, hydration after load, and closed-store rejection.

## Current product-machine gate

The code-level CI is green. The next required validation is the primary Windows/NVIDIA machine. From the repository root:

```powershell
 git pull
 .\verify.ps1
```

`verify.ps1` runs the system doctor, pnpm install, strict TypeScript typecheck, Studio production build, native CMake configure/build, and the complete CTest suite. After it passes, run `./dev.ps1` and perform the visual/premium Studio review.

Any Windows compiler, filesystem, SQLite, path, or UI issue discovered there must be fixed on the foundation branch before moving to IPC/media-provider work.
