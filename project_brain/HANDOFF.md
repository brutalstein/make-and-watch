# Session Handoff

## Current state

Foundation work is on `foundation/series-engine-v0` and tracked by draft PR #1.

Implemented and committed:

- canonical `project_brain/` session handoff system;
- C++20 transactional semantic project graph with typed commands/events, optimistic revisions, locks, staleness, DAG validation, dependency invalidation, impact preview, snapshots, and guarded hydration;
- embedded SQLite 3.53.4 persistence behind `SnapshotStore`, with WAL, foreign keys, full synchronization, transactional replacement, and load validation;
- SQLite schema v2 append-only native event journal with in-place migration from schema v1;
- `ProjectSession` stages mutations and atomically persists snapshot + native events before replacing live state;
- durable versioned commit context (`mwctx1`) with actor/source/plan/reason attribution;
- versioned JSONL IPC protocol v1 and `makewatch_engine_host`;
- native methods for health, snapshot, impact, apply, bounded history, and project replacement;
- `project.apply` now validates/bounds commit context and 1..128 command batches before native mutation;
- bounded `project.history` returns 1..24 complete committed revision groups with parsed native attribution instead of leaking storage encoding;
- real process-boundary smoke test covers SQLite mutation, snapshot, attributed history, and host stdin/stdout transport;
- localhost bridge with correlation, timeout, bounded request bodies, native failure propagation, bounded history route, and NVIDIA/system telemetry;
- React/TypeScript Studio driven by the real native snapshot;
- draggable controlled workflow canvas with 8 px snap, local persistent positions, dependency-aware Arrange, Fit/`F`, focus, Scene Strip, approval/lock/impact and real GPU telemetry;
- semantic vs presentation boundary: drag/camera/layout never mutate `ProjectEngine` or project revision;
- typed AI Director Autopilot schema, validator, cancellable executor, pause/resume/checkpoints, and deterministic Assist-mode planner;
- premium virtual AI cursor, takeover banner, interaction lock, `Esc` / **Take back control**, and `Space` pause/resume;
- cinematic workflow camera with dead-zone follow, edge protection, search-time widen, manipulation-time tighten and transient ownership;
- explicit **24 FPS Autopilot presentation governor** for cursor, node motion and camera observation;
- virtual cursor state isolated with `useSyncExternalStore`, so cursor frames no longer re-render the whole Studio application tree;
- distance-aware readable cursor pacing and deterministic frame-index animation; pause/background stalls do not teleport progress;
- camera DOM/React Flow observation is capped at 24 FPS and only one viewport write may be outstanding;
- stale edge animation is disabled during takeover to reduce unnecessary presentation load;
- Workspace Drive physically handles at most five representative displaced nodes; repetitive remainder settles in one deterministic presentation-only pass;
- presentation-step watchdog prevents visual/read-only steps from holding takeover forever;
- authoritative semantic `applyCommands` deliberately remains owned by transport + native transaction correlation, not a competing UI race timeout;
- premium Inspector **Durable Activity** feed backed by native `project.history`, distinguishing You / AI Director / System and allowing focus on a surviving primary entity;
- Activity is revision-based and persisted across restart; no synthetic timestamps/schema migration were invented;
- hardened C++ `ResourceManager` with VRAM/RAM reserves, CPU budget, duplicate protection, correct GPU-only exclusivity, admission preview, projected headroom, high-water telemetry, counters, and move-only RAII `ResourceLease`;
- CPU-only work may continue alongside exclusive GPU work when RAM/CPU capacity fits;
- development fixture v2 with topology-first, freshness-finalization, locks-last plus scoped old-fixture migration;
- one-command Windows quality gate `./verify.ps1` and `./dev.ps1` live runtime;
- provider-agnostic AI Director boundary; Claude/Codex authentication remains intentionally unimplemented rather than faked.

Subsystem context:

- `FOUNDATION_V1.md` — semantic project graph.
- `PERSISTENCE.md` — SQLite snapshot+journal boundary.
- `JOURNAL_AND_RECOVERY.md` — native history and future recovery constraints.
- `IPC_AND_SESSION.md` — transaction, IPC, bounded history, bridge.
- `WORKSPACE_LAYOUT.md` — presentation-only workflow layout.
- `AUTOPILOT.md` — typed takeover, deterministic presentation governor, camera, safety.
- `RUNTIME_FOUNDATION.md` — resource-safety/admission layer.
- `AUTH_AND_AI_DIRECTOR.md` — Claude/Codex constraints.

