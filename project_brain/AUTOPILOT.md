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
projection      actions     project.apply
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

The cursor currently supports visible movement, press state, click ripple, glow/trail, AI identity badge, and contextual activity labels.

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
- center/focus node.

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
2. frames the workflow;
3. identifies nodes displaced from deterministic dependency-aware layout;
4. moves the virtual cursor to those nodes;
5. visibly drags them into organized positions;
6. persists only workspace positions;
7. focuses a review-relevant scene/shot;
8. requests native dependency impact;
9. finishes without mutating semantic project state.

This is not pretending Claude/Codex is connected. It is a real execution harness that future providers can feed.

## Non-negotiable invariants

- Never simulate AI authority by directly calling arbitrary DOM click handlers from provider text.
- Never give a model unrestricted OS mouse/keyboard access as the normal product design.
- Never allow Assist mode to change semantic state.
- Never disable emergency takeover.
- Never bypass native locks/revisions because an Autopilot plan requested it.
- Never let animation state become project truth.
- Never hide a semantic commit behind a cosmetic drag operation.
- Never execute a plan created against an obsolete project revision.
- Never call a provider output trusted until it passes plan validation.

## Next evolution

1. bounded native `project.history` IPC with parsed commit provenance;
2. premium Activity/Changes panel distinguishing human, AI, and system commits;
3. Claude/Codex plan-producer adapters after supported authentication is verified;
4. Guided checkpoints and semantic plan preview cards;
5. provider worker actions expressed as typed job steps rather than raw shell control;
6. replayable visual explanation driven from recorded plan/action metadata where useful.
