# Make & Watch — Native Anime Motion Engine

> Architecture decision + design
> Created: 2026-08-30 (Europe/Istanbul)
> Status of this document: **architecture selected; M1 graph-backed ShotAnim control plane implemented; renderer proof mechanically passes but the visual slice remains rejected; semantic rig building, alignment, C, B and full QC are roadmap.**

This document supersedes the parts of `ANIME_TEMPORAL_PIPELINE.md` and `MEDIA_PIPELINE.md`
that described a large temporal diffusion model (FramePack / Wan / Hunyuan / LTX class)
as the **mandatory** future of Shot video. It is not mandatory. It is an optional
escape hatch. The primary production system is a deterministic, storage-cheap,
2D-animation engine that treats the existing anime SDXL/ComfyUI stack as a
**key-animation department**, not a per-frame generator.

Legend used throughout:

- **[implemented]** — code exists on the current feature branch/working tree and is exercised by a check or the vertical slice; this does not imply release acceptance.
- **[slice]** — proven once by the vertical slice, not yet production-wired.
- **[planned]** — designed here, not built.
- **[research]** — external technique we intend to adopt; not integrated.

---

## 0. Why this decision

### 0.1 The constraint that forced it

Real temporal proof was blocked on the product machine because the only registered
temporal provider (`FramePackTemporalProvider`) needs a ~30–40 GB Hugging Face model
set (`hunyuanvideo-community/HunyuanVideo`, `lllyasviel/flux_redux_bfl`,
`lllyasviel/FramePackI2V_HY`) that Make & Watch deliberately refuses to auto-download
(`framePackRuntimeStatus.bootstrapPolicy = 'explicit-only'`). Replacing it with
another 20–40 GB video model (Wan 2.2, LTX-2, CogVideoX) trades one heavy mandatory
dependency for another and keeps every structural weakness: identity drift between
segments, full-frame boiling, opaque failure, no reuse across episodes, ~1 hour of
GPU per rendered minute on an 8 GB laptop card.

### 0.2 The insight

Professional limited animation is **not** "many images per second." A held body pose
with living eyes, mouth, hair tips and a moving camera over a painted multiplane
background *is* temporal animation, and it is how most TV anime minutes are actually
shot. The image model's correct role is the **layout / key-animation department**:
produce a small number of on-model key drawings. Everything between the keys —
inbetweens, secondary motion, camera, environment parallax, mouth flap, compositing —
is deterministic 2D code that costs kilobytes and milliseconds, not gigabytes and
hours.

### 0.3 What the current code already gives us for free (verified)

The temporal path is **provider-neutral end to end**. A new engine only has to be a
registered temporal provider that returns the existing artifact contract:

```
{ mediaType: 'video', relativePath, sha256, mimeType, durationSeconds, width, height, fps, providerMetadata }
```

`TemporalProviderRegistry` (`tools/generation/temporal-provider-registry.mjs`) validates
that shape; `TemporalShotGenerationService` registers `generation` + `asset` nodes with
full provenance, enforces stale-revision fail-closed, and runs everything through
`GpuExclusiveScheduler`; `compileEpisodeComposition` and `EpisodeRenderService`
(`tools/composition/`) consume `video` Shot Assets and already do FFmpeg
scale/pad/fps-normalize, xfade transitions, timed audio mix with `loudnorm`, scene
cache and `-c copy` episode concat. **None of that changes.** The native anime engine
slots in where FramePack sits.

> Bug found and fixed while verifying this: `validateProvider()` did `return {...provider}`,
> which strips prototype methods off a class instance, so `FramePackTemporalProvider`
> (and any class-based provider, including this new engine) reported
> `provider.status is not a function`. Fixed to delegate; regression test added.

---

## 1. Architecture comparison

Seven candidates were scored 0–100 on 16 dimensions. Scores are judgement calls by
the author, informed by the code audit and the research anchors in §16, and are meant
to be argued with, not treated as measurement (per INVARIANTS #13 the real numbers
come from the benchmark in §14).

Candidates:

- **A** — Sparse Keyframe / Rig only (Live2D-class layered-mesh deformation).
- **B** — Motion Retargeting only (skeleton/pose sequences, no renderer of its own).
- **C** — Selective Neural Re-draw only (generate every needed pose, interpolate).
- **A+B**, **A+C**, **A+B+C** — hybrids.
- **FP** — the current FramePack-primary temporal-diffusion system.

| Dimension | A | B | C | A+B | A+C | A+B+C | FP |
|---|---:|---:|---:|---:|---:|---:|---:|
| Anime visual ceiling | 45 | 20 | 55 | 58 | 72 | **76** | 60 |
| Character identity consistency | 95 | 40 | 68 | 90 | 90 | 90 | 45 |
| Location consistency | 94 | 40 | 55 | 92 | 93 | 93 | 42 |
| Complex motion capability | 28 | 45 | 60 | 60 | 58 | 70 | **84** |
| Dialogue quality | 80 | 35 | 70 | 78 | 86 | **86** | 58 |
| Action quality | 22 | 48 | 55 | 55 | 52 | 64 | **72** |
| Determinism | 98 | 95 | 55 | 92 | 84 | 84 | 38 |
| 8 GB feasibility | 98 | 98 | 78 | 96 | 86 | 85 | 42 |
| Runtime speed (per 60 s) | 95 | 92 | 55 | 90 | 66 | 64 | 18 |
| Mandatory disk footprint | 96 | 98 | 68 | 95 | 80 | 80 | 12 |
| Per-episode storage | 93 | 95 | 80 | 93 | 90 | 90 | 68 |
| Reusability across episodes | 88 | 95 | 55 | 92 | 88 | 92 | 25 |
| Cost | 96 | 95 | 70 | 94 | 76 | 76 | 40 |
| Maintainability | 62 | 58 | 80 | 55 | 60 | 50 | 58 |
| Debuggability | 92 | 80 | 48 | 84 | 78 | 74 | 22 |
| Director controllability | 85 | 82 | 62 | 86 | 88 | **90** | 48 |
| **Plain mean** | 79.2 | 69.8 | 63.4 | **81.9** | 77.9 | 79.0 | 45.8 |
| **Product-weighted mean** | 70.0 | — | — | 77.0 | 76.1 | **78.9** | 52.4 |

Product-weighted mean triples the four dimensions that define the product
(anime visual ceiling, complex motion, dialogue quality, action quality) and doubles
identity / location / director-control, because the efficiency dimensions are
**constraints to satisfy**, not quantities to maximise.

### 1.1 Reading the table honestly

