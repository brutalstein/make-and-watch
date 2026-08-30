# Series Continuity and Temporal Media Pipeline

> Current status: 2026-08-30 04:26 TRT (Europe/Istanbul)

## Product rule

Make & Watch no longer treats a still image, animated crop, Ken Burns move, pan/zoom filter, or repeated frozen frame as valid Shot video.

The only renderable visual contract is:

```text
Series / Episode / Scene / Shot / Character / Location
                         |
                         v
            canonical reference Assets
                         |
                         v
             hero/start/end frames
                 (preparation only)
                         |
                         v
           I2V / FLF2V / VIDEO synthesis
                         |
                         v
              real temporal video Asset
                         |
                         v
            Scene / Episode composition
                         |
                         v
                 temporal MP4 master
```

A hero/reference image is an input to temporal synthesis. It can never satisfy Episode render readiness by itself.

## Retired animated-still path

The previous animated-still fallback is intentionally removed.

Retired behavior:

```text
single image
 -> FFmpeg loop
 -> zoom / pan / push / orbit approximation
 -> repeated/frozen visual frames
 -> pretend Shot video
```

Removed runtime pieces include the dedicated `camera-motion` renderer and its regression tests. Episode composition no longer prefers or accepts an image Asset when a temporal video Asset is missing.

Legacy project history may still contain old image Generation/Asset nodes. They remain provenance/history and may be reused as hero frames, but they are not renderable Shot media.

## Final Shot strategies

Only three final Shot generation strategies are exposed by the merged production schema:

- `I2V` — animate a canonical hero/start image into a temporal clip;
- `FLF2V` — constrain both start and end images for controlled action/cut endpoints;
- `VIDEO` — provider-native temporal synthesis.

Default for new Shots is `I2V`.

`STILL_MOTION`, `T2I`, and `COMPOSITE` are not valid final Shot synthesis strategies. T2I/img2img remain useful preparation operations for references and hero frames, not Episode output.

Scene generation policy is temporal-only:

- `i2v-first`;
- `keyframe-controlled`;
- `provider-native-video`.

## Hero-frame preparation

The existing ComfyUI Scene image path remains useful but its product meaning is now **hero-frame preparation**, not final preview video.

It may generate one high-quality image for each Shot from:

- Series style preset and visual language;
- Episode/Scene story context;
- Shot framing, purpose, camera intent and action;
- canonical Character references;
- canonical Location references.

Those images become candidate `heroFrameAssetId` / start-frame inputs for I2V or FLF2V.

## Canonical continuity

Characters and Locations are canonical graph entities shared across Scenes and Episodes.

Durable identity/environment controls include:

- `canonicalImageAssetIds`;
- `acceptedReferenceAssetIds`;
- `continuityPolicy`;
- semantic node revision;
- lock/approval/stale state;
- Shot/Scene dependencies.

A reference image attached in Director Room is content-addressed, registered as a native Asset, and can be promoted into Character/Location continuity. Source references remain immutable.

## Temporal Shot request

`buildTemporalShotRequest()` is the provider-neutral contract for expensive video work.

It resolves:

- current authoritative Shot revision;
- exactly one owning Scene;
- strategy: I2V / FLF2V / VIDEO;
- authored duration;
- hero/start frame;
- optional end frame;
- Character reference Assets;
- Location reference Assets;
- chronological temporal action prompt;
- quality/continuity priorities;
- bounded temporal segments;
- GPU/RAM resource policy.

Provider output contract requires:

- `mediaType=video`;
- measured duration;
- content hash;
- real generated video provenance;
- no still-image fallback.

## Segmentation and drift control

Long Shot requests are split into bounded temporal sections. Default segment target is 6 seconds.

```text
hero frame
   -> temporal segment 0
   -> accepted tail frame
   -> temporal segment 1
   -> accepted tail frame
   -> ...
   -> complete Shot video
```

Later segments use previous-tail-frame handoff. This limits context growth, supports bounded VRAM, and creates checkpoints where identity/motion drift can later be scored or rejected.

