# Native Anime M5 Motion Retargeting (B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans, task-by-task. Steps use `- [ ]`.

**Goal:** Give the deterministic engine real full-body action — walk, turn, reach, sit, and staged two-character contact beats (a strike, a grab) — by retargeting reusable skeletal `MotionClip` performances onto `CharacterRig` skeletons, with foot-lock IK and centre-of-mass preservation, and escalating any pose outside a rig's valid domain to a corrective redraw instead of folding the mesh.

**Architecture:** `MotionClip` is provider-neutral skeletal JSON (bone-rotation channels + param channels + contact/impact events), authored by hand, by a procedural generator, or (later) by DWPose extraction. Retargeting maps a source skeleton to a target `CharacterRig` skeleton by bone-name correspondence + limb-length scale + COM preservation + foot-lock IK, and bakes frame-aligned bone-rotation curves into the `ShotAnim`. The native worker gains a 2D forward-kinematic bone chain in its per-layer transform stack (§4.1 of `NATIVE_ANIME_MOTION_ENGINE.md`); limb layers are parented to bones. Nothing here loads a model; DWPose extraction and sakuga redraw art stay GPU-gated and explicit.

**Spec:** `project_brain/NATIVE_ANIME_MOTION_ENGINE.md` §3.1, §4.1, §6, §8.1. Maps to that doc's roadmap "Milestone 4 — motion retargeting (B)".

**Requires:** M1 + M2 committed. A rig-skeleton extension (Task 3) is additive and does not migrate the native C++ schema.

## Global Constraints

- `MotionClip` and retarget output are pure deterministic JSON; identical inputs produce byte-identical bone curves.
- Retargeting never invents limb geometry the target rig lacks; a missing `semanticPart`/bone for a required pose is a `corrective_redraw` blocker, not a guess.
- Foot-lock only pins a foot during an explicit `footPlant` event window; it never freezes a foot across the whole clip.
- Bone-rotation curves stay a separate channel group from the existing head/eye/mouth/breathing/hair curves; retargeting must not touch those.
- A clip whose retargeted param vector leaves `rig.validDomain` at frame `f` emits a redraw escalation at `f`; the engine cuts or crossfades per M3 policy.
- Two-character contact uses one shared `ShotAnim` camera and per-character retargeted clips aligned on a named `contact` event; no physical collision solver.
- Starter library clips are hand-authored and reviewed; no clip is promoted to cross-Episode canon from an unreviewed generator.

## File Structure

- Create `tools/anime/motion-clip-contract.mjs` + `-check.mjs`: `makewatch.motionClip/1` normalize/validate.
- Create `tools/anime/skeleton-kinematics.py` + `-selftest.py`: 2D FK chain, two-bone analytic IK, FABRIK, foot-lock, COM — pure numpy.
- Create `tools/anime/skeleton-kinematics.mjs` + `-check.mjs`: the same math in JS for compile-time retargeting/validation (kept in lockstep with the Python by a shared fixture vector).
- Create `tools/anime/motion-retarget.mjs` + `-check.mjs`: `retargetMotionClip(clip, sourceSkeleton, targetRigSkeleton, options)` → frame-aligned bone-rotation curves + events + domain escalations.
- Modify `tools/anime/native-anime-asset-contracts.mjs` + `-check.mjs`: optional `skeleton` + limb `states` (`parentBone`, `restAngleDeg`) on `CharacterRig`; `validateMotionClip` export.
- Modify `tools/anime/character-rig-service.mjs` + `-check.mjs`: accept/persist an optional skeleton + limb states; still valid with none (dialogue-only rig).
- Create `tools/anime/motion-clip-service.mjs` + `-check.mjs`: register/list hand-authored `MotionClip` JSON as content-addressed assets; plan a retarget against a promoted rig.
- Modify `tools/anime/native-anime-contract.mjs` + `-check.mjs`: `characters[].motion { motionClipAssetId, timeScale, loop, alignEvent, screenAnchor }`.
- Modify `tools/anime/shot-anim-compiler.mjs` + `-check.mjs`: resolve one promoted `MotionClip` per character, retarget to the rig skeleton, emit bone curves + `correctiveKeys` escalation, keep dialogue/eye/mouth channels intact.
- Modify `tools/anime/native-anime-worker.py` + `-selftest.py`: apply the bone-chain FK transform to bone-parented limb layers; unchanged for skeleton-less rigs.
- Create `tools/anime/motion-library/*.json`: starter `walk`, `turn`, `sit`, `reach`, `strike` clips + a `PROVENANCE.md` note.
- Modify `tools/director/anime-production-tools.mjs` + `-check.mjs`: `motion_clip_list`, `motion_retarget_plan`.
- Modify `tools/generation/gateway-api-client.mjs`, `tools/generation/server.mjs`: bounded endpoints.
- Modify `package.json`: `anime:m5-check`; wire into `scripts/verify.ps1`.
- Modify `project_brain/NATIVE_ANIME_MOTION_ENGINE.md`, `project_brain/DEVELOPMENT_LOG.md`: measured M5 state.