- **A alone wins the plain mean if you ignore the mission.** It is the cheapest,
  most deterministic, most debuggable option. It also has an anime visual ceiling of
  45 and an action score of 22: it is a talking-puppet engine. The user's own
  failure-mode list ("a talking VTuber", "cheap puppet animation") is exactly what
  pure A produces the moment a shot needs real staging.
- **A+B tops the plain mean** because B's artifacts (motion clips) are the single most
  reusable, most deterministic asset type. But A+B's visual ceiling is still capped at
  58: without C, any pose outside the rig's valid deformation domain either folds the
  mesh or forces the "two drawings -> hope the morph works" antipattern, which the
  brief explicitly forbids.
- **FP wins raw motion and action** and nothing else. Its "anime visual ceiling" of 60
  is generous — morphing AI motion actively reads as *not anime* in quiet dialogue,
  which is where a series lives.
- **A+B+C wins the product-weighted mean (78.9)** and is the only option that clears
  the product bar on every mission dimension while staying inside every hard
  constraint.

### 1.2 Selected architecture

**Target: A+B+C.**
**Build now: A+C** (rig + corrective redraw + deterministic 2.5D environment +
forced-alignment lip sync). **B** (skeleton/IK motion library + cross-character
retargeting) is milestone 2.

Why A+C first and not full A+B+C: B's value is concentrated in action shots, which are
the lowest-confidence area of the whole design regardless of B, and B adds the most
net-new code (skeleton solver, IK, foot-lock, retarget). A+C proves the core thesis —
*deterministic limited animation of AI key drawings* — on dialogue, reaction and
establishing shots, which is where a credible anime **series** spends ~80 % of its
runtime.

**FramePack: retained as optional provider `framepack`, disabled unless its models are
present.** It is never on the render-readiness path.

---

## 2. System overview

```
Director (animation director, not prompt relay)
  |  Shot plan: class, framing, key states, acting beats, gaze/expression timelines,
  |             camera path, secondary-motion intent, dialogue timing, redraw flags
  v
Reusable canon (native graph + content-addressed assets)
  |- CharacterRig      (per Character x outfit-state)   ~20-40 layer images + JSON
  |- EnvironmentPackage(per Location)                   ~3-8 depth plates + depth map + JSON
  |- PoseLibrary       (accepted rig states, incl. redraws)
  \- MotionClip        (reusable skeletal/param performances)      [B / planned]
  v
Shot animation program  (ShotAnim JSON - the temporal provider request payload)
  |- param curves per character (headAngleX/Y/Z, eyeLook, blink, mouthShape, breathing, bodyAngle, hairSway...)
  |- correctiveKeys[] : { t, generated key drawing asset, blend }   <- C, only where the rig can't reach
  |- camera keyframes + shake
  |- dialogue[] : { dialogueUnit, audioAsset, alignmentAsset -> derived mouthShape channel }
  \- fx[] : rain / bloom / grain / speedlines / light-rays  (deterministic)
  v
Native Anime Motion Engine worker  (Python: numpy + Pillow + OpenCV; optional moderngl/GL)
  per frame @ delivery fps:
    resolve param vector -> deform each layer mesh (bone + warp-grid + rotation deformers)
    Verlet secondary motion (hair / cloth / accessories)
    composite layers in depth order over parallax-shifted environment plates
    apply camera transform + deterministic FX + grade
    stream frame -> encoder
  v
Optional RIFE pass  (cadence smoothing between VALID rendered poses only)   [research/slice-optional]
  v
FFmpeg encode -> per-Shot MP4  (frames streamed + deleted; nothing persisted per-frame)
  v
Existing pipeline UNCHANGED:
  TemporalProviderRegistry validate -> generation+asset provenance -> composition -> EpisodeRenderService
```

The engine adapter is registered as temporal provider **`native-anime`** with
`strategies: ['I2V']`. Its dependency probe can validate the renderer, but production
`ready` deliberately remains `false` until the native project graph -> ShotAnim
compiler exists. A hero image alone is rejected; there is no living-hold/Ken Burns
fallback. Later, use a dedicated `strategy: 'RIG2V'` if rig-specific inputs cannot fit
the provider-neutral I2V envelope cleanly.

---

## 3. Data model

All of this lives in the **existing** native graph. `Node.metadata` is
`map<string,string>`; large structured payloads are stored as `asset` nodes with
`mediaType: 'json'` and content-addressed bytes. **No native C++ schema migration is
required.** New semantic concepts are represented as typed JSON assets + strongly
named metadata keys until/unless dedicated `NodeKind`s are justified.

### 3.1 CharacterRig  `asset` (mediaType `json`), depended on by `character`

```jsonc
{
  "schema": "makewatch.characterRig/1",
  "characterId": "character.mira",
  "outfitState": "default",
  "canvas": { "width": 2048, "height": 2048 },
  "layers": [
    {
      "id": "front_hair",
      "semanticPart": "front_hair",
      "imageAssetId": "asset.<sha>",
      "depthOrder": 90,
      "parentBone": "head",
      "mesh": { "kind": "grid", "cols": 6, "rows": 8, "restPoints": [[0,0]], "uv": [[0,0]] },
      "pivot": [0.5, 0.12]
    }
  ],
  "skeleton": {
    "bones": [
      { "id": "root",  "parent": null,   "rest": { "x": 1024, "y": 1600, "rot": 0, "len": 0 } },
      { "id": "spine", "parent": "root", "rest": { "x": 0, "y": -220, "rot": 0, "len": 260 } },
      { "id": "neck",  "parent": "spine","rest": { "x": 0, "y": -260, "rot": 0, "len": 90 } },
      { "id": "head",  "parent": "neck", "rest": { "x": 0, "y": -90,  "rot": 0, "len": 220 } }
    ]
  },
  "params": [
    { "id": "headAngleX", "min": -30, "max": 30, "default": 0 },
    { "id": "headAngleY", "min": -22, "max": 22, "default": 0 },
    { "id": "headAngleZ", "min": -18, "max": 18, "default": 0 },
    { "id": "eyeLookX",   "min": -1,  "max": 1,  "default": 0 },
    { "id": "eyeLookY",   "min": -1,  "max": 1,  "default": 0 },
    { "id": "eyeBlinkL",  "min": 0,   "max": 1,  "default": 0 },
    { "id": "eyeBlinkR",  "min": 0,   "max": 1,  "default": 0 },
    { "id": "browRaise",  "min": -1,  "max": 1,  "default": 0 },
    { "id": "mouthOpen",  "min": 0,   "max": 1,  "default": 0 },
    { "id": "mouthShape", "min": 0,   "max": 7,  "default": 0 },
    { "id": "bodyAngle",  "min": -20, "max": 20, "default": 0 },
    { "id": "breathing",  "min": 0,   "max": 1,  "default": 0 },
    { "id": "hairFrontSway", "min": -1, "max": 1, "default": 0 },
    { "id": "hairBackSway",  "min": -1, "max": 1, "default": 0 }
  ],
  "deformers": [
    {
      "id": "head_warp", "type": "warp-grid",
      "targetLayers": ["face_base", "eyes_l", "eyes_r", "brows", "mouth", "front_hair"],
      "drivenBy": ["headAngleX", "headAngleY", "headAngleZ"],
      "keys": [
        { "at": { "headAngleX": -30 }, "offsets": [[0,0]] },
        { "at": { "headAngleX":  30 }, "offsets": [[0,0]] }
      ]
    },
    { "id": "neck_rotation", "type": "rotation", "targetLayers": ["head_group"], "drivenBy": ["headAngleZ"], "pivotBone": "neck" }
  ],
  "physics": [
    {
      "id": "front_hair_dyn", "type": "pendulum-chain",
      "rootBone": "head", "attachLayer": "front_hair",
      "segments": 3, "restAngles": [0, 0, 0],
      "stiffness": 0.28, "damping": 0.12, "gravity": [0, 0.6],
      "driveParam": "hairFrontSway", "maxDeg": 22
    }
  ],
  "validDomain": {
    "headAngleX": [-24, 24], "headAngleY": [-16, 16], "headAngleZ": [-14, 14],
    "combined": [ { "if": {"headAngleX": [">", 18]}, "then": {"headAngleY": [-8, 8]} } ]
  }
}
```

