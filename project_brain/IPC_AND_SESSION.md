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
4. save the staged snapshot plus native events through `SnapshotStore`;
5. if persistence fails, return failure and leave live state untouched;
6. only after persistence succeeds, replace the live engine with staged state.

Therefore a successful mutation response means the in-memory authoritative state, persisted snapshot, and committed journal agree. Persistence-failure behavior is covered by native tests.

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
- `project.history`
- `project.replace`

### `project.apply`

The dispatcher parses typed project commands and commit context before routing through `ProjectSession`. It never bypasses the domain engine.

Current hard IPC bounds:

- command batch must contain 1..128 commands;
- actor must be `user`, `ai_director`, or `system`;
- source, plan ID, and reason strings are length-bounded;
- malformed or unknown context is rejected before native mutation.

Accepted commit context:

```json
{
  "actor": "user",
  "source": "studio-inspector",
  "planId": "",
  "reason": "manual Studio lock"
}
```

`ProjectSession` persists this attribution in the transaction event using the versioned `mwctx1` representation.

### `project.history`

`project.history` is a bounded read-only projection over the append-only journal. The caller requests 1..24 committed transactions, not arbitrary unbounded rows.

The dispatcher:

1. requests a bounded native event budget from `ProjectSession`;
2. groups events by project revision;
3. returns only groups containing `transaction.committed`, preventing an incomplete oldest transaction from being presented as a full commit;
4. parses `mwctx1` attribution inside native code;
5. returns structured `actor`, `source`, `planId`, `reason`, revision, and event data.

Storage encoding is therefore not leaked into React or the Node bridge.

History is revision-based; no wall-clock timestamp has been invented and no SQLite migration was added merely for display convenience.

## Development bridge

`tools/dev-bridge/server.mjs` exists to make the browser-based Studio usable during development.

Properties:

- binds only to `127.0.0.1`;
- allows CORS only from localhost / 127.0.0.1 development origins;
- limits JSON request bodies;
- correlates concurrent native RPC requests by UUID;
- times out unresponsive native RPC calls;
- fails closed if the native engine exits unexpectedly;
- exposes bounded `/api/project/history?limit=` by forwarding to native `project.history`;
- exposes NVIDIA telemetry through `nvidia-smi` for UI observability only;
- stores the development project at `.makewatch/dev-project.sqlite3` by default.

GPU telemetry displayed by Studio is observational. Runtime admission decisions remain a native-engine responsibility.

## Studio ownership rule

The React application may project and edit state, but it must not implement graph or persistence invariants. Approval, lock/unlock, dependency impact, and durable Activity/history all come from the native boundary.

The development seed is inserted through native typed commands. It is fixture data, not a second domain implementation.

## Process-boundary validation

The native CTest suite starts the actual `makewatch_engine_host` executable and streams JSONL through stdin/stdout. The smoke path performs a real SQLite-backed attributed mutation, reads the snapshot, reads `project.history`, validates actor/source/reason persistence, and verifies that the project database was created.

This is deliberately stronger than testing `ipc::Dispatcher` only in-process.

## AI Director integration rule

Claude/Codex integration is not implemented or faked at this milestone. When added, the provider adapter must translate natural-language intent into validated plans/operations and submit semantic work through the same native command/impact/history boundary. Provider code must not mutate project files or SQLite directly.