---

### Task 1: MotionClip contract

**Files:** Create `tools/anime/motion-clip-contract.mjs`, `tools/anime/motion-clip-contract-check.mjs`; modify `package.json`.

**Interface:** `validateMotionClip(value)`, `normalizeMotionClipInput(value)`, `motionClipLimits`.

`makewatch.motionClip/1`:
```jsonc
{
  "schema": "makewatch.motionClip/1",
  "clipId": "walk.neutral.loop",
  "fps": 24,
  "frameCount": 24,
  "loopable": true,
  "skeleton": { "bones": [ { "id": "root", "parent": null, "rest": { "x": 0, "y": 0, "rot": 0, "len": 0 } },
                           { "id": "hip", "parent": "root", "rest": { "x": 0, "y": -4, "rot": 0, "len": 40 } } ] },
  "channels": {
    "bone": { "hip": [ { "f": 0, "deg": 0 }, { "f": 12, "deg": 3, "ease": "easeInOut" } ],
              "thigh_l": [ { "f": 0, "deg": -18 } ] },
    "param": { "breathing": [ { "f": 0, "v": 0.0 } ] }
  },
  "events": [ { "f": 0, "kind": "footPlant", "bone": "foot_l" },
              { "f": 12, "kind": "footPlant", "bone": "foot_r" },
              { "f": 8, "kind": "contact", "bone": "hand_r" } ],
  "rootMotion": [ { "f": 0, "x": 0, "y": 0 }, { "f": 23, "x": 62, "y": 0 } ]
}
```

- [ ] **Step 1: Write failing checks** — a valid walk clip normalizes; assert: unknown bone in `channels.bone`, non-monotonic keyframe `f`, `f` outside `0..frameCount-1`, duplicate bone ids, a `root` bone with a non-null parent, an event bone absent from the skeleton, `fps` outside 1..120, `frameCount` outside 1..2048, and byte-identical normalization for identical input.
- [ ] **Step 2: Run** `node tools/anime/motion-clip-contract-check.mjs` — FAIL (module missing).
- [ ] **Step 3: Implement** strict normalization: integer frames only, sorted non-overlapping keys per channel, bone tree acyclic with exactly one root, events reference real bones, `rootMotion` optional and monotonic in `f`. Reuse `semanticPart` vocabulary for bone ids where they double as layer parents. Freeze output.
- [ ] **Step 4: Verify** — `motion clip contract check: passed`.
- [ ] **Step 5: Commit** `feat(anime): define MotionClip contract`.

---

### Task 2: 2D skeleton kinematics core

**Files:** Create `tools/anime/skeleton-kinematics.mjs`, `-check.mjs`, `tools/anime/skeleton-kinematics.py`, `-selftest.py`; modify `package.json`.

- [ ] **Step 1: Shared fixture** — one skeleton + one target end-effector in `tools/anime/skeleton-kinematics-fixture.json`; both language checks assert the same solved joint positions to 1e-6.
- [ ] **Step 2: Failing checks** — FK: a 3-bone chain at known angles resolves to hand-computed world joints. Two-bone IK: reachable target hits within tol; unreachable target extends straight at max length. FABRIK: 4-bone chain converges under `K` iterations, each segment length preserved. Foot-lock: given a planted foot world position, the hip is adjusted so the ankle stays pinned while the knee stays valid. COM: scaling limb lengths keeps the projected COM x within tol.
- [ ] **Step 3: Implement** both modules from the same equations (§4.1, §4.3). Fixed iteration counts; no randomness. JS module used by the compiler; Python module used by the worker.
- [ ] **Step 4: Verify** — `node tools/anime/skeleton-kinematics-check.mjs && python tools/anime/skeleton-kinematics-selftest.py`.
- [ ] **Step 5: Commit** `feat(anime): add deterministic 2D skeleton IK`.

---

### Task 3: CharacterRig skeleton + limb extension

**Files:** Modify `tools/anime/native-anime-asset-contracts.mjs`, `-check.mjs`, `tools/anime/semantic-package-contract.mjs`, `tools/anime/character-rig-service.mjs`, `-check.mjs`.