## Validation status

GitHub Actions is the code-level gate for every branch commit and must remain green across Studio and Native core before product-machine validation.

Validated in CI across milestones:

- bridge/fixture JavaScript checks;
- strict shared/Studio TypeScript and Vite production build;
- strict native C/C++ configure/build;
- semantic graph tests;
- ResourceManager preview/high-water/exclusivity/scoped-lease tests;
- SQLite snapshot/journal + schema-v1→v2 migration tests;
- ProjectSession persistence-failure/no-false-history guarantees;
- IPC parser/dispatcher tests;
- attributed context parsing and bounded history tests;
- real native-host process smoke test including durable history;
- Autopilot production build and camera/cursor integration.

During the history milestone, CI caught a legitimate C++ lambda constness error in `history_json`; it was fixed in code without reducing warnings. Test includes were also made explicit instead of relying on transitive headers.

The primary Windows/NVIDIA machine previously passed the full foundation gate and opened the live native Studio. Hands-on Autopilot testing then exposed cursor visibility, endless-feeling traversal, excessive speed, and transient freezing. The current code addresses those with bounded choreography and the 24 FPS presentation governor, but this newest performance/history build still requires a fresh Windows live run before being called product-machine validated.

## Immediate next gate

On Windows:

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

In Studio:

1. manually scatter many nodes far from organized positions;
2. run **Let AI drive this workflow**;
3. confirm motion is visibly slower/readable rather than racing;
4. confirm UI remains responsive while cursor moves — Inspector/topbar should not freeze with every cursor frame;
5. confirm camera follows smoothly without high-refresh-rate oscillation/backlog;
6. confirm only five representative nodes at most are individually dragged and repetitive remainder settles together;
7. confirm pass reaches completed state and manual control returns;
8. pause for several seconds with `Space`, resume, and confirm no teleport;
9. cancel with `Esc` / **Take back control** and confirm immediate ownership return;
10. confirm Assist-mode layout does not advance native revision;
11. restart and confirm layout persistence;
12. inspect **Durable Activity** in the Inspector;
13. manually lock/unlock or approve a node and confirm a new **You** history entry appears with the new native revision;
14. restart and confirm Activity survives because it is read from SQLite journal;
15. older unattributed commits may appear as System; new manual commits must be attributed;
16. `./verify.ps1` must pass expanded native history/ResourceManager tests on Windows GNU 15.2.

Any freeze, camera backlog, Activity attribution/history, SQLite, or resource-accounting regression found here must be fixed before media/provider work.

## Next engineering milestone after that gate

1. checkpoint/recovery policy on top of snapshot + journal;
2. content-addressed asset/provenance storage separated from semantic graph state;
3. bounded native pending-job queue;
4. worker supervisor + capability/health contract, with worker lifetime owning `ResourceLease`;
5. native hardware-profile probing/calibration without making CUDA/NVIDIA mandatory for all installs;
6. first lightweight local voice and storyboard/image provider paths;
7. Claude/Codex Director plan producers only after supported authentication behavior is reverified.

## What not to do next

- Do not wire heavyweight models directly into React.
- Do not store workspace x/y or camera transforms in semantic metadata.
- Do not let cosmetic drag call `project.apply`.
- Do not give providers unrestricted OS mouse/keyboard authority.
- Do not map provider text directly to arbitrary DOM handlers.
- Do not let Assist mode mutate semantic state.
- Do not remove emergency takeover.
- Do not add a UI-only race timeout around an authoritative semantic commit.
- Do not drive Autopilot presentation at unrestricted display refresh rate.
- Do not let scheduling bypass `ResourceManager`.
- Do not classify CPU-only work as GPU work for exclusivity.
- Do not let React/Node duplicate graph/persistence invariants or parse SQLite provenance encoding.
- Do not make ComfyUI project-state owner.
- Do not implement fake/custom Claude subscription OAuth or ship OAuth tokens in `.env`.
- Do not treat the journal as a full event-sourced replay engine yet.
- Do not weaken strict compiler/type gates.
- Do not expose patent-sensitive adaptive synthesis-selection logic while repo is public.

## Quality bar

Every milestone must remain buildable, testable, explainable, reversible, bounded, and explicit about what is actually validated. “100/100” is the quality target backed by evidence; it is not a claim that software can never contain defects.
