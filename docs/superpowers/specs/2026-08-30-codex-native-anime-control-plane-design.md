# Codex-Native Anime Production Control Plane

Date: 2026-08-30

Status: approved design; implementation not started

Primary acceptance target: one 52–68 second anime episode

Long-term target: episodic 20-minute production without a mandatory video diffusion model

## 1. Purpose

Make every important Make & Watch production operation available to Codex through
typed, bounded tools while preserving the native project graph as the sole project
authority. Use those tools to produce and inspect a real one-minute anime acceptance
episode before attempting a 20-minute episode.

“Full authority” means Codex may author project state, start expensive generation,
promote accepted assets, render Shots and Episodes, run QC, cancel jobs, and inspect
artifacts. It does not mean bypassing revisions, locks, resource admission,
provenance, output validation, or visual acceptance.

## 2. Scope

This initiative contains four deliverables:

1. a complete, curated Codex production tool surface;
2. a validated semantic CharacterRig and reusable Location package foundation;
3. native graph to ShotAnim compilation with real Japanese dialogue timing;
4. one fully rendered, visually inspected, 52–68 second acceptance Episode.

It also establishes the storage, queue, cache and composition boundaries needed to
scale the same representation to 20 minutes. It does not render a 20-minute Episode
in this initiative.

## 3. Non-goals

- Do not expose arbitrary shell or filesystem execution as project truth.
- Do not turn every internal helper into a Codex tool.
- Do not add a single opaque `anime_produce` mega-tool.
- Do not generate 24 diffusion images per second.
- Do not make FramePack or another large video model mandatory.
- Do not call a technically valid MP4 “anime quality” when visual inspection fails.
- Do not promote generated art into canonical continuity without QC acceptance.

## 4. Existing tool inventory

Codex currently receives 27 typed production tools.

### `makewatch` — 18 tools

`project_snapshot`, `project_query`, `project_history`, `project_impact`,
`project_apply`, `workflow_new`, `workflow_save`, `workflow_list`, `workflow_load`,
`workflow_delete`, `production_schema`, `generation_provider`, `scene_generate`,
`audio_generate`, `episode_compose`, `episode_render`, `generation_job`, and
`generation_jobs`.

### `makewatch_media` — 9 tools

`reference_provider`, `reference_generate`, `reference_job`, `reference_jobs`,
`temporal_providers`, `shot_temporal_plan`, `shot_generate_video`, `temporal_job`, and
`temporal_jobs`.

These already cover authoritative graph mutation, canonical reference generation,
hero-image generation, Chatterbox generation, provider inspection, temporal jobs,
composition and final render. New tools must reuse these operations rather than
duplicate them.

## 5. Tool-surface decision

Add one typed namespace, `makewatch_anime`, and fill two concrete gaps in the existing
media surface.

### 5.1 Existing namespace additions

| Tool | Mode | Purpose |
|---|---|---|
| `audio_provider` | read | Report real Chatterbox installation, model and supported languages. The gateway endpoint already exists. |
| `media_job_cancel` | write | Cancel a queued or running reference, audio, temporal, anime or render job. Cancellation must terminate owned workers and leave no graph success record. |

### 5.2 New `makewatch_anime` tools