- [x] **Step 1: Checks** — dialogue-only rig (no skeleton) still validates (`skeleton: null`, `validDomainCombined: []`). A rig with `skeleton.bones` + limb states (`parentBone`, `restAngleDeg`) validates; `parentBone` not in the skeleton fails; `parentBone` with no skeleton fails; a cyclic skeleton fails; `validDomain.combined` rules parsed into `validDomainCombined` (both the asset contract and `normalizeCharacterRigBuildInput`).
- [x] **Step 2: Implement** — new shared `tools/anime/bone-tree.mjs` `normalizeBoneTree` (also now backs `MotionClip.skeleton`, so clip and rig skeletons cannot drift). Additive optional block on `validateCharacterRig` + `normalizeCharacterRigBuildInput`; `requiredStateIds()` unchanged. `character-rig-service.#run` threads `skeleton`/`parentBone`/`restAngleDeg`/`validDomainCombined` into the built rig JSON.
- [x] **Step 3: Verify** — `anime:semantic-check` + `anime:m5-check` + shot-anim compiler/provider checks all green.
- [x] **Step 4: Commit** `feat(anime): rig carries an optional skeleton`.

---

### Task 4: Motion retarget

**Files:** Create `tools/anime/motion-retarget.mjs`, `-check.mjs`.

**Interface:** `retargetMotionClip({ clip, targetRig, options }) -> { boneCurves, events, rootMotion, domainEscalations }`.

- [x] **Step 1: Checks** — bone-name correspondence maps source→target; per-limb length scale applied; a target missing a source bone drops that channel and records a `missing_bone` note; a retargeted frame outside `targetRig.validDomain` produces a `domainEscalations[{ frame, channel, value }]` entry; foot-lock keeps a planted ankle within tol of its plant position across the plant window; identical inputs → identical output. Also: `validDomain.combined` rules parsed; `event_bone_dropped` note; `timeScale` retimes uniformly.
- [x] **Step 2: Implement** using the Task 2 JS kinematics: sample every clip frame, map bone rotations, scale translations by limb-length ratio, run foot-lock IK during `footPlant` windows, preserve COM x, convert `f` frames to `t` seconds at the ShotAnim fps, emit step/linear bone curves. Output also carries `paramCurves` (face/eye/mouth channels pass through untouched) and `notes`.
- [x] **Step 3: Verify** — `node tools/anime/motion-retarget-check.mjs` → `motion retarget check: passed`; `pnpm anime:m5-check` green.
- [x] **Step 4: Commit** `feat(anime): retarget motion clips onto rigs`.

---

### Task 5: MotionClip asset service + starter library

**Files:** Create `tools/anime/motion-clip-service.mjs`, `-check.mjs`, `tools/anime/motion-library/{walk,turn,sit,reach,strike}.json`, `tools/anime/motion-library/PROVENANCE.md`.

- [x] **Step 1: Checks** — `register` persists a content-addressed `makewatch.motionClip/1` asset (draft) with `handAuthored` Generation provenance, no raster; `list` returns library + registered; `retargetPlan({ clipAssetId, characterId })` reports covered/missing bones + `domainEscalationCount` and writes nothing; a clip needing a bone the rig lacks sets `correctiveRedrawRequired`; stale `expectedCharacterRevision` and a locked Character are rejected; a skeleton-less rig is rejected; duplicate content hash is idempotent (`created:false`).
- [x] **Step 2: Author** `walk` (loop), `turn`, `sit`, `reach`, `strike` — hand-keyed bone rotations, `PROVENANCE.md` states each is hand-authored, not mocap/DWPose.
- [x] **Step 3: Implement** `MotionClipService` (`plan`/`list`/`register`/`retargetPlan`/`validate`) — synchronous register (no GPU, no job queue); every library clip runs through `validateMotionClip` on load. Also fixed `normalizeRootMotion` to round-trip an empty `[]` (was rejecting its own output).
- [x] **Step 4: Verify** — `node tools/anime/motion-clip-service-check.mjs` → passed; `anime:m5-check` green.
- [x] **Step 5: Commit** `feat(anime): manage reusable motion clips`.

---

### Task 6: ShotAnim + compiler wiring

**Files:** Modify `tools/anime/native-anime-contract.mjs`, `-check.mjs`, `tools/anime/shot-anim-compiler.mjs`, `-check.mjs`.

