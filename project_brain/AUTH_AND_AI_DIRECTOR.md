# Authentication and AI Director Integration

## Product requirement

The user chooses one AI Director. Media generation remains local and provider-independent.

Current product integration policy:

- **Codex** — primary local-client Director path; official Codex client owns ChatGPT/API-key authentication.
- **Claude** — production third-party path requires Anthropic API/Console or supported cloud-provider authentication. Claude Code subscription routing is policy-gated by default.

## Non-negotiable security rule

Make & Watch must not impersonate official clients, scrape credentials, copy token caches, collect session tokens, or invent a provider OAuth exchange.

## Official behavior verified 2026-08-29

OpenAI documents Codex **Sign in with ChatGPT for subscription access** for local Codex clients and documents non-interactive `codex exec` capabilities used by the bridge. Make & Watch therefore asks the official Codex client to sign in and never receives the resulting OAuth credential.

Anthropic documents Claude Code subscription login for ordinary use of Claude Code/native Anthropic applications. Anthropic's legal/compliance documentation separately states that developers building products/services should use Claude Console API-key authentication or a supported cloud provider and may not offer Claude.ai login in their own application or route Free/Pro/Max credentials on users' behalf.

Therefore a detected Claude Code installation is **not** treated as a shipping subscription OAuth provider. The adapter is disabled by default and can only be enabled as an explicit developer-preview experiment with `MAKEWATCH_ENABLE_EXPERIMENTAL_CLAUDE_CODE=1`. Production Claude support must use a supported Anthropic API path unless Anthropic policy changes or explicit approval is obtained.

See `DIRECTOR_PROVIDERS.md` for official links and implementation details.

## Implemented Studio flow

1. `GET /api/director/providers` returns sanitized typed provider status plus explicit policy state.
2. Codex may expose `supported_local_client` and first-party login.
3. Claude normally exposes `api_required`; the Studio does not offer product subscription login.
4. `POST /api/director/connect` rejects policy-disallowed providers.
5. `POST /api/director/plan` compiles bounded Make-&-Watch-specific context and invokes one policy-permitted provider.
6. Output must match `AutopilotPlan` schema and then pass live Studio/native revision validation.
7. Connection-phase provider plans remain Assist-only and cannot mutate semantic project state.

## Project specialization versus fine-tuning

Codex/Claude are not retrained for this repository. Make-&-Watch specialization is provided by:

- root `AGENTS.md` / `CLAUDE.md` project instructions;
- `project_brain/AI_DIRECTOR_CONTEXT.md`;
- bounded live graph context;
- typed output schema;
- native revision/lock/capability validation.

This avoids repeatedly sending the entire repository or maintaining a hidden duplicate project memory.

## Credential storage

The supported local Codex path stores **zero Codex secrets in Make & Watch**.

Future direct Anthropic/OpenAI API or enterprise credentials must use an OS-backed secret abstraction such as Windows Credential Manager, macOS Keychain, or Linux Secret Service. Never persist secrets in project files, SQLite project metadata, logs, shipping `.env` defaults or Director context packs.

## Failure behavior

- Missing client: report missing; never fake connection.
- Old client: require official update.
- Unauthenticated supported client: offer first-party login.
- Policy-disallowed provider: show the supported API requirement and reject login/inference.
- Concurrent Director inference: reject the second run.
- Timeout/output overflow: terminate the owned provider process tree.
- Bridge shutdown: terminate the active request-scoped provider child.
- Invalid schema/stale revision: reject before native mutation.

## Future provider modes

Guided/Director semantic execution will reuse the same provider/validator boundary only after explicit preview/capability/approval UX is complete. Native C++ `ProjectSession` remains authoritative regardless of provider.
