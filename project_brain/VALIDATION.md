# Validation Record

This file records what was actually executed, not what is merely expected to work.

## Foundation history

The repository has progressively passed isolated native validation, strict GitHub Actions, and an earlier full Windows/NVIDIA quality gate. Validated foundation areas include the transactional semantic graph, SQLite persistence/migration, ProjectSession commit semantics, JSONL IPC, process-boundary host smoke, native-driven Studio state, presentation-only layout, durable history, typed Autopilot, and native ResourceManager.

The primary Windows development environment previously observed was Node v24.11.0, pnpm 10.15.0, CMake 4.1.2, Ninja 1.13.1, GNU C/C++ 15.2 via MSYS2 UCRT64, and an NVIDIA GeForce RTX 5070 Laptop GPU with 8151 MB reported by system doctor. An earlier full `./verify.ps1` gate passed and live Studio opened successfully.

CI/product testing has repeatedly found real defects; those defects were fixed without weakening warning, type, transaction, lock or persistence rules.

## 2026-08-29 — Durable native history

Protocol v1 supports bounded attributed `project.history`. `project.apply` validates actor/source/plan/reason context and bounded command batches. SQLite transaction provenance remains stored durably and is decoded in native C++ before reaching React.

The real engine-host process smoke performs an attributed mutation and reads the resulting actor/source/reason back over stdin/stdout from SQLite-backed history.

## 2026-08-29 — Exact pointer pick-and-place redesign

Hands-on testing rejected the earlier camera-follower implementation. The visible pointer could diverge from the logical pointer because the target node was measured before later camera motion, the rendered cursor was clamped to a safe frame, and active drag used approximate `delta * zoom` cursor integration.

The replacement removes `AutopilotCameraFollower.tsx` and introduces `workflowPointerInteraction.ts`.

Code-level behavior now enforced:

- rendered pointer coordinates are the logical interaction coordinates; no safe-frame clamp;
- an off-screen node is found through bounded visible workspace pan gestures;
- every pan viewport write is awaited before the next deterministic frame;
- target node anchor is freshly reprojected after viewport changes;
- pointer settles on that exact projected anchor before press;
- a small epsilon check verifies pre-grab alignment;
- viewport stays fixed while the node is held;
- each drag frame computes the node's exact flow-space position and projects the pointer from that same anchor;
- no `delta * zoom` integration is used;
- post-drop alignment is verified before the step completes;
- pause preserves the held presentation state;
- cancellation removes pan/drag presentation ownership;
- every displaced node gets an individual drag step; the old five-node/bulk-settle behavior is removed;
- deterministic 24 FPS presentation remains, with frame-index progress and awaited frame callbacks;
- step-specific finite liveness budgets remain active.

Strict Studio TypeScript and Vite production build passed with the exact-pointer implementation.

## 2026-08-29 — BackgroundJobRuntime lifecycle gate

A native bounded background lifecycle layer was added above `ResourceManager`.

Implemented and tested behavior:

- fixed capacity covers queued + running jobs;
- duplicate jobs rejected;
- resource-aware queue scan starts the first admissible job;
- a blocked GPU job does not block later CPU-only work when CPU/RAM are safe;
- every running job owns a scoped `ResourceLease`;
- requesting cancellation of running work does **not** release its resources;
- resources remain reserved until actual stop/completion confirmation;
- shutdown stops new admission and cancels queued work immediately;
- running shutdown is deterministic oldest-first;
- exactly one shutdown target is exposed at a time;
- repeated target reads return the same worker until it is confirmed stopped;
- wrong-target confirmation fails closed and preserves accounting;
- active resource count falls exactly one-by-one as workers are confirmed stopped;
- final shutdown reaches zero running jobs and zero active resource leases.

The current layer is lifecycle/admission ownership only. It does not launch model processes yet; WorkerSupervisor remains the next layer.

## 2026-08-29 — Current CI result

The exact-pointer + BackgroundJobRuntime branch state passed GitHub Actions code gates:

- bridge/fixture checks: passed;
- strict shared/Studio TypeScript: passed;
- Vite production build: passed;
- native C/C++ configure: passed;
- strict native build: passed;
- complete CTest suite: passed, including `makewatch_background_job_runtime_tests`;
- existing graph, SQLite, history, ResourceManager and process-smoke tests remained passing.

This is code-level validation. The new pointer choreography is not yet claimed as hands-on Windows validated.

## Required product-machine gate

From repository root:

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

Scatter several workflow nodes far from their canonical positions, including nodes outside the current viewport, then run **Let AI drive this workflow**.

Verify:

1. cursor visibly pans workflow space to find an off-screen node;
2. it arrives on the node body, not beside it;
3. it visibly settles before press;
4. press occurs while cursor is still exactly on the node;
5. node and cursor stay locked together for the whole drag;
6. release occurs at the final node position;
7. all displaced nodes are handled individually in sequence;
8. no hidden camera follow fights the pointer;
9. `Space` pause during a grab freezes rather than releases/teleports;
10. `Esc` / **Take back control** immediately cancels presentation ownership;
11. Inspector/topbar remain responsive during motion;
12. Assist layout does not advance native semantic revision;
13. final layout survives restart;
14. Durable Activity remains correct;
15. `./verify.ps1` passes the new background lifecycle test under the Windows toolchain.

Any pointer/node mismatch or freeze is a failed product gate and must be fixed before model/provider work.

## Next gate after live pointer validation

Build the concrete WorkerSupervisor on top of `BackgroundJobRuntime`:

```text
graceful stop request
 -> bounded grace wait
 -> terminate one stuck worker if necessary
 -> wait for actual process exit
 -> confirm stopped to BackgroundJobRuntime
 -> release that worker's ResourceLease
 -> advance to next worker
```

Then add typed worker health/capability handshake, bounded logging, checkpoint/recovery, content-addressed asset provenance, hardware probing/calibration, and lightweight local media providers.
