# Make & Watch — Development Log

This log is the durable chronological checkpoint for major product/runtime changes. Add new entries with local project time (Europe/Istanbul) after meaningful milestones, fixes or architecture decisions. It complements the topic-specific documents under `project_brain/`; it does not replace Git history.

---

## 2026-08-30 04:09 TRT — Director Room + canonical reference audit

### User/product objective

Make the AI Director a natural interactive screenwriter/director rather than a plan-only form: optional durable visual references, multimodal conversation, autonomous creative decisions when the user delegates them, low-cost automatic model routing, persistent archives, broad typed project authority and premium workflow UX.

### Director Room state entering this audit

Already implemented before the audit:

- persistent/resumable Director conversations;
- archive search/rename/archive/unarchive/delete and default-closed archive presentation preference;
- Codex App Server preferred runtime plus bounded official CLI compatibility fallback;
- automatic low-cost Director model routing from the live Codex model catalog, preferring GPT-5.6 Luna + low reasoning when advertised;
- fail-closed image turns: attached images require a real image-capable App Server path and are never silently discarded into text-only fallback;
- composer image file picker, drag/drop and clipboard paste;
- content-addressed Director reference library backed by native image Asset nodes;
- conversation schema v2 attachment metadata with v1 backward compatibility;
- actual Codex `localImage` input for durable references;
- natural Director persona/context instructions;
- typed `makewatch` project/workflow/media tools instead of unrestricted project shell mutation.

### Previous media milestone recorded here for continuity

Before the current reference audit the local media stack had already progressed beyond simple storyboard frames:

- ComfyUI Scene storyboard generation;
- GPU-exclusive local scheduling boundary;
- Chatterbox voice/audio generation;
- FramePack temporal I2V provider/planning/service path;
- temporal `makewatch_media` tools;
- Episode composition compiler;
- deterministic FFmpeg preview/render assembly with camera motion, transitions, timed audio and Scene cache behavior;
- native Generation/Asset provenance for completed outputs.

### Release-blocking bugs found during this audit

1. **Canonical reference generation service was dead in the product path.**
   - `AnchorReferenceGenerationService` and its unit test existed.
   - Media gateway did not instantiate it or expose HTTP routes.
   - Shared gateway client did not expose it.
   - Codex dynamic tools could not invoke it.

2. **Stale canonical-reference race.**
   - Target/source revisions were checked before inference but not again after the expensive ComfyUI call.

3. **Failed job could expose an artifact.**
   - Artifact metadata was assigned before final native canonical registration.

4. **Content-addressed artifact reuse lacked full path verification.**

5. **Workflow `Add Scene` dead action.**

6. **Documentation drift.**

### Fixes committed to `main`

Canonical reference generation is now fully reachable:

```text
Codex makewatch_media.reference_generate
        |
        v
GenerationGatewayClient
        |
        v
POST /api/reference/generate
        |
        v
AnchorReferenceGenerationService
        |
        +--> text-only T2I OR durable source-Asset img2img
        +--> GPU scheduler
        +--> content-addressed artifact
        +--> native Generation/Asset provenance
        +--> Character/Location -> generated Asset dependency
```

Reference safety was hardened with revision rechecks, stale rejection, non-public failed artifacts, content re-hashing and immutable sources.

Workflow `Add Scene` became self-sufficient and mutation controls were aligned with busy/lock state.

### Verification

Release checkpoint `596f6c7e4ec59a3705219368797b6563e66e73e7` passed CI run #771 on Studio/Director, TypeScript/build, Linux native and Windows native.

---

## 2026-08-30 04:26 TRT — Animated-still retirement + temporal-only anime direction

### Product decision

The animated-still/slideshow path is permanently retired as final Shot media.

Make & Watch must not complete a visual Shot by:

- looping one still image;
- applying FFmpeg zoom/pan/push/orbit to a still;
- creating a Ken Burns-style clip;
- concatenating independently generated still frames as if they were coherent animation;
- freezing/cloning the final frame of a short video to hide missing duration.

The target is real temporal anime video.

### New final Shot contract

Only these final strategies remain active:

```text
I2V
FLF2V
VIDEO
```

