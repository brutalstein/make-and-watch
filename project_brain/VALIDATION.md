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
- Vite production build: passed;
- native C/C++ configure: passed;
- native build: passed;
- CTest: passed with zero failures.

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

Studio hardcoded workflow state was replaced by a native snapshot client. CI passed localhost bridge syntax validation, strict shared/Studio TypeScript, and the Vite production build.

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

CI passed strict TypeScript for controlled React Flow state, the production Vite build, and bridge/fixture checks.

Implemented behavior includes draggable nodes, 8 px snap grid, locally persisted layout, dependency-aware deterministic Arrange, Fit action / `F` shortcut, double-click focus, Scene Strip focus, smooth semantic edges, and selected/dragging visual states.

The important invariant is validated architecturally: drag/layout state does not call `project.apply`, does not change native project revision, and does not alter semantic dependency topology.

## 2026-08-29 — Development fixture v2 migration

The bundled development fixture carries `devSeedVersion=2` and marks its complete topology fresh before applying final locks. The localhost development bridge detects the known old `series.afterlight` fixture and performs a narrowly scoped native migration without deleting the user's local development SQLite database.

This migration path is intentionally limited to the bundled development fixture and is not a generic user-project auto-mutation mechanism.

## 2026-08-29 — SQLite schema v2 append-only journal

SQLite schema advanced from v1 to v2. `ProjectSession` forwards the successful native event batch together with the staged snapshot to `SnapshotStore::save_commit`.

GitHub Actions passed tests covering:

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

## 2026-08-29 — AI Director Autopilot execution harness

Studio gained a typed AI takeover subsystem intended for users who do not want to understand or manually operate node workflows.

Implemented code-level capabilities include versioned `AutopilotPlan`, Assist/Guided/Director modes, exact-revision validation, bounded plan inputs, cancellable execution control, pause/resume/checkpoints, virtual AI cursor, takeover interaction lock, emergency `Esc`/Take-back control, native impact inspection, animated node dragging, and a deterministic Assist-mode Workspace Drive.

GitHub Actions passed strict Studio TypeScript and production Vite build with this integration.

Native commit-context support was extended so future semantic Autopilot transactions can carry durable provenance. CI caught an ambiguous `SqliteSnapshotStore::save_commit` overload and a stale `FakeStore` override; both were fixed without relaxing warnings or storage semantics. ProjectSession tests verify AI commit context reaches persistence and is encoded in the transaction event using versioned `mwctx1` detail.

## 2026-08-29 — Cinematic Autopilot camera and bounded liveness

Hands-on use exposed two UX defects in the first Autopilot iteration: the virtual cursor could leave the visible workflow area when the canvas was looking elsewhere, and a large presentation-layout pass could feel as though it never finished because it physically traversed every displaced node and then performed additional camera work.

The Studio implementation was refactored with a dedicated `AutopilotCameraFollower` and bounded workspace choreography.

Current code-level behavior:

- a workflow safe/dead frame keeps the AI action visible without permanently centering it;
- canvas pan follows the selected semantic node only when cursor motion requires it;
- distant-node search gradually widens the camera;
- active manipulation gently tightens the camera;
- pan/zoom deltas are damped and bounded per animation frame;
- camera ownership is transient and yields to explicit focus/fit operations after cursor motion settles;
- the initial takeover banner does not move the graph until the cursor enters the workflow;
- cursor labels flip near frame edges;
- pause/background suspension does not count as active cursor animation time;
- the deterministic demo physically drags at most six meaningful displaced nodes;
- repetitive remainder is settled in one dependency-aware presentation-only pass;
- periodic reframing makes the workflow feel explored instead of mechanically traversed;
- the previous unnecessary final fit pass was removed after the completion message;
- focus/drag/impact/arrange/fit presentation steps have a 10-second liveness watchdog and fail safely instead of retaining interaction ownership forever;
- user approval checkpoints remain intentionally unbounded;
- authoritative semantic `applyCommands` is deliberately not wrapped in a second UI race timeout; native transport/transaction correlation owns that boundary.

GitHub Actions passed strict Studio TypeScript and the Vite production build after these changes.

## 2026-08-29 — Hardened native ResourceManager

The generic C++ resource-safety layer was reviewed before introducing workers. The review found an overly broad exclusivity rule: an exclusive GPU request previously conflicted with all active work rather than only GPU-using work. This could unnecessarily serialize CPU-only audio/metadata workloads.

The implementation now provides:

- GPU-use classification based on VRAM/exclusive-GPU requirements;
- exclusive GPU serialization only against other GPU-using work;
- continued CPU-only admission during an exclusive GPU reservation when RAM/CPU budgets fit;
- non-mutating `preview_admission()` using the same policy as real acquisition;
- projected VRAM/RAM/CPU usage and post-admission headroom;
- active GPU workload count;
- VRAM/RAM/CPU high-water marks;
- admission/rejection counters;
- move-only RAII `ResourceLease` ownership through `try_acquire_scoped()` so normal early-return/exception paths can release reservations automatically;
- explicit ResourceManager-outlives-lease lifetime rule.

Expanded native tests cover non-mutating preview, protected VRAM headroom, outcome counters, high-water metrics, GPU-only exclusivity behavior, CPU-only coexistence, move ownership, automatic scoped release, duplicate protection, and configuration guards.

GitHub Actions completed native configure, strict build, and the full CTest suite successfully on the current code-level milestone.

A bounded native pending-job queue was considered next, but no partial implementation was committed when the repository connector refused that new-file write. The runtime therefore remains intentionally at the resource-admission boundary; the job queue must not be claimed as implemented.

## Current required product-machine gate

The latest bounded Autopilot + dynamic camera + ResourceManager changes are green in CI but still require one fresh end-to-end run on the primary Windows/NVIDIA development machine.

From the repository root:

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

Verify:

1. manually move many workflow nodes far away from their organized positions;
2. launch **Let AI drive this workflow**;
3. the AI should scan/reframe the workflow naturally rather than mechanically traversing every node;
4. the camera should widen while locating distant nodes and gently tighten during manipulation;
5. the virtual cursor should remain inside the cinematic safe frame while the canvas moves underneath it;
6. only a bounded set of representative nodes should be physically dragged, with repetitive remainder settled together;
7. the workflow pass must reach a clear completion state and release manual interaction ownership;
8. `Space` pause/resume should not produce cursor teleporting even after a long pause;
9. `Esc` and **Take back control** should cancel immediately;
10. Assist-mode layout work must not advance native project revision;
11. AI-arranged positions must survive restart;
12. manual approve/lock must still advance native project revision and survive SQLite restart;
13. `./verify.ps1` must pass the expanded ResourceManager tests on the Windows GNU 15.2 toolchain;
14. native connection and real GPU telemetry must remain healthy throughout.

After this product-machine gate, the next engineering sequence is bounded native history/provenance UI, checkpoint/recovery policy, content-addressed asset storage, native pending-job queue, worker supervision with scoped resource leases, hardware-profile probing, and the first lightweight local media provider paths.
