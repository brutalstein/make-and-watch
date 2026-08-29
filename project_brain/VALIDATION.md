# Validation Record

This file records what was actually executed, not what is merely expected to work.

## Foundation history

The repository has progressively passed isolated native validation, strict GitHub Actions, and an earlier full Windows/NVIDIA quality gate. Existing validated areas include the transactional semantic graph, SQLite persistence and v1→v2 migration, ProjectSession persist-before-live-commit semantics, JSONL native IPC, process-boundary host smoke, native-driven Studio state, draggable presentation-only workflow layout, development-fixture migration, append-only journal, typed Autopilot, cinematic camera, and hardened ResourceManager.

The primary Windows development environment previously observed was Node v24.11.0, pnpm 10.15.0, CMake 4.1.2, Ninja 1.13.1, GNU C/C++ 15.2 via MSYS2 UCRT64, and an NVIDIA GeForce RTX 5070 Laptop GPU with 8151 MB reported by system doctor. The earlier full `./verify.ps1` gate passed with zero native test failures, and the live native Studio subsequently opened successfully.

## Defects caught rather than hidden

CI and product-machine validation have caught legitimate defects during foundation work, including bootstrap/cache configuration, TypeScript emit configuration, missing explicit C++ includes, a locked-before-topology development seed, a SQLite overload ambiguity, stale test-double APIs, and Autopilot presentation defects. These were fixed without weakening warning, type, lock, persistence, or transaction invariants.

## 2026-08-29 — Deterministic Autopilot performance governor

Hands-on use showed that the AI workspace pass could still move too quickly and temporarily freeze. Review identified three high-frequency presentation sources: cursor state lived in the root React application, controlled node drag mutated React Flow at display-refresh cadence, and camera observation/viewport writes could also run at display refresh rate.

The implementation now provides:

- virtual cursor state isolated through a small external `useSyncExternalStore` presentation store;
- fixed-frame **24 FPS** cursor and node animation rather than unrestricted display refresh rate;
- frame-index progress so pause/background stalls slow motion instead of teleporting it forward;
- distance-aware bounded cursor travel duration;
- slower deterministic visible node-drag pacing;
- at most five representative visible node drags before repetitive remainder settles in one dependency-aware presentation pass;
- explicit breathing/reframe pauses;
- stale edge animation suspended during Autopilot takeover;
- camera DOM/React Flow observation capped at 24 FPS even on 144/165 Hz displays;
- no more than one outstanding React Flow viewport write;
- bounded/damped pan and zoom;
- presentation-step liveness deadlines while semantic native commits remain owned by transport + `ProjectSession` transaction correlation.

Strict Studio TypeScript and Vite production build passed after this refactor.

## 2026-08-29 — Bounded attributed native history and Activity

The planned history milestone was implemented together with the performance work.

Protocol v1 now supports:

- `project.apply` command batches bounded to 1..128 items;
- validated commit actor: `user`, `ai_director`, or `system`;
- bounded source, plan ID, and reason context;
- native parsing/persistence of commit context;
- `project.history` bounded to 1..24 complete committed revision groups;
- finite native event budget and grouping by project revision;
- omission of a truncated group that lacks its `transaction.committed` marker;
- native decoding of versioned `mwctx1` provenance so storage encoding never leaks into React/Node.

Shared TypeScript contracts, localhost bridge, and Studio now expose a **Durable Activity** feed showing recent committed native revisions with You / AI Director / System attribution. Activity is revision-based; no timestamp or schema migration was invented.

The first native build of the history change caught a genuine C++ constness error in a local flush lambda. The code was corrected (`auto` callable closure rather than a const mutable closure), and test headers were made explicit instead of relying on transitive includes.

The subsequent native configure/build/CTest passed. The real `makewatch_engine_host` process smoke was expanded to perform an attributed SQLite mutation and read actor/source/reason back through `project.history` over stdin/stdout.

## 2026-08-29 — Current final CI result

Current branch HEAD passed GitHub Actions completely:

- bridge/fixture JavaScript checks: passed;
- strict shared/Studio TypeScript: passed;
- Vite production build: passed;
- native C/C++ configure: passed;
- strict native build: passed;
- complete CTest suite: passed;
- attributed dispatcher/history tests: passed;
- real engine-host + SQLite + history process smoke: passed.

## Required product-machine gate

The latest deterministic presentation governor and Durable Activity/history build is CI-green but still requires a fresh hands-on Windows/NVIDIA run before being called product-machine validated.

From repository root:

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

Verify:

1. scatter many workflow nodes far from organized positions;
2. launch **Let AI drive this workflow**;
3. cursor/node movement is visibly slower and readable;
4. Inspector/topbar remain responsive during cursor travel;
5. camera follows smoothly without high-refresh-rate oscillation/backlog;
6. only a bounded representative set is individually dragged;
7. the pass clearly completes and returns manual control;
8. a long `Space` pause/resume does not teleport;
9. `Esc` / **Take back control** cancels immediately;
10. Assist layout does not advance native project revision;
11. AI-arranged positions survive restart;
12. Durable Activity displays persisted revisions;
13. manually lock/unlock or approve and confirm a new **You** Activity entry appears with the new revision;
14. restart and confirm Activity survives SQLite reopen;
15. older pre-attribution history may appear as System, while new manual commits must be attributed;
16. `./verify.ps1` passes the expanded IPC/history/ResourceManager suite under Windows GNU 15.2;
17. native connection and real GPU telemetry remain healthy.

After this gate, the next engineering sequence is checkpoint/recovery policy, content-addressed asset/provenance storage, bounded native pending-job queue, worker supervision with scoped `ResourceLease`, hardware profile/calibration, and first lightweight local media providers.
