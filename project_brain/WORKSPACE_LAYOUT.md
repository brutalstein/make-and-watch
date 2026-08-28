# Workflow Workspace Layout

## Purpose

The workflow canvas is an interactive production workspace, but node coordinates are **presentation state**, not semantic project state.

Dragging a Scene, Character, Shot, or Generation card must never by itself:

- advance the native project revision;
- mark semantic entities stale;
- change dependency topology;
- create project history events;
- alter locks or approvals;
- trigger regeneration.

This separation keeps visual organization ergonomic without contaminating the authoritative production graph.

## Current implementation

`apps/studio/src/workflowLayout.ts` owns the browser-side layout policy.

The layout format is versioned as `makewatch.workflow-layout.v1` and stored in local browser storage using a project-scoped key derived from the Series and Episode entity IDs.

Stored state contains only validated finite `{x, y}` positions keyed by native entity ID.

```text
C++ ProjectGraph                 Studio Workspace Layout
(authoritative)                  (presentation-only)

entity id  --------------------> entity id
kind                             x / y
metadata                         viewport placement
approval
locked
stale
dependencies
```

## Default layout

When no saved position exists, Studio computes a deterministic dependency-aware layout:

1. derive graph depth from native dependency edges;
2. place dependency roots in the leftmost column;
3. move dependents to progressively deeper columns;
4. sort nodes deterministically inside a column;
5. saved positions override defaults for existing nodes;
6. newly created nodes receive deterministic default positions.

The algorithm is intentionally a UI layout policy, not an execution/synthesis scheduler.

## Interaction behavior

Current canvas behavior:

- nodes are draggable;
- movement snaps to an 8 px grid;
- drag completion saves presentation layout locally;
- **Arrange** restores dependency-aware deterministic placement and saves it;
- **Fit** or keyboard `F` fits the graph to the viewport;
- double-clicking a node centers it;
- clicking a Scene Strip item selects and centers the corresponding native node;
- semantic dependency edges are visible but cannot be rewired from the canvas yet;
- `nodesConnectable=false` prevents accidental topology mutation.

## Persistence policy

Workspace layout persistence is deliberately best-effort. A browser storage failure must not block project editing or corrupt the native project.

Long term, desktop builds may replace browser local storage with a workspace-preferences store. The invariant remains the same: **workspace coordinates are not semantic project truth** unless a future explicitly typed feature introduces a semantic concept that truly depends on spatial layout.

## Rules for future changes

- Never encode workflow coordinates into generic node metadata merely to make drag persistence convenient.
- Never route drag events through `project.apply`.
- Never infer dependency changes from card proximity.
- Keep semantic mutations explicit and typed.
- If collaborative/multi-device workspace layouts are added, synchronize them through a presentation-state service, not `ProjectEngine`.
