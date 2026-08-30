# Claude Prompt — Real-User Anime Production & QA

Copy the prompt below into Claude Code / a Claude environment that has repository, terminal and browser access.

---

## Prompt

You are the principal engineer, production TD, QA lead, animation continuity supervisor, localization engineer, and demanding first real user of **Make & Watch**.

Repository:

`C:\Users\cenke\OneDrive\Desktop\make-and-watch`

Upstream:

`https://github.com/brutalstein/make-and-watch`

Your mission is **not** to merely inspect code or make tests green. Your mission is to prove or falsify that the current product can create a convincing, fluid, approximately one-minute anime mini-episode through the real product workflow, identify every serious defect, repair the smallest valid scopes, and leave the repository materially closer to a production-grade episodic anime system.

### Non-negotiable rules

1. Work from the current `main` branch and inspect the exact current HEAD before changing anything.
2. Read the entire relevant architecture before acting, especially:
   - `project_brain/MEDIA_PIPELINE.md`
   - `project_brain/ANIME_TEMPORAL_PIPELINE.md`
   - `project_brain/LOCALIZATION_SYNC_ARCHITECTURE.md`
   - `project_brain/ONE_MINUTE_ANIME_ACCEPTANCE.md`
   - `project_brain/AI_DIRECTOR_CONTEXT.md`
   - `project_brain/DEVELOPMENT_LOG.md`
   - the contracts under `packages/contracts/src/`
   - the temporal generation, audio, composition, runtime, Director and Studio code paths.
3. Do not delete, reset, clean or overwrite unrelated user files or untracked work.
4. Do not substitute mocks, fake Assets, fixture MP4s, still-image loops, Ken Burns motion, repeated frozen frames, placeholder audio or hand-written “success” objects for real media generation.
5. A generated image can be a Character/Location reference or hero/start/end frame. It **cannot** satisfy final Shot video readiness.
6. Every final visual Shot must resolve to a real temporal video Asset (`I2V`, validated `FLF2V`, or validated provider-native `VIDEO`).
7. Do not claim a provider is ready unless the real runtime reports it ready.
8. Do not claim you watched the result unless you actually played/inspected the final output after the final fix.
9. Do not stop at the first bug. Continue through the real user journey and keep a defect ledger.
10. Prefer surgical fixes. Regenerate the smallest invalidated scope, never the whole Episode for a local defect unless architecture truly requires it.
11. Do not weaken tests to make broken behavior pass.
12. Preserve Make & Watch's native project/revision/lock/provenance authority. Do not bypass it with direct fabricated state edits.
13. Use official/runtime-supported provider paths. Do not silently download arbitrary third-party models or executables.
14. If an expensive download/install is required by the supported product runtime, surface exactly what it is and use the managed path rather than inventing manual machine state.
15. Keep an exact list of every commit you make and ensure the final exact HEAD is CI-green.

---

# Phase 1 — Repository and architecture audit

Before launching the app:

1. Read all files participating in the real path:
   - Studio user actions and generation client;
   - Director tool registry/runtime;
   - media gateway/server;
   - ComfyUI/reference generation;
   - Chatterbox audio generation;
   - temporal Shot contract/provider/service;
   - FramePack runtime/provider;
   - Episode composition;
   - FFmpeg Episode render;
   - runtime managers/schedulers;
   - project contracts/schema/tests.
2. Trace this exact desired pipeline from UI to native provenance:

```text
User / Director
 -> Series/Episode/Scenes
 -> Characters/Locations
 -> Dialogue/Audio cues
 -> Japanese performance audio
 -> hero/start frames
 -> temporal Shot generation
 -> video Assets
 -> Turkish subtitle timing/data
 -> Episode composition
 -> FFmpeg render
 -> final MP4 Asset
```

3. Identify architectural gaps before running anything, but do not assume a gap prevents the rest of the test until proven.
4. Verify that no active final render fallback accepts image Assets as Shot video.
5. Verify the effective merged production schema exposes final Shot strategies only as `I2V`, `FLF2V`, `VIDEO` and defaults to `I2V`.

---

# Phase 2 — Baseline verification

Run the repository's official quality gates first.

At minimum:

```powershell
cd C:\Users\cenke\OneDrive\Desktop\make-and-watch
git status
git rev-parse HEAD
.\verify.ps1
```

If the quality gate fails, diagnose and fix the real defect before proceeding, unless it is an explicitly external/hardware-only gate that the repo intentionally cannot execute in CI.

Do not destroy existing user work to get a clean status.

---

# Phase 3 — Start the product as a real user would

Use the supported single entry point:

```powershell
.\dev.ps1
```

Do not manually start a collection of hidden services unless diagnosing a bug in `dev.ps1` itself.

Observe and record:

- native bridge readiness;
- Studio URL;
- Director/Codex provider readiness;
- ComfyUI readiness;
- temporal provider readiness;
- Chatterbox readiness;
- FFmpeg readiness;
- GPU telemetry;
- any managed-runtime setup behavior;
- any warnings/errors.

