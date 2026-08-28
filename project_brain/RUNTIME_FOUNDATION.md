# Runtime Foundation — Resource Safety Layer

## Purpose

The eventual synthesis planner may be sophisticated, but the runtime still needs a simple hard safety boundary beneath it. No provider or AI Director is allowed to overcommit declared machine resources just because it believes a shot is important.

`runtime::ResourceManager` is that first boundary.

## Current guarantees

- Explicit total and reserved VRAM/RAM budgets.
- CPU thread admission budget.
- Thread-safe workload accounting.
- Duplicate workload IDs are rejected.
- Exclusive GPU workloads cannot overlap other GPU jobs.
- Reconfiguration is rejected while work is active.
- Admission uses subtraction-based bounds checks to avoid integer-overflow-style overcommit mistakes.
- Runtime telemetry exposes usable/used memory, active job count, CPU allocation, and exclusive state.

## Example for an 8 GB GPU

```text
Physical VRAM      8192 MB
Safety reserve     1024 MB
Usable by engine   7168 MB
```

The reserve is intentionally unavailable to model workers. It leaves headroom for the desktop compositor, driver allocations, CUDA/runtime overhead, and estimate error.

## What this is not

This is not the patent-sensitive adaptive synthesis planner. It does not decide whether a shot should use full video, I2V, avatar animation, or another representation. It only enforces hard runtime admission policy after a workload estimate exists.

## Next runtime layers

1. Hardware probe produces a `ResourceBudget` and capability profile.
2. Provider manifests expose conservative workload estimates.
3. Scheduler requests admission before starting a worker.
4. Runtime telemetry reconciles estimates with measured high-water marks.
5. Repeated estimate error feeds future provider calibration.

The public repository should keep this generic safety layer separate from any unpublished synthesis-selection invention.
