# Make & Watch — Premium Anime Temporal Production Design

> Architecture / quality roadmap
> Updated: 2026-08-30 (Europe/Istanbul)

> **Direction change (2026-08-30):** the mandatory temporal path is no longer a large
> temporal diffusion model. It is the deterministic **Native Anime Motion Engine**
> (`project_brain/NATIVE_ANIME_MOTION_ENGINE.md`, provider `native-anime`). FramePack
> and any Wan/Hunyuan/LTX-class stack are retained only as **optional experimental
> providers**, off unless their models are explicitly present. The quality goals in
> this document still stand; the primary route to them is the native engine, which
> treats the anime SDXL/ComfyUI stack as a key-animation department. Sections below
> that read "FramePack is the current local temporal foundation" are superseded on
> that one point.

## Goal

The target is not a slideshow with zooms and not a sequence of independently diffused images.

The target is an authored anime episode where:

- Character identity survives every cut;
- costume, hair silhouette, facial proportions and signature colors remain stable;
- Locations preserve geometry, palette and lighting logic;
- every Shot is real temporal video;
- motion feels intentionally animated rather than randomly morphing;
- dialogue acting, eye movement, breathing, hair/cloth secondary motion and camera staging remain coherent;
- action Shots can become expressive/sakuga-like without contaminating quiet dialogue Shots;
- a failed 2–6 second segment can be regenerated without rebuilding a 20-minute Episode.

The production unit is therefore a **short temporal Shot**, not an entire Scene and never an entire Episode.

---

# 1. Core visual philosophy

## 1.1 Anime is not “maximum motion everywhere”

Good anime is selective.

A frame may hold the body pose while:

- eyes blink;
- mouth shapes change;
- shoulders breathe;
- hair tips move;
- cloth settles;
- rain/smoke/light continues;
- background parallax moves;
- camera creeps;
- foreground elements pass the lens.

This is still temporal animation. It is fundamentally different from freezing one complete image and moving its crop.

Make & Watch should aim for **intentional motion density**, not random full-frame deformation.

## 1.2 Output cadence versus drawing cadence

Delivery may remain 24 fps while perceived character animation intentionally resembles animation “on twos” or “on threes” for selected elements.

This should be treated as an artistic cadence target, not implemented by blindly duplicating whole frames.

Desired behavior:

- background/camera/effects can remain fluid;
- character key poses can change at a lower visual cadence;
- mouth/eyes can use discrete expressive poses;
- action/sakuga Shots can switch to denser motion.

A future anime post-process/QC layer may explicitly classify cadence, but temporal synthesis must remain the source of actual moving media.

---

# 2. Canonical Series Bible

A long-form anime Series needs a stronger visual bible than prompt text.

## 2.1 Character reference package

Each important Character should eventually own an accepted package such as:

```text
Character
 ├─ semantic description
 ├─ canonical face/front
 ├─ canonical face/3-quarter
 ├─ canonical profile
 ├─ full-body turnaround
 ├─ neutral expression
 ├─ expression sheet
 ├─ outfit-state references
 ├─ palette swatches
 ├─ hair silhouette reference
 ├─ height/body proportion rules
 ├─ voice reference
 └─ accepted temporal clips
```

The project graph should store these as Asset IDs, never as fragile filesystem assumptions.

### Identity hierarchy

For generation, preserve in roughly this order:

1. face geometry;
2. eye shape/color;
3. hair silhouette/color;
4. body proportions;
5. signature clothing shapes;
6. palette;
7. accessories;
8. micro-detail.

If a provider must sacrifice something under difficult motion, low-priority fabric/detail variation is preferable to identity drift.

## 2.2 Location reference package

A recurring Location should eventually have:

```text
Location
 ├─ master wide layout
 ├─ reverse angle
 ├─ key walls / doors / windows
 ├─ horizon / perspective rules
 ├─ palette
 ├─ material rules
 ├─ daytime lighting state
 ├─ night lighting state
 ├─ weather states
 └─ accepted Scene frames
```

This prevents every new angle from becoming a different apartment/street/classroom.

## 2.3 Style bible

The Series-level anime bible should specify:

- line weight;
- line color policy;
- cel-shadow count;
- highlight policy;
- skin shading;
- eye rendering;
- hair specular style;
- background paint style;
- atmospheric perspective;
- bloom policy;
- chromatic aberration policy;
- film grain policy;
- saturation/value range;
- key color motifs;
- action-effect language;
- compositing softness;
- preferred focal lengths/framing grammar.

