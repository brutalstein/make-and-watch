# Make & Watch

**A local-first, AI-directed long-form series production engine.**

Make & Watch is being built as a premium desktop studio for planning, approving, generating, editing, and rendering episodic media with a user-controlled AI director and a local-first media runtime.

> Status: architecture foundation. The repository intentionally keeps invention-sensitive implementation details out of the public tree until the IP strategy is settled.

## Product principles

- **Human approval before expensive generation** — prompt → episode plan → scenes → storyboards → shots → animatic → final synthesis.
- **Local-first media generation** — image, video, speech, audio, compositing, caching, and rendering are designed to run locally through replaceable providers.
- **One AI director connection** — the user may connect a supported director such as Claude or Codex; the director plans and edits through typed operations instead of directly mutating runtime internals.
- **Hardware-aware execution** — the runtime is designed around explicit resource budgets, resumability, incremental work, and deterministic project state.
- **Premium workflow UX** — natural-language direction and a visual workflow operate on the same underlying project graph.
- **Model-agnostic core** — no single image/video/audio model is allowed to define the architecture.

## Repository map

- `apps/` — user-facing applications.
- `engine/` — C++ core runtime and domain logic.
- `packages/` — shared TypeScript packages and UI contracts.
- `schemas/` — versioned cross-language data contracts.
- `providers/` — adapters for replaceable AI/media providers.
- `project_brain/` — **start here in every new development session**.

## New session?

Read [`project_brain/README.md`](project_brain/README.md) first. It is the canonical handoff entry point and explains what the system is, what must remain true, and where to continue.

## IP note

This repository is currently public. Detailed invention disclosures, claim-oriented algorithms, and unpublished patent-sensitive implementation techniques should not be committed publicly before an IP filing strategy is decided.
