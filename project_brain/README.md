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
9. `AI_DIRECTOR_CONTEXT.md` — compact stable creative-Director policy.
10. `DIRECTOR_PROVIDERS.md` — Codex/Claude provider policy, process and context-budget boundary.
11. `AUTH_AND_AI_DIRECTOR.md` — authentication invariants and provider authority.
12. `RUNTIME_FOUNDATION.md` — native resource admission and lifecycle safety layer.
13. `BACKGROUND_JOBS.md` — bounded job ownership, cancellation, and deterministic one-at-a-time shutdown contract.
14. `INVARIANTS.md` — rules that must remain true as the repository grows.
15. `DECISIONS.md` — architecture decisions already made.
16. `QUALITY_GATES.md` — objective standards behind the quality target.
17. `ROADMAP.md` — milestone sequence.
18. `VALIDATION.md` — tests and environments that were actually executed.
19. `HANDOFF.md` — current continuation point and live product-machine gate.

## One-sentence product definition

Make & Watch is a local-first desktop series-production studio where a user directs an AI in natural language, visually reviews and approves a dynamic episode workflow, and lets a hardware-aware local runtime generate, validate, edit, and render long-form episodic media incrementally.

## Current stage

**Foundation v1 / Interactive Native Studio + exact Autopilot pointer + policy-aware Director link + bounded background lifecycle.** The repository has a transactional C++ project graph, SQLite schema-v2 snapshot/journal persistence, guarded resource admission, bounded background-job ownership, versioned native IPC, a persist-before-live-commit application session, interactive Studio, and a typed Autopilot executor whose visible pointer finds/grabs/places displaced nodes while the viewport follows the held cursor/node through a deterministic 30 FPS presentation ceiling.

The Director provider surface now has an explicit policy boundary. Codex is the primary local-client path to validate with official ChatGPT sign-in; Make & Watch owns no Codex OAuth credential. Claude Code is detected but public-product subscription routing is disabled by default because Anthropic's current third-party policy requires a supported API/Console/cloud-provider path. Claude Code remains an explicit developer-preview adapter only, never a silent shipping default.

The Director context compiler is project-specific and bounded rather than repo-dump based: it uses project instructions, a canonical policy hash, live native revision, compact graph state, JSON Schema output and a conservative <=4K-token context budget.

No heavyweight image/video/voice model is a hard dependency yet. `BackgroundJobRuntime` owns bounded lifecycle/resource accounting but does not launch media workers; concrete WorkerSupervisor remains the next native runtime layer.

Provider planning, worker processes and model execution must build on these validated boundaries rather than bypassing them.

## Public-repository warning

The repository is currently public. Keep patent-sensitive invention disclosures, unpublished claim language, and implementation details of potentially novel adaptive synthesis-selection/resource-planning mechanisms out of this tree until the IP strategy is settled.
