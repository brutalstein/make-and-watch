# Native Anime M2 Semantic Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, validate and explicitly promote reusable CharacterRig and EnvironmentPackage assets that remove the face seams and flat-background limitations of the 4-second proof.

**Architecture:** Treat accepted Character and Location reference Assets as immutable source material. Assemble generated or artist-supplied semantic states into content-addressed draft packages, validate them in isolated deterministic workers, and link only passing packages to their Character or Location. Keep generation separate from canonical promotion.

**Tech Stack:** Node.js ESM, Python/Pillow/OpenCV worker protocol, existing ComfyUI reference service, native project bridge, JSON Assets, FFmpeg contact sheets, assert-based checks.

**Spec:** `docs/superpowers/specs/2026-08-30-codex-native-anime-control-plane-design.md`

**Requires:** M1 compiler/control-plane commit and a green `verify.ps1`.

## Global Constraints

- A build creates a draft; only `*_validate({ promote: true })` may establish continuity.
- Every source must be a graph Asset with a verified SHA-256 and a path below `.makewatch`.
- `face_base` may not contain baked eyes or a baked mouth in a passing dialogue rig.
- The first representation is registered state sprites plus bounded affine transforms; do not label it mesh warping.
- No automatic destructive inpainting of canonical reference art.
- Reuse packages by content hash across Episodes; never copy the package into every Episode.
- Visual evidence is mandatory for promotion.

## File Structure

- Create `tools/anime/semantic-package-contract.mjs`: normalized build/validation input contracts and safe managed-path resolution.
- Create `tools/anime/semantic-package-contract-check.mjs`: invalid source, duplicate state and traversal checks.
- Create `tools/anime/character-rig-service.mjs`: Character plan/build/validate/promotion lifecycle.
- Create `tools/anime/character-rig-service-check.mjs`: graph provenance, revision race, draft and promotion checks.
- Create `tools/anime/environment-package-service.mjs`: Location plan/build/validate/promotion lifecycle.
- Create `tools/anime/environment-package-service-check.mjs`: plate registration, safe bounds and promotion checks.
- Create `tools/anime/semantic-package-worker.py`: deterministic alpha, registration, palette and parallax validation plus contact-sheet rendering.
- Create `tools/anime/semantic-package-worker-selftest.py`: deterministic worker protocol fixtures.
- Modify `tools/director/anime-production-tools.mjs`: route the six semantic-package tools.
- Modify `tools/director/anime-production-tools-check.mjs`: verify schemas and routing.
- Modify `tools/generation/gateway-api-client.mjs` and `tools/generation/server.mjs`: bounded plan/build/validate endpoints.
- Modify `tools/anime/shot-anim-compiler.mjs`: resolve only promoted compatible packages.
- Modify `package.json`: add all deterministic checks.
- Modify `project_brain/NATIVE_ANIME_MOTION_ENGINE.md` and `project_brain/DEVELOPMENT_LOG.md`: record measured M2 state.

---

### Task 1: Semantic package input contract

**Files:**
- Create: `tools/anime/semantic-package-contract.mjs`
- Create: `tools/anime/semantic-package-contract-check.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `normalizeCharacterRigBuildInput(value)` and `normalizeEnvironmentPackageBuildInput(value)`.
- Produces: `resolveManagedSourceAsset(snapshot, projectRoot, assetId, expectedMediaType)`.
- Consumes: M1 `validateCharacterRig` and `validateEnvironmentPackage`.

- [ ] **Step 1: Write failing normalization checks**

```js
import assert from 'node:assert/strict';
import { normalizeCharacterRigBuildInput } from './semantic-package-contract.mjs';

