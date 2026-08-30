# Native Anime M4 One-Minute Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce, compose, inspect and truthfully score one 52–68 second multi-Shot anime Episode through the same typed Codex production surface intended for future 20-minute Episodes.

**Architecture:** Add a resumable acceptance state machine that diagnoses the graph, starts only the next ready existing job, records every artifact/job/gate, and stops at failed QC. Keep Shot generation and retry independent. Compose accepted Shot MP4s, render subtitles/audio, collect storage/runtime evidence, and require an explicit human watch-through decision before PASS.

**Tech Stack:** Existing Make & Watch Director tools, native project bridge, native anime renderer, Chatterbox, selected aligner, Episode composition/render services, FFmpeg/ffprobe, Node.js ESM checks.

**Spec:** `docs/superpowers/specs/2026-08-30-codex-native-anime-control-plane-design.md`

**Normative gate:** `project_brain/ONE_MINUTE_ANIME_ACCEPTANCE.md`

**Requires:** Passing M1–M3 commits and green deterministic checks on the product machine.

## Global Constraints

- Duration is 52–68 seconds at 24 fps; do not render a 20-minute Episode in M4.
- Use several editorial Shots; a single continuous puppet take fails.
- Every final Shot requires real native temporal video, real Japanese audio where dialogue exists, a passing QC Asset and explicit acceptance.
- No persisted individual rendered frames after completion.
- Acceptance resume reuses completed content-addressed jobs; it never regenerates a passing dependency without reason.
- Critical or major visual defects make the Episode fail even when probes/tests pass.
- `episode_acceptance_run` orchestrates transparent existing operations; it does not hide stages or create a second source of project truth.
- Main updates are fast-forward only and occur only after exact-HEAD verification.

## Acceptance Story

Use the repository’s recommended compact story unless the approved graph already has an equivalent 52–68 second story:

1. 8 s rainy Tokyo street establishment.
2. 18 s two-Character Japanese cafe dialogue: close-up, reverse, reaction.
3. 10 s phone-message reaction with Japanese on-screen text and Turkish forced narrative.
4. 12 s stand-and-walk-to-door action broken into purposeful short Shots.
5. 10 s exterior emotional button with a final Japanese line and Turkish subtitle.

## File Structure

- Create `tools/anime/anime-acceptance-contract.mjs`: plan/run/resume/report input contract and gate identifiers.
- Create `tools/anime/anime-acceptance-contract-check.mjs`: duration, coverage and report validation checks.
- Create `tools/anime/anime-acceptance-service.mjs`: resumable bounded orchestration over existing services.
- Create `tools/anime/anime-acceptance-service-check.mjs`: dry plan, resume, failure stop and idempotency checks.
- Create `tools/anime/anime-acceptance-evidence.mjs`: ffprobe, storage, scratch, contact-sheet and runtime evidence collector.
- Create `tools/anime/anime-acceptance-evidence-check.mjs`: deterministic fixtures and path safety.
- Create `tools/anime/twenty-minute-readiness.mjs`: projection from actual per-Shot observations without producing media.
- Create `tools/anime/twenty-minute-readiness-check.mjs`: scaling and budget checks.
- Modify `tools/director/anime-production-tools.mjs`: expose `episode_acceptance_plan` and `episode_acceptance_run`.
- Modify `tools/director/anime-production-tools-check.mjs`: schemas/routing/authority checks.
- Modify `tools/generation/gateway-api-client.mjs` and `tools/generation/server.mjs`: plan/run/resume/report endpoints.
- Modify `tools/composition/episode-composition.mjs`: only if required for accepted-Shot/resume invariants found by tests.
- Modify `tools/composition/episode-composition-check.mjs`: cover any composition invariant changed by the service work.
- Modify `tools/composition/episode-render-service.mjs`: only if required for streaming/concat/retention gates found by tests.
- Modify `package.json`: register deterministic checks.
- Modify required `project_brain` documents after measured acceptance.

---

### Task 1: Acceptance contract and truthful gate model

**Files:**
- Create: `tools/anime/anime-acceptance-contract.mjs`
- Create: `tools/anime/anime-acceptance-contract-check.mjs`
- Modify: `package.json`

**Interfaces:**
- `buildAcceptancePlan(snapshot, episodeId, options)`.
- `validateAcceptanceReport(value)` for `makewatch.animeAcceptanceReport/1`.
- Gate states: `ready`, `blocked`, `running`, `passed`, `failed`, `needs_human_review`.

- [ ] **Step 1: Write failing plan/report checks**

