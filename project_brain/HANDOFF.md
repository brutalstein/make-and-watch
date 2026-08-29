# Session Handoff

## Current state

Foundation work is on `foundation/series-engine-v0` and tracked by draft PR #1.

The current foundation includes:

- C++20 transactional semantic project graph with typed commands/events, revisions, locks, approvals, staleness, dependency invalidation, impact preview, snapshots and guarded hydration;
- SQLite schema v2 with WAL, foreign keys, atomic snapshot + append-only journal persistence and v1 migration;
- `ProjectSession` persist-before-live-commit semantics;
- durable commit provenance (`actor`, `source`, `plan`, `reason`) and bounded native `project.history`;
- JSONL IPC v1 + real `makewatch_engine_host` process;
- localhost development bridge and native-driven React/TypeScript Studio;
- presentation-only workflow layout separated from semantic state;
- Durable Activity feed backed by native history;
- generic native `ResourceManager` with VRAM/RAM/CPU budgets, GPU exclusivity, admission preview, high-water metrics, counters and move-only `ResourceLease`;
- native `BackgroundJobRuntime` with bounded job capacity, resource-aware ready scanning, cancellation ownership and deterministic one-at-a-time shutdown contract;
- typed AI Director Autopilot with exact-revision validation, pause/resume/cancel/checkpoints and emergency takeover;
- exact workflow pointer pick-and-place interaction for every displaced node;
- provider-agnostic Director boundary; Claude/Codex authentication remains intentionally unimplemented rather than faked.

## Exact pointer milestone

The previous autonomous camera-follower design was removed after hands-on testing showed visible pointer/node drift.

`AutopilotCameraFollower.tsx` is deleted. `VirtualCursor` no longer clamps the rendered pointer away from its logical coordinate.

The canonical workflow interaction now lives in `workflowPointerInteraction.ts` and follows:

```text
pan workspace -> find node -> exact hover -> settle -> press ->
move node + pointer from the same projected anchor -> release -> verify -> next node
```

Important implementation guarantees:

- off-screen nodes are found by visible bounded workspace pan gestures, not hidden `fitView`/teleport;
- pointer location is reprojected after viewport mutations before press;
- rendered pointer coordinate equals logical pointer coordinate;
- drag does not use `delta * zoom` integration;
- viewport stays fixed while a node is held;
- every drag frame projects the exact next node anchor and places the pointer at the same point;
- pre-grab and post-drop alignment are checked with a small epsilon;
- every displaced node gets its own `dragNode` step; the old five-node limit/bulk remainder path is gone;
- deterministic 24 FPS animation remains, with awaited frame callbacks so viewport writes cannot overtake one another;
- pause preserves grab presentation instead of pretending to release the node;
- cancellation clears panning/dragging presentation state immediately.

See `AUTOPILOT.md`.

## Background runtime milestone

`BackgroundJobRuntime` now sits above `ResourceManager`.

It does **not** launch model processes yet. It owns lifecycle/admission state and each running job's resource lease so the future process supervisor cannot free accounting early.

Key rules:

- queued + running work is bounded by fixed capacity;
- duplicate job IDs are rejected;
- resource-blocked GPU work does not cause head-of-line blocking for later safe CPU-only work;
- cancelling queued work removes it immediately because it owns no lease;
- cancelling running work changes state to cancellation-requested but retains VRAM/RAM/CPU accounting;
- resources are released only after actual stop/completion confirmation;
- shutdown stops new admission and cancels queued work;
- exactly one running shutdown target is exposed at a time;
- the same target remains current until stop is confirmed;
- wrong-target confirmation fails closed;
- shutdown releases running resource leases one-by-one in deterministic oldest-first order.

See `BACKGROUND_JOBS.md` and `RUNTIME_FOUNDATION.md`.

## CI validation

The exact-pointer + BackgroundJobRuntime code passed the current GitHub Actions code gates:

- bridge/fixture checks;
- strict shared/Studio TypeScript;
- Vite production build;
- strict native configure/build;
- complete CTest suite;
- new background lifecycle tests.

Background runtime tests cover bounded capacity, duplicate rejection, GPU head-of-line avoidance, cancellation retaining resource reservations, sequential shutdown, wrong-target fail-closed behavior and active resource count reaching zero only after final confirmed stop.

Code-level CI is green; the newest pointer behavior still requires a hands-on Windows/NVIDIA product-machine run before it is called visually validated.

## Immediate Windows gate

From repository root:

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

Then deliberately scatter multiple nodes far apart and run **Let AI drive this workflow**.

Validate:

1. AI moves through workflow space to find an off-screen target by visibly panning the canvas;
2. cursor ends visibly on the node body before any grab;
3. a short hover/settle is visible;
4. cursor presses while exactly on the node;
5. node and pointer remain locked together throughout the drag;
6. pointer releases at the final node position;
7. it repeats the full sequence for every displaced node, not only a sample;
8. no hidden camera motion fights the cursor;
9. `Space` pause during a grab freezes the held state without teleport/release;
10. `Esc` / **Take back control** cancels and returns interaction immediately;
11. Studio remains responsive during movement;
12. presentation-only layout does not increment native project revision;
13. arranged positions persist after restart;
14. `./verify.ps1` passes the new background lifecycle tests on the Windows toolchain.

Any pointer/node mismatch or freeze found on the product machine must be treated as a failed gate, not papered over by more camera motion.

## Next engineering sequence

1. concrete cross-platform WorkerSupervisor on top of `BackgroundJobRuntime`;
2. graceful stop -> bounded wait -> one-process termination escalation -> confirmed exit -> lease release;
3. typed worker health/capability handshake and bounded logs;
4. checkpoint/recovery policy on snapshot + journal;
5. content-addressed asset/provenance storage;
6. hardware-profile probing/calibration;
7. first lightweight local voice/storyboard provider paths;
8. Claude/Codex plan producers only after supported authentication is reverified.

## What not to do

- Do not reintroduce `AutopilotCameraFollower` or cursor safe-frame clamping.
- Do not use stale DOM coordinates after viewport movement.
- Do not use `delta * zoom` cursor integration during node drag.
- Do not bulk-move displaced nodes while claiming the AI handled them individually.
- Do not let presentation state mutate native semantic state.
- Do not give providers unrestricted OS mouse/keyboard or arbitrary DOM authority.
- Do not free running-job resources when cancellation is merely requested.
- Do not expose a second shutdown target before the first worker is confirmed stopped.
- Do not let scheduler/provider code bypass `ResourceManager`.
- Do not claim WorkerSupervisor/process launching exists yet.
- Do not make ComfyUI project-state owner.
- Do not implement fake/custom Claude subscription OAuth.
- Do not weaken strict type/compiler/test gates.
- Do not publicly disclose patent-sensitive adaptive synthesis-selection logic while the repo is public.

## Quality bar

“100/100” is the engineering target: deterministic behavior, explicit ownership, bounded failure modes, strict tests and product-machine evidence. It is not a claim that software can never contain a defect.
