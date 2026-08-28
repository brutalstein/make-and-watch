# Session Handoff

## Current state

Repository was initialized from empty on 2026-08-28. Foundation work is on `foundation/series-engine-v0`.

Implemented foundation pieces:

- canonical `project_brain/` session handoff system;
- versioned initial JSON contracts;
- C++20 engine library and strict warning policy;
- typed director operations and validator tests;
- provider-agnostic `DirectorProvider` boundary;
- policy-correct official-client bridge direction for Claude/Codex subscription use;
- React/TypeScript Studio shell with Director, live workflow, scene strip, inspector, and resource-plan mock surfaces;
- cross-platform doctor/bootstrap/dev entry points;
- CI definition for native and Studio builds.

## Validation status

The connector-based branch updates did not automatically produce a GitHub Actions run, so CI has not yet provided external build confirmation. Source-level review caught and fixed explicit `<utility>` portability includes and moved `enable_testing()` to the root CMake scope. Before merging to `main`, run the local bootstrap/build/tests or trigger CI through the normal Git workflow.

## Immediate next steps

1. Run `./doctor.sh` or `.\doctor.ps1` on a development machine.
2. Run bootstrap, native build/tests, and Studio typecheck/build.
3. Fix any environment-specific issues discovered by real execution.
4. Review the Studio foundation visually and tune interaction/design before persistence work.
5. Implement Foundation v1 persistent project graph (SQLite + migrations + command/event boundary).
6. Keep patent-sensitive scheduler/synthesis novelty private until IP strategy is cleared.

## What not to do next

- Do not wire a heavyweight video model directly into the UI.
- Do not make ComfyUI the project state owner.
- Do not implement a fake/custom Claude subscription OAuth flow.
- Do not put OAuth tokens in `.env` as a shipping design.
- Do not create a second TypeScript-only domain model that diverges from schemas.
- Do not prematurely disclose patent-sensitive runtime algorithms in public.

## Quality bar

Every milestone must remain buildable, testable, explainable, and reversible. “100/100” is treated as a quality target backed by `QUALITY_GATES.md`, not as permission to conceal defects or unverified assumptions.
