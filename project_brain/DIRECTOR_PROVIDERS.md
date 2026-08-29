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

## Codex — supported product path

The canonical integration is **Codex App Server**.

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

## Automatic startup / simple-user contract

The developer runtime must prepare infrastructure rather than make the user manage services.

`tools/dev-runner.mjs` now:

1. builds the native host;
2. starts the local bridge/native session;
3. waits for bridge health;
4. calls `/api/director/providers` before Vite starts, which initializes the owned Codex App Server when Codex is available;
5. starts Studio.

If a ChatGPT account is already connected, chat is ready when Studio opens. If sign-in is required, the App Server is still prepared and the first user Send starts/continues the official sign-in flow.

Director warm-up failure is non-fatal because local project operation must remain possible without an AI provider.

## Composer/readiness rule

Provider readiness must **not** disable the chat text area.

The current first-Send behavior is:

```text
user types immediately
 -> Send
 -> chat ready? yes -> submit turn
 -> chat ready? no  -> open official auth from this user gesture
                     -> retain message locally as queued
                     -> poll sanitized readiness
                     -> submit queued message only after chat becomes ready
```

If connection fails before submission, Studio restores the text to the composer. If failure happens after a provider turn may have started, Studio avoids automatic replay to prevent duplicate turns.

Manual Connect remains available inside the Connections drawer as a recovery/control surface, not the normal mandatory path.

## Multi-turn chat ownership

`tools/director/codex-chat-session.mjs` keeps one Codex thread for each active Director conversation.

Current bounds:

- finite active conversation count;
- one active provider run at a time;
- finite turn/request timeouts;
- read-only sandbox;
- `approvalPolicy=never`;
- restricted runtime-readable root;
- bounded prompt/reply sizes;
- explicit thread deletion on New conversation/close/shutdown;
- provider process remains bridge-owned.

First chat turn receives bounded native project context. Later turns rely on the same Codex thread instead of resending the repository/project brain on every message.

Chat threads are creative context only; they cannot mutate SQLite/native project state.

## Planning path

Planning remains distinct from ordinary chat.

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

## Provider readiness fields

Studio does not hide everything behind one boolean. Status includes independent installation/capability/account/login/planning/chat states.

For Codex, `chatAvailable` requires a working App Server plus ChatGPT-managed account readiness. The composer is still writable before that state.

## Claude — policy-gated by default

Claude Code subscription login is not treated as a supported third-party product auth path.

Public behavior:

- Claude CLI may be detected and displayed;
- production Claude chat/planning requires a supported Anthropic API/Console/cloud-provider path;
- Claude Code local-client behavior remains developer-preview only behind the explicit experimental flag;
- `chatAvailable` remains false for the shipping Claude slot until a supported product provider is implemented.

## Local bridge endpoints

- `GET /api/director/providers` — sanitized provider readiness/policy state and Codex warm-up surface;
- `POST /api/director/connect` — policy-permitted official login initiation;
- `POST /api/director/chat` — bounded multi-turn creative chat;
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

Chat first-turn context has its own bounded compiler and subsequent turns use provider-native thread history.

## Shutdown / failure behavior

- missing CLI: report unavailable; never fake connection;
- App Server start failure: surface exact readiness issue while local Studio remains usable;
- auth required: first Send or manual Connect can initiate the official browser flow;
- concurrent provider run: reject the second run rather than overlap hidden state;
- timeout: interrupt owned turn;
- bridge shutdown: interrupt active work, close/delete owned threads, then terminate App Server if graceful drain fails;
- malformed provider output never becomes project state.

## Product-machine validation

CI uses deterministic fake-process protocol tests; it cannot contain the user's ChatGPT session.

Windows live validation must prove:

1. `dev.ps1` warms Codex App Server before Studio startup when available;
2. composer accepts typing before authentication/readiness;
3. first Send directly works when already connected;
4. otherwise first Send opens the official ChatGPT flow, keeps the message queued locally and submits it after readiness;
5. a second message continues the same thread;
6. Chat stays interactive while Autopilot protects workflow geometry;
7. collapse/reopen/Connections toggles do not break canvas layout;
8. bridge shutdown during a turn leaves no orphan App Server process;
9. chat/planning do not mutate semantic project revision by themselves.
