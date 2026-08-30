# AI Director Providers

> Current status: 2026-08-30 04:09 TRT (Europe/Istanbul)

## Goal

Make & Watch uses a cloud/first-party reasoning layer as an interactive screenwriter/director while authoritative project state, media generation, worker lifecycle and rendering remain local.

This is **project-scoped specialization**, not model fine-tuning. Provider conversation is useful creative context, but plain model text is never project truth. Actual changes become truth only after typed Make & Watch tools pass native validation and commit.

## Authentication boundary

Make & Watch must never copy credential caches, session tokens or subscription OAuth tokens. Codex authentication stays owned by the official Codex client/App Server. React receives only sanitized provider state.

Official integration direction checked during the August 2026 implementation:

- Codex App Server is the preferred interactive integration.
- Official Codex CLI `exec` is a bounded compatibility fallback when App Server is unavailable.
- Claude Code local subscription routing remains developer-preview/policy-gated; shipping Claude chat waits for a supported Anthropic product/API path.

## Codex runtime selection

Runtime selection is capability-driven:

```text
Codex CLI detected
      |
      +-- App Server initializes
      |       -> permission-profile discovery
      |       -> account/read
      |       -> ChatGPT browser auth when required
      |       -> provider-native multi-turn threads
      |       -> image/localImage turns
      |       -> dynamic Make & Watch tools
      |
      +-- App Server unavailable
              -> bounded official codex exec probe
              -> ChatGPT login status required
              -> read-only compatibility chat/plan
              -> no image pretending / no hidden multimodal fallback
```

`runtimeMode` is surfaced as `app_server`, `exec_fallback`, or `none`.

## Automatic Director model profile

Routine Director Room conversation should not require a model picker.

The App Server model catalog is inspected at runtime. Make & Watch prefers the configured inexpensive multilingual Director profile when it is actually advertised by that installed Codex build/account. The current preferred profile is GPT-5.6 Luna with low reasoning. If it is unavailable, a compatible advertised fallback is selected rather than hard-failing on a stale model string.

Rules:

- routine dialogue uses a low reasoning budget;
- costly reasoning is reserved for tasks that actually need it;
- image-bearing turns require an advertised image-capable App Server model;
- the exec compatibility path must never silently discard an image and then claim it was seen;
- model/profile information is surfaced as status, not as a mandatory user decision.

## App Server safety and lifecycle

The bridge owns one App Server process and negotiates a read-only provider execution profile. Provider-side filesystem/shell access is not the project mutation mechanism.

Project authority is instead exposed through typed dynamic tools. This separation is intentional:

```text
Codex reasoning/thread
      |
      +--> provider sandbox / read-only client context
      |
      +--> makewatch tools
      |       -> native ProjectSession / revision / lock / journal
      |
      +--> makewatch_media tools
              -> bounded localhost media gateway
              -> GPU scheduler / generation services
              -> native provenance commit
```

A rejected/failed provider turn must not kill the bridge. Owned child processes, turn-completion promises, shutdown, output limits and timeout paths are bounded and guarded.

## Interactive Director Room

Director Room is conversational rather than form-driven.

The Director should:

- understand natural multilingual requests;
- act like a screenwriter/director/visual-development collaborator;
- ask only blocking questions;
- make creative choices when the user delegates them;
- reuse established Character/Location continuity instead of inventing duplicates;
- accept optional image references;
- use typed tools when the user asks for an actual project/media change;
- clearly distinguish discussion from committed state.

### Durable image attachments

Studio supports reference images through file selection, drag/drop and clipboard paste. Uploads are not pasted into prompts as fragile filesystem strings.

Flow:

```text
Studio composer image
   -> localhost media gateway
   -> content validation + SHA-256 storage
   -> native image Asset registration
   -> conversation attachment stores Asset ID/hash metadata
   -> Codex App Server receives actual localImage input
```

Conversation archive schema v2 persists attachment links. Older v1 conversations remain readable with empty attachment arrays until rewritten. A provider failure after image submission is recorded; the system does not replay the image turn through a text-only fallback.

## Typed project authority

Interactive Director chat may mutate semantic project state **only** through typed `makewatch` tools. This is not unrestricted shell access.

Current project/workflow capabilities include:

- project snapshot/query/history/impact;
- revision-checked atomic project apply;
- workflow new/save/list/load/delete with recovery behavior;
- authoritative production schema inspection;
- Scene storyboard generation;
- Audio generation;
- Episode composition inspection and render start;
- bounded media job inspection.

Locks, cycles, expected project revision and journal/recovery remain native authority. Direct SQLite mutation, DOM click automation and arbitrary project-file edits are not allowed as substitutes.

## Canonical Character/Location reference generation

`makewatch_media` now includes real canonical reference operations:

- `reference_provider`
- `reference_generate`
- `reference_job`
- `reference_jobs`

