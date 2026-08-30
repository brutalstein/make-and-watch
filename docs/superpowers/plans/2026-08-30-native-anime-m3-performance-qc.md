# Native Anime M3 Japanese Performance and Shot QC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn real Chatterbox Japanese audio into authoritative mouth timing, render independent Turkish subtitle timing, detect invalid native animation, and create sparse corrective drawings only at failed moments.

**Architecture:** Put forced aligners behind one stable worker protocol and select the smallest provider that passes a measured Japanese corpus gate on the product machine. Store sample-index timing in immutable Alignment Assets. Derive discrete anime mouth states during ShotAnim compilation, keep subtitle cues independent, and gate promotion with deterministic plus visual Shot QC. Reuse the existing ComfyUI reference generator for one-frame corrective candidates.

**Tech Stack:** Node.js ESM, Python alignment worker, selected Japanese forced aligner, Chatterbox Multilingual V3, FFmpeg/ffprobe, Pillow/OpenCV, existing native renderer and ComfyUI service.

**Spec:** `docs/superpowers/specs/2026-08-30-codex-native-anime-control-plane-design.md`

**Requires:** Passing M1 and M2 commits with at least one promoted dialogue CharacterRig and one promoted EnvironmentPackage.

## Global Constraints

- The real generated WAV is the performance clock; estimated text duration and proxy tones cannot pass.
- Provider-specific tokens are normalized to integer sample ranges in `makewatch.alignment/1`.
- Low-confidence alignment blocks mouth compilation; envelope motion is preview-only.
- Mouth, blink, gaze, brows, head and breathing stay independent channels.
- Turkish subtitle cues share DialogueUnit identity but may outlast mouth closure.
- Corrective redraw emits one draft key drawing for one requested moment; it never generates a temporal clip.
- Shot promotion requires a passing QC Asset and explicit `promote: true`.

## File Structure

- Create `tools/audio/alignment-provider-contract.mjs`: stable provider request/result and confidence contract.
- Create `tools/audio/alignment-provider-contract-check.mjs`: provider normalization regressions.
- Create `tools/audio/japanese-alignment-worker.py`: bounded JSON-lines runtime adapter.
- Create `tools/audio/japanese-alignment-worker-selftest.py`: synthetic/provided-fixture protocol tests.
- Create `tools/audio/japanese-alignment-runtime-manager.mjs`: isolated runtime discovery/status/bootstrap without automatic large downloads.
- Create `tools/audio/japanese-alignment-runtime-manager-check.mjs`: status and explicit-install checks.
- Create `tools/audio/dialogue-alignment-service.mjs`: graph/audio/transcript resolution, jobs, persistence and provenance.
- Create `tools/audio/dialogue-alignment-service-check.mjs`: hashes, language, confidence, races and cancellation.
- Create `tools/composition/subtitle-timing.mjs`: deterministic Turkish segmentation and CPS solver.
- Create `tools/composition/subtitle-timing-check.mjs`: readability and independent-out-time checks.
- Modify `tools/composition/episode-render-service.mjs`: burn/export accepted subtitle cues using safe FFmpeg input generation.
- Modify `tools/composition/episode-render-service-check.mjs`: subtitle filter and WebVTT/SRT sidecar checks.
- Create `tools/anime/anime-shot-qc.mjs`: structural and media QC orchestration.
- Create `tools/anime/anime-shot-qc-check.mjs`: QC/promotion/failure cases.
- Create `tools/anime/anime-shot-qc-worker.py`: sampled-frame metrics and contact sheets.
- Create `tools/anime/anime-shot-qc-worker-selftest.py`: deterministic visual fixtures.
- Create `tools/anime/corrective-redraw-service.mjs`: bounded single-key ComfyUI request and draft provenance.
- Create `tools/anime/corrective-redraw-service-check.mjs`: pose/domain/reference/revision checks.
- Modify `tools/anime/shot-anim-compiler.mjs`: aligned mouth curves, subtitle cues and corrective-key resolution.
- Modify `tools/anime/native-anime-contract.mjs`: registered mouth-state layer inputs and sample-clock Alignment references.
- Modify `tools/anime/native-anime-contract-check.mjs`: mouth-state and Alignment compatibility cases.
- Modify `tools/anime/native-anime-worker.py`: render named mouth states and independent facial channels.
- Modify `tools/director/anime-production-tools.mjs`: route `dialogue_align`, `shot_qc`, `corrective_redraw`.
- Modify gateway client/server and `package.json`: endpoints and checks.
- Modify localization/anime/development documents with measured M3 truth.

---

### Task 1: Stable alignment-provider contract

**Files:**
- Create: `tools/audio/alignment-provider-contract.mjs`
- Create: `tools/audio/alignment-provider-contract-check.mjs`
- Modify: `package.json`

