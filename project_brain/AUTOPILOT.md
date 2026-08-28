# AI Director Autopilot

## Product intent

Make & Watch must remain usable by people who do not understand node editors, dependency graphs, generation pipelines, or production workflow mechanics.

Autopilot therefore lets an AI Director **operate the Studio on the user's behalf while making that work visibly understandable**. The user can watch a cinematic virtual cursor focus nodes, inspect impact, reorganize the workspace, and later execute validated semantic operations.

The important principle is:

> The AI does not gain an unrestricted desktop mouse. It receives a typed plan and the Studio projects that plan through a controlled virtual cursor.

This provides the visual feeling of an expert operating the application without sacrificing deterministic execution, testability, or native safety boundaries.

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

A plan also carries:

- plan ID;
- provider identity;
- autonomy mode;
- expected native project revision;
- bounded ordered steps.

Unknown or unsafe plans are rejected before execution.

## Validation boundary

`autopilotValidation.ts` currently enforces:

- supported plan schema;
- exact expected project revision;
- bounded step count;
- unique step IDs;
- known node targets;
- finite/bounded coordinates;
- bounded waits and animation durations;
- bounded command counts;
- known dependency endpoints;
- no semantic mutation in Assist mode.

Future provider-generated plans must pass the same validation. A Claude/Codex response is never trusted merely because it came from a model.

## Execution liveness

A visually impressive automation that can remain stuck forever is not acceptable product behavior.

The executor therefore applies a bounded execution deadline to **presentation and read-only workflow actions**. Focus, drag, impact preview, arrange, and fit steps must either complete within their execution budget or fail safely. Explicit user approval checkpoints are intentionally unbounded because waiting for the user is the requested behavior.

Authoritative semantic `applyCommands` is deliberately different. It is not wrapped in a second UI-only race timeout that could report failure while a native transaction is still completing. Transport correlation, localhost RPC timeout policy, `ProjectSession`, and transactional persistence own that boundary. This prevents the UI from inventing a split-brain success/failure state around a real commit.

A timed-out presentation step cancels the execution control and becomes a visible failed Autopilot state rather than leaving the Studio interaction lock active indefinitely.

The deterministic workspace demo also limits repetitive visible cursor work. It physically demonstrates a bounded number of meaningful node moves; if a large graph contains more displaced nodes, the remaining presentation-only layout is settled as one deterministic dependency-layout operation. This keeps the interaction understandable on both 8-node and future 800-node projects.

## Autonomy modes

### Assist

Presentation and inspection only. It may organize the canvas, focus nodes, inspect dependency impact, and explain what it is doing. It cannot issue semantic project mutations.

The current deterministic **AI Workspace Drive** demo intentionally uses Assist mode.

### Guided

May prepare and execute typed semantic operations but must stop at configured creative checkpoints for user approval.

### Director

May execute a user-authorized plan over a broader scope while still respecting native locks, revisions, resource limits, and explicit stop controls. Critical policies may still force checkpoints.

The distinction is a capability policy, not merely a UI label.

## Virtual cursor

`VirtualCursor.tsx` is a Studio overlay, not an operating-system cursor injection system.

Reasons:

- deterministic and testable;
- does not steal the user's real mouse;
- cross-platform;
- cannot click arbitrary desktop applications;
- motion can be cinematic and consistent;
- actions remain tied to typed Studio entities instead of screen coordinates alone.

The cursor supports visible movement, press state, click ripple, glow/trail, AI identity badge, and contextual activity labels.

## Cinematic workflow camera

`AutopilotCameraFollower.tsx` owns presentation-only camera follow while the AI cursor is actively searching or dragging.

Rules:

- the camera uses a dead/safe frame rather than permanently centering the cursor;
- when the AI is travelling to find a distant node, the composition gradually widens;
- when the AI presses and manipulates a node, the composition tightens slightly;
- cursor and selected node remain inside the visible safe frame while the workflow pans beneath them;
- pan and zoom are damped and bounded per animation frame;
- camera ownership is transient and is released as soon as cursor motion settles;
- explicit `fitView` / focus commands are therefore free to run without fighting a second camera controller;
- initial takeover choreography does not move the graph until the cursor actually enters the workflow;
- label placement flips near viewport edges so cursor explanations remain visible.

