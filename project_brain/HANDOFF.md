# Session Handoff

## Current branch

Active implementation work is on:

```text
runtime/worker-supervisor-v1
```

It is based on `foundation/series-engine-v0`.

Do not test `main` for the current product implementation; `main` is not the active application branch yet.

## Current state

The foundation now includes:

- C++20 transactional semantic project graph;
- SQLite schema v2 snapshot + append-only journal persistence;
- persist-before-live-commit `ProjectSession`;
- JSONL IPC and real native host;
- native-driven React/TypeScript Studio;
- exact-pointer AI Autopilot;
- `ResourceManager` + bounded `BackgroundJobRuntime`;
- concrete cross-platform `WorkerSupervisor`;
- Codex Director through the official local Codex client with App Server primary + bounded read-only `codex exec` compatibility fallback;
- bounded Director chat/planning with zero Codex credential custody;
- independent premium side-panel rails for Creative Control, Director Chat and Inspector;
- cross-episode canonical character continuity compiler;
- deterministic native episode video render-plan compiler;
- public IP boundary excluding patent-sensitive adaptive synthesis selection/scheduling.

## WorkerSupervisor — current runtime behavior

Read `RUNTIME_FOUNDATION.md` and `BACKGROUND_JOBS.md` before changing worker code.

### Ownership chain

```text
WorkerSupervisor
  -> concrete process tree
  -> typed startup/capability handshake
  -> bounded stdout/stderr
      |
      v
BackgroundJobRuntime
  -> queue / cancellation / sequential shutdown
  -> ResourceLease ownership
      |
      v
ResourceManager
  -> VRAM / RAM / CPU / GPU exclusivity
```

Critical invariant:

> A lease is never released until the complete owned worker process tree is confirmed stopped.

### POSIX

- each worker owns a dedicated process group;
- graceful stop is `MW_STOP_V1` over stdin;
- escalation signals the process group;
- Linux `/proc` liveness distinguishes live descendants from zombie/dead members;
- leader exit with surviving descendants is not completion.

### Windows

- restricted inherited stdio handles;
- suspended launch;
- one Job Object per worker;
- kill-on-job-close protection;
- assign to Job Object before resume;
- actual Windows implementation is compiled/tested in CI under MSVC.

### Startup protocol

```text
MW_READY_V1<TAB>worker-name<TAB>capability-a,capability-b
```

Readiness is bounded. Required capabilities must match before READY. A worker that emits readiness and exits cleanly between pump passes is handled correctly.

### Shutdown

```text
oldest running target
 -> graceful stop
 -> bounded wait
 -> terminate one process tree
 -> bounded wait
 -> hard kill one process tree if required
 -> confirm full tree exit
 -> release exactly one lease
 -> next target
```

The destructor emergency path fails closed if actual process exit cannot be proven.

## Five-pass audit completed on this branch

The repository was re-audited in five separate passes with different failure models:

1. architecture, invariants, persistence ownership and project truth;
2. resource accounting, background jobs, WorkerSupervisor, media compiler;
3. Codex/provider process ownership and bridge lifecycle;
4. Studio/Autopilot plan safety, bounds and UI execution assumptions;
5. CMake/test/CI wiring and cross-platform compilation.

Important corrections from this audit:

- WorkerSupervisor sources were added to the actual native CMake target; before this, new files existed but `verify.ps1` did not compile them;
- real worker-process fixtures/tests now cover handshake, fast clean exit, cancellation lease retention, bounded logs, capability mismatch, uncooperative escalation and sequential shutdown;
- native CI now runs on both Linux and Windows/MSVC, and `runtime/**` branches trigger CI;
- quick worker readiness is processed before exit classification;
- cancellation no longer abandons lifecycle ownership when the cooperative stdin stop channel is broken;
- lifecycle errors fail closed before fresh work admission;
- POSIX Codex/provider children use owned process groups so descendants are included in teardown;
- development runtime shutdown is bounded and process-tree aware;
- native bridge pipe errors are contained instead of becoming process-level EPIPE crashes;
- bridge native-host shutdown now gives clean stdin EOF a bounded grace period before escalation;
- repeated `nvidia-smi` telemetry is coalesced/cached to reduce process churn;
- public HTTP snapshot replacement is disabled until journal-aware recovery exists;
- workspace Autopilot removed redundant per-node waits, speeds long drags, and limits one pass to 120 drag operations so it cannot exceed the v1 128-step contract;
- Autopilot semantic validation simulates command state across the plan, catching duplicate create, removed-node use and invalid dependency endpoints before native mutation;
- Director plan JSON schema now describes concrete project-command variants instead of accepting arbitrary `{type: ...}` objects;
- video compilation now blocks final readiness for stale/unapproved Series state and ambiguous Scene/Shot ownership;
- video compiler graph lookup is indexed instead of repeatedly scanning all nodes for every edge traversal.

