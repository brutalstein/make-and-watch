# Session Handoff

## Current state

Foundation work is on `foundation/series-engine-v0` and tracked by draft PR #1.

Implemented foundation pieces:

- canonical `project_brain/` session handoff system;
- versioned JSON contracts and shared TypeScript contracts;
- C++20 engine library with strict warning policy;
- typed Director operations and validator tests;
- provider-agnostic `DirectorProvider` boundary;
- policy-correct official-client bridge direction for Claude/Codex subscription use;
- React/TypeScript Studio shell with Director, workflow, scene strip, inspector, and resource-plan surfaces;
- cross-platform doctor/bootstrap/dev entry points;
- one-command Windows quality gate: `./verify.ps1`;
- CI for native and Studio builds;
- transactional native project graph with typed commands/events, optimistic revisions, locks, staleness, cycle prevention, dependency invalidation, atomic rollback, impact preview, deterministic snapshots, and guarded hydration;
- generic thread-safe runtime resource admission with explicit VRAM/RAM reserves, CPU budgets, exclusivity, and duplicate-job protection;
- embedded SQLite 3.53.4 snapshot persistence behind `SnapshotStore`, including schema v1 migration, WAL, foreign keys, full synchronization, atomic save, validation on load, and round-trip tests.

Read these files before changing the corresponding subsystem:

- `FOUNDATION_V1.md` — project graph and transactional semantics.
- `RUNTIME_FOUNDATION.md` — public resource-safety layer.
- `PERSISTENCE.md` — SQLite persistence boundary.
- `AUTH_AND_AI_DIRECTOR.md` — Claude/Codex integration constraints.

## Validation status

GitHub Actions is green for the latest persistence/resource/project-graph foundation after fixing one explicit include defect found by CI. The passing suite covers:

- Studio pnpm install;
- strict TypeScript typecheck;
- Vite production build;
- native C/C++ configure and build;
- Director operation validation tests;
- transactional project graph tests;
- runtime resource admission tests;
- SQLite persistence round-trip tests.

The next quality gate is the user's primary Windows/NVIDIA machine. Pull the branch and run `./verify.ps1`. Do not begin heavyweight media-provider integration until that passes locally.

## Immediate next steps

1. On Windows: `git pull`, then run `./verify.ps1` and capture the full output.
2. If the quality gate passes, open Studio with `./dev.ps1` and perform visual/product review.
3. Add a narrow native IPC/service boundary so Studio can query snapshots, impact previews, commands, and resource telemetry without duplicating C++ domain rules.
4. Add append-only history/checkpoint recovery and content-addressed asset provenance.
5. Only then add the first lightweight local image/voice provider path.
6. Keep patent-sensitive adaptive synthesis-selection logic private until IP strategy is cleared.

## What not to do next

- Do not wire a heavyweight video model directly into the UI.
- Do not make ComfyUI the project state owner.
- Do not implement a fake/custom Claude subscription OAuth flow.
- Do not put OAuth tokens in `.env` as a shipping design.
- Do not create a second TypeScript-only domain engine that diverges from C++.
- Do not let persistence code own domain invariants.
- Do not weaken strict compilation/typechecking to make CI pass.
- Do not prematurely disclose patent-sensitive runtime algorithms in public.

## Quality bar

Every milestone must remain buildable, testable, explainable, reversible, and explicit about what is actually validated. “100/100” is a quality target backed by evidence, not a claim that defects are impossible.
