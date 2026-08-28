# Vision

## Product thesis

Long-form generative media should not be a single opaque prompt-to-video job. It should behave like a modern creative production system: inspectable, reversible, approval-driven, resumable, resource-aware, and editable at multiple levels of detail.

A user may begin with one natural-language idea, but Make & Watch must first expose the planned creative structure — series bible, episode outline, scenes, storyboards, shots, animatic — before expensive final synthesis.

## Core experience

The same project graph is manipulated through two synchronized surfaces:

- **Director surface:** natural-language commands through one connected AI director (for example a supported Claude or Codex integration).
- **Studio surface:** a premium visual workflow with episode, scene, shot, timeline, approval, resource, and quality views.

Neither surface owns project truth. The local engine owns project truth.

## Local-first promise

Image, video, speech, audio, caching, validation, compositing, and rendering are designed around replaceable local providers. Optional remote providers may exist later, but the architecture must never require a paid media API to open or edit a project.

## Long-form strategy

A 20-minute episode is treated as a graph of small, versioned, dependency-tracked creative units rather than one monolithic generation. The runtime may choose different production representations per shot, cache accepted assets, reuse locked creative state, and regenerate only invalidated work.

## Quality philosophy

Premium does not mean decorative gradients. Premium means:

- the system explains what it is doing;
- costly work happens only when justified;
- the user can approve, lock, compare, revert, and regenerate precisely;
- crashes do not destroy progress;
- project state is deterministic and portable;
- hardware limitations change the execution plan rather than silently corrupting quality;
- the UI remains responsive while heavy work is running.

## Explicit non-goals for the foundation

- Training a foundation video model from scratch.
- Coupling the core to one model family.
- Hiding project state inside an LLM conversation.
- Letting an AI agent mutate arbitrary project files or execute unrestricted runtime actions.
- Requiring cloud compute for normal project operation.
