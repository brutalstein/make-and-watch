# Validation Record

This file records what was actually executed, not what is merely expected to work.

## Foundation history

The repository has progressively passed isolated native validation, strict GitHub Actions, and an earlier Windows/NVIDIA foundation gate. Validated areas include the transactional semantic graph, SQLite persistence/migration, `ProjectSession`, JSONL IPC/process smoke, native-driven Studio, durable history, exact-pointer Autopilot, ResourceManager, BackgroundJobRuntime, cross-episode continuity and deterministic video-plan compilation.

CI/product testing has repeatedly found real defects; fixes have been made without weakening strict type, warning, transaction, lock, persistence or resource invariants.

## 2026-08-29 — Director composer + provider lifecycle corrections

Previously identified Director defects included readiness-gated typing, a full-viewport Autopilot veil stealing chat input, Windows CLI executable discovery gaps, App Server notification races and startup/process ownership issues.

Current code-level behavior:

- Director textarea remains writable before provider readiness;
- first Send may retain a visible queued message while official authentication completes;
- Autopilot owns only workflow geometry, not Director Chat input;
- Windows `.exe/.cmd/.bat` provider discovery is explicit and tested;
- Codex App Server initialization follows `initialize -> initialized` and supports bounded multi-turn chat/planning when available;
- provider processes are bridge-owned and bounded on shutdown.

## 2026-08-29 — Resilient Codex local runtime

Hands-on Windows testing showed a real Codex state where the CLI was installed/authenticated but `codex app-server` exited immediately with code 1. Blocking the whole product behind `Update required` was therefore rejected.

The supported Codex local-client runtime is now:

```text
App Server available -> app_server
App Server unavailable/broken + bounded official codex exec available -> exec_fallback
neither safe path available -> none
```

Code-level checks cover:

- cached static Codex version/help capability probing;
- bounded App Server failure diagnostics;
- ChatGPT-only subscription readiness in compatibility mode;
- API-key/other login does not masquerade as ChatGPT subscription access;
- read-only `codex exec` compatibility turns;
- bounded temporary final-message files removed after every run;
- typed planning additionally requiring output-schema capability;
- bounded in-memory compatibility transcript rather than fake provider-native thread ownership;
- App Server mid-conversation failure may fail over to compatibility mode if the safe exec capability exists;
- active exec/login child ownership during shutdown.

CI helper `codex-exec-runtime-check.mjs` validates login parsing, capability detection and transcript bounds without requiring a real user credential.

## 2026-08-29 — Premium toggleable Studio sidecars

Code-level Studio behavior now includes independent persisted presentation states for:

- Creative Control;
- Director Chat;
- Inspector.

Collapsed panels become narrow cinematic rails and return width to the workflow. The Autopilot interaction veil follows the active sidecar widths.

A screenshot audit found a second outer `.director-panel` scroll container that caused native Windows white scrollbar chrome/arrows. The final CSS forces Creative Control outer overflow hidden and leaves only the inner `chat-history` scroll container. WebKit scrollbar buttons are suppressed and side-panel thumbs use the Studio visual language.

The legacy decorative Inspector chevron is hidden so the real toggle is the sole control.

## 2026-08-29 — Native media/runtime hardening

`SeriesContinuityCompiler` validation includes one canonical Character across Episodes, revision propagation, cross-episode anchors and ambiguous Scene/Shot ownership detection.

`VideoPipelineCompiler` tests include finite dimensions/FPS/duration handling, NaN rejection, duplicate Shot ownership, zero-shot/empty-scene readiness, approval/stale checks and finite accumulated duration. The public compiler still requires explicit `generationStrategy`; patent-sensitive adaptive strategy selection remains excluded.

Resource/runtime audit also hardened allocation-failure windows around scoped resource acquisition and queued-to-running job transitions. Running resources still release only after actual stop/completion confirmation.

## Latest code-level CI

GitHub Actions for code head `4952b1e677ff3354ee950b87943a76dd66729a44` completed successfully.

Passed:

- Bridge and Director checks, including Codex exec compatibility regression;
- strict TypeScript;
- Studio production build;
- native configure/build;
- complete CTest suite.

Subsequent commits before this record are documentation-only.

This proves code-level gates, not the real authenticated Windows product path.

## Required Windows product-machine gate

Fully stop the old runtime, then from repo root:

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

### Codex

1. startup must print the real runtime: `App Server`, `CLI compatibility`, or precise unavailable/auth-required state;
2. if the existing official Codex login is ChatGPT-based and App Server still exits, Studio must use **CLI compatibility** rather than a blocking `Update required` state;
3. type and Send without manual service management;
4. if authentication is required, first Send must preserve the message while official Codex login completes;
5. a second message must preserve bounded conversation continuity;
6. chat/planning alone must not advance native semantic project revision;
7. stopping dev runtime during a turn must leave no owned Codex process orphaned.

### Side panels

1. Creative Control, Director Chat and Inspector each collapse/reopen independently;
2. collapsed width must return smoothly to Workflow;
3. no panel may overlay the workflow;
4. Creative Control must not show the old white native outer scrollbar/arrows;
5. open/closed preferences must survive restart;
6. Autopilot must still protect workflow geometry while Chat remains interactive.

### Exact pointer / native runtime

Retest exact cursor/node alignment, focal camera follow, pause and Esc takeover after side-panel width changes. `verify.ps1` must also keep all native continuity/video/resource/background tests green on Windows.

Any blocking `Update required` despite a safe authenticated fallback, duplicate queued message, credential leakage, orphan process, panel overlap, nested native scrollbar, pointer drift, resource-accounting regression or malformed media acceptance is a failed gate.

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
