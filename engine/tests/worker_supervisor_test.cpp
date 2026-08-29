#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <string>
#include <thread>

#include "makewatch/core/id.hpp"
#include "makewatch/runtime/background_job_runtime.hpp"
#include "makewatch/runtime/resource_manager.hpp"
#include "makewatch/runtime/worker_supervisor.hpp"

namespace {

using namespace std::chrono_literals;
using makewatch::core::EntityId;
using makewatch::runtime::BackgroundJobRequest;
using makewatch::runtime::BackgroundJobRuntime;
using makewatch::runtime::ResourceBudget;
using makewatch::runtime::ResourceManager;
using makewatch::runtime::WorkerLaunchSpec;
using makewatch::runtime::WorkerSupervisor;
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

BackgroundJobRequest job(const char* id, std::uint64_t vram_mb = 0) {
  const EntityId job_id{id};
  return BackgroundJobRequest{
      .job_id = job_id,
      .kind = "worker-test",
      .resources = WorkloadRequest{
          .workload_id = job_id,
          .vram_mb = vram_mb,
          .ram_mb = 256,
          .cpu_threads = 1,
          .exclusive_gpu = false,
      },
  };
}

WorkerLaunchSpec spec(
    const std::filesystem::path& fixture,
    const char* mode,
    std::size_t tail_bytes = 64 * 1024) {
  WorkerLaunchSpec result;
  result.executable = fixture;
  result.arguments = {mode};
  result.required_capabilities = {"image"};
  result.ready_timeout = 1500ms;
  result.graceful_stop_timeout = 80ms;
  result.terminate_timeout = 120ms;
  result.hard_kill_timeout = 750ms;
  result.stdout_tail_bytes = tail_bytes;
  result.stderr_tail_bytes = tail_bytes;
  return result;
}

template <typename Predicate>
void pump_until(
    WorkerSupervisor& supervisor,
    Predicate predicate,
    const std::string& message,
    std::chrono::milliseconds timeout = 4s) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < deadline) {
    const auto pumped = supervisor.pump(0);
    require(pumped.ok(), message + " (pump failed: " + pumped.status.message + ")");
    if (predicate(supervisor.snapshot())) return;
    std::this_thread::sleep_for(10ms);
  }
  require(false, message + " (timed out)");
}

void test_fast_ready_exit_is_completed(const std::filesystem::path& fixture) {
  ResourceManager resources;
  configure_resources(resources);
  BackgroundJobRuntime jobs{resources, 4};
  WorkerSupervisor supervisor{jobs};

  require(supervisor.submit(job("quick", 512), spec(fixture, "quick-exit")).ok(),
          "quick worker should submit");
  const auto first = supervisor.pump(1);
  require(first.ok() && first.launched == 1, "quick worker should launch");

  pump_until(supervisor, [](const auto& snapshot) {
    return snapshot.active_workers == 0 && snapshot.completed_process_total == 1;
  }, "quick ready+exit worker should complete instead of failing handshake");

  const auto snapshot = supervisor.snapshot();
  require(snapshot.jobs.resources.active_workloads == 0 &&
              snapshot.jobs.resources.vram_used_mb == 0,
          "quick worker completion should release its exact resource lease");
}

void test_cancel_holds_lease_until_real_exit(const std::filesystem::path& fixture) {
  ResourceManager resources;
  configure_resources(resources);
  BackgroundJobRuntime jobs{resources, 4};
  WorkerSupervisor supervisor{jobs};

  require(supervisor.submit(job("cancel", 2048), spec(fixture, "cooperative")).ok(),
          "cooperative worker should submit");
  require(supervisor.pump(1).ok(), "cooperative worker should launch");
  pump_until(supervisor, [](const auto& snapshot) {
    return snapshot.ready_workers == 1;
  }, "cooperative worker should become ready");

  require(supervisor.request_cancel(EntityId{"cancel"}).ok(),
          "running worker cancellation should start");
  auto snapshot = supervisor.snapshot();
  require(snapshot.jobs.resources.active_workloads == 1 &&
              snapshot.jobs.resources.vram_used_mb == 2048,
          "cancel request must retain resources until process-tree exit is confirmed");

  pump_until(supervisor, [](const auto& current) {
    return current.active_workers == 0 && current.cancelled_process_total == 1;
  }, "cooperative worker should stop and finalize cancellation");
  snapshot = supervisor.snapshot();
  require(snapshot.jobs.resources.active_workloads == 0 &&
              snapshot.jobs.resources.vram_used_mb == 0,
          "confirmed cooperative exit should release resources");
}

