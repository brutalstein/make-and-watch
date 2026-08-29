#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "makewatch/core/id.hpp"
#include "makewatch/core/status.hpp"
#include "makewatch/runtime/background_job_runtime.hpp"

namespace makewatch::runtime {

enum class WorkerState {
  kStarting,
  kReady,
  kStoppingGracefully,
  kTerminating,
  kKilling,
};

struct WorkerLaunchSpec final {
  std::filesystem::path executable;
  std::vector<std::string> arguments;
  std::optional<std::filesystem::path> working_directory;
  std::vector<std::string> required_capabilities;
  std::chrono::milliseconds ready_timeout{5000};
  std::chrono::milliseconds graceful_stop_timeout{2000};
  std::chrono::milliseconds terminate_timeout{1000};
  std::chrono::milliseconds hard_kill_timeout{2000};
  std::size_t stdout_tail_bytes{64 * 1024};
  std::size_t stderr_tail_bytes{64 * 1024};
};

struct WorkerSnapshot final {
  core::EntityId job_id;
  WorkerState state{WorkerState::kStarting};
  std::uint64_t process_id{0};
  std::string worker_name;
  std::vector<std::string> capabilities;
  std::optional<std::int64_t> exit_code;
  std::string stdout_tail;
  std::string stderr_tail;
  std::uint64_t stdout_dropped_bytes{0};
  std::uint64_t stderr_dropped_bytes{0};
};

struct WorkerSupervisorSnapshot final {
  std::size_t pending_jobs{0};
  std::size_t active_workers{0};
  std::size_t starting_workers{0};
  std::size_t ready_workers{0};
  std::size_t stopping_workers{0};
  std::uint64_t launched_total{0};
  std::uint64_t spawn_failed_total{0};
  std::uint64_t handshake_failed_total{0};
  std::uint64_t completed_process_total{0};
  std::uint64_t cancelled_process_total{0};
  std::uint64_t failed_process_total{0};
  std::uint64_t graceful_stop_total{0};
  std::uint64_t terminate_escalation_total{0};
  std::uint64_t hard_kill_total{0};
  std::vector<WorkerSnapshot> workers;
  BackgroundJobSnapshot jobs;
};

struct WorkerPumpResult final {
  core::Status status;
  std::size_t launched{0};
  std::size_t finalized{0};
  std::size_t escalated{0};

  [[nodiscard]] bool ok() const noexcept { return status.ok(); }
};

/**
 * Concrete cross-platform process owner above BackgroundJobRuntime.
 *
 * One logical background job maps to exactly one owned worker process tree.
 * Resource leases remain inside BackgroundJobRuntime until this supervisor has
 * confirmed that the complete worker tree is gone.
 *
 * Worker startup is non-blocking. pump() advances readiness, cancellation,
 * crash detection and bounded stop escalation. Shutdown itself is synchronous
 * and drains workers sequentially according to BackgroundJobRuntime's contract.
 *
 * Ready handshake (single bounded stdout line):
 *   MW_READY_V1\t<worker-name>\t<capability-a>,<capability-b>\n
 * Graceful stop command on stdin:
 *   MW_STOP_V1\n
 */
class WorkerSupervisor final {
 public:
  explicit WorkerSupervisor(BackgroundJobRuntime& jobs);
  ~WorkerSupervisor() noexcept;

  WorkerSupervisor(const WorkerSupervisor&) = delete;
  WorkerSupervisor& operator=(const WorkerSupervisor&) = delete;
  WorkerSupervisor(WorkerSupervisor&&) = delete;
  WorkerSupervisor& operator=(WorkerSupervisor&&) = delete;

  [[nodiscard]] core::Status submit(
      BackgroundJobRequest request,
      WorkerLaunchSpec launch_spec);

  // Advances all active workers and launches at most max_launches newly admitted
  // jobs. max_launches=0 performs lifecycle maintenance without starting work.
  [[nodiscard]] WorkerPumpResult pump(std::size_t max_launches = 1);

  // Queued jobs cancel immediately. Running workers begin graceful stop and keep
  // their resource lease until a later pump() confirms complete process-tree exit.
  [[nodiscard]] core::Status request_cancel(const core::EntityId& job_id);

  // Stops admission, cancels queued work, then drains running workers exactly one
  // at a time: graceful stop -> bounded wait -> terminate -> hard kill -> exit
  // confirmation -> resource lease release.
  [[nodiscard]] core::Status shutdown();

  [[nodiscard]] WorkerSupervisorSnapshot snapshot() const;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace makewatch::runtime
