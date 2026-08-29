# Series Continuity and Video Pipeline

## Purpose

Long-form Make & Watch projects are not one-shot video prompts. A series is compiled from canonical semantic entities into bounded per-shot work and an episode assembly DAG.

```text
canonical Series / Episode / Scene / Shot / Character graph
                         |
                         v
              SeriesContinuityCompiler
                         |
          canonical character revision anchors
                         |
                         v
                VideoPipelineCompiler
                         |
       explicit shot synthesis + composite tasks
                         |
                         v
               episode assembly task
                         |
                         v
        future WorkerSupervisor/providers/render
```

Semantic continuity and media execution remain separate.

## Cross-episode character identity

Characters are not copied per episode. A single canonical `character` node is referenced everywhere that character appears.

`SeriesContinuityCompiler` projects:

- canonical character ID/revision;
- approval/lock/stale state;
- every episode using the character;
- whether the anchor crosses episode boundaries;
- shot-to-character continuity bindings.

A canonical Character revision is therefore the current semantic identity version. A change can invalidate dependent work across episodes through the native graph instead of creating silent divergent copies.

### Ownership hardening

Continuity compilation now rejects ambiguous topology as readiness issues rather than emitting duplicate bindings:

- one Scene appearing under multiple Episodes in the same Series;
- one Shot appearing under multiple Scenes in the same Series.

Duplicate ownership is skipped deterministically after being reported.

Series readiness itself also participates: stale or non-final-approved Series state prevents final-synthesis readiness. Referenced Character anchors must remain identity-locked, fresh and approved/locked.

## Video render-plan compiler

`VideoPipelineCompiler` compiles one Episode into a deterministic `VideoRenderPlan`.

For every valid uniquely-owned Shot it creates:

1. `kSynthesizeShot`;
2. `kCompositeShot` depending on synthesis;
3. one `kAssembleEpisode` depending on all composites.

The plan records project revision, output profile, duration, explicit generation strategy, continuity Character IDs, task dependencies and readiness issues.

## Video compiler hard bounds

The compiler now fails closed or reports not-ready state for malformed media inputs:

- width/height must be non-zero and <= 16384;
- FPS must be finite, positive and <= 240;
- Shot `durationSeconds` must parse completely to a finite positive number; `nan`, infinity, range overflow and malformed suffixes are invalid;
- accumulated Episode duration must remain finite;
- metadata index parsing requires full-string consumption;
- an Episode must depend on exactly one Series;
- Episode, Scene and Shot stale/approval state participates in final readiness;
- a Scene with no Shots is an issue;
- an Episode with zero Shots is an issue;
- explicit `generationStrategy` is required and length-bounded;
- a Shot reachable through multiple Scenes does not create duplicate render task IDs;
- referenced continuity anchors must be ready for final synthesis.

A plan may still be returned with issues for inspection/repair, but `ready_for_final_synthesis` is true only when the issue list is empty.

## Public-repository IP boundary

The compiler does **not** choose a generation representation automatically. `generationStrategy` remains explicit project metadata.

Patent-sensitive adaptive representation selection, quality/resource control loops and unpublished scheduling heuristics remain intentionally excluded from this public repository until IP strategy is settled.

## Current tests

Native tests cover:

- canonical cross-episode Character reuse and revision propagation;
- identity lock readiness;
- stale Series readiness;
- duplicate Shot ownership in continuity;
- deterministic Shot synthesis/composite/Episode assembly dependencies;
- NaN FPS rejection;
- NaN Shot duration handling;
- stale Scene and draft Episode readiness;
- duplicate Shot task suppression;
- missing explicit strategy readiness.

The native build remains warning-clean under the repository compiler policy.

## What is not implemented yet

- concrete OS/Python WorkerSupervisor;
- actual image/video model process launch;
- content-addressed generated-asset/provenance store;
- FFmpeg execution/compositing worker;
- checkpoint/resume for active media jobs;
- adaptive strategy selection.

The next media-runtime milestone must connect this deterministic plan to `BackgroundJobRuntime` through a concrete WorkerSupervisor and typed capability handshake. Resource leases must remain owned until the real worker confirms stop/completion.
