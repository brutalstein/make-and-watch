#include "worker_supervisor_impl.hpp"

#include <algorithm>
#include <utility>

namespace makewatch::runtime {

core::Status WorkerSupervisor::Impl::remember_error(
    core::Status current,
    core::Status candidate) const {
  return current.ok() && !candidate.ok() ? std::move(candidate) : current;
}

core::Status WorkerSupervisor::Impl::begin_stop_locked(
    ActiveWorker& worker,
    BackgroundJobCompletion completion,
    bool shutdown_target,
    std::chrono::steady_clock::time_point now) {
  worker.requested_completion = completion;
  worker.shutdown_target = worker.shutdown_target || shutdown_target;
  if (worker.state == WorkerState::kStoppingGracefully ||
      worker.state == WorkerState::kTerminating ||
      worker.state == WorkerState::kKilling) {
    return core::Status::success();
  }

  const auto status = worker.process->request_graceful_stop();
  worker.state = WorkerState::kStoppingGracefully;
  worker.deadline = now + worker.spec.graceful_stop_timeout;
  ++graceful_stop_total;
  return status;
}

core::Status WorkerSupervisor::Impl::finalize_exited_locked(
    std::map<std::string, ActiveWorker>::iterator iterator,
    const detail::ProcessObservation& observation,
    WorkerPumpResult& result) {
  auto& worker = iterator->second;
  worker.exit_code = observation.exit_code;

  BackgroundJobCompletion completion = BackgroundJobCompletion::kFailed;
  if (worker.requested_completion.has_value()) {
    completion = *worker.requested_completion;
  } else if (worker.state == WorkerState::kReady &&
             observation.exit_code.has_value() && *observation.exit_code == 0) {
    completion = BackgroundJobCompletion::kCompleted;
  }

  core::Status status;
  if (worker.shutdown_target) {
    status = jobs.confirm_shutdown_target_stopped(worker.job_id, completion);
  } else {
    status = jobs.finish(worker.job_id, completion);
  }
  if (!status.ok()) return status;

  switch (completion) {
    case BackgroundJobCompletion::kCompleted:
      ++completed_process_total;
      break;
    case BackgroundJobCompletion::kCancelled:
      ++cancelled_process_total;
      break;
    case BackgroundJobCompletion::kFailed:
      ++failed_process_total;
      break;
  }
  active.erase(iterator);
  ++result.finalized;
  return core::Status::success();
}

core::Status WorkerSupervisor::Impl::advance_locked(
    std::chrono::steady_clock::time_point now,
    WorkerPumpResult& result) {
  core::Status aggregate = core::Status::success();

  for (auto iterator = active.begin(); iterator != active.end();) {
    auto& worker = iterator->second;
    const auto observation = worker.process->observe();

    if (observation.tree_exited) {
      auto current = iterator++;
      aggregate = remember_error(
          std::move(aggregate), finalize_exited_locked(current, observation, result));
      continue;
    }

    // A leader exiting while descendants remain is not completion. The tree is
    // drained before its resource lease can be released.
    if (observation.leader_exited && !worker.requested_completion.has_value()) {
      aggregate = remember_error(
          std::move(aggregate),
          begin_stop_locked(worker, BackgroundJobCompletion::kFailed, false, now));
    }

    if (worker.state == WorkerState::kStarting) {
      if (const auto handshake_error = worker.capture->handshake_error();
          handshake_error.has_value()) {
        ++handshake_failed_total;
        aggregate = remember_error(
            std::move(aggregate),
            begin_stop_locked(worker, BackgroundJobCompletion::kFailed, false, now));
      } else if (const auto handshake = worker.capture->ready_handshake();
                 handshake.has_value()) {
        bool capabilities_match = true;
        for (const auto& required : worker.spec.required_capabilities) {
          if (!std::binary_search(
                  handshake->capabilities.begin(), handshake->capabilities.end(), required)) {
            capabilities_match = false;
            break;
          }
        }
        if (!capabilities_match) {
          ++handshake_failed_total;
          aggregate = remember_error(
              std::move(aggregate),
              begin_stop_locked(worker, BackgroundJobCompletion::kFailed, false, now));
        } else {
          worker.worker_name = handshake->worker_name;
          worker.capabilities = handshake->capabilities;
          worker.state = WorkerState::kReady;
        }
      } else if (now >= worker.deadline) {
        ++handshake_failed_total;
        aggregate = remember_error(
            std::move(aggregate),
            begin_stop_locked(worker, BackgroundJobCompletion::kFailed, false, now));
      }
    }

    if (worker.state == WorkerState::kStoppingGracefully && now >= worker.deadline) {
      const auto status = worker.process->terminate_tree();
      aggregate = remember_error(std::move(aggregate), status);
      worker.state = WorkerState::kTerminating;
      worker.deadline = now + worker.spec.terminate_timeout;
      ++terminate_escalation_total;
      ++result.escalated;
    } else if (worker.state == WorkerState::kTerminating && now >= worker.deadline) {
      const auto status = worker.process->hard_kill_tree();
      aggregate = remember_error(std::move(aggregate), status);
      worker.state = WorkerState::kKilling;
      worker.deadline = now + worker.spec.hard_kill_timeout;
      ++hard_kill_total;
      ++result.escalated;
    } else if (worker.state == WorkerState::kKilling && now >= worker.deadline) {
      aggregate = remember_error(
          std::move(aggregate),
          core::Status::failure(
              core::ErrorCode::kIoError,
              "worker process tree did not exit after hard-kill deadline: " +
                  worker.job_id.value()));
    }

    ++iterator;
  }
  return aggregate;
}

core::Status WorkerSupervisor::Impl::launch_started_job_locked(
    const core::EntityId& job_id,
    std::chrono::steady_clock::time_point now) {
  try {
    auto pending_iterator = pending.find(job_id.value());
    if (pending_iterator == pending.end()) {
      const auto finish_status = jobs.finish(job_id, BackgroundJobCompletion::kFailed);
      if (!finish_status.ok()) return finish_status;
      return core::Status::failure(
          core::ErrorCode::kCorruptData,
          "background runtime started a job without a supervisor launch specification");
    }

    WorkerLaunchSpec spec = std::move(pending_iterator->second.spec);
    pending.erase(pending_iterator);
    auto capture = std::make_shared<detail::OutputCapture>(
        spec.stdout_tail_bytes, spec.stderr_tail_bytes);
    auto spawned = detail::NativeProcess::spawn(spec, capture);
    if (!spawned.ok()) {
      ++spawn_failed_total;
      const auto finish_status = jobs.finish(job_id, BackgroundJobCompletion::kFailed);
      if (!finish_status.ok()) return finish_status;
      return spawned.status;
    }

    const auto ready_timeout = spec.ready_timeout;
    ActiveWorker staged{
        .job_id = job_id,
        .spec = std::move(spec),
        .capture = std::move(capture),
        .process = std::move(spawned.process),
        .state = WorkerState::kStarting,
        .deadline = now + ready_timeout,
        .requested_completion = std::nullopt,
        .shutdown_target = false,
        .worker_name = {},
        .capabilities = {},
        .exit_code = std::nullopt,
    };
    active.emplace(job_id.value(), std::move(staged));
    ++launched_total;
    return core::Status::success();
  } catch (...) {
    // Local process ownership is destroyed during unwinding before this handler.
    // Only then may the lifecycle lease be failed/released.
    pending.erase(job_id.value());
    (void)jobs.finish(job_id, BackgroundJobCompletion::kFailed);
    throw;
  }
}

WorkerPumpResult WorkerSupervisor::Impl::pump_locked(std::size_t max_launches) {
  WorkerPumpResult result{.status = core::Status::success()};
  const auto now = std::chrono::steady_clock::now();
  result.status = advance_locked(now, result);

  for (std::size_t index = 0; index < max_launches; ++index) {
    const auto started = jobs.start_one_ready();
    if (!started.ok()) {
      if (started.status.code == core::ErrorCode::kBusy) break;
      result.status = remember_error(std::move(result.status), started.status);
      break;
    }
    if (!started.started()) break;

    const auto status = launch_started_job_locked(*started.job_id, now);
    result.status = remember_error(std::move(result.status), status);
    if (status.ok()) ++result.launched;
  }
  return result;
}

void WorkerSupervisor::Impl::emergency_drain_noexcept() noexcept {
  std::scoped_lock lock(mutex);
  for (auto& [id, worker] : active) {
    static_cast<void>(id);
    const bool confirmed = worker.process->emergency_kill_and_wait();
    if (!confirmed) continue;  // fail closed: retain native lease accounting

    if (worker.shutdown_target) {
      (void)jobs.confirm_shutdown_target_stopped(
          worker.job_id,
          worker.requested_completion.value_or(BackgroundJobCompletion::kFailed));
    } else {
      (void)jobs.finish(
          worker.job_id,
          worker.requested_completion.value_or(BackgroundJobCompletion::kFailed));
    }
  }
  active.clear();
  pending.clear();
}

}  // namespace makewatch::runtime
