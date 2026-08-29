# AI Director Providers

## Goal

Make & Watch uses a cloud reasoning/Director layer while authoritative project state, media generation, worker lifecycle and rendering remain local.

This is **project-scoped specialization**, not model fine-tuning. Codex/Claude are not retrained. Their Make-&-Watch behavior comes from a tiny provider-native instruction set, compact canonical Director policy, bounded live graph context, schema-constrained output and native validation.

## Authentication boundary

Make & Watch must never copy credential caches, session tokens or subscription OAuth tokens.

Official references checked 2026-08-29:

- OpenAI Codex App Server: https://developers.openai.com/codex/app-server
- OpenAI Codex authentication: https://developers.openai.com/codex/auth
- OpenAI Codex `AGENTS.md`: https://developers.openai.com/codex/guides/agents-md
- Anthropic Claude Code setup: https://docs.anthropic.com/en/docs/claude-code/getting-started
- Anthropic Claude Code legal/compliance: https://docs.anthropic.com/en/docs/claude-code/legal-and-compliance
- Anthropic Claude Code CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-usage

## Codex — supported product embedding path

The canonical Codex integration is now **Codex App Server**, not ad-hoc `codex login` + `codex exec` subprocess composition.

OpenAI documents App Server as the product-embedding interface for Codex. The Make & Watch bridge starts one owned `codex app-server` JSONL session and uses the documented protocol:

```text
initialize
 -> initialized
 -> account/read
 -> account/login/start (ChatGPT, only if required)
 -> account/login/completed / account/updated
 -> thread/start
 -> turn/start with outputSchema
 -> item/completed / turn/completed
 -> thread/delete
```

For ChatGPT-managed authentication, Codex owns OAuth persistence and refresh. Make & Watch receives only sanitized account state (`type`, optional plan type) and never sees the email/token cache or OAuth secret.

`tools/director/codex-app-server.mjs` owns the App Server session. Important bounds:

- stdio newline-delimited JSON protocol;
- finite request, turn and shutdown timeouts;
- finite protocol line/write bounds;
- one active Director turn maximum;
- read-only Director sandbox;
- `approvalPolicy=never`;
- restricted readable root limited to `tools/director/runtime`;
- unexpected server-side interactive/tool requests rejected fail-closed;
- JSON Schema output supplied through `turn/start.outputSchema`;
- completed Director threads deleted so planning does not accumulate hidden conversation history;
- active turn interrupted on timeout/error/shutdown;
- App Server process remains bridge-owned and is drained/terminated during shutdown.

`tools/director/runtime/AGENTS.md` is intentionally tiny. Codex Director turns do not need repository-wide browsing; the live project graph arrives through the bounded context compiler.

## Codex readiness states

Provider status separates independent stages rather than hiding everything behind one `capable` boolean:

1. CLI detected;
2. App Server initialized;
3. ChatGPT account connected;
4. Director planning available.

This allows Studio to explain exactly why a detected client cannot yet plan. A user can begin first-party ChatGPT login as soon as App Server is ready; planning compatibility is not used to incorrectly hide the login action.

## Claude — policy-gated by default

Claude Code itself supports user login with Claude subscription plans. That fact does **not** make subscription OAuth a supported third-party product authentication path.

Anthropic's current legal/compliance documentation directs developers building products/services to Claude Console API authentication or a supported cloud provider and restricts routing Free/Pro/Max credentials through a third-party product.

Therefore public Make & Watch behavior is:

- Claude Code may be detected and shown;
- Claude subscription login/inference is not actionable by default;
- production Claude support must use a supported Anthropic API/Console/cloud-provider path;
- the existing Claude Code adapter is developer-preview only behind `MAKEWATCH_ENABLE_EXPERIMENTAL_CLAUDE_CODE=1`;
- the developer flag must never silently become the shipping default.

## Local bridge endpoints

- `GET /api/director/providers` — sanitized provider readiness/policy state;
- `POST /api/director/connect` — starts only a policy-permitted official login flow;
- `POST /api/director/plan` — compiles bounded context and invokes one policy-permitted provider.

The Codex connect result returns the official App Server `authUrl`; Studio opens it in a user-initiated browser popup and polls sanitized provider state until account + planning readiness become true.

## Project specialization and context economy

`project_brain/AI_DIRECTOR_CONTEXT.md` is the stable policy source. Codex runtime instruction is a small `tools/director/runtime/AGENTS.md` file.

Runtime requests deliberately do not resend the entire repository, project journal or project brain. `tools/director/context-pack.mjs` sends:

- a short invariant reminder;
- canonical policy hash;
- exact native project revision;
- bounded objective;
- compact relevant node state;
- relevant dependency edges;
- optional workspace positions.

Hard context bounds:

- <=16,000 prompt characters;
- conservative estimate <=4,000 tokens;
- <=3,000 objective characters;
- <=72 nodes before adaptive reduction;
- <=120 dependency edges before adaptive reduction;
- small metadata allow-list with bounded values.

If the pack would exceed the hard budget, it now reduces node/edge/objective/metadata scope deterministically. It **never slices serialized JSON mid-object**. CI asserts deterministic hashes, valid JSON after reduction, selected-node retention, metadata filtering and the hard char/token bounds.

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

The current provider milestone requests **Assist-mode preview plans only**. Login or planning alone never grants semantic write authority.

## Product-machine validation

CI validates the App Server protocol with a deterministic fake process but cannot contain the user's authenticated ChatGPT subscription.

Windows validation must prove:

1. Codex CLI is discovered;
2. App Server initializes;
3. `Connect Codex officially` opens the official ChatGPT auth URL if required;
4. sanitized account state transitions to ChatGPT connected;
5. one Assist objective returns schema-valid AutopilotPlan JSON;
6. context remains within budget;
7. native semantic revision does not change from planning;
8. bridge shutdown during a turn leaves no orphan App Server process.

Claude should remain **API required for product** unless the explicit developer-preview flag is set.