```js
const plan = buildAcceptancePlan(snapshot, 'episode.acceptance.001', { minSeconds: 52, maxSeconds: 68 });
assert.equal(plan.durationSeconds, 58);
assert.ok(plan.gates.some((g) => g.id === 'real-japanese-audio'));
assert.ok(plan.gates.some((g) => g.id === 'visual-watch-through' && g.state === 'needs_human_review'));
assert.throws(() => validateAcceptanceReport({ ...passingReport, humanReview: null }), /human review/i);
assert.throws(() => buildAcceptancePlan(singleShotSnapshot, episodeId, {}), /editorial shots/i);
```

Cover missing rig/package/alignment/QC, non-native final Shot, proxy audio, subtitle absence, duration outside range, intermediate-frame leakage and critical/major visual defects.

- [ ] **Step 2: Run and confirm module-not-found**

Run: `node tools/anime/anime-acceptance-contract-check.mjs`
Expected: FAIL because the contract module does not exist.

- [ ] **Step 3: Implement the pure diagnostic plan**

Read only graph nodes/edges/metadata. Return exact blockers with node/Asset IDs and recommended existing tool calls. Never start a job or mutate the graph from the plan function.

- [ ] **Step 4: Implement strict report validation**

Require exact final MP4 hash/probe, Shot QC links, Japanese audio/alignment evidence, Turkish cues, runtime/storage measurements, scratch bytes, watch-through result and timestamped defect list.

- [ ] **Step 5: Verify and commit**

Run: `node tools/anime/anime-acceptance-contract-check.mjs`
Expected: `anime acceptance contract check: passed`.

```text
feat(anime): define one-minute acceptance gates
```

---

### Task 2: Evidence collector and 20-minute projection

**Files:**
- Create: `tools/anime/anime-acceptance-evidence.mjs`
- Create: `tools/anime/anime-acceptance-evidence-check.mjs`
- Create: `tools/anime/twenty-minute-readiness.mjs`
- Create: `tools/anime/twenty-minute-readiness-check.mjs`

**Interfaces:**
- `collectAcceptanceEvidence({ projectRoot, episodeAssetId, shotAssetIds, jobTimings })`.
- `projectTwentyMinuteBudget({ measuredEpisode, reuseScenario })`.

- [ ] **Step 1: Write failing filesystem/probe fixtures**

Use a temporary managed project root and fake ffprobe adapter. Assert exact persistent bytes by category, zero disposable-frame bytes, unique-content accounting, final duration/fps/audio/video streams and contact-sheet timestamp coverage. Reject paths escaping `.makewatch`.

- [ ] **Step 2: Write projection checks**

```js
const projection = projectTwentyMinuteBudget({
  measuredEpisode: { seconds: 60, finalMediaBytes: 30_000_000, reusableAssetBytes: 80_000_000, shotScratchPeakBytes: 12_000_000 },
  reuseScenario: { episodeSeconds: 1200, reusableAssetReuse: 0.8, averageShotSeconds: 4 },
});
assert.equal(projection.persistentFrameBytes, 0);
assert.ok(projection.scratchPeakBytes < projection.projectedFinalMediaBytes);
assert.equal(projection.renderStrategy, 'bounded-per-shot-resumable');
```

- [ ] **Step 3: Implement exact evidence collection**

Count content-addressed files once by resolved path/hash. Separate reusable canon, sparse keys, audio, Shot video, final Episode, reports and scratch. Generate contact sheets by streaming selected frames; clean temporary samples in `finally`.

- [ ] **Step 4: Implement a labeled projection, not a promise**

Scale final compressed media and Shot count from measured observations, amortize only explicitly reusable assets, report low/base/high ranges, queue limits and peak scratch. Mark all 20-minute values as projections.

- [ ] **Step 5: Verify and commit**

Run: `node tools/anime/anime-acceptance-evidence-check.mjs && node tools/anime/twenty-minute-readiness-check.mjs`
Expected: both pass.

```text
feat(anime): measure acceptance storage and scale
```

---

### Task 3: Resumable acceptance service

**Files:**
- Create: `tools/anime/anime-acceptance-service.mjs`
- Create: `tools/anime/anime-acceptance-service-check.mjs`
- Modify only if tests require: `tools/composition/episode-composition.mjs`
- Modify only if tests require: `tools/composition/episode-composition-check.mjs`
- Modify only if tests require: `tools/composition/episode-render-service.mjs`

**Interfaces:**
- `plan({ episodeId }) -> diagnostic plan`.
- `start({ episodeId, expectedEpisodeRevision, maxNewJobs, resumeRunId }) -> { run }`.
- `run(runId)`, `runs({ episodeId, limit })`, `cancel(runId)`.
- A run contains ordered stage records with `tool`, `inputDigest`, `jobId`, `artifactIds`, `state`, `startedAt`, `finishedAt`, `blocker`.

- [ ] **Step 1: Write state-machine tests before implementation**

