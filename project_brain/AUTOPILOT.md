# AI Director Autopilot

## Product intent

Make & Watch must remain usable by people who do not understand node editors, dependency graphs, generation pipelines, or production workflow mechanics.

Autopilot therefore lets an AI Director **operate the Studio on the user's behalf while making that work visibly understandable**. The user can watch a cinematic virtual cursor focus nodes, inspect impact, reorganize the workspace, and later execute validated semantic operations.

The important principle is:

> The AI does not gain an unrestricted desktop mouse. It receives a typed plan and the Studio projects that plan through a controlled virtual cursor.

This provides the visual feeling of an expert operating the application without sacrificing deterministic execution, testability, native safety, or UI responsiveness.

## Architecture

```text
Claude / Codex / deterministic demo planner
                  |
                  v
          AutopilotPlan v1
                  |
                  v
       validateAutopilotPlan
                  |
                  v
   AutopilotExecutionControl
 pause / resume / cancel / checkpoint
                  |
                  v
       executeAutopilotPlan
       /          |          \
      v           v           v
virtual cursor  workspace   native semantic
+ camera        actions     project.apply
      |           |           |
      +-----------+-----------+
                  |
                  v
           visible Studio
```

Provider authentication and plan generation are deliberately separate from execution. Claude/Codex will become plan producers; they do not replace the executor or native engine.

## Typed plan

`apps/studio/src/director/autopilotTypes.ts` defines versioned plan schema 1.

Current step vocabulary:

- `announce`
- `focusNode`
- `dragNode`
- `previewImpact`
- `arrangeWorkflow`
- `fitWorkflow`
- `applyCommands`
- `checkpoint`
- `wait`

A plan also carries plan ID, provider identity, autonomy mode, expected native project revision, and bounded ordered steps. Unknown or unsafe plans are rejected before execution.

## Validation boundary

`autopilotValidation.ts` currently enforces supported schema, exact expected project revision, bounded step/command counts, unique step IDs, known targets, finite/bounded coordinates and durations, dependency endpoints, and Assist-mode prohibition on semantic mutation.

A Claude/Codex response is never trusted merely because it came from a model.

## Deterministic presentation governor

Hands-on use showed that visually updating cursor, node state, React Flow camera, and the entire Studio tree at display refresh rate can make an otherwise lightweight workflow feel too fast or temporarily freeze on high-refresh displays.

The presentation runtime now has an explicit performance budget:

- cursor/node presentation cadence is fixed at **24 FPS**;
- motion progress is frame-index based rather than wall-clock catch-up based;
- pause or background-tab stalls slow the presentation instead of teleporting it forward;
- cursor travel duration is distance-aware and bounded;
- visible node drags are deliberately slower and readable;
- the virtual cursor uses an external `useSyncExternalStore` presentation store, so cursor frames do **not** re-render the full `App`, Inspector, telemetry, and controlled workflow host;
- stale edge animation is suspended while Autopilot owns the workflow;
- camera DOM observation and React Flow reads are sampled at the same 24 FPS budget, even on 144/165 Hz displays;
- at most one React Flow viewport write may be outstanding;
- pan/zoom steps are bounded and damped;
- the deterministic workspace demo physically moves at most five representative displaced nodes and settles repetitive remainder as one presentation-only layout pass.

This presentation budget is not semantic project state and is intentionally independent from native revision/resource accounting.

## Execution liveness

A visually impressive automation that can remain stuck forever is unacceptable.

Presentation/read-only actions have bounded execution deadlines. Focus, drag, impact preview, arrange, and fit must complete within budget or fail safely. Explicit user approval checkpoints remain unbounded because waiting for the user is intended.

Authoritative semantic `applyCommands` is deliberately different. It is not wrapped in a second UI-only race timeout that could report failure while a native transaction is still completing. Transport correlation, localhost RPC timeout policy, `ProjectSession`, and transactional persistence own that boundary.

A timed-out presentation step cancels execution control and becomes a visible failed state rather than retaining interaction ownership forever.

## Autonomy modes

### Assist

Presentation and inspection only. It may organize the canvas, focus nodes, inspect dependency impact, and explain work. It cannot issue semantic project mutations. The bundled **AI Workspace Drive** uses this mode.

### Guided

May prepare and execute typed semantic operations but stops at configured creative checkpoints for user approval.

### Director

May execute a user-authorized plan over broader scope while still respecting native locks, revisions, resource limits, typed policy, and explicit takeover controls.