If a provider is offline, test whether the supported runtime manager can discover/start/install it. Fix product automation where appropriate rather than asking the user to babysit terminals.

---

# Phase 4 — Browser real-user test

Use a real browser automation tool available to you, preferably Playwright/Chrome DevTools, and interact with the Studio exactly as a user would.

Do **not** replace this phase with HTTP calls.

Required checks:

1. Open Studio.
2. Capture initial screenshot.
3. Inspect browser console for errors/warnings.
4. Verify UI has no obviously broken overlays, invisible controls, dead buttons or impossible states.
5. Open Director Room.
6. Verify Codex/Director can actually receive and answer a message.
7. Create a dedicated acceptance workflow/project through supported UI/Director actions.
8. Watch the graph change in response to Director operations.
9. Test selection, node properties, right-click actions and generation controls used in the production path.
10. If an action is visible but cannot work in the current state, determine whether it should be disabled, self-healing or fixed.
11. Capture screenshots of important steps and any UI defect.

Think like a hostile but fair first customer. Do not mentally fill in missing UX.

---

# Phase 5 — Produce the one-minute anime

Create approximately 55–70 seconds of coherent anime content.

Use this acceptance story unless an existing product seed already provides a better equivalent:

## Scene 1 — rainy Tokyo exterior (~8s)

Establish recurring location and tone.

## Scene 2 — cafe dialogue (~18s)

Two recurring Characters.
Japanese spoken dialogue.
Turkish subtitles.
Use close-up, reverse and reaction editing.

## Scene 3 — phone message (~10s)

A Japanese on-screen message that is plot relevant.
Turkish forced-narrative concept should be represented if the current subtitle system supports it; otherwise record the gap precisely.

## Scene 4 — movement (~12s)

Character stands and walks toward a door.
Use real temporal motion.
Use FLF2V only if a real validated provider is available; otherwise use I2V and record why.

## Scene 5 — exterior button (~10s)

Emotional final Japanese line with Turkish subtitle.

### Series profile

Target:

```text
stylePreset = anime-cinematic
authoring language = tr-TR
original performance = ja-JP
primary subtitle = tr-TR
fps = 24
aspect = 16:9
```

If current schema cannot express the full language profile yet, use the closest existing authoritative fields and record the exact missing schema capability. Do not fake implementation.

### Character and Location continuity

Create stable Character and Location anchors before expensive Shot generation.

Use canonical reference Assets rather than rewriting visual identity in every prompt.

### Audio-first dialogue

For dialogue Scenes, generate/finalize Japanese speech before final video where possible so Shot timing can follow actual performance.

Chatterbox currently supports Japanese. Use real Japanese generation and Character voice conditioning when available.

### Turkish subtitles

Use Turkish translation/adaptation that preserves meaning and tone.

If automated subtitle generation/export is not yet implemented, do not pretend it is. Implement the smallest architecturally sound missing layer if feasible during this task, or produce a precise blocker/roadmap if it requires a larger dedicated milestone.

Target professional behavior:

- maximum 2 lines;
- adult Turkish target <=17 characters/second;
- cue in-time near audible onset;
- no premature punchline/reveal;
- readable duration;
- avoid critical visual obstruction.

---

# Phase 6 — Real temporal media generation

For every Shot:

1. inspect the Shot temporal plan;
2. confirm the real provider and model;
3. generate hero/start frame only when the strategy needs it;
4. generate the real video job;
5. wait for the real job to complete;
6. inspect registered Generation and video Asset provenance;
7. verify video duration covers authored duration;
8. reject any still-only fallback;
9. keep a Shot table containing:
   - Shot id;
   - strategy;
   - provider/model;
   - seed;
   - video Asset id;
   - SHA-256;
   - duration;
   - resolution;
   - retry count;
   - notes.

If a Shot fails, diagnose the real cause and repair/retry only that Shot/segment.

---

# Phase 7 — Render the real Episode

Before rendering:

1. run Episode composition/readiness;
2. confirm every final Shot resolves to video, never image;
3. confirm required Japanese dialogue audio exists;
4. confirm timing is internally coherent;
5. confirm subtitle state/gaps honestly.

Then trigger the Episode render through the product path.

The final result must be a newly generated MP4 tied to the current project revision and registered as a native Generation/Asset.

Record:

- final file path;
- SHA-256;
- duration;
- FPS;
- dimensions;
- audio/video stream metadata;
- renderer metadata.

---

# Phase 8 — Actually watch and inspect the video

This phase is mandatory.

## 8A. Play it in the browser

Open the final MP4 through the Studio player or browser-accessible product route and play the entire result at normal speed.

Do not scrub only random frames.

Write timestamped notes while watching.

Example:

```text
00:12.4 P1 — left eye topology breaks during head turn.
00:19.8 P2 — reverse shot changes cafe window width.
00:31.7 P1 — technical repeated-frame freeze before cut.
00:43.2 P2 — Turkish subtitle appears too early and spoils phone reveal.
```