### 3.2 EnvironmentPackage  `asset` (mediaType `json`), depended on by `location`

```jsonc
{
  "schema": "makewatch.environmentPackage/1",
  "locationId": "location.rain_cafe_interior",
  "canvas": { "width": 3072, "height": 1728 },
  "plates": [
    { "depthIndex": 0, "role": "sky_window", "imageAssetId": "asset.<sha>", "parallax": 0.10 },
    { "depthIndex": 1, "role": "back_wall",  "imageAssetId": "asset.<sha>", "parallax": 0.35 },
    { "depthIndex": 2, "role": "mid_tables", "imageAssetId": "asset.<sha>", "parallax": 0.70, "alphaAssetId": "asset.<sha>" },
    { "depthIndex": 3, "role": "fg_counter", "imageAssetId": "asset.<sha>", "parallax": 1.15, "alphaAssetId": "asset.<sha>" }
  ],
  "depthMapAssetId": "asset.<sha>",
  "lightingStates": { "day": {}, "night": {}, "dusk": {} },
  "weatherStates": { "clear": {}, "rain": { "fx": ["rain_medium", "window_streaks"] } },
  "cameraSafeRegion": { "x": [0.05, 0.95], "y": [0.05, 0.9] }
}
```

Plates are produced either by **See-through**-style layer decomposition [research] or
by generating the background once in ComfyUI and splitting into 3–5 depth bands by
thresholding a Depth Anything V2 map, then inpainting the revealed edges. Either way
it is **one-time per Location**, reused across every Scene and Episode.

### 3.3 ShotAnim  — the temporal provider request payload  `asset` (json) or inline

```jsonc
{
  "schema": "makewatch.shotAnim/1",
  "shotId": "shot.s02.03",
  "durationSeconds": 4.0,
  "fps": 24,
  "resolution": [1920, 1080],
  "cadence": { "bodyKeys": "on-3", "mouth": "discrete", "eyes": "discrete", "hair": "continuous", "camera": "continuous" },
  "environment": {
    "packageAssetId": "asset.<sha>", "lighting": "night", "weather": "rain",
    "camera": [
      { "t": 0.0, "x": 0.00, "y": 0.00, "zoom": 1.00, "rot": 0 },
      { "t": 4.0, "x": 0.00, "y": -0.01, "zoom": 1.03, "rot": 0 }
    ],
    "shake": null
  },
  "characters": [
    {
      "rigAssetId": "asset.<sha>", "screen": { "x": 0.62, "y": 0.58, "scale": 0.9, "flip": false },
      "curves": {
        "eyeLookX": [ { "t": 0.0, "v": 0.0 }, { "t": 1.4, "v": 0.0 }, { "t": 1.9, "v": -0.8, "ease": "easeInOut" } ],
        "headAngleX": [ { "t": 0.0, "v": 0 }, { "t": 1.75, "v": 0 }, { "t": 2.4, "v": -14, "ease": "easeOut" } ],
        "breathing": [ { "t": 0.0, "v": 0.0 }, { "t": 2.0, "v": 1.0 }, { "t": 4.0, "v": 0.0 } ]
      },
      "blinkSchedule": [ 1.1, 3.2 ],
      "dialogueRef": "dlg.s02.014"
    }
  ],
  "dialogue": [
    { "dialogueUnitId": "dlg.s02.014", "speakerCharacterIndex": 0,
      "audioAssetId": "asset.<sha>", "alignmentAssetId": "asset.<sha>", "startSeconds": 0.6 }
  ],
  "correctiveKeys": [
    { "t": 2.55, "characterIndex": 0, "keyDrawingAssetId": "asset.<sha>", "blend": "crossfade", "blendFrames": 2 }
  ],
  "fx": [ { "kind": "rain", "intensity": 0.5 }, { "kind": "grain", "amount": 0.04 }, { "kind": "bloom", "amount": 0.15 } ]
}
```

### 3.4 Alignment  `asset` (json) — shared with `LOCALIZATION_SYNC_ARCHITECTURE.md`

Follows the alignment-asset shape already specified in `LOCALIZATION_SYNC_ARCHITECTURE.md` §5.1:
`{ dialogueUnitId, language, audioAssetId, sampleRate, speechStart, speechEnd, tokens:[{text,start,end,conf}] }`.
The mouth channel is **derived** from this at render time (§7); it is not stored twice.

### 3.5 Controlled vocabulary — `semanticPart`

`root, spine, neck, head_group, face_base, eyes_l, eyes_r, brows, mouth, ear_l, ear_r,
front_hair, side_hair_l, side_hair_r, rear_hair, torso, hip, upper_arm_l, upper_arm_r,
forearm_l, forearm_r, hand_l, hand_r, thigh_l, thigh_r, shin_l, shin_r, foot_l, foot_r,
accessory_*`. Unknown parts are allowed but excluded from automated QC.

