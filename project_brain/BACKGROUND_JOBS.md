# Background Jobs and Shutdown Ownership

## Purpose

Local media generation will eventually create long-lived Python/model/encoder workers. Those processes must never become an unbounded collection of detached background work, and resource accounting must never claim memory is free while a worker may still be alive.

`runtime::BackgroundJobRuntime` is the native lifecycle layer directly above `ResourceManager`.

It currently owns **job admission state and resource leases**. It intentionally does not launch OS processes yet; the next worker-supervisor layer will map one running job to one concrete worker/process handle.

## State flow

```text
submit
  |
  v
QUEUED
  |
  | start_one_ready + ResourceManager admission
  v
RUNNING  ----------------------------+
  |                                    |
  | request_cancel                     | normal finish
  v                                    |
CANCELLATION_REQUESTED                 |
  |                                    |
  +------ actual worker stop ----------+
                 confirmed
                    |
                    v
             ResourceLease release
                    |
                    v
                 FINISHED
```

A cancellation request is **not** a completion signal.

## Hard resource invariant

> Never release a running job's `ResourceLease` until the worker supervisor has confirmed that the underlying work has actually stopped.

This prevents a dangerous state where the scheduler admits new GPU/RAM work because accounting says capacity is free while an old process is still consuming those resources.

Queued jobs own no lease and may therefore be cancelled immediately.

## Bounded queue

`BackgroundJobRuntime` has a fixed outstanding-job capacity covering queued + running work.

- duplicate active/queued job IDs are rejected;
- new submissions are rejected when capacity is full;
- new submissions are rejected after shutdown begins;
- resource requests must use the same ID as the job lifecycle record.

The capacity is a hard safety bound, not a scheduling optimization.

## Ready scan / head-of-line behavior

`start_one_ready()` scans queued jobs in deterministic queue order and starts the first resource-admissible job.

This prevents a blocked GPU request from unnecessarily blocking later CPU-only work. Example:

```text
1. exclusive GPU video   -> starts
2. GPU image             -> blocked by exclusivity
3. CPU transcript        -> may start if CPU/RAM fit
```

The runtime never bypasses `ResourceManager`; it uses `preview_admission()` followed by scoped acquisition.

## Sequential shutdown

Shutdown is deliberately serialized:

```text
begin_shutdown
  -> stop accepting new work
  -> cancel all QUEUED jobs
  -> choose oldest RUNNING job as shutdown target
  -> request that one worker to stop
  -> wait for confirmed exit
  -> release exactly that lease
  -> choose next running job
  -> repeat
```

`next_shutdown_target()` returns the same job until that target is confirmed stopped. It cannot expose target N+1 while target N is still pending.

`confirm_shutdown_target_stopped()` fails closed if the caller tries to confirm a different job.

This gives the future process supervisor a deterministic one-at-a-time teardown contract instead of a kill-all race.

## Current validation

Native tests cover:

- bounded outstanding capacity;
- duplicate rejection;
- GPU head-of-line avoidance for CPU-only work;
- cancellation-requested jobs retaining their resource reservations;
- lease release only after stop/completion confirmation;
- deterministic oldest-first sequential shutdown;
- exactly one shutdown target at a time;
- wrong-target confirmation failing closed;
- resource active-count reduction one-by-one during shutdown;
- zero active resources after final confirmed shutdown.

## Lifetime rule

`ResourceManager` must outlive `BackgroundJobRuntime`, and `BackgroundJobRuntime` must outlive the concrete workers whose leases it owns. The future worker supervisor must enforce this ownership order during application shutdown.

Do not destroy lifecycle ownership while a worker may still be alive and then interpret RAII cleanup as proof that the process stopped.

## Next layer

The next runtime layer should be a worker supervisor that owns concrete process handles and follows this policy per job:

1. request graceful stop;
2. wait for a bounded grace interval;
3. if still alive, terminate that **one** process;
4. wait for actual exit confirmation;
5. call `confirm_shutdown_target_stopped()`;
6. only then advance to the next worker.

Provider-specific worker protocols, health probes and crash recovery belong above this lifecycle layer. React and provider scripts must not own native resource leases directly.
