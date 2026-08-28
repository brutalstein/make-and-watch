# Project Brain — Start Here

This folder is the canonical context handoff for **Make & Watch**. A new engineer or AI coding session should be able to read it and understand the product, architecture, non-negotiable constraints, current validated state, and next safe actions without relying on chat history.

## Reading order

1. `VISION.md` — product goal and deliberate non-goals.
2. `ARCHITECTURE.md` — system boundaries and dependency direction.
3. `FOUNDATION_V1.md` — transactional semantic project graph.
4. `PERSISTENCE.md` — embedded SQLite storage boundary.
5. `IPC_AND_SESSION.md` — native application transaction boundary and Studio IPC.
6. `RUNTIME_FOUNDATION.md` — public resource-safety layer.
7. `AUTH_AND_AI_DIRECTOR.md` — supported Claude/Codex integration boundary.
8. `INVARIANTS.md` — rules that must remain true as the repository grows.
9. `DECISIONS.md` — architecture decisions already made.
10. `QUALITY_GATES.md` — objective standards behind the quality target.
11. `ROADMAP.md` — milestone sequence.
12. `VALIDATION.md` — tests and environments that were actually executed.
13. `HANDOFF.md` — current continuation point.

## One-sentence product definition

Make & Watch is a local-first desktop series-production studio where a user directs an AI in natural language, visually reviews and approves a dynamic episode workflow, and lets a hardware-aware local runtime generate, validate, edit, and render long-form episodic media incrementally.

## Current stage

**Foundation v1 / Native Studio Bridge.** The repository now has a transactional C++ project graph, SQLite persistence, guarded local resource admission, a versioned native IPC host, a persist-before-live-commit application session, and a Studio that projects real native state rather than hardcoded workflow data.

No heavyweight image/video/voice model is a hard dependency yet. Claude/Codex natural-language provider authentication is intentionally not faked; the next media/provider milestones must build on the validated native boundary.

## Public-repository warning

The repository is currently public. Keep patent-sensitive invention disclosures, unpublished claim language, and implementation details of potentially novel adaptive synthesis-selection/resource-planning mechanisms out of this tree until the IP strategy is settled.