**Interfaces:**
- `normalizeAlignmentRequest({ audioPath, audioSha256, transcript, language, sampleRate })`.
- `normalizeAlignmentResult(raw, request, provider)`.
- Result tokens: `{ text, readingKana, startSample, endSample, confidence }`.

- [ ] **Step 1: Write failing contract checks**

```js
const normalized = normalizeAlignmentResult({
  speechStartSample: 2400,
  speechEndSample: 50400,
  tokens: [{ text: 'もっと', readingKana: 'モット', startSample: 2400, endSample: 14400, confidence: 0.94 }],
}, request, { id: 'fixture', version: '1' });
assert.equal(normalized.tokens[0].startSample, 2400);
assert.throws(() => normalizeAlignmentResult({ ...raw, tokens: [{ ...raw.tokens[0], endSample: 9999999 }] }, request, provider), /audio bounds/i);
assert.throws(() => normalizeAlignmentRequest({ ...request, language: 'tr-TR' }), /ja-JP/);
```

Cover non-monotonic tokens, blank Japanese transcript, audio-hash mismatch and low-confidence warnings.

- [ ] **Step 2: Run and observe missing module**

Run: `node tools/audio/alignment-provider-contract-check.mjs`
Expected: FAIL because the contract module does not exist.

- [ ] **Step 3: Implement exact normalization**

Use integer samples only. Preserve raw provider confidence without inventing precision. Convert provider seconds once at the boundary and validate monotonic non-overlapping ranges. Version normalization rules in the output.

- [ ] **Step 4: Verify**

Run: `node tools/audio/alignment-provider-contract-check.mjs`
Expected: `alignment provider contract check: passed`.

- [ ] **Step 5: Commit**

```text
feat(audio): define Japanese alignment contract
```

---

### Task 2: Select and isolate the Japanese aligner

