#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <map>
#include <mutex>
#include <optional>
#include <string>

#include "makewatch/core/id.hpp"
#include "makewatch/core/status.hpp"
#include "makewatch/runtime/resource_manager.hpp"

namespace makewatch::runtime {

enum class BackgroundJobState {
  kQueued,
  kRunning,
  kCancellationRequested,
};

enum class BackgroundJobCompletion {
  kCompleted,
  kCancelled,
  kFailed,
};

struct BackgroundJobRequest final {
  core::EntityId job_id;
  std::string kind;
  WorkloadRequest resources;
};

struct BackgroundJobSnapshot final {
  std::size_t capacity{0};
  bool accepting_jobs{true};
  bool shutting_down{false};
  std::size_t queued_jobs{0};
  std::size_t running_jobs{0};
  std::size_t cancellation_requested_jobs{0};
  std::uint64_t submitted_total{0};
  std::uint64_t started_total{0};
  std::uint64_t completed_total{0};
  std::uint64_t cancelled_total{0};
  std::uint64_t failed_total{0};
  ResourceSnapshot resources;
};

struct StartBackgroundJobResult final {
  core::Status status;
  std::optional<core::EntityId> job_id;

  [[nodiscard]] bool ok() const noexcept { return status.ok(); }
  [[nodiscard]] bool started() const noexcept { return job_id.has_value(); }
};

struct ShutdownTargetResult final {
  core::Status status;
  std::optional<core::EntityId> job_id;

  [[nodiscard]] bool ok() const noexcept { return status.ok(); }
};

/**
 * Bounded lifecycle owner for native background work.
 *
 * This layer intentionally does not launch OS processes yet. A future worker
 * supervisor will use the returned job id to launch/stop a concrete worker.
 * Resource leases stay owned here until the supervisor confirms that running
 * work actually stopped. Cancellation therefore never releases VRAM/RAM/CPU
 * accounting early while a process may still be using those resources.
 */
class BackgroundJobRuntime final {
 public:
  BackgroundJobRuntime(ResourceManager& resources, std::size_t capacity);

  BackgroundJobRuntime(const BackgroundJobRuntime&) = delete;
  BackgroundJobRuntime& operator=(const BackgroundJobRuntime&) = delete;
  BackgroundJobRuntime(BackgroundJobRuntime&&) = delete;
  BackgroundJobRuntime& operator=(BackgroundJobRuntime&&) = delete;

  [[nodiscard]] core::Status submit(BackgroundJobRequest request);
  [[nodiscard]] StartBackgroundJobResult start_one_ready();
  [[nodiscard]] core::Status request_cancel(const core::EntityId& job_id);
  [[nodiscard]] core::Status finish(
      const core::EntityId& job_id,
      BackgroundJobCompletion completion);

  // Shutdown is deliberately sequential. begin_shutdown() stops admission and
  // cancels queued work. next_shutdown_target() exposes exactly one running job
  // at a time; confirm_shutdown_target_stopped() releases that job's lease only
  // after the external supervisor confirms the process/thread is actually down.
  [[nodiscard]] core::Status begin_shutdown();
  [[nodiscard]] ShutdownTargetResult next_shutdown_target();
  [[nodiscard]] core::Status confirm_shutdown_target_stopped(
      const core::EntityId& job_id,
      BackgroundJobCompletion completion = BackgroundJobCompletion::kCancelled);

  [[nodiscard]] bool shutdown_complete() const;
  [[nodiscard]] BackgroundJobSnapshot snapshot() const;

 private:
  struct QueuedJob final {
    BackgroundJobRequest request;
    std::uint64_t sequence{0};
  };

  struct RunningJob final {
    BackgroundJobRequest request;
    std::uint64_t sequence{0};
    BackgroundJobState state{BackgroundJobState::kRunning};
    ResourceLease lease;
  };

  [[nodiscard]] core::Status validate_request(const BackgroundJobRequest& request) const;
  [[nodiscard]] bool id_in_use_locked(const core::EntityId& job_id) const;
  void count_completion_locked(BackgroundJobCompletion completion);

  ResourceManager& resources_;
  const std::size_t capacity_;
  mutable std::mutex mutex_;
  std::deque<QueuedJob> queued_;
  std::map<std::string, RunningJob> running_;
  std::optional<std::string> shutdown_target_;
  bool accepting_jobs_{true};
  bool shutting_down_{false};
  std::uint64_t next_sequence_{1};
  std::uint64_t submitted_total_{0};
  std::uint64_t started_total_{0};
  std::uint64_t completed_total_{0};
  std::uint64_t cancelled_total_{0};
  std::uint64_t failed_total_{0};
};

}  // namespace makewatch::runtime
