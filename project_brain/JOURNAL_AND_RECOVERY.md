# Project Journal and Recovery

## Why the journal exists

A snapshot answers **what the project is now**. The journal answers **what committed native events led to the current state**.

Make & Watch persists both without making event history the semantic source of truth yet.

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

Schema v2 retains snapshot tables and adds `project_journal` plus ordered affected-entity rows in `project_journal_affected`.

Journal rows include monotonically allocated row ID, project revision, event index inside the transaction, stable event type string, optional primary entity ID, detail, and ordered affected IDs. `(project_revision, event_index)` is unique.

No schema migration was added for the Activity UI. History is revision-based and does not invent timestamps that were never persisted.

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

## Durable attribution

`transaction.committed` may carry versioned `mwctx1` context containing:

- actor (`user`, `ai_director`, `system`);
- source;
- plan ID;
- reason;
- original transaction event detail.

The encoding is a storage detail. Native `project.history` parses it before crossing IPC, so React and the Node bridge never implement the escape/parser rules.

Older journal entries that predate attribution remain valid and may appear as system/unattributed activity.

## Atomicity invariant

For normal native command commits, `ProjectSession` calls `SnapshotStore::save_commit(snapshot, events, context)`.

SQLite performs snapshot replacement and journal append inside the same `BEGIN IMMEDIATE` transaction. A partial state where the snapshot advances but history does not, or vice versa, is forbidden.

Only after that transaction succeeds does `ProjectSession` replace its live engine with staged state.

## Bounded history projection

`project.history` is implemented as a read-only bounded IPC projection, not direct SQL exposure.

Current rules:

- caller requests 1..24 committed transactions;
- dispatcher requests a finite event budget;
- events are grouped by native project revision;
- a group is returned only if its `transaction.committed` marker is present;
- attribution is parsed natively;
- structured actor/source/plan/reason and typed events are returned;
- Studio displays recent transactions in the Inspector Activity feed.

This avoids presenting a truncated oldest revision as if it were a complete transaction and avoids unbounded journal reads from UI code.

## Migration

- fresh databases are created directly at schema v2;
- existing schema v1 databases migrate in place to v2;
- future/newer schemas are rejected rather than guessed at;
- migration tests create a real v1 SQLite fixture and verify current snapshot+journal writes after upgrade.

## Current role versus future recovery

The journal is an append-only audit/history foundation. Full event-sourced reconstruction is **not** implemented and must not be assumed.

Implemented safe use:

1. bounded attributed history through native IPC;
2. durable Activity display in Studio.

Next recovery work:

1. add named/checkpoint snapshots tied to revisions;
2. define latest-verified-checkpoint recovery policy;
3. validate reconstructed graph before live replacement;
4. later implement undo/redo as typed inverse operations or checkpoint restore, never ad-hoc UI mutation.

## Recovery design constraints

- Recovery must validate reconstructed graph before replacing live state.
- Journal rows must never be edited in place as a normal product operation.
- User-facing undo cannot simply decrement `project_revision`.
- History must distinguish committed native work from AI proposals that were never approved.
- Provider/job events need their own typed model; do not overload semantic graph events with raw worker logs.
- Content-addressed assets/provenance remain separate and should reference project revision/provenance IDs rather than embedding media in SQLite.
