# Session Handoff

## Current state

Foundation work is on `foundation/series-engine-v0` and tracked by draft PR #1.

Current foundation includes:

- C++20 transactional semantic project graph, SQLite schema v2 + journal, `ProjectSession`, JSONL IPC and real native host;
- native-driven React/TypeScript Studio;
- exact-pointer AI Autopilot;
- `ResourceManager` + bounded `BackgroundJobRuntime`;
- Codex Director through the official local Codex client with **App Server primary + bounded read-only `codex exec` compatibility fallback**;
- bounded Director chat/planning with zero Codex credential custody;
- independent premium side-panel rails for Creative Control, Director Chat and Inspector;
- cross-episode canonical character continuity compiler;
- deterministic native episode video render-plan compiler;
- public IP boundary excluding patent-sensitive adaptive synthesis selection/scheduling.

## Codex Director — current product behavior

Read `DIRECTOR_PROVIDERS.md` and `AUTH_AND_AI_DIRECTOR.md` before changing provider code.

### Runtime selection

```text
Codex CLI detected
  -> App Server works
       -> app_server
       -> native account/read + browser auth + provider-native chat threads
  -> App Server missing/exits/fails
       -> bounded codex exec probe
       -> codex login status
       -> require ChatGPT session
       -> exec_fallback
```

Important:

- App Server failure must no longer force an unusable `Update required` state if official `codex exec` can safely serve the current ChatGPT session;
- exec fallback requires read-only sandbox + bounded final-message output; typed plans additionally require output-schema support;
- API-key/other Codex login must not silently count as ChatGPT subscription access;
- static `--version` / `--help` probes are cached for bridge lifetime;
- account/login state remains live;
- Make & Watch never reads `~/.codex/auth.json` or any provider token cache;
- shutdown owns active App Server, exec turn and login child processes.

### Composer contract

The text area is always writable unless a message is actually in-flight.

First Send:

```text
ready -> send
not ready -> keep local queued message
          -> start official Codex sign-in
          -> poll sanitized readiness
          -> send only when ready
```

If connection fails before submission, restore text. Do not blindly replay after a turn may have started.

## Premium side-panel ownership

Workflow is the persistent central canvas. Every sidecar is presentation-only and independently collapsible:

```text
[Creative Control] [Director Chat] [Workflow] [Inspector]
       <-> rail          <-> rail             rail <->
```

- `StudioPanelController.tsx` owns Creative Control + Inspector open/rail preferences;
- `DirectorProviderDock` owns Director Chat open/rail preference;
- collapsed width is returned to the workflow through CSS grid variables;
- Autopilot interaction veil tracks active panel widths and owns only workflow geometry;
- side panels remain interactive while Autopilot owns the workflow;
- Creative Control has only one inner scroll container (`chat-history`); do not restore outer `.director-panel` scrolling;
- native Windows scrollbar arrows/white track are suppressed by custom panel scrollbar styling;
- the old decorative Inspector chevron is hidden so the real toggle is the only control;
- presentation toggles never change native project revision.

## Native media foundation

Read `MEDIA_PIPELINE.md` before changing continuity/video planning.

`SeriesContinuityCompiler` preserves one canonical Character node across episodes and rejects ambiguous scene/shot ownership.

`VideoPipelineCompiler` emits deterministic per-shot synthesize/composite tasks plus episode assembly. Current hardening covers finite dimensions/FPS/durations, duplicate shot ownership, zero-shot/empty-scene conditions, approval/stale readiness and canonical continuity readiness.

The public repo still does **not** contain automatic patent-sensitive representation/strategy selection.

## Runtime safety

`ResourceManager` is the hard VRAM/RAM/CPU boundary. `BackgroundJobRuntime` owns leases until real stop/completion confirmation. Exception-safety hardening preserves queued jobs/resources if allocations fail during acquisition/start transitions.

A concrete OS/Python WorkerSupervisor is still not implemented.

## Immediate Windows gate

Fully stop the old runtime first:

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

Expected startup should report the real Codex runtime:

- `Codex Director ready · App Server`, or
- `Codex Director ready · CLI compatibility`, or
- a precise unavailable/auth-required message.

### Director live gate

1. If your existing Codex ChatGPT login is valid and App Server is broken, Studio should use **CLI compatibility** instead of showing a blocking `Update required` state.
2. Type a message immediately and Send; already-authenticated ChatGPT compatibility mode should answer without manual Connect.
3. If not authenticated, first Send must preserve the message while official Codex login completes.
4. Send a second message and verify bounded conversation continuity.
5. Collapse/reopen Creative Control, Director Chat and Inspector independently; workflow must expand/contract smoothly with no overlap.
6. Creative Control must not show the old white outer Windows scrollbar/arrows.
7. Start Autopilot; workflow must remain protected while Director Chat stays usable.
8. Stop the runtime during an active Director turn; no owned Codex process should remain orphaned.
9. Chat/planning alone must not advance native semantic revision.

Any blocking `Update required` despite a usable authenticated exec fallback, duplicate Send, credential leakage, orphan process, nested native scrollbar, panel overlap or workflow interaction leak is a failed gate.

## Next engineering sequence after live provider/UI gate

1. concrete cross-platform WorkerSupervisor over `BackgroundJobRuntime`;
2. graceful stop -> bounded wait -> one-process escalation -> confirmed exit -> lease release;
3. typed worker capability/health handshake + bounded stdout/stderr;
4. content-addressed generated-asset/provenance store;
5. checkpoint/recovery policy;
6. first lightweight local storyboard/image worker;
7. first local voice worker;
8. FFmpeg/native composite + episode assembly execution;
9. one licensed local video/I2V worker behind the explicit render plan;
10. scale benchmarks: 30 s -> 2 min -> 5 min -> 10 min -> 20 min.

## Quality bar

“100/100” is the engineering target: deterministic behavior, explicit ownership, bounded failure modes, strict tests and product-machine evidence. It is not a mathematical claim that software can never contain a defect.
