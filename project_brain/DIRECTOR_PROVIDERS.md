# AI Director Providers

## Goal

Make & Watch uses a cloud reasoning/Director layer while authoritative project state, media generation, worker lifecycle and rendering remain local.

This is **project-scoped specialization**, not model fine-tuning. Provider conversation is useful creative context, but it is never project truth.

## Authentication boundary

Make & Watch must never copy credential caches, session tokens or subscription OAuth tokens.

Official references checked 2026-08-29:

- OpenAI Codex App Server: https://developers.openai.com/codex/app-server
- OpenAI Codex authentication: https://developers.openai.com/codex/auth
- OpenAI Codex `AGENTS.md`: https://developers.openai.com/codex/guides/agents-md
- Anthropic Claude Code legal/compliance: https://docs.anthropic.com/en/docs/claude-code/legal-and-compliance

## Codex — resilient supported local-client path

The preferred integration is **Codex App Server**, but the product must not become unusable merely because an installed official Codex CLI build cannot keep App Server alive.

Current runtime selection is deterministic:

```text
Codex CLI detected
      |
      +-- app-server advertised + initializes
      |       -> app_server
      |       -> account/read
      |       -> ChatGPT browser auth when needed
      |       -> native Codex threads for multi-turn chat
      |
      +-- app-server unavailable/broken
              -> bounded codex exec capability probe
              -> codex login status
              -> ChatGPT subscription session required
              -> exec_fallback
              -> bounded read-only compatibility chat/plan
```

`runtimeMode` is surfaced as `app_server`, `exec_fallback`, or `none`.

### App Server mode

One bridge-owned App Server process handles sanitized account state, login, bounded chat threads and schema-constrained planning:

```text
initialize -> initialized -> account/read
      |
      +-- auth needed -> account/login/start(type=chatgpt)
      |                 -> official browser flow
      |                 -> account/login/completed / account/updated
      |
      +-- chat -> thread/start -> repeated turn/start -> thread/delete
      |
      +-- plan -> thread/start -> turn/start(outputSchema) -> thread/delete
```

Codex owns OAuth persistence/refresh. Make & Watch receives sanitized account type/plan state and, when needed, the official auth URL. Account email and token material are stripped before provider state reaches React.

### Exec compatibility mode

`tools/director/codex-exec-runtime.mjs` provides a bounded compatibility path when App Server exits or is missing from the installed official CLI.

Rules:

- uses the same official local Codex executable and cached login session;
- requires `codex login status` to identify a **ChatGPT** session before product chat is enabled;
- API-key/other auth must not silently masquerade as subscription access;
- runs `codex exec` with read-only sandbox and prompt over stdin;
- final output is collected from a bounded temporary `--output-last-message` file and the temp directory is always removed;
- typed planning additionally requires `--output-schema`;
- chat keeps only a bounded in-memory recent transcript window rather than pretending CLI exec has native thread state;
- transcript is conversation context only and never project truth;
- App Server failure is preserved as a diagnostic issue instead of blocking a working CLI fallback.

Static `--version` / `--help` capability probes are cached for the bridge lifetime so readiness polling does not continuously spawn probe processes. Login/account readiness remains live.

## Automatic startup / simple-user contract

The developer runtime must prepare infrastructure rather than make the user manage services.

`tools/dev-runner.mjs`:

1. builds the native host;
2. starts the local bridge/native session;
3. waits for bridge health;
4. warms Director provider status before Vite starts;
5. reports the real Codex runtime (`App Server`, `CLI compatibility`, or unavailable);
6. starts Studio.

If a ChatGPT account is already connected, chat should be usable immediately. If sign-in is required, first Send initiates the policy-permitted official login flow while preserving the queued user message.

Director warm-up failure is non-fatal because local project operation must remain possible without an AI provider.

## Composer/readiness rule

Provider readiness must **not** disable the chat text area.

The current first-Send behavior is:

```text
user types immediately
 -> Send
 -> chat ready? yes -> submit turn
 -> chat ready? no  -> start official Codex login from this user gesture
                     -> retain message locally as queued
                     -> poll sanitized readiness
                     -> submit queued message only after chat becomes ready
```

If connection fails before submission, Studio restores the text to the composer. If failure happens after a provider turn may have started, Studio avoids automatic replay to prevent duplicate turns.

