# Roadmap

## Status snapshot — 2026-08-30

Foundation v0/v1, the core Studio workflow, WorkerSupervisor/resource admission, local image preview, local voice generation, deterministic composition and FFmpeg preview assembly are implemented. A verified 60-second four-Shot preview now exercises eased camera motion and authored transitions at 24 fps. Media v1 remains incomplete until a licensed video/I2V provider, persistent job recovery and reproducible quality benchmark harness are shipped.

## Foundation v0 — repository and contracts

Exit criteria:

- professional repository layout;
- canonical project brain;
- C++ engine builds independently;
- typed director operations exist;
- initial cross-language schemas exist;
- Studio shell communicates product concepts without pretending generation already works;
- CI validates native and TypeScript foundations.

## Foundation v1 — persistent project graph

- project/episode/scene/shot entities;
- SQLite-backed transactional store;
- migration framework;
- approvals, locks, versions, invalidation events;
- deterministic IDs and asset provenance;
- command/event boundary.

## Studio v1 — premium interactive workflow

- episode board;
- scene/shot drill-down;
- visual workflow graph;
- director panel;
- approval/lock/version controls;
- timeline/animatic shell;
- live resource/job inspector;
- keyboard-first interaction and polished empty/loading/error states.

## Runtime v1 — local job system

- worker lifecycle supervisor;
- capability discovery;
- bounded job queues;
- persistence/recovery;
- hardware profile abstraction;
- explicit resource budgets;
- content-addressed cache.

## Media v1 — first end-to-end local path

- one image provider;
- one voice provider;
- one video/I2V provider;
- FFmpeg/native render adapter;
- storyboard → animatic → final short scene;
- quality measurements and reproducible benchmark harness.

## Long-form milestones

The architecture targets long-form from day one, but validation scales deliberately:

30 seconds → 2 minutes → 5 minutes → 10 minutes → 20 minutes.

At every step we measure peak VRAM/RAM, failure recovery, cache reuse, generation throughput, invalidation scope, continuity metrics, and human-rated output quality.