The current `anime-cinematic` preset is only a starting scaffold. The long-term quality bar requires Series-specific visual language.

---

# 3. Shot architecture

## 3.1 Prefer short editorial Shots

For local production, default target:

- dialogue/reaction Shot: ~2–5 s;
- atmospheric Shot: ~3–6 s;
- action beat: ~1–4 s;
- special long take: split internally into bounded temporal segments.

This is both cinematic and computationally useful.

Shorter Shot boundaries:

- reset model drift;
- allow new canonical anchors;
- make retries cheap;
- keep VRAM bounded;
- make direction precise;
- let the editor hide model limitations with professional cutting.

## 3.2 Shot classes

The Director should eventually classify Shots into production archetypes.

### Dialogue close-up

Priority:

- face identity;
- eyes;
- mouth timing;
- breathing;
- subtle head motion;
- stable hair/wardrobe;
- quiet background animation.

Avoid excessive camera or body movement.

### Reaction Shot

Priority:

- readable expression change;
- eye focus;
- one controlled head/body action;
- clean silhouette.

### Establishing Shot

Priority:

- Location geometry;
- weather/atmosphere;
- controlled parallax;
- environment motion;
- stable architecture.

### Action / sakuga Shot

Priority changes:

- motion silhouette;
- pose readability;
- arcs;
- anticipation;
- impact;
- smear/deformation allowance;
- speed effects;
- camera energy.

Identity constraints may remain strong but should not suppress intentional animation deformation.

### Insert / object Shot

Priority:

- object geometry;
- hand/object interaction;
- continuity with previous/next cut.

---

# 4. Hero frame is a key drawing, not a final video

The image model should be treated like a key-animation/layout department.

For I2V:

```text
canonical references
       +
Shot direction
       +
Series style bible
       ↓
high-quality hero/start frame
       ↓
TEMPORAL SYNTHESIS
       ↓
video Shot
```

The hero frame establishes:

- identity;
- costume;
- shot composition;
- lens/framing;
- light;
- environment state;
- initial pose.

It must never be looped or pan/zoomed into final Shot media.

---

# 5. I2V versus FLF2V versus VIDEO

## 5.1 I2V — default

Use when:

- start composition matters strongly;
- motion can emerge from one key image;
- character must remain close to a canonical design;
- dialogue/atmosphere is moderate.

This is the default Make & Watch strategy.

## 5.2 FLF2V — controlled pose-to-pose animation

Use when the Shot needs a deterministic endpoint.

Examples:

- character starts looking away and ends looking into camera;
- hand begins at side and ends on door handle;
- person sits, then ends standing;
- camera composition must land exactly for a match cut.

Pipeline:

```text
start key drawing
      ↓
temporal interpolation/synthesis
      ↓
end key drawing
```

This mirrors key-pose thinking more closely than unconstrained generation.

Current Make & Watch contract supports FLF2V, but the current local FramePack provider is primarily the I2V path. FLF2V provider execution should remain explicit until a compatible runtime is integrated and validated.

A current official research candidate is ComfyUI LTX-2.3 FLF2V, whose official workflow is specifically designed to interpolate between first and last images.

Official reference:
https://github.com/Comfy-Org/docs/blob/main/tutorials/video/ltx/ltx-2-3.mdx

## 5.3 Provider-native VIDEO

Use only when a provider can preserve Series continuity without a mandatory hero frame, or when highly dynamic synthesis benefits from native text/video conditioning.

This should not become a shortcut that bypasses Character/Location anchors.

---

# 6. Temporal prompting

Static image prompting and motion prompting should be different artifacts.

Bad temporal prompt:

```text
beautiful anime woman, black hair, blue coat, cinematic lighting
```

That describes appearance, not time.

Better temporal prompt:

```text
0.0–1.2s: she holds eye contact and breathes quietly.
1.2–2.8s: her eyes shift toward the door before her head follows.
2.8–4.5s: she turns slightly; the front hair strand lags and settles.
4.5–5.0s: she stops, tense, with one final blink.
Camera: almost locked, very slow 3% push-in.
Environment: rain continues outside the window; room geometry does not change.
```

Temporal prompt principles:

- chronological verbs;
- one primary action per short Shot;
- explicit start/settle phases;
- secondary motion after primary motion;
- camera direction separate from body action;
- environment motion separate from geometry;
- forbidden drift described in negative constraints.

---

