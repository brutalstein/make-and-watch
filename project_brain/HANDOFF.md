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
- first-party Codex/Claude Director bridge with zero OAuth credential custody;
- bounded project-specific Director context compiler and schema-constrained plan output;
- Studio `DIRECTOR LINK` for first-party status/login and validated Assist-plan preview.

## Exact pointer / camera milestone

The canonical interaction lives in `apps/studio/src/director/workflowPointerInteraction.ts`:

```text
pan workspace -> find node -> exact hover -> press ->
held node + cursor enter focal point -> canvas follows underneath ->
release -> verify -> next node
```

Important guarantees:

- off-screen nodes are found by visible bounded workspace pan gestures;
- cursor lands on a freshly projected node anchor before grab;
- rendered and logical cursor coordinates are identical;
- drag never uses `delta * zoom` approximation;
- after grab, viewport translation is recomputed and awaited every deterministic frame so the exact flow anchor stays at the cursor focal point;
- cursor is reprojected after each viewport write;
- pre-grab and post-drop alignment are checked;
- every displaced node is handled individually;
- presentation cadence is capped at 30 FPS, not monitor refresh rate;
- cursor/pan/drag timings are substantially faster than the first exact-pointer pass while preserving visible press/release phases;
- pause freezes current held state; cancellation clears presentation ownership immediately.

Do not reintroduce an independent camera follower. The pointer interaction primitive itself owns camera movement while a node is held.

## First-party AI Director milestone

Read `DIRECTOR_PROVIDERS.md`, `AUTH_AND_AI_DIRECTOR.md`, and `AI_DIRECTOR_CONTEXT.md` before changing this layer.

Make & Watch does not implement subscription OAuth itself. It invokes the user's official local client:

- Codex: official `codex login`, `codex login status`, `codex exec`;
- Claude Code: official Claude login/status commands and non-interactive print mode.

Current bridge endpoints:

- `GET /api/director/providers`;
- `POST /api/director/connect`;
- `POST /api/director/plan`.

Provider planning rules:

- one active Director inference maximum;
- finite timeout/output limits;
- bridge shutdown terminates active provider child process tree;
- status returned to React is sanitized;
- prompts travel through stdin;
- Codex uses read-only sandbox, ephemeral session and JSON Schema output;
- Claude uses one turn, plan permission, all built-in tools disabled, MCP tools denied and JSON Schema structured output;
- provider result is still only a proposal and must pass Studio Autopilot validation/live revision checks.

The current Studio provider phase requests **Assist-mode preview plans only**. It deliberately does not grant semantic write authority yet.

## Context economy

Root `AGENTS.md` / `CLAUDE.md` carry provider-native project instructions. `AI_DIRECTOR_CONTEXT.md` is the canonical policy.

Runtime prompts avoid resending that full policy. The context compiler sends a short invariant reminder, canonical policy hash and bounded live graph slice.

Hard bounds:

- <=16,000 prompt characters;
- conservative estimate <=4,000 context tokens;
- <=3,000 objective characters;
- <=72 nodes;
- <=120 included dependency edges;
- allow-listed compact metadata only.

The context pack is deterministic and SHA-256 hashed. CI has a regression test against context growth and irrelevant metadata leakage.

## Background runtime milestone

`BackgroundJobRuntime` sits above `ResourceManager`. It does not launch model/media processes yet.

Key rules:

- queued + running work has fixed capacity;
- duplicate IDs rejected;
- resource-aware ready scan avoids safe CPU work being blocked behind unavailable GPU work;
- running cancellation retains VRAM/RAM/CPU lease until actual stop confirmation;
- shutdown stops admission, clears queued work and exposes exactly one running stop target at a time;
- wrong-target confirmation fails closed;
- leases release one-by-one only after confirmed worker stop.

Concrete WorkerSupervisor remains next native process layer.

## Validation status

CI validates code structure without authenticated user subscriptions. Current gates include:

- bridge/fixture syntax and development seed check;
- deterministic Director context-budget regression check;
- provider-manager missing-client/sanitized-status smoke;
- strict shared/Studio TypeScript;
- Vite production build;
- strict native configure/build;
- full CTest including graph, persistence/history, ResourceManager, BackgroundJobRuntime and real native-host smoke.

Authenticated first-party provider behavior and the newest 30 FPS cursor-camera choreography still require Windows product-machine validation.

## Immediate Windows gate

From repository root:

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

### Pointer

1. scatter nodes far apart, including outside viewport;
2. run **Let AI drive this workflow**;
3. verify finding/pickup is visibly faster than previous version;
4. cursor lands on node exactly;
5. after grab, cursor/node move toward the workflow focal point and camera travels with them;
6. once focused, cursor/node stay visually anchored while canvas moves underneath toward the destination;
7. release occurs on target with no visible pointer drift;
8. every displaced node is processed individually;
9. `Space` pause mid-drag freezes without teleport;
10. `Esc` cancels immediately;
11. Studio stays responsive and native semantic revision does not change from Assist layout.

### Director provider

1. inspect new **DIRECTOR LINK** panel;
2. refresh provider status;
3. select installed Codex or Claude;
4. if unauthenticated, use **Connect ... officially** and complete the first-party browser/client flow;
5. refresh until provider reports authenticated/capable;
6. submit a small objective;
7. confirm a schema-valid Assist plan is reported;
8. confirm context token estimate stays within budget;
9. confirm native project revision does not change merely from provider planning;
10. close `./dev.ps1` while a provider request is running and verify no orphan CLI process remains.

Any pointer drift, freeze, auth-token custody, unbounded context, orphan process or stale-revision acceptance is a failed gate.

## Next engineering sequence

1. enable provider-generated Assist plan execution through the existing Autopilot runtime after live provider validation;
2. add Guided plan preview/checkpoint UX before semantic AI mutation;
3. concrete cross-platform WorkerSupervisor on top of `BackgroundJobRuntime`;
4. graceful stop -> bounded wait -> single-process escalation -> confirmed exit -> lease release;
5. typed worker health/capability handshake and bounded logs;
6. checkpoint/recovery policy;
7. content-addressed asset/provenance storage;
8. hardware-profile probing/calibration;
9. first lightweight local voice/storyboard workers.

## What not to do

- Do not reintroduce a separate hidden camera follower.
- Do not use stale DOM coordinates or `delta * zoom` pointer integration.
- Do not couple Autopilot presentation cadence to display refresh rate.
- Do not copy/read Codex or Claude OAuth credential caches.
- Do not expose raw first-party auth status text to React/logs.
- Do not resend the entire repository/project brain on every Director request.
- Do not allow provider output to bypass typed Autopilot/native validation.
- Do not grant semantic write authority just because provider login succeeded.
- Do not free running-job resources when cancellation is merely requested.
- Do not launch media workers outside `BackgroundJobRuntime`/future WorkerSupervisor ownership.
- Do not weaken strict type/compiler/test gates.
- Do not publicly disclose patent-sensitive adaptive synthesis-selection logic while the repo is public.

## Quality bar

“100/100” is the engineering target: deterministic behavior, explicit ownership, bounded failure modes, strict tests and product-machine evidence. It is not a claim that software can never contain a defect.
