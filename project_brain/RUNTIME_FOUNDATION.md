# Runtime Foundation — Resource and Background Safety

## Purpose

The runtime must provide hard safety guarantees below any future synthesis scheduler. A provider, model or AI Director may request work, but it cannot bypass native resource accounting or create unbounded detached background jobs.

The current public safety stack is:

```text
provider estimate
      |
      v
BackgroundJobRuntime
 bounded queue / lifecycle / shutdown ownership
      |
      v
ResourceManager
 VRAM / RAM / CPU / GPU exclusivity
      |
      v
future WorkerSupervisor
 actual process lifetime / health / stop confirmation
```

The adaptive representation/synthesis planner remains separate and is intentionally not implemented in this public layer.

## ResourceManager guarantees

- explicit total and reserved VRAM/RAM budgets;
- CPU-thread admission budget;
- thread-safe accounting;
- duplicate workload IDs rejected;
- exclusive GPU workloads conflict only with other GPU work;
- CPU-only work may continue alongside an exclusive GPU workload if CPU/RAM fit;
- reconfiguration rejected while resources are active;
- overflow-safe capacity checks;
- non-mutating `preview_admission()` using the same admission policy as real acquisition;
- projected post-admission usage/headroom;
- current and high-water VRAM/RAM/CPU telemetry;
- admission/rejection counters;
- move-only `ResourceLease` for scoped ownership.

`ResourceManager` is the hard capacity boundary. Scheduler policy never bypasses it.

## BackgroundJobRuntime guarantees

`BackgroundJobRuntime` now exists directly above resource admission.

It provides:

- fixed outstanding-job capacity for queued + running jobs;
- duplicate job rejection;
- deterministic queue order;
- resource-aware ready scanning;
- no GPU head-of-line blocking for later CPU-only work when it can safely run;
- scoped `ResourceLease` ownership for every running job;
- explicit cancellation-requested state;
- queued cancellation without acquiring resources;
- running cancellation that **retains resource accounting until real stop confirmation**;
- stop-new-work shutdown transition;
- immediate cancellation of queued work during shutdown;
- deterministic oldest-running-first shutdown target;
- exactly one exposed shutdown target at a time;
- wrong-target stop confirmation rejected fail-closed;
- resource release exactly one worker at a time as stops are confirmed.

See `BACKGROUND_JOBS.md` for the full lifecycle contract.

## Critical cancellation rule

A cancellation request is not a completion event.

```text
RUNNING worker
   |
request_cancel
   |
   v
CANCELLATION_REQUESTED
   |        resources remain reserved
   |
actual worker exits
   |
finish / confirm_shutdown_target_stopped
   |
   v
ResourceLease released
```

This prevents false-free resource accounting while an OS process may still own CUDA/RAM allocations.

## Sequential application shutdown direction

The native lifecycle layer defines the order for the future worker supervisor:

1. stop new job admission;
2. discard queued jobs;
3. select one running job;
4. ask that worker to stop;
5. wait for actual exit;
6. release only that job's resources;
7. select the next running job;
8. repeat until zero live jobs/resources.

A future supervisor may escalate one stuck worker from graceful stop to termination after a bounded grace interval, but it must still confirm process exit before releasing the native lease or advancing to the next shutdown target.

## Lifetime ownership

`ResourceManager` must outlive leases. `BackgroundJobRuntime` owns the leases for background jobs and therefore must outlive concrete workers. The future worker supervisor must make this ownership order explicit in application startup/shutdown.

Do not interpret C++ object destruction/RAII cleanup as proof that an external worker process stopped.

## Validation

Strict native tests cover both resource admission and background lifecycle behavior, including:

- previews and protected headroom;
- peak/high-water metrics and counters;
- GPU exclusivity vs CPU-only coexistence;
- scoped lease release and move semantics;
- bounded job capacity;
- duplicate jobs;
- ready scanning around blocked GPU work;
- cancellation retaining active VRAM/RAM/CPU accounting;
- sequential shutdown 3 -> 2 -> 1 -> 0 active workloads;
- exactly one shutdown target at a time;
- wrong-target confirmation preserving resources;
- zero active resource leases after final confirmed shutdown.

## What is not implemented yet

The current background layer does **not** launch Python/model processes. Do not claim a worker supervisor exists yet.

The next runtime milestone is a concrete cross-platform worker supervisor with:

- process handles;
- typed capability/health handshake;
- graceful-stop request;
- bounded grace timeout;
- one-process-at-a-time escalation/termination;
- actual exit confirmation;
- crash detection;
- lifecycle completion routed back into `BackgroundJobRuntime`;
- stdout/stderr limits and structured worker status rather than unbounded log accumulation.

After that, hardware probing/calibration and the first lightweight local providers can safely sit on top.

## IP boundary

This resource/job lifecycle layer is generic safety infrastructure. Patent-sensitive representation selection, perceptual optimization and adaptive synthesis scheduling must remain separate while the repository is public.