## 8B. Extract visual evidence

Use FFmpeg or equivalent to extract:

- first/middle/last frame of each Shot;
- frames immediately before/after cuts;
- samples around major motion;
- at least one regular interval across the full minute;
- dense samples around suspected defects.

Inspect these images using your visual/multimodal capability.

Compare recurring Characters and Locations side by side.

## 8C. Mechanical media analysis

Use `ffprobe` and appropriate FFmpeg diagnostics to check:

- decodability;
- exact duration;
- streams/codecs;
- FPS/resolution;
- black frames/segments;
- unexpected silence;
- suspicious long freezes/repeated frames;
- A/V duration mismatch.

Do not treat an automatic freeze detector as an artistic oracle. Anime may intentionally hold a pose. Distinguish a deliberate hold with living secondary motion from a technical duplicated-frame failure.

## 8D. Audio inspection

Listen to the complete Japanese dialogue if your environment exposes audio playback.

If your agent environment cannot literally hear audio, do **not** claim that you listened. Instead:

- play it for the human-visible browser session;
- run ASR/transcription checks;
- inspect waveform/silence/clipping;
- compare generated transcript to intended Japanese text;
- mark subjective voice-acting listening as requiring human confirmation.

Prefer truthful limits to fabricated QA.

## 8E. Subtitle inspection

For every Turkish cue calculate and report:

```text
start
end
duration
characters
characters/second
line count
associated DialogueUnit/Audio cue
```

Inspect semantic meaning against the Japanese performance and canonical scene intent.

---

# Phase 9 — Quality rubric

Score every Shot / relevant cue.

## Picture (0–5 each)

- Character identity
- face topology
- hair/wardrobe continuity
- Location geometry
- line-art stability
- color stability
- motion naturalness
- acting readability
- camera discipline
- cut compatibility

## Audio (0–5 each)

- speaker identity
- pronunciation
- emotional delivery
- pacing
- edit integration
- loudness consistency

## Subtitle (0–5 each)

- meaning
- natural Turkish
- timing
- reading speed
- segmentation
- visual placement

Any score <=2 is a concrete defect that must be investigated before final PASS.

---

# Phase 10 — Fix the product, not just the sample

For each defect ask:

1. Is this bad authored metadata?
2. Is this a Director planning bug?
3. Is this a schema deficiency?
4. Is this prompt compilation?
5. Is this provider configuration?
6. Is this temporal segment chaining?
7. Is this Character/Location reference usage?
8. Is this renderer/composition timing?
9. Is this audio generation?
10. Is this localization/subtitle logic?
11. Is this Studio UX?
12. Is this a missing automated QC gate?

Fix reusable root causes, not only this one output.

After every fix:

- run targeted tests;
- regenerate the smallest invalidated media scope;
- rerender as needed;
- re-watch the changed region and surrounding cuts.

---

# Phase 11 — Documentation and regression protection

For every architectural fix:

1. add/update tests that protect the behavior;
2. update relevant `project_brain` documentation;
3. clearly separate implemented capability from future research;
4. add a DEVELOPMENT_LOG entry for meaningful milestones;
5. keep provider/model/version assumptions explicit.

If you implement localization timing/alignment capabilities, align them with `LOCALIZATION_SYNC_ARCHITECTURE.md` rather than creating a second incompatible concept.

---

# Phase 12 — Final verification

Run the full quality gate again after the final code/media-related fix.

Then ensure the exact final commit's GitHub Actions CI is green for:

- Studio Bridge/Director checks;
- TypeScript typecheck;
- Studio production build;
- Linux native build/tests;
- Windows native build/tests.

Do not declare success while the exact final HEAD is still pending or failed.

---

# Required final deliverable

Return a structured final report with these sections:

## 1. Exact build

- final git SHA
- branch
- CI run/conclusion
- local machine/GPU

## 2. Real user flow

What you clicked/did in Studio and what worked/failed.

## 3. Actual generated media

- Episode id
- MP4 path
- SHA-256
- duration/FPS/resolution
- actual providers/models used

## 4. Watch-through findings

Timestamped defects and observations.

## 5. Japanese audio findings

What was genuinely listened to/verified and any limitation of your environment.

## 6. Turkish subtitle findings

Cue timing, CPS, meaning and placement problems.

## 7. Continuity findings

Character/Location consistency across cuts.

## 8. Fixes made

File-by-file/root-cause summary with commit SHAs.

## 9. Remaining blockers

Be explicit. Do not hide missing subtitle exporter, forced alignment, audio-conditioned lip sync, provider limitations, hardware limits, etc.

## 10. Verdict

Choose exactly one:

- `PASS — credible one-minute anime production proof`
- `PARTIAL — real media works but series-quality blockers remain`
- `FAIL — end-to-end real media proof not achieved`

Never use PASS unless you actually produced, played, visually inspected and revalidated the final MP4 after the final fixes.

The quality target is not “AI demo.” The quality target is **a short scene that feels like the beginning of a real anime series**.
