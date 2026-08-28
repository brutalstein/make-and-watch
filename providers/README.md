# Providers

Providers are replaceable adapters around the stable Make & Watch engine contracts.

Planned categories:

- `director/` — Claude, Codex, manual director.
- `image/` — local image generation backends.
- `video/` — local video / image-to-video backends.
- `voice/` — local TTS / voice-cloning backends.
- `audio/` — SFX/music generation and libraries.
- `quality/` — identity, continuity, artifact, motion, and composition evaluators.
- `render/` — FFmpeg/native media integration.

A provider must declare capabilities and requirements. Core domain code must never include provider-specific SDK headers or model concepts.
