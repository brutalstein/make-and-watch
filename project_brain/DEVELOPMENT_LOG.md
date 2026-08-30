# Make & Watch — Development Log

This log is the durable chronological checkpoint for major product/runtime changes. Add new entries with local project time (Europe/Istanbul) after meaningful milestones, fixes or architecture decisions. It complements the topic-specific documents under `project_brain/`; it does not replace Git history.

---

## 2026-08-30 04:09 TRT — Director Room + canonical reference audit

### User/product objective

Make the AI Director a natural interactive screenwriter/director rather than a plan-only form: optional durable visual references, multimodal conversation, autonomous creative decisions when the user delegates them, low-cost automatic model routing, persistent archives, broad typed project authority and premium workflow UX.

### Director Room state entering this audit

Already implemented before the audit:

- persistent/resumable Director conversations;
- archive search/rename/archive/unarchive/delete and default-closed archive presentation preference;
- Codex App Server preferred runtime plus bounded official CLI compatibility fallback;
- automatic low-cost Director model routing from the live Codex model catalog, preferring GPT-5.6 Luna + low reasoning when advertised;
- fail-closed image turns: attached images require a real image-capable App Server path and are never silently discarded into text-only fallback;
- composer image file picker, drag/drop and clipboard paste;
- content-addressed Director reference library backed by native image Asset nodes;
- conversation schema v2 attachment metadata with v1 backward compatibility;
- actual Codex `localImage` input for durable references;
- natural Director persona/context instructions;
- typed `makewatch` project/workflow/media tools instead of unrestricted project shell mutation.

### Previous media milestone recorded here for continuity

Before the current reference audit the local media stack had already progressed beyond simple storyboard frames:

- ComfyUI Scene storyboard generation;
- GPU-exclusive local scheduling boundary;
- Chatterbox voice/audio generation;
- FramePack temporal I2V provider/planning/service path;
- temporal `makewatch_media` tools;
- Episode composition compiler;
- deterministic FFmpeg preview/render assembly with camera motion, transitions, timed audio and Scene cache behavior;
- native Generation/Asset provenance for completed outputs.

These paths remain active; current work extends rather than replaces them.

### Release-blocking bugs found during this audit

1. **Canonical reference generation service was dead in the product path.**
   - `AnchorReferenceGenerationService` and its unit test existed.
   - Media gateway did not instantiate it or expose HTTP routes.
   - Shared gateway client did not expose it.
   - Codex dynamic tools could not invoke it.
   - Result: CI could be green while the intended user feature was unreachable.

2. **Stale canonical-reference race.**
   - Target/source revisions were checked before inference but not again after the expensive ComfyUI call.
   - A Character/Location edited during generation could receive output produced from the older revision.

3. **Failed job could expose an artifact.**
   - Artifact metadata was assigned before final native canonical registration.
   - A later registration failure could leave a failed job with a publicly retrievable artifact.

4. **Content-addressed artifact reuse lacked full path verification.**
   - A pre-existing hash path was not required to be a regular file whose bytes re-hash to the expected SHA-256.

5. **Workflow `Add Scene` dead action.**
   - In a non-empty workflow with no Episode, pane context menu displayed `Add Scene` but pressing it raised `Create an Episode before adding a Scene.`
   - This violated the product UX rule that visible actions must be actionable or explicitly disabled for a real state reason.

6. **Documentation drift.**
   - Compact Director/provider/media docs still described older read-only/future-worker assumptions and could mislead future agents even though runtime capabilities had advanced.

### Fixes committed to `main`

Canonical reference generation is now fully reachable:

```text
Codex makewatch_media.reference_generate
        |
        v
GenerationGatewayClient
        |
        v
POST /api/reference/generate
        |
        v
AnchorReferenceGenerationService
        |
        +--> text-only T2I OR durable source-Asset img2img
        +--> GPU scheduler
        +--> content-addressed artifact
        +--> native Generation/Asset provenance
        +--> Character/Location -> generated Asset dependency
```

New media API/tool surface:

- `GET /api/reference/provider`
- `POST /api/reference/generate`
- `GET /api/reference/jobs`
- `GET /api/reference/jobs/:jobId`
- `GET /api/reference/artifacts/:jobId`
- `makewatch_media.reference_provider`
- `makewatch_media.reference_generate`
- `makewatch_media.reference_job`
- `makewatch_media.reference_jobs`

Reference styles currently exposed:

- `live-action-cinematic`
- `anime-cinematic`
- `illustration`
- `stylized-3d`

Reference safety was hardened:

- target/source revisions are rechecked before inference, after inference and before canonical registration;
- stale jobs fail and do not attach output;
- failed/running jobs do not publish artifacts;
- artifact is assigned to public job state only after native registration succeeds;
- existing content-addressed file paths are re-hashed before reuse;
- non-file hash-path collisions fail with integrity error;
- source reference remains immutable.

Workflow UX was hardened:

- `Add Scene` now creates missing Series/Episode scope and the new Scene in one native transaction when necessary;
- clean projects keep the dedicated Quick Start Episode path;
- Episode/Scene lock state disables dependent actions;
- mutation actions consistently respect the shared busy state.

Tests added/expanded:

- reference media dynamic tool presence and input bounds;
- runtime forwarding for reference provider/generate/job operations;
- stale Character mutation during inference must fail;
- stale output must not add a new canonical Asset dependency;
- failed stale job must not expose an artifact;
- previous temporal media tool coverage remains in the same namespace.

### Documentation synchronized

Updated on this checkpoint:

- `AI_DIRECTOR_CONTEXT.md`
- `DIRECTOR_PROVIDERS.md`
- `MEDIA_PIPELINE.md`
- this `DEVELOPMENT_LOG.md`

They now describe the same authority/model/multimodal/reference/temporal behavior as the runtime.

### Verification status at time of writing

All changes are being committed directly to `main` per release instruction. Final release status is **not** declared by this log entry itself. The exact final `main` SHA must pass the repository CI after the last documentation/code commit:

- Studio `Bridge and Director checks`
- Studio TypeScript typecheck
- Studio production build
- Native core Linux configure/build/test
- Native core Windows configure/build/test

Any later fix generated by those checks must receive a new log entry or an amendment below before release is called green.
