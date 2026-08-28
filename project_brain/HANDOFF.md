# Session Handoff

## Current state

Repository was initialized from empty on 2026-08-28. Foundation work is on `foundation/series-engine-v0` with draft PR #1 open against `main`.

Implemented foundation pieces:

- canonical `project_brain/` session handoff system;
- versioned initial JSON contracts;
- C++20 engine library and strict warning policy;
- typed director operations and validator tests;
- provider-agnostic `DirectorProvider` boundary;
- policy-correct official-client bridge direction for Claude/Codex subscription use;
- React/TypeScript Studio shell with Director, live workflow, scene strip, inspector, and resource-plan mock surfaces;
- cross-platform doctor/bootstrap/dev entry points;
- CI definition for native and Studio builds;
- objective quality gates and recorded validation history.

## Validation status

Foundation CI is green.

Native path:

- configure: passed;
- compile: passed;
- tests: passed.

Studio path:

- dependency install: passed;
- strict TypeScript typecheck: passed;
- Vite production build: passed.

The native core was also independently reconstructed and tested outside CI with GCC 14.2.0, CMake 3.31.6, and Ninja 1.12.1. See `VALIDATION.md` for the exact record and the setup issues CI exposed and resolved.

## Immediate next steps

1. On the primary Windows machine, checkout `foundation/series-engine-v0`.
2. Run `.\doctor.ps1` and `.\scripts\bootstrap.ps1`.
3. Open the Studio with `.\dev.ps1` and visually review layout, scaling, interaction, and premium feel.
4. Fix any Windows-specific or visual issues before moving PR #1 out of draft.
5. After foundation approval, implement Foundation v1 persistent project graph: SQLite + migrations + command/event boundary.
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