| Tool | Mode | Purpose |
|---|---|---|
| `production_status` | read | One readiness report for rig, Location package, Japanese audio, alignment, ShotAnim compiler, renderer, QC and acceptance runner. |
| `character_rig_plan` | read | Resolve a Character, outfit state and canonical references; report reusable states and missing semantic art. |
| `character_rig_build` | expensive write | Generate or derive candidate semantic layers/states. Creates draft Generation/Asset provenance only. |
| `character_rig_validate` | read/write | Validate topology, semantic coverage, alpha seams, state registration and valid deformation domain; optionally promote a passing rig. |
| `location_package_plan` | read | Resolve a Location and report existing plates/depth/occlusion states and missing inputs. |
| `location_package_build` | expensive write | Build draft reusable background, midground, foreground, depth and occlusion assets. |
| `location_package_validate` | read/write | Validate registration, parallax-safe bounds and separation; optionally promote a passing package. |
| `dialogue_align` | expensive write | Align an existing Japanese Audio Asset to its DialogueUnit transcript and create a content-addressed Alignment Asset. |
| `shot_anim_plan` | read | Compile a diagnostic plan from the native graph without rendering; list exact rig, Location, audio, alignment and corrective-key dependencies. |
| `shot_anim_compile` | write | Materialize a validated, content-addressed ShotAnim JSON Asset tied to exact input revisions and hashes. |
| `shot_qc` | read/write | Run deterministic structural and rendered-frame QC; persist a QC report and optionally promote a passing Shot Asset. |
| `corrective_redraw` | expensive write | Generate one draft pose-conditioned corrective drawing for a specified failed time/pose; never redraw a whole Shot. |
| `episode_acceptance_plan` | read | Evaluate the one-minute acceptance specification and return all blockers without starting generation. |
| `episode_acceptance_run` | expensive write | Run the bounded existing jobs needed for a ready Episode, stop on any failed gate, render the final MP4, and persist an Acceptance Report. |

The existing `shot_generate_video` remains the render entry point. Once
`shot_anim_compile` is wired, calling it with `providerId: "native-anime"` consumes
the compiled ShotAnim. No duplicate `shot_generate_native` tool is added.

## 6. Authority and safety model

All write tools must:

1. read a fresh native graph snapshot;
2. require or capture the expected project and target revisions;
3. reject locked, stale, missing or conflicting inputs;
4. write generated bytes only under the project-managed `.makewatch` root;
5. hash outputs before graph mutation;
6. create/update Generation and content-addressed Asset nodes through the bridge;
7. attach every input Asset as a dependency;
8. re-read target revisions before final commit;
9. commit success only after media/JSON probing and QC;
10. clean scratch data on success, failure and cancellation.

Canonical promotion is an explicit flag on validation/QC tools. Generation tools can
only create draft candidates. Project locks and native revision checks remain stronger
than Codex authority.

## 7. Durable data contracts

Structured payloads remain versioned JSON Assets so no premature C++ NodeKind
migration is required.

### 7.1 CharacterRig v1

Schema: `makewatch.characterRig/1`

Required semantic coverage for the first dialogue rig:

- `body` or `torso`;
- `face_base` without baked eyes or mouth;
- `eyes_l` and `eyes_r`, each with `OPEN`, `HALF`, and `CLOSED` accepted states;
- `mouth` states `CLOSED`, `SMALL`, `A`, `I`, `U`, `E`, `O`, and `WIDE`;
- `front_hair` and `rear_hair` or a documented single-hair fallback;
- pivots, z-order, masks, parent attachments and valid parameter domains;
- source Asset hashes, outfit state, Character revision and palette fingerprint.

The first implementation may use state sprites plus affine deformation. It must not
claim a full mesh/warp-grid rig until that representation is implemented and tested.

### 7.2 EnvironmentPackage v1

Schema: `makewatch.environmentPackage/1`

Required first-slice coverage:

- background, midground and foreground plates;
- normalized parallax depth for each plate;
- camera-safe bounds;
- foreground occlusion mask;
- Location revision and source hashes;
- lighting/weather state identifiers.

### 7.3 Alignment v1

Schema: `makewatch.alignment/1`

Contains DialogueUnit ID, Japanese transcript, Audio Asset ID/hash, provider/version,
normalization rules, timed mora/phoneme tokens, speech bounds, confidence and warning
list. Proxy tones and hand-authored timings are forbidden in acceptance output.

### 7.4 ShotAnim v1

The existing `makewatch.shotAnim/1` renderer contract remains authoritative. The new
compiler adds a compile report containing resolved node revisions, Asset IDs/hashes,
rig valid-domain result, audio/alignment binding, subtitle cues and redraw blockers.

### 7.5 QC and acceptance reports

