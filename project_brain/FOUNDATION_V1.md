# Foundation v1 — Transactional Project Graph

## Why this exists

Make & Watch must not treat an episode as a pile of generated files. The durable product state is a graph of semantic entities and dependencies. Generated media is downstream output.

This milestone introduces the first real native project-state engine.

## Implemented invariants

- Project mutations enter through typed commands.
- A batch of commands is atomic: all changes commit or none do.
- Every successful transaction increments a monotonic project revision.
- Nodes have their own monotonic optimistic-concurrency revision.
- Dependency cycles are rejected.
- Direct mutation of locked nodes is rejected.
- Locks do not hide staleness: a locked downstream node may still be marked stale when an upstream dependency changes.
- Semantic content edits invalidate transitive dependents instead of rebuilding the whole project.
- Stale outputs cannot be approved until a trusted worker marks them fresh.
- Removing a node cleans incident edges and invalidates downstream dependents.
- Events are emitted for committed state transitions and retained by the engine.

## Dependency direction

`dependent -> dependency`

Example:

```text
generation.001 -> shot.001 -> character.mira
                         \-> location.cafe
```

If `character.mira` changes, the engine walks the reverse dependency index and marks `shot.001`, then `generation.001`, stale.

## Why lock and stale are separate

A lock expresses user authority: automated/director edits must not mutate the entity.

Staleness expresses truth about derived state: an upstream dependency changed and the entity may no longer be valid.

A locked node can therefore be stale. The user retains control while the system remains honest about consistency.

## Concurrency model

Commands may include `expected_revision`. A stale UI/client write is rejected with `kRevisionConflict` instead of silently overwriting newer state.

This is the basis for future background workers, undo/version history, AI Director operations, and multi-process persistence.

## Persistence boundary

The graph currently lives in memory. SQLite is intentionally the *next* layer, not mixed into domain rules. Persistence will store snapshots/events and reconstruct this exact engine state; it must not become the source of business logic.

## Public-repository boundary

This document describes ordinary project-state engineering. Patent-sensitive resource-selection/synthesis algorithms remain outside the public repository until the IP strategy is resolved.
