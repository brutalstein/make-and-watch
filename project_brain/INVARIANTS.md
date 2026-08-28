# Engineering Invariants

These are non-negotiable unless an architecture decision explicitly replaces one.

1. **The user owns final creative authority.** Important creative changes are previewable and approval-aware.
2. **The project graph is the source of truth, not chat history.** The AI director is replaceable.
3. **No provider owns the architecture.** Wan, LTX, a TTS model, ComfyUI, FFmpeg, Claude, Codex, or any future provider is an adapter.
4. **Cross-boundary data is typed and versioned.** No unstructured dictionary soup across C++/TypeScript/Python boundaries.
5. **Heavy work is resumable.** A process crash must not require restarting an episode from zero.
6. **Expensive generation is incremental.** Editing one approved unit must not invalidate unrelated work by default.
7. **UI remains responsive under load.** Rendering or inference must never block the Studio event loop.
8. **Secrets never enter project files or logs.** OAuth tokens/credentials live in OS-appropriate secure storage when integrations arrive.
9. **Resource limits are explicit.** The engine must be able to reject work before catastrophic OOM rather than relying on accidental failure.
10. **Manual operation remains possible without an AI connection.** Projects must open, inspect, edit, and render without the director being online.
11. **Public API/contracts evolve compatibly.** Breaking changes require a schema version boundary and migration plan.
12. **Every architectural change updates `project_brain`.** A session handoff must remain trustworthy.
13. **Quality claims require benchmarks.** We do not call a path faster, cheaper, or higher quality without measurements.
14. **Patent-sensitive novelty stays out of the public repository until cleared.**
15. **Rust is not part of the technology stack.** Native core work uses C/C++ unless a documented decision changes it.
