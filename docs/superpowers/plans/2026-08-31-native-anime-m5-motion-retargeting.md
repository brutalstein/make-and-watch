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

- [ ] **Step 1: Checks** — a dialogue-only rig (no skeleton) still validates. A rig with `skeleton.bones` + limb states (`semanticPart` in the pose-part set, `parentBone`, `restAngleDeg`) validates; a limb state whose `parentBone` is not in the skeleton fails; a skeleton with a cycle fails; `validDomain.combined` rules now parsed, not skipped.
- [ ] **Step 2: Implement** the additive optional block on `validateCharacterRig` and `normalizeCharacterRigBuildInput`; `requiredStateIds()` unchanged (limbs optional). Persist skeleton + limb states in the built rig JSON.
- [ ] **Step 3: Verify** focused rig checks + `anime:semantic-check`.
- [ ] **Step 4: Commit** `feat(anime): rig carries an optional skeleton`.

---

### Task 4: Motion retarget

**Files:** Create `tools/anime/motion-retarget.mjs`, `-check.mjs`.

**Interface:** `retargetMotionClip({ clip, targetRig, options }) -> { boneCurves, events, rootMotion, domainEscalations }`.

- [ ] **Step 1: Checks** — bone-name correspondence maps source→target; per-limb length scale applied; a target missing a source bone drops that channel and records a `missing_bone` note; a retargeted frame outside `targetRig.validDomain` produces a `domainEscalations[{ frame, channel, value }]` entry; foot-lock keeps a planted ankle within tol of its plant position across the plant window; identical inputs → identical output.
- [ ] **Step 2: Implement** using the Task 2 JS kinematics: sample every clip frame, map bone rotations, scale translations by limb-length ratio, run foot-lock IK during `footPlant` windows, preserve COM x, convert `f` frames to `t` seconds at the ShotAnim fps, emit step/linear bone curves.
- [ ] **Step 3: Verify** — `node tools/anime/motion-retarget-check.mjs`.
- [ ] **Step 4: Commit** `feat(anime): retarget motion clips onto rigs`.

---

### Task 5: MotionClip asset service + starter library

**Files:** Create `tools/anime/motion-clip-service.mjs`, `-check.mjs`, `tools/anime/motion-library/{walk,turn,sit,reach,strike}.json`, `tools/anime/motion-library/PROVENANCE.md`.

- [ ] **Step 1: Checks** — `register` persists a content-addressed `makewatch.motionClip/1` asset (draft), attaches Generation provenance, no raster copy; `list` returns library + registered clips; `retargetPlan({ clipAssetId, characterId })` reports covered/missing bones and any domain escalation without writing state; stale rig revision and lock are rejected; duplicate content hash is idempotent.
- [ ] **Step 2: Author** the five starter clips by hand (short, loopable where sensible), each with a `PROVENANCE.md` line stating it is hand-authored, not motion-captured.
- [ ] **Step 3: Implement** the service on the M2 job/bridge pattern (`plan`/`register`/`validate`); validate every clip through `validateMotionClip` on load.
- [ ] **Step 4: Verify** — `node tools/anime/motion-clip-service-check.mjs`.
- [ ] **Step 5: Commit** `feat(anime): manage reusable motion clips`.

---

### Task 6: ShotAnim + compiler wiring

**Files:** Modify `tools/anime/native-anime-contract.mjs`, `-check.mjs`, `tools/anime/shot-anim-compiler.mjs`, `-check.mjs`.

- [ ] **Step 1: Checks** — a Shot with `character.motion.motionClipAssetId` compiles to a ShotAnim carrying baked bone curves + events; a draft (unpromoted) clip is rejected; a clip needing a bone the rig lacks yields a `corrective_redraw` blocker naming the frame; dialogue/eye/mouth channels are unchanged alongside motion.
- [ ] **Step 2: Implement** resolution of one promoted `MotionClip` per character, retarget via Task 4, merge bone curves into the per-character curve set, surface `domainEscalations` as compiler `correctiveKeys` + issues.
- [ ] **Step 3: Verify** — `node tools/anime/shot-anim-compiler-check.mjs && npm run anime:semantic-check`.
- [ ] **Step 4: Commit** `feat(anime): compile shots with retargeted motion`.

---

### Task 7: Worker bone-chain FK

**Files:** Modify `tools/anime/native-anime-worker.py`, `-selftest.py`; modify `package.json`; `scripts/verify.ps1`.

- [ ] **Step 1: Selftest** — a synthetic rig with `spine/hip/thigh_l/shin_l/foot_l` bone-parented limb layers + a short retargeted clip renders a deterministic MP4; decoded-frame SHA stable across two runs; a skeleton-less rig renders byte-identically to the pre-M5 path.
- [ ] **Step 2: Implement** the FK bone chain in the per-layer transform stack: each limb layer resolves `M_bone` = product of parent-bone rotations about bone heads, inserted between `M_camera` and the existing local deform. Reuse `tools/anime/skeleton-kinematics.py`. Head-group / plates unchanged.
- [ ] **Step 3: Verify** — `python tools/anime/native-anime-worker-selftest.py` twice; `anime:m5-check`.
- [ ] **Step 4: Commit** `feat(anime): render retargeted limb motion`.

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
