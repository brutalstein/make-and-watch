# Series Continuity and Media Pipeline

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

Continuity compilation rejects ambiguous topology as readiness issues rather than emitting duplicate bindings:

- one Scene appearing under multiple Episodes in the same Series;
- one Shot appearing under multiple Scenes in the same Series.

Duplicate ownership is skipped deterministically after being reported. Series readiness itself participates: stale or non-final-approved Series state prevents final-synthesis readiness. Referenced Character anchors must remain identity-locked, fresh and approved/locked.

## Video render-plan compiler

`VideoPipelineCompiler` compiles one Episode into a deterministic `VideoRenderPlan`.

For every valid uniquely-owned Shot it creates:

1. `kSynthesizeShot`;
2. `kCompositeShot` depending on synthesis;
3. one `kAssembleEpisode` depending on all composites.

The plan records project revision, output profile, duration, explicit generation strategy, continuity Character IDs, task dependencies and readiness issues.

## Concrete Episode preview renderer

The local generation gateway now executes a bounded FFmpeg preview path after manifest compilation:

1. resolve ready Shot visual Assets and Audio Assets from native project truth;
2. render every Shot to the Episode profile and authored duration;
3. convert still-image `camera` + `motionLevel` intent into eased, oversampled FFmpeg motion;
4. assemble Shot segments with hard cuts or bounded fades/dissolves while preserving authored total duration;
5. mix timed audio cues (or a silence bed), cache each Scene master, and concatenate the Episode;
6. hash the final MP4 and register Episode `generation` + `asset` nodes through revision-checked native commands.

Render queues and retained job history are bounded. Cache keys include every render-affecting motion, transition, source, audio, profile and encoding field so edited camera intent cannot reuse a stale master.

Codex can operate this path only through typed host tools: `episode_compose`, `episode_render`, `generation_job(kind=render)` and `generation_jobs(kind=render)`. Composition inspection is read-only; render and provenance writes remain inside the local gateway/native transaction boundary.

## First concrete generation path: scene storyboard preview

The first real media execution path is deliberately smaller than final video synthesis. It generates one storyboard/reference frame per Shot in a Scene through a local ComfyUI server and persists the result back into the authoritative project graph as downstream `generation` nodes.

```text
Studio Scene context action
        |
        v
local generation gateway :4178
        |
        +--> authoritative snapshot from project bridge :4177
        |
        +--> prompt compiler
        |      series visual language
        |      episode / scene summary
        |      shot framing / camera
        |      linked characters / locations
        |
        +--> local ComfyUI :8188
        |      POST /prompt
        |      GET /history/{prompt_id}
        |      GET /view
        |
        +--> .makewatch/artifacts/scenes/...
        |
        +--> native project.apply
               generation.preview.<shot-id>
               depends on Shot
               status / artifact / provider provenance
```

This is real local image generation, not a placeholder preview. It is intentionally called **storyboard preview** rather than final synthesis: a future I2V/video worker can consume the same canonical Shot and generated reference artifacts without changing project identity.

### Generation gateway invariants

- ComfyUI endpoint is restricted to localhost HTTP by default.
- Default ComfyUI address is `127.0.0.1:8188` and can be overridden with `MAKEWATCH_COMFYUI_URL` only to another localhost address.
- Prompt JSON and returned images have explicit byte bounds.
- Completion is confirmed through bounded `/history/{prompt_id}` polling rather than depending solely on WebSocket delivery.
- A Scene generation job is bounded to 64 Shots and the local queue is bounded.
- Only one preview job executes at a time in v1 to avoid uncontrolled VRAM concurrency.
- Generated artifacts are written under `.makewatch/artifacts/scenes`.
- Project semantic state is never edited directly by the generation gateway; generation status/provenance is committed through revision-checked native `project.apply`.
- Graph cycle, lock and revision rules remain native authority.
- Generated preview nodes are downstream of their canonical Shot, so later Shot edits invalidate the correct dependency path.
- A generation failure is recorded as failed generation metadata and does not silently mark the Shot itself as approved.

Environment controls:

- `MAKEWATCH_COMFYUI_URL`
- `MAKEWATCH_COMFYUI_CHECKPOINT`
- `MAKEWATCH_COMFYUI_TIMEOUT_MS`
- `MAKEWATCH_GENERATION_PORT`
- `MAKEWATCH_PREVIEW_WIDTH`
- `MAKEWATCH_PREVIEW_HEIGHT`
- `MAKEWATCH_ARTIFACT_DIR`

`dev.ps1` / `tools/dev-runner.mjs` starts the Make & Watch generation gateway automatically. ComfyUI itself remains an external local inference service in this milestone; if it is offline Studio remains usable and the Scene generation action reports that exact state.

## Workflow context actions

Studio right-click actions map to project semantics, not cosmetic graph edits.

- **Selected → this node** means the clicked node depends on the other selected nodes.
- **This node → selected** means each other selected node depends on the clicked node.
- Add Scene and Add Shot create native nodes plus their parent dependency.
- Lock/unlock and delete route through native commands.
- React Flow's local Delete/Backspace mutation is intercepted so presentation state cannot delete authoritative project nodes on its own.
- Cycle detection, locked-node rejection and revision conflicts are surfaced from the native engine.

## Video compiler hard bounds

The compiler fails closed or reports not-ready state for malformed media inputs:

- width/height must be non-zero and <= 16384;
- FPS must be finite, positive and <= 240;
- Shot `durationSeconds` must parse completely to a finite positive number;
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

The native compiler does **not** choose a final generation representation automatically. `generationStrategy` remains explicit project metadata.

Patent-sensitive adaptive representation selection, quality/resource control loops and unpublished scheduling heuristics remain intentionally excluded from this public repository until IP strategy is settled. Storyboard preview uses an explicit generic local T2I path and does not implement adaptive synthesis selection.

## Current verification

Native tests cover continuity, deterministic video planning, malformed duration/FPS/topology cases, resource lifecycle and worker process ownership. JavaScript quality gates additionally cover:

- deterministic ComfyUI workflow construction without contacting a remote service;
- scene prompt composition from canonical graph context;
- generation-node provenance and Shot dependency creation;
- artifact manifest creation;
- no-Shot Scene rejection;
- camera intent classification, eased oversampled motion filters and static fallbacks;
- mixed hard-cut/xfade transition graphs with exact authored-duration compensation;
- motion/transition-aware Scene cache invalidation;
- Director composition/render tool schemas, runtime wiring and render-job routing;
- syntax/type/build gates for the Studio generation UI.

## Next media-runtime milestone

The current output is a real deterministic preview/animatic renderer, not final generative video synthesis. Remaining work includes:

- typed I2V/video model worker integration for `kSynthesizeShot`;
- explicit use of `WorkerSupervisor` resource leases for final media workers;
- persistent checkpoint/resume for active media jobs;
- richer content-addressed artifact provenance and garbage collection;
- subtitle burn-in/sidecars and richer music/ambience mixing;
- only after IP strategy allows it, any adaptive strategy-selection layer.