Cover a fully blocked dry plan, one-next-job scheduling, max-new-job bound, stop-on-QC-failure, cancelled child job, service restart/resume, reuse of matching completed artifacts, stale Episode revision, composition from accepted Shots only, render failure and idempotent report persistence.

- [ ] **Step 2: Run and confirm failure**

Run: `node tools/anime/anime-acceptance-service-check.mjs`
Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement transparent orchestration**

Call the existing service interfaces for audio, alignment, compile, native render, Shot QC, composition and Episode render. Persist run state after every transition. Do not invoke corrective redraw automatically: stop with the exact `corrective_redraw` recommendation so Codex can inspect and authorize the new key.

- [ ] **Step 4: Preserve resumability and bounded execution**

At resume, compare input digests, hashes and revisions. Reuse only exact matches. Start at most `maxNewJobs`; never hold the GPU scheduler while polling another service. Cancellation delegates to M1 cancellation and marks the run cancelled without marking draft artifacts ready.

- [ ] **Step 5: Require human review before PASS**

The service may reach `needs_human_review`; only a follow-up run input containing the inspected final Asset hash, `passed` boolean and timestamped findings may close the gate. Machine QC cannot synthesize this decision.

- [ ] **Step 6: Verify and commit**

Run: `node tools/anime/anime-acceptance-service-check.mjs`
Expected: `anime acceptance service check: passed`.

```text
feat(anime): orchestrate resumable acceptance runs
```

---

### Task 4: Expose acceptance plan/run to Codex

**Files:**
- Modify: `tools/director/anime-production-tools.mjs`
- Modify: `tools/director/anime-production-tools-check.mjs`
- Modify: `tools/generation/gateway-api-client.mjs`
- Modify: `tools/generation/server.mjs`

- [ ] **Step 1: Add failing tool-schema/routing checks**

Assert `episode_acceptance_plan` is read-only and takes `episodeId`; `episode_acceptance_run` requires Episode revision for a new run, supports `resumeRunId`, caps `maxNewJobs`, and validates human-review evidence against a final Asset hash.

- [ ] **Step 2: Add bounded gateway routes**

Expose plan/start/get/list/cancel using stable error categories. Return every stage and blocker; do not collapse results to a single progress percentage.

- [ ] **Step 3: Verify the complete production tool surface**

Run: `node tools/director/anime-production-tools-check.mjs && node tools/director/makewatch-tool-runtime-check.mjs`
Expected: all 43 typed production tools (27 existing plus 16 approved additions) are registered exactly once and route to the gateway.

- [ ] **Step 4: Commit**

```text
feat(director): expose anime acceptance workflow
```

---

### Task 5: Author the 52–68 second acceptance graph through Codex

**Files:**
- Project mutations: native graph through `project_apply`, not hand-edited files.
- Generated media/reports: `.makewatch/` only.

- [ ] **Step 1: Inspect current readiness**

Call `project_snapshot`, `production_status`, `audio_provider`, `temporal_providers` and `episode_acceptance_plan`. Record blockers and the current graph revisions.

- [ ] **Step 2: Reuse canon before creating anything**

Select existing promoted CharacterRig and EnvironmentPackage Assets when their Character/outfit/Location states fit. Generate new reference or semantic states only for documented missing coverage.

- [ ] **Step 3: Author a multi-Scene/multi-Shot graph**

Use stable Series/Episode/Scene/Shot/Audio identities. Encode shot class, framing, key poses, acting beats, gaze/expression/body/camera/secondary/environment intent, Japanese performance text, Turkish subtitles and independent cue anchors. Keep total planned duration between 52 and 68 seconds.

- [ ] **Step 4: Re-run the pure plan**

Confirm the plan reports exact required operations and no structural blocker. Review the proposed Shot breakdown for purposeful cuts, reactions and action coverage before any expensive generation.

---

### Task 6: Generate, repair and compose the one-minute Episode

**Files:**
- Generated media/reports: `.makewatch/` only.

- [ ] **Step 1: Run bounded acceptance stages**

Call `episode_acceptance_run` with a small `maxNewJobs`, poll through typed job tools, and resume. Inspect each stage output. Generate Japanese audio, alignment, ShotAnim and native video per Shot.

- [ ] **Step 2: Repair the smallest failed dependency**

For pronunciation/alignment failure, repair that DialogueUnit/audio. For rig-domain failure, create/validate one corrective key. For visual QC failure, repair that Shot or semantic state. Never regenerate the whole Episode for one local defect.

- [ ] **Step 3: Promote passing Shots explicitly**

Run `shot_qc({ promote: true })` only after contact-sheet/video inspection. Confirm rejected prior outputs remain traceable and composition selects accepted versions only.

