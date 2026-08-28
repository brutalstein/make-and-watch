# Foundation v1 — Transactional Project Graph

## Why this exists

Make & Watch must not treat an episode as a pile of generated files. The durable product state is a graph of semantic entities and dependencies. Generated media is downstream output.

This milestone introduces the first real native project-state engine.

## Implemented invariants

- Project mutations enter through typed commands.
- A batch of commands is atomic: all changes commit or none do.
- Every successful transaction increments a monotonic project revision.
- Nodes have their own optimistic-concurrency revision.
- Dependency cycles are rejected.
- Direct mutation of locked nodes is rejected.
- Locks do not hide staleness: a locked downstream node may still be marked stale when an upstream dependency changes.
- Semantic content edits invalidate transitive dependents instead of rebuilding the whole project.
- Stale outputs cannot be approved until a trusted worker marks them fresh.
- Removing a node cleans incident edges and invalidates downstream dependents.
- Events are emitted for committed state transitions and retained by the engine.
- Impact can be previewed without mutating project state, including locked and already-stale dependents.
- The native graph exports deterministic ordered snapshots suitable for a persistence/IPC boundary.
- Hydration is only allowed into a pristine engine and snapshot validation is atomic.

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

## Impact preview

Before accepting a natural-language edit, Studio will be able to ask the engine for an impact report. This report lists all transitive downstream entities plus the subset that is locked or already stale. The UI can therefore say exactly what would be affected before the user approves an expensive change.

## Snapshot/hydration boundary

Snapshots preserve nodes, revisions, approval/lock/stale state, and dependency edges in deterministic map/set order. Loading validates all nodes and edges into a staged graph first. Missing endpoints, duplicates, zero persisted revisions, or cycles reject the snapshot without mutating the live graph.

This is deliberately separate from the eventual storage technology: SQLite will persist validated snapshots/events, but database code will not own graph invariants.

## Concurrency model

Commands may include `expected_revision`. A stale UI/client write is rejected with `kRevisionConflict` instead of silently overwriting newer state.

This is the basis for future background workers, version history, AI Director operations, and multi-process persistence.

## Public-repository boundary

This document describes ordinary project-state engineering. Patent-sensitive resource-selection/synthesis algorithms remain outside the public repository until the IP strategy is resolved.
