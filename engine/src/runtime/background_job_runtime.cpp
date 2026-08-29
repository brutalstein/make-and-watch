#include "makewatch/runtime/background_job_runtime.hpp"

#include <algorithm>
#include <iterator>
#include <utility>

namespace makewatch::runtime {

BackgroundJobRuntime::BackgroundJobRuntime(ResourceManager& resources, std::size_t capacity)
    : resources_(resources), capacity_(capacity) {}

core::Status BackgroundJobRuntime::validate_request(const BackgroundJobRequest& request) const {
  if (capacity_ == 0) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                 "background job capacity must be non-zero");
  }
  if (request.job_id.empty()) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                 "background job id must not be empty");
  }
  if (request.kind.empty()) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                 "background job kind must not be empty");
  }
  if (request.resources.workload_id != request.job_id) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                 "background job id must match resource workload id");
  }
  if (request.resources.cpu_threads == 0) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                 "background job CPU thread request must be non-zero");
  }
  return core::Status::success();
}

bool BackgroundJobRuntime::id_in_use_locked(const core::EntityId& job_id) const {
  if (running_.contains(job_id.value())) return true;
  return std::any_of(queued_.begin(), queued_.end(), [&](const QueuedJob& job) {
    return job.request.job_id == job_id;
  });
}

core::Status BackgroundJobRuntime::submit(BackgroundJobRequest request) {
  if (const auto status = validate_request(request); !status.ok()) return status;

  std::scoped_lock lock(mutex_);
  if (!accepting_jobs_) {
    return core::Status::failure(core::ErrorCode::kBusy,
                                 "background runtime is not accepting new jobs");
  }
  if (queued_.size() + running_.size() >= capacity_) {
    return core::Status::failure(core::ErrorCode::kResourceExhausted,
                                 "background job capacity is exhausted");
  }
  if (id_in_use_locked(request.job_id)) {
    return core::Status::failure(core::ErrorCode::kAlreadyExists,
                                 "background job id is already queued or running");
  }

  queued_.push_back(QueuedJob{std::move(request), next_sequence_++});
  ++submitted_total_;
  return core::Status::success();
}

StartBackgroundJobResult BackgroundJobRuntime::start_one_ready() {
  std::scoped_lock lock(mutex_);
  if (shutting_down_ || !accepting_jobs_) {
    return StartBackgroundJobResult{
        core::Status::failure(core::ErrorCode::kBusy,
                              "background runtime is shutting down"),
        std::nullopt};
  }

  for (auto iterator = queued_.begin(); iterator != queued_.end(); ++iterator) {
    const auto preview = resources_.preview_admission(iterator->request.resources);
    if (!preview.allowed()) {
      if (preview.status.code == core::ErrorCode::kInvalidArgument) {
        return StartBackgroundJobResult{preview.status, std::nullopt};
      }
      continue;
    }

    // Stage all queue-owned data before resource admission. If any copy allocates
    // and throws, the queue remains untouched and no native resource is reserved.
    BackgroundJobRequest staged_request = iterator->request;
    const auto staged_sequence = iterator->sequence;
    core::EntityId job_id = staged_request.job_id;

    auto acquired = resources_.try_acquire_scoped(staged_request.resources);
    if (!acquired.ok()) {
      if (acquired.status.code == core::ErrorCode::kBusy ||
          acquired.status.code == core::ErrorCode::kResourceExhausted) {
        continue;
      }
      return StartBackgroundJobResult{acquired.status, std::nullopt};
    }

    // Commit to running_ before erasing the queued source. If map allocation or
    // value construction throws, the temporary/moved lease releases itself and
    // the original queued request is still present for a later retry.
    const auto [running_iterator, inserted] = running_.emplace(
        job_id.value(),
        RunningJob{
            .request = std::move(staged_request),
            .sequence = staged_sequence,
            .state = BackgroundJobState::kRunning,
            .lease = std::move(acquired.lease),
        });
    static_cast<void>(running_iterator);
    if (!inserted) {
      return StartBackgroundJobResult{
          core::Status::failure(core::ErrorCode::kAlreadyExists,
                                "background job became active during admission"),
          std::nullopt};
    }

    queued_.erase(iterator);
    ++started_total_;
    return StartBackgroundJobResult{core::Status::success(), job_id};
  }

  return StartBackgroundJobResult{core::Status::success(), std::nullopt};
}