- [ ] **Step 4: Compose and render**

Use `episode_compose` and `episode_render`. Produce a final 24 fps MP4 with Japanese audio and readable Turkish subtitles plus managed subtitle sidecars. Confirm final media is newly generated, not the 4-second proof or a loop.

- [ ] **Step 5: Confirm cleanup and resumability**

Verify disposable frame cache is zero, final/reusable assets remain, and rerunning the acceptance plan reuses exact passing artifacts.

---

### Task 7: Human visual/audio inspection and acceptance report

**Files:**
- Create during run: `.makewatch/reports/native-anime-acceptance/` artifacts only.
- Modify after evidence: required `project_brain` documents.

- [ ] **Step 1: Probe the final MP4**

Record SHA-256, bytes, duration, dimensions, 24 fps stream, codecs, audio stream, start/end timestamps and A/V drift.

- [ ] **Step 2: Watch the Episode from start to finish**

Use normal playback with audio/subtitles. Record timestamped critical, major and minor findings for identity, composition, pose readability, puppet feel, lip sync, eyes/blinks, head/hair/cloth, parallax/occlusion, effects, Japanese performance, subtitles, cuts and narrative clarity.

- [ ] **Step 3: Inspect dense visual evidence**

Open Scene contact sheets and full-resolution frames at dialogue closures, blinks, maximum turns, hand/object contact, walk foot plants, edit boundaries and subtitle changes. Compare recurring Character and Location appearances.

- [ ] **Step 4: Repair and rerun invalidated scope**

Fix all practical critical/major defects, then repeat relevant compile/render/QC/composition steps. If an artistic blocker cannot be repaired, record the exact limitation and mark acceptance failed.

- [ ] **Step 5: Submit explicit human-review evidence**

Resume `episode_acceptance_run` with final Asset hash, pass/fail and timestamped findings. Persist `makewatch.animeAcceptanceReport/1`. A PASS requires no open critical/major findings.

- [ ] **Step 6: Produce the 20-minute readiness projection**

Use actual one-minute observations to report projected persistent storage, scratch peak, runtime, queue behavior and reuse for 20 minutes. Do not generate a 20-minute video and do not label the projection as measured output.

---

### Task 8: Documentation, exact-head CI and main integration

**Files:**
- Modify: `project_brain/NATIVE_ANIME_MOTION_ENGINE.md`
- Modify: `project_brain/MEDIA_PIPELINE.md`
- Modify: `project_brain/ANIME_TEMPORAL_PIPELINE.md`
- Modify: `project_brain/AI_DIRECTOR_CONTEXT.md`
- Modify: `project_brain/DEVELOPMENT_LOG.md`
- Modify: `project_brain/ONE_MINUTE_ANIME_ACCEPTANCE.md`
- Modify if architecture boundary changed: `project_brain/ARCHITECTURE.md`, `project_brain/INVARIANTS.md`, `project_brain/VALIDATION.md`, `project_brain/HANDOFF.md`.

- [ ] **Step 1: Update status labels from evidence only**

Clearly separate implemented, product-machine validated, visually accepted, failed and research-candidate behavior. Include exact artifact/report IDs, hashes, measured runtime/storage, selected aligner and open defects. Never claim studio quality or 20-minute proof.

- [ ] **Step 2: Run focused and full deterministic gates**

Run every new M1–M4 check explicitly, then:

Run: `powershell -ExecutionPolicy Bypass -File .\verify.ps1`
Expected: all gates pass on the current exact HEAD.

Run: `git diff --check`
Expected: no whitespace errors.

Run: `graphify update .`
Expected: knowledge graph refresh completes.

- [ ] **Step 3: Commit final evidence/docs**

```text
docs(anime): record one-minute acceptance result
```

- [ ] **Step 4: Verify the commit, tree scope and remote base**

Record `git rev-parse HEAD`, `git status --short`, `git diff --stat origin/main...HEAD` and `git ls-remote origin refs/heads/main`. Ensure unrelated `.serena/`, `pnpm-lock.yaml` and user work are not staged.

- [ ] **Step 5: Fast-forward local and remote main**

Only when the fetched `origin/main` equals the previously recorded expected SHA: switch to `main`, fast-forward it to the verified feature HEAD, rerun `verify.ps1`, and push `main`. If remote main changed or the worktree cannot switch safely, stop and report the exact blocker. Never merge with a generated merge commit and never force-push.

- [ ] **Step 6: Deliver the final report**

Return the architecture comparison, selected design, mandatory/runtime and per-Episode storage, runtime/resource behavior, realistic quality ceiling, implemented vertical slices, visual results, defects, next three milestones, exact commits and final CI status. Distinguish infrastructure completion from one-minute visual PASS.