---

## 4. Animation math

### 4.1 Layer transform stack (per frame, per layer)

```
world(vertex) =  M_screen
              .  M_camera
              .  M_bone(chain from root; each bone rotated by its param contribution + IK)   [B: IK; A: FK only]
              .  D_warp(param vector)          // bilinear-blended control-point offsets from deformer keys
              .  D_rotation(param)             // rigid rotation about pivot bone
              .  P_physics(t)                  // Verlet offset for dynamic layers
              .  rest(vertex)
```

- **Bone chain (FK):** standard 2D hierarchical transform. Each param maps to a bone
  rotation via a linear or piecewise-linear curve defined in the deformer. IK
  (two-bone analytic + FABRIK for longer chains) is **[B / planned]** for limbs.
- **Warp-grid deformer:** a `cols x rows` lattice of control points. Each deformer key
  is a full set of control-point offsets `at` a param value. For an arbitrary param
  vector, offsets are **multi-linearly interpolated** between the bracketing keys per
  driving param, then summed across deformers targeting the layer. Vertex positions
  are bilinear-sampled from the deformed lattice (same as a Live2D ArtMesh under a
  Warp Deformer). This is cheap (`O(vertices)`) and exact at the keys.
- **Rotation deformer:** rigid `rotate(theta(param))` about a pivot bone head; used for
  necks, wrists, props. Rotation deformer as parent + warp-grid as child reproduces
  the Live2D "neck that changes shape as it turns" idiom.
- **Rendering the deformed mesh:** `cv2.remap` / per-triangle affine warp
  (`cv2.warpAffine` in a mask) at delivery resolution. Premultiplied alpha throughout;
  composite back-to-front by `depthOrder`.

### 4.2 Interpolation of param curves

Keyframe channels support `step`, `linear`, `easeIn/Out/InOut` (cubic),
`bezier(p1,p2)`, and two anime-specific holds: `hold` (value frozen until next key)
and `snap-on-N` (value only updates on frame indices `= 0 (mod N)` — this is how
"animate on 2s/3s" is done **without duplicating whole frames**; only the *character
key-pose channels* snap, while camera / hair / FX stay continuous).

### 4.3 Secondary motion — deterministic Verlet

Per dynamic chain (hair strand, ribbon, coat hem):

```
for each segment i:
  x_i' = x_i + (1 - damping) * (x_i - x_prev_i) + a * dt^2      // Verlet integrate
  x_prev_i = x_i ; x_i = x_i'
constraint-solve K iterations:
  keep |x_i - x_{i-1}| == restLength_i                          // distance constraint
  pull x_i toward rest bend by stiffness                        // angular spring
  clamp bend angle to +/- maxDeg                                // no impossible fold
root segment is pinned to its attach bone's animated transform
```

Fixed `dt = 1/fps`, fixed `K`, fixed seed -> **bit-identical every run**. The
head-rotation param feeds the root; the tips lag, overshoot and settle. `driveParam`
adds an optional authored sway on top (wind, motion).

### 4.4 Camera / environment (2.5D)

Each plate translates by `camera.pan * plate.parallax` and scales by
`1 + (camera.zoom - 1) * plate.parallax`. Depth-map-driven micro-parallax (per-pixel
displacement from `depthMapAssetId`) is an optional higher-quality mode for a single
"master plate" location that was not pre-split. Focus falloff is a depth-keyed
Gaussian blur. All deterministic.

### 4.5 Compositing / grade

Deterministic FFmpeg/OpenCV/numpy: additive rain layers, `unsharp` line boost,
bloom (threshold -> blur -> screen), grain (seeded noise), chromatic aberration
(channel shift), light rays (radial blur of a masked highlight), colour grade (3D LUT
or lift/gamma/gain). Effects that do **not** need re-synthesis never touch a model.

---

## 5. Corrective re-draw policy (C)

**Principle:** the image model is a key animator, never an inbetweener.

### 5.1 When a redraw is triggered

Automatically, when any of these is true for a target frame:

1. a param vector leaves `rig.validDomain` (mesh-fold risk);
2. the Director's Shot plan marks a `correctiveKey` (new angle, back view, big
   expression, hand-object contact, severe foreshortening);
3. runtime QC (§8) on a rendered candidate frame exceeds a distortion threshold;
4. a required `semanticPart` for the requested pose does not exist in the rig.

### 5.2 How a redraw is generated

One image, via the existing ComfyUI stack, **strongly conditioned**:

```
canonical Character reference asset(s)            (identity)
+ current outfit-state layers as an img2img base  (wardrobe / palette lock, low denoise 0.35-0.5)
+ target 2D skeleton / pose  (ControlNet OpenPose/DWPose)      [needs ControlNet SDXL ~2.5 GB, planned]
+ Shot framing + Location plate as context
+ Series style-bible negative/positive scaffold
-> one key drawing
```

The result is registered as an `asset`, **added to `rig.poseLibrary`**, and depended
on by the Character (an accepted, reusable canon pose). Episode 5's head-turn reuses
Episode 1's. This is why C's runtime cost amortizes across a series instead of
recurring per shot.

### 5.3 How the animation resumes after a redraw

The redraw is a **new key state**. The engine:

1. cross-fades (2–3 frames) from the last rig frame to the redraw, **only if** a
   tail-frame continuity score (feature match + palette delta) is under threshold;
2. otherwise the Director is told to place a **cut** at that instant (the honest,
   anime-correct answer — you cut on the hard pose change);
3. resumes rig/deformation animation from the redraw's pose vector (estimated by
   fitting rig params to the drawing, or authored by the Director).

### 5.4 What redraw is NOT allowed to do

- generate two independent drawings and interpolate between them with no shared base;
- become a per-frame generator;
- silently replace the rig for a whole shot without the plan saying so;
- promote a low-confidence / off-model redraw into cross-episode canon.

---

## 6. Motion retargeting (B) — [planned, milestone 2]

Motion is stored as `MotionClip` json: channels over `bone` rotations + `param`
values + `events` (footPlant, contact, impact). Sources: procedural generators,
Director-authored key poses, a small hand-built library, DWPose extraction from a
short user reference clip, or synthetic pose planning. Retargeting maps a source
skeleton to a `CharacterRig` skeleton by bone-name correspondence + limb-length
scaling + foot-lock IK + centre-of-mass preservation. A walk cycle authored once
drives any rig. Clips outside a rig's valid domain trigger redraws at the offending
key. This is the action pipeline's backbone; it is **not** in the current build.

