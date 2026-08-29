# Validation Record

This file records what was actually executed, not what is merely expected to work.

## Foundation history

The repository has progressively passed isolated native validation, strict GitHub Actions, and an earlier full Windows/NVIDIA quality gate. Validated foundation areas include the transactional semantic graph, SQLite persistence/migration, ProjectSession commit semantics, JSONL IPC, process-boundary host smoke, native-driven Studio state, presentation-only layout, durable history, typed Autopilot, ResourceManager and BackgroundJobRuntime.

The primary Windows development environment previously observed was Node v24.11.0, pnpm 10.15.0, CMake 4.1.2, Ninja 1.13.1, GNU C/C++ 15.2 via MSYS2 UCRT64, and an NVIDIA GeForce RTX 5070 Laptop GPU with 8151 MB reported by system doctor. An earlier full `./verify.ps1` gate passed and live Studio opened successfully.

CI/product testing has repeatedly found real defects; they were fixed without weakening type, warning, transaction, lock, persistence or resource invariants.

## 2026-08-29 — Durable native history

Protocol v1 supports bounded attributed `project.history`. `project.apply` validates actor/source/plan/reason context and bounded command batches. SQLite transaction provenance is decoded in native C++ before React.

Real engine-host process smoke performs attributed mutation and reads actor/source/reason back over stdin/stdout from SQLite history.

## 2026-08-29 — Exact pointer redesign and faster cursor-centric camera

Hands-on testing rejected the old independent camera follower because viewport motion, safe-frame rendering clamp and approximate `delta * zoom` integration could separate visible pointer from held node.

The canonical replacement is `workflowPointerInteraction.ts`.

Current behavior:

- rendered pointer coordinate is the logical interaction coordinate;
- off-screen nodes are found with visible bounded workspace pan gestures;
- viewport writes are awaited;
- node anchor is freshly reprojected after viewport changes;
- pointer settles on exact node anchor before press;
- pre-grab/post-drop epsilon checks remain;
- no `delta * zoom` pointer integration;
- every displaced node is handled individually;
- presentation ceiling increased from 24 to **30 FPS** for smoother/faster motion while remaining bounded below display-refresh rate;
- cursor/pan/press/release durations were reduced substantially;
- drag duration is distance-aware and bounded roughly 520–980 ms in the deterministic workspace planner;
- after grab, held node + pointer smoothly enter a workflow focal point;
- each drag frame computes viewport translation required to keep the exact held flow anchor at that cursor focal point;
- viewport update is awaited, then cursor is reprojected from the same exact flow anchor;
- once focused, the node/cursor stay visually anchored while the canvas moves underneath;
- pause freezes held state rather than teleporting/releasing;
- cancellation cleans presentation ownership.

Strict Studio TypeScript and Vite production build passed with this code.

## 2026-08-29 — BackgroundJobRuntime lifecycle gate

Native bounded background lifecycle sits above `ResourceManager`.

Tests prove:

- fixed queued+running capacity;
- duplicate rejection;
- resource-aware first-admissible scan;
- blocked GPU work does not unnecessarily block safe CPU-only work;
- every running job owns a scoped `ResourceLease`;
- cancel request does not release live resources early;
- resources remain reserved until confirmed stop/completion;
- shutdown stops admission and cancels queued work;
- running shutdown is oldest-first, exactly one target at a time;
- wrong-target confirmation fails closed;
- active resource count drains one-by-one to zero.

This layer does not launch media/model processes yet. WorkerSupervisor remains next.

## 2026-08-29 — Project-scoped Director provider bridge

A policy-aware local Director bridge and Studio **DIRECTOR LINK** were added.

### Codex

Current official OpenAI docs were checked. Codex documents **Sign in with ChatGPT for subscription access** in local clients and provides the non-interactive `codex exec` flags used here.

Code-level Codex bridge:

- official `codex login` / status;
- no credential/token reads by Make & Watch;
- `codex exec` read-only sandbox;
- ephemeral session;
- prompt over stdin;
- JSON Schema final output;
- temporary final-message file removed after run;
- finite wall-clock and output-byte bounds;
- one active planning inference maximum.

### Claude policy correction