- [x] **Step 1: Checks** — `native-anime-contract-check`: a ShotAnim `motion[]` block (skeleton + `boneCurves` + events + rootMotion) validates, an out-of-skeleton bone curve / cyclic skeleton / unknown event kind are rejected, `layers[].bone` carried. `shot-anim-compiler-check`: a Shot with `characterMotion` compiles to a ShotAnim carrying baked bone curves + `contact` event + a bone-parented limb layer, dialogue/eyes/mouth intact; a `draft` clip → `unapproved_asset`; a clip driving a bone the rig lacks → `motion_bone_missing` blocker `corrective_redraw`.
- [x] **Step 2: Implement** — `validateShotAnim` gains `motion` + `layers[].bone` (via shared `normalizeBoneTree`). `planShotAnim` parses `shot.metadata.characterMotion` `{characterId:{motionClipAssetId,timeScale?,loop?,screenAnchor?}}`, resolves each promoted clip through `assetIssue` (draft/stale rejected), retargets via Task 4, and raises `corrective_redraw` issues for `missing_bone` notes and (when no correctiveKeys) the first `domainEscalation`; `motion_clip_too_long` guards over-length clips. `buildShotAnimRequest` emits the `motion[]` block + limb layers; head/body/eye/mouth layers and `actingCurves` untouched.
- [x] **Step 3: Verify** — `shot-anim-compiler-check` + `native-anime-contract-check` + `anime:semantic-check` + provider/compilation-service checks green.
- [x] **Step 4: Commit** `feat(anime): compile shots with retargeted motion`.

---

### Task 7: Worker bone-chain FK

**Files:** Modify `tools/anime/native-anime-worker.py`, `-selftest.py`; modify `package.json`. Deviations: also touched `native-anime-contract.mjs` + `shot-anim-compiler.mjs` (skeleton units → canvas pixels needs a `pixelsPerUnit` on each `motion` entry; the compiler derives it from the rig rest-pose height when unset). `scripts/verify.ps1` unchanged — the ffmpeg/numpy/cv2-dependent `native-anime-worker-selftest.py` stays a manual run; `anime:m5-check` gained only the worker AST-parse (matches the existing `bridge:check` guard).

- [x] **Step 1: Selftest** — `motion_shot` adds `char.hero.thigh`/`char.hero.shin` bone-parented layers + a hand-authored `motion` entry (thigh 0→32°, shin 0→-24°, root x drift); renders twice → identical `framesSha256`; a flat-curve variant renders a different hash (bone rotation actually moves pixels); the pre-existing skeleton-less render is byte-identical pre/post-M5 (`29ca4625…`, verified via `git stash`).
- [x] **Step 2: Implement** — `build_motion_index` precomputes rest FK + screen placement per `motion` entry; per frame, `forward_kinematics(skeleton, sampled bone degs)` → `frame_joints`; each limb layer (`layer["motion"] is not None`) uses `bone_matrix` (shift authored head → FK head + root motion, rotate about head by world-angle delta) as its `local`, skipping the head-group/plate dispatch. `M = place @ local` unchanged. Reuses `skeleton-kinematics.py` via the existing `runpy` load.
- [x] **Step 3: Verify** — `python tools/anime/native-anime-worker-selftest.py` (both scenarios passed); `pnpm anime:m5-check` green; contract/compiler/provider/compilation-service + `anime:semantic-check` + `anime:m3-check` green.
- [x] **Step 4: Commit** `feat(anime): render retargeted limb motion`.

---

### Task 8: Codex tools + endpoints

**Files:** Modify `tools/director/anime-production-tools.mjs`, `-check.mjs`, `tools/generation/gateway-api-client.mjs`, `tools/generation/server.mjs`.

- [ ] **Step 1: Checks** — `motion_clip_list`, `motion_retarget_plan` schemas (`additionalProperties:false`, retarget requires `characterId` + `clipAssetId`), dispatch, gateway pathnames.
- [ ] **Step 2: Implement** deferred tools + runtime methods + client methods + bounded `GET /anime/motion-clips`, `GET /anime/characters/:id/motion-plan` routes.
- [ ] **Step 3: Verify** — `node tools/director/anime-production-tools-check.mjs && node tools/director/makewatch-tool-runtime-check.mjs`.
- [ ] **Step 4: Commit** `feat(director): expose motion retargeting tools`.

---

### Task 9: Product-machine action proof — [GPU / human gated]

- [ ] Author or DWPose-extract one `strike` and one `reach` clip; register and review.
- [ ] Build two dialogue+limb CharacterRigs (needs M2 Task 6 art), promote.
- [ ] Compile and render a 3-shot contact beat (windup / thrust / follow-through) at `native-anime`; hard cut on the `contact` frame.
- [ ] Run `shot_qc`; where the domain report names a pose, generate one corrective key, review, register, recompile.
- [ ] Watch with audio; record timestamped limb-stretch, foot-slide, identity, contact-read and cut-timing defects.
- [ ] Record wall time split (retarget / render / redraw) and confirm frame cache returns to zero.
- [ ] `verify.ps1` + `graphify update .`; commit `docs(anime): record action retargeting proof`; fast-forward `main` only on an unchanged recorded remote SHA.