---

## 7. Japanese performance + lip sync

Wired to `LOCALIZATION_SYNC_ARCHITECTURE.md`. **No new competing concept.**

```
DialogueUnit
  -> performanceText.ja-JP  (Director adaptation, not literal translation)
  -> Chatterbox Multilingual V3, language_id = ja   [implemented - audio path already supports ja]
  -> forced alignment  ->  Alignment asset (tokens with ms ranges + confidence)
  -> derived stylized mouth channel  (render-time, not stored)
  -> subtitleText.tr-TR  ->  reading-speed / segmentation solver  ->  timed cue   [planned]
```

### 7.1 Forced alignment

- **[slice]** the proof uses authored mora timing from its deterministic synthetic
  tone generator. It does **not** prove Japanese TTS or forced alignment.
- **[planned]** a forced-alignment provider using Montreal Forced Aligner, WhisperX,
  or another measured Japanese-capable aligner behind the stable Alignment contract.
- **[research/canonical]** Montreal Forced Aligner 3.x (Japanese acoustic + dictionary
  + G2P models) as an accuracy candidate; WhisperX JA as an
  alternative. Chosen aligner is a provider behind a stable Alignment-asset contract,
  never a project-truth owner.

### 7.2 Confidence gate

Alignment confidence below threshold -> retry with known transcript -> verify text
normalization -> regenerate the TTS line if pronunciation is clearly wrong -> **do not
build mouth motion from low-confidence timing** (fall back to a generic open/close
envelope and flag for human check).

### 7.3 Stylized mouth shapes

Eight discrete shapes, anime-simple, not photoreal visemes:
`CLOSED(0) SMALL(1) A(2) I(3) U(4) E(5) O(6) WIDE(7)`. Japanese mora -> shape:
vowels a/i/u/e/o -> A/I/U/E/O; nasal/silence -> CLOSED; small pause -> SMALL; emphasis /
shout -> WIDE. Consonant-only frames hold the previous vowel shape or CLOSED for
stops. The mouth layer is a sprite set or a warp-grid target keyed to `mouthShape`.

### 7.4 Lip vs subtitle timing

Enforced separation from `LOCALIZATION_SYNC_ARCHITECTURE.md` §6: mouth channel follows
`Alignment` exactly; the Turkish subtitle cue follows the same DialogueUnit but is
solved for reading speed (<=17 CPS adult, <=2 lines) and **may linger past mouth
closure**. Subtitle rendering itself is still a gap (`EpisodeRenderService` does not
burn or export subtitles today) — tracked in §12.

---

## 8. Vertical slice evidence and visual inspection

**Mechanical result: PASS. Product/anime visual result: FAIL.** The latest accepted
benchmark artifact is `.makewatch/reports/native-anime-slice/slice.mp4`:

- 4.000 s, 1920x1080, 24 fps, 96 H.264 frames + AAC audio;
- 6 registered layers, one driven Verlet chain, two parallax plates;
- eye-look, blink, mouth envelope, subtle head motion, hair follow-through, camera,
  burned Turkish subtitle;
- `framesSha256 = 5080035b0259ec3458986fe2096815384884a73d8c7592e75536b2d30f2cf870`;
- 36.46 s render wall time = **9.11 s per output second** on the product machine;
- 10,239,596 B reusable layer/audio state + 4,663,380 B MP4 = **14,902,976 B**;
- zero persisted intermediate frames.

The audio is a deterministic vowel-tone proxy with authored mora timings, **not a
genuine Chatterbox Japanese performance**. The contact sheet shows stable identity and
environment, but the face reads as a puppet: crude automatic eye removal leaves a
light horizontal inpaint seam during head/eye motion, the affine front-hair overlay
does not behave like a clean semantic mesh, and mouth motion is only vertical scale.
The slice therefore proves renderer/provenance/storage mechanics, not the one-minute
acceptance gate or professional anime quality. Further blur/mask heuristics are not an
acceptable fix; the next slice requires accepted semantic open-eye/closed-eye/mouth
states (or See-through-class decomposition) and a real Japanese DialogueUnit.

## 8.1 Quality control target

Runs on rendered candidate frames and on rig param vectors before render.

| Signal | Method | Action on fail |
|---|---|---|
| Mesh foldover / triangle inversion | signed area of every deformed triangle; sign flip = fold | clamp to valid domain, else escalate to redraw |
| Param outside `validDomain` | interval + combined-rule check | escalate to redraw |
| Face landmark topology drift | landmark detector on rendered frame vs canonical layout | redraw + flag |
| Eye geometry distortion | eye-region aspect / area vs rest +/- tolerance | redraw |
| Limb stretch | bone length delta vs rest > 12 % | clamp / redraw |
| Foot sliding | horizontal foot-contact drift during a "planted" event | tighten foot-lock IK (B) |
| Line instability / boil | temporal edge-map delta on static regions | reduce warp gain; investigate physics params |
| Palette drift | per-region histogram delta vs rig | reject redraw; regrade |
| Pose discontinuity at cut/redraw | feature-match + flow between adjacent frames | insert cut instead of crossfade |
| Subtitle CPS / lines | arithmetic on cue | re-segment / condense |
| A/V timing | mouth-channel start vs `Alignment.speechStart` | re-derive channel |

QC never silently ships an ugly frame; it either fixes deterministically, escalates to
one redraw, or tells the Director to cut.

---

## 9. Storage strategy

**Persistent project state contains no rendered frames.**

| Kind | Approx size | Lifetime | Reuse |
|---|---|---|---|
| CharacterRig JSON | 50-400 KB | permanent | every episode |
| Character layer images (~20-40 x premul PNG/WebP) | 10-30 MB per outfit-state | permanent | every episode |
| EnvironmentPackage JSON | 20-80 KB | permanent | every episode |
| Environment plates (3-8) + depth map | 8-25 MB per Location | permanent | every episode |
| PoseLibrary entries (redraws) | ~1-2 MB each | permanent | cross-episode |
| MotionClip JSON | 5-50 KB | permanent | cross-character |
| DialogueUnit + Alignment JSON | <20 KB per line | permanent | - |
| Dialogue audio (opus/wav) | ~30-80 KB/s | permanent | - |
| ShotAnim JSON | 5-40 KB per Shot | permanent | - |
| **Intermediate frames** | 0 | **scratch, streamed to encoder, deleted** | - |
| Final per-Shot MP4 | ~0.4-1.5 MB/s at 1080p CRF 18 | project artifact | - |
| Final Episode MP4 | ~1-2.5 MB/s | project artifact | - |

