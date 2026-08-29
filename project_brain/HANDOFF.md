# Session Handoff

## Current state

Foundation work is on `foundation/series-engine-v0` and tracked by draft PR #1.

The current foundation includes:

- C++20 transactional semantic project graph with typed commands/events, revisions, locks, approvals, staleness, dependency invalidation, impact preview, snapshots and guarded hydration;
- SQLite schema v2 with atomic snapshot + append-only journal persistence;
- `ProjectSession` persist-before-live-commit semantics;
- JSONL IPC v1 + real `makewatch_engine_host` process;
- native-driven React/TypeScript Studio;
- exact-pointer AI Autopilot with pause/resume/cancel/checkpoints;
- `ResourceManager` + bounded `BackgroundJobRuntime` lifecycle/resource ownership;
- supported Codex App Server integration with ChatGPT-managed authentication and zero OAuth credential custody;
- bounded multi-turn Codex Director chat;
- cinematic toggleable Director Chat sidecar with persisted open/closed presentation preference;
- first-Send automatic secure Codex connection flow;
- cross-episode canonical character continuity compiler;
- deterministic native episode video render-plan compiler;
- public-repository IP boundary that keeps adaptive representation-selection/scheduling algorithms out of this tree.

## Director Chat — current product behavior

The previous readiness-gated composer was removed. A provider that is still starting must never make the text area untypeable.

Current UX contract:

```text
start dev runtime
 -> native engine builds/starts
 -> localhost bridge starts
 -> dev-runner warms /api/director/providers
 -> owned codex app-server initializes before Studio opens when available
 -> Studio opens
 -> user can type immediately
 -> first Send:
      already authenticated -> message sends
      auth required -> official ChatGPT auth URL opens -> message remains queued locally
                       -> sanitized status polling -> queued message sends after connection
```

Important details:

- the composer is writable regardless of `chatAvailable` readiness;
- the user message is not shown as submitted until it is actually handed to the provider;
- before provider submission, a failed connection restores the text to the composer;
- after a possible provider submission, the UI does not blindly retry and risk duplicate turns;
- Codex App Server is warmed in `tools/dev-runner.mjs` before Vite Studio starts;
- manual `Connect` remains available inside the Connections drawer as a recovery/control surface, not a mandatory normal step;
- chat conversation threads are bounded and owned by the bridge;
- chat does not mutate native semantic project truth;
- Claude remains `api_required` for shipping product chat until a supported Anthropic provider exists.

## Toggle / cinematic sidecar

`DirectorProviderDock` inserts one real sidecar before the workflow canvas.

It has two visual states:

```text
OPEN   : Creative Control | Director Chat | Workflow | Inspector
CLOSED : Creative Control | 62px Chat rail | wider Workflow | Inspector
```

- open/closed state is a presentation preference stored in local storage;
- panel width animates through CSS grid columns;
- panel entrance/messages/connection drawer have subtle motion;
- `prefers-reduced-motion` removes non-essential animations;
- connection diagnostics live behind a `Connections` drawer instead of occupying the conversation permanently;
- closing chat never destroys native project state or provider credentials.

## Autopilot interaction ownership

Autopilot must own workflow geometry without disabling conversation.

A previous full-viewport interaction veil could block Director Chat. Current CSS scopes the effective lock to the live workflow canvas bounds while the chat sidecar remains interactive. ReactFlow also independently disables node dragging/selection during Autopilot.

Do not restore a full-screen pointer-stealing overlay.

## Native media foundation

Read `MEDIA_PIPELINE.md` before changing continuity/video planning.

### Series continuity

`SeriesContinuityCompiler` uses one canonical Character node across episodes. It now also detects invalid ownership such as one scene under multiple episodes or one shot under multiple scenes in the same series and avoids creating duplicate continuity bindings.

Final readiness considers canonical series/character approval, freshness and identity lock state.

### Video compiler

`VideoPipelineCompiler` creates a deterministic per-episode DAG:

```text
shot synthesize -> shot composite --+
shot synthesize -> shot composite --+--> episode assemble
```

Hardening now includes:

- finite/bounded profile dimensions and FPS;
- finite positive shot durations (`nan`/overflow rejected as invalid metadata);
- exact metadata index parsing;
- exactly one Series dependency for an Episode;
- Episode/Scene/Shot approval + stale validation;
- empty Scene/zero-shot detection;
- bounded explicit `generationStrategy` metadata;
- duplicate shot ownership detection without duplicate task IDs;
- finite accumulated episode duration;
- canonical character continuity readiness.

The public compiler still does **not** implement patent-sensitive automatic strategy selection.

## Runtime safety hardening

`ResourceManager::try_acquire_scoped` now stages the lease identity before resource accounting is mutated, closing a post-acquire allocation-failure window.

`BackgroundJobRuntime::start_one_ready` stages queue data before resource admission and commits `running_` before erasing the queued source. If a later map/value allocation throws, the RAII lease releases and the original queued request remains available rather than disappearing.

The invariant remains: a running worker lease is released only after actual stop/completion confirmation.

## Current code validation

Latest code-level CI after the Director UX + media/runtime hardening is green:

- Bridge and Director checks;
- strict TypeScript;
- Studio production build;
- strict native configure/build;
- complete CTest suite.

This is not the Windows/NVIDIA product-machine gate.

## Immediate Windows gate

Fully stop any old dev runtime, then:

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

Expected terminal startup:

- native engine builds/starts;
- bridge becomes healthy;
- dev-runner prints `Preparing Codex Director service…`;
- if already authenticated: `Codex Director ready ...`;
- if auth is required: App Server is still prepared and Studio explains that first Send will complete secure sign-in.

### Director Chat live test

1. Collapse Director Chat; confirm it becomes a narrow vertical rail and the workflow expands smoothly.
2. Reopen it; confirm no workflow overlap/global page scrollbar.
3. **Before touching Connect**, click the composer and type. It must accept text immediately.
4. Press Send.
5. If ChatGPT is already connected, the message should send directly.
6. If authentication is required, the official ChatGPT sign-in flow should open from that Send gesture; the unsent message remains visibly queued and sends automatically after status becomes ready.
7. Send a second message; it must continue the same Codex thread.
8. Open/close `Connections`; provider diagnostics should not disturb the conversation layout.
9. Start Autopilot and verify Director Chat remains typeable while the workflow canvas itself stays protected from manual geometry interaction.
10. Stop `dev.ps1` during an active Director turn and verify no orphan `codex app-server` remains.
11. Restart and confirm the Chat open/closed presentation preference is restored.

Any disabled composer before a message is in-flight, login dead-end, workflow interaction leak during Autopilot, duplicate first-Send message, orphan provider process, overlay, global scrolling, or layout break is a failed live gate.

## Next engineering sequence after this live gate

1. concrete cross-platform WorkerSupervisor over `BackgroundJobRuntime`;
2. graceful stop -> bounded wait -> one-process escalation -> actual exit confirmation -> lease release;
3. typed worker capability/health handshake + bounded stdout/stderr;
4. content-addressed generated-asset/provenance store;
5. checkpoint/recovery policy;
6. first lightweight local storyboard/image worker;
7. first local voice worker;
8. FFmpeg/native composite + episode assembly execution;
9. one licensed local video/I2V worker behind the explicit render plan;
10. scale benchmarks: 30 s -> 2 min -> 5 min -> 10 min -> 20 min.

## Do not

- re-disable the chat textarea based on provider readiness;
- require manual provider connection as the normal happy path;
- let a global Autopilot overlay steal Director Chat pointer input;
- copy/read provider credential caches;
- route Claude subscription OAuth as a shipping product provider;
- let chat/provider output bypass typed native validation;
- duplicate canonical characters per episode;
- release worker resources before actual process stop confirmation;
- weaken strict compiler/type/test gates;
- expose patent-sensitive adaptive synthesis-selection logic while the repository is public.

## Quality bar

“100/100” is the engineering target: deterministic behavior, explicit ownership, bounded failure modes, strict tests and product-machine evidence. It is not a claim that software can never contain a defect.
