#pragma once

#include <chrono>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "makewatch/runtime/worker_supervisor.hpp"
#include "worker_process.hpp"

namespace makewatch::runtime {

class WorkerSupervisor::Impl final {
 public:
  explicit Impl(BackgroundJobRuntime& background_jobs) : jobs(background_jobs) {}

  [[nodiscard]] core::Status submit(
      BackgroundJobRequest request,
      WorkerLaunchSpec launch_spec);
  [[nodiscard]] WorkerPumpResult pump(std::size_t max_launches);
  [[nodiscard]] core::Status request_cancel(const core::EntityId& job_id);
  [[nodiscard]] core::Status shutdown();
  [[nodiscard]] WorkerSupervisorSnapshot snapshot() const;
  void emergency_drain_noexcept() noexcept;

 private:
  struct PendingWorker final {
    WorkerLaunchSpec spec;
  };

  struct ActiveWorker final {
    core::EntityId job_id;
    WorkerLaunchSpec spec;
    std::shared_ptr<detail::OutputCapture> capture;
    std::unique_ptr<detail::NativeProcess> process;
    WorkerState state{WorkerState::kStarting};
    std::chrono::steady_clock::time_point deadline;
    std::optional<BackgroundJobCompletion> requested_completion;
    bool shutdown_target{false};
    std::string worker_name;
    std::vector<std::string> capabilities;
    std::optional<std::int64_t> exit_code;
  };

  [[nodiscard]] core::Status remember_error(
      core::Status current,
      core::Status candidate) const;
  [[nodiscard]] core::Status begin_stop_locked(
      ActiveWorker& worker,
      BackgroundJobCompletion completion,
      bool shutdown_target,
      std::chrono::steady_clock::time_point now);
  [[nodiscard]] core::Status finalize_exited_locked(
      std::map<std::string, ActiveWorker>::iterator iterator,
      const detail::ProcessObservation& observation,
      WorkerPumpResult& result);
  [[nodiscard]] core::Status advance_locked(
      std::chrono::steady_clock::time_point now,
      WorkerPumpResult& result);
  [[nodiscard]] core::Status launch_started_job_locked(
      const core::EntityId& job_id,
      std::chrono::steady_clock::time_point now);
  [[nodiscard]] WorkerPumpResult pump_locked(std::size_t max_launches);

  BackgroundJobRuntime& jobs;
  mutable std::mutex mutex;
  std::map<std::string, PendingWorker> pending;
  std::map<std::string, ActiveWorker> active;
  std::uint64_t launched_total{0};
  std::uint64_t spawn_failed_total{0};
  std::uint64_t handshake_failed_total{0};
  std::uint64_t completed_process_total{0};
  std::uint64_t cancelled_process_total{0};
  std::uint64_t failed_process_total{0};
  std::uint64_t graceful_stop_total{0};
  std::uint64_t terminate_escalation_total{0};
  std::uint64_t hard_kill_total{0};
};

}  // namespace makewatch::runtime