# 7. Motion hierarchy

A useful animation hierarchy:

1. **primary action** — walk, turn, reach, sit, strike;
2. **secondary body motion** — shoulders, torso balance, hands;
3. **overlap/follow-through** — hair, cloth, straps;
4. **facial acting** — gaze, blink, brows, mouth;
5. **environment motion** — rain, smoke, crowds, leaves;
6. **camera motion** — dolly/pan/handheld;
7. **compositing motion** — light flicker, particles, foreground.

The Director should avoid asking the model to maximize all seven at once unless the Shot is intentionally high-energy.

---

# 8. Segment chaining without visible drift

Current temporal planning splits long Shots into bounded sections.

The naive version is:

```text
segment A tail
 -> segment B start
```

Premium version should become:

```text
segment A
 -> extract several tail candidates
 -> continuity QC
 -> choose accepted handoff frame/state
 -> segment B
```

Future handoff state may include:

- selected tail frame;
- face/identity embedding score;
- palette state;
- camera pose intent;
- body pose estimate;
- optical-flow direction;
- environment reference match.

If drift exceeds threshold, regenerate only the bad segment.

Do not regenerate the whole Scene.

---

# 9. Temporal continuity QC

A premium system should not trust one model sample blindly.

Potential QC signals, to be implemented only after hardware validation:

## Identity stability

- face embedding similarity against canonical Character references;
- hairstyle silhouette similarity;
- eye/hair dominant color consistency;
- outfit palette consistency;
- accessory presence.

## Line-art stability

For anime output:

- edge-map temporal consistency;
- line density drift;
- facial feature topology;
- edge warp error after optical-flow compensation.

## Color stability

- palette histogram delta;
- skin/hair/clothing region color drift;
- exposure/white-balance discontinuity.

## Geometry stability

For Locations:

- keypoint/feature consistency;
- vanishing/perspective drift;
- door/window/furniture relative layout;
- background warp error.

## Motion quality

- optical-flow discontinuity;
- acceleration/jerk spikes;
- unnatural sudden camera movement;
- stationary regions that boil/flicker;
- duplicated/frozen tail frames.

## Temporal perceptual metrics

Research candidates include temporal LPIPS-like comparisons, optical-flow-warp reconstruction error and perceptual embedding deltas. Metrics should be used as rejection/ranking signals, not as absolute “art quality” truth.

---

# 10. Candidate generation and selection

For final-quality Shots, one sample should not automatically become canon.

A future bounded candidate strategy:

```text
same semantic Shot + same references
  ├─ candidate A
  ├─ candidate B
  └─ candidate C
       ↓
cheap automated QC
       ↓
Director ranking
       ↓
optional user approval
       ↓
accepted Asset
```

Resource policy should limit candidate count and generate sequentially on 8 GB hardware.

Only accepted media should become preferred continuity references.

---

# 11. Anime-specific compositing

A strong anime look often comes from compositing, not only the raw character render.

Future layers may include:

- background plate;
- character temporal layer;
- foreground occluders;
- rain/snow/smoke;
- speed lines;
- impact flash;
- particles;
- bloom/glow;
- depth haze;
- light rays;
- selective blur;
- film grain;
- color grade.

The system should prefer deterministic compositing for effects that do not require generative re-synthesis.

This reduces model workload and increases art-direction control.

---

# 12. Anime camera grammar

Avoid making every Shot a floating AI camera demo.

Preferred grammar:

- stable layouts;
- deliberate cuts;
- motivated pans;
- restrained pushes during emotional dialogue;
- low-frequency handheld only when dramatically justified;
- strong foreground/background separation;
- match cuts based on shape/gaze/action;
- parallax for environment depth;
- fast camera only in action Shots.

Traditional anime frequently gains energy through editing and pose design rather than continuous 3D camera motion.

---

# 13. Action / sakuga mode

Action Shots need a separate direction profile.

Potential fields for a future Shot schema extension:

```text
actionStyle
poseExaggeration
smearAllowance
impactFramePolicy
speedLinePolicy
cameraEnergy
motionArcDescription
anticipationSeconds
impactSeconds
recoverySeconds
```

Temporal prompt should explicitly describe:

```text
anticipation
 -> acceleration
 -> contact/impact
 -> follow-through
 -> recovery
```

This makes motion readable and avoids constant undifferentiated chaos.

---

# 14. Dialogue acting and lip sync

Anime dialogue should not necessarily chase photoreal mouth geometry.

