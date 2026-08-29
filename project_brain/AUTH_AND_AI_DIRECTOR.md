# Authentication and AI Director Integration

## Product requirement

The user chooses one AI Director. Media generation remains local and provider-independent.

Current product integration policy:

- **Codex** — supported local-client product path through the official Codex client. App Server is preferred; a bounded read-only `codex exec` compatibility runtime is permitted when the installed official client cannot keep App Server alive.
- **Claude** — production third-party path requires Anthropic API/Console or a supported cloud provider. Claude Code subscription routing remains policy-gated by default.

## Non-negotiable security rule

Make & Watch must not impersonate official clients, scrape credentials, copy token caches, collect session tokens, or invent a provider OAuth exchange.

## Codex authentication ownership

Preferred path:

```text
runtime warm-up
 -> local bridge
 -> codex app-server
 -> initialize / initialized
 -> account/read

user Send when auth is required
 -> account/login/start(type=chatgpt)
 -> official ChatGPT browser flow
 -> account/login/completed / account/updated
 -> queued local message submitted
```

Compatibility path when App Server is unavailable/broken:

```text
codex app-server probe/start fails
 -> bounded codex exec capability probe
 -> codex login status
 -> require ChatGPT session
 -> read-only codex exec chat/plan
```

Both paths rely on the official Codex client owning credentials. Make & Watch never reads the Codex credential cache.

The compatibility runtime intentionally does **not** treat a generic/API-key login as ChatGPT subscription access. If `codex login status` does not identify a ChatGPT session, product chat remains unavailable until official ChatGPT sign-in is completed.

## User-gesture and queued-message rule

The composer itself is never credential-gated. The user may type before account/runtime readiness.

If authentication is required, the first **Send** keeps the message visibly queued and starts the policy-permitted official Codex sign-in flow. App Server mode uses its returned browser `authUrl`; compatibility mode launches the official `codex login` flow. The queued message is submitted only after sanitized provider status reports chat readiness.

If connection fails before submission, the text is restored to the composer. A failure after a provider turn may have started must not cause automatic blind replay.

## Claude policy

Claude Code subscription login for ordinary Claude Code use is distinct from a supported third-party product authentication path.

Therefore:

- a detected Claude CLI may be visible;
- public product status remains `api_required`;
- Claude Code developer preview exists only behind `MAKEWATCH_ENABLE_EXPERIMENTAL_CLAUDE_CODE=1`;
- shipping Claude chat/planning must use a supported Anthropic API/Console/cloud-provider path;
- Make & Watch must not route Free/Pro/Max credentials through the product on the user's behalf.

## Studio/provider flow

1. dev-runner starts the native engine and bridge;
2. before Studio starts, it warms provider status and selects the best available Codex runtime;
3. runtime status is one of `app_server`, `exec_fallback`, or `none`;
4. Studio receives sanitized typed readiness;
5. user can type immediately regardless of provider readiness;
6. `/api/director/chat` handles bounded conversation using native App Server threads or bounded compatibility transcript state;
7. `/api/director/connect` is used automatically by first Send when needed or manually from Connections;
8. `/api/director/plan` remains a separate schema-constrained Assist planning surface;
9. chat/planning output cannot mutate semantic project state directly.

## Context and process bounds

App Server mode owns real Codex thread IDs and deletes them on New conversation/close/shutdown.

Compatibility mode cannot pretend to own provider-native thread history. It stores only a bounded in-memory recent transcript, sends bounded prompts through stdin, uses read-only sandboxing, collects only the bounded final message, and removes temporary output files after every turn.

Static CLI version/help capability probes are cached for the bridge lifetime so status polling does not continuously spawn probe processes. Account/login readiness remains live.

## Project specialization versus fine-tuning

Codex/Claude are not retrained for this repository. Make-&-Watch specialization is provided by:

- tiny provider-native runtime instructions;
- bounded native graph context;
- bounded conversation context;
- schema-constrained planning;
- native revision/lock/capability validation before any later execution.

## Credential storage

The supported Codex path stores **zero Codex secrets in Make & Watch**.

Future direct Anthropic/OpenAI API or enterprise credentials must use an OS-backed secret abstraction such as Windows Credential Manager, macOS Keychain, or Linux Secret Service. Never persist secrets in project files, SQLite project metadata, logs, shipping `.env` defaults or Director context packs.

## Failure behavior

- Missing CLI: report missing; local project operation remains available.
- App Server failure: preserve a bounded diagnostic, stop the broken owned process, and attempt the official CLI exec compatibility runtime.
- Compatibility runtime missing required bounded/read-only flags: report unavailable rather than run an unsafe path.
- App Server ready but no ChatGPT account: composer stays writable; first Send initiates official sign-in.
- Compatibility mode without ChatGPT login: composer stays writable; first Send starts `codex login` and keeps the message queued.
- Popup blocked in App Server mode: preserve queued text and expose the official auth URL as recovery.
- Login pending: preserve one owned login flow and poll boundedly.
- Connection failure before chat submission: restore text to composer.
- Possible failure after chat submission: do not blindly auto-replay and risk a duplicate turn.
- Policy-disallowed provider: explain supported API requirement.
- Concurrent Director inference: reject overlap.
- Turn/process timeout: interrupt or terminate only the owned provider work.
- Bridge shutdown: drain App Server threads, active exec turn, and active login child before exit.
- Invalid plan schema/stale revision: reject before native mutation.

## Authority boundary

Conversation history is not a project database.

```text
chat = creative context
plan = typed proposal
ProjectSession = authoritative semantic commit boundary
SQLite/journal = durable project truth/history
```

Guided/Director semantic execution must continue to reuse this boundary. Native C++ `ProjectSession` remains authoritative regardless of provider.
