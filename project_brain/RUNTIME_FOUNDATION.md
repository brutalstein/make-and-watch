# Runtime Foundation — Resource, Jobs, and Worker Safety

## Purpose

The runtime is the hard safety boundary below future media workers and schedulers. A provider, model, AI Director, or Studio surface cannot bypass native resource accounting or create unbounded detached background work.

```text
provider / render request
      |
      v
WorkerSupervisor
 concrete worker process-tree lifetime / protocol / bounded logs
      |
      v
BackgroundJobRuntime
 bounded queue / lifecycle / shutdown ownership
      |
      v
ResourceManager
 VRAM / RAM / CPU / GPU exclusivity
```

Adaptive representation/synthesis planning remains separate and intentionally absent from this public generic safety layer.

## ResourceManager guarantees

- explicit total/reserved VRAM and RAM budgets;
- CPU-thread budget;
- thread-safe accounting;
- duplicate workload rejection;
- GPU exclusivity rules;
- protected headroom previews using the same policy as acquisition;
- peak/current telemetry and admission/rejection counters;
- move-only scoped `ResourceLease` ownership;
- no reconfiguration while workloads are active.

### Scoped acquisition commit safety

`try_acquire_scoped` stages the lease `EntityId` before it mutates resource accounting. If identity copying allocates and fails, no workload has been committed. After successful admission the staged ID is moved into the lease.

`ResourceManager` must outlive every lease it creates.

## BackgroundJobRuntime guarantees

- fixed outstanding queued+running capacity;
- duplicate job rejection;
- deterministic queue order;
- first resource-admissible ready scan;
- blocked GPU work does not unnecessarily block later safe CPU-only work;
- every running job owns a `ResourceLease`;
- cancel request is distinct from confirmed completion;
- a running cancellation retains resources until actual stop confirmation;
- shutdown stops admission, clears queued work and drains one running target at a time;
- wrong-target stop confirmation fails closed.

### Queue -> running commit safety

`start_one_ready` stages queue-owned request data **before** resource admission. After admission it commits the `running_` entry before erasing the queued source.

```text
copy/stage queued request
      |
      | allocation failure -> queue unchanged, no resource acquired
      v
ResourceLease acquire
      |
      v
running_ map commit
      |
      | allocation/value construction failure
      | -> temporary RAII lease releases
      | -> original queued request still exists
      v
erase queued source
```

A queue item cannot silently disappear because of a post-admission allocation failure.

## WorkerSupervisor guarantees

`WorkerSupervisor` is now the concrete process owner above `BackgroundJobRuntime`.

- one logical running job maps to one owned worker process tree;
- startup is non-blocking and advanced by `pump()`;
- readiness uses the bounded `MW_READY_V1` handshake;
- required capability tokens are checked before READY;
- stdout/stderr retention is bounded, with dropped-byte telemetry;
- quick workers that emit readiness and then exit cleanly are classified correctly;
- crash detection is separate from cancellation;
- cancellation sends `MW_STOP_V1`, then escalates after explicit deadlines;
- failure to write the graceful stop command never releases resources early;
- lifecycle/accounting errors fail closed and prevent fresh admission in the same pump pass;
- resource leases release only after complete process-tree exit confirmation.

### POSIX ownership

Workers run in dedicated process groups. Signals target the group. Linux checks `/proc` to distinguish live descendants from zombie/dead members before declaring the tree stopped.

### Windows ownership

Workers launch suspended with restricted handle inheritance, are assigned to a per-worker Job Object with kill-on-close behavior, and are then resumed. This prevents child/grandchild process escape from a worker lease.

## Critical cancellation rule

A cancellation request is not a completion event.

```text
RUNNING worker tree
   |
request_cancel
   v
CANCELLATION_REQUESTED
   |        resources remain reserved
MW_STOP_V1 / terminate / kill
   |
complete tree exits
   |
finish / confirm_shutdown_target_stopped
   v
ResourceLease released
```

This prevents false-free capacity while an external process may still own CUDA/RAM allocations.

## Sequential application shutdown

The concrete implementation follows:

1. stop new job admission;
2. cancel/discard queued work;
3. choose the oldest running shutdown target;
4. request graceful stop for that worker;
5. wait boundedly;
6. terminate that one process tree if required;
7. hard-kill that one tree if required;
8. confirm actual tree exit;
9. release that job's native lease;
10. advance to the next worker;
11. finish only when no live jobs/resources remain.

A destructor emergency path does not reinterpret object cleanup as process confirmation. If it cannot prove exit, it fail-stops rather than advertise false resource availability.

## Process and bridge hardening around the runtime

The development bridge now guards native child-process/stdin/stdout/stderr transport errors, bounds incomplete JSONL buffering, coalesces expensive GPU telemetry probes, and gives the native host a bounded graceful EOF shutdown before escalation.

Director provider children on POSIX run in owned process groups so the existing bounded provider lifecycle terminates descendants as well as the leader. Windows continues to use explicit process-tree termination behavior for provider compatibility paths.

## Validation

Strict native tests cover:

- resource budget validation and headroom previews;
- high-water resource metrics;
- GPU exclusivity/CPU-only coexistence;
- scoped lease release/move semantics;
- bounded job capacity and duplicate IDs;
- ready scanning around blocked GPU work;
- cancellation retaining resource accounting;
- real worker handshake and fast clean exit;
- capability mismatch;
- bounded log capture;
- uncooperative-worker escalation;
- sequential multi-worker shutdown;
- final zero active leases.

CI builds and runs the native suite on **Linux and Windows/MSVC**, while Studio/Director syntax, checks, typecheck, and production build run in the Studio job.

## Next runtime milestone

The process-lifetime foundation is present. Next work should add resumable media state rather than another process wrapper:

1. content-addressed generated-asset/provenance store;
2. checkpoint/recovery policy;
3. first lightweight storyboard/image worker;
4. voice worker;
5. FFmpeg/native composite and assembly execution;
6. licensed video/I2V worker;
7. hardware/throughput benchmarks from 30 seconds toward 20 minutes.

## IP boundary

This resource/job/process lifecycle layer is generic safety infrastructure. Patent-sensitive representation selection, perceptual optimization, and adaptive synthesis scheduling must remain separate while the repository is public.
