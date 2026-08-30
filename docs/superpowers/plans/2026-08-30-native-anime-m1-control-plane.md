# Native Anime M1 Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the native project graph to validated ShotAnim programs and expose the production compiler, readiness, audio status and cancellation through typed Codex tools.

**Architecture:** Add small versioned JSON-asset validators, a pure graph-to-ShotAnim compiler, and a persistence service. Reuse the existing generation gateway, temporal registry and Director namespaces; add only the missing production operations. The native provider becomes ready only when the compiler is injected by the server.

**Tech Stack:** Node.js ESM, Python worker protocol, native project bridge, JSON Assets, FFmpeg/ffprobe, existing assert-based checks.

**Spec:** `docs/superpowers/specs/2026-08-30-codex-native-anime-control-plane-design.md`

## Global Constraints

- The native graph is authoritative; files alone never establish project truth.
- Every mutation requires fresh revision checks and content-addressed provenance.
- Generated files stay below `.makewatch`; path traversal is rejected.
- No hero-image living-hold fallback.
- No mandatory video diffusion runtime.
- Keep existing 27 tools backward compatible.
- `verify.ps1` must pass on the exact committed HEAD.
- Push only by fast-forward after checking the remote main SHA; never force-push.

## File Structure

- Create `tools/anime/native-anime-asset-contracts.mjs`: validators for CharacterRig, EnvironmentPackage, Alignment, QC and Acceptance JSON Assets.
- Create `tools/anime/native-anime-asset-contracts-check.mjs`: contract regression checks.
- Create `tools/anime/shot-anim-compiler.mjs`: pure graph/Asset resolution and ShotAnim planning/compilation.
- Create `tools/anime/shot-anim-compiler-check.mjs`: compiler fixtures and fail-closed cases.
- Create `tools/anime/shot-anim-compilation-service.mjs`: persist compiled ShotAnim bytes and graph provenance.
- Create `tools/anime/shot-anim-compilation-service-check.mjs`: persistence and revision-race checks.
- Create `tools/director/anime-production-tools.mjs`: `makewatch_anime` specs and routing for M1 operations.
- Create `tools/director/anime-production-tools-check.mjs`: schema/routing checks.
- Modify `tools/generation/temporal-shot-generation-service.mjs`: inject a provider request builder and attach compiled ShotAnim/input dependencies.
- Modify `tools/generation/native` registration in `tools/generation/server.mjs`: inject compiler and enable production readiness.
- Modify `tools/generation/gateway-api-client.mjs`: compiler/status/cancellation client methods.
- Modify `tools/director/makewatch-tool-runtime.mjs`: register `makewatch_anime` and `audio_provider`/`media_job_cancel` routes.
- Modify job services under `tools/generation/`, `tools/audio/`, and `tools/composition/`: shared cancellation semantics without changing completed artifacts.
- Modify `package.json`: run all new checks in `bridge:check`.
- Modify `project_brain/NATIVE_ANIME_MOTION_ENGINE.md` and `DEVELOPMENT_LOG.md`: record implemented M1 truth only.

---

### Task 1: Versioned anime asset validators

**Files:**
- Create: `tools/anime/native-anime-asset-contracts.mjs`
- Create: `tools/anime/native-anime-asset-contracts-check.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `validateCharacterRig(value)`, `validateEnvironmentPackage(value)`, `validateAlignmentAsset(value)`, `validateAnimeQcReport(value)`, `validateAnimeAcceptanceReport(value)`.
- Produces: `nativeAnimeAssetSchemas` with the five exact schema identifiers.

- [ ] **Step 1: Write failing contract checks**

```js
import assert from 'node:assert/strict';
import {
  validateAlignmentAsset,
  validateCharacterRig,
  validateEnvironmentPackage,
} from './native-anime-asset-contracts.mjs';

