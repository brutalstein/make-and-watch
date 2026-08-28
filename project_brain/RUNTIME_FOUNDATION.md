# Runtime Foundation — Resource Safety Layer

## Purpose

The eventual synthesis planner may be sophisticated, but the runtime still needs a simple hard safety boundary beneath it. No provider or AI Director is allowed to overcommit declared machine resources just because it believes a shot is important.

`runtime::ResourceManager` is that first boundary.

## Current guarantees

- Explicit total and reserved VRAM/RAM budgets.
- CPU thread admission budget.
- Thread-safe workload accounting.
- Duplicate workload IDs are rejected.
- Exclusive GPU workloads conflict only with other GPU-using workloads; CPU-only audio/metadata work can continue safely while the GPU is exclusively reserved.
- Reconfiguration is rejected while work is active.
- Admission uses subtraction-based bounds checks so capacity checks do not depend on potentially overflowing additions.
- `preview_admission()` evaluates the exact same admission policy without mutating reservations or counters.
- Admission previews expose projected usage and remaining VRAM/RAM/CPU headroom.
- Runtime snapshots expose current usage, remaining capacity, active workload count, active GPU workload count, and exclusive state.
- High-water telemetry records peak admitted VRAM, RAM, and CPU-thread usage.
- Admission/rejection counters provide objective runtime evidence for later benchmark and scheduler tuning.
- `ResourceLease` provides move-only RAII ownership so early returns and normal exceptions do not silently leak workload reservations.

## Resource ownership model

```text
provider estimate
      |
      v
preview_admission()      <-- no mutation
      |
      v
try_acquire() / try_acquire_scoped()
      |
      +--> hard VRAM reserve
      +--> hard RAM reserve
      +--> CPU thread budget
      +--> GPU exclusivity policy
      |
      v
admitted workload
      |
      v
release() / ResourceLease destructor
```

`ResourceLease` is intentionally a runtime-local ownership primitive. The `ResourceManager` that issued a lease must outlive that lease. Long-lived worker supervision will own managers and leases at a higher layer rather than exposing them to React or provider scripts.

## GPU exclusivity semantics

GPU exclusivity applies to GPU use, not to every active task.

Examples:

- an exclusive video diffusion job blocks another GPU image/video/validator job;
- an exclusive video job does **not** block CPU-only transcript parsing or CPU-only audio preparation if RAM/CPU budgets still fit;
- a new exclusive GPU job waits until existing GPU work drains;
- duplicate workload IDs are rejected independently of resource fit.

This distinction prevents unnecessary system-wide serialization while retaining a hard GPU safety boundary.

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

1. Native hardware probe produces a `ResourceBudget` and capability profile.
2. Provider manifests expose conservative workload estimates.
3. A bounded native pending-job layer requests ResourceManager admission before process launch.
4. Worker supervisor owns scoped resource leases for the complete worker/job lifetime.
5. Runtime telemetry reconciles estimates with measured high-water marks.
6. Repeated estimate error feeds future provider calibration.
7. Scheduler policy stays separate from the hard admission boundary so optimization cannot bypass safety.

The public repository should keep this generic safety layer separate from any unpublished synthesis-selection invention.