- `makewatch.animeQcReport/1` records deterministic checks, sampled frame evidence,
  thresholds, failures and promotion decision.
- `makewatch.animeAcceptanceReport/1` records every acceptance gate, job/artifact IDs,
  runtime/storage measurements, watch-through defects and final pass/fail.

## 8. Production data flow

```text
Codex Director
  -> inspect production_status + production_schema
  -> author Series/Episode/Scene/Shot/DialogueUnit graph
  -> reference_generate Character and Location canon
  -> character_rig_plan/build/validate
  -> location_package_plan/build/validate
  -> audio_generate Japanese DialogueUnit
  -> dialogue_align
  -> shot_anim_plan
  -> corrective_redraw only for reported invalid domains
  -> shot_anim_compile
  -> shot_generate_video(providerId = native-anime)
  -> shot_qc; promote only on pass
  -> episode_compose
  -> episode_render
  -> episode_acceptance_run + human visual inspection
```

Each failed step returns a specific blocker. Codex repairs only the smallest invalid
dependency and resumes from that boundary.

## 9. Graph to ShotAnim compiler

`buildShotAnimRequest(snapshot, shotId, options)` is a sibling of
`buildTemporalShotRequest`.

It must resolve exactly one Scene and:

- the Shot duration, cadence, framing, camera and acting metadata;
- one accepted CharacterRig for every visible Character/outfit state;
- one accepted EnvironmentPackage for the Location;
- accepted pose/corrective-key Assets;
- Japanese Audio and Alignment Assets for each DialogueUnit;
- Turkish subtitle text and independent readable cue timing;
- deterministic seed, render dimensions and renderer limits.

Compilation fails when a required semantic state is absent, an Asset is stale, an
alignment does not match the Audio hash, or the requested pose exceeds the rig domain
without a corrective key. The provider must never synthesize a hero-image living hold.

Once the compiler exists and its runtime dependencies pass, `native-anime` may report
`ready: true`. Readiness means the production path is connected, not that every Shot
is individually renderable.

## 10. Japanese performance

The existing Chatterbox worker supplies real `ja` audio. `audio_provider` must expose
that capability before Codex starts work.

Alignment is provider-neutral. The first selected provider must be measured on the
actual Chatterbox Japanese output and must produce deterministic Alignment JSON for
the same audio/transcript. A VAD/envelope fallback may preview mouth motion but cannot
pass the one-minute acceptance gate.

Mouth shapes are discrete anime states derived from aligned Japanese timing. Blink,
gaze, brows, breathing and head motion remain Director-authored channels. Turkish
subtitle timing derives from the same DialogueUnit but is not forced to mouth closure.

## 11. Character quality and corrective redraw

The rejected 4-second proof demonstrated that elliptical extraction and face
inpainting create visible seams. The production rig builder therefore treats clean
semantic eye/mouth/face states as an acceptance prerequisite.

Minimum rig QC:

- no duplicate baked eyes or mouth in `face_base`;
- no alpha halo or inpaint seam above threshold;
- open/half/closed eye states remain registered independently;
- every mouth state preserves face palette and line weight;
- no layer includes unrelated face regions;
- requested parameter samples remain inside the declared valid domain.

If a valid pose cannot be represented, `corrective_redraw` creates one draft drawing
conditioned by canonical Character, outfit, pose, camera and previous accepted state.
It becomes reusable only after QC promotion.

## 12. One-minute acceptance execution

The existing `ONE_MINUTE_ANIME_ACCEPTANCE.md` remains the normative gate. The runner
does not replace its criteria; it evaluates and records them.

Required terminal evidence includes:

- 52–68 second final Episode MP4 at 24 fps;
- multiple editorial Shots, not one continuous puppet take;
- real Chatterbox Japanese dialogue and matching Alignment Assets;
- Turkish subtitle timing;
- stable recurring Character and Location identity;
- accepted rig states plus corrective keys where required;
- zero persisted intermediate frames after completion;
- per-Shot QC reports and a complete Episode composition;
- storage/runtime/VRAM measurements;
- extracted frames/contact sheets and an explicit human watch-through result.

