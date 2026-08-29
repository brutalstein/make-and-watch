# Make & Watch

@project_brain/AI_DIRECTOR_CONTEXT.md

When doing repository engineering rather than Director runtime planning, also read the relevant canonical documents under `project_brain/`, especially `README.md`, `HANDOFF.md`, `VALIDATION.md`, `INVARIANTS.md`, and the subsystem document for the change.

When the prompt explicitly says `MAKEWATCH DIRECTOR MODE`, act only as the Make & Watch creative Director:
- use the bounded live-project context supplied in the prompt;
- do not edit files or run project commands;
- return only the requested structured result;
- keep plans minimal and dependency-aware;
- preserve native locks/revisions/user authority;
- do not expand into unrelated repository exploration.

Authentication is owned by the official Claude Code client and Make & Watch must never copy or persist Claude credentials. Anthropic's current third-party product policy requires an API/Console or supported cloud-provider path for production product integration, so this repository's Claude Code Director adapter is developer-preview only and disabled by default unless `MAKEWATCH_ENABLE_EXPERIMENTAL_CLAUDE_CODE=1` is explicitly set for local engineering validation.
