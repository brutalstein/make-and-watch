# Project Brain — Start Here

This folder is the canonical context handoff for **Make & Watch**. A new engineer or AI coding session should be able to read it and understand the product, architecture, non-negotiable constraints, current validated state, and next safe actions without relying on chat history.

## Reading order

1. `VISION.md` — product goal and deliberate non-goals.
2. `ARCHITECTURE.md` — system boundaries, state ownership, and dependency direction.
3. `FOUNDATION_V1.md` — transactional semantic project graph.
4. `PERSISTENCE.md` — embedded SQLite snapshot+journal storage boundary.
5. `JOURNAL_AND_RECOVERY.md` — append-only native history and future recovery constraints.
6. `IPC_AND_SESSION.md` — native application transaction boundary and Studio IPC.
7. `WORKSPACE_LAYOUT.md` — draggable workflow presentation-state boundary.
8. `AUTOPILOT.md` — exact virtual-pointer pick-and-place protocol, typed takeover, interaction ownership, and safety boundaries.
9. `RUNTIME_FOUNDATION.md` — native resource admission and lifecycle safety layer.
10. `BACKGROUND_JOBS.md` — bounded job ownership, cancellation, and deterministic one-at-a-time shutdown contract.
11. `AUTH_AND_AI_DIRECTOR.md` — supported Claude/Codex integration boundary.
12. `INVARIANTS.md` — rules that must remain true as the repository grows.
13. `DECISIONS.md` — architecture decisions already made.
14. `QUALITY_GATES.md` — objective standards behind the quality target.
15. `ROADMAP.md` — milestone sequence.
16. `VALIDATION.md` — tests and environments that were actually executed.
17. `HANDOFF.md` — current continuation point.

## One-sentence product definition

Make & Watch is a local-first desktop series-production studio where a user directs an AI in natural language, visually reviews and approves a dynamic episode workflow, and lets a hardware-aware local runtime generate, validate, edit, and render long-form episodic media incrementally.

## Current stage

**Foundation v1 / Interactive Native Studio + exact Autopilot pointer + bounded background lifecycle.** The repository has a transactional C++ project graph, SQLite schema-v2 snapshot/journal persistence, guarded resource admission, bounded background-job ownership, versioned native IPC, a persist-before-live-commit application session, interactive Studio, and a typed Autopilot executor whose visible pointer finds, grabs and places displaced workflow nodes one-by-one.

The current AI Workspace Drive is deliberately deterministic and Assist-only; it proves the execution/interaction system without pretending Claude/Codex authentication is already connected. No heavyweight image/video/voice model is a hard dependency yet. The background runtime owns lifecycle/resource accounting but does not launch provider workers yet; concrete WorkerSupervisor is the next native runtime layer.

Provider authentication, worker processes and model execution must build on these validated boundaries rather than bypassing them.

## Public-repository warning

The repository is currently public. Keep patent-sensitive invention disclosures, unpublished claim language, and implementation details of potentially novel adaptive synthesis-selection/resource-planning mechanisms out of this tree until the IP strategy is settled.