A technically valid MP4 with puppet motion, face seams, proxy audio, missing subtitle
timing, or unreviewed critical/major visual defects is a failed acceptance run.

## 13. Twenty-minute readiness without a twenty-minute render

The one-minute path must use the same Episode/Scene/Shot contracts intended for 20
minutes. Infrastructure readiness is demonstrated by:

- bounded Shot jobs and cancellation;
- content-addressed cross-Episode CharacterRig/Location reuse;
- no frame-count-proportional persistent raster storage;
- resumable composition from accepted Shot MP4s;
- per-Shot retry instead of full-Episode regeneration;
- final Episode streaming/concat and explicit retention policy;
- queue and artifact budgets expressed per Shot and per Episode.

No artificial 20-minute duration flag or monolithic worker is introduced.

## 14. Error handling and cancellation

Errors use stable categories: `invalid_argument`, `not_found`, `not_ready`, `busy`,
`stale_request`, `locked`, `qc_failed`, `cancelled`, `timeout`, `provider_error`, and
`conflict`.

Cancellation semantics:

- queued job: remove it and mark `cancelled`;
- running owned process: cooperative stop, then bounded process-tree termination;
- generated but uncommitted bytes: delete them;
- committed draft candidate: retain it with explicit provenance; never erase project
  truth silently;
- no Generation or Asset may report `ready` after cancellation.

## 15. Verification strategy

Implementation follows test-first slices:

1. schema/contract checks for every JSON Asset and tool input;
2. compiler fixtures covering success, missing/stale/locked inputs and hash mismatch;
3. tool-runtime routing tests for every new tool;
4. cancellation tests for queued and running jobs;
5. deterministic worker self-test and FFprobe validation;
6. integration fixture from graph snapshot to persisted Generation/Asset provenance;
7. product-machine Japanese audio/alignment smoke test;
8. CharacterRig visual contact-sheet QC;
9. one-minute real-user acceptance run and watch-through.

`verify.ps1` must remain green after every milestone. Heavy local model inference is a
product-machine gate and is reported separately from deterministic CI.

## 16. Milestones and commit boundaries

### M1 — control plane and compiler foundation

- add missing status/cancellation APIs and typed tools;
- add versioned rig, Location, Alignment, QC and acceptance contracts;
- implement graph to ShotAnim planning/compilation;
- make `native-anime` ready only through the connected compiler path.

### M2 — semantic reusable assets

- implement CharacterRig and Location plan/build/validate services;
- produce a seam-free dialogue rig and parallax-safe Location package;
- expose both through `makewatch_anime`.

### M3 — Japanese performance and Shot QC

- generate real Chatterbox Japanese audio;
- integrate and measure an Alignment provider;
- compile/render/QC multiple production Shots;
- add corrective redraw at failed rig-domain moments.

### M4 — one-minute acceptance

- author and generate the 52–68 second mini Episode;
- compose/render/inspect it;
- persist the acceptance report and repair critical/major defects until pass or a
  truthful external/artistic blocker is demonstrated.

Each milestone gets focused tests, a full verification run and a separate commit.
After verification, local `main` is fast-forwarded and pushed to `origin/main` only if
the remote still matches the expected base. Remote divergence stops the push for
reconciliation; force-push is forbidden.

## 17. Success criteria

This initiative is complete only when:

- Codex can perform all four deliverables through typed project tools;
- the provider/tool/graph path contains no undocumented manual step;
- the one-minute final MP4 passes the existing acceptance gate and human visual
  inspection;
- every artifact has deterministic project-managed provenance;
- scratch frame storage returns to zero;
- full local verification passes on the exact committed HEAD;
- verified commits are present on `origin/main` without rewriting history.

If the visual gate does not pass, the infrastructure may be complete but this
initiative remains incomplete and the report must name the concrete defects.