Three possible production levels:

## Level A — stylized mouth timing

- open;
- half;
- closed;
- occasional emphasized shape;
- blink/brow/head acting independent from mouth.

This can look more anime-authentic than hyper-detailed photoreal lip motion.

## Level B — audio-driven face motion

Generate/condition head and facial performance from the actual voice track while keeping canonical Character references.

## Level C — joint image+audio video

A provider may synthesize image and audio-conditioned video together.

Current official research candidate: ComfyUI LTX-2.3 IA2V provides an image+audio video workflow with synchronized lip movement.

Official reference:
https://github.com/Comfy-Org/docs/blob/main/tutorials/video/ltx/ltx-2-3.mdx

This is a research/upgrade path, not the current local default.

---

# 15. Motion transfer / pose-controlled future path

For difficult acting/action, unconstrained text motion may be weaker than an explicit motion reference.

Potential future input:

```text
canonical Character image
 +
pose/motion reference video
 +
Scene style
 -> character-preserving motion transfer
```

ComfyUI currently documents Wan2.2 Animate / Fun Control workflows for motion/expression or pose-controlled video generation.

Official references:

https://github.com/Comfy-Org/docs/blob/main/tutorials/video/wan/wan2-2-animate.mdx
https://github.com/Comfy-Org/docs/blob/main/tutorials/video/wan/wan2-2-fun-control.mdx

These are future provider research candidates and should not be silently downloaded or selected by the public runtime.

---

# 16. FramePack role — optional experimental provider only

**Status: research-candidate / optional fallback. Not installed by default, not on the
render-readiness path.** The mandatory temporal path is the Native Anime Motion Engine
(`NATIVE_ANIME_MOTION_ENGINE.md`).

FramePack stays registered as provider `framepack` (`strategies: ['I2V']`) and reports
`ready: false` unless its ~30–40 GB Hugging Face model set is explicitly present
(`framePackRuntimeStatus.bootstrapPolicy = 'explicit-only'` — Make & Watch never
auto-downloads it). It exists for local engineering comparison and as an escape hatch
for a shot the native engine + corrective redraw genuinely cannot stage.

Why it was not chosen as the foundation: a mandatory 20–40 GB temporal-diffusion
dependency, ~1 GPU-hour per rendered minute on an 8 GB card, identity drift between
segments, full-frame boiling, opaque failure, and zero reuse across Episodes. The
scoring that led here is in `NATIVE_ANIME_MOTION_ENGINE.md` §1.

Official project: https://github.com/lllyasviel/FramePack

Make & Watch uses FramePack only as a provider implementation behind its own contract;
it never owns project semantics. The provider may evolve; the Series/Shot/Asset graph
must remain stable.

---

# 17. 8 GB GPU choreography

For RTX 5070 Laptop-class 8 GB VRAM, quality depends on process choreography.

Recommended sequence:

```text
Director plans Shot
      ↓
ComfyUI hero/reference frame
      ↓
write/hash Asset
      ↓
release ComfyUI GPU model/cache
      ↓
FramePack temporal generation
      ↓
validate/hash video
      ↓
terminate/release temporal worker
      ↓
voice/lip-sync job if required
      ↓
release worker
      ↓
FFmpeg deterministic composition
```

Never keep ComfyUI image model + FramePack + heavy lip-sync model resident simultaneously on an 8 GB card.

Use system RAM/CPU offload only within measured bounds; avoiding OOM is more valuable than theoretical parallel throughput.

---

# 18. Episode-level continuity loop

For each Scene:

```text
canonical Series Bible
 + Character refs
 + Location refs
 + previous accepted Scene state
       ↓
Shot plan
       ↓
hero/end keys
       ↓
temporal candidates
       ↓
QC + acceptance
       ↓
accepted video Assets
       ↓
Scene master
```

At Episode completion, selected high-quality outputs may be promoted into `acceptedReferenceAssetIds` so Episode 2 can inherit actual on-screen canon from Episode 1.

Do not promote every generated frame automatically. Bad generations must not pollute future continuity.

---

# 19. Cross-episode state

The Series should persist explicit state such as:

- Character current outfit;
- injuries/damage;
- hair changes;
- carried objects;
- Location damage/state;
- time of day;
- weather;
- relationship/emotional state where visually relevant.

This belongs in semantic project nodes, not hidden provider conversation memory.

Provider conversation helps creative collaboration; project graph/Assets are the durable canon.

---

# 20. Director behavior for anime production

