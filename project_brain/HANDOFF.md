# Session Handoff

## Current state

Foundation work is on `foundation/series-engine-v0` and tracked by draft PR #1.

The current foundation includes:

- C++20 transactional semantic project graph with typed commands/events, revisions, locks, approvals, staleness, dependency invalidation, impact preview, snapshots and guarded hydration;
- SQLite schema v2 with WAL, foreign keys, atomic snapshot + append-only journal persistence and v1 migration;
- `ProjectSession` persist-before-live-commit semantics;
- durable commit provenance and bounded native `project.history`;
- JSONL IPC v1 + real `makewatch_engine_host` process;
- localhost bridge and native-driven React/TypeScript Studio;
- presentation-only workflow layout separated from semantic state;
- Durable Activity backed by native history;
- generic native `ResourceManager` plus bounded `BackgroundJobRuntime` lifecycle ownership;
- typed AI Director Autopilot with exact-revision validation, pause/resume/cancel/checkpoints and emergency takeover;
- exact workflow pointer pick-and-place for every displaced node;
- cursor-centric drag camera: held node + virtual pointer move into a focal point and remain there while the canvas travels underneath;
- deterministic **30 FPS** presentation ceiling with awaited viewport frames;
- policy-aware Director provider bridge with zero OAuth credential custody;
- supported local Codex/ChatGPT sign-in path plus default-gated Claude product policy;
- bounded project-specific Director context compiler and schema-constrained plan output;
- Studio `DIRECTOR LINK` for policy-aware status/login and validated Assist-plan preview.

## Exact pointer / camera milestone

Canonical interaction: `apps/studio/src/director/workflowPointerInteraction.ts`.

```text
pan workspace -> find node -> exact hover -> press ->
held node + cursor enter focal point -> canvas follows underneath ->
release -> verify -> next node
```

Guarantees:

- off-screen nodes are found by visible bounded workspace pan gestures;
- cursor lands on a freshly projected node anchor before grab;
- rendered/logical cursor coordinates are identical;
- no `delta * zoom` approximation;
- after grab, viewport translation is recomputed and awaited each deterministic frame so the held exact flow anchor stays at the cursor focal point;
- cursor is reprojected after each viewport write;
- pre-grab/post-drop alignment checks remain active;
- every displaced node is handled individually;
- presentation is capped at 30 FPS, independent of monitor refresh;
- cursor/pan/drag timings are faster than the first exact-pointer pass while retaining readable press/release phases;
- pause freezes the held state and cancellation removes presentation ownership.

Do not reintroduce an independent camera follower. The pointer primitive owns camera movement while a node is held.

## AI Director provider milestone

Read `DIRECTOR_PROVIDERS.md`, `AUTH_AND_AI_DIRECTOR.md`, and `AI_DIRECTOR_CONTEXT.md` before modifying provider code.

### Codex

Codex is the primary local subscription-backed Director bridge to validate. Make & Watch invokes the official client for `codex login`, status, and schema-constrained `codex exec`; it never reads/copies the resulting credential.

### Claude

Anthropic's current third-party product policy requires an API/Console or supported cloud-provider path. Claude Code subscription routing is therefore `api_required` and not actionable by default. The existing Claude Code adapter is developer-preview only behind `MAKEWATCH_ENABLE_EXPERIMENTAL_CLAUDE_CODE=1`; do not make that the shipping default.

Current bridge endpoints:

- `GET /api/director/providers`;
- `POST /api/director/connect`;
- `POST /api/director/plan`.

Provider rules:

- explicit provider policy state;
- one active Director inference maximum;
- finite timeout/output bounds;
- shutdown rejects new HTTP work, terminates the active provider child tree, **awaits bounded child exit**, then closes the native host;
- raw auth/status output is not forwarded to React;
- prompts travel through stdin;
- Codex uses read-only sandbox, ephemeral run and JSON Schema final output;
- Claude developer preview uses one turn, plan permission, built-in tools disabled, MCP denied and JSON Schema structured output;
- provider output remains only a proposal and must pass Studio/live-native validation.

The current provider phase is **Assist-plan preview only**. Login does not grant semantic write authority.

## Context economy

Root `AGENTS.md` / `CLAUDE.md` carry provider-native project instructions. `AI_DIRECTOR_CONTEXT.md` is canonical policy.

