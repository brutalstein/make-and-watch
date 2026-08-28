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

CTest launches the real `makewatch_engine_host` executable, feeds JSONL through stdin, performs an SQLite-backed `node.create`, requests a snapshot, verifies successful RPC responses, verifies the persisted node is returned, and confirms the project database is created. GitHub Actions passed the complete native suite including this process boundary.

## 2026-08-29 — Windows live Studio seed bug and regression protection

The first live `./dev.ps1` run on Windows exposed a legitimate development-fixture defect: `scene.01` was created locked before its dependency edge to the episode was added. The native engine correctly rejected this with `locked node dependency topology cannot change`.

The engine invariant was preserved. The fixture was changed to create nodes unlocked, build the full topology, finalize freshness, then lock creative anchors. `dev-seed-check.mjs` now fails CI if topology is changed after locking or if a fixture node is not finalized fresh.

The user subsequently opened the live Studio successfully on Windows, proving the native host, bridge, SQLite project, real NVIDIA telemetry, and native graph rendering path on the product machine.

## 2026-08-29 — Draggable workflow workspace

Studio was converted to a controlled React Flow canvas with presentation-only drag state.

Latest CI passed:

- strict TypeScript for controlled React Flow node state;
- production Vite build;
- bridge/seed JavaScript checks.

Implemented behavior includes draggable nodes, 8 px snap grid, locally persisted layout, dependency-aware deterministic Arrange, Fit action / `F` shortcut, double-click focus, Scene Strip focus, smooth semantic edges, and selected/dragging visual states.

The important invariant is validated architecturally: drag/layout state does not call `project.apply`, does not change native project revision, and does not alter semantic dependency topology.

## 2026-08-29 — Development fixture v2 migration

The bundled development fixture now carries `devSeedVersion=2` and marks its complete topology fresh before applying final locks. The localhost development bridge detects the known old `series.afterlight` fixture and performs a narrowly scoped native migration without deleting the user's local development SQLite database.

This migration path is intentionally limited to the bundled development fixture and is not a generic user-project auto-mutation mechanism.

## 2026-08-29 — SQLite schema v2 append-only journal

SQLite schema was advanced from v1 to v2. `ProjectSession` now forwards the successful native event batch together with the staged snapshot to `SnapshotStore::save_commit`.

GitHub Actions passed the native build and test suite covering:

- atomic snapshot + event-journal commit;
- no journal append when persistence fails;
- append-only history across later snapshot replacement;
- stable event order within a project revision;
- affected-entity persistence;
- journal survival across close/reopen;
- closed-store rejection;
- construction of a real schema-v1 SQLite fixture;
- in-place v1 -> v2 migration;
- successful snapshot+journal commit after migration.

The latest code-level CI is green for both Studio and Native core after these changes.

## Current required product-machine gate

The latest draggable-layout + fixture-v2 + SQLite-journal code has passed CI but has not yet been re-run on the primary Windows machine.

From the repository root:

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

Verify:

1. the existing development database migrates without manual deletion;
2. the fixture no longer starts with almost every node stale;
3. nodes can be dragged and snap smoothly;
4. dragged positions survive a Studio/runtime restart;
5. **Arrange** restores deterministic dependency-aware positions;
6. `F` fits the graph;
7. native approval/lock mutations still persist after restart;
8. no Windows path/process/SQLite regression appears after schema v2 migration.

Only after this hands-on gate should the journal be surfaced through IPC/Studio history and media-provider work proceed.
