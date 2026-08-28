# Session Handoff

## Current state

Foundation work is on `foundation/series-engine-v0` and tracked by draft PR #1.

Implemented and committed:

- canonical `project_brain/` session handoff system;
- C++20 transactional semantic project graph with typed commands/events, optimistic revisions, locks, staleness, DAG validation, dependency invalidation, impact preview, snapshots, and guarded hydration;
- embedded SQLite 3.53.4 persistence behind `SnapshotStore`, with WAL, foreign keys, full synchronization, transactional replacement, and load validation;
- SQLite schema v2 append-only native event journal with in-place migration from schema v1;
- `ProjectSession` application layer that stages mutations and atomically persists snapshot + native events before replacing live state;
- durable versioned commit-context encoding on transaction events (`mwctx1`) for future human/AI/system history attribution;
- versioned JSONL IPC protocol v1 and `makewatch_engine_host` executable;
- typed native methods for health, snapshot, impact, apply, and project replacement;
- process-boundary smoke test that launches the real native host and writes/reads an SQLite-backed project;
- localhost-only development bridge with request correlation, RPC timeout, bounded request bodies, native failure propagation, NVIDIA/system telemetry, and commit-context forwarding envelope;
- React/TypeScript Studio driven by the real native snapshot, with real node selection, Scene Strip, revision display, approval, lock/unlock, impact preview, and GPU telemetry;
- draggable controlled workflow canvas with 8 px snap, local persistent node positions, dependency-aware Arrange, Fit/`F`, double-click focus, Scene Strip focus, and polished selected/dragging states;
- explicit semantic-state vs presentation-state boundary: dragging and camera motion never mutate `ProjectEngine` or project revision;
- typed AI Director Autopilot plan schema, bounded validator, cancellable executor, pause/resume/checkpoint control, and deterministic Assist-mode workspace planner;
- premium Studio virtual AI cursor with visible movement, press/ripple, contextual labels, takeover banner, progress, interaction lock, and emergency **Take back control** / `Esc` behavior;
- cinematic Autopilot workflow camera with dead-zone follow, edge protection, search-time zoom-out, manipulation-time zoom-in, and transient camera ownership so `fitView`/focus commands do not fight it;
- bounded Autopilot presentation-step watchdog: ordinary visual/read-only steps fail safely instead of holding interaction ownership forever;
- bounded visible workspace demonstration: a limited number of meaningful displaced nodes are physically handled by the cursor and repetitive remainder is settled in one deterministic presentation-only pass;
- final workspace demo no longer performs an unnecessary competing final fit pass after its completion message;
- semantic `applyCommands` remains authoritative and routes through the normal native command/transport boundary rather than an unsafe UI-only timeout race;
- hardened C++ `ResourceManager` with explicit VRAM/RAM reserves, CPU budget, duplicate protection, accurate GPU-only exclusivity semantics, non-mutating admission preview, projected headroom, peak/high-water telemetry, admission/rejection counters, and move-only scoped RAII `ResourceLease` ownership;
- CPU-only work can continue when an exclusive GPU job is active if RAM/CPU capacity fits; exclusive GPU policy now serializes GPU use rather than unrelated CPU work;
- development fixture v2 that completes topology, finalizes freshness, then applies locks;
- narrowly scoped automatic migration of the known old development fixture without requiring deletion of the local SQLite database;
- one-command Windows quality gate `./verify.ps1` plus `./dev.ps1` native+bridge+Studio runtime;
- provider-agnostic AI Director boundary; Claude/Codex natural-language authentication remains intentionally unimplemented rather than faked.

Subsystem context:

- `FOUNDATION_V1.md` — project graph semantics.
- `PERSISTENCE.md` — SQLite snapshot+journal boundary.
- `JOURNAL_AND_RECOVERY.md` — append-only native history and future recovery constraints.
- `IPC_AND_SESSION.md` — application transaction + native IPC + Studio bridge.
- `WORKSPACE_LAYOUT.md` — draggable presentation-only workflow layout.
- `AUTOPILOT.md` — typed AI takeover, virtual cursor, cinematic camera, interaction ownership, and safety rules.
- `RUNTIME_FOUNDATION.md` — public resource-safety and admission layer.
- `AUTH_AND_AI_DIRECTOR.md` — Claude/Codex integration constraints.

## Validation status

GitHub Actions is the code-level gate for every branch commit and must remain green across Studio and Native core before product-machine testing.

Previously validated in CI:

- bridge/fixture JavaScript invariant checks;
- strict shared and Studio TypeScript;
- Vite production build;
- strict native C/C++ configure/build;
- semantic graph tests;
- resource admission tests;
- SQLite snapshot tests;
- SQLite schema-v1 -> schema-v2 migration test;
- append-only event journal tests;
- ProjectSession persistence failure and no-false-history guarantees;
- IPC parser/dispatcher tests;
- real native-host process smoke test;
- Autopilot typed execution and production Studio build;
- cinematic camera/follower TypeScript integration;
- native resource preview, high-water accounting, GPU exclusivity, and scoped lease tests.

The primary Windows/NVIDIA machine already passed the earlier full foundation gate and opened the live native Studio successfully. A later hands-on run confirmed the Autopilot cursor works, but exposed two UX defects now addressed in code: cursor/camera visibility across distant workflow space and a workspace pass that felt like it did not finish cleanly after repetitive node work.

The **latest** bounded Autopilot + dynamic camera zoom + hardened ResourceManager changes need one fresh Windows pull/verify/dev run before being treated as product-machine validated.

## Known intentional boundary

Studio and the Node bridge already carry optional commit context (`actor`, `planId`, `reason`) and `ProjectSession` can persist durable provenance. The current protocol-v1 dispatcher still defaults context at the native boundary; parsing the optional IPC context envelope should be completed together with the bounded `project.history` protocol work before provider-driven semantic Autopilot is enabled.

This does **not** affect the current AI Workspace Drive demo because it is Assist-mode and issues no semantic mutations.

## Immediate next gate

On Windows:

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

In Studio:

1. manually move many workflow nodes far away from their organized positions;
2. click **Let AI drive this workflow**;
3. confirm the AI scans/widens the workflow naturally instead of blindly traversing off-screen space;
4. confirm the camera gently zooms out while locating distant nodes and tightens during active manipulation;
5. confirm the cursor stays visible inside the cinematic safe frame while the canvas moves beneath it;
6. confirm only a bounded number of representative nodes are physically dragged and repetitive remainder is settled together;
7. confirm the pass reaches a clear completion state and releases interaction ownership rather than appearing to run forever;
8. confirm ordinary canvas / Scene Strip / Inspector mutation is blocked only while Autopilot owns the workflow;
9. use `Space` to pause/resume and confirm no teleport after a long pause;
10. use `Esc` or **Take back control** and confirm immediate cancellation;
11. confirm Assist-mode layout work does **not** increment native project revision;
12. restart and confirm AI-arranged workspace positions survive;
13. manually approve/lock a native node and confirm semantic revision still advances and survives restart;
14. run `./verify.ps1` and confirm the hardened ResourceManager tests pass on GNU 15.2 / Windows as well as CI.

Any Windows process, resource accounting, camera, cancellation, SQLite, or live-state regression found here must be fixed before provider/media work.

## Next engineering milestone after that gate

1. expose bounded native journal via `project.history` IPC and parse commit provenance;
2. add a premium Studio Activity/History surface distinguishing human, AI, and system commits;
3. design verified checkpoints and recovery policy on top of snapshots + journal;
4. add content-addressed asset/provenance storage separated from semantic state;
5. add the bounded native pending-job layer, then provider worker supervisor + capability discovery/health contract;
6. make worker lifetime own `ResourceLease` reservations so crashed/finished jobs cannot leak admission accounting;
7. add native hardware-profile probing/calibration without making CUDA/NVIDIA a mandatory dependency for all installs;
8. add first lightweight local voice and storyboard/image provider paths;
9. add Claude/Codex Director plan-producer adapters only after supported authentication behavior is verified.

## What not to do next

- Do not wire a heavyweight video model directly into React.
- Do not store workflow x/y coordinates or camera transforms in semantic node metadata.
- Do not let drag operations call `project.apply` or mutate dependencies implicitly.
- Do not give AI providers unrestricted OS mouse/keyboard access as the normal interaction model.
- Do not let provider text directly invoke arbitrary DOM handlers; providers emit typed plans.
- Do not let Assist mode perform semantic mutation.
- Do not remove `Esc` / Take-back control from Autopilot.
- Do not add a UI-only race timeout around an authoritative semantic commit.
- Do not let a scheduling optimization bypass `ResourceManager` admission.
- Do not treat CPU-only work as GPU work for exclusivity purposes.
- Do not let Node/React duplicate graph or persistence invariants.
- Do not make ComfyUI the project owner.
- Do not implement a fake/custom Claude subscription OAuth flow.
- Do not put OAuth tokens in `.env` as a shipping design.
- Do not treat the current event journal as a complete event-sourced replay engine yet.
- Do not weaken strict compilation/typechecking to make CI pass.
- Do not expose patent-sensitive adaptive synthesis-selection logic while the repository is public.

## Quality bar

Every milestone must remain buildable, testable, explainable, reversible, and explicit about what is actually validated. “100/100” is the quality target backed by evidence; it is not a claim that software can never contain defects.
