# Validation Record

This file records what was actually executed, not what is merely expected to work.

## Foundation history

The repository has progressively passed isolated native validation, strict GitHub Actions, and an earlier Windows/NVIDIA foundation gate. Validated areas include the transactional semantic graph, SQLite persistence/migration, ProjectSession commit semantics, JSONL IPC, process-boundary host smoke, native-driven Studio state, presentation-only workflow layout, durable history, exact-pointer Autopilot, ResourceManager and BackgroundJobRuntime.

The earlier Windows environment observed Node v24.11.0, pnpm 10.15.0, CMake 4.1.2, Ninja 1.13.1, GNU C/C++ 15.2 through MSYS2 UCRT64, and an NVIDIA GeForce RTX 5070 Laptop GPU with 8151 MB reported by system doctor.

CI/product testing has repeatedly found real defects; fixes have been made without weakening strict type, warning, transaction, lock, persistence or resource invariants.

## 2026-08-29 — Codex App Server and multi-turn Director Chat

The old ad-hoc Codex execution concept is superseded by the official **Codex App Server** product-embedding path.

Code-level validated behavior includes:

- bridge-owned App Server process;
- initialize/initialized handshake;
- sanitized `account/read` state with account email stripped;
- ChatGPT-managed login initiation without token custody;
- read-only/no-approval Director turns;
- schema-constrained planning;
- bounded multi-turn chat threads;
- explicit thread deletion;
- finite protocol/output/turn/shutdown bounds;
- rejection of unexpected interactive server tool requests;
- bounded context compiler tests;
- provider policy/status sanitization tests.

The fake-process App Server regression test verifies protocol sequencing without requiring a real user account.

## 2026-08-29 — Disabled-composer root-cause correction

A concrete UI defect was identified: Director Chat textarea/send readiness was gated by `chatAvailable`, so the browser disabled typing while Codex was still initializing or waiting for ChatGPT authentication.

The code path was redesigned:

- textarea is no longer disabled by provider readiness;
- user may type immediately;
- first Send can initiate the official ChatGPT flow if required;
- unsent text remains locally queued while authentication completes;
- queued text is submitted only after sanitized status reports chat readiness;
- failure before submission restores text to the composer;
- possible failure after provider submission is not blindly auto-replayed.

A second interaction defect was found: Autopilot's full-viewport veil and Director CSS could steal pointer input from chat. The effective lock is now scoped to workflow-canvas geometry while Director Chat stays interactive.

## 2026-08-29 — Automatic Codex warm-up

`tools/dev-runner.mjs` now prepares the Director service before Studio startup:

1. native host build;
2. bridge/native session start;
3. bridge health wait;
4. `/api/director/providers` warm-up, which initializes owned Codex App Server when available;
5. Vite Studio start.

Warm-up failure remains non-fatal because local project operation must work without AI.

The authenticated/non-authenticated branches still require the real Windows product-machine gate because CI cannot contain the user's ChatGPT session or validate browser popup behavior.

## 2026-08-29 — Cinematic toggleable chat UI

Code-level Studio validation now includes a separate Director Chat sidecar with:

- persisted open/closed preference;
- narrow collapsed rail;
- animated grid-width transition;
- connection diagnostics in a collapsible drawer;
- readable message/composer typography;
- queued-message state;
- reduced-motion handling.

Strict TypeScript and Vite production build pass with this component.

Visual quality, popup behavior and exact desktop sizing still require live screenshot/product testing.

## 2026-08-29 — Cross-episode continuity compiler

Native `SeriesContinuityCompiler` validation covers:

- one canonical Character reused across multiple Episodes;
- Character revision propagation;
- cross-episode identity anchor detection;
- lock/freshness/final-approval readiness;
- stale Series readiness;
- duplicate Shot ownership under multiple Scenes reported without duplicate continuity binding.

The compiler also detects Scene ownership ambiguity across Episodes.