assert.equal(validateCharacterRig(validRig).schema, 'makewatch.characterRig/1');
assert.equal(validateEnvironmentPackage(validLocation).plates.length, 3);
assert.equal(validateAlignmentAsset(validAlignment).audioSha256, 'a'.repeat(64));
assert.throws(() => validateCharacterRig({ ...validRig, states: [] }), /semantic states/);
assert.throws(() => validateAlignmentAsset({ ...validAlignment, audioSha256: 'bad' }), /SHA-256/);
```

- [ ] **Step 2: Run the check and confirm the missing-module failure**

Run: `node tools/anime/native-anime-asset-contracts-check.mjs`
Expected: FAIL with module-not-found for `native-anime-asset-contracts.mjs`.

- [ ] **Step 3: Implement strict minimal validators**

Use finite-number helpers and project-relative path validation already established in
`native-anime-contract.mjs`. Require unique semantic state IDs, required eye/mouth
states, three Location plate roles, 64-character lowercase hashes, sorted positive
alignment timings and schema-specific size bounds. Return normalized frozen objects.

- [ ] **Step 4: Run contract and syntax checks**

Run: `node tools/anime/native-anime-asset-contracts-check.mjs`
Expected: `native anime asset contract checks passed`.

Run: `node --check tools/anime/native-anime-asset-contracts.mjs`
Expected: exit 0.

- [ ] **Step 5: Add the check to `bridge:check` and commit**

```bash
git add package.json tools/anime/native-anime-asset-contracts.mjs tools/anime/native-anime-asset-contracts-check.mjs
git commit -m "feat(anime): validate production asset contracts"
```

### Task 2: Pure graph-to-ShotAnim planner/compiler

**Files:**
- Create: `tools/anime/shot-anim-compiler.mjs`
- Create: `tools/anime/shot-anim-compiler-check.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: the validators from Task 1 and `validateShotAnim(value)`.
- Produces: `planShotAnim(snapshot, shotId, { projectRoot, readFile }) -> Promise<ShotAnimPlan>`.
- Produces: `buildShotAnimRequest(snapshot, shotId, options) -> Promise<{ shotAnim, inputAssetIds, compileReport }>`.

- [ ] **Step 1: Write a failing ready-plan fixture**

Build a snapshot containing one Scene, Shot, Character, Location, Audio, CharacterRig
Asset, EnvironmentPackage Asset and Alignment Asset. Put JSON fixtures below a
temporary `.makewatch` root. Assert:

```js
const plan = await planShotAnim(snapshot, 'shot.1', { projectRoot: root });
assert.equal(plan.ready, true);
assert.deepEqual(plan.inputAssetIds.sort(), ['asset.alignment', 'asset.audio', 'asset.environment', 'asset.rig'].sort());

const compiled = await buildShotAnimRequest(snapshot, 'shot.1', { projectRoot: root });
assert.equal(compiled.shotAnim.schema, 'makewatch.shotAnim/1');
assert.equal(compiled.shotAnim.dialogue[0].language, 'ja');
```

Also assert explicit issues for a stale rig, audio-hash mismatch, missing CLOSED eye
state, missing Location package and a pose outside `validDomain` without a corrective
key.

- [ ] **Step 2: Run the compiler check and confirm failure**

Run: `node tools/anime/shot-anim-compiler-check.mjs`
Expected: FAIL because `planShotAnim` is not implemented.

- [ ] **Step 3: Implement graph and Asset resolution**

Parse these bounded metadata keys:

```js
const shotKeys = {
  characterRigAssetIds: 'JSON array of Asset IDs',
  environmentPackageAssetId: 'one Asset ID',
  dialogueAudioAssetIds: 'JSON object DialogueUnit ID -> Audio Asset ID',
  alignmentAssetIds: 'JSON object DialogueUnit ID -> Alignment Asset ID',
  actingCurves: 'bounded JSON object of channel keyframes',
  cameraKeyframes: 'bounded JSON array',
  correctiveKeyAssetIds: 'JSON array',
};
```

Resolve files only from Asset `relativePath` below `.makewatch`, verify bytes against
Asset `sha256`, validate the structured payload, and return issues rather than partial
animation. `buildShotAnimRequest` throws `not_ready` when `plan.ready` is false.

- [ ] **Step 4: Run red/green compiler checks**

Run: `node tools/anime/shot-anim-compiler-check.mjs`
Expected: `shot anim compiler checks passed`.

