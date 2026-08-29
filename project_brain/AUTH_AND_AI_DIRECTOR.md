# Authentication and AI Director Integration

## Product requirement

The user chooses one AI Director connection. The first supported targets are **Codex** and **Claude Code**. Media generation remains local and does not depend on that provider.

## Non-negotiable security rule

Make & Watch must not impersonate official clients, scrape credentials, copy subscription token caches, or invent a third-party OAuth exchange for subscription model access.

The implemented local subscription path is:

```text
Make & Watch Studio
   |
   +--> local bridge --> official Codex CLI  --> ChatGPT browser sign-in
   |
   +--> local bridge --> official Claude Code -> Claude.ai/Pro/Max sign-in
```

The first-party client owns authentication and credential storage. Make & Watch owns only sanitized status probing, bounded process invocation, context compilation, plan validation and native project execution.

## Official behavior verified 2026-08-29

OpenAI's current Codex authentication documentation states that Codex supports **Sign in with ChatGPT for subscription access**, and documents `codex login` as the Codex CLI browser-login entry point. The Codex CLI reference documents stable non-interactive `codex exec`, read-only sandboxing, ephemeral sessions, JSON Schema output and final-message file output. Codex also officially loads project-scoped `AGENTS.md` instructions.

Anthropic's current Claude Code setup documentation supports Claude App Pro/Max login and states that Claude Code stores its credentials. The current CLI reference documents print mode, JSON output, one-turn bounds, plan permission mode, tool restriction and `--json-schema` structured output. Claude project instructions are represented by `CLAUDE.md`.

Canonical official links and the exact bridge contract are recorded in `DIRECTOR_PROVIDERS.md`.

## Implemented Studio flow

1. `GET /api/director/providers` probes official client/version/auth/capability state.
2. React receives only sanitized typed state; raw status output is not exposed.
3. `POST /api/director/connect` launches the first-party login command.
4. The browser/official client completes OAuth; Make & Watch never receives the token.
5. `POST /api/director/plan` compiles bounded Make-&-Watch-specific context and starts one first-party provider process.
6. Provider output must match `AutopilotPlan` schema and then pass the existing Studio validator/live revision check.
7. The initial provider connection phase remains Assist-only: it proves real planning without silently granting semantic write authority.

## Project specialization versus fine-tuning

Codex/Claude are not actually retrained for this repository. They are specialized through:

- root `AGENTS.md` for Codex;
- root `CLAUDE.md` for Claude;
- canonical `project_brain/AI_DIRECTOR_CONTEXT.md` policy;
- deterministic bounded live-project context;
- typed output schema;
- exact native project revision and validation.

This is preferred to repeatedly dumping the repository into the context window. It is cheaper, more deterministic, easier to version, and does not create a second hidden project state.

## Credential storage

The subscription path stores **zero provider secrets in Make & Watch**.

If Make & Watch later adds direct API-key/enterprise providers, secrets must use an OS-backed secret abstraction such as Windows Credential Manager, macOS Keychain, or Linux Secret Service. Never persist provider secrets inside project files, SQLite project metadata, `.env` shipping defaults, logs or Director context packs.

## Failure behavior

- Missing client: report not installed; do not fake connection.
- Old client lacking required safe flags: require official client update.
- Unauthenticated client: offer first-party login.
- Provider already busy: reject the second concurrent planning request.
- Timeout/output overflow: terminate the owned provider process tree.
- Bridge shutdown: terminate any request-scoped provider plan child.
- Invalid structured output or stale project revision: reject before native mutation.

## Future provider modes

Guided/Director semantic execution will reuse the same provider/validator boundary, but must add explicit plan preview, capability grant and approval UX before enabling broader mutation. The native C++ engine and `ProjectSession` remain authoritative regardless of provider.
