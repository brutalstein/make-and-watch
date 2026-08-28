# Session Handoff

## Current state

Foundation work is on `foundation/series-engine-v0` and tracked by draft PR #1.

Implemented and committed:

- canonical `project_brain/` session handoff system;
- C++20 transactional semantic project graph with typed commands/events, optimistic revisions, locks, staleness, DAG validation, dependency invalidation, impact preview, snapshots, and guarded hydration;
- generic thread-safe local resource admission with explicit VRAM/RAM reserves, CPU budgets, exclusivity, and duplicate-work protection;
- embedded SQLite 3.53.4 persistence behind `SnapshotStore`, with schema versioning, WAL, foreign keys, full synchronization, transactional replacement, and load validation;
- `ProjectSession` application layer that persists staged state before replacing the live engine;
- versioned JSONL IPC protocol v1 and `makewatch_engine_host` executable;
- typed native methods for health, snapshot, impact, apply, and project replacement;
- process-boundary smoke test that launches the real native host and writes/reads an SQLite-backed project;
- localhost-only development bridge with request correlation, RPC timeout, bounded request bodies, native failure propagation, and NVIDIA/system telemetry;
- React/TypeScript Studio driven by the real native snapshot, with real node selection, scene strip, revision display, approval, lock/unlock, impact preview, and GPU telemetry;
- development fixture seeded through native typed commands instead of hardcoded React state;
- one-command Windows quality gate `./verify.ps1` plus `./dev.ps1` native+bridge+Studio runtime;
- provider-agnostic AI Director boundary; Claude/Codex natural-language authentication remains intentionally unimplemented rather than faked.

Subsystem context:

- `FOUNDATION_V1.md` — project graph semantics.
- `PERSISTENCE.md` — SQLite boundary.
- `IPC_AND_SESSION.md` — application transaction + native IPC + Studio bridge.
- `RUNTIME_FOUNDATION.md` — public resource-safety layer.
- `AUTH_AND_AI_DIRECTOR.md` — Claude/Codex integration constraints.

## Validation status

GitHub Actions is green for the native-host/process-boundary milestone and Studio bridge milestone. The suite covers bridge JavaScript syntax, strict TypeScript, production Studio build, strict C/C++ build, semantic graph tests, resource tests, SQLite tests, ProjectSession persistence-failure tests, IPC parser/dispatcher tests, and a real native-host process smoke test.

The previous foundation was also validated on the primary Windows/NVIDIA machine with Node 24.11.0, pnpm 10.15.0, CMake 4.1.2, Ninja 1.13.1, GNU C/C++ 15.2.0, and an RTX 5070 Laptop GPU; the then-current 4-test native suite passed 4/4. The newly added native host / bridge / live Studio path still needs one hands-on Windows validation after pulling current HEAD.

## Immediate next gate

On the primary Windows machine:

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

In Studio:

1. confirm the header says Native online and real GPU telemetry appears;
2. click scene / character / shot nodes and verify Inspector follows native state;
3. select `character.mira` or a scene and run **Preview impact**;
4. approve an eligible review/draft node and verify project revision increments;
5. lock/unlock an editable node and verify the native revision changes;
6. stop the runtime, restart `./dev.ps1`, and verify the changed state survives via SQLite.

Any Windows process-launch, CORS, SQLite lock, path, live-state, or UI defect found in this test must be fixed before media-provider work.

## Next engineering milestone after that gate

1. append-only command/event journal and recoverable checkpoints;
2. content-addressed asset/provenance index separated from semantic state;
3. provider worker supervisor + capability discovery contract;
4. first lightweight local voice and storyboard/image provider path;
5. Director provider adapter only after supported authentication behavior is verified.

## What not to do next

- Do not wire a heavyweight video model directly into React.
- Do not let Node/React duplicate graph or persistence invariants.
- Do not make ComfyUI the project owner.
- Do not implement a fake/custom Claude subscription OAuth flow.
- Do not put OAuth tokens in `.env` as a shipping design.
- Do not weaken strict compilation/typechecking to make CI pass.
- Do not expose patent-sensitive adaptive synthesis-selection logic while the repository is public.

## Quality bar

Every milestone must remain buildable, testable, explainable, reversible, and explicit about what is actually validated. “100/100” is the quality target backed by evidence; it is not a claim that software can never contain defects.
