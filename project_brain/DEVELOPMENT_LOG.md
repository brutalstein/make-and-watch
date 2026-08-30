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

### Verification

Exact release SHA `426e80cefe06b7c66c3aeb8485d0abbb07607faa` passed CI run #796:

- Bridge and Director checks: success;
- Studio TypeScript typecheck: success;
- Studio production build: success;
- Native Linux configure/build/test: success;
- Native Windows MSVC build/test: success.

---

## 2026-08-30 14:04 TRT — Multilingual anime localization architecture + real-user proof gate

### Product objective

Move Make & Watch from “temporal video generator” toward a credible episodic anime production system with an explicit language/localization model and a hard real-media acceptance test.

Target default for the Turkish anime audience profile:

```text
Authoring language:          tr-TR
Original performance audio: ja-JP
Primary subtitles:          tr-TR
Optional subtitle tracks:   en-US / others
Optional dub tracks:        tr-TR / en-US / others
```

Japanese performance is an intelligent default for `anime-cinematic`, not a mandatory restriction.

### Architecture decision: DialogueUnit identity

A serious localized production cannot keep script text, Japanese TTS, Turkish subtitle text and lip-sync timing as unrelated strings.

The new design document introduces a stable semantic `DialogueUnit` concept.

One DialogueUnit owns/links:

- semantic intent;
- speaker Character;
- authoring text;
- Japanese performance adaptation;
- Turkish/English subtitle adaptation;
- generated speech Assets;
- forced-alignment Assets;
- optional dub Assets;
- QC/approval/revision state.

The stable DialogueUnit id survives translation and regeneration.

### Audio timing versus subtitle timing

A critical distinction is now explicit:

```text
actual generated audio + forced alignment
 -> mouth/face/performance timing

same DialogueUnit + audio/shot anchors
 -> subtitle cue timing optimized for readability
```

Lip sync and subtitle sync therefore share identity and timing anchors but are not forced to use identical out-times.

This allows mouth motion to end with speech while a Turkish subtitle may remain visible slightly longer when readability and shot boundaries permit.

### Rational-time direction

The long-term timeline should migrate away from floating-point seconds as production truth.

The roadmap recommends an OpenTimelineIO-style rational-time principle:

- picture/edit time represented at frame rate;
- audio alignment represented in integer samples;
- VTT/IMSC/SRT timestamps derived during export.

This prevents cumulative drift and handles 23.976/29.97/59.94 more rigorously.

### Japanese speech and alignment research

Current official/public research establishes:

- Chatterbox Multilingual V3 documents `ja` and `tr` support;
- Montreal Forced Aligner documents a current Japanese acoustic/dictionary/G2P alignment workflow;
- WhisperX currently includes Japanese and Turkish alignment model mappings.

These are research/roadmap inputs unless already wired into Make & Watch. Documentation does not claim the forced-alignment layer is implemented today.

### Subtitle architecture

The new localization document recommends:

- structured internal SubtitleTrack data;
- WebVTT for browser preview;
- IMSC/TTML for professional timed-text master output;
- SRT as compatibility export only;
- BCP-47 language tags at project boundaries;
- deterministic subtitle timing verification;
- language matrix UI rather than one ambiguous `language` field.

W3C WebVTT and IMSC are the standards anchors. Current public Netflix timing/language guides are used only as professional QC references, not as certification claims.

For Turkish adult subtitles, the documented target includes <=17 characters/second and maximum two lines, with audio/shot-aware timing and semantic segmentation.

### Audio-first dialogue production

For dialogue-heavy anime, the recommended order is now:

```text
DialogueUnits
 -> Japanese performance adaptation
 -> Japanese TTS
 -> forced alignment
 -> Shot timing refinement
 -> hero/start frames
 -> temporal video
 -> Turkish subtitle timing/adaptation
 -> final mix/render
```

This makes actual acting/audio duration authoritative before expensive final video generation and reduces late video rework.

### New documents

Created:

- `project_brain/LOCALIZATION_SYNC_ARCHITECTURE.md`
- `project_brain/ONE_MINUTE_ANIME_ACCEPTANCE.md`
- `project_brain/CLAUDE_REAL_USER_ANIME_QA_PROMPT.md`

`LOCALIZATION_SYNC_ARCHITECTURE.md` specifies multilingual semantic identity, language matrix, forced alignment, subtitle/lip timing separation, timed-text formats, dub strategy, on-screen Japanese text, songs and QC.

`ONE_MINUTE_ANIME_ACCEPTANCE.md` defines a real ~60 second proof instead of an API/unit-test proof. A PASS requires a newly generated MP4, real temporal video Assets for every final Shot, Japanese dialogue, Turkish subtitles, visual playback/inspection, audio/subtitle checks, continuity review and exact-head CI.

`CLAUDE_REAL_USER_ANIME_QA_PROMPT.md` instructs a Claude environment with repo/terminal/browser access to act as a demanding real user: launch Studio, use the visible UI, create the mini episode, generate real media, render it, play it, extract/inspect frames, produce timestamped defects, repair root causes and rerun the smallest invalidated scope.

### Important truth boundary

This documentation checkpoint does **not** itself prove that the user's local RTX machine currently produces a smooth one-minute anime. That proof requires running the acceptance prompt on the product machine with real installed inference runtimes and visually/audibly inspecting the final generated media.

The documentation explicitly forbids calling a test PASS when:

- no final MP4 exists;
- a final Shot is still-image fallback;
- the final output was not actually played/inspected;
- Japanese audio/subtitle behavior was fabricated;
- an external provider was offline;
- the exact final commit was not verified.