const input = normalizeCharacterRigBuildInput({
  characterId: 'character.aya',
  expectedRevision: 7,
  outfitState: 'school-uniform',
  states: [
    { id: 'face_base', sourceAssetId: 'asset.face', pivot: [0.5, 0.55], z: 10 },
    { id: 'eye_l.OPEN', sourceAssetId: 'asset.eye-open', pivot: [0.4, 0.4], z: 20 },
  ],
});
assert.equal(input.states[0].id, 'face_base');
assert.throws(() => normalizeCharacterRigBuildInput({ ...input, states: [input.states[0], input.states[0]] }), /duplicate state/i);
assert.throws(() => normalizeCharacterRigBuildInput({ ...input, expectedRevision: -1 }), /revision/i);
```

- [ ] **Step 2: Run the check and confirm module-not-found**

Run: `node tools/anime/semantic-package-contract-check.mjs`
Expected: FAIL because the contract module does not exist.

- [ ] **Step 3: Implement strict normalization and source resolution**

Reject unknown semantic state IDs, duplicate IDs, non-finite pivots/z/depth, unsafe relative paths, wrong media types, missing hashes and files outside `.makewatch`. Cap state/plate counts and source byte sizes using named exported limits.

- [ ] **Step 4: Re-run the focused check**

Run: `node tools/anime/semantic-package-contract-check.mjs`
Expected: `semantic package contract check: passed`.

- [ ] **Step 5: Commit**

```text
feat(anime): validate semantic package inputs
```

---

### Task 2: Deterministic semantic-package QC worker

**Files:**
- Create: `tools/anime/semantic-package-worker.py`
- Create: `tools/anime/semantic-package-worker-selftest.py`
- Modify: `package.json`

**Worker operations:**
- `character`: alpha occupancy/halo, state bounds, eye/mouth registration, face-base exclusion masks, palette distance and parameter-domain samples.
- `environment`: equal canvas registration, opaque coverage, normalized depth ordering, occlusion-mask dimensions, camera-safe bounds and parallax exposure.
- Both: emit JSON findings and a deterministic PNG contact sheet; never mutate sources.

- [ ] **Step 1: Add failing protocol fixtures**

Generate tiny synthetic RGBA fixtures in a temporary directory. Assert that a registered eye-state set passes, a baked-eye `face_base` fails, mismatched plate sizes fail, and identical inputs produce byte-identical JSON apart from the caller-supplied output path.

- [ ] **Step 2: Run the self-test**

Run: `python tools/anime/semantic-package-worker-selftest.py`
Expected: FAIL because the worker does not exist.

- [ ] **Step 3: Implement bounded validation and contact sheets**

Use image dimensions and alpha masks, not filenames, as evidence. Keep thresholds in the request and echo their resolved values into the report. Return non-zero only for protocol/runtime failure; represent QC failure as `{ "passed": false, "findings": [...] }`.

- [ ] **Step 4: Verify determinism**

Run: `python tools/anime/semantic-package-worker-selftest.py`
Expected: `semantic package worker self-test: passed`.

- [ ] **Step 5: Commit**

```text
feat(anime): add semantic package visual checks
```

---

### Task 3: CharacterRig lifecycle

**Files:**
- Create: `tools/anime/character-rig-service.mjs`
- Create: `tools/anime/character-rig-service-check.mjs`
- Modify: `tools/anime/shot-anim-compiler.mjs`

**Interfaces:**
- `plan({ characterId, outfitState }) -> { reusableRigs, sourceAssets, requiredStates, missingStates, blockers }`.
- `build({ characterId, expectedRevision, outfitState, states, validDomains }) -> { job }`.
- `validate({ rigAssetId, expectedCharacterRevision, promote }) -> { reportAssetId, passed, promoted }`.

- [ ] **Step 1: Write service checks with an in-memory bridge**

```js
const plan = await service.plan({ characterId: 'character.aya', outfitState: 'school-uniform' });
assert.deepEqual(plan.missingStates.sort(), ['mouth.A', 'mouth.CLOSED']);

const built = await service.build(validBuildInput);
assert.equal(built.job.status, 'queued');
await service.waitForIdle();
assert.equal(service.job(built.job.id).status, 'completed');
assert.equal(snapshot.nodes.find((n) => n.id === builtAssetId).approval, 'draft');

