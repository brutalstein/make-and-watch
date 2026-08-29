#include <cstdlib>
#include <iostream>
#include <string>

#include "makewatch/runtime/background_job_runtime.hpp"
#include "makewatch/runtime/resource_manager.hpp"

namespace {

using makewatch::core::EntityId;
using makewatch::runtime::BackgroundJobCompletion;
using makewatch::runtime::BackgroundJobRequest;
using makewatch::runtime::BackgroundJobRuntime;
using makewatch::runtime::ResourceBudget;
using makewatch::runtime::ResourceManager;
using makewatch::runtime::WorkloadRequest;

void require(bool condition, const std::string& message) {
  if (!condition) {
    std::cerr << "FAILED: " << message << '\n';
    std::exit(EXIT_FAILURE);
  }
}

void configure_resources(ResourceManager& resources) {
  require(resources.configure(ResourceBudget{
      .vram_total_mb = 8192,
      .vram_reserve_mb = 1024,
      .ram_total_mb = 32768,
      .ram_reserve_mb = 2048,
      .cpu_threads = 8,
  }).ok(), "resource manager should configure");
}

BackgroundJobRequest job(
    const char* id,
    const char* kind,
    std::uint64_t vram_mb,
    std::uint64_t ram_mb,
    std::uint32_t cpu_threads,
    bool exclusive_gpu = false) {
  const EntityId job_id{id};
  return BackgroundJobRequest{
      .job_id = job_id,
      .kind = kind,
      .resources = WorkloadRequest{
          .workload_id = job_id,
          .vram_mb = vram_mb,
          .ram_mb = ram_mb,
          .cpu_threads = cpu_threads,
          .exclusive_gpu = exclusive_gpu,
      },
  };
}

void test_bounded_submission_and_duplicate_rejection() {
  ResourceManager resources;
  configure_resources(resources);
  BackgroundJobRuntime runtime{resources, 2};

  require(runtime.submit(job("job.a", "image", 512, 512, 1)).ok(),
          "first job should queue");
  require(!runtime.submit(job("job.a", "image", 512, 512, 1)).ok(),
          "duplicate active job id should be rejected");
  require(runtime.submit(job("job.b", "voice", 0, 256, 1)).ok(),
          "second job should fill capacity");
  require(!runtime.submit(job("job.c", "image", 256, 256, 1)).ok(),
          "bounded outstanding capacity should reject overflow");

  const auto snapshot = runtime.snapshot();
  require(snapshot.queued_jobs == 2 && snapshot.running_jobs == 0,
          "bounded queue snapshot should report queued jobs");
}

void test_ready_scan_avoids_gpu_head_of_line_blocking() {
  ResourceManager resources;
  configure_resources(resources);
  BackgroundJobRuntime runtime{resources, 6};

  require(runtime.submit(job("gpu.exclusive", "video", 6000, 4096, 3, true)).ok(),
          "exclusive GPU job should queue");
  require(runtime.submit(job("gpu.blocked", "image", 512, 512, 1)).ok(),
          "second GPU job should queue");
  require(runtime.submit(job("cpu.ready", "transcript", 0, 384, 1)).ok(),
          "CPU-only job should queue");

  auto started = runtime.start_one_ready();
  require(started.ok() && started.started() && started.job_id->value() == "gpu.exclusive",
          "oldest admissible exclusive GPU job should start first");

  started = runtime.start_one_ready();
  require(started.ok() && started.started() && started.job_id->value() == "cpu.ready",
          "ready scan should skip blocked GPU work and admit CPU-only work");

  auto snapshot = runtime.snapshot();
  require(snapshot.running_jobs == 2 && snapshot.queued_jobs == 1,
          "blocked GPU job should remain queued while CPU work runs");
  require(snapshot.resources.active_gpu_workloads == 1 &&
              snapshot.resources.exclusive_gpu_active,
          "resource snapshot should preserve exclusive GPU ownership");

  require(runtime.finish(EntityId{"cpu.ready"}, BackgroundJobCompletion::kCompleted).ok(),
          "CPU job completion should release its lease");
  require(runtime.finish(EntityId{"gpu.exclusive"}, BackgroundJobCompletion::kCompleted).ok(),
          "exclusive GPU completion should release its lease");

  started = runtime.start_one_ready();
  require(started.ok() && started.started() && started.job_id->value() == "gpu.blocked",
          "previously blocked GPU job should start after exclusive work drains");
  require(runtime.finish(EntityId{"gpu.blocked"}, BackgroundJobCompletion::kCompleted).ok(),
          "final GPU job should finish cleanly");
}

void test_running_cancel_holds_resources_until_stop_confirmation() {
  ResourceManager resources;
  configure_resources(resources);
  BackgroundJobRuntime runtime{resources, 4};
  require(runtime.submit(job("job.cancel", "image", 2048, 1024, 2)).ok(),
          "cancellable job should queue");
  const auto started = runtime.start_one_ready();
  require(started.started(), "cancellable job should start");

  require(runtime.request_cancel(EntityId{"job.cancel"}).ok(),
          "running cancellation should be requested");
  auto snapshot = runtime.snapshot();
  require(snapshot.cancellation_requested_jobs == 1 &&
              snapshot.resources.active_workloads == 1 &&
              snapshot.resources.vram_used_mb == 2048,
          "cancel request must not release resources before worker stop confirmation");

  require(runtime.finish(EntityId{"job.cancel"}, BackgroundJobCompletion::kCancelled).ok(),
          "worker stop confirmation should finish cancelled job");
  snapshot = runtime.snapshot();
  require(snapshot.running_jobs == 0 && snapshot.resources.active_workloads == 0 &&
              snapshot.resources.vram_used_mb == 0 && snapshot.cancelled_total == 1,
          "confirmed stop should release the exact resource lease");
}

void test_shutdown_stops_running_jobs_exactly_one_at_a_time() {
  ResourceManager resources;
  configure_resources(resources);
  BackgroundJobRuntime runtime{resources, 8};

  require(runtime.submit(job("job.1", "cpu", 0, 256, 1)).ok(), "job 1 should queue");
  require(runtime.submit(job("job.2", "cpu", 0, 256, 1)).ok(), "job 2 should queue");
  require(runtime.submit(job("job.3", "cpu", 0, 256, 1)).ok(), "job 3 should queue");
  require(runtime.start_one_ready().started(), "job 1 should start");
  require(runtime.start_one_ready().started(), "job 2 should start");
  require(runtime.start_one_ready().started(), "job 3 should start");
  require(runtime.submit(job("job.queued", "cpu", 0, 256, 1)).ok(),
          "one extra job should remain queued for shutdown cancellation");

  require(runtime.begin_shutdown().ok(), "shutdown should begin");
  auto snapshot = runtime.snapshot();
  require(snapshot.shutting_down && !snapshot.accepting_jobs && snapshot.queued_jobs == 0 &&
              snapshot.running_jobs == 3 && snapshot.cancelled_total == 1,
          "shutdown should stop admission and cancel queued work immediately");
  require(!runtime.submit(job("job.late", "cpu", 0, 128, 1)).ok(),
          "new work must be rejected after shutdown begins");

  auto target = runtime.next_shutdown_target();
  require(target.ok() && target.job_id.has_value() && target.job_id->value() == "job.1",
          "oldest running job should be first shutdown target");
  const auto repeated = runtime.next_shutdown_target();
  require(repeated.job_id.has_value() && repeated.job_id->value() == "job.1",
          "shutdown must not expose a second target before first stop confirmation");
  require(runtime.snapshot().resources.active_workloads == 3,
          "resources remain reserved while first target is still alive");

  require(runtime.confirm_shutdown_target_stopped(EntityId{"job.1"}).ok(),
          "first stopped worker should release first lease");
  require(runtime.snapshot().resources.active_workloads == 2,
          "only one workload should be released after first confirmation");

  target = runtime.next_shutdown_target();
  require(target.job_id.has_value() && target.job_id->value() == "job.2",
          "second job should become target only after first stopped");
  require(runtime.confirm_shutdown_target_stopped(EntityId{"job.2"}).ok(),
          "second shutdown target should confirm");
  require(runtime.snapshot().resources.active_workloads == 1,
          "second confirmation should release exactly one more lease");

  target = runtime.next_shutdown_target();
  require(target.job_id.has_value() && target.job_id->value() == "job.3",
          "third job should be final target");
  require(runtime.confirm_shutdown_target_stopped(EntityId{"job.3"}).ok(),
          "final shutdown target should confirm");
  require(runtime.shutdown_complete(), "runtime should report complete sequential shutdown");

  snapshot = runtime.snapshot();
  require(snapshot.resources.active_workloads == 0 && snapshot.running_jobs == 0 &&
              snapshot.cancelled_total == 4,
          "shutdown completion should leave no resource leases or background jobs");
}

void test_invalid_shutdown_confirmation_is_fail_closed() {
  ResourceManager resources;
  configure_resources(resources);
  BackgroundJobRuntime runtime{resources, 2};
  require(runtime.submit(job("job.safe", "cpu", 0, 256, 1)).ok(), "safe job should queue");
  require(runtime.start_one_ready().started(), "safe job should start");
  require(runtime.begin_shutdown().ok(), "shutdown should begin");
  require(runtime.next_shutdown_target().job_id.has_value(), "shutdown target should exist");

  require(!runtime.confirm_shutdown_target_stopped(EntityId{"other"}).ok(),
          "wrong stop confirmation must fail closed");
  require(runtime.snapshot().resources.active_workloads == 1,
          "wrong confirmation must not release live worker resources");
  require(runtime.confirm_shutdown_target_stopped(EntityId{"job.safe"}).ok(),
          "correct confirmation should release the worker");
}

}  // namespace

int main() {
  test_bounded_submission_and_duplicate_rejection();
  test_ready_scan_avoids_gpu_head_of_line_blocking();
  test_running_cancel_holds_resources_until_stop_confirmation();
  test_shutdown_stops_running_jobs_exactly_one_at_a_time();
  test_invalid_shutdown_confirmation_is_fail_closed();
  std::cout << "background_job_runtime_test: all checks passed\n";
  return EXIT_SUCCESS;
}
