# Session Handoff

## Current state

Foundation work is on `foundation/series-engine-v0` and tracked by draft PR #1.

Implemented foundation pieces:

- canonical `project_brain/` session handoff system;
- versioned JSON contracts;
- C++20 engine library and strict warning policy;
- typed director operations and validator tests;
- provider-agnostic `DirectorProvider` boundary;
- policy-correct official-client bridge direction for Claude/Codex subscription use;
- React/TypeScript Studio shell with Director, workflow, scene strip, inspector, and resource-plan surfaces;
- cross-platform doctor/bootstrap/dev entry points;
- CI for native and Studio builds;
- Foundation v1 transactional native project graph with typed commands/events, optimistic revisions, locks, staleness, cycle prevention, dependency invalidation, and atomic rollback.

Read `FOUNDATION_V1.md` before modifying project-state behavior.

## Validation status

The previous foundation milestone passed GitHub Actions for native configure/build/CTest and Studio pnpm install/strict TypeScript/Vite production build. The native core was also reconstructed independently with GCC 14.2.0, CMake 3.31.6, and Ninja 1.12.1.

The newly added Foundation v1 project-graph code must now pass the expanded GitHub Actions suite and then be pulled/tested on the primary Windows machine before the next milestone.

## Immediate next steps

1. Validate the expanded native suite in GitHub Actions.
2. On Windows: `git pull`, then run `cmake --build --preset dev` and `ctest --preset dev`.
3. Run `pnpm typecheck` and `pnpm build:web` to guard cross-language contract changes.
4. After native graph validation, add persistence behind a repository/store boundary with SQLite + migrations.
5. Then bridge Studio state to the native engine through a narrow IPC transport; do not duplicate graph rules in React.
6. Keep patent-sensitive scheduler/synthesis novelty private until IP strategy is cleared.

## What not to do next

- Do not wire a heavyweight video model directly into the UI.
- Do not make ComfyUI the project state owner.
- Do not implement a fake/custom Claude subscription OAuth flow.
- Do not put OAuth tokens in `.env` as a shipping design.
- Do not create a second TypeScript-only domain engine that diverges from C++.
- Do not let persistence code own domain invariants.
- Do not prematurely disclose patent-sensitive runtime algorithms in public.

## Quality bar

Every milestone must remain buildable, testable, explainable, reversible, and explicit about what is actually validated. “100/100” is a quality target backed by evidence, not a claim that defects are impossible.
