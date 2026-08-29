# AI Director Providers

## Goal

Make & Watch uses a cloud reasoning/Director layer while keeping authoritative project state, media generation, worker lifecycle and rendering local.

This is **project-scoped specialization**, not model fine-tuning. Codex/Claude are not retrained. Their Make-&-Watch behavior comes from repository instructions, a compact canonical Director policy, bounded live graph context, JSON Schema output and native validation.

## Authentication boundary

Make & Watch does not copy credential caches, session tokens or subscription OAuth tokens.

Official references checked 2026-08-29:

- OpenAI Codex authentication: https://developers.openai.com/codex/auth
- OpenAI Codex CLI reference: https://developers.openai.com/codex/cli/reference
- OpenAI Codex `AGENTS.md`: https://developers.openai.com/codex/guides/agents-md
- Anthropic Claude Code setup: https://docs.anthropic.com/en/docs/claude-code/getting-started
- Anthropic Claude Code legal/compliance: https://docs.anthropic.com/en/docs/claude-code/legal-and-compliance
- Anthropic Claude Code CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-usage
- Anthropic structured outputs: https://code.claude.com/docs/en/agent-sdk/structured-outputs

## Codex — primary local subscription bridge

OpenAI documents **Sign in with ChatGPT for subscription access** in Codex and supports that sign-in method in the local Codex CLI. The current Make & Watch local bridge therefore treats Codex as the primary subscription-backed Director integration to validate on the product machine.

Make & Watch asks the official Codex client to authenticate and probes first-party status. It never reads or persists the resulting token.

The bridge requires a Codex CLI version whose `codex exec --help` exposes:

- `--sandbox`;
- `--ephemeral`;
- `--output-schema`;
- `--output-last-message`.

Director planning uses:

- `codex exec` non-interactive mode;
- read-only sandbox;
- ephemeral rollout session;
- JSON Schema final-output validation;
- final result written to a temporary file;
- prompt through stdin rather than shell interpolation;
- finite process timeout and byte limits.

The temporary output directory is removed after every run.

## Claude — policy-gated by default

Claude Code itself supports user login with Claude subscription plans. That fact does **not** make subscription OAuth a supported third-party product authentication path.

Anthropic's current legal/compliance documentation states that developers building products/services should use an API key through Claude Console or a supported cloud provider, and that third-party developers may not offer Claude.ai login in their own application or route requests through Free/Pro/Max plan credentials on behalf of users.

Therefore public Make & Watch behavior is:

- Claude Code may be detected and shown in the Director provider surface;
- Claude subscription login/inference is **not actionable by default**;
- the production Claude path must use an Anthropic-supported API/Console/cloud-provider integration;
- the existing Claude Code adapter remains a developer-preview implementation only, gated behind `MAKEWATCH_ENABLE_EXPERIMENTAL_CLAUDE_CODE=1` for explicit local engineering tests where appropriate;
- that developer flag must never silently become the shipping product default.

When developer preview is explicitly enabled, the adapter is deliberately narrow:

- one turn;
- plan permission mode;
- built-in tools disabled;
- MCP tools denied;
- JSON Schema structured output required;
- finite process timeout/output bounds.

The default CI test asserts that Claude Code is `api_required`, not an enabled product subscription bridge.

## Provider policy state

Provider status returned to Studio includes an explicit policy:

- `supported_local_client` — current Codex local-client path;
- `api_required` — default Claude product policy;
- `experimental_local_client` — explicit developer-only Claude Code override.

This prevents UI from confusing a policy block with an outdated/missing CLI.

## Current local bridge

`tools/director/provider-manager.mjs` owns request-scoped provider processes.

Endpoints:

- `GET /api/director/providers` — sanitized installed/authenticated/capability/policy state;
- `POST /api/director/connect` — launches only a policy-permitted first-party login;
- `POST /api/director/plan` — compiles bounded context and invokes one policy-permitted provider.

Exactly one Director planning inference may be active at a time.

## Project specialization and context economy

Root `AGENTS.md` and `CLAUDE.md` provide provider-native project instructions. `project_brain/AI_DIRECTOR_CONTEXT.md` is the canonical compact Director policy.

Runtime requests deliberately do **not** resend the entire policy, repository or project journal. `tools/director/context-pack.mjs` sends:

- a short invariant reminder;
- canonical policy hash;
- current native project revision;
- bounded user objective;
- compact relevant node state;
- relevant dependency edges;
- optional workspace positions.

Hard context bounds:

- 16,000 characters total prompt;
- conservative estimate <=4,000 tokens;
- <=3,000 objective characters;
- <=72 nodes;
- <=120 included dependency edges;
- small metadata allow-list with bounded values.

The pack is deterministically serialized and SHA-256 hashed. A CI regression check rejects accidental context growth or irrelevant large metadata leakage.

This means token/context cost scales primarily with the current useful graph slice rather than repository size.

## Output authority

Provider output is never project truth.

```text
policy-permitted provider
        -> schema-constrained AutopilotPlan
        -> Studio validator
        -> exact live native revision check
        -> autonomy/capability policy
        -> optional user checkpoint
        -> native ProjectSession transaction
        -> SQLite + journal
```

The current provider connection milestone requests **Assist-mode plans only** and validates them without semantic mutation. Provider login alone never grants write authority.

## Process/privacy/resource bounds

- no Make & Watch credential custody for local-client OAuth;
- raw CLI auth/status text is not forwarded to React;
- prompt travels over stdin;
- stdout/stderr have finite byte caps;
- plan process has finite wall-clock timeout;
- one planning process maximum;
- active provider child is owned by the bridge and terminated during shutdown/timeout;
- provider reasoning does not acquire GPU `ResourceLease`; local media generation remains a separate native runtime responsibility;
- provider result still passes the same typed/native safety boundaries as any future provider.

## Product-machine validation

CI cannot contain the user's authenticated subscription state. Windows validation must therefore prove the supported Codex path:

1. Codex CLI is discovered;
2. `Connect Codex officially` launches first-party login if needed;
3. ChatGPT-authenticated status is detected without credential custody;
4. one Assist-mode Director objective returns schema-valid JSON;
5. live native revision validation passes;
6. context estimate remains within budget;
7. provider planning does not mutate native project state;
8. shutting down the bridge during planning leaves no orphan provider child.

Claude should appear **API required for product** unless the explicit developer-preview environment flag is set.
