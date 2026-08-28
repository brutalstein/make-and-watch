# Architecture Decisions

## ADR-001 — C++ core, TypeScript product surface

**Status:** accepted.

The engine core is C++20+. The premium Studio UI is React/TypeScript. Native media and resource-sensitive code remains outside the browser/UI runtime.

## ADR-002 — One project graph, two control surfaces

**Status:** accepted.

Natural-language direction and visual workflow editing mutate the same validated project model. Neither maintains a competing representation of creative state.

## ADR-003 — AI director uses typed operations

**Status:** accepted.

Claude/Codex integrations must translate intent into versioned operations. Free-form model output is never applied directly to persistent project state.

## ADR-004 — Provider architecture

**Status:** accepted.

Image, video, voice, audio, QC, and director implementations are capability providers. Provider-specific concepts do not leak into core domain entities unless they are explicitly stored as optional provenance/parameters.

## ADR-005 — Approval before final synthesis

**Status:** accepted.

The default user journey is concept → episode plan → scenes → storyboard → shots → animatic → final synthesis. Auto-approval is a policy override, not the architectural default.

## ADR-006 — Out-of-process heavyweight AI workers

**Status:** planned/accepted direction.

Python/model workers will be isolated from the C++ engine. IPC details are not fixed yet; contracts must allow a future transport swap without domain changes.

## ADR-007 — Public repository IP discipline

**Status:** active constraint.

This public tree may contain product architecture and ordinary engineering, but unpublished invention disclosures and claim-oriented implementation detail remain private until an IP decision is made.
