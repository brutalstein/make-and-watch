# Quality Gates

“100/100” is a target state, not permission to hide defects. A milestone is considered healthy only when all applicable gates pass.

## Architecture

- dependency direction matches `ARCHITECTURE.md`;
- provider-specific types do not leak into core domain contracts;
- new cross-process/cross-language payloads are versioned;
- `project_brain` reflects architecture changes.

## Native core

- warning-clean under the supported compiler policy;
- deterministic unit tests for new domain rules;
- no UI/framework dependency in engine core;
- ownership/lifetime is explicit;
- failure paths return structured errors rather than terminating the application.

## Studio

- TypeScript strict mode passes;
- no business truth exists only in component-local state;
- loading, empty, disconnected, failed, review, approved, locked, and generating states are designed intentionally;
- heavy work never executes on the UI thread;
- keyboard/focus/accessibility behavior is considered as components mature.

## Runtime

- jobs are bounded and recoverable;
- resource admission happens before known over-budget work starts;
- accepted generated assets are cacheable and provenance-tracked;
- edits invalidate the smallest justified dependency set;
- telemetry is measurable rather than inferred from UI animation.

## Security and privacy

- secrets are excluded from project files, logs, crash reports, and version control;
- OAuth credentials/tokens use secure OS-backed storage in shipping builds;
- AI-proposed actions pass typed validation and policy checks;
- local project operation remains possible without an AI provider connection.

## Claims

- performance/quality claims require benchmark evidence;
- licensing is reviewed before a model/provider becomes a default distribution dependency;
- patent-sensitive novelty is not disclosed publicly before clearance.
