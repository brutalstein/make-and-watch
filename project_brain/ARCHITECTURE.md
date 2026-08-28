# Architecture

## Dependency rule

Dependencies point inward toward stable contracts and authoritative native domain state. UI frameworks, model runtimes, authentication mechanisms, transport adapters, and media libraries are adapters around the core — never the definition of the core.

```text
Studio UI (React / TypeScript)
        |
        +--> presentation-only workspace state
        |      drag positions / viewport / layout
        |
        v
shared versioned contracts
        |
        v
local transport adapter
(Node bridge in development)
        |
        v
JSONL IPC protocol v1
        |
        v
C++ makewatch_engine_host
        |
        v
Dispatcher -> ProjectSession
                  |
          +-------+----------------+
          v                        v
     ProjectEngine             SnapshotStore
          |                        |
          v                        v
   ProjectGraph          SQLite snapshot + journal
          |
          +--> resource / job / media contracts

Replaceable outer providers:
AI director | image | video | voice | audio | QC | renderer
```

## Main boundaries

### `apps/studio`
Desktop-facing product surface. It renders Workflow, Episode, Scene, Shot, Inspector, Director, Preview, Timeline, resource observability, and workspace interaction. UI state is not authoritative project state. Approval/lock/impact operations round-trip to the native engine.

Workflow coordinates are explicitly presentation-only. Dragging a node reorganizes the user's workspace and is persisted separately; it does not advance native project revision, alter dependencies, mark media stale, or produce native semantic events. See `WORKSPACE_LAYOUT.md`.

### `engine/project`
Authoritative semantic project graph and typed mutation rules. Owns revision checks, lock behavior, staleness, dependency cycle prevention, invalidation, events, impact preview, and deterministic snapshots.

### `engine/application`
Application-level transaction coordination. `ProjectSession` stages a native mutation, obtains its semantic events, atomically persists snapshot + events through the storage boundary, and only then replaces live state. This prevents a successful UI mutation from leaving RAM, disk, and native history at different revisions.

### `engine/ipc`
Versioned native process boundary. `ipc::Dispatcher` validates protocol envelopes, parses typed commands/snapshots, calls `ProjectSession`, and serializes typed responses. It does not own domain rules.

### `engine/persistence`
Storage adapters behind `SnapshotStore`. SQLite is the current implementation. Persistence validates/stores domain snapshots and an append-only committed event journal but does not decide project semantics. Schema v2 and journal details are in `PERSISTENCE.md` and `JOURNAL_AND_RECOVERY.md`.

### `engine/runtime`
Generic hard resource-safety/admission layer. Patent-sensitive adaptive synthesis-selection policy is intentionally not committed to the public repository.

### `tools/dev-bridge`
Development-only browser transport. It binds to localhost, spawns the native host, forwards versioned RPC, supplies system telemetry, and performs narrowly scoped migration of the bundled development fixture. It is replaceable and must remain thin. Development fixture repair must never become a generic user-project mutation path.

### `schemas` and `packages/contracts`
Versioned cross-language contracts. Anything crossing language/process boundaries needs an explicit stable representation. TypeScript types help Studio speak the native protocol without inventing a second domain model.

### `providers`
Replaceable adapters for AI Director and media capability. Heavy/incompatible model environments should run out-of-process and communicate through constrained provider contracts.

### `project_brain`
Canonical human/agent handoff context. Architecture changes are incomplete until this folder reflects them.

## State ownership

There are deliberately different classes of state:

| State | Owner | Examples |
| --- | --- | --- |
| Semantic project truth | C++ `ProjectEngine` | entities, metadata, approvals, locks, staleness, dependencies |
| Durable current project | `SnapshotStore` / SQLite | validated current semantic snapshot |
| Durable committed history | SQLite journal | native events per project revision |
| Workspace presentation | Studio workspace store | node x/y, viewport preferences |
| Runtime telemetry | runtime/bridge observation | GPU usage, temperature, free RAM |
| Future generated assets | content-addressed asset store | image/video/audio blobs + provenance |

Never solve a convenience problem by moving one state category into the wrong owner.

## Project truth

Project truth is the validated native semantic graph persisted transactionally. The event journal records committed history but is not yet a complete event-sourced reconstruction mechanism. Generated media will live in a separate content-addressed asset/provenance layer and will be referenced by semantic project entities rather than treated as anonymous timeline files.

## Director safety boundary

A connected AI Director must emit typed, previewable operations. Impact is computed before expensive changes; user locks remain authoritative; optimistic revisions protect against stale clients. Claude/Codex must never become the persistence layer or receive unrestricted runtime authority.

AI proposals that the user has not approved are not committed native history. Once an approved operation crosses `project.apply`, its resulting native events can be journaled with the committed revision.

## Process strategy

The current native project process is already isolated from Studio. Heavy media providers will later be additional isolated workers so Python/CUDA dependency conflicts, model crashes, and memory leaks cannot corrupt the project engine or UI process.

## Performance direction

The engine evolves through explicit resource budgets, bounded queues, resumable jobs, content-addressed caching, selective invalidation, deterministic provenance, and GPU-native media paths where justified. Novel synthesis-selection details remain private while the repository is public.
