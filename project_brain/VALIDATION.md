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

Hands-on Windows testing showed a real Codex state where the CLI was installed/authenticated but `codex app-server` initially could not be launched through the bridge. Windows `.cmd` shim launching was corrected with explicit `cmd.exe /D /S /C` quoting and verbatim argument ownership. Subsequent live validation reached:

```text
Codex Director ready · App Server · plus
Codex launcher: codex.cmd · path
```

The supported Codex local-client runtime remains:

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
- active exec/login child ownership during shutdown.

## 2026-08-29 — Live App Server wire-contract correction

The first authenticated chat request reached the real Codex App Server and exposed a wire-enum mismatch:

```text
Invalid request: unknown variant `readOnly`, expected one of `read-only`, `workspace-write`, `danger-full-access`
```

The corrected contract is field-specific:

- `thread/start.sandbox = "read-only"`;
- `turn/start.sandboxPolicy.type = "readOnly"`.

Regression tests now assert both values separately so camelCase/kebab-case conventions cannot be accidentally unified again.

## 2026-08-29 — Provider pipe crash isolation + telemetry backoff

A later browser trace showed `/api/director/chat` followed by repeated `/api/system net::ERR_CONNECTION_REFUSED`, indicating the local bridge had exited while Studio remained open.

The Director child-process boundary was hardened:

- all owned provider stdin/stdout/stderr pipes now have explicit `error` listeners;
- Windows `EPIPE`/broken-pipe events are recorded on the child instead of becoming an unhandled EventEmitter error capable of terminating the whole Node bridge;
- the provider executable regression check explicitly emits an `EPIPE` on guarded stdin and proves it is contained;
- higher-level provider logic still observes child exit/request timeout and fails over or reports failure normally.

Studio telemetry was also hardened:

- one system request may be in flight at a time;
- the last valid telemetry value is cached;
- bridge failures use exponential retry backoff from 2.5 s up to 30 s;
- repeated 2.5 s browser fetch spam is suppressed while the bridge is unavailable;
- successful telemetry resets the backoff automatically.

## 2026-08-29 — React Flow attribution compliance

Studio previously set React Flow's `hideAttribution` option and emitted the library's Pro-license warning. Make & Watch does not assume a React Flow Pro subscription. A visible React Flow attribution is now rendered inside the workflow surface with Studio-consistent styling; the matching development warning is filtered only because the attribution is explicitly restored rather than removed.

## 2026-08-29 — Premium toggleable Studio sidecars

Code-level Studio behavior includes independent persisted presentation states for:

- Creative Control;
- Director Chat;
- Inspector.

Collapsed panels become narrow cinematic rails and return width to the workflow. The Autopilot interaction veil follows the active sidecar widths.

A screenshot audit found a second outer `.director-panel` scroll container that caused native Windows white scrollbar chrome/arrows. The final CSS forces Creative Control outer overflow hidden and leaves only the inner `chat-history` scroll container. WebKit scrollbar buttons are suppressed and side-panel thumbs use the Studio visual language.

## 2026-08-29 — Native media/runtime hardening

`SeriesContinuityCompiler` validation includes one canonical Character across Episodes, revision propagation, cross-episode anchors and ambiguous Scene/Shot ownership detection.

`VideoPipelineCompiler` tests include finite dimensions/FPS/duration handling, NaN rejection, duplicate Shot ownership, zero-shot/empty-scene readiness, approval/stale checks and finite accumulated duration. The public compiler still requires explicit `generationStrategy`; patent-sensitive adaptive strategy selection remains excluded.

Resource/runtime audit also hardened allocation-failure windows around scoped resource acquisition and queued-to-running job transitions. Running resources still release only after actual stop/completion confirmation.

## Latest code-level CI

GitHub Actions for code head `5ee898d59ba2beecfbab677d9c089c20c3767a84` completed successfully.

Passed:

- Bridge and Director checks, including Windows launcher, App Server wire enums, Codex exec fallback and provider EPIPE containment;
- strict TypeScript;
- Studio production build;
- native configure/build;
- complete CTest suite.

This proves code-level gates, not the final real authenticated Windows chat-response gate.

## Required Windows product-machine gate

Fully stop the old runtime, then from repo root:

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

### Codex / bridge survival

1. startup reports `Codex Director ready · App Server · plus` or a safe compatibility state;
2. send a normal chat message;
3. the message must return a Codex reply without sandbox-enum error;
4. provider failure, if any, must return a bounded chat error while `/api/system` and `/api/project` remain reachable;
5. browser console must not enter repeated `ERR_CONNECTION_REFUSED` telemetry spam;
6. send a second message and confirm the same conversation continues;
7. chat/planning alone must not advance native semantic project revision;
8. stopping dev runtime during a turn must leave no owned Codex process orphaned.

### Side panels

1. Creative Control, Director Chat and Inspector each collapse/reopen independently;
2. collapsed width must return smoothly to Workflow;
3. no panel may overlay the workflow;
4. Creative Control must not show the old white native outer scrollbar/arrows;
5. open/closed preferences must survive restart;
6. Autopilot must still protect workflow geometry while Chat remains interactive;
7. visible React Flow attribution must remain present in the workflow surface.

### Exact pointer / native runtime

Retest exact cursor/node alignment, focal camera follow, pause and Esc takeover after side-panel width changes. `verify.ps1` must also keep all native continuity/video/resource/background tests green on Windows.

Any bridge termination from a Director failure, blocking provider dead-end, duplicate queued message, credential leakage, orphan process, panel overlap, nested native scrollbar, pointer drift, resource-accounting regression or malformed media acceptance is a failed gate.

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
