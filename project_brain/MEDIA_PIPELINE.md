# Series Continuity and Video Pipeline

## Purpose

Long-form Make & Watch projects are not one-shot video prompts. A series is compiled from canonical semantic entities into bounded per-shot work and an episode assembly DAG.

This foundation deliberately separates **semantic continuity** from **media execution**:

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

## Cross-episode character identity

Characters are not copied per episode. A single canonical `character` node is referenced by scenes and/or shots in every episode where that character appears.

`SeriesContinuityCompiler` projects those references into a `SeriesContinuityManifest` containing:

- canonical character ID;
- canonical native node revision;
- approval/lock/stale state;
- every episode using the character;
- whether the anchor crosses episode boundaries;
- every shot-to-character continuity binding.

A character revision is therefore the semantic identity version for the current foundation. If the canonical character changes, normal native dependency invalidation can mark dependent work stale across all affected episodes instead of silently creating divergent copies.

Final-synthesis readiness currently requires referenced character anchors to be locked, fresh and approved/locked by native approval semantics.

## Video render-plan compiler

`VideoPipelineCompiler` compiles one episode into a deterministic `VideoRenderPlan`.

For every shot it creates:

1. a `kSynthesizeShot` task;
2. a `kCompositeShot` task depending on that synthesis task;
3. one final `kAssembleEpisode` task depending on all shot composites.

The plan records:

- native project revision;
- episode ID;
- explicit output profile;
- total shot duration;
- continuity character IDs;
- deterministic task dependencies;
- explicit `generationStrategy` copied from shot metadata;
- readiness issues.

## Public-repository IP boundary

The compiler does **not** choose a generation representation automatically. `generationStrategy` must be explicit project metadata.

Patent-sensitive adaptive representation selection, quality/resource control loops and unpublished scheduling heuristics remain intentionally excluded from this public repository until IP strategy is settled.

## What is implemented versus not implemented

Implemented now:

- native cross-episode continuity projection;
- canonical character revision anchors;
- deterministic episode render DAG compilation;
- explicit shot strategy requirement;
- readiness validation;
- warning-clean native unit tests for continuity and video planning.

Not implemented yet:

- OS/Python WorkerSupervisor;
- actual image/video model process launch;
- content-addressed generated-asset/provenance store;
- FFmpeg execution/compositing worker;
- checkpoint/resume for active media jobs;
- adaptive strategy selection.

The next media-runtime milestone must connect this deterministic plan to the existing `BackgroundJobRuntime` through a concrete WorkerSupervisor and typed capability handshake. Resource leases must remain owned until the real worker confirms stop/completion.
