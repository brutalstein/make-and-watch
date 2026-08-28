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

Native foundation has been independently configured, built, and tested in an isolated environment using GCC 14.2.0, CMake 3.31.6, and Ninja 1.12.1. `ctest` passed 1/1 tests. See `VALIDATION.md` for the exact record.

Studio validation remains pending because the available execution environment lacks `pnpm` and cannot reach the package registry. Before merge, run `pnpm install`, `pnpm typecheck`, and `pnpm build:web` on a normal development machine and fix any failures on this branch.

## Immediate next steps

1. Run `.\doctor.ps1` on the primary Windows development machine.
2. Run bootstrap, Studio typecheck/build, and native tests from the actual checkout.
3. Review the Studio foundation visually and tune interaction/design before persistence work.
4. Implement Foundation v1 persistent project graph (SQLite + migrations + command/event boundary).
5. Keep patent-sensitive scheduler/synthesis novelty private until IP strategy is cleared.

## What not to do next

- Do not wire a heavyweight video model directly into the UI.
- Do not make ComfyUI the project state owner.
- Do not implement a fake/custom Claude subscription OAuth flow.
- Do not put OAuth tokens in `.env` as a shipping design.
- Do not create a second TypeScript-only domain model that diverges from schemas.
- Do not prematurely disclose patent-sensitive runtime algorithms in public.

## Quality bar

Every milestone must remain buildable, testable, explainable, and reversible. “100/100” is treated as a quality target backed by `QUALITY_GATES.md`, not as permission to conceal defects or unverified assumptions.