The distinction is a capability policy, not merely a UI label.

## Virtual cursor

`VirtualCursor.tsx` is a Studio overlay, not operating-system cursor injection.

Reasons:

- deterministic and testable;
- does not steal the user's real mouse;
- cross-platform;
- cannot click arbitrary desktop applications;
- motion is controllable and cinematic;
- actions remain tied to typed Studio entities.

The cursor supports travel, press state, ripple, glow/trail, AI badge, contextual labels, and is rendered from its own external presentation store so high-frequency cursor updates stay isolated from the application tree.

## Cinematic workflow camera

`AutopilotCameraFollower.tsx` owns presentation-only camera follow while the cursor is actively searching or dragging.

Rules:

- dead/safe frame instead of permanent centering;
- composition widens during search and tightens gently during manipulation;
- cursor and selected node remain inside the visible safe frame while the workflow moves beneath them;
- pan/zoom are bounded;
- DOM/React Flow observation is capped at 24 FPS;
- only one viewport mutation may be pending;
- ownership is transient and yields to explicit fit/focus operations;
- takeover startup does not move the graph before the cursor enters the workflow;
- labels flip near frame edges.

Camera motion never changes semantic state or saved node coordinates.

## Interaction ownership

While Autopilot is planning/executing/paused/waiting for approval, manual workflow dragging, node selection, Scene Strip mutation and native mutation buttons are disabled.

The user must never be trapped:

- `Esc` immediately takes control back;
- **Take back control** is always visible during takeover;
- `Space` pauses/resumes except at an approval checkpoint;
- Guided/Director checkpoints expose explicit continuation.

A cancelled plan cannot continue executing later steps.

## Presentation versus semantic actions

Presentation-only actions include drag, arrange, fit, focus and cinematic pan/zoom. They must not advance native revision, invalidate dependencies, change locks/approval, create semantic events or start generation.

`applyCommands` is the only Autopilot step that may change authoritative project truth:

```text
Autopilot executor
      -> engineClient
      -> localhost/native transport
      -> JSONL IPC
      -> ProjectSession
      -> staged ProjectEngine
      -> transactional persistence + journal
      -> live commit
```

No Autopilot feature may mutate SQLite/project files by DOM manipulation or direct filesystem access.

## Durable provenance

The attribution path is now complete through protocol v1.

Semantic commits may carry:

- actor (`user`, `ai_director`, `system`);
- source;
- plan ID;
- reason.

The native dispatcher validates/bounds that context, `ProjectSession` persists it in the versioned `mwctx1` transaction detail, and native `project.history` parses it back into typed structured fields. Studio therefore does not parse the storage encoding.

The Activity surface can distinguish human, AI Director, and system commits. Older transactions created before full attribution may legitimately appear as system/unattributed history.

## Current deterministic demo

**Let AI drive this workflow** builds a deterministic Assist-mode plan against the live native snapshot. It:

1. validates exact native revision;
2. frames and briefly scans the graph;
3. identifies displaced nodes;
4. finds and visibly drags at most five representative nodes with distance-aware pacing;
5. periodically reframes instead of mechanically racing across cards;
6. settles repetitive remainder as one presentation-only dependency layout;
7. saves workspace coordinates only;
8. focuses a review-relevant scene/shot;
9. requests native dependency impact;
10. explicitly completes and returns control;
11. never mutates semantic project state.

This is not pretending Claude/Codex is connected. It is a real validated execution harness for future plan producers.

## Non-negotiable invariants

- Never directly map provider text to arbitrary DOM click handlers.
- Never give a model unrestricted OS mouse/keyboard access as the normal product design.
- Never allow Assist mode to change semantic state.
- Never disable emergency takeover.
- Never leave ordinary presentation/read-only steps unbounded.
- Never add a UI-only race timeout around an authoritative semantic commit.
- Never bypass native locks/revisions.
- Never let animation/camera state become project truth.
- Never hide a semantic commit behind cosmetic drag.
- Never execute a plan against obsolete project revision.
- Never trust provider output before typed validation.
- Never drive presentation at unrestricted display refresh rate when a bounded cadence is sufficient.

## Next evolution

1. checkpoint/recovery policy on top of snapshot + journal;
2. content-addressed asset/provenance storage;
3. native bounded job queue and worker supervisor using scoped resource leases;
4. Claude/Codex plan-producer adapters after supported authentication is verified;
5. Guided semantic plan preview/checkpoints;
6. replayable visual explanations driven from recorded plan/action metadata where useful.