Manual Connect remains available inside the Connections drawer as a recovery/control surface, not the normal mandatory path.

## Multi-turn ownership

App Server mode uses one native Codex thread per Director conversation.

Exec compatibility mode uses a bounded in-memory transcript window because it cannot claim provider-native thread ownership.

Common bounds:

- finite active conversation count;
- one active provider run at a time;
- finite turn/process timeouts;
- bounded prompt/reply/output sizes;
- read-only execution policy;
- explicit conversation cleanup on New conversation/close/shutdown;
- provider process remains bridge-owned while active.

Chat is creative context only; it cannot mutate SQLite/native project state.

## Planning path

A provider plan must be schema-constrained and pass:

```text
provider
 -> AutopilotPlan schema
 -> Studio validation
 -> exact live native revision check
 -> autonomy/capability policy
 -> optional checkpoint
 -> native ProjectSession transaction if execution is later authorized
```

Current provider-generated plans remain Assist-preview oriented. Login, chat, or planning alone grants no semantic write authority.

## Claude — policy-gated by default

Claude Code subscription login is not treated as a supported third-party product auth path.

Public behavior:

- Claude CLI may be detected and displayed;
- production Claude chat/planning requires a supported Anthropic API/Console/cloud-provider path;
- Claude Code local-client behavior remains developer-preview only behind the explicit experimental flag;
- `chatAvailable` remains false for the shipping Claude slot until a supported product provider is implemented.

## Studio side-panel UX

Workflow is the persistent central canvas. Creative Control, Director Chat and Inspector are independent presentation sidecars.

- Director Chat already supports open/rail states;
- `StudioPanelController` gives Creative Control and Inspector independent persisted collapse/rail states;
- collapsing a sidecar returns width to the workflow instead of overlaying it;
- Autopilot interaction lock tracks the actual active sidecar widths and still owns only the workflow surface;
- sidecar scrolling is internal; Creative Control must not create a second outer native scrollbar;
- internal scrollbars use a quiet custom thumb with native arrow buttons removed.

This presentation state never changes native project revision.

## Local bridge endpoints

- `GET /api/director/providers` — sanitized provider readiness/policy/runtime state and warm-up surface;
- `POST /api/director/connect` — policy-permitted official login initiation;
- `POST /api/director/chat` — bounded creative chat;
- `POST /api/director/chat/close` — explicit conversation/thread teardown;
- `POST /api/director/plan` — bounded schema-constrained Assist planning.

## Context economy

Runtime requests do not dump the repository/project journal.

Planning hard bounds remain approximately:

- <=16,000 prompt characters;
- conservative <=4,000 estimated tokens;
- bounded node/edge scope;
- allow-listed bounded metadata;
- deterministic reduction that never slices serialized JSON mid-object.

Chat first-turn context has its own bounded compiler. App Server mode uses provider-native thread history; exec compatibility mode carries only a bounded recent transcript.

## Shutdown / failure behavior

- missing CLI: report unavailable; never fake connection;
- App Server start failure: record the bounded diagnostic and attempt official CLI exec compatibility;
- incompatible exec fallback: report unavailable rather than run an unsafe/unbounded command path;
- auth required: first Send or manual Connect can initiate official Codex login;
- concurrent provider run: reject the second run rather than overlap hidden state;
- timeout: interrupt/terminate only the owned provider run;
- bridge shutdown: drain App Server/turns and any active exec/login child before exit;
- malformed provider output never becomes project state.

## Product-machine validation

CI validates deterministic helpers and fake App Server protocol behavior but cannot contain the user's ChatGPT subscription session.

Windows live validation must prove:

1. `dev.ps1` reports the actual Codex runtime;
2. composer accepts typing before authentication/readiness;
3. an already-connected ChatGPT CLI session enables either App Server chat or exec compatibility chat without reconfiguration;
4. if sign-in is required, first Send preserves the message while official login completes;
5. a second message preserves bounded conversation continuity;
6. Chat stays interactive while Autopilot protects workflow geometry;
7. Creative Control, Chat and Inspector can collapse/reopen independently without breaking canvas geometry;
8. no nested white/native Creative Control scrollbar remains;
9. bridge shutdown during a provider turn leaves no orphan owned provider process;
10. chat/planning do not mutate semantic project revision by themselves.