Runtime prompts do not resend the full policy/repository. The context compiler sends a short invariant reminder, policy hash and bounded live graph slice.

Hard bounds:

- <=16,000 prompt characters;
- conservative estimate <=4,000 tokens;
- <=3,000 objective characters;
- <=72 nodes;
- <=120 included dependency edges;
- allow-listed bounded metadata only.

Context serialization is deterministic and SHA-256 hashed. CI rejects context-budget growth and irrelevant large metadata leakage.

## Background runtime milestone

`BackgroundJobRuntime` sits above `ResourceManager`; it does not launch media/model processes yet.

Rules:

- fixed queued+running capacity;
- duplicate IDs rejected;
- resource-aware ready scan avoids safe CPU work being blocked behind unavailable GPU work;
- running cancellation keeps VRAM/RAM/CPU lease until actual stop confirmation;
- shutdown stops admission, clears queued work and exposes one running target at a time;
- wrong-target confirmation fails closed;
- leases release one-by-one only after confirmed stop.

Concrete WorkerSupervisor remains the next native process layer.

## Validation status

CI currently covers:

- bridge/fixture syntax and development seed;
- Director context-budget regression;
- provider-manager missing-client/sanitized-status/policy smoke;
- strict shared/Studio TypeScript;
- Vite production build;
- strict native configure/build;
- full CTest including graph, persistence/history, ResourceManager, BackgroundJobRuntime and native-host smoke.

Authenticated Codex behavior and the newest 30 FPS cursor-camera choreography still require Windows product-machine validation.

## Immediate Windows gate

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

### Pointer

1. scatter nodes far apart, including outside viewport;
2. run **Let AI drive this workflow**;
3. verify finding/pickup is clearly faster;
4. cursor lands exactly on node;
5. after grab, cursor/node move toward focal point and camera travels with them;
6. once focused, cursor/node remain visually anchored while canvas moves underneath toward destination;
7. release has no visible pointer drift;
8. every displaced node is processed individually;
9. `Space` pause mid-drag freezes without teleport;
10. `Esc` cancels immediately;
11. Studio remains responsive and Assist layout does not change native semantic revision.

### Director provider

1. inspect **DIRECTOR LINK**;
2. refresh status;
3. Codex should be the actionable local-client option when installed;
4. if needed use **Connect Codex officially** and complete the first-party flow;
5. refresh until Codex is authenticated/capable;
6. submit a small objective;
7. confirm schema-valid Assist plan preview;
8. confirm estimated context <=4K tokens;
9. confirm planning alone does not change native revision;
10. while a plan is running, stop `./dev.ps1` and verify no orphan Codex child remains;
11. Claude should show **API required for product** by default, not a subscription-connect button.

Any pointer drift/freeze, credential custody, policy bypass, unbounded context, orphan process or stale-revision acceptance is a failed gate.

## Next engineering sequence

1. after live Codex validation, allow provider-generated **Assist** plans to execute through the existing exact Autopilot runtime;
2. add Guided plan preview/checkpoint UX before semantic AI mutation;
3. concrete cross-platform WorkerSupervisor on top of `BackgroundJobRuntime`;
4. graceful stop -> bounded wait -> one-process escalation -> confirmed exit -> lease release;
5. typed worker health/capability handshake and bounded logs;
6. checkpoint/recovery policy;
7. content-addressed asset/provenance storage;
8. hardware-profile probing/calibration;
9. first lightweight local voice/storyboard workers;
10. production Claude provider via supported Anthropic API/Console/cloud path.

## Do not

- reintroduce a separate hidden camera follower;
- use stale DOM coordinates or `delta * zoom` pointer integration;
- couple presentation cadence to display refresh rate;
- copy/read provider credential caches;
- enable Claude subscription routing as the public product default;
- expose raw auth status to React/logs;
- resend the whole repo/project brain on each Director request;
- let provider output bypass Autopilot/native validation;
- grant semantic write authority because login succeeded;
- free running-job resources on cancel request before stop confirmation;
- launch media workers outside background runtime/future supervisor ownership;
- weaken strict gates;
- expose patent-sensitive adaptive synthesis-selection logic while repo is public.

## Quality bar

“100/100” is the engineering target: deterministic behavior, explicit ownership, bounded failure modes, strict tests and product-machine evidence. It is not a claim that software can never contain a defect.