core::Status BackgroundJobRuntime::request_cancel(const core::EntityId& job_id) {
  std::scoped_lock lock(mutex_);
  const auto queued_iterator = std::find_if(
      queued_.begin(), queued_.end(), [&](const QueuedJob& job) {
        return job.request.job_id == job_id;
      });
  if (queued_iterator != queued_.end()) {
    queued_.erase(queued_iterator);
    ++cancelled_total_;
    return core::Status::success();
  }

  const auto running_iterator = running_.find(job_id.value());
  if (running_iterator == running_.end()) {
    return core::Status::failure(core::ErrorCode::kNotFound,
                                 "background job is not queued or running");
  }
  running_iterator->second.state = BackgroundJobState::kCancellationRequested;
  return core::Status::success();
}

void BackgroundJobRuntime::count_completion_locked(BackgroundJobCompletion completion) {
  switch (completion) {
    case BackgroundJobCompletion::kCompleted:
      ++completed_total_;
      return;
    case BackgroundJobCompletion::kCancelled:
      ++cancelled_total_;
      return;
    case BackgroundJobCompletion::kFailed:
      ++failed_total_;
      return;
  }
}

core::Status BackgroundJobRuntime::finish(
    const core::EntityId& job_id,
    BackgroundJobCompletion completion) {
  ResourceLease lease;
  {
    std::scoped_lock lock(mutex_);
    const auto iterator = running_.find(job_id.value());
    if (iterator == running_.end()) {
      return core::Status::failure(core::ErrorCode::kNotFound,
                                   "background job is not running");
    }

    lease = std::move(iterator->second.lease);
    running_.erase(iterator);
    if (shutdown_target_.has_value() && *shutdown_target_ == job_id.value()) {
      shutdown_target_.reset();
    }
    count_completion_locked(completion);
  }

  return lease.release();
}

core::Status BackgroundJobRuntime::begin_shutdown() {
  std::scoped_lock lock(mutex_);
  if (shutting_down_) return core::Status::success();

  accepting_jobs_ = false;
  shutting_down_ = true;
  cancelled_total_ += static_cast<std::uint64_t>(queued_.size());
  queued_.clear();
  return core::Status::success();
}

ShutdownTargetResult BackgroundJobRuntime::next_shutdown_target() {
  std::scoped_lock lock(mutex_);
  if (!shutting_down_) {
    return ShutdownTargetResult{
        core::Status::failure(core::ErrorCode::kInvalidArgument,
                              "background shutdown has not started"),
        std::nullopt};
  }

  if (shutdown_target_.has_value()) {
    return ShutdownTargetResult{
        core::Status::success(),
        core::EntityId{*shutdown_target_}};
  }
  if (running_.empty()) {
    return ShutdownTargetResult{core::Status::success(), std::nullopt};
  }

  auto target = running_.begin();
  for (auto iterator = std::next(running_.begin()); iterator != running_.end(); ++iterator) {
    if (iterator->second.sequence < target->second.sequence) target = iterator;
  }
  target->second.state = BackgroundJobState::kCancellationRequested;
  shutdown_target_ = target->first;
  return ShutdownTargetResult{core::Status::success(), target->second.request.job_id};
}

core::Status BackgroundJobRuntime::confirm_shutdown_target_stopped(
    const core::EntityId& job_id,
    BackgroundJobCompletion completion) {
  {
    std::scoped_lock lock(mutex_);
    if (!shutting_down_) {
      return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                   "background shutdown has not started");
    }
    if (!shutdown_target_.has_value() || *shutdown_target_ != job_id.value()) {
      return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                   "job is not the current sequential shutdown target");
    }
  }
  return finish(job_id, completion);
}

bool BackgroundJobRuntime::shutdown_complete() const {
  std::scoped_lock lock(mutex_);
  return shutting_down_ && queued_.empty() && running_.empty() &&
         !shutdown_target_.has_value();
}

BackgroundJobSnapshot BackgroundJobRuntime::snapshot() const {
  std::scoped_lock lock(mutex_);
  std::size_t cancellation_requested = 0;
  for (const auto& [id, job] : running_) {
    static_cast<void>(id);
    if (job.state == BackgroundJobState::kCancellationRequested) {
      ++cancellation_requested;
    }
  }

  return BackgroundJobSnapshot{
      .capacity = capacity_,
      .accepting_jobs = accepting_jobs_,
      .shutting_down = shutting_down_,
      .queued_jobs = queued_.size(),
      .running_jobs = running_.size(),
      .cancellation_requested_jobs = cancellation_requested,
      .submitted_total = submitted_total_,
      .started_total = started_total_,
      .completed_total = completed_total_,
      .cancelled_total = cancelled_total_,
      .failed_total = failed_total_,
      .resources = resources_.snapshot(),
  };
}

}  // namespace makewatch::runtime
