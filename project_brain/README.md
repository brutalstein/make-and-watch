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
8. `AUTOPILOT.md` — exact virtual-pointer protocol and interaction ownership.
9. `AI_DIRECTOR_CONTEXT.md` — compact stable creative-Director policy.
10. `DIRECTOR_PROVIDERS.md` — Codex App Server / Claude provider policy and bounded multi-turn chat.
11. `AUTH_AND_AI_DIRECTOR.md` — authentication invariants and provider authority.
12. `RUNTIME_FOUNDATION.md` — native resource admission and lifecycle safety layer.
13. `BACKGROUND_JOBS.md` — bounded job ownership and deterministic shutdown contract.
14. `MEDIA_PIPELINE.md` — cross-episode continuity and deterministic video render-plan compiler.
15. `INVARIANTS.md` — rules that must remain true as the repository grows.
16. `DECISIONS.md` — architecture decisions already made.
17. `QUALITY_GATES.md` — objective standards behind the quality target.
18. `ROADMAP.md` — milestone sequence.
19. `VALIDATION.md` — tests and environments that were actually executed.
20. `HANDOFF.md` — current continuation point and live product-machine gate.

## One-sentence product definition

Make & Watch is a local-first desktop series-production studio where a user directs an AI in natural language, visually reviews and approves a dynamic episode workflow, and lets a hardware-aware local runtime generate, validate, edit, and render long-form episodic media incrementally.

## Current stage

**Foundation v1 / Self-starting Director Chat + continuity/video compiler hardening.**

Current validated code foundation includes:

- transactional C++ semantic project graph;
- SQLite snapshot + append-only journal persistence;
- versioned JSONL native IPC and `ProjectSession` persist-before-live-commit boundary;
- live Studio workflow/Inspector/Activity surfaces;
- exact-pointer Autopilot with explicit takeover;
- native `ResourceManager` + bounded `BackgroundJobRuntime`;
- official Codex App Server integration with ChatGPT-managed authentication and no OAuth credential custody;
- bounded multi-turn Director Chat;
- a cinematic toggleable Chat sidecar whose composer is writable before provider readiness;
- `dev-runner` Codex warm-up before Studio startup;
- first-Send auth continuation: if sign-in is needed, the user message remains queued locally and is submitted after the official ChatGPT flow completes;
- cross-episode canonical Character continuity projection;
- deterministic native Episode video render-plan compilation with explicit shot strategy metadata;
- hardened finite/bounded media validation and duplicate ownership checks.

Director conversation remains **non-authoritative**. Natural-language discussion never becomes project truth by itself. Real semantic change must still cross typed validation and the native project transaction boundary.

Claude Code may be detected, but public-product Claude subscription routing remains disabled. Shipping Claude chat requires a supported Anthropic API/Console/cloud-provider path.

No heavyweight image/video/voice model is a hard dependency yet. The next major runtime milestone is a concrete WorkerSupervisor, followed by provenance-backed local media workers and FFmpeg/native execution.

## UX startup principle

The normal user path must not require service administration:

```text
start Make & Watch
 -> native engine / bridge / Codex App Server are prepared by the runtime
 -> Studio opens
 -> user types immediately
 -> Send works directly or continues through official ChatGPT sign-in if required
```

Provider diagnostics and manual Connect actions are recovery/control surfaces, not the happy-path workflow.

## Public-repository warning

The repository is currently public. Keep patent-sensitive invention disclosures, unpublished claim language, and implementation details of potentially novel adaptive synthesis-selection/resource-planning mechanisms out of this tree until the IP strategy is settled.
