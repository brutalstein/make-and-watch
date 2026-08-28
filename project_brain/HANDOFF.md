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
- durable versioned commit-context encoding on transaction events (`mwctx1`) for future human/AI/system history attribution;
- versioned JSONL IPC protocol v1 and `makewatch_engine_host` executable;
- typed native methods for health, snapshot, impact, apply, and project replacement;
- process-boundary smoke test that launches the real native host and writes/reads an SQLite-backed project;
- localhost-only development bridge with request correlation, RPC timeout, bounded request bodies, native failure propagation, NVIDIA/system telemetry, and commit-context forwarding envelope;
- React/TypeScript Studio driven by the real native snapshot, with real node selection, Scene Strip, revision display, approval, lock/unlock, impact preview, and GPU telemetry;
- draggable controlled workflow canvas with 8 px snap, local persistent node positions, dependency-aware Arrange, Fit/`F`, double-click focus, Scene Strip focus, and polished selected/dragging states;
- explicit semantic-state vs presentation-state boundary: dragging never mutates `ProjectEngine` or project revision;
- typed AI Director Autopilot plan schema, bounded validator, cancellable executor, pause/resume/checkpoint control, and deterministic Assist-mode workspace planner;
- premium Studio virtual AI cursor with visible movement, press/ripple, contextual labels, takeover banner, progress, interaction lock, and emergency **Take back control** / `Esc` behavior;
- Autopilot can visibly focus, inspect, and drag workflow nodes while preserving presentation-vs-semantic ownership;
- semantic `applyCommands` is available in the Autopilot executor and always routes through the normal native command boundary; current bundled demo intentionally stays Assist-only and therefore does not mutate semantic project state;
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
- `AUTOPILOT.md` — typed AI takeover, virtual cursor, interaction ownership, and safety rules.
- `RUNTIME_FOUNDATION.md` — public resource-safety layer.
- `AUTH_AND_AI_DIRECTOR.md` — Claude/Codex integration constraints.

## Validation status

The Autopilot Studio integration passes strict TypeScript and production Vite build in GitHub Actions. Native commit-context work initially exposed two legitimate C++ API/test integration defects (an overload ambiguity and a stale `FakeStore` override); both were fixed without weakening warning or type policy. The latest ProjectSession test additionally checks that AI commit context reaches the persistence boundary and is encoded in the transaction event.

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
- real native-host process smoke test.

The primary Windows/NVIDIA machine already passed the earlier full foundation gate and subsequently opened the live native Studio successfully. The screenshot confirmed Native online, real GPU telemetry, persisted native graph, Inspector state, and Scene Strip rendering.

The **latest** draggable-layout + fixture-v2 + journal + Autopilot changes need one hands-on Windows pull/verify/dev run before being treated as product-machine validated.

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

1. confirm old local project opens without deleting `.makewatch/dev-project.sqlite3`;
2. confirm the bundled fixture is no longer globally stale at startup;
3. manually drag several nodes far from their organized positions;
4. confirm manual positions save across restart;
5. click **Let AI drive this workflow**;
6. confirm the AI takeover banner and virtual cursor become visible;
7. confirm ordinary canvas / Scene Strip / Inspector mutation interaction is blocked while AI controls the workflow;
8. watch the virtual cursor visibly move to and drag displaced nodes back toward dependency-aware positions;
9. confirm the AI focuses a review-relevant node and calculates native impact visibly;
10. use `Space` to pause/resume during execution;
11. start again and press `Esc` or **Take back control** mid-run; execution must stop and manual input must immediately return;
12. confirm Assist-mode Autopilot layout work does **not** increment native project revision;
13. restart and confirm AI-arranged workspace positions survive;
14. approve/lock an editable native node manually and confirm project revision advances and survives restart.

Any Windows process, SQLite migration, drag persistence, virtual-cursor, interaction-lock, cancellation, React Flow, or live-state defect found here must be fixed before provider/media work.

## Next engineering milestone after that gate

1. expose bounded native journal via `project.history` IPC and parse commit provenance;
2. add a premium Studio Activity/History surface distinguishing human, AI, and system commits;
3. design verified checkpoints and recovery policy on top of snapshots + journal;
4. add content-addressed asset/provenance storage separated from semantic state;
5. add provider worker supervisor + capability discovery/health contract;
6. add first lightweight local voice and storyboard/image provider paths;
7. add Claude/Codex Director plan-producer adapters only after supported authentication behavior is verified.

## What not to do next

- Do not wire a heavyweight video model directly into React.
- Do not store workflow x/y coordinates in semantic node metadata.
- Do not let drag operations call `project.apply` or mutate dependencies implicitly.
- Do not give AI providers unrestricted OS mouse/keyboard access as the normal interaction model.
- Do not let provider text directly invoke arbitrary DOM handlers; providers emit typed plans.
- Do not let Assist mode perform semantic mutation.
- Do not remove `Esc` / Take-back control from Autopilot.
- Do not let Node/React duplicate graph or persistence invariants.
- Do not make ComfyUI the project owner.
- Do not implement a fake/custom Claude subscription OAuth flow.
- Do not put OAuth tokens in `.env` as a shipping design.
- Do not treat the current event journal as a complete event-sourced replay engine yet.
- Do not weaken strict compilation/typechecking to make CI pass.
- Do not expose patent-sensitive adaptive synthesis-selection logic while the repository is public.

## Quality bar

Every milestone must remain buildable, testable, explainable, reversible, and explicit about what is actually validated. “100/100” is the quality target backed by evidence; it is not a claim that software can never contain defects.
