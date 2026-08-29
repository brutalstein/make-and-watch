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
- cursor-centric drag camera with deterministic 30 FPS presentation ceiling;
- supported Codex App Server Director bridge with ChatGPT-managed authentication and zero OAuth credential custody;
- default-gated Claude product policy (`api_required`);
- deterministic bounded Director context compiler with valid JSON under budget reduction;
- Studio Director Link integrated into the AI Director sidebar rather than overlaying the workflow.

## Exact pointer / camera milestone

Canonical interaction: `apps/studio/src/director/workflowPointerInteraction.ts`.

```text
pan workspace -> find node -> exact hover -> press ->
held node + cursor enter focal point -> canvas follows underneath ->
release -> verify -> next node
```

Do not reintroduce an independent camera follower. Pointer/node geometry owns the camera during a held drag. Presentation remains capped at 30 FPS, independent of monitor refresh.

## Codex Director milestone

Read `DIRECTOR_PROVIDERS.md`, `AUTH_AND_AI_DIRECTOR.md`, and `AI_DIRECTOR_CONTEXT.md` before changing provider code.

The supported product path is **Codex App Server**:

```text
local bridge
 -> codex app-server
 -> initialize/initialized
 -> account/read
 -> account/login/start(type=chatgpt) if required
 -> account/login/completed + account/updated
 -> thread/start
 -> turn/start(outputSchema, read-only, approvalPolicy=never)
 -> item/completed / turn/completed
 -> thread/delete
```

Key rules:

- Codex owns ChatGPT OAuth persistence/refresh; Make & Watch never receives the token;
- account email is stripped before status leaves the App Server client;
- CLI/App Server/account/planning readiness are separate typed states;
- login is not incorrectly hidden behind planning capability;
- one owned App Server session per bridge;
- one active Director turn maximum;
- early completion notifications cannot race ahead of turn waiter setup;
- timeout/error/shutdown interrupt active turns;
- successful turns are not unnecessarily interrupted after completion;
- every Director thread is deleted after use to avoid hidden transcript accumulation;
- read access is restricted to `tools/director/runtime` during Director turns;
- provider output remains only a proposal and must pass live revision + Autopilot validation.

Claude remains `api_required` in the public product. The Claude Code adapter is developer-preview only behind `MAKEWATCH_ENABLE_EXPERIMENTAL_CLAUDE_CODE=1`.

## Director Link UX

`DirectorProviderDock` is mounted through a portal into a real `.director-provider-slot` immediately after the Autopilot card inside the left AI Director panel.

It must never use a fixed page overlay again.

The sidebar owns its own scroll; the workflow canvas size must not change because Director Link expands. Global document scrolling is disabled by `layout-safety.css`; Director and Inspector panels scroll internally.

Codex readiness is shown as four stages:

1. CLI;
2. APP SERVER;
3. ACCOUNT;
4. PLAN.

When ChatGPT login is required, Studio opens the official App Server `authUrl` from the user's click and boundedly polls sanitized status. Objective/plan controls appear only when planning is actually available.

## Context economy

Runtime prompts do not resend the repository/project brain/journal. Hard bounds remain:

- <=16,000 characters;
- conservative <=4,000 tokens;
- <=3,000 objective characters;
- <=72 nodes before reduction;
- <=120 edges before reduction;
- allow-listed bounded metadata only.

If needed, the compiler reduces dependency/node/objective/metadata scope deterministically. It never slices JSON mid-string. CI asserts deterministic output, valid JSON after reduction, selected-node retention and hard budget compliance.

## Background runtime milestone

`BackgroundJobRuntime` sits above `ResourceManager`; it does not launch model/media workers yet.

Rules:

- fixed queued+running capacity;
- duplicate IDs rejected;
- resource-aware ready scan prevents safe CPU work from being blocked behind unavailable GPU work;
- cancel request does not release a running worker's VRAM/RAM/CPU lease;
- shutdown stops admission, clears queued work and drains one running target at a time;
- wrong-target confirmation fails closed;
- lease releases only after confirmed stop.