- [ ] **Step 5: Commit**

```bash
git add package.json tools/anime/shot-anim-compiler.mjs tools/anime/shot-anim-compiler-check.mjs
git commit -m "feat(anime): compile ShotAnim from project graph"
```

### Task 3: Persist compiled ShotAnim provenance

**Files:**
- Create: `tools/anime/shot-anim-compilation-service.mjs`
- Create: `tools/anime/shot-anim-compilation-service-check.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `buildShotAnimRequest` from Task 2.
- Produces: `ShotAnimCompilationService.plan(shotId)` and `ShotAnimCompilationService.compile(shotId)`.
- `compile` returns `{ generationNodeId, assetNodeId, relativePath, sha256, shotAnim, compileReport }`.

- [ ] **Step 1: Write a failing persistence test**

Use a fake bridge with stable snapshots and captured commands. Assert the service:

```js
const result = await service.compile('shot.1');
assert.match(result.assetNodeId, /^asset\.[a-f0-9]{24}$/);
assert.ok(commands.some((c) => c.node?.metadata?.schema === 'makewatch.shotAnim/1'));
assert.ok(commands.some((c) => c.type === 'dependency.add' && c.dependency === 'asset.rig'));
```

Change the Shot revision between compile and commit and assert `stale_request` with no
bridge apply.

- [ ] **Step 2: Run and confirm failure**

Run: `node tools/anime/shot-anim-compilation-service-check.mjs`
Expected: FAIL because the service module is missing.

- [ ] **Step 3: Implement atomic file/provenance commit**

Serialize normalized ShotAnim with `JSON.stringify(value, null, 2)`, hash exact UTF-8
bytes, write under `.makewatch/artifacts/anime/shot-anim/<shot>/<sha>.json`, then create
Generation and content-addressed Asset nodes. Re-read the Shot revision immediately
before bridge apply. On graph failure, retain no orphan temporary file.

- [ ] **Step 4: Run service checks**

Run: `node tools/anime/shot-anim-compilation-service-check.mjs`
Expected: `shot anim compilation service checks passed`.

- [ ] **Step 5: Commit**

```bash
git add package.json tools/anime/shot-anim-compilation-service.mjs tools/anime/shot-anim-compilation-service-check.mjs
git commit -m "feat(anime): persist compiled ShotAnim assets"
```

### Task 4: Connect compiler to temporal generation

**Files:**
- Modify: `tools/generation/temporal-shot-generation-service.mjs`
- Modify: `tools/generation/temporal-shot-generation-service-check.mjs`
- Modify: `tools/anime/native-anime-provider.mjs`
- Modify: `tools/anime/native-anime-provider-check.mjs`
- Modify: `tools/generation/server.mjs`

**Interfaces:**
- Consumes: `providerRequestBuilders[providerId]({ snapshot, request })` injected into `TemporalShotGenerationService`.
- Produces: native provider request containing `shotAnim` plus compiler input Asset dependencies.

- [ ] **Step 1: Extend the temporal service test first**

Inject:

```js
providerRequestBuilders: {
  'native-anime': async ({ request }) => ({
    request: { ...request, shotAnim },
    inputAssetIds: ['asset.rig', 'asset.environment', 'asset.alignment'],
  }),
},
```

Assert registry generation receives `shotAnim` and the Generation node depends on all
three additional Assets. Assert a builder error commits nothing.

- [ ] **Step 2: Run and observe the constructor/behavior failure**

Run: `node tools/generation/temporal-shot-generation-service-check.mjs`
Expected: FAIL because `providerRequestBuilders` is ignored.

- [ ] **Step 3: Implement the minimal provider request-builder hook**

Store a frozen plain object in the service. Immediately before registry generation,
call the selected builder with the fresh snapshot and base request. Use its returned
request and merge its Asset IDs into provenance dependencies.

- [ ] **Step 4: Wire the server and provider readiness**

In `server.mjs`, create a builder that calls Task 2's compiler. Construct
`NativeAnimeTemporalProvider` with `acceptsProductionRequests: true` only in this wired
server path. Keep the constructor default false so isolated/manual use stays
fail-closed.

- [ ] **Step 5: Run focused checks**

Run:

```powershell
node tools/generation/temporal-shot-generation-service-check.mjs
node tools/anime/native-anime-provider-check.mjs
node tools/generation/temporal-provider-registry-check.mjs
```

Expected: all three print passed messages.

- [ ] **Step 6: Commit**

```bash
git add tools/generation/temporal-shot-generation-service.mjs tools/generation/temporal-shot-generation-service-check.mjs tools/anime/native-anime-provider.mjs tools/anime/native-anime-provider-check.mjs tools/generation/server.mjs
git commit -m "feat(anime): wire native ShotAnim generation"
```

### Task 5: Expose M1 through Codex tools

**Files:**
- Create: `tools/director/anime-production-tools.mjs`
- Create: `tools/director/anime-production-tools-check.mjs`
- Modify: `tools/director/makewatch-tool-runtime.mjs`
- Modify: `tools/director/makewatch-tool-runtime-check.mjs`
- Modify: `tools/generation/gateway-api-client.mjs`
- Modify: `tools/generation/server.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces namespace `makewatch_anime` with `production_status`, `shot_anim_plan`, and `shot_anim_compile` in M1.
- Adds `audio_provider` to `makewatch_media`.

