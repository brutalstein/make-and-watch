# Background Jobs and Shutdown Ownership

## Purpose

Local media generation creates long-lived model/encoder workers. Those processes must never become an unbounded collection of detached background work, and resource accounting must never claim memory is free while a worker process tree may still be alive.

The runtime ownership stack is now concrete:

```text
WorkerSupervisor
 concrete process tree / handshake / logs / stop confirmation
      |
      v
BackgroundJobRuntime
 bounded queue / lifecycle / sequential shutdown / lease ownership
      |
      v
ResourceManager
 VRAM / RAM / CPU / GPU exclusivity
```

`BackgroundJobRuntime` owns job admission and `ResourceLease`s. `WorkerSupervisor` owns the corresponding operating-system process tree. Neither layer may manufacture completion on behalf of the other.

## State flow

```text
submit
  |
  v
QUEUED
  |
  | start_one_ready + ResourceManager admission
  v
RUNNING / worker STARTING
  |
  | MW_READY_V1 handshake + capability check
  v
READY  ---------------------------------------+
  |                                             |
  | request_cancel / application shutdown       | real process exit
  v                                             |
STOPPING_GRACEFULLY                             |
  |                                             |
  | grace deadline                              |
  v                                             |
TERMINATING                                     |
  |                                             |
  | terminate deadline                          |
  v                                             |
KILLING                                         |
  |                                             |
  +------------- complete process-tree exit ----+
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

> Never release a running job's `ResourceLease` until `WorkerSupervisor` has confirmed that the complete owned worker process tree is gone.

This prevents a dangerous state where the scheduler admits new GPU/RAM work because accounting says capacity is free while an old child/grandchild process still owns CUDA or system memory.

Queued jobs own no lease and may therefore be cancelled immediately.

## Concrete process ownership

### POSIX

Each worker launches in its own process group. Stop escalation signals the group, not only the leader. On Linux, process-group liveness is checked through `/proc` while zombie/dead states are excluded from the live-member decision.

A leader exit while descendants remain is **not** a completed job.

### Windows

Each worker launches with restricted inherited handles and is assigned to a per-worker Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` before execution is resumed. Termination therefore owns the worker tree rather than relying on one PID.

The Windows implementation is compiled and tested in CI under MSVC; it is not inferred from the POSIX implementation.

## Worker protocol

Startup is bounded and typed at the process boundary.

Ready line:

```text
MW_READY_V1<TAB>worker-name<TAB>capability-a,capability-b
```

Graceful stop command:

```text
MW_STOP_V1
```

Rules:

- ready timeout is explicit;
- required capabilities are validated before the worker becomes READY;
- malformed or missing readiness fails closed;
- a worker may emit readiness and exit cleanly between two supervisor pump passes; captured readiness is processed before exit classification so this is not falsely reported as a handshake failure;
- a broken stdin during graceful stop does not abandon cancellation — it advances immediately toward tree-level escalation.

## Bounded logs

Worker stdout/stderr are consumed off the main application loop and retained only as bounded tails. Dropped-byte counters preserve observability without allowing an accidental or hostile worker to consume unbounded RAM through logs.

The first ready line also has a bounded parser contract.

## Bounded queue and ready scan

`BackgroundJobRuntime` has a fixed outstanding-job capacity covering queued + running work.

- duplicate active/queued job IDs are rejected;
- new submissions are rejected when capacity is full;
- new submissions are rejected after shutdown begins;
- resource requests must use the same ID as the job lifecycle record;
- `start_one_ready()` scans in deterministic queue order and starts the first resource-admissible job, so blocked GPU work does not unnecessarily block later safe CPU-only work.

The supervisor never launches a worker until the matching background job has acquired its native resource lease.

## Sequential shutdown

Application shutdown is deliberately serialized by job age:

```text
begin_shutdown
  -> stop accepting new work
  -> cancel all QUEUED jobs
  -> choose oldest RUNNING job
  -> graceful MW_STOP_V1
  -> bounded wait
  -> terminate that one process tree
  -> bounded wait
  -> hard-kill that one process tree if required
  -> confirm complete tree exit
  -> release exactly that lease
  -> choose next running job
  -> repeat
```

`next_shutdown_target()` cannot expose target N+1 while target N is still pending. Wrong-target stop confirmation fails closed.

If the supervisor destructor reaches an emergency path and cannot prove an owned process tree stopped, it fail-stops rather than allowing later RAII destruction to make resource accounting appear free incorrectly.

## Current validation

Real-process native tests cover:

- bounded outstanding capacity and duplicate rejection;
- GPU head-of-line avoidance for CPU-only work;
- cancellation retaining resources until actual process exit;
- fast ready+clean-exit classification;
- required-capability mismatch;
- bounded stdout tails and dropped-byte accounting;
- cooperative graceful shutdown;
- deliberately uncooperative worker escalation;
- deterministic sequential shutdown of multiple live workers;
- final zero active resource leases.

CI executes the native suite on both Linux and Windows. Studio/provider checks run separately.

## Lifetime rule

Ownership order remains:

```text
ResourceManager
  outlives BackgroundJobRuntime
    outlives WorkerSupervisor-owned process confirmation
```

In the application this means worker shutdown must complete before native resource/job ownership is destroyed. C++ object destruction alone is never interpreted as proof that an external worker stopped.

## Next layer

The next runtime work should build **above** this generic safety layer:

1. content-addressed generated-asset/provenance storage;
2. checkpoint/recovery policy;
3. first lightweight storyboard/image worker using the typed supervisor protocol;
4. voice worker;
5. FFmpeg/native composite + episode assembly execution;
6. licensed video/I2V worker behind the explicit render plan;
7. measured scale gates from 30 seconds toward 20 minutes.

Provider-specific model semantics belong above the supervisor. React and Director/provider scripts must never own native resource leases directly.