Concrete WorkerSupervisor remains the next native process layer after the new Director live gate.

## CI / audit state

Repository tree and PR changed-file inventory were audited across Studio, Director/bridge, contracts/schemas, native engine/runtime/tests, scripts/build config and canonical docs. High-risk runtime/provider/UI/native boundaries were deep-read. Do not represent this as a mathematical guarantee of zero defects; CI + product-machine evidence remain required.

CI now uses Node-24-generation GitHub Actions (`checkout@v7`, `setup-node@v7`, `pnpm/action-setup@v6`). The repository currently has no committed `pnpm-lock.yaml`, so install intentionally remains `--no-frozen-lockfile`; adding a committed lockfile is a separate reproducibility improvement.

Current gates include:

- seed and bridge syntax;
- Director context hard-budget/valid-JSON regression;
- Windows provider executable discovery simulation;
- Codex App Server protocol fake-process test;
- provider policy/status sanitization checks;
- strict TypeScript;
- Vite production build;
- strict native configure/build;
- complete CTest suite.

## Immediate Windows gate

Fully stop the old dev runtime first, then:

```powershell
git pull
.\verify.ps1
.\dev.ps1
```

### Director Link / Codex

1. Director Link must appear inside the left AI Director panel directly under the Autopilot card; it must not cover or resize the workflow canvas.
2. The browser page itself must not gain a vertical scrollbar; Director/Inspector panels scroll internally.
3. Codex should show CLI -> APP SERVER readiness.
4. If ACCOUNT is not ready, **Connect Codex officially** must be actionable.
5. The user click opens the official ChatGPT sign-in URL returned by App Server.
6. After sign-in, ACCOUNT and PLAN should become ready without restarting Studio.
7. Objective input should appear only when PLAN is ready.
8. Submit a small objective and confirm a schema-valid Assist-plan preview plus bounded context stats.
9. Planning alone must not change native semantic revision.
10. Stop `dev.ps1` during an active turn and verify no orphan `codex app-server` process remains.
11. Claude should show its CLI if installed but remain **API required for product** by default.

### Pointer

Retest exact cursor/node alignment, focal camera follow, pause and Esc cancellation after the layout changes. Director Link must not affect workflow geometry.

Any unusable readiness state, popup/login dead-end, workflow overlap, global scrolling, pointer drift, credential custody, stale-revision acceptance, unbounded context or orphan process is a failed live gate.

## Next engineering sequence

1. after live Codex validation, execute provider-generated **Assist** plans through the existing exact Autopilot runtime;
2. add Guided plan preview/checkpoint UX before semantic AI mutation;
3. implement concrete cross-platform WorkerSupervisor over `BackgroundJobRuntime`;
4. graceful stop -> bounded wait -> one-process escalation -> actual exit confirmation -> lease release;
5. typed worker health/capability handshake and bounded logs;
6. checkpoint/recovery policy;
7. content-addressed asset/provenance storage;
8. hardware profile probing/calibration;
9. first lightweight local voice/storyboard workers;
10. production Claude provider through a supported Anthropic API path.

## Do not

- reintroduce a fixed Director Link overlay over workflow space;
- reintroduce a separate hidden Autopilot camera follower;
- copy/read provider credential caches;
- route Claude subscription OAuth as a public-product provider;
- accumulate hidden Codex planning threads;
- send the full repo/project journal per Director request;
- let provider output bypass typed/native validation;
- release running worker resources before actual stop confirmation;
- weaken strict compiler/type/test gates;
- expose patent-sensitive adaptive synthesis-selection logic while the repo is public.

## Quality bar

“100/100” is the engineering target: deterministic behavior, explicit ownership, bounded failure modes, strict tests and product-machine evidence. It is not a claim that software can never contain a defect.