- [ ] **Step 1: Write tool schema/routing failures**

Assert exact JSON schemas: no additional properties, bounded `shotId`, and normalized
tool results. Route fixture calls and assert runtime method arguments.

```js
assert.deepEqual(names, ['production_status', 'shot_anim_plan', 'shot_anim_compile']);
assert.deepEqual(await call('shot_anim_plan', { shotId: 'shot.1' }), { ready: true });
```

- [ ] **Step 2: Run and confirm missing namespace failure**

Run: `node tools/director/anime-production-tools-check.mjs`
Expected: FAIL because the module is missing.

- [ ] **Step 3: Add gateway endpoints and client methods**

Add local-only routes:

```text
GET  /api/anime/status
GET  /api/anime/shots/:shotId/plan
POST /api/anime/shots/:shotId/compile
```

Return existing error envelopes and enforce current ID regexes/body bounds.

- [ ] **Step 4: Implement typed tools and runtime composition**

Append `animeProductionDynamicToolSpecs()` beside the two existing namespaces. Keep
the runtime dependency explicit; fail configuration when an M1 method is missing.

- [ ] **Step 5: Run tool/client checks**

Run:

```powershell
node tools/director/anime-production-tools-check.mjs
node tools/director/makewatch-tool-runtime-check.mjs
node --check tools/generation/gateway-api-client.mjs
node --check tools/generation/server.mjs
```

Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add package.json tools/director/anime-production-tools.mjs tools/director/anime-production-tools-check.mjs tools/director/makewatch-tool-runtime.mjs tools/director/makewatch-tool-runtime-check.mjs tools/generation/gateway-api-client.mjs tools/generation/server.mjs
git commit -m "feat(director): expose native anime tools"
```

### Task 6: Add bounded job cancellation

**Files:**
- Modify: `tools/generation/scene-generation-service.mjs` and its check.
- Modify: `tools/generation/anchor-reference-generation-service.mjs` and its check.
- Modify: `tools/audio/audio-generation-service.mjs` and its check or add `audio-generation-service-check.mjs`.
- Modify: `tools/generation/temporal-shot-generation-service.mjs` and its check.
- Modify: `tools/composition/episode-render-service.mjs` and its check.
- Modify: `tools/generation/server.mjs`.
- Modify: `tools/generation/gateway-api-client.mjs`.
- Modify: `tools/director/temporal-media-tools.mjs` and its check.

**Interfaces:**
- Each service produces `cancel(jobId) -> publicJob`.
- Worker runners accept an `AbortSignal` and terminate only their owned process tree.
- `media_job_cancel({ kind, jobId })` supports `visual`, `reference`, `audio`, `temporal`, `anime`, and `render`.

- [ ] **Step 1: Add queued/running cancellation tests before code**

For every service assert queued removal. For temporal/audio/render, run a blocking fake
worker, cancel it, and assert:

```js
assert.equal(service.get(job.id).status, 'cancelled');
assert.equal(applies.length, 0, 'cancelled job cannot commit success provenance');
```

- [ ] **Step 2: Run focused checks and record expected failures**

Run each modified `*-check.mjs`; each must fail on missing `cancel` before
implementation.

- [ ] **Step 3: Implement one shared status convention, not a shared base class**

Add `cancelled` to public job states. Queued cancellation removes the ID from pending.
Running cancellation aborts the owned operation. Existing finally blocks continue
queue pumping. A completed/failed/cancelled job returns unchanged.

- [ ] **Step 4: Add the gateway and `media_job_cancel` tool route**

Use `POST /api/jobs/:kind/:jobId/cancel`; validate `kind` against the six-value enum
and dispatch to the owning service.

- [ ] **Step 5: Run all cancellation and tool checks**

Expected: every modified service check passes and no cancelled fixture writes a ready
Generation/Asset.

- [ ] **Step 6: Commit**

```bash
git add tools/generation/scene-generation-service.mjs tools/generation/scene-generation-service-check.mjs
git add tools/generation/anchor-reference-generation-service.mjs tools/generation/anchor-reference-generation-service-check.mjs
git add tools/audio/audio-generation-service.mjs tools/audio/audio-generation-service-check.mjs
git add tools/generation/temporal-shot-generation-service.mjs tools/generation/temporal-shot-generation-service-check.mjs
git add tools/composition/episode-render-service.mjs tools/composition/episode-render-service-check.mjs
git add tools/generation/server.mjs tools/generation/gateway-api-client.mjs
git add tools/director/temporal-media-tools.mjs tools/director/temporal-media-tools-check.mjs
git commit -m "feat(runtime): cancel bounded media jobs"
```

### Task 7: M1 verification, documentation and main integration

**Files:**
- Modify: `project_brain/NATIVE_ANIME_MOTION_ENGINE.md`
- Modify: `project_brain/DEVELOPMENT_LOG.md`

**Interfaces:**
- Produces a truthful M1 status and exact local verification evidence.

- [ ] **Step 1: Run the full local gate**

Run: `.\verify.ps1`
Expected: quality gate passed; 11/11 or the then-current complete native test count
passed.

- [ ] **Step 2: Run the deterministic worker self-test**

Run: `python tools/anime/native-anime-worker-selftest.py`
Expected: two renders produce the same decoded-frame SHA-256.

- [ ] **Step 3: Update docs with implemented truth and remaining M2 blockers**

Record tool names, compiler readiness, cancellation semantics and focused/full test
evidence. Do not mark CharacterRig build, Japanese alignment, QC or one-minute
acceptance operational.

- [ ] **Step 4: Commit docs**

```bash
git add project_brain/NATIVE_ANIME_MOTION_ENGINE.md project_brain/DEVELOPMENT_LOG.md
git commit -m "docs(anime): record M1 production compiler"
```

- [ ] **Step 5: Refresh graph and verify exact HEAD**

Run:

```powershell
graphify update .
.\verify.ps1
git diff --check
git status --short
```

Expected: tests pass; only pre-existing untracked `.serena/`, `graphify-out/`, and
`pnpm-lock.yaml` remain.

- [ ] **Step 6: Fast-forward and push main safely**

```powershell
$featureHead = git rev-parse HEAD
git fetch origin main
$currentRemoteMain = git rev-parse origin/main
git merge-base --is-ancestor $currentRemoteMain $featureHead
if ($LASTEXITCODE -ne 0) { throw "origin/main diverged from the verified feature history; stop for reconciliation" }
git switch main
git merge --ff-only origin/main
git merge --ff-only $featureHead
if ((git rev-parse HEAD) -ne $featureHead) { throw "main did not reach the verified M1 commit" }
.\verify.ps1
git push origin main
git switch feat/native-anime-motion-engine
```

The ancestry check guarantees that the fetched remote main can fast-forward to the
verified feature commit. A concurrent remote update makes the normal push fail; stop
and reconcile without force-push.