**Per-Episode marginal storage** ~= final Episode MP4 (**~480 MB-1.8 GB for 20 min**
at the stated 0.4-1.5 MB/s range; **~24-90 MB for one minute**) **+** new redraws for that episode
(a handful x ~1.5 MB) **+** ShotAnim/Alignment JSON (<1 MB) **+** new dialogue audio.
Recurring Characters and Locations add **zero** new canonical asset copies. Content-
addressed dedup (`asset.<sha[:24]>`, already the convention) stores identical
layers/plates once. If both every per-Shot MP4 and the final Episode MP4 are retained,
budget roughly twice the encoded-video range until an explicit cache-retention policy
is implemented. The current 4 s proof is 1.17 MB/s, inside the stated range.

**Mandatory incremental install footprint target:** renderer libs
(`numpy`+`Pillow`+`opencv`, target <300 MB installed; measure the managed runtime before
release). A Japanese aligner (roughly hundreds of MB to ~1 GB depending on provider)
and RIFE are optional until validated. Target **<1.5 GB for the complete recommended
native animation runtime**, excluding the already-existing SDXL and Chatterbox stacks.
Optional quality boosters **not on the render path**: ControlNet-SDXL (~2.5 GB, for
redraws), See-through auto-rig (~5-8 GB, one-time per character), Depth Anything V2
small (~100 MB, one-time per location). The existing anime SDXL checkpoint
(`waiIllustriousSDXL`, 6.5 GB) stays either way. **No 20-40 GB mandatory video model.**

---

## 10. Resource strategy (RTX 5070 Laptop, 8 GB VRAM, 32 GB RAM, Windows)

- The deterministic renderer is **CPU-first** (numpy/OpenCV) with an optional GPU
  raster path; it never holds a diffusion model resident. A 1-minute 1080p24 render is
  minutes of CPU, seconds on a modest GPU raster path.
- Redraws and TTS acquire the **existing `GpuExclusiveScheduler`** lease
  (`kind: 'visual'` / `'audio'`), run one at a time, release the model
  (`POST /free` to ComfyUI is already implemented), then the renderer runs GPU-free.
- Bounded queues and stale-revision fail-closed checks exist in
  `TemporalShotGenerationService` and `EpisodeRenderService` (`MAX_PENDING_*`). The
  native worker has a wall-clock cap and process-tree termination. **[implemented,
  M1]** `media_job_cancel` removes queued visual/reference/audio/temporal/anime/render
  jobs immediately. Running Chatterbox, native-anime, FramePack and FFmpeg work is
  marked `cancelled` only after its owned process tree exits; cancellation cannot
  commit a new ready Generation/Asset. Abort-aware GPU waiters preserve exclusive
  ordering. ComfyUI requests abort locally without killing the shared ComfyUI process.
- Never keep SDXL + aligner + renderer GPU state resident simultaneously — same rule
  as `ANIME_TEMPORAL_PIPELINE.md` §17, now much easier because the render step needs
  no model.

---

## 11. Realistic anime quality ceiling

**This does not automatically produce Kyoto Animation / ufotable / MAPPA / Madhouse
output. Claiming that would be unserious.** What it can and cannot do:

### Reproducible deterministically (high confidence)
- multiplane / parallax background camera moves (book shots, slow push-ins, pans)
- limited-animation dialogue: 3-8-shape mouth charts, discrete blinks, subtle head
  float, one-cycle breathing, micro weight shifts
- secondary follow-through on hair / cloth / accessories (with tuning)
- editing rhythm: reaction cuts, held emotional beats, hard cuts on pose changes
- perfect identity / wardrobe / palette continuity across every cut and every episode
- compositing polish: grain, bloom, diffusion filter, chromatic aberration, light
  rays, rain / snow / dust, colour grade, colour-script consistency

### Needs sparse generative redraw (medium confidence, cost amortized over a series)
- any pose / camera angle outside the rig's deformation domain
- new outfit states, injuries, held props
- extreme "sakuga face" expressions
- complex hand / object interaction, severe foreshortening
- new establishing compositions of a Location

### Human artistic judgement remains the limiting factor
- **appeal of the key poses** — the single biggest anime-quality lever, and it is the
  image model + Director's taste, not the engine
