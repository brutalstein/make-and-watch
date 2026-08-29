#include "worker_supervisor_impl.hpp"

#include <algorithm>
#include <set>
#include <string_view>
#include <thread>
#include <utility>

namespace makewatch::runtime {
namespace {

constexpr std::size_t kMaxTailBytes = 1024 * 1024;
constexpr auto kShutdownPollInterval = std::chrono::milliseconds{10};

bool valid_capability(std::string_view capability) {
  if (capability.empty() || capability.size() > 96) return false;
  return std::all_of(capability.begin(), capability.end(), [](unsigned char character) {
    return (character >= 'a' && character <= 'z') ||
           (character >= 'A' && character <= 'Z') ||
           (character >= '0' && character <= '9') ||
           character == '.' || character == '_' || character == '-' ||
           character == ':' || character == '/';
  });
}

core::Status validate_launch_spec(const WorkerLaunchSpec& spec) {
  if (spec.executable.empty()) {
    return core::Status::failure(
        core::ErrorCode::kInvalidArgument, "worker executable must not be empty");
  }
  if (spec.ready_timeout.count() <= 0 ||
      spec.graceful_stop_timeout.count() <= 0 ||
      spec.terminate_timeout.count() <= 0 ||
      spec.hard_kill_timeout.count() <= 0) {
    return core::Status::failure(
        core::ErrorCode::kInvalidArgument, "worker lifecycle timeouts must be positive");
  }
  if (spec.stdout_tail_bytes > kMaxTailBytes || spec.stderr_tail_bytes > kMaxTailBytes) {
    return core::Status::failure(
        core::ErrorCode::kInvalidArgument,
        "worker log tail bounds must not exceed 1 MiB per stream");
  }
  if (spec.required_capabilities.size() > 32) {
    return core::Status::failure(
        core::ErrorCode::kInvalidArgument,
        "worker required capabilities must not exceed 32 entries");
  }

  std::set<std::string> unique_capabilities;
  for (const auto& capability : spec.required_capabilities) {
    if (!valid_capability(capability)) {
      return core::Status::failure(
          core::ErrorCode::kInvalidArgument,
          "worker required capability contains an invalid token");
    }
    if (!unique_capabilities.insert(capability).second) {
      return core::Status::failure(
          core::ErrorCode::kInvalidArgument,
          "worker required capabilities must not contain duplicates");
    }
  }
  return core::Status::success();
}

}  // namespace

core::Status WorkerSupervisor::Impl::submit(
    BackgroundJobRequest request,
    WorkerLaunchSpec launch_spec) {
  if (const auto status = validate_launch_spec(launch_spec); !status.ok()) return status;
  const auto job_id = request.job_id;

  std::scoped_lock lock(mutex);
  if (pending.contains(job_id.value()) || active.contains(job_id.value())) {
    return core::Status::failure(
        core::ErrorCode::kAlreadyExists,
        "worker job id is already owned by the supervisor");
  }

  pending.emplace(job_id.value(), PendingWorker{std::move(launch_spec)});
  try {
    const auto status = jobs.submit(std::move(request));
    if (!status.ok()) pending.erase(job_id.value());
    return status;
  } catch (...) {
    pending.erase(job_id.value());
    throw;
  }
}

WorkerPumpResult WorkerSupervisor::Impl::pump(std::size_t max_launches) {
  std::scoped_lock lock(mutex);
  return pump_locked(max_launches);
}

core::Status WorkerSupervisor::Impl::request_cancel(const core::EntityId& job_id) {
  std::scoped_lock lock(mutex);

  if (auto active_iterator = active.find(job_id.value()); active_iterator != active.end()) {
    const auto runtime_status = jobs.request_cancel(job_id);
    if (!runtime_status.ok()) return runtime_status;
    return begin_stop_locked(
        active_iterator->second,
        BackgroundJobCompletion::kCancelled,
        false,
        std::chrono::steady_clock::now());
  }

  const auto pending_iterator = pending.find(job_id.value());
  if (pending_iterator == pending.end()) {
    return core::Status::failure(
        core::ErrorCode::kNotFound, "worker job is not queued or active");
  }
  const auto status = jobs.request_cancel(job_id);
  if (status.ok()) pending.erase(pending_iterator);
  return status;
}

core::Status WorkerSupervisor::Impl::shutdown() {
  std::unique_lock lock(mutex);

  if (jobs.shutdown_complete()) return core::Status::success();
  if (const auto status = jobs.begin_shutdown(); !status.ok()) return status;
  pending.clear();

  for (;;) {
    WorkerPumpResult maintenance{.status = core::Status::success()};
    const auto now = std::chrono::steady_clock::now();
    const auto advance_status = advance_locked(now, maintenance);
    if (!advance_status.ok()) return advance_status;

    if (jobs.shutdown_complete()) return core::Status::success();
    const auto target = jobs.next_shutdown_target();
    if (!target.ok()) return target.status;
    if (!target.job_id.has_value()) {
      return core::Status::failure(
          core::ErrorCode::kCorruptData,
          "background shutdown is incomplete but has no running target");
    }

    auto worker_iterator = active.find(target.job_id->value());
    if (worker_iterator == active.end()) {
      return core::Status::failure(
          core::ErrorCode::kCorruptData,
          "background shutdown target has no owned worker process");
    }
    auto& worker = worker_iterator->second;
    if (!worker.shutdown_target) {
      const auto stop_status = begin_stop_locked(
          worker, BackgroundJobCompletion::kCancelled, true, now);
      if (!stop_status.ok()) return stop_status;
    }

    const auto target_id = target.job_id->value();
    while (active.contains(target_id)) {
      WorkerPumpResult drain{.status = core::Status::success()};
      const auto drain_status = advance_locked(std::chrono::steady_clock::now(), drain);
      if (!drain_status.ok()) return drain_status;
      if (!active.contains(target_id)) break;
      lock.unlock();
      std::this_thread::sleep_for(kShutdownPollInterval);
      lock.lock();
    }
  }
}

WorkerSupervisorSnapshot WorkerSupervisor::Impl::snapshot() const {
  std::scoped_lock lock(mutex);
  WorkerSupervisorSnapshot result{
      .pending_jobs = pending.size(),
      .active_workers = active.size(),
      .launched_total = launched_total,
      .spawn_failed_total = spawn_failed_total,
      .handshake_failed_total = handshake_failed_total,
      .completed_process_total = completed_process_total,
      .cancelled_process_total = cancelled_process_total,
      .failed_process_total = failed_process_total,
      .graceful_stop_total = graceful_stop_total,
      .terminate_escalation_total = terminate_escalation_total,
      .hard_kill_total = hard_kill_total,
      .workers = {},
      .jobs = jobs.snapshot(),
  };
  result.workers.reserve(active.size());

  for (const auto& [id, worker] : active) {
    static_cast<void>(id);
    switch (worker.state) {
      case WorkerState::kStarting:
        ++result.starting_workers;
        break;
      case WorkerState::kReady:
        ++result.ready_workers;
        break;
      case WorkerState::kStoppingGracefully:
      case WorkerState::kTerminating:
      case WorkerState::kKilling:
        ++result.stopping_workers;
        break;
    }
    result.workers.push_back(WorkerSnapshot{
        .job_id = worker.job_id,
        .state = worker.state,
        .process_id = worker.process->process_id(),
        .worker_name = worker.worker_name,
        .capabilities = worker.capabilities,
        .exit_code = worker.exit_code,
        .stdout_tail = worker.capture->stdout_tail(),
        .stderr_tail = worker.capture->stderr_tail(),
        .stdout_dropped_bytes = worker.capture->stdout_dropped_bytes(),
        .stderr_dropped_bytes = worker.capture->stderr_dropped_bytes(),
    });
  }
  return result;
}

}  // namespace makewatch::runtime