Anthropic legal/compliance docs were checked after the initial adapter was written. They state third-party product developers should use Claude Console API keys or supported cloud providers and may not route Free/Pro/Max credentials on behalf of users.

The implementation was corrected rather than hiding that constraint:

- public-product Claude status defaults to `api_required`;
- Claude subscription connect/inference is rejected by default;
- existing Claude Code adapter is developer-preview only behind `MAKEWATCH_ENABLE_EXPERIMENTAL_CLAUDE_CODE=1`;
- CI asserts the default policy gate;
- production Claude integration remains a future supported API/Console/cloud path.

### Context economy

The Director is project-specialized through root `AGENTS.md` / `CLAUDE.md`, `AI_DIRECTOR_CONTEXT.md`, typed schema and bounded live graph context rather than fine-tuning or whole-repo prompt dumps.

CI regression bounds:

- <=16,000 prompt characters;
- conservative <=4,000 token estimate;
- <=3,000 objective characters;
- <=72 nodes;
- <=120 included edges;
- allow-listed compact metadata;
- deterministic SHA-256 context hash;
- irrelevant large metadata must not leak into context.

### Process shutdown

Provider status exposed to React is sanitized. Raw auth output is not forwarded.

The bridge now rejects new HTTP work once shutdown starts, terminates an active Director process tree, awaits bounded provider child exit, and only then closes the native host. This is code-level lifecycle ownership; orphan-free behavior with a real authenticated Codex run still requires the Windows live gate.

## 2026-08-29 — Latest code-level CI result

GitHub Actions for code HEAD `ee41476707f8d779803e595d0d72e4a2d9fcba68` completed successfully:

- Studio contracts/build: passed;
- bridge syntax/checks: passed;
- Director context-budget check: passed;
- provider-manager missing-client/sanitized-status/policy check: passed;
- strict TypeScript: passed;
- Vite production build: passed;
- native configure/build: passed;
- complete CTest: passed;
- existing graph, SQLite/history, ResourceManager, BackgroundJobRuntime and process-smoke tests remained passing.

Subsequent commits before this record are documentation-only. Final branch HEAD must still remain CI-green before product-machine handoff.

## Required Windows product-machine gate

From repository root:

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

### Pointer/camera

1. scatter nodes far outside canonical positions;
2. run **Let AI drive this workflow**;
3. verify acquisition is materially faster;
4. cursor lands on the node body exactly;
5. after press, held node/cursor enter focal point and camera follows them;
6. once focused, node/cursor remain visually anchored while canvas travels underneath;
7. release has no visible cursor drift;
8. every displaced node is processed individually;
9. `Space` pause mid-grab freezes without teleport;
10. `Esc` / Take back control cancels immediately;
11. Inspector/topbar remain responsive;
12. Assist layout does not advance native semantic revision;
13. layout persists across restart.

### Codex Director

1. inspect **DIRECTOR LINK**;
2. refresh provider state;
3. Codex should be actionable if current official CLI is installed;
4. if unauthenticated, click **Connect Codex officially** and complete first-party login;
5. refresh until authenticated/capable;
6. submit a small objective;
7. confirm a schema-valid Assist plan preview returns;
8. context estimate must remain <=4K tokens;
9. planning alone must not change native revision;
10. stop `./dev.ps1` while a Codex plan is running and verify no orphan Codex process remains;
11. Claude should display **API required for product** by default.

Any cursor drift/freeze, credential custody, provider-policy bypass, unbounded context, orphan process, stale-revision acceptance or resource-accounting regression is a failed product gate.

## Next after that gate

1. execute provider-generated **Assist** plans through the existing exact Autopilot runtime;
2. Guided plan preview/checkpoint UX before semantic AI mutation;
3. concrete WorkerSupervisor on top of BackgroundJobRuntime;
4. graceful stop -> bounded wait -> one-process escalation -> confirmed exit -> lease release;
5. worker health/capability contract and bounded logs;
6. checkpoint/recovery;
7. content-addressed asset provenance;
8. hardware profile/calibration;
9. lightweight local storyboard/voice workers;
10. production Claude provider through supported Anthropic API/Console/cloud authentication.
