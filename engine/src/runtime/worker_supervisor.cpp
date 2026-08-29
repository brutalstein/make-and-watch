#include "makewatch/runtime/worker_supervisor.hpp"

#include "worker_supervisor_impl.hpp"

namespace makewatch::runtime {

WorkerSupervisor::WorkerSupervisor(BackgroundJobRuntime& jobs)
    : impl_(std::make_unique<Impl>(jobs)) {}

WorkerSupervisor::~WorkerSupervisor() noexcept {
  if (!impl_) return;
  if (const auto status = impl_->shutdown(); !status.ok()) {
    impl_->emergency_drain_noexcept();
  }
}

core::Status WorkerSupervisor::submit(
    BackgroundJobRequest request,
    WorkerLaunchSpec launch_spec) {
  if (!impl_) {
    return core::Status::failure(
        core::ErrorCode::kIoError, "worker supervisor is not initialized");
  }
  return impl_->submit(std::move(request), std::move(launch_spec));
}

WorkerPumpResult WorkerSupervisor::pump(std::size_t max_launches) {
  if (!impl_) {
    return WorkerPumpResult{
        .status = core::Status::failure(
            core::ErrorCode::kIoError, "worker supervisor is not initialized")};
  }
  return impl_->pump(max_launches);
}

core::Status WorkerSupervisor::request_cancel(const core::EntityId& job_id) {
  if (!impl_) {
    return core::Status::failure(
        core::ErrorCode::kIoError, "worker supervisor is not initialized");
  }
  return impl_->request_cancel(job_id);
}

core::Status WorkerSupervisor::shutdown() {
  return impl_ ? impl_->shutdown() : core::Status::success();
}

WorkerSupervisorSnapshot WorkerSupervisor::snapshot() const {
  return impl_ ? impl_->snapshot() : WorkerSupervisorSnapshot{};
}

}  // namespace makewatch::runtime
