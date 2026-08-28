# Session Handoff

## Current state

Foundation work is on `foundation/series-engine-v0` and tracked by draft PR #1.

Implemented and committed:

- canonical `project_brain/` session handoff system;
- C++20 transactional semantic project graph with typed commands/events, optimistic revisions, locks, staleness, DAG validation, dependency invalidation, impact preview, snapshots, and guarded hydration;
- generic thread-safe local resource admission with explicit VRAM/RAM reserves, CPU budgets, exclusivity, and duplicate-work protection;
- embedded SQLite 3.53.4 persistence behind `SnapshotStore`, with WAL, foreign keys, full synchronization, transactional replacement, and load validation;
- SQLite schema v2 append-only native event journal with in-place migration from schema v1;
- `ProjectSession` application layer that stages mutations and atomically persists snapshot + native events before replacing live state;
- versioned JSONL IPC protocol v1 and `makewatch_engine_host` executable;
- typed native methods for health, snapshot, impact, apply, and project replacement;
- process-boundary smoke test that launches the real native host and writes/reads an SQLite-backed project;
- localhost-only development bridge with request correlation, RPC timeout, bounded request bodies, native failure propagation, and NVIDIA/system telemetry;
- React/TypeScript Studio driven by the real native snapshot, with real node selection, scene strip, revision display, approval, lock/unlock, impact preview, and GPU telemetry;
- draggable controlled workflow canvas with 8 px snap, local persistent node positions, dependency-aware Arrange, Fit/`F`, double-click focus, Scene Strip focus, and polished selected/dragging states;
- explicit semantic-state vs presentation-state boundary: dragging never mutates `ProjectEngine` or project revision;
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
- `RUNTIME_FOUNDATION.md` — public resource-safety layer.
- `AUTH_AND_AI_DIRECTOR.md` — Claude/Codex integration constraints.

## Validation status

Latest GitHub Actions is green across both jobs after draggable workflow, fixture migration, and journal work.

Validated in CI:

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
- real native-host process smoke test.

The primary Windows/NVIDIA machine already passed the earlier full foundation gate and subsequently opened the live native Studio successfully. The screenshot confirmed Native online, real GPU telemetry, persisted native graph, Inspector state, and Scene Strip rendering.

The **latest** drag-layout + fixture-v2 + journal/schema-v2 changes still need one hands-on Windows pull/verify/dev run before being treated as product-machine validated.

## Immediate next gate

On Windows:

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

In Studio:

1. confirm old local project opens without deleting `.makewatch/dev-project.sqlite3`;
2. confirm the bundled fixture is no longer globally stale at startup;
3. drag several nodes and verify smooth snap/reposition behavior;
4. stop and restart Studio/runtime and confirm node positions survive;
5. click **Arrange** and confirm deterministic dependency-aware layout;
6. press `F` and confirm the workflow fits the viewport;
7. click Scene Strip items and confirm the corresponding node is selected/centered;
8. approve/lock an editable native node and confirm project revision advances;
9. restart and confirm semantic changes survive through SQLite schema v2.

Any Windows process, SQLite migration, drag persistence, React Flow, or live-state defect found here must be fixed before moving on.

## Next engineering milestone after that gate

1. expose bounded native journal via `project.history` IPC;
2. add a premium Studio Activity/History surface using committed native events;
3. design verified checkpoints and recovery policy on top of snapshots + journal;
4. add content-addressed asset/provenance storage separated from semantic state;
5. add provider worker supervisor + capability discovery/health contract;
6. add first lightweight local voice and storyboard/image provider paths;
7. add Director provider adapter only after supported authentication behavior is verified.

## What not to do next

- Do not wire a heavyweight video model directly into React.
- Do not store workflow x/y coordinates in semantic node metadata.
- Do not let drag operations call `project.apply` or mutate dependencies implicitly.
- Do not let Node/React duplicate graph or persistence invariants.
- Do not make ComfyUI the project owner.
- Do not implement a fake/custom Claude subscription OAuth flow.
- Do not put OAuth tokens in `.env` as a shipping design.
- Do not treat the current event journal as a complete event-sourced replay engine yet.
- Do not weaken strict compilation/typechecking to make CI pass.
- Do not expose patent-sensitive adaptive synthesis-selection logic while the repository is public.

## Quality bar

Every milestone must remain buildable, testable, explainable, reversible, and explicit about what is actually validated. “100/100” is the quality target backed by evidence; it is not a claim that software can never contain defects.
