# Persistence — SQLite Snapshot + Journal Store

## Boundary

Persistence stores validated engine state and committed native history. It does not own project semantics.

The native domain remains:

```text
ProjectEngine -> ProjectGraph -> typed commands/events
```

Persistence is behind `SnapshotStore`:

```text
ProjectSession
    |
    +--> snapshot + events
              |
              v
        SnapshotStore
              |
              +-- SqliteSnapshotStore
```

This allows future backup, cloud, test, or alternate storage adapters without moving domain rules out of C++.

## Embedded SQLite

The developer build pins the official SQLite 3.53.4 amalgamation with a SHA3-256 hash. The application does not require a separately installed SQLite development package. Release binaries can link the embedded engine rather than asking end users to install database tooling.

## Database safety configuration

On open:

- `foreign_keys=ON`
- `journal_mode=WAL`
- `synchronous=FULL`
- 5 second busy timeout
- SQLite full-mutex connection mode

The amalgamation disables dynamic extension loading and legacy double-quoted-string behavior.

## Schema v2

Snapshot tables:

- `project_meta`
- `nodes`
- `node_metadata`
- `dependencies`

Append-only native history tables:

- `project_journal`
- `project_journal_affected`

`PRAGMA user_version` is the migration authority. Existing schema v1 project databases migrate in place to v2. Databases newer than the engine are rejected rather than guessed at.

Detailed journal semantics are in `JOURNAL_AND_RECOVERY.md`.

## Commit semantics

Normal project mutation goes through `ProjectSession`:

1. clone/stage the current native engine;
2. apply and validate the typed command batch;
3. obtain the resulting deterministic snapshot and native event list;
4. call `SnapshotStore::save_commit(snapshot, events)`;
5. SQLite uses one `BEGIN IMMEDIATE` transaction to replace current snapshot rows and append the corresponding journal rows;
6. only after persistence succeeds does `ProjectSession` replace its live engine.

This prevents RAM/disk split-brain and also prevents a journal entry from claiming a mutation that was never committed live.

`save(snapshot)` remains available for validated snapshot replacement paths that intentionally do not append a normal command event batch.

## Load semantics

Snapshot rows are loaded in deterministic order, enum/revision values are checked, then the resulting graph is run through the native `ProjectGraph::replace_from_snapshot()` validator. A malformed graph never reaches the live `ProjectEngine`.

`load_journal(limit)` reconstructs typed native events from stable persisted event names and ordered affected-entity rows. The current journal is an audit/history foundation; the application is not yet fully event-sourced.

## Validated migration behavior

Tests now cover:

- fresh schema-v2 database creation;
- transactional snapshot round-trip;
- append-only journal across later snapshot replacement;
- event ordering inside a project revision;
- journal survival after database close/reopen;
- closed-store rejection;
- construction of a real schema-v1 SQLite fixture followed by in-place migration to v2;
- successful snapshot+journal commit after that migration.

## Next persistence work

- bounded history exposed through native IPC;
- user-visible activity/history surface;
- checkpoint/recovery policy tied to verified revisions;
- explicit integrity/backup APIs and fault injection;
- content-addressed asset/provenance index stored separately from semantic project state and journal.
