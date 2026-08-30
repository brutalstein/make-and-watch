# Series Continuity and Temporal Media Pipeline

> Current status: 2026-08-30 (Europe/Istanbul)

> **Temporal provider direction (2026-08-30):** the mandatory temporal path is the
> deterministic **Native Anime Motion Engine** (`NATIVE_ANIME_MOTION_ENGINE.md`,
> provider `native-anime`), not a large temporal diffusion model. FramePack is an
> optional experimental fallback only. See "Current temporal provider" below.

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

## Multilingual anime product profile

For an authentic-anime Turkish audience profile, the recommended default is now conceptually:

```text
Authoring language:          tr-TR
Original performance audio: ja-JP
Primary subtitle:           tr-TR
Optional subtitles:         en-US / additional BCP-47 languages
Optional dubs:              tr-TR / en-US / additional languages
```

`anime-cinematic` should recommend Japanese original performance when the user has not specified a preference, but language remains explicitly user-overridable.

One generic `language` field is not sufficient for the long-term product. The detailed multilingual/synchronization architecture lives in:

`project_brain/LOCALIZATION_SYNC_ARCHITECTURE.md`

The core synchronization rule is:

```text
DialogueUnit
 -> actual generated Japanese speech
 -> forced alignment
 -> lip/face/performance timing

same DialogueUnit
 -> Turkish localized subtitle text
 -> audio/shot-aware subtitle timing
```

Lip sync and subtitle sync share semantic identity and timing anchors, but they are not forced to use identical out-times. Mouth motion follows actual speech; subtitle timing may remain slightly longer for readability where edit boundaries permit.

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

## Dialogue and localization direction

The current Audio node can represent language and subtitle intent, but premium localization needs a stronger semantic contract.

The roadmap introduces a stable `DialogueUnit` concept that binds:

- speaker identity;
- dramatic/semantic intent;
- authoring text;
- Japanese performance adaptation;
- generated Japanese speech Asset;
- forced-alignment Asset;
- Turkish/English subtitle adaptations;
- optional dub Assets;
- QC/approval/revision.

This prevents script, TTS, subtitles and lip motion from becoming unrelated copies.

For dialogue-heavy anime, the recommended production order is audio-first:

```text
DialogueUnits
 -> final Japanese performance text
 -> Japanese TTS
 -> forced alignment
 -> Shot duration/acting refinement
 -> hero/start frame
 -> temporal video
 -> Turkish subtitle segmentation/timing
 -> Episode mix/render
```

This is a roadmap architecture. The forced-alignment and first-class multi-track localization layer are not yet claimed as implemented.

## Timed text direction

Canonical subtitles should eventually be structured project data, not SRT files used as project truth.

Recommended export surfaces:

- WebVTT for web/browser preview;
- IMSC/TTML for professional timed-text master output;
- SRT for compatibility only.

Language tags should use BCP-47 at product boundaries.

Professional QC targets for Turkish subtitle adaptation are documented in `LOCALIZATION_SYNC_ARCHITECTURE.md`, including reading speed, maximum line count, timing to audio/shot and forced-narrative handling.

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

**Mandatory path: the Native Anime Motion Engine** — provider `native-anime`, a
deterministic 2D-animation renderer (numpy + Pillow + OpenCV, CPU-first, no resident
video model). Design and status: `NATIVE_ANIME_MOTION_ENGINE.md`. It is a drop-in
`TemporalProviderRegistry` provider returning the same `{mediaType:'video', …}`
artifact contract, so composition, render and provenance are unchanged.

Implementation status: the adapter is **registered** and the renderer is
**mechanically validated** by a 4 s MP4, but its visual gate failed and production
status deliberately reports `ready: false` until full ShotAnim compilation from the
native Shot graph exists. A lone hero image is rejected; there is no animated-still
fallback.

**Optional experimental fallback: FramePack** — provider `framepack`, `ready: false`
unless its ~30–40 GB models are explicitly present. Never bootstrapped automatically,
never on the render-readiness path. Kept for local comparison and hard-pose escape.

Every provider is a bounded adapter, not project truth. Make & Watch owns:

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

The FFmpeg renderer consumes video Shot Assets only.

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

Current local path includes Chatterbox multilingual voice generation. Dialogue/narration Assets are timed against Scene/Shot structure and mixed during Episode assembly.

Chatterbox currently documents Japanese and Turkish among its supported languages. This makes Japanese original performance technically plausible through the current provider family, but pronunciation/acting quality still requires real product-machine QC.

Future dialogue quality work includes:

- forced alignment;
- performance-aware speech adaptation;
- audio-first Shot timing;
- stylized anime mouth-state timing;
- audio-conditioned face/lip providers;
- language-specific dub face layers.

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
 -> finalize dialogue/audio intent
 -> prepare hero frames where needed
 -> shot_temporal_plan
 -> shot_generate_video
 -> poll temporal_job
 -> episode_compose
 -> repair missing/failed Shots
 -> episode_render
```

The Director must never report a Scene/Episode as visually complete merely because hero images exist.

## Real-user proof gate

Repository tests and CI verify contracts, but they do not prove subjective series quality on the user's GPU.

The mandatory local proof specification is:

`project_brain/ONE_MINUTE_ANIME_ACCEPTANCE.md`

A PASS requires:

- a newly generated ~1-minute MP4;
- real temporal video for every final Shot;
- Japanese dialogue;
- Turkish subtitle behavior;
- browser playback;
- visual frame inspection;
- mechanical media checks;
- Character/Location continuity review;
- audio/subtitle review;
- timestamped defects;
- repair + revalidation after the final fix;
- exact final commit CI green.

The executable Claude real-user QA instructions are in:

`project_brain/CLAUDE_REAL_USER_ANIME_QA_PROMPT.md`

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

## Design documents

- Anime visual/temporal quality roadmap: `project_brain/ANIME_TEMPORAL_PIPELINE.md`
- Localization, Japanese/Turkish sync and timed-text architecture: `project_brain/LOCALIZATION_SYNC_ARCHITECTURE.md`
- Real one-minute product acceptance: `project_brain/ONE_MINUTE_ANIME_ACCEPTANCE.md`
- Claude real-user execution prompt: `project_brain/CLAUDE_REAL_USER_ANIME_QA_PROMPT.md`
