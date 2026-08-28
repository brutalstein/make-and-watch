# Session Handoff

## Current state

Repository was initialized from empty on 2026-08-28. Foundation work is being developed on `foundation/series-engine-v0`.

The public `main` branch currently contains the project introduction. The foundation branch is intended to introduce the canonical architecture/context, versioned contracts, native core scaffolding, Studio shell, and CI before a review/merge.

## Immediate next steps

1. Complete the C++ domain/operation validation foundation.
2. Complete the first premium Studio shell using mock project data only.
3. Add CI/build ergonomics and verify both sides compile.
4. Review public-repository IP exposure before implementing novel resource/synthesis algorithms.
5. After foundation review, implement persistent project graph and migrations before heavyweight model integrations.

## What not to do next

- Do not wire a heavyweight video model directly into the UI.
- Do not make ComfyUI the project state owner.
- Do not put OAuth tokens in `.env` as a shipping design.
- Do not create a second TypeScript-only domain model that diverges from schemas.
- Do not prematurely optimize patent-sensitive runtime algorithms in public.

## Quality bar

Every milestone must remain buildable, testable, explainable, and reversible. “100/100” is treated as a quality target backed by gates and tests, not as a claim that defects cannot exist.