`reference_generate` accepts an existing Character or Location target plus an optional image Asset.

Without a source Asset it performs text-to-image canonical design. With an image Asset it performs reference-guided img2img through standard ComfyUI primitives. Supported explicit styles currently include:

- `live-action-cinematic`
- `anime-cinematic`
- `illustration`
- `stylized-3d`

The source Asset is never overwritten. Successful output creates/uses a content-addressed image Asset and Generation provenance, then makes the target Character/Location depend on that generated Asset.

Important fail-closed invariants:

- target must be Character or Location and unlocked;
- optional source must remain an image Asset;
- target/source revisions are captured when the job is submitted;
- they are checked before generation, after the expensive generation step, and again before canonical registration;
- stale output cannot become a canonical dependency;
- a failed job does not publish its artifact endpoint;
- a pre-existing content-addressed path is re-hashed before reuse;
- native revision/lock/cycle validation still owns the final commit.

## Temporal video tools

The same `makewatch_media` namespace retains temporal Shot execution:

- `temporal_providers`
- `shot_temporal_plan`
- `shot_generate_video`
- `temporal_job`
- `temporal_jobs`

Current local temporal implementation includes the FramePack provider path with bounded hardware/resource policy. The Director must inspect provider/readiness and the Shot plan before claiming a video can be produced.

## Local media boundary

Codex never shells directly into ComfyUI, FramePack, Chatterbox or FFmpeg as the authoritative product path. Typed tools delegate to the localhost media gateway, which owns execution limits and provenance writes.

Current local media paths include:

- ComfyUI storyboard frames;
- ComfyUI canonical Character/Location T2I/img2img references;
- Chatterbox voice/audio generation;
- FramePack temporal I2V;
- deterministic Episode composition and preview/render assembly.

GPU-heavy reference/storyboard/video work is serialized through the local GPU scheduling boundary rather than independently overcommitting VRAM.

## Planning path

Provider-generated `AutopilotPlan` output remains schema-constrained and validated against the live project before any later execution:

```text
provider
 -> AutopilotPlan schema
 -> Studio validation
 -> exact live native revision check
 -> autonomy/capability policy
 -> optional checkpoint
 -> native transaction if execution is authorized
```

Assist plan preview remains non-mutating. Interactive chat tool calls are a separate explicitly typed execution path.

## Composer/readiness behavior

Provider readiness must not disable typing. The first Send may initiate official Codex sign-in while preserving the queued text. If connection fails before submission, the composer restores it. If a provider turn may already have started, Studio avoids automatic replay to prevent duplicate turns.

Image attachments are uploaded and registered before the turn is submitted. The Send action remains disabled while an attachment upload is unresolved/failed, rather than sending a partial prompt.

## Conversation persistence

App Server mode uses a provider-native Codex thread per Director conversation. The Make & Watch conversation archive is also durable and stores user/assistant/system messages plus attachment metadata.

Exec compatibility mode carries only a bounded recent transcript and cannot claim provider-native thread ownership.

Archive operations support recent/archived search, rename, archive/unarchive and explicit deletion. Archive presentation is closed by default and its UI preference is persisted independently from conversation data.

## Context economy

Runtime requests do not dump the repository or entire journal by default.

- first-turn project context is bounded and deterministic;
- later App Server turns rely on provider-native thread continuity plus targeted live project context;
- project queries are preferred to full snapshots for focused work;
- dynamic tool results are byte/character bounded;
- low-cost model routing prevents routine conversation from consuming high-reasoning budgets unnecessarily.

## Shutdown / failure behavior

- missing CLI: report unavailable; never fake connection;
- App Server failure: record a bounded diagnostic and use official CLI compatibility only when safe;
- image turn without a real image-capable App Server path: fail explicitly;
- malformed provider output: never becomes project state;
- concurrent provider run: reject/serialize rather than overlap hidden state;
- media queue/provider failure: return authoritative job/provider error rather than fabricate an artifact;
- bridge shutdown: drain/terminate owned provider processes cleanly;
- local project operation remains available when AI/media providers are offline.

## Product-machine validation

CI covers deterministic provider protocol helpers, dynamic tool contracts, conversation persistence, reference-generation provenance, stale-output rejection, TypeScript and production build. Product-machine smoke validation must additionally exercise the real local account/GPU services:

1. Codex App Server authenticates through the installed official client;
2. automatic Director model routing resolves an advertised compatible model;
3. text conversation resumes correctly;
4. pasted/dragged/uploaded image is visible to a real image-capable turn;
5. image attachment survives conversation reload;
6. `reference_generate` can create a Character/Location reference from text;
7. an uploaded image Asset can drive `anime-cinematic` img2img and attach only after native commit;
8. editing the target while generation runs causes stale rejection rather than attachment;
9. temporal/video/audio providers report real readiness before execution;
10. shutdown leaves no owned provider/media bridge process orphaned.