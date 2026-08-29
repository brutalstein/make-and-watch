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
Studio
 -> local bridge
 -> codex app-server
 -> account/read
 -> account/login/start(type=chatgpt) when required
 -> official ChatGPT browser flow
 -> account/login/completed / account/updated
```

Codex owns OAuth persistence and refresh. Make & Watch receives only sanitized readiness/account information and the official login URL required to continue the user-initiated browser flow. Account email and OAuth credentials are deliberately stripped before provider state can reach React.

The bridge keeps one owned App Server process and shuts it down with the bridge. Director turns use read-only, no-approval execution and schema-constrained output.

## Claude policy

Claude Code subscription login for ordinary Claude Code use is distinct from a supported third-party product authentication path. Anthropic's current legal/compliance guidance requires products/services to use supported API/Console/cloud-provider authentication rather than route Free/Pro/Max credentials on users' behalf.

Therefore:

- a detected Claude CLI is visible but not misleadingly shown as a shipping OAuth provider;
- public product status is `api_required`;
- Claude Code developer preview exists only behind `MAKEWATCH_ENABLE_EXPERIMENTAL_CLAUDE_CODE=1`;
- production Claude support will use an OS-secret-backed Anthropic API/enterprise provider unless official policy changes.

## Studio flow

1. `GET /api/director/providers` returns sanitized typed readiness and policy state.
2. Codex readiness is split into CLI / App Server / account / planning stages.
3. `POST /api/director/connect` asks App Server to start ChatGPT-managed auth and returns the official auth URL; Make & Watch never receives the OAuth token.
4. Studio opens that URL from a user click and polls sanitized provider state until planning readiness becomes true.
5. `POST /api/director/plan` compiles bounded project-specific context and runs one policy-permitted provider.
6. Output must match `AutopilotPlan` schema and then pass live revision/Autopilot validation.
7. Current provider plans remain Assist-only and cannot mutate semantic project state.

## Project specialization versus fine-tuning

Codex/Claude are not retrained for this repository. Make-&-Watch specialization is provided by:

- tiny provider-native runtime instructions;
- `project_brain/AI_DIRECTOR_CONTEXT.md` policy hash;
- bounded live graph context;
- typed output schema;
- native revision/lock/capability validation.

This is cheaper and more deterministic than repeatedly sending the whole repository or maintaining hidden duplicate project memory.

## Credential storage

The supported Codex path stores **zero Codex secrets in Make & Watch**.

Future direct Anthropic/OpenAI API or enterprise credentials must use an OS-backed secret abstraction such as Windows Credential Manager, macOS Keychain, or Linux Secret Service. Never persist secrets in project files, SQLite project metadata, logs, shipping `.env` defaults or Director context packs.

## Failure behavior

- Missing CLI: report missing; never fake connection.
- CLI without working App Server: report update/integration issue explicitly.
- App Server ready but no ChatGPT account: expose first-party connect action.
- Login pending: preserve one owned login flow and poll boundedly.
- Policy-disallowed provider: show the supported API requirement and reject product login/inference.
- Concurrent Director inference: reject the second run.
- Turn timeout: interrupt the owned turn.
- Bridge shutdown: interrupt active turn, close App Server, bounded-wait, then terminate if necessary.
- Invalid schema/stale revision: reject before native mutation.

## Future provider modes

Guided/Director semantic execution will reuse this same provider/validator boundary only after explicit preview/capability/approval UX is complete. Native C++ `ProjectSession` remains authoritative regardless of provider.
