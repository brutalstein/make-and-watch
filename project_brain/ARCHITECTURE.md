# Architecture

## Dependency rule

Dependencies point inward toward stable contracts and domain state. UI frameworks, model runtimes, authentication mechanisms, and media libraries are adapters around the core — never the definition of the core.

```text
Studio UI (TypeScript/React)
        |
        v
Versioned contracts / commands
        |
        v
C++ application + domain core
        |
        +--> scheduler/resource interfaces
        +--> project graph + approvals
        +--> cache/job interfaces
        +--> media interfaces
        |
        v
Replaceable adapters/providers
  AI director | image | video | voice | audio | QC | renderer
```

## Main boundaries

### `apps/studio`
Desktop-facing product surface. It may present Director, Workflow, Episode, Scene, Shot, Preview, Timeline, Resource, and Settings views. UI state is not authoritative project state.

### `engine`
C++ core. Owns domain rules, typed operations, approvals, project mutation validation, job state, resource policy contracts, and eventually media orchestration. It must remain usable without Electron or React.

### `schemas`
Versioned cross-language contracts. Anything crossing process/language boundaries must have an explicit version and validation rules.

### `packages`
Shared TypeScript packages generated from or aligned with schemas. They help the UI speak the engine's language without inventing a second domain model.

### `providers`
Replaceable implementation adapters. A provider declares capabilities; the engine chooses or rejects it through contracts. Providers may be local processes, native libraries, or later optional remote services.

### `project_brain`
Canonical human/agent handoff context. Architecture changes are incomplete until this folder reflects them.

## Project truth

Long-term project state will live in a transactional local store plus a content-addressed asset store. Generated assets are referenced by identity and provenance, not treated as anonymous files on a timeline.

## Director safety boundary

The connected AI director emits **typed operations**. Operations are schema-validated, policy-checked, previewable, and applied by the engine. The AI director never becomes the persistence layer and never receives unrestricted authority over the runtime.

## Approval model

Creative units progress through explicit states such as draft, review, approved, locked, invalidated, and failed. Expensive downstream work should require the necessary upstream approvals unless the user explicitly enables an auto-approval policy.

## Process strategy

Heavy model providers should eventually run out-of-process. This isolates incompatible Python environments, model crashes, and memory leaks from the C++ engine and the Studio UI.

## Performance direction

The engine will evolve toward explicit resource budgets, bounded queues, resumable jobs, content-addressed caching, selective invalidation, and GPU-native media paths where justified. Patent-sensitive implementation specifics are intentionally not documented in this public repository yet.