const validated = await service.validate({ rigAssetId: builtAssetId, expectedCharacterRevision: 7, promote: true });
assert.equal(validated.passed, true);
assert.equal(validated.promoted, true);
assert.ok(snapshot.dependencies.some((e) => e.dependent === 'character.aya' && e.dependency === builtAssetId));
```

Also cover missing required mouth/eye states, stale Character revision, locked Character, failed seam QC, hash collision, cancellation and a build that never promotes itself.

- [ ] **Step 2: Confirm the tests fail**

Run: `node tools/anime/character-rig-service-check.mjs`
Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement plan and draft build**

Copy no raster data. Persist one normalized `makewatch.characterRig/1` JSON Asset whose state entries reference source Asset IDs/hashes. Attach Character, all source Assets and the Generation node as dependencies. Use the shared GPU scheduler only when a build request explicitly asks the existing reference generator to create missing state art.

- [ ] **Step 4: Implement validation and explicit promotion**

Invoke the QC worker, persist its contact sheet and report as draft Assets, re-read revisions, then add the passing rig dependency and `characterRigAssetIds` metadata to the Character. A failed report remains inspectable but never changes canonical continuity.

- [ ] **Step 5: Make compilation reject draft/incompatible rigs**

Require the selected CharacterRig dependency to be approved, match Character revision/outfit and cover all parameters used by the Shot. Report a `corrective_redraw` blocker for out-of-domain poses.

- [ ] **Step 6: Re-run focused checks**

Run: `node tools/anime/character-rig-service-check.mjs && node tools/anime/shot-anim-compiler-check.mjs`
Expected: both checks pass.

- [ ] **Step 7: Commit**

```text
feat(anime): manage reusable character rigs
```

---

### Task 4: EnvironmentPackage lifecycle

**Files:**
- Create: `tools/anime/environment-package-service.mjs`
- Create: `tools/anime/environment-package-service-check.mjs`
- Modify: `tools/anime/shot-anim-compiler.mjs`

**Interfaces:**
- `plan({ locationId, stateId }) -> { reusablePackages, sourceAssets, requiredPlates, missingPlates, blockers }`.
- `build({ locationId, expectedRevision, stateId, plates, cameraSafeBounds }) -> { job }`.
- `validate({ packageAssetId, expectedLocationRevision, promote }) -> { reportAssetId, passed, promoted }`.

- [ ] **Step 1: Write failing lifecycle checks**

Cover a valid background/midground/foreground package, mismatched plate canvases, missing occlusion mask, invalid depth ordering, stale/locked Location and explicit promotion.

- [ ] **Step 2: Run the check**

Run: `node tools/anime/environment-package-service-check.mjs`
Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement draft assembly and validation**

Persist only JSON references to content-addressed plate Assets. Store camera-safe bounds, normalized depth, lighting/weather state and source hashes. Generate the contact sheet from worker output and apply the same revision-before/after discipline as CharacterRig.

- [ ] **Step 4: Add compiler selection**

Resolve one promoted package matching Location revision and requested lighting/weather state. Reject unsafe camera motion whose parallax exposes transparent canvas regions.

- [ ] **Step 5: Verify focused checks**

Run: `node tools/anime/environment-package-service-check.mjs && node tools/anime/shot-anim-compiler-check.mjs`
Expected: both checks pass.

- [ ] **Step 6: Commit**

```text
feat(anime): manage reusable location packages
```

---

### Task 5: Expose all six M2 operations to Codex

**Files:**
- Modify: `tools/director/anime-production-tools.mjs`
- Modify: `tools/director/anime-production-tools-check.mjs`
- Modify: `tools/generation/gateway-api-client.mjs`
- Modify: `tools/generation/server.mjs`

- [ ] **Step 1: Extend routing tests**

Add schema and dispatch coverage for `character_rig_plan`, `character_rig_build`, `character_rig_validate`, `location_package_plan`, `location_package_build` and `location_package_validate`. Assert that build/promote inputs require explicit target revision fields.

- [ ] **Step 2: Confirm new cases fail**

Run: `node tools/director/anime-production-tools-check.mjs`
Expected: FAIL on the first missing M2 route.

- [ ] **Step 3: Add bounded server routes and client methods**

Return public job/report views only. Map stable service error codes to existing gateway HTTP categories. Do not accept absolute artifact paths or raw image bytes through these tools.

- [ ] **Step 4: Verify tool count and dispatch**

Run: `node tools/director/anime-production-tools-check.mjs && node tools/director/makewatch-tool-runtime-check.mjs`
Expected: M1+M2 tool inventory and every route pass.

- [ ] **Step 5: Commit**

```text
feat(director): expose semantic anime assets
```

---

### Task 6: Product-machine semantic asset proof

**Files:**
- Create during run: `.makewatch/reports/native-anime-m2/` artifacts only.
- Modify after evidence: `project_brain/NATIVE_ANIME_MOTION_ENGINE.md`
- Modify after evidence: `project_brain/DEVELOPMENT_LOG.md`

- [ ] **Step 1: Run readiness and source-asset plans through the Codex tools**

Use one existing anime Character reference and one existing Location reference. Record the exact source Asset IDs, hashes and graph revisions.

- [ ] **Step 2: Generate only missing semantic art**

Use `reference_generate` for each missing clean state; do not crop the previous face and inpaint underneath it. Build the CharacterRig and EnvironmentPackage as drafts.

- [ ] **Step 3: Validate and inspect contact sheets**

Open both contact sheets at full resolution. Reject duplicate facial features, alpha halos, line-weight shifts, background plate misregistration or unsafe parallax edges. Promote only if deterministic QC and human inspection both pass.

- [ ] **Step 4: Compile the existing 4-second Shot against promoted packages**

Run the M1 compiler and native renderer. Extract frames at 0.5 s, blink midpoint, two mouth poses and maximum head turn. Compare directly with `.makewatch/reports/native-anime-slice/slice.mp4`.

- [ ] **Step 5: Record truthful measured results**

Document hashes, persistent bytes, render runtime and remaining visual defects. If either package fails, record M2 infrastructure complete but product proof failed; do not promote or claim the seam defect is fixed.

- [ ] **Step 6: Run full verification and refresh the knowledge graph**

Run: `powershell -ExecutionPolicy Bypass -File .\verify.ps1`
Expected: all checks pass.

Run: `graphify update .`
Expected: graph refresh completes without errors.

- [ ] **Step 7: Commit measured documentation and graph changes intentionally**

```text
docs(anime): record semantic asset proof
```

- [ ] **Step 8: Update `main` safely**

Fetch `origin`, verify the recorded remote-main SHA has not changed, fast-forward local `main` to the verified M2 HEAD, rerun `verify.ps1` on that exact HEAD, then push `main`. Stop on divergence; never force-push. Preserve `.serena/`, `pnpm-lock.yaml` and unrelated user files.
