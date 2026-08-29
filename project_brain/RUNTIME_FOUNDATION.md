# Runtime Foundation — Resource and Background Safety

## Purpose

The runtime provides hard safety guarantees below future media workers/schedulers. A provider, model or AI Director cannot bypass native resource accounting or create unbounded detached background work.

```text
provider/work request
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

Adaptive representation/synthesis planning remains separate and intentionally absent from the public safety layer.

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

`try_acquire_scoped` stages the lease `EntityId` before it mutates resource accounting. This closes a post-acquire allocation window: if identity copying allocates and fails, no workload has been committed yet. After successful admission the staged ID is moved into the lease.

The ResourceManager must outlive every lease it creates.

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

`start_one_ready` now stages queue-owned request data **before** resource admission. After admission it commits the `running_` entry before erasing the queued source.

Therefore:

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
      | -> temporary/acquired RAII lease releases
      | -> original queued request still exists
      v
erase queued source
```

A queue item cannot silently disappear because a post-admission map allocation failed.

## Critical cancellation rule

A cancellation request is not a completion event.

```text
RUNNING worker
   |
request_cancel
   v
CANCELLATION_REQUESTED
   |        resources remain reserved
actual worker exits
   |
finish / confirm_shutdown_target_stopped
   v
ResourceLease released
```

This prevents false-free capacity while an external process may still own CUDA/RAM allocations.

## Sequential application shutdown direction

The future WorkerSupervisor must follow:

1. stop new job admission;
2. cancel/discard queued work;
3. choose the oldest running shutdown target;
4. request graceful stop for that worker;
5. wait boundedly;
6. escalate that one process if required;
7. confirm actual process exit;
8. release that job's native lease;
9. advance to the next worker;
10. finish only when no live jobs/resources remain.

Do not interpret C++ object destruction alone as proof that an external worker stopped.

## Validation

Strict native tests currently cover:

- budget validation and headroom previews;
- high-water resource metrics;
- GPU exclusivity/CPU-only coexistence;
- scoped lease release/move semantics;
- bounded job capacity and duplicate IDs;
- ready scanning around blocked GPU work;
- cancellation retaining resource accounting;
- sequential shutdown and one-target-at-a-time ownership;
- wrong-target failure;
- final zero active leases.

The allocation-failure ordering hardening is structural/RAII code review plus warning-clean CI; deterministic out-of-memory fault injection is not implemented yet and should be added when a native fault-injection harness exists.

## What is not implemented yet

The current background layer does **not** launch Python/model processes.

The next runtime milestone is a concrete cross-platform WorkerSupervisor with:

- concrete process handles;
- typed capability/health handshake;
- graceful-stop protocol;
- bounded grace timeout;
- one-process escalation/termination;
- real exit confirmation;
- crash detection;
- lifecycle completion routed back into `BackgroundJobRuntime`;
- bounded stdout/stderr and structured status.

## IP boundary

This resource/job lifecycle layer is generic safety infrastructure. Patent-sensitive representation selection, perceptual optimization and adaptive synthesis scheduling must remain separate while the repository is public.
