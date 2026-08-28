# Architecture

## Dependency rule

Dependencies point inward toward stable contracts and authoritative native domain state. UI frameworks, model runtimes, authentication mechanisms, transport adapters, and media libraries are adapters around the core — never the definition of the core.

```text
Studio UI (React / TypeScript)
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
          +-------+--------+
          v                v
     ProjectEngine      SnapshotStore
          |                |
          v                v
   ProjectGraph       SQLite adapter
          |
          +--> resource / job / media contracts

Replaceable outer providers:
AI director | image | video | voice | audio | QC | renderer
```

## Main boundaries

### `apps/studio`
Desktop-facing product surface. It renders Workflow, Episode, Scene, Shot, Inspector, Director, Preview, Timeline, and resource observability. UI state is not authoritative project state. Approval/lock/impact operations currently round-trip to the native engine.

### `engine/project`
Authoritative semantic project graph and typed mutation rules. Owns revision checks, lock behavior, staleness, dependency cycle prevention, invalidation, events, impact preview, and deterministic snapshots.

### `engine/application`
Application-level transaction coordination. `ProjectSession` stages a native mutation, persists its snapshot, and only then replaces live state. This prevents a successful UI mutation from leaving RAM and disk at different project revisions.

### `engine/ipc`
Versioned native process boundary. `ipc::Dispatcher` validates protocol envelopes, parses typed commands/snapshots, calls `ProjectSession`, and serializes typed responses. It does not own domain rules.

### `engine/persistence`
Storage adapters behind `SnapshotStore`. SQLite is the current implementation. Persistence validates and stores domain snapshots but does not decide project semantics.

### `engine/runtime`
Generic hard resource-safety/admission layer. Patent-sensitive adaptive synthesis-selection policy is intentionally not committed to the public repository.

### `tools/dev-bridge`
Development-only browser transport. It binds to localhost, spawns the native host, forwards versioned RPC, and supplies system telemetry. It is replaceable and must remain thin.

### `schemas` and `packages/contracts`
Versioned cross-language contracts. Anything crossing language/process boundaries needs an explicit stable representation. TypeScript types help Studio speak the native protocol without inventing a second domain model.

### `providers`
Replaceable adapters for AI Director and media capability. Heavy/incompatible model environments should run out-of-process and communicate through constrained provider contracts.

### `project_brain`
Canonical human/agent handoff context. Architecture changes are incomplete until this folder reflects them.

## Project truth

Project truth is the validated native semantic graph persisted transactionally. Generated media will live in a separate content-addressed asset/provenance layer and will be referenced by semantic project entities rather than treated as anonymous timeline files.

## Director safety boundary

A connected AI Director must emit typed, previewable operations. Impact is computed before expensive changes; user locks remain authoritative; optimistic revisions protect against stale clients. Claude/Codex must never become the persistence layer or receive unrestricted runtime authority.

## Process strategy

The current native project process is already isolated from Studio. Heavy media providers will later be additional isolated workers so Python/CUDA dependency conflicts, model crashes, and memory leaks cannot corrupt the project engine or UI process.

## Performance direction

The engine evolves through explicit resource budgets, bounded queues, resumable jobs, content-addressed caching, selective invalidation, deterministic provenance, and GPU-native media paths where justified. Novel synthesis-selection details remain private while the repository is public.