- layout / staging / composition choices
- timing charts — the *feel* of an action (ease amounts, snap, overshoot)
- knowing when a hold "lives" versus "dies"
- redraw art direction (does this corrective drawing match the show's line weight?)

### Technical innovations required to close the gap
1. a learned **rig-validity predictor** for precise automatic redraw escalation
2. **identity-preserving pose-conditioned redraw** (IPAdapter + ControlNet + explicit
   canonical-ref loss) proven not to drift
3. a **timing-chart language** for the Director (ease curves as first-class objects)
4. automatic **tail-frame continuity scoring** between a redraw and resumed rig anim
5. an **anime-cadence classifier** that picks on-2s / on-3s per element without
   duplicating frames

**Honest near-term target tier:** *well-directed streaming limited animation*
(a strong ONA / visual-novel adaptation look), not action-showcase TV anime.

---

## 12. Failure modes & open gaps

| Failure mode | Mitigation | Residual risk |
|---|---|---|
| Rig animation reads as "VTuber puppet" | keep motion density low in dialogue; cut on hard poses; redraw for turns | real; the reason C is load-bearing, not optional |
| Crude auto-split leaves face seams / duplicate features | accepted semantic open/closed eye and mouth states; See-through-class decomposition; reject on region-delta QC | observed in the vertical slice; current visual gate fails |
| Redraws drift off-model | low-denoise img2img from outfit layers + IPAdapter + canonical-ref; QC palette/landmark gate | needs ControlNet + tuning; not built |
| "Living hold" looks frozen | Verlet hair + breathing + blink cadence tuned per Series | calibration problem; must benchmark (§14) |
| Auto-rig (See-through) seams need cleanup | artist-in-the-loop per canonical character | one-time cost per character, acceptable |
| Forced alignment wrong on TTS artifacts | confidence gate + generic envelope fallback + human spot-check | subtle flap errors possible |
| Action shots underwhelm | short cuts + smears + held impact frames + B motion library | action ceiling ~64/100; documented, not hidden |
| **Subtitle burn-in / VTT / IMSC export not implemented** in `EpisodeRenderService` | add a deterministic subtitle render + sidecar exporter | **open gap — carried from `LOCALIZATION_SYNC_ARCHITECTURE.md` §21** |
| Biggest new codebase to own | phase it (A+C now, B later); lean on open primitives (RIFE, Depth Anything, torchaudio, See-through) | maintainability 50/100; real |

---

## 13. Roadmap

- **Milestone 0 — vertical slice [mechanically complete; visual gate failed]:** one rig (few layers) + one 2-plane
  environment + one Japanese line + eyeLook + blink + mouth flap + micro head motion +
  Verlet front hair + parallax push-in + burned Turkish subtitle -> one real 3-5 s
  1080p24 MP4, no video model. Inspect frames, measure storage/runtime, compare vs
  the old animated-still preview and vs the FramePack architecture.
- **Milestone 1 — control plane and compiler [implemented]:** strict CharacterRig,
  EnvironmentPackage, Alignment, QC and Acceptance contracts; graph-backed
  `planShotAnim()` / `buildShotAnimRequest()`; content-addressed ShotAnim Asset and
  Generation provenance; native provider request wiring; bounded Codex tools and job
  cancellation. The compiler accepts only current approved project-managed assets and
  fails closed on rig domain violations. Full production readiness remains `false`
  until the M2/M3/M4 builders and gates exist.
- **Milestone 2 — corrective redraw (C):** ControlNet-SDXL pose conditioning;
  `rig.poseLibrary` promotion; tail-frame continuity scoring; auto-escalation from QC.
- **Milestone 3 — subtitle layer:** deterministic Turkish subtitle render in
  `EpisodeRenderService` + WebVTT sidecar; reading-speed solver; forced-narrative for
  on-screen Japanese text.
- **Milestone 4 — motion retargeting (B) [code implemented; render proof GPU/human-gated]:**
  MotionClip schema; skeleton IK / FABRIK / foot-lock; a starter walk / turn / sit /
  reach / strike library. DWPose extraction and the two-character contact render proof
  stay GPU/human-gated (plan Task 9).
- **Milestone 5 — auto-rig + environment decomposition:** See-through integration for
  Character layers; Depth Anything V2 environment plate split; rig-validity predictor.
- **Milestone 6 — anime compositing + cadence:** full FX toolkit; on-2s/on-3s
  classifier; per-Series colour script enforcement; RIFE cadence pass.

### 13.1 M1 verification (2026-08-31)

- `makewatch_anime`: `production_status`, `shot_anim_plan`, `shot_anim_compile`.
- `makewatch_media`: `audio_provider`, `media_job_cancel` in addition to the existing
  reference and temporal tools. `anime` cancellation is an alias for a native-anime
  job owned by `TemporalShotGenerationService`.
- `ShotAnimCompilationService` persists `makewatch.shotAnim/1` by SHA-256 and attaches
  exact input Asset dependencies after a fresh Shot revision check. Read-only plans
  expose dependency IDs/revisions but never raw bytes or absolute paths.
- `server.mjs` injects the compiler request builder into the native provider path.
  The renderer may report ready when Python/FFmpeg are present, while the aggregate
  production status truthfully remains not ready.
- Fresh local gate: `verify.ps1` passed, including strict TypeScript, Studio production
  build, all bridge/runtime checks and **11/11 native tests**. Deterministic worker
  self-test passed twice with decoded-frame SHA prefix `29ca4625cf5535db` and zero
  persisted intermediate frames.
- Remaining M2 blockers: no production CharacterRig builder/decomposition, no
  EnvironmentPackage builder/depth split, and therefore no accepted semantic asset
  set for a real graph-authored Shot. M3 Japanese alignment/QC/corrective redraw and
  M4 one-minute acceptance are also not implemented.

### 13.2 Milestone 4 / M5 motion-retargeting code verification (2026-08-31)

Plan `docs/superpowers/plans/2026-08-31-native-anime-m5-motion-retargeting.md`,
Tasks 1-8 landed on `feat/native-anime-motion-engine`:

- `makewatch.motionClip/1` contract + deterministic 2D skeleton kinematics (FK,
  two-bone IK, FABRIK, foot-lock, COM), mirrored JS/Python from one fixture vector.
- `retargetMotionClip()` — bone-name correspondence, per-limb length scale, foot-lock
  IK during `footPlant` windows, COM-x preservation, `f`->`t` retiming, rig
  `validDomain` / `validDomain.combined` escalations, missing-bone -> `corrective_redraw`.
- `CharacterRig` gains an optional `skeleton` + limb `states` (`parentBone`,
  `restAngleDeg`); dialogue-only rigs still validate unchanged. Shared
  `bone-tree.mjs` keeps clip and rig skeletons from drifting.
- Hand-authored `walk` / `turn` / `sit` / `reach` / `strike` library (`PROVENANCE.md`);
  `MotionClipService` content-addresses clips and plans retargets against a promoted rig.
- `ShotAnim` carries `motion[]` + `layers[].bone`; the compiler retargets one promoted
  clip per character and emits bone curves, limb layers and domain escalations without
  touching head/eye/mouth/breathing/hair channels.
- `native-anime-worker.py` drives bone-parented limb layers through a per-frame FK
  chain (`bone_matrix`); a ShotAnim with no `motion` renders byte-identically to the
  pre-M5 path (decoded-frame SHA `29ca4625cf5535db`, verified pre/post).
- `makewatch_anime` Codex tools `motion_clip_list` + `motion_retarget_plan` (read-only)
  over `GET /api/anime/motion-clips` and
  `GET /api/anime/characters/:id/motion-plan?clipAssetId=…`.

Gate: `pnpm bridge:check` green; `anime:m5-check` / `anime:semantic-check` /
`anime:m3-check` green; `native-anime-worker-selftest.py` (base + motion scenarios)
passed with ffmpeg present. Not yet done: Task 9 — the GPU/human-reviewed
two-character contact-beat render, `verify.ps1` full pass, and `main` fast-forward.

---

## 14. Benchmark methodology (INVARIANTS #13)

Every "cheaper / faster / higher quality" claim must be backed by a run recorded under
`.makewatch/reports/`:

- **Storage:** bytes of *persistent* project growth for a fixed 60 s acceptance
  episode — new (rig, plates, redraws, JSON, audio, MP4) vs baseline animated-still
  vs (projected) FramePack per-shot MP4 set. Frame-cache peak measured and confirmed
  reclaimed to 0.
- **Runtime:** wall-clock per rendered second, split into (redraw GPU, TTS GPU,
  alignment, deterministic render, encode). Target: deterministic render + encode
  < 4 s per output second on CPU at 1080p24 for two characters; redraws counted
  separately and amortized.
- **VRAM:** peak during redraw / TTS; confirm renderer path holds no model.
- **Quality:** the `ONE_MINUTE_ANIME_ACCEPTANCE.md` rubric scored per Shot; plus
  mechanical checks (ffprobe duration / fps / black-frame / freeze) and dense frame
  extraction inspected visually.
- **Determinism:** render the same ShotAnim twice; assert bit-identical MP4 (or
  identical decoded-frame hashes if the encoder is nondeterministic).

---

## 15. Contracts (clean interfaces for the new engine)

```
buildShotAnimRequest(snapshot, shotId, options) -> {ShotAnim, inputAssetIds, compileReport}
NativeAnimeProvider implements { id:'native-anime', displayName, strategies:['I2V'],
                                 status(context) -> {installed, ready, busy, detail, runtime, hardware},
                                 generate(request, context) -> ArtifactDescriptor }   // same contract FramePack returns
native-anime-worker.py  --request <path>   ->  MW_TEMPORAL_RESULT_V1 <json>           // same worker protocol as FramePack
AlignmentProvider       { align(audioPath, transcript, language) -> AlignmentAsset }  // MFA | torchaudio | vad-fallback
CadenceEngine           { sampleParam(channel, tSeconds, fps) -> value }              // step/linear/ease/hold/snap-on-N
DeformSolver            { solve(rig, paramVector) -> deformed layer meshes }
VerletChain             { step(dt, rootTransform) -> segment positions }              // fixed dt, fixed K, deterministic
EnvironmentCompositor   { frame(package, camera, lighting, weather, t) -> RGBA plate stack }
```

The provider contract and worker stdout protocol (`MW_TEMPORAL_RESULT_V1\t<json>`) are
identical to FramePack's, so `server.mjs` registers both. The current temporal service
still takes an exclusive GPU scheduler lease even for the CPU-first renderer; resource
classification remains an optimization milestone now that the compiler is wired.

```js
new TemporalProviderRegistry()
  .register(new NativeAnimeProvider({ projectRoot, workerPath }))
  .register(new FramePackTemporalProvider({ projectRoot, workerPath }));   // optional, off unless models present
```

Default Shot metadata selects `native-anime`. The server connects the ShotAnim compiler
and never falls back to an animated still. Aggregate `production_status.ready` remains
false until CharacterRig/EnvironmentPackage builders, Japanese Alignment, QC and the
one-minute acceptance runner are operational.

---

## 16. Research anchors (as of 2026-08-30)

### 2D rig / deformation
- Inochi2D — open (BSD-2) real-time 2D puppet standard; layered art -> runtime
  parameter-driven mesh deformation + physics + masking; Inox2D (Rust) + inochi2d-c
  reimplementations. Architectural reference for the **open, provider-neutral rig
  representation**. https://inochi2d.com/ · https://docs.inochi2d.com/
- Live2D Cubism deformer model (warp deformer = Bezier-divided lattice; rotation
  deformer; parent rotation + child warp for necks) — idiom reference only, no
  dependency. https://docs.live2d.com/en/cubism-editor-manual/deformer/
- "Image Deformation Using Moving Least Squares" (SIGGRAPH 2006); "Locally controlled
  as-rigid-as-possible deformation for 2D characters" (CAVW 2017); "Topology-aware
  moving least square deformation for 2D characters" — math for skeleton/point/cage
  handle deformation with shape preservation.

### Layer decomposition / depth
- **See-through: Single-image Layer Decomposition for Anime Characters** (SIGGRAPH
  2026, Apache-2.0) — one anime image -> up to 23 semantic layers (front/back hair,
  face, eyes L/R, clothing, accessories) + per-layer depth + inpainted occlusions;
  8 GB path via NF4, ~2-3 min/image; ComfyUI plugin `jtydhr88/ComfyUI-See-through`.
  https://github.com/shitagaki-lab/see-through
- Depth Anything V2 (small ~100 MB) — anime-usable relative depth for environment
  plate splitting / micro-parallax. https://depth-anything-v2.github.io/

### Frame interpolation
- Practical-RIFE 4.25 (MIT, ~tens of MB; older repository models include anime-tuned variants) —
  cadence smoothing between **valid** rendered poses only.
  https://github.com/hzwer/Practical-RIFE

### Forced alignment (Japanese)
- Montreal Forced Aligner 3.x — Japanese tokenizer/G2P/acoustic model ecosystem;
  boundary accuracy must be benchmarked on Make & Watch dialogue before selection.
  https://github.com/MontrealCorpusTools/Montreal-Forced-Aligner
- WhisperX — JA + TR alignment models, word-level ms timestamps.
  https://github.com/m-bain/whisperX
- torchaudio CTC forced-alignment API (`MMS_FA`) — lightest local path, runs in the
  existing ComfyUI torch env.

### What we are deliberately NOT doing
- FramePack / Wan 2.2 / HunyuanVideo / LTX-2 / CogVideoX as a **mandatory** provider.
- SadTalker / EchoMimic / MuseTalk / Wav2Lip talking-head models — they solve
  photoreal portrait lip-sync, produce a "talking head" not authored anime, and are
  another heavy dependency. The stylized mouth-chart approach is deliberate.

---

## 17. Relationship to existing documents

- `ANIME_TEMPORAL_PIPELINE.md` §16 ("FramePack role"), §5.2 / §23 Phase C — FramePack is
  now *optional*, not "the current local temporal foundation." The premium-quality
  goals in that document still stand; the path to them is this engine.
- `MEDIA_PIPELINE.md` "Current temporal provider" / "Resource policy for the 8 GB
  class" — the temporal provider is `native-anime`; FramePack is a fallback.
- `LOCALIZATION_SYNC_ARCHITECTURE.md` — unchanged and authoritative for DialogueUnit,
  Alignment asset shape, lip-vs-subtitle timing separation, subtitle QC. This engine
  *consumes* that contract; it does not fork it.
- `ONE_MINUTE_ANIME_ACCEPTANCE.md` — the acceptance gate is unchanged in spirit
  ("every final Shot is real temporal video, no animated-still fallback"). A
  `native-anime` MP4 **is** real temporal video (deterministic 2D animation, streamed
  frames, real motion) — it is explicitly *not* a looped still, Ken Burns, or
  frozen-frame pad. The gate's "FLF2V only if a validated provider exists" clause now
  also covers "heavy I2V diffusion only if a validated provider exists."
- `INVARIANTS.md` #3 ("no provider owns the architecture") — this engine is itself an
  adapter behind the temporal contract; the graph, not the engine, is truth.
