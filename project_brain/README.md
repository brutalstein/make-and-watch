# Project Brain — Start Here

This folder is the canonical context handoff for **Make & Watch**. A new engineer or AI coding session should be able to read this folder and understand the product, architecture, non-negotiable constraints, current stage, and next safe actions without relying on chat history.

## Reading order

1. `VISION.md` — what we are building and what we are deliberately not building.
2. `ARCHITECTURE.md` — system boundaries and dependency direction.
3. `AUTH_AND_AI_DIRECTOR.md` — supported authentication boundary and AI-director policy.
4. `INVARIANTS.md` — rules that must remain true as the repository grows.
5. `DECISIONS.md` — architecture decisions already made.
6. `QUALITY_GATES.md` — objective standards behind the project's quality target.
7. `ROADMAP.md` — milestone sequence and quality gates.
8. `HANDOFF.md` — current repository state and immediate continuation point.

## One-sentence product definition

Make & Watch is a local-first desktop series-production studio where a user directs an AI in natural language, visually reviews and approves a dynamic episode workflow, and lets a hardware-aware local runtime generate, validate, edit, and render long-form episodic media incrementally.

## Current stage

**Foundation v0.** The repository is establishing contracts, domain boundaries, development ergonomics, and the first Studio shell. No heavyweight media model is a hard dependency yet.

## Public-repository warning

The repository is currently public. Keep patent-sensitive invention disclosures, unpublished claim language, and implementation details of potentially novel scheduling/synthesis mechanisms out of this tree until the IP strategy is settled.
