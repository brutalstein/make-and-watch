# AI Director Autopilot

## Product intent

Make & Watch must be usable by people who do not understand node editors. Autopilot therefore operates the Studio through a visible **virtual pointer**, but the pointer is only a projection of validated typed actions. It never receives unrestricted OS mouse/keyboard authority.

Provider authentication and planning remain separate from execution: Claude/Codex will produce typed plans; Studio executes those plans; native C++ remains semantic authority.

## Exact workflow pointer protocol

Hands-on testing proved that a hidden camera follower plus cursor clamping was the wrong interaction model. It allowed the logical pointer coordinate, rendered pointer coordinate, viewport and node position to diverge.

That design has been removed.

Every displaced workflow node now follows one deterministic physical sequence:

```text
PAN WORKSPACE
     |
     v
FIND TARGET NODE
     |
     v
MOVE POINTER TO EXACT NODE ANCHOR
     |
     v
SETTLE / HOVER
     |
     v
PRESS / GRAB
     |
     v
DRAG NODE + POINTER TOGETHER
     |
     v
RELEASE AT TARGET
     |
     v
VERIFY POINTER/NODE ALIGNMENT
     |
     v
NEXT NODE
```

The implementation lives in `workflowPointerInteraction.ts`.

## Finding an off-screen node

Autopilot does not secretly center the graph or teleport the camera to the target.

If a target node is outside the visible workflow interaction frame:

1. the pointer moves to empty workflow space;
2. presses the workspace;
3. performs one bounded pan gesture;
4. releases;
5. reprojects the target node after the viewport mutation;
6. repeats until the target is visible.

Pan gestures are bounded and finite. The target must enter the interaction frame within the configured gesture limit or the step fails safely.

This means the user can actually watch the AI search through workflow space.

## Exact grab invariant

Once visible, the node anchor is calculated in flow coordinates and projected with React Flow's current viewport into screen coordinates.

The pointer is moved to that exact projected point. After all viewport writes finish, the point is projected again and the pointer is snapped to the fresh value before press.

The visible `VirtualCursor` is rendered directly at its logical `x/y`. There is no safe-frame clamp or second display coordinate.

A small epsilon assertion verifies that pointer and projected node anchor agree before interaction continues.

## Exact drag invariant

The previous implementation integrated pointer movement using `node delta * zoom`. That accumulated error whenever viewport state changed.

The replacement does not integrate cursor deltas.

During an active grab:

- viewport is intentionally fixed;
- each deterministic frame computes the node's exact next flow-space position;
- React Flow node state is updated;
- that exact node anchor is projected back into screen coordinates;
- the pointer is placed at that projected coordinate in the same presentation frame.

Therefore pointer and node derive from the same source of truth on every drag frame.

A final post-drop alignment check is required before the step completes.

## All displaced nodes are handled individually

The earlier demonstration limited visible drags and bulk-arranged the remainder. That behavior was removed.

`buildWorkspaceAutopilotPlan()` now emits one `dragNode` step for **every displaced node** in deterministic semantic order. Each node is found, grabbed, moved and released individually.

The plan ID is deterministic for the same native revision + displaced-node count; `Date.now()` is not used.

The plan remains bounded by validation (`MAX_STEPS`) so malformed or unreasonable provider plans cannot create infinite work.

## Presentation governor

Pointer/node/viewport gesture animation still uses a bounded 24 FPS deterministic presentation cadence.

- progress is frame-index based;
- pause/background stalls do not cause wall-clock teleport;
- awaited frame callbacks prevent viewport writes from overtaking one another;
- cursor state remains in an external `useSyncExternalStore`, so pointer frames do not re-render the whole Studio tree;
- stale semantic edge animation is suspended while Autopilot owns interaction;
- distance-aware durations keep short movement intentional and long movement readable.

This is presentation state only and never advances native project revision.

## Removed architecture

`AutopilotCameraFollower.tsx` has been deleted.

Do not reintroduce:

- autonomous camera follow fighting pointer actions;
- safe-frame clamping of rendered cursor coordinates;
- one-time DOM center measurement followed by later viewport movement;
- `delta * zoom` pointer integration;
- bulk-arranging unvisited displaced nodes;
- hidden `fitView` before a node-search sequence.

## Pause / cancellation behavior

Pause preserves the physical grab state. If the AI is holding a node, the cursor does not visually release merely because execution is paused.

Cancellation (`Esc` / **Take back control**) remains authoritative and performs presentation cleanup:

- execution control is aborted;
- workflow-pan presentation class is removed;
- any controlled `dragging` marker is cleared;
- virtual cursor is hidden/released;
- no later plan step may continue.

## Execution liveness

Presentation operations remain bounded. Physical find/drag steps receive larger finite budgets than simple UI actions because a distant target may need several visible workspace pan gestures.

Semantic `applyCommands` remains different: it is an authoritative native transaction and is not wrapped in a competing UI-only timeout race. Transport correlation and `ProjectSession` own that boundary.

## Autonomy modes

### Assist
Presentation/inspection only. It may move workspace nodes but cannot mutate semantic project state. Current **AI Workspace Drive** remains Assist mode.

### Guided
May submit typed semantic commands but stops at configured user approval checkpoints.

### Director
May execute broader user-authorized plans while still respecting native locks, revisions, resource policy, validation and emergency takeover.

## Durable provenance

Semantic AI operations travel through:

```text
Autopilot executor
  -> engineClient
  -> local transport
  -> JSONL IPC
  -> ProjectSession
  -> SQLite snapshot + journal
```

Actor/source/plan/reason context is validated natively and returned through typed `project.history`. Studio does not parse SQLite provenance encoding.

## Non-negotiable invariants

- Visible pointer coordinate must equal logical pointer coordinate.
- Never press a node using a stale pre-camera/pre-pan screen measurement.
- Never integrate pointer position from approximate zoom deltas during node drag.
- Never bulk-move a displaced node that the stepwise workspace demo claims to manipulate visibly.
- Never let presentation state become semantic project truth.
- Never let Assist mode mutate native semantic state.
- Never execute a stale-revision plan.
- Never give provider text arbitrary DOM/OS control.
- Never remove emergency takeover.
- Never weaken deterministic bounds merely to make an animation appear to finish.

## Next evolution

1. live Windows product-machine validation of exact pointer pick-and-place;
2. worker supervisor using the native background-job lifecycle contract;
3. checkpoint/recovery policy and content-addressed asset provenance;
4. Claude/Codex plan producers after supported authentication behavior is reverified;
5. Guided semantic plan preview/checkpoints.