## Codex Director — current product behavior

Read `DIRECTOR_PROVIDERS.md` and `AUTH_AND_AI_DIRECTOR.md` before changing provider code.

### Runtime selection

```text
Codex CLI detected
  -> App Server works
       -> app_server
       -> permission-profile negotiation
       -> :read-only
       -> account/read + provider-native threads
  -> App Server missing/exits/fails
       -> bounded codex exec probe
       -> require ChatGPT session
       -> exec_fallback
```

Important:

- App Server failure must not force an unusable state if safe official `codex exec` compatibility works;
- App Server modern path negotiates allowed `:read-only` permissions;
- exec fallback requires read-only sandbox and bounded final-message output;
- API-key/other Codex login must not silently count as ChatGPT subscription access;
- Make & Watch never reads `~/.codex/auth.json` or provider token caches;
- child/stdio errors are guarded;
- provider process trees remain bridge-owned through shutdown.

## Studio / Autopilot ownership

Workflow is the persistent central canvas. Creative Control, Director Chat and Inspector are independent presentation sidecars.

- collapsed sidecars return width to Workflow;
- Autopilot interaction lock owns workflow geometry only;
- Director Chat remains interactive while Autopilot owns Workflow;
- panel presentation state does not mutate semantic project revision;
- semantic mutations still cross typed validation and native transactions;
- built-in workspace organization is now bounded to a safe per-pass step count.

## Media compiler

`SeriesContinuityCompiler` preserves canonical Character identity across episodes.

`VideoPipelineCompiler` emits explicit synthesize/composite/assembly tasks and now checks:

- valid finite video profile;
- exactly one Series for the compiled Episode;
- Series/Episode/Scene/Shot final readiness;
- exactly one Episode parent for each compiled Scene;
- exactly one Scene parent for each compiled Shot;
- explicit bounded generation strategy;
- finite positive duration;
- continuity-anchor readiness;
- zero-scene/zero-shot conditions.

The public compiler still requires explicit `generationStrategy`; patent-sensitive adaptive strategy selection is not in this repository.

## CI state

The new CI topology is:

```text
Native core · Linux
Native core · Windows
Studio contracts and build
```

A post-WorkerSupervisor audit head has already completed all three jobs successfully, including Windows/MSVC native tests. Continue checking the final branch head after every remaining commit; do not infer success from an older SHA.

## Next required gate — user's Windows/NVIDIA machine

After the final GitHub head is green, validate on the actual product machine from the repository root.

First make sure no old Make & Watch/Vite/bridge/native process is still running. Then update the branch and run the local quality gate. Do not merge to `main` before this product-machine gate.

Expected live checks:

1. local `verify.ps1` passes strict TypeScript, Studio build, native compile and complete CTest suite;
2. `dev.ps1` starts the native engine, bridge, Director and Studio without orphan terminals/processes;
3. startup reports real Codex App Server or safe CLI compatibility state;
4. first Codex message returns normally;
5. second message preserves conversation continuity;
6. stopping runtime during an active Director turn leaves no owned Codex process tree;
7. `/api/system` and `/api/project` remain alive after a provider error;
8. Creative Control, Director Chat and Inspector collapse/reopen without overlap;
9. Autopilot cursor/node/camera remain aligned after panel width changes;
10. Autopilot Esc/pause takeover remains immediate;
11. real WorkerSupervisor CTest passes on Windows;
12. final resource snapshot after worker shutdown has zero active workloads.

## Next engineering sequence after the Windows gate

1. content-addressed generated-asset/provenance store;
2. checkpoint/recovery policy;
3. first lightweight local storyboard/image worker over `WorkerSupervisor`;
4. first local voice worker;
5. FFmpeg/native composite + episode assembly execution;
6. one licensed local video/I2V worker behind the explicit native render plan;
7. benchmark harness and scale gates: 30 s -> 2 min -> 5 min -> 10 min -> 20 min.

## Quality bar

“100/100” means deterministic ownership, bounded failure modes, explicit resource accounting, cross-platform tests, product-machine evidence and no known invariant violation. It is not a mathematical claim that a nontrivial software system can never contain an undiscovered defect.