For a 20-minute Episode, Make & Watch should continue to produce many short editorial Shots rather than one 20-minute model invocation.

## Current temporal provider

The current local provider path is FramePack.

FramePack is treated as a bounded provider adapter, not as project truth. Make & Watch owns:

- request validation;
- reference resolution;
- GPU admission;
- process lifetime;
- output verification;
- hashing/provenance;
- native graph registration.

Provider code/model availability is checked explicitly. Large model downloads must never occur silently as a side effect of pressing Generate.

## Resource policy for the 8 GB class

Temporal generation uses exclusive GPU admission.

The current safety model includes:

- one temporal heavy job at a time;
- release other local GPU model/cache state before temporal launch when possible;
- explicit VRAM reserve rather than allocating to theoretical 100%;
- bounded segment duration;
- bounded process timeout;
- owned subprocess termination;
- measured output validation before provenance commit.

Throughput is intentionally secondary to avoiding random OOM, corrupted state, or competing resident models.

## Composition readiness

`compileEpisodeComposition()` is fail-closed.

Every Shot must have:

1. a positive authored duration;
2. an I2V/FLF2V/VIDEO strategy;
3. a ready non-stale video Generation;
4. a ready non-stale video Asset;
5. valid video duration metadata;
6. enough generated duration to cover the authored Shot duration within one-frame tolerance.

A still image does not count toward `generatedVisualCount`.

A temporal video shorter than the authored duration is a readiness error. The user/Director must regenerate the Shot instead of freezing the final frame.

## Episode renderer

The FFmpeg renderer now consumes video Shot Assets only.

Responsibilities:

- normalize temporal clips to delivery dimensions/FPS;
- trim to editorial duration;
- apply cuts/fades/dissolves;
- use a very small time-stretch when a dissolve requires extra overlap instead of cloning/freeze-padding the last frame;
- mix timed Audio Assets;
- cache Scene masters by temporal source hashes, durations, transitions, profile and audio;
- concatenate Scene masters;
- hash/register the Episode Generation and Asset.

The removed image-to-video branch cannot be selected by runtime state.

## Audio

Audio remains an independent semantic/generation layer.

Current local path includes Chatterbox voice generation. Dialogue/narration Assets are timed against Scene/Shot structure and mixed during Episode assembly.

Future anime dialogue quality work is described in `ANIME_TEMPORAL_PIPELINE.md` and includes performance-aware speech, shot-specific acting motion, audio-driven face/lip control and QC.

## Director tools

Codex must use authoritative typed tools.

Project/workflow truth remains under `makewatch`.

Heavy temporal media execution remains under `makewatch_media`:

- `temporal_providers`;
- `shot_temporal_plan`;
- `shot_generate_video`;
- `temporal_job`;
- `temporal_jobs`;
- canonical reference tools.

The intended Director sequence is:

```text
production_schema
 -> project authoring
 -> prepare/choose references
 -> prepare hero frames where needed
 -> shot_temporal_plan
 -> shot_generate_video
 -> poll temporal_job
 -> episode_compose
 -> repair missing/failed Shots
 -> episode_render
```

The Director must never report a Scene/Episode as visually complete merely because hero images exist.

## Verification contract

CI must protect these invariants:

- merged Shot schema exposes only I2V / FLF2V / VIDEO;
- default new Shot strategy is I2V;
- temporal request rejects legacy STILL_MOTION/T2I/COMPOSITE strategies;
- still-only Shot data cannot satisfy Episode composition;
- missing/short/unprobed temporal video blocks render readiness;
- renderer accepts video Shot media only;
- transition/cache behavior remains deterministic;
- native Linux and Windows tests remain green;
- Studio typecheck/build remains green.

Product-machine smoke testing is still required for actual installed FramePack/ComfyUI/Chatterbox GPU inference because CI intentionally does not run multi-gigabyte model inference.

## Anime quality design

For the full technical theory and roadmap for a real authored-anime look rather than generic AI video, see:

`project_brain/ANIME_TEMPORAL_PIPELINE.md`