Camera motion never changes semantic state or saved node coordinates. It is a pure projection of what the AI is currently doing.

## Interaction ownership

While Autopilot is planning/executing/paused/waiting for approval:

- manual workflow dragging is disabled;
- node selection is disabled;
- scene strip interaction is disabled;
- manual native mutation buttons are disabled;
- Studio places a takeover interaction layer over normal controls.

The user must **never** be trapped by automation. The following remain authoritative:

- `Esc` — immediately take back control;
- **Take back control** — visible stop action;
- `Space` — pause/resume while not at an approval checkpoint;
- explicit approval continuation when a Guided/Director plan requests it.

A cancelled plan cannot continue executing later steps.

## Presentation versus semantic actions

### Presentation-only

Examples:

- drag node;
- arrange graph;
- fit viewport;
- center/focus node;
- cinematic pan/zoom camera motion.

These update Studio workspace state only. They must not:

- advance native project revision;
- invalidate dependencies;
- change approvals/locks;
- create native semantic events;
- start generation.

### Semantic

`applyCommands` is the only Autopilot step that may change authoritative project truth.

It routes through the same path as human-authorized mutations:

```text
Autopilot executor
      -> engineClient
      -> localhost/native transport
      -> JSONL IPC
      -> ProjectSession
      -> staged ProjectEngine
      -> transactional persistence
      -> live commit
```

No Autopilot feature may mutate SQLite, project files, or native graph state by DOM manipulation or direct filesystem access.

## Provenance direction

Studio and bridge already carry commit context fields for semantic AI actions:

- actor (`user`, `ai_director`, `system`);
- plan ID;
- reason/source context.

`ProjectSession` supports durable commit context and encodes it into the committed transaction event using the versioned `mwctx1` detail representation, without requiring a new SQLite schema merely for provenance.

The final IPC context parser / user-facing History presentation belongs to the bounded-history milestone. Until that parser is wired, provider-driven semantic Autopilot must not be advertised as fully actor-attributed end to end.

## Current deterministic demo

The current Studio button **Let AI drive this workflow** builds a deterministic Assist-mode plan against the live native snapshot.

It:

1. validates the exact native project revision;
2. widens the camera and scans the production graph;
3. identifies nodes displaced from deterministic dependency-aware layout;
4. visibly finds and drags a bounded set of representative nodes;
5. periodically reframes the workflow rather than mechanically traversing cards forever;
6. settles any repetitive remainder as one presentation-only dependency-layout pass;
7. persists only workspace positions;
8. focuses a review-relevant scene/shot;
9. requests native dependency impact;
10. explicitly reports completion and returns control without a final competing camera pass;
11. finishes without mutating semantic project state.

This is not pretending Claude/Codex is connected. It is a real execution harness that future providers can feed.

## Non-negotiable invariants

- Never simulate AI authority by directly calling arbitrary DOM click handlers from provider text.
- Never give a model unrestricted OS mouse/keyboard access as the normal product design.
- Never allow Assist mode to change semantic state.
- Never disable emergency takeover.
- Never leave an ordinary Autopilot presentation/read-only step unbounded indefinitely.
- Never add a UI-only race timeout around an authoritative semantic commit.
- Never bypass native locks/revisions because an Autopilot plan requested it.
- Never let animation or camera state become project truth.
- Never hide a semantic commit behind a cosmetic drag operation.
- Never execute a plan created against an obsolete project revision.
- Never call provider output trusted until it passes plan validation.

## Next evolution

1. bounded native `project.history` IPC with parsed commit provenance;
2. premium Activity/Changes panel distinguishing human, AI, and system commits;
3. Claude/Codex plan-producer adapters after supported authentication is verified;
4. Guided checkpoints and semantic plan preview cards;
5. provider worker actions expressed as typed jobs rather than raw shell control;
6. replayable visual explanation driven from recorded plan/action metadata where useful.