**Files:**
- Create: `tools/audio/japanese-alignment-worker.py`
- Create: `tools/audio/japanese-alignment-worker-selftest.py`
- Create: `tools/audio/japanese-alignment-runtime-manager.mjs`
- Create: `tools/audio/japanese-alignment-runtime-manager-check.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create a measured provider bake-off fixture**

Prepare 10 short Japanese Chatterbox lines covering vowel length, sokuon, moraic nasal, particles and pauses. Keep transcript, WAV hash and manually reviewed coarse word/mora boundaries in `.makewatch/reports/alignment-bakeoff/`; generated media stays untracked.

- [ ] **Step 2: Measure the documented candidates**

Evaluate torchaudio/MMS forced alignment, WhisperX Japanese alignment and Montreal Forced Aligner using the same WAVs. Record install bytes, cold start, peak RAM/VRAM, token coverage, boundary median/p95 error, deterministic repeatability and failure rate. Do not install every candidate permanently; isolate trials and retain only reports.

- [ ] **Step 3: Select by explicit gate**

The selected provider must cover all 10 lines, produce stable monotonic timing, have reviewed median boundary error <= 80 ms and p95 <= 160 ms, and fit the 8 GB/32 GB machine without a mandatory video-model-sized runtime. If none pass, stop M3 with the evidence instead of shipping envelope timing as forced alignment.

- [ ] **Step 4: Write worker/runtime checks before the adapter**

Assert `status()` distinguishes `not-installed`, `installed`, `model-missing` and `ready`; bootstrap requires an explicit call; worker JSON-lines input/output is bounded; cancellation terminates the owned process tree.

- [ ] **Step 5: Implement only the selected adapter**

Pin runtime/model versions and hashes in the runtime manifest. Keep models under `.makewatch/runtimes/alignment/`, report exact disk usage, and never load the aligner while image generation or Chatterbox owns the GPU.

- [ ] **Step 6: Verify protocol and status**

Run: `python tools/audio/japanese-alignment-worker-selftest.py`
Expected: worker fixtures pass without downloading models.

Run: `node tools/audio/japanese-alignment-runtime-manager-check.mjs`
Expected: all state transitions pass against a temporary fake runtime.

- [ ] **Step 7: Commit**

```text
feat(audio): add measured Japanese aligner runtime
```

---

### Task 3: Dialogue alignment service and Codex tool

**Files:**
- Create: `tools/audio/dialogue-alignment-service.mjs`
- Create: `tools/audio/dialogue-alignment-service-check.mjs`
- Modify: `tools/director/anime-production-tools.mjs`
- Modify: `tools/director/anime-production-tools-check.mjs`
- Modify: `tools/generation/gateway-api-client.mjs`
- Modify: `tools/generation/server.mjs`

**Interface:**
- `dialogue_align({ dialogueUnitId, audioAssetId, expectedDialogueRevision, providerId }) -> { job }`.

- [ ] **Step 1: Write failing graph/persistence tests**

```js
const started = await service.start({
  dialogueUnitId: 'audio.dialogue.aya.001',
  audioAssetId: 'asset.audio.abc',
  expectedDialogueRevision: 3,
});
await service.waitForIdle();
const job = service.job(started.id);
assert.equal(job.status, 'completed');
assert.equal(job.artifact.language, 'ja-JP');
assert.ok(snapshot.dependencies.some((e) => e.dependent === job.artifact.assetId && e.dependency === 'asset.audio.abc'));
```

Cover wrong language, transcript/audio mismatch, audio SHA mismatch, low confidence, stale revision, lock, queue bound and cancellation cleanup.

- [ ] **Step 2: Implement the service**

Resolve the DialogueUnit Japanese performance text and content-addressed WAV, acquire the scheduler, invoke the selected worker, validate the result, hash/persist the Alignment JSON, then commit Generation/Asset/dependencies after a final revision check.

- [ ] **Step 3: Route the typed tool**

Add the `dialogue_align` schema, gateway endpoint/client method and runtime dispatch. Return the job ID and poll/cancel through the shared job tools from M1.

- [ ] **Step 4: Verify focused checks**

Run: `node tools/audio/dialogue-alignment-service-check.mjs && node tools/director/anime-production-tools-check.mjs`
Expected: both pass.

- [ ] **Step 5: Commit**

```text
feat(audio): persist Japanese dialogue alignment
```

---

### Task 4: Derive anime mouth states and readable Turkish cues

**Files:**
- Create: `tools/composition/subtitle-timing.mjs`
- Create: `tools/composition/subtitle-timing-check.mjs`
- Modify: `tools/anime/shot-anim-compiler.mjs`
- Modify: `tools/anime/shot-anim-compiler-check.mjs`
- Modify: `tools/anime/native-anime-contract.mjs`
- Modify: `tools/anime/native-anime-contract-check.mjs`
- Modify: `tools/anime/native-anime-worker.py`
- Modify: `tools/anime/native-anime-worker-selftest.py`
- Modify: `tools/composition/episode-render-service.mjs`
- Modify: `tools/composition/episode-render-service-check.mjs`

- [ ] **Step 1: Write mouth-map and subtitle tests**

Assert kana vowels map to `A/I/U/E/O`, silence/nasal/stops resolve to `CLOSED` or held prior vowel according to the documented state table, and emphasis may select `WIDE`. Assert Turkish cues remain <= 17 CPS, <= 2 lines, stay inside Shot bounds and may outlast speech by a bounded readable linger.

- [ ] **Step 2: Add compiler failure cases**

Compilation must reject an Alignment whose audio hash differs, confidence is below threshold, mouth states are absent from the promoted rig, or cue timing overlaps an editorial cut illegally.

- [ ] **Step 3: Implement deterministic derivation**

Convert sample ranges to frame-aligned named-state step curves once at compile time. Extend the ShotAnim contract so a mouth layer resolves its registered `CLOSED/SMALL/A/I/U/E/O/WIDE` source state instead of vertically scaling one mouth bitmap. Keep eye/blink/gaze/head/breathing curves unchanged. Emit subtitle cues as independent ShotAnim metadata; do not derive subtitle out-time from mouth closure.

- [ ] **Step 4: Render subtitle burn-in and sidecars safely**

Generate managed UTF-8 WebVTT/SRT files, pass them to FFmpeg without interpolating user text into a shell command, and preserve a clean-master option. Probe the final stream and sidecar duration.

- [ ] **Step 5: Verify**

Run: `node tools/composition/subtitle-timing-check.mjs && node tools/anime/shot-anim-compiler-check.mjs && python tools/anime/native-anime-worker-selftest.py && node tools/composition/episode-render-service-check.mjs`
Expected: all checks pass.

- [ ] **Step 6: Commit**

```text
feat(anime): drive mouths and subtitles from dialogue
```

---

### Task 5: Deterministic Shot QC and explicit promotion

**Files:**
- Create: `tools/anime/anime-shot-qc.mjs`
- Create: `tools/anime/anime-shot-qc-check.mjs`
- Create: `tools/anime/anime-shot-qc-worker.py`
- Create: `tools/anime/anime-shot-qc-worker-selftest.py`
- Modify: `tools/director/anime-production-tools.mjs`
- Modify: `tools/director/anime-production-tools-check.mjs`
- Modify: gateway client/server and `package.json`.

**Interface:**
- `shot_qc({ shotId, videoAssetId, shotAnimAssetId, expectedShotRevision, promote })`.

- [ ] **Step 1: Add failing structural and media fixtures**

Cover ffprobe duration/fps/audio presence, freeze ratio, black frames, line/palette discontinuity, pose jumps, face-state registration, foot/contact metadata, subtitle CPS, audio/video drift and scratch-frame leakage. Test that `promote: true` cannot promote any failing report.

- [ ] **Step 2: Implement bounded frame sampling**

Stream selected timestamps from FFmpeg to the worker or a temporary bounded directory; emit a contact sheet and delete samples in `finally`. Persist thresholds, numeric observations and frame timestamps in `makewatch.animeQcReport/1`.

- [ ] **Step 3: Implement promotion**

After a passing report, re-read Shot and Asset revisions, mark/link the video Asset as accepted and attach the QC Asset. Preserve prior accepted output until the replacement passes.

- [ ] **Step 4: Route and verify `shot_qc`**

Run: `python tools/anime/anime-shot-qc-worker-selftest.py && node tools/anime/anime-shot-qc-check.mjs && node tools/director/anime-production-tools-check.mjs`
Expected: all checks pass.

- [ ] **Step 5: Commit**

```text
feat(anime): gate shot promotion with QC
```

---

### Task 6: Sparse corrective redraw

**Files:**
- Create: `tools/anime/corrective-redraw-service.mjs`
- Create: `tools/anime/corrective-redraw-service-check.mjs`
- Modify: `tools/director/anime-production-tools.mjs`
- Modify: `tools/director/anime-production-tools-check.mjs`
- Modify: gateway client/server.

**Interface:**
- `corrective_redraw({ shotId, characterId, timeFrame, targetPose, expectedShotRevision, previousAcceptedKeyAssetId }) -> { job }`.

- [ ] **Step 1: Write failing request/provenance tests**

Reject a time outside the Shot, missing promoted CharacterRig/reference, pose with no compiler blocker, stale revisions, a previous key from another Character, and requests covering a time range instead of one frame.

- [ ] **Step 2: Implement a single-frame conditioned request**

Reuse `AnchorReferenceGenerationService`/ComfyUI primitives with canonical Character, outfit, target skeleton/pose, camera/framing, Location plate and previous accepted key. Persist the result as a draft pose Asset with exact inputs. Do not attach it to ShotAnim automatically.

- [ ] **Step 3: Require QC before reuse**

Run palette/landmark/identity/contact checks and expose the draft to Codex. A subsequent explicit project mutation may register a passing pose in the rig pose library; failed art stays draft.

- [ ] **Step 4: Route and verify**

Run: `node tools/anime/corrective-redraw-service-check.mjs && node tools/director/anime-production-tools-check.mjs`
Expected: both pass.

- [ ] **Step 5: Commit**

```text
feat(anime): generate sparse corrective keys
```

---

### Task 7: Product-machine multi-Shot proof

**Files:**
- Create during run: `.makewatch/reports/native-anime-m3/` artifacts only.
- Modify after evidence: `project_brain/LOCALIZATION_SYNC_ARCHITECTURE.md`
- Modify after evidence: `project_brain/NATIVE_ANIME_MOTION_ENGINE.md`
- Modify after evidence: `project_brain/DEVELOPMENT_LOG.md`

- [ ] **Step 1: Generate real Japanese performance**

Use `audio_provider` first. Generate at least three Japanese DialogueUnits through `audio_generate`, probe each WAV and listen for pronunciation/cutoff/artifacts. No proxy audio.

- [ ] **Step 2: Align and compile**

Run `dialogue_align`, inspect confidence/warnings, then `shot_anim_plan` and `shot_anim_compile`. Repair text normalization or regenerate audio when the gate fails.

- [ ] **Step 3: Render editorial coverage**

Render at least close-up, reverse and reaction Shots through `shot_generate_video(providerId: "native-anime")`; include eye movement, blink, mouth states, subtle head/hair motion and parallax. Add Turkish subtitle cues.

- [ ] **Step 4: Run QC and corrective redraw only where demanded**

Use `shot_qc` on each Shot. When the rig-domain report names a specific pose/time, create one corrective key, inspect it, register only if passing, then recompile and rerender the affected Shot.

- [ ] **Step 5: Inspect real media**

Watch with audio and subtitles. Inspect extracted frames/contact sheets at full resolution. Record timestamped lip, identity, seam, puppet, line/palette, parallax and subtitle defects.

- [ ] **Step 6: Measure storage/runtime/resources**

Record Chatterbox, alignment, compile, native render, QC and corrective-redraw wall time separately; record peak VRAM/RAM where available and confirm disposable frame cache returns to zero.

- [ ] **Step 7: Full verification and graph refresh**

Run: `powershell -ExecutionPolicy Bypass -File .\verify.ps1`
Run: `graphify update .`
Expected: both complete successfully.

- [ ] **Step 8: Commit measured truth and update main safely**

```text
docs(anime): record Japanese performance proof
```

Fetch and verify remote main against its recorded base, fast-forward local `main` to the exact verified M3 HEAD, rerun full verification on `main`, and push. Stop on divergence; never force-push.
