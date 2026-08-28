# Persistence — SQLite Snapshot Store

## Boundary

Persistence stores validated engine state. It does not own project semantics.

The native domain remains:

```text
ProjectEngine -> ProjectGraph -> typed commands/events
```

Persistence is behind `SnapshotStore`:

```text
ProjectEngine::snapshot()
        |
        v
SnapshotStore
        |
        +-- SqliteSnapshotStore
```

This allows future backup, cloud, test, or alternate storage adapters without changing domain rules.

## Embedded SQLite

The developer build pins the official SQLite 3.53.4 amalgamation with a SHA3-256 hash. The application therefore does not require a separately installed SQLite development package. Release binaries will link the embedded engine rather than asking end users to install database tooling.

## Database safety configuration

On open:

- `foreign_keys=ON`
- `journal_mode=WAL`
- `synchronous=FULL`
- 5 second busy timeout
- SQLite full-mutex connection mode

The amalgamation disables dynamic extension loading and legacy double-quoted-string behavior.

## Schema v1

Tables:

- `project_meta`
- `nodes`
- `node_metadata`
- `dependencies`

`PRAGMA user_version` is the migration authority. Databases newer than the engine are rejected rather than guessed at.

## Save semantics

A snapshot save uses `BEGIN IMMEDIATE`. Existing snapshot rows are replaced inside the same transaction and either the whole project state commits or the transaction rolls back.

## Load semantics

Rows are loaded in deterministic order, enum/revision values are checked, then the resulting graph is run through the native `ProjectGraph::replace_from_snapshot()` validator. A malformed graph never reaches the live `ProjectEngine`.

## Future work

- append-only command/event journal for forensic recovery and history;
- autosave generations/checkpoints;
- schema migration tests across real fixture databases;
- backup API and integrity checks;
- explicit crash/fault injection tests;
- content-addressed asset index stored separately from semantic project state.
