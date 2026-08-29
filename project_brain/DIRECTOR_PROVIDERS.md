# First-Party AI Director Providers

## Goal

Make & Watch may use **Codex** or **Claude Code** as the cloud reasoning/Director layer while keeping media generation, authoritative project state, worker lifecycle and rendering local.

This is project-scoped orchestration, not model fine-tuning. The provider is made Make-&-Watch-specific through repository instructions plus a bounded live-project context compiler. The underlying model is not modified or retrained.

## Authentication boundary

Make & Watch does **not** implement its own OAuth exchange for ChatGPT/Claude subscriptions and does not copy provider credential caches.

Official references used for this implementation (checked 2026-08-29):

- OpenAI Codex authentication: https://developers.openai.com/codex/auth
- OpenAI Codex CLI reference: https://developers.openai.com/codex/cli/reference
- OpenAI Codex `AGENTS.md`: https://developers.openai.com/codex/guides/agents-md
- Anthropic Claude Code setup/authentication: https://docs.anthropic.com/en/docs/claude-code/getting-started
- Anthropic Claude Code CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-usage
- Anthropic structured outputs: https://code.claude.com/docs/en/agent-sdk/structured-outputs

OpenAI documents `codex login` and **Sign in with ChatGPT for subscription access**. Anthropic documents Claude App Pro/Max login through Claude Code and that Claude Code stores its own credentials. Therefore the Studio asks the first-party client to authenticate and later probes first-party status; it never receives the OAuth token.

## Current bridge

`tools/director/provider-manager.mjs` owns request-scoped first-party CLI processes.

Supported provider IDs:

- `codex`
- `claude`

Local bridge endpoints:

- `GET /api/director/providers` — sanitized installed/authenticated/capability state;
- `POST /api/director/connect` — launches first-party login (`codex login` or `claude auth login`);
- `POST /api/director/plan` — compiles bounded context and invokes one authenticated provider.

Exactly one Director plan inference may be active at a time.

## Codex execution

The bridge requires a Codex CLI version whose `codex exec --help` exposes:

- `--sandbox`;
- `--ephemeral`;
- `--output-schema`;
- `--output-last-message`.

The Director run uses `codex exec` non-interactively with:

- read-only sandbox;
- ephemeral session rollout;
- JSON Schema final-output validation;
- final message written to a temporary file;
- prompt through stdin;
- finite process timeout/output bounds.

The temp output directory is removed after every run.

## Claude execution

The bridge requires a current Claude Code CLI exposing:

- print mode / JSON output;
- `--max-turns`;
- `--permission-mode`;
- `--json-schema`;
- `--tools`.

The Director run is deliberately narrower than a normal Claude Code session:

- one turn;
- permission mode `plan`;
- built-in tools disabled with `--tools ""`;
- MCP tools denied;
- JSON Schema structured output required;
- finite process timeout/output bounds.

The provider result prefers Claude's validated `structured_output`. Free-form parsing is only a compatibility fallback when the documented JSON envelope returns the result as a string.

## Project specialization and context economy

Root `AGENTS.md` and `CLAUDE.md` provide first-party project-scoped instructions. `project_brain/AI_DIRECTOR_CONTEXT.md` is the canonical compact Director policy.

Runtime requests do **not** resend that whole policy. `tools/director/context-pack.mjs` sends only:

- a compact invariant reminder;
- the canonical policy hash;
- current native project revision;
- bounded user objective;
- selected compact node fields;
- relevant dependency edges;
- optional workspace positions.

Current hard context bounds:

- 16,000 characters total prompt;
- approximately 4,000 tokens by conservative character estimate;
- 3,000 characters of user objective;
- at most 72 nodes;
- at most 120 included dependency edges;
- small allow-list of metadata keys and bounded metadata values.

The context pack is deterministically serialized and SHA-256 hashed. No prompt or provider response is persisted as a hidden long-term transcript by Make & Watch at this layer.

This design deliberately avoids sending the entire repository, journal, or episode history every turn. Context cost should scale with the relevant current graph slice rather than repository size.

## Output authority

Provider output is not project truth.

Flow:

```text
first-party authenticated Codex / Claude
        -> schema-constrained AutopilotPlan
        -> Studio plan validator
        -> exact expected native revision
        -> capability/autonomy policy
        -> optional user checkpoint
        -> native ProjectSession command transaction
        -> SQLite + journal
```

The initial live connection UI requests **Assist-mode plans only** and validates them without semantic mutation. Guided/Director execution will be enabled only after plan-preview/approval UX and additional live provider tests are complete.

## Process and privacy bounds

- OAuth tokens/cached credential files are never read, copied or persisted by Make & Watch.
- Provider status exposed to React is sanitized; raw CLI status text is not forwarded.
- Prompts are sent through stdin, not shell interpolation.
- Provider stdout/stderr have finite byte caps.
- Plan runs have finite wall-clock timeout.
- Active plan child process is terminated when the local bridge shuts down.
- On timeout the owned provider process tree is terminated.
- Only one provider planning process is admitted concurrently.
- Provider planning does not acquire local GPU `ResourceLease`; local media workers will use the native runtime separately.

## What remains to validate locally

CI can validate bridge syntax, context-budget regression checks, TypeScript build and native tests, but GitHub Actions does not carry the user's authenticated first-party Codex/Claude session.

Windows product-machine validation must therefore prove:

1. installed CLI is discovered;
2. first-party login launches correctly;
3. ChatGPT or Claude subscription status is detected without credential custody;
4. one Assist-mode plan returns schema-valid JSON;
5. context stats stay within budget;
6. bridge shutdown while a provider is running leaves no orphan provider child;
7. native semantic project revision remains unchanged by connection-phase Assist planning.