## 2026-08-29 — Video render-plan hardening

Native `VideoPipelineCompiler` has deterministic per-Shot synthesis/composite tasks plus Episode assembly.

Tests now exercise hostile/malformed media inputs:

- NaN FPS rejected;
- dimensions/FPS bounded in native code;
- `durationSeconds="nan"` is not accepted as usable duration;
- Scene stale state blocks final readiness;
- Episode draft state blocks final readiness;
- missing explicit generation strategy blocks final readiness;
- duplicate Shot ownership does not create duplicate synthesis tasks;
- Episode with no usable Shots is not final-ready;
- accumulated duration remains finite.

The compiler still intentionally requires an explicit `generationStrategy`; patent-sensitive automatic strategy selection is not public.

## 2026-08-29 — Runtime exception-safety hardening

A code audit found allocation-failure windows around resource/job state transitions.

Corrections:

- `ResourceManager::try_acquire_scoped` stages lease identity before mutating active resource accounting;
- `BackgroundJobRuntime::start_one_ready` stages queued request data before resource admission;
- running-map commit happens before the queued source is erased;
- if running-map/value construction fails, RAII lease ownership releases reserved resources while the original queued job remains available.

Normal cancellation/shutdown semantics remain unchanged: a running worker's resource lease is not released until actual stop/completion confirmation.

## Latest code-level CI

GitHub Actions for code head `578c46e3fc2c226085a43977d4ced79dc8ee9125` completed successfully before the subsequent documentation-only synchronization commits.

Passed jobs/steps:

- Bridge and Director checks;
- strict TypeScript;
- Vite production build;
- native configure;
- warning-policy native build;
- complete CTest suite.

A newer final documentation head should also be checked before handoff, but documentation-only changes do not replace the required Windows live gate.

## Required Windows product-machine gate

From repository root:

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

### Startup / Director Chat

1. terminal prints `Preparing Codex Director service…` before Studio starts;
2. if already authenticated, it reports Codex Director ready;
3. if auth is required, App Server is prepared without requiring the user to manually run a CLI service;
4. collapse Chat to the narrow rail and reopen it; workflow resizes cleanly;
5. before pressing manual Connect, click the composer and type — it must accept text immediately;
6. press Send;
7. if already authenticated, message sends directly;
8. if auth is required, official ChatGPT sign-in opens from the Send gesture and the unsent message remains visibly queued;
9. after sign-in, queued message sends automatically;
10. send a second message and confirm same conversation continuity;
11. Connections drawer opens/closes without displacing conversation incorrectly;
12. start Autopilot and confirm Chat remains interactive while manual workflow geometry input remains blocked;
13. stop dev runtime during an active turn and verify no orphan `codex app-server` process remains;
14. restart and confirm Chat open/closed presentation preference is restored;
15. Claude remains API-required for product by default.

### Exact pointer

Retest node acquisition, exact hover, held node/cursor alignment, camera follow, pause and Esc takeover. Chat sidecar layout must not change pointer geometry.

### Native media/runtime

`verify.ps1` must keep all continuity, video compiler, resource manager and background lifecycle tests green on the Windows compiler/toolchain.

Any disabled composer, login dead-end, duplicate queued message, orphan App Server, workflow interaction leak during Autopilot, cursor drift, resource-accounting regression, media NaN acceptance or duplicate render-task identity is a failed gate.

## Next after the live gate

1. concrete WorkerSupervisor over BackgroundJobRuntime;
2. graceful stop -> bounded wait -> one-process escalation -> confirmed exit -> lease release;
3. typed worker capability/health handshake and bounded logs;
4. content-addressed asset/provenance storage;
5. checkpoint/recovery;
6. first local storyboard/image worker;
7. first local voice worker;
8. FFmpeg/native composite/assembly execution;
9. first licensed local video/I2V worker behind the explicit native plan;
10. measured long-form scaling from 30 seconds toward 20 minutes.
