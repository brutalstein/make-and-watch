# Authentication and AI Director Integration

## Product requirement

The user chooses one AI Director. Authoritative project state and media generation remain local and provider-independent.

Current product integration policy:

- **Codex** — supported local-client product path through the official Codex client. App Server is preferred; a bounded read-only `codex exec` compatibility runtime is permitted when the installed official client cannot keep App Server alive.
- **Claude** — production third-party path requires Anthropic API/Console or a supported cloud provider. Claude Code subscription routing remains policy-gated by default.

## Non-negotiable security rule

Make & Watch must not impersonate official clients, scrape credentials, copy token caches, collect session tokens, or invent a provider OAuth exchange.

The supported Codex path stores **zero Codex secrets in Make & Watch**. Codex owns credential persistence and refresh.

## Codex authentication ownership

Preferred path:

```text
runtime warm-up
 -> local bridge
 -> codex app-server
 -> initialize / initialized
 -> permissionProfile/list
 -> select allowed :read-only
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

## User gesture and queued-message rule

The composer is never credential-gated. The user may type before account/runtime readiness.

If authentication is required, the first **Send** keeps the message visibly queued and starts the policy-permitted official Codex sign-in flow. App Server mode uses its returned browser `authUrl`; compatibility mode launches the official `codex login` flow. The queued message is submitted only after sanitized provider status reports chat readiness.

If connection fails before submission, the text is restored to the composer. A failure after a provider turn may have started must not cause automatic blind replay.

## Durable conversation ownership

Make & Watch owns a provider-agnostic local conversation archive under `.makewatch/conversations/`. That directory is ignored by Git and contains no provider credentials.

Each product conversation stores only bounded product data:

- product conversation ID and title;
- provider/runtime label;
- provider thread handle when one exists;
- user/assistant/system transcript entries;
- timestamps, turn count and native project revision references;
- archive/failure state.

The provider thread handle is an opaque continuation token, not a credential.

### App Server lifecycle

A Director conversation uses a persistent Codex thread:

```text
new conversation
 -> thread/start (persistent; never ephemeral)
 -> repeated turn/start

switch/new conversation
 -> thread/unsubscribe only
 -> product conversation remains on disk

application restart / session switch
 -> read Make & Watch archive
 -> thread/resume(threadId)
 -> continue the same provider conversation

archive
 -> product archive flag
 -> best-effort thread/archive

restore
 -> best-effort thread/unarchive
 -> thread/resume on next use

hard delete
 -> explicit user action only
 -> best-effort thread/delete
 -> delete Make & Watch archive file
```

Bridge shutdown interrupts active work and releases subscriptions/processes but **never deletes persisted conversations**.

### Exec fallback lifecycle

`codex exec` has no provider-native multi-turn thread ownership. The compatibility path therefore reconstructs bounded context from the durable Make & Watch transcript instead of pretending to own a native Codex thread.

If an App Server conversation temporarily falls back to exec, its existing provider thread handle is retained. A later App Server-capable runtime can resume the original thread rather than losing the continuation handle.

## Chat operator authority

Director chat is no longer advisory-only.

When the user explicitly asks to create, edit, delete, load, save, reset, approve, lock or otherwise apply a project/workflow change, Codex may invoke the host-provided `makewatch.*` dynamic tools directly.

Important rules:

- Codex remains in `:read-only` provider sandbox mode;
- it may not edit project files or use shell commands as a substitute for product operations;
- project mutations are possible only through the typed Make & Watch capability registry;
- every mutation crosses native validation and optimistic `expectedProjectRevision` checks;
- locks, dependency invariants, persistence and journal provenance remain authoritative in native C++;
- a tool failure or revision conflict must be surfaced; Codex must never claim a change succeeded without a successful tool result;
- ordinary brainstorming/discussion must not mutate the project merely because tools exist.

Current capabilities include bounded project read/query/history/impact/apply; workflow new/save/list/load/delete; media provider inspection; Scene visual and Audio generation; Episode composition inspection/render start; and visual/audio/render job polling. Every media operation follows the same host-tool/native-authority pattern.

## Planning versus chat

`/api/director/plan` remains a separate schema-constrained `AutopilotPlan` surface. A generated plan is still a typed proposal until Studio validation and the relevant execution boundary accept it.

Chat and plan are therefore distinct:

```text
chat discussion          -> conversation only
chat explicit operation  -> makewatch.* tool -> native ProjectSession
plan generation           -> typed AutopilotPlan proposal
plan execution            -> Studio/native execution boundary
```

## Claude policy

Claude Code subscription login for ordinary Claude Code use is distinct from a supported third-party product authentication path.

Therefore:

- a detected Claude CLI may be visible;
- public product status remains `api_required`;
- Claude Code developer preview exists only behind `MAKEWATCH_ENABLE_EXPERIMENTAL_CLAUDE_CODE=1`;
- shipping Claude chat/planning must use a supported Anthropic API/Console/cloud-provider path;
- Make & Watch must not route Free/Pro/Max credentials through the product on the user's behalf.

The product conversation archive is intentionally provider-agnostic so a future supported Claude/API implementation can reuse the same session/archive UX without changing native project authority.

## Context and process bounds

- first successful chat turn receives bounded live-project context;
- later App Server turns rely primarily on provider thread history plus current native revision;
- if the first provider turn failed, the retry is still treated as a first successful turn and receives full bounded first-turn context;
- compatibility mode rebuilds only bounded transcript context;
- static CLI capability probes are cached for the bridge lifetime;
- one provider run is active at a time;
- prompt/reply/protocol sizes and timeouts are bounded;
- provider processes remain bridge-owned and are drained/terminated on shutdown without deleting conversation history.

## Project specialization versus fine-tuning

Codex/Claude are not retrained for this repository. Make & Watch specialization is provided by:

- small provider-native runtime instructions;
- bounded live graph context;
- durable bounded conversation context;
- typed `makewatch.*` capabilities;
- schema-constrained planning;
- native revision/lock/capability validation.

## Credential storage

Future direct Anthropic/OpenAI API or enterprise credentials must use an OS-backed secret abstraction such as Windows Credential Manager, macOS Keychain, or Linux Secret Service. Never persist secrets in project files, SQLite project metadata, logs, conversation archives, shipping `.env` defaults or Director context packs.

## Failure behavior

- Missing CLI: report missing; local project operation remains available.
- App Server failure: preserve a bounded diagnostic, stop the broken owned process, and attempt the official CLI exec compatibility runtime.
- Compatibility runtime missing required bounded/read-only flags: report unavailable rather than run an unsafe path.
- App Server ready but no ChatGPT account: composer stays writable; first Send initiates official sign-in.
- Compatibility mode without ChatGPT login: composer stays writable; first Send starts `codex login` and keeps the message queued.
- Popup blocked: preserve queued text and expose the official auth URL as recovery.
- Connection failure before chat submission: restore text to composer.
- Possible failure after chat submission: record failure state and do not blindly auto-replay.
- Corrupt unrelated local conversation file: isolate it so the archive picker remains usable.
- Concurrent Director inference: reject overlap.
- Turn/process timeout: interrupt or terminate only owned provider work.
- Bridge shutdown: stop active provider/native work without deleting conversations.
- Invalid command/plan/stale project revision: reject before native mutation.

## Authority boundary

Conversation history is durable creative context, but it is not the project database.

```text
conversation archive = durable creative/session context
makewatch.* tools     = typed project-operation capability surface
ProjectSession        = authoritative semantic commit boundary
SQLite/journal        = durable project truth/history
```

Native C++ `ProjectSession` remains authoritative regardless of provider or conversation state.
