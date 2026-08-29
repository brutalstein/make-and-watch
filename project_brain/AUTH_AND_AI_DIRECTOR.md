# Authentication and AI Director Integration

## Product requirement

The user chooses one AI Director. Media generation remains local and provider-independent.

Current product integration policy:

- **Codex** — supported local-client product path through official Codex App Server + ChatGPT-managed authentication.
- **Claude** — production third-party path requires Anthropic API/Console or a supported cloud provider. Claude Code subscription routing remains policy-gated by default.

## Non-negotiable security rule

Make & Watch must not impersonate official clients, scrape credentials, copy token caches, collect session tokens, or invent a provider OAuth exchange.

## Codex authentication ownership

The supported Codex flow is:

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

Codex owns OAuth persistence and refresh. Make & Watch receives only sanitized readiness/account information plus the official login URL required for the user-initiated browser flow. Account email and OAuth credentials are deliberately stripped before provider state can reach React.

The bridge owns one App Server process and shuts it down with the bridge.

## User-gesture and queued-message rule

Browser authentication is initiated from an explicit user action. Normal UX uses the first **Send** gesture when sign-in is still required; manual Connect remains a recovery/control action.

The composer itself is never credential-gated. The user may type before account readiness.

A message waiting for authentication is held locally and visibly marked queued. It is submitted only after sanitized provider status reports chat readiness. If connection fails before submission, the text is restored to the composer.

This avoids both a dead disabled composer and silent message loss.

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
2. before Studio starts, it warms provider status so Codex App Server initializes when available;
3. Studio receives sanitized typed readiness;
4. user can type immediately regardless of account state;
5. `POST /api/director/chat` handles bounded multi-turn conversation after readiness;
6. `POST /api/director/connect` is used automatically by first Send when needed or manually from Connections;
7. `POST /api/director/plan` remains a separate schema-constrained Assist planning surface;
8. chat/planning output cannot mutate semantic project state directly.

## Project specialization versus fine-tuning

Codex/Claude are not retrained for this repository. Make-&-Watch specialization is provided by:

- tiny provider-native runtime instructions;
- bounded native graph context;
- provider-native conversation thread state for follow-up chat;
- schema-constrained planning;
- native revision/lock/capability validation before any later execution.

## Credential storage

The supported Codex path stores **zero Codex secrets in Make & Watch**.

Future direct Anthropic/OpenAI API or enterprise credentials must use an OS-backed secret abstraction such as Windows Credential Manager, macOS Keychain, or Linux Secret Service. Never persist secrets in project files, SQLite project metadata, logs, shipping `.env` defaults or Director context packs.

## Failure behavior

- Missing CLI: report missing; local project operation remains available.
- CLI without working App Server: report exact integration issue; do not fake readiness.
- App Server ready but no ChatGPT account: composer stays writable; first Send can initiate official sign-in.
- Popup blocked: preserve queued text and expose the official auth URL as a recovery link.
- Login pending: preserve one owned login flow and poll boundedly.
- Connection failure before chat submission: restore text to composer.
- Possible failure after chat submission: do not blindly auto-replay and risk a duplicate turn.
- Policy-disallowed provider: explain supported API requirement.
- Concurrent Director inference: reject overlap.
- Turn timeout: interrupt the owned turn.
- Bridge shutdown: interrupt active work, close owned chat threads, close App Server, bounded-wait, then terminate if necessary.
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