New Shots default to `I2V`.

Scene policy is temporal-only:

- `i2v-first`;
- `keyframe-controlled`;
- `provider-native-video`.

T2I/img2img remain valid **preparation** tools for canonical references, hero/start frames and FLF2V end frames. They do not count as final Shot media.

### Removed runtime path

Deleted:

- `tools/composition/camera-motion.mjs`;
- `tools/composition/motion-check.mjs`;
- renderer branch that accepted `mediaType=image`;
- image loop/zoompan final Shot rendering;
- video `tpad=stop_mode=clone` freeze-tail padding;
- composition fallback from I2V/VIDEO to image Assets.

The root quality gate no longer protects the deleted animated-still implementation and instead runs temporal transition/cache checks.

### Composition is now fail-closed

Every renderable Shot must have:

1. `I2V`, `FLF2V`, or `VIDEO` strategy;
2. ready video Generation;
3. ready non-stale video Asset;
4. measured positive duration metadata;
5. generated duration sufficient for the authored Shot duration within one-frame tolerance.

A hero image alone makes the Shot **not ready**.

If temporal output is too short, Make & Watch requires regeneration rather than freezing the tail.

### Renderer behavior

Episode rendering consumes real video Shot Assets only.

It still owns deterministic editorial tasks:

- resolution/FPS normalization;
- cuts/fades/dissolves;
- Scene cache;
- timed audio mixing;
- Episode concatenation;
- final MP4 hashing/provenance.

When a dissolve needs a small overlap extension, the renderer uses a bounded slight PTS time-stretch instead of a frozen-frame clone.

### Active schema cleanup

The temporal capability overlay is now authoritative not only for fields but also for current Shot/Scene purpose and primary output text. Studio and Codex therefore see a temporal-video-only production model rather than the historical “clip or animated still” wording.

The stable base capability table may preserve legacy project-reading history internally, but its old strategy/output semantics are overridden by the active temporal schema and cannot satisfy runtime readiness.

### Anime production design

Created `project_brain/ANIME_TEMPORAL_PIPELINE.md` as the quality roadmap.

It records technical/theoretical direction for:

- model-sheet style Character reference packages;
- recurring Location reference packages;
- Series style bible and color script;
- short editorial Shot grammar;
- hero frame as key drawing;
- I2V as default and FLF2V for controlled pose-to-pose endpoints;
- chronological temporal prompts;
- primary/secondary/follow-through motion hierarchy;
- segment tail handoff and future continuity QC;
- line/palette/identity/geometry drift checks;
- bounded candidate generation and acceptance;
- anime-specific deterministic compositing;
- restrained dialogue motion versus action/sakuga direction;
- future audio-driven dialogue/lip behavior;
- future pose/motion-reference providers;
- 8 GB-class sequential GPU choreography;
- cross-Episode accepted-reference promotion;
- explicit rejection of fake still-video fallbacks.

Official future-provider research references are recorded separately from current implementation so documentation does not imply unsupported runtimes already work.

### Director behavior

`AI_DIRECTOR_CONTEXT.md` now makes temporal completion explicit:

```text
prepare references
 -> prepare hero/end frames
 -> temporal plan
 -> temporal video job
 -> poll + verify video Asset
 -> Episode composition
 -> repair failures
 -> Episode render
```

The Director must never claim visual completion merely because Scene hero images were produced.

### Tests changed

CI now asserts:

- Shot strategies are exactly I2V/FLF2V/VIDEO;
- default new Shot strategy is I2V;
- legacy STILL_MOTION/T2I/COMPOSITE cannot enter temporal execution;
- still-only Shot data cannot satisfy Episode readiness;
- missing video blocks readiness;
- short video blocks readiness rather than being freeze-padded;
- transition/cache logic is tested using real video media semantics.

### Verification status

This entry records the migration before final release verification. The exact final `main` SHA after all code/documentation changes must pass:

- Bridge and Director checks;
- Studio TypeScript typecheck;
- Studio production build;
- Native Linux configure/build/test;
- Native Windows configure/build/test.

Do not call this temporal-only checkpoint released until that exact-head CI is green.