The Director should act like a screenwriter + storyboard artist + episode director.

It should:

1. understand the dramatic beat;
2. choose Shot size/order;
3. decide which Character/Location references are needed;
4. prepare hero frames;
5. use I2V for normal Shots;
6. choose FLF2V when the endpoint matters;
7. use stronger action direction for sakuga-like moments;
8. poll temporal jobs instead of claiming completion;
9. inspect composition readiness;
10. regenerate only failed/weak Shots;
11. preserve accepted continuity for future Episodes.

The user should be able to say things like:

```text
Make this scene feel like a quiet late-night anime conversation.
Keep Mira exactly on-model.
Use restrained movement and rain outside the window.
At the final line she slowly turns toward the door.
```

and the Director should translate that into structured Shot timing and temporal jobs.

---

# 21. Quality tiers

## Draft

Purpose: story/edit validation.

- smaller/shorter temporal jobs;
- one candidate;
- basic continuity checks;
- fast encode.

## Preview

Purpose: judge acting/style/continuity.

- stronger hero frame;
- normal temporal settings;
- candidate retry when QC fails;
- dialogue audio;
- Scene assembly.

## Final

Purpose: published Episode.

- canonical reference enforcement;
- multiple candidates only where needed;
- stronger temporal QC;
- controlled endpoint generation for difficult Shots;
- audio/lip-sync pass;
- final compositing/grade;
- accepted Asset promotion.

---

# 22. What must never return

The following are explicitly rejected as final Shot generation:

- one image looped for five seconds;
- Ken Burns / zoompan pretending to be character motion;
- sequence of independently generated unrelated still frames;
- silent image fallback when I2V fails;
- clone-padding the final video frame to hide insufficient duration;
- treating hero/reference frames as completed Shot media;
- marking a generation successful before validated Asset/provenance commit.

If temporal synthesis fails, the Shot is failed/not-ready.

That failure is preferable to a fake completed video.

---

# 23. Implementation roadmap

## Phase A — now / foundation

**Implemented now:**
- temporal-only Shot schema;
- I2V default;
- image fallback removed from Episode composition;
- animated-still FFmpeg renderer deleted;
- temporal video duration mandatory;
- canonical Character/Location reference Assets;
- content-addressed provenance;
- GPU-exclusive jobs;
- provider-neutral `TemporalProviderRegistry` (drop-in providers behind one artifact contract).

**Validated experimentally (vertical slice, not production-wired):**
- Native Anime Motion Engine deterministic renderer mechanics — see
  `NATIVE_ANIME_MOTION_ENGINE.md` §8. The visual/anime gate failed on semantic face
  decomposition, so this is not a quality acceptance.

**Planned:**
- native project graph -> ShotAnim compiler; the registered `native-anime` adapter
  remains fail-closed/not-ready until this exists;
- corrective-redraw (C) escalation and PoseLibrary promotion;
- deterministic subtitle render + WebVTT sidecar.

**Research candidate / optional:**
- FramePack `framepack` provider (off unless models present);
- Wan 2.2 / LTX-2 / HunyuanVideo FLF2V/VIDEO providers.

## Phase B — anime continuity QC

- accepted model-sheet reference roles;
- face/line/palette drift scoring;
- segment tail QC;
- retry only failed temporal sections;
- user/Director candidate acceptance.

## Phase C — key-pose direction

- production FLF2V provider;
- explicit pose/end-frame authoring;
- match-cut endpoint planning;
- pose/control reference inputs.

## Phase D — dialogue performance

- voice-driven acting/lip timing;
- anime mouth-shape policy;
- eye/head acting control;
- subtitle timing alignment.

## Phase E — final anime compositing

- deterministic FX layers;
- color script enforcement;
- shot-to-shot grade matching;
- foreground/background compositing;
- action impact/smear effect toolkit;
- final Episode QC report.

---

# 24. Acceptance bar

A temporal anime Scene is acceptable only if:

- every Shot is actual video;
- no hidden still fallback occurred;
- primary Character remains recognizably on-model;
- Location does not morph between cuts without narrative reason;
- motion starts/ends intentionally;
- hair/cloth/environment show coherent secondary motion where appropriate;
- dialogue Shots do not jitter or overanimate;
- action Shots remain readable;
- no Shot is padded with a frozen tail to meet duration;
- audio/video timing is believable;
- bad Shots can be identified and regenerated independently.

That is the standard Make & Watch should optimize toward.
