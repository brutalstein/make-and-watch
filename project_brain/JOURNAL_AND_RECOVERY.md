# Project Journal and Recovery

## Why the journal exists

A snapshot answers **what the project is now**. The journal answers **what committed native events led to the current state**.

Make & Watch now persists both without making event history the semantic source of truth yet.

```text
Typed native command batch
          |
          v
staged ProjectEngine
          |
          +--> validated snapshot
          +--> native events
                    |
                    v
        SqliteSnapshotStore::save_commit
                    |
          one SQLite transaction
           /                 \
 current snapshot          append-only journal
```

If persistence fails, neither the live `ProjectSession` state nor the journal advances.

## SQLite schema v2

Schema v2 retains the snapshot tables and adds:

### `project_journal`

- monotonically allocated row ID;
- project revision;
- event index inside that native transaction;
- stable event type string;
- primary entity ID when present;
- event detail text.

The pair `(project_revision, event_index)` is unique.

### `project_journal_affected`

Stores each event's ordered affected-entity IDs with a foreign key to the journal entry.

## Stable persisted event names

Current strings:

- `node.created`
- `node.updated`
- `node.removed`
- `dependency.added`
- `dependency.removed`
- `lock.changed`
- `approval.changed`
- `freshness.changed`
- `dependents.invalidated`
- `transaction.committed`

These strings are persistence/protocol data. Renaming C++ enum members must not silently change historical storage semantics.

## Atomicity invariant

For normal native command commits, `ProjectSession` calls `SnapshotStore::save_commit(snapshot, events)`.

SQLite performs snapshot replacement and journal append inside the same `BEGIN IMMEDIATE` transaction. A partial state where the snapshot advances but its event history does not, or vice versa, is forbidden.

Only after that transaction succeeds does `ProjectSession` replace its live engine with the staged engine.

## Migration

- fresh databases are created directly at schema v2;
- existing schema v1 databases migrate in place to v2;
- future/newer schemas are rejected rather than guessed at;
- migration tests create a real v1 SQLite fixture, open it through the current adapter, then verify snapshot+journal writes.

## Current role versus future recovery

The journal is currently an append-only audit/history foundation. Full event-sourced reconstruction is **not** implemented and must not be assumed.

Safe next uses:

1. expose bounded history through IPC;
2. display native activity/history in Studio;
3. add named/checkpoint snapshots tied to revisions;
4. implement explicit recovery policy from the latest verified checkpoint;
5. later add undo/redo as typed inverse operations or checkpoint restore, not ad-hoc UI mutation.

## Recovery design constraints

- Recovery must validate the reconstructed graph before replacing live state.
- Journal rows must never be edited in place as a normal product operation.
- A user-facing undo cannot simply decrement `project_revision`.
- History display must distinguish native committed events from AI proposals that were never approved.
- Future provider/job events need their own typed model; do not overload semantic graph events with raw worker logs.
- Content-addressed assets/provenance remain a separate subsystem and should reference native project revision/provenance IDs rather than embedding binary media in SQLite.