void test_uncooperative_worker_escalates(const std::filesystem::path& fixture) {
  ResourceManager resources;
  configure_resources(resources);
  BackgroundJobRuntime jobs{resources, 4};
  WorkerSupervisor supervisor{jobs};

  require(supervisor.submit(job("stubborn"), spec(fixture, "ignore-stop")).ok(),
          "stubborn worker should submit");
  require(supervisor.pump(1).ok(), "stubborn worker should launch");
  pump_until(supervisor, [](const auto& snapshot) {
    return snapshot.ready_workers == 1;
  }, "stubborn worker should become ready");

  require(supervisor.request_cancel(EntityId{"stubborn"}).ok(),
          "stubborn worker cancellation should begin");
  pump_until(supervisor, [](const auto& snapshot) {
    return snapshot.active_workers == 0 && snapshot.cancelled_process_total == 1;
  }, "stubborn worker should be terminated after bounded grace");

  const auto snapshot = supervisor.snapshot();
  require(snapshot.terminate_escalation_total >= 1,
          "stubborn worker must exercise process-tree escalation");
  require(snapshot.jobs.resources.active_workloads == 0,
          "escalated worker must release resources only after confirmed exit");
}

void test_capability_mismatch_fails_closed(const std::filesystem::path& fixture) {
  ResourceManager resources;
  configure_resources(resources);
  BackgroundJobRuntime jobs{resources, 4};
  WorkerSupervisor supervisor{jobs};

  auto launch = spec(fixture, "limited-capabilities");
  launch.required_capabilities = {"voice"};
  require(supervisor.submit(job("capability"), std::move(launch)).ok(),
          "capability mismatch worker should submit");
  require(supervisor.pump(1).ok(), "capability mismatch worker should launch");

  pump_until(supervisor, [](const auto& snapshot) {
    return snapshot.active_workers == 0 && snapshot.failed_process_total == 1;
  }, "missing required capability should fail and drain worker");
  const auto snapshot = supervisor.snapshot();
  require(snapshot.handshake_failed_total == 1 &&
              snapshot.jobs.resources.active_workloads == 0,
          "handshake capability failure must not leak a resource lease");
}

void test_log_tail_is_bounded(const std::filesystem::path& fixture) {
  ResourceManager resources;
  configure_resources(resources);
  BackgroundJobRuntime jobs{resources, 4};
  WorkerSupervisor supervisor{jobs};

  constexpr std::size_t kTailBytes = 2048;
  require(supervisor.submit(job("noisy"), spec(fixture, "noisy", kTailBytes)).ok(),
          "noisy worker should submit");
  require(supervisor.pump(1).ok(), "noisy worker should launch");
  pump_until(supervisor, [](const auto& snapshot) {
    return snapshot.ready_workers == 1 && !snapshot.workers.empty() &&
           snapshot.workers.front().stdout_dropped_bytes > 0;
  }, "noisy worker should overflow only the bounded log tail");

  const auto snapshot = supervisor.snapshot();
  require(!snapshot.workers.empty() &&
              snapshot.workers.front().stdout_tail.size() <= kTailBytes,
          "worker stdout tail must stay within its configured memory bound");
  require(supervisor.request_cancel(EntityId{"noisy"}).ok(), "noisy worker should cancel");
  pump_until(supervisor, [](const auto& current) {
    return current.active_workers == 0;
  }, "noisy worker should drain after cancellation");
}

void test_shutdown_drains_workers_sequentially(const std::filesystem::path& fixture) {
  ResourceManager resources;
  configure_resources(resources);
  BackgroundJobRuntime jobs{resources, 6};
  WorkerSupervisor supervisor{jobs};

  require(supervisor.submit(job("shutdown.1", 512), spec(fixture, "cooperative")).ok(),
          "first shutdown worker should submit");
  require(supervisor.submit(job("shutdown.2", 512), spec(fixture, "cooperative")).ok(),
          "second shutdown worker should submit");
  require(supervisor.pump(2).ok(), "both shutdown workers should launch");
  pump_until(supervisor, [](const auto& snapshot) {
    return snapshot.ready_workers == 2;
  }, "both shutdown workers should become ready");

  require(supervisor.shutdown().ok(), "supervisor shutdown should fully drain owned workers");
  const auto snapshot = supervisor.snapshot();
  require(snapshot.active_workers == 0 && snapshot.pending_jobs == 0,
          "shutdown should leave no worker ownership behind");
  require(snapshot.jobs.shutting_down && snapshot.jobs.queued_jobs == 0 &&
              snapshot.jobs.running_jobs == 0 &&
              snapshot.jobs.cancellation_requested_jobs == 0,
          "background runtime should complete shutdown with no lifecycle records");
  require(snapshot.jobs.resources.active_workloads == 0 &&
              snapshot.jobs.resources.vram_used_mb == 0,
          "sequential shutdown must leave zero active resource leases");
  require(snapshot.cancelled_process_total == 2,
          "shutdown should classify both live workers as cancelled");
}

}  // namespace

int main(int argc, char** argv) {
  require(argc == 2, "worker supervisor test requires fixture executable path");
  const std::filesystem::path fixture{argv[1]};
  require(std::filesystem::exists(fixture), "worker fixture executable must exist");

  test_fast_ready_exit_is_completed(fixture);
  test_cancel_holds_lease_until_real_exit(fixture);
  test_uncooperative_worker_escalates(fixture);
  test_capability_mismatch_fails_closed(fixture);
  test_log_tail_is_bounded(fixture);
  test_shutdown_drains_workers_sequentially(fixture);
  std::cout << "worker_supervisor_test: all checks passed\n";
  return EXIT_SUCCESS;
}
