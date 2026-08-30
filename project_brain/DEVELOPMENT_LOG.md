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

---

## 2026-08-30 — Native Anime Motion Engine architecture; FramePack demoted to optional

### Objective

Redesign the long-term anime temporal architecture around a storage-efficient,
compute-efficient, deterministic animation system that does **not** require a large
generative video model (FramePack / Wan / Hunyuan / LTX class, 20–40+ GB) as a
mandatory dependency.

### Trigger

Real temporal proof was blocked: the only registered temporal provider
(`FramePackTemporalProvider`) needs a ~30–40 GB Hugging Face model set that the
product deliberately refuses to auto-download (`bootstrapPolicy: 'explicit-only'`).
Swapping in another heavy video model keeps every structural weakness (segment
identity drift, full-frame boiling, opaque failure, no cross-Episode reuse,
~1 GPU-hour per rendered minute on 8 GB).

### Decision

Adopt the **Native Anime Motion Engine** — a deterministic 2D-animation renderer
(sparse AI key drawings + layered-mesh deformation + Verlet secondary motion + 2.5D
parallax environment + forced-alignment lip sync + sparse corrective redraw). Target
architecture A+B+C; foundation A+C now; B (motion retargeting) later. The image model
becomes the key-animation department, not a per-frame generator. Full rationale and
7×16 architecture scoring: `project_brain/NATIVE_ANIME_MOTION_ENGINE.md`.

The engine is a drop-in `TemporalProviderRegistry` provider (`native-anime`) returning
the existing `{mediaType:'video', …}` artifact contract, so composition, render and
provenance are unchanged.

### Implemented now (this change)

- `project_brain/NATIVE_ANIME_MOTION_ENGINE.md` — architecture decision document.
- Five `project_brain/` documents updated so FramePack is no longer the mandatory
  future (this log, `MEDIA_PIPELINE.md`, `ANIME_TEMPORAL_PIPELINE.md`,
  `AI_DIRECTOR_CONTEXT.md`, `ONE_MINUTE_ANIME_ACCEPTANCE.md`).
- P0 fix: `validateProvider()` in `tools/generation/temporal-provider-registry.mjs`
  spread `{...provider}`, dropping prototype `status()`/`generate()` off class-based
  providers — the live gateway logged `FramePack I2V provider.status is not a
  function`. Fixed to delegate; regression test added.
- `tools/anime/` — `native-anime-contract.mjs` (ShotAnim validation contract),
  `native-anime-provider.mjs` (`NativeAnimeTemporalProvider`), `native-anime-worker.py`
  (deterministic renderer), plus `*-check` tests wired into `verify.ps1`.
- `tools/generation/server.mjs` registers `native-anime` as the target default temporal
  provider, but it reports `ready: false` until the graph -> ShotAnim compiler is
  wired. It refuses a hero-only animated-still fallback. `framepack` remains registered
  but reports `ready: false` unless its models are explicitly present.
- Native provider metadata (determinism, frame hash, render time, cache posture) is
  persisted on the Generation node; output FPS is persisted on the video Asset.

### Validated experimentally (not production-wired)

- Vertical slice: one anime Character key drawing + hand-split layers + a 2-plane
  environment + one proxy Japanese-timing tone + eye/blink/mouth/head/hair motion + 2.5D
  parallax push-in + burned Turkish subtitle → one real animated 1080p24 MP4 rendered
  with **no generative video model**. Latest measurement: 4.000 s / 96 frames,
  36.46 s render, 14,902,976 B total persistent proof state, zero frame cache.
  Mechanical gate passed; visual gate failed because automatic eye inpainting leaves
  a face seam and the affine layers still read as a puppet. Measurements and notes:
  `NATIVE_ANIME_MOTION_ENGINE.md` §8, `.makewatch/reports/`.

### Planned

- ShotAnim compiled from the Shot graph (`buildShotAnimRequest()` beside
  `buildTemporalShotRequest()`); `native-anime` wired through
  `TemporalShotGenerationService` end to end.
- Corrective-redraw (C) escalation + `rig.poseLibrary` promotion.
- Deterministic Turkish subtitle render + WebVTT sidecar in `EpisodeRenderService`
  (still an open gap).
- Motion retargeting (B): MotionClip schema, skeleton IK/foot-lock, cross-character
  retarget.

### Research candidate / optional

- FramePack `framepack` provider — off unless models present, never on the
  render-readiness path.
- See-through auto-rig, Depth Anything V2 environment split, Practical-RIFE cadence
  pass, MFA / WhisperX forced aligners.

### Truth boundary

The vertical slice proves the renderer path produces real deterministic animation
without a video model and without persisted frames. It misses the <4 s/output-second
CPU target (measured 9.11) and fails visual inspection. It does **not** prove genuine
Japanese TTS/alignment, series-grade anime quality, or a full one-minute
Episode; those remain planned milestones with the benchmark methodology in
`NATIVE_ANIME_MOTION_ENGINE.md` §14.

---

## 2026-08-31 — Native Anime M1 control plane completed

### Implemented

- Strict versioned contracts now validate CharacterRig, EnvironmentPackage,
  Japanese Alignment, QC and one-minute Acceptance assets without claiming that the
  M2-M4 producers exist.
- `planShotAnim()` resolves live Shot ownership and exact approved Character,
  Location, Audio, Alignment and corrective-key dependencies. It rejects stale or
  mismatched revisions, unmanaged paths, hash failures and acting curves outside a
  rig's valid deformation domain.
- `buildShotAnimRequest()` compiles the accepted plan into `makewatch.shotAnim/1`.
  `ShotAnimCompilationService` persists it content-addressed and atomically registers
  Generation/Asset provenance after a fresh Shot revision check.
- `TemporalShotGenerationService` injects the compiled ShotAnim only for the
  `native-anime` provider and carries the compiler's exact Asset IDs into temporal
  provenance. Hero-only animated-still fallback remains forbidden.
- New bounded Codex surface:
  `makewatch_anime.production_status`, `shot_anim_plan`, `shot_anim_compile`, plus
  `makewatch_media.audio_provider` and `media_job_cancel`.
- `media_job_cancel` covers visual, reference, audio, temporal, anime and render jobs.
  Queued work is removed immediately. Running Chatterbox/native-anime/FramePack/FFmpeg
  work receives an AbortSignal and becomes cancelled only after the owned process tree
  exits. Abort-aware GPU waiters retain exclusive ordering; cancelled temporal/render
  fixtures write no ready provenance.

### Commits

- `5539f0b` — validate native anime production assets.
- `cfa36a6` — compile ShotAnim from the project graph.
- `632c32d` — persist compiled ShotAnim assets and provenance.
- `4d2b2bd` — wire native ShotAnim generation.
- `fa5be62` — expose bounded native-anime Codex tools.
- `075171f` — add bounded media-job cancellation.

### Verification

- Fresh `verify.ps1`: passed on the product machine (RTX 5070 Laptop 8 GB), including
  bridge/runtime checks, strict TypeScript, Studio production build and **11/11 native
  tests**.
- `python tools/anime/native-anime-worker-selftest.py`: passed; two renders produced
  the same decoded-frame SHA-256 prefix `29ca4625cf5535db`, with zero persisted frames.

### Truth boundary / next milestone

M1 proves a deterministic graph-to-ShotAnim control plane, not production anime
quality. Aggregate anime production readiness intentionally remains false. M2 must
build and validate reusable semantic CharacterRig and EnvironmentPackage assets on the
real product machine. Japanese forced alignment, multi-mouth-state rendering, QC,
corrective redraw and the one-minute acceptance run remain M3/M4 work.
