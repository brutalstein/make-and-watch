# Native Session and IPC Boundary

## Purpose

Studio must never become a second project engine. The authoritative state and mutation rules live in C++ and are persisted through the native application boundary.

The current development path is:

```text
React Studio
    |
    v
localhost development bridge (Node, transport only)
    |
    v
versioned JSONL protocol v1
    |
    v
makewatch_engine_host
    |
    v
ipc::Dispatcher
    |
    v
application::ProjectSession
   / \
  v   v
ProjectEngine   SnapshotStore
                   |
                   v
             SQLite project DB
```

The Node bridge is replaceable. It owns no project invariants and is not a persistence authority. A future packaged desktop shell may spawn and communicate with `makewatch_engine_host` directly while preserving the same native contract.

## ProjectSession transaction guarantee

`ProjectEngine` already makes a command batch atomic in memory. `ProjectSession` extends that guarantee across persistence:

1. copy the current engine into a staged engine;
2. apply the command batch to the staged engine;
3. if domain validation fails, return the typed failure and leave live state untouched;
4. save the staged snapshot through `SnapshotStore`;
5. if persistence fails, return failure and leave live state untouched;
6. only after persistence succeeds, replace the live engine with staged state.

Therefore a successful mutation response means the in-memory authoritative state and persisted snapshot agree. A simulated persistence failure is covered by native tests.

## Protocol v1

The native host accepts one JSON request per stdin line and emits one JSON response per stdout line.

Request envelope:

```json
{
  "protocol": 1,
  "id": "caller-generated-id",
  "method": "project.snapshot",
  "params": {}
}
```

Success and failure responses preserve the request id and protocol version. Failures expose stable machine-readable error codes plus a human-readable message.

Implemented methods:

- `health`
- `project.snapshot`
- `project.impact`
- `project.apply`
- `project.replace`

`project.apply` parses typed project commands and routes them through `ProjectSession`; it does not bypass the native domain engine.

## Development bridge

`tools/dev-bridge/server.mjs` exists to make the browser-based Studio usable during development.

Properties:

- binds only to `127.0.0.1`;
- allows CORS only from localhost / 127.0.0.1 development origins;
- limits JSON request bodies;
- correlates concurrent native RPC requests by UUID;
- times out unresponsive native RPC calls;
- fails closed if the native engine exits unexpectedly;
- exposes NVIDIA telemetry through `nvidia-smi` for UI observability only;
- stores the development project at `.makewatch/dev-project.sqlite3` by default.

GPU telemetry displayed by Studio is observational. Runtime admission decisions remain a native-engine responsibility.

## Studio ownership rule

The React application may project and edit state, but it must not implement graph invariants. Current Studio operations such as approval, lock/unlock, and dependency impact preview call the native bridge and use optimistic node revisions.

The development seed is also inserted through native typed commands. It is fixture data, not a second domain implementation.

## Process-boundary validation

The native CTest suite includes a smoke test that starts the actual `makewatch_engine_host` executable, streams JSONL requests through stdin, performs a real SQLite-backed mutation, reads a snapshot from stdout, validates success responses, and verifies that the project database was created.

This is deliberately stronger than testing `ipc::Dispatcher` only in-process.

## AI Director integration rule

Claude/Codex integration is not implemented or faked at this milestone. When added, the provider adapter must translate natural-language intent into validated operations and submit them through the same native command/impact/approval boundary. Provider code must not mutate project files or SQLite directly.
