# Make & Watch agent instructions

This repository is Make & Watch. Treat `project_brain/` as canonical architecture context.

For engineering work: read `project_brain/README.md`, `HANDOFF.md`, `VALIDATION.md`, `INVARIANTS.md`, and the subsystem document relevant to the change before modifying code. Keep strict TypeScript/C++ quality gates green. Do not weaken domain, persistence, resource, auth, or test invariants to make a build pass.

For **AI Director runtime planning** (the prompt will explicitly say `MAKEWATCH DIRECTOR MODE`):
- read/follow `project_brain/AI_DIRECTOR_CONTEXT.md`;
- treat the bounded live-project context in the prompt as authoritative runtime context;
- do not edit repository files or run project commands;
- return only the requested structured plan/result;
- minimize context exploration and output size;
- never bypass native locks/revisions/resource admission;
- never expose patent-sensitive adaptive synthesis-selection logic while this repository is public.

Make & Watch owns no Codex OAuth token. Authentication remains inside the official Codex client.
