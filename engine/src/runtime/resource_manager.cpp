#include "makewatch/runtime/resource_manager.hpp"

#include <algorithm>
#include <utility>

namespace makewatch::runtime {
namespace {

AdmissionDecision rejected_decision(
    core::Status status,
    std::uint64_t vram_used_mb,
    std::uint64_t ram_used_mb,
    std::uint32_t cpu_threads_used,
    std::uint64_t vram_headroom_mb,
    std::uint64_t ram_headroom_mb,
    std::uint32_t cpu_headroom) {
  return AdmissionDecision{
      .status = std::move(status),
      .projected_vram_mb = vram_used_mb,
      .projected_ram_mb = ram_used_mb,
      .projected_cpu_threads = cpu_threads_used,
      .vram_headroom_after_mb = vram_headroom_mb,
      .ram_headroom_after_mb = ram_headroom_mb,
      .cpu_headroom_after = cpu_headroom,
      .would_activate_exclusive_gpu = false,
  };
}

}  // namespace

ResourceLease::ResourceLease(ResourceManager* manager, core::EntityId workload_id) noexcept
    : manager_(manager), workload_id_(std::move(workload_id)) {}

ResourceLease::~ResourceLease() noexcept {
  if (manager_ != nullptr) {
    (void)release();
  }
}

ResourceLease::ResourceLease(ResourceLease&& other) noexcept
    : manager_(std::exchange(other.manager_, nullptr)),
      workload_id_(std::move(other.workload_id_)) {}

ResourceLease& ResourceLease::operator=(ResourceLease&& other) noexcept {
  if (this == &other) return *this;
  if (manager_ != nullptr) {
    (void)release();
  }
  manager_ = std::exchange(other.manager_, nullptr);
  workload_id_ = std::move(other.workload_id_);
  return *this;
}

core::Status ResourceLease::release() {
  if (manager_ == nullptr) return core::Status::success();
  auto* manager = manager_;
  manager_ = nullptr;
  return manager->release(workload_id_);
}

core::Status ResourceManager::validate_budget(const ResourceBudget& budget) {
  if (budget.vram_total_mb == 0 || budget.ram_total_mb == 0 || budget.cpu_threads == 0) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                 "resource totals and CPU thread count must be non-zero");
  }
  if (budget.vram_reserve_mb >= budget.vram_total_mb) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                 "VRAM reserve must be smaller than total VRAM");
  }
  if (budget.ram_reserve_mb >= budget.ram_total_mb) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                 "RAM reserve must be smaller than total RAM");
  }
  return core::Status::success();
}

core::Status ResourceManager::validate_request(const WorkloadRequest& request) {
  if (request.workload_id.empty()) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                 "workload id must not be empty");
  }
  if (request.cpu_threads == 0) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                 "workload CPU thread count must be non-zero");
  }
  return core::Status::success();
}

bool ResourceManager::uses_gpu(const WorkloadRequest& request) noexcept {
  return request.exclusive_gpu || request.vram_mb > 0;
}

core::Status ResourceManager::configure(ResourceBudget budget) {
  if (const auto status = validate_budget(budget); !status.ok()) {
    return status;
  }

  std::scoped_lock lock(mutex_);
  if (!active_.empty()) {
    return core::Status::failure(core::ErrorCode::kBusy,
                                 "cannot reconfigure resources while workloads are active");
  }
  budget_ = budget;
  configured_ = true;
  vram_used_mb_ = 0;
  ram_used_mb_ = 0;
  cpu_threads_used_ = 0;
  active_gpu_workloads_ = 0;
  exclusive_gpu_active_ = false;
  vram_peak_mb_ = 0;
  ram_peak_mb_ = 0;
  cpu_threads_peak_ = 0;
  admissions_total_ = 0;
  rejections_total_ = 0;
  return core::Status::success();
}

AdmissionDecision ResourceManager::evaluate_locked(const WorkloadRequest& request) const {
  const auto usable_vram = configured_ ? budget_.vram_total_mb - budget_.vram_reserve_mb : 0;
  const auto usable_ram = configured_ ? budget_.ram_total_mb - budget_.ram_reserve_mb : 0;
  const auto vram_headroom = usable_vram >= vram_used_mb_ ? usable_vram - vram_used_mb_ : 0;
  const auto ram_headroom = usable_ram >= ram_used_mb_ ? usable_ram - ram_used_mb_ : 0;
  const auto cpu_headroom = configured_ && budget_.cpu_threads >= cpu_threads_used_
                                ? budget_.cpu_threads - cpu_threads_used_
                                : 0;

  if (!configured_) {
    return rejected_decision(
        core::Status::failure(core::ErrorCode::kInvalidArgument,
                              "resource manager is not configured"),
        vram_used_mb_, ram_used_mb_, cpu_threads_used_,
        vram_headroom, ram_headroom, cpu_headroom);
  }
  if (active_.contains(request.workload_id.value())) {
    return rejected_decision(
        core::Status::failure(core::ErrorCode::kAlreadyExists,
                              "workload id is already active"),
        vram_used_mb_, ram_used_mb_, cpu_threads_used_,
        vram_headroom, ram_headroom, cpu_headroom);
  }

  const bool request_uses_gpu = uses_gpu(request);
  if (exclusive_gpu_active_ && request_uses_gpu) {
    return rejected_decision(
        core::Status::failure(core::ErrorCode::kBusy,
                              "GPU is reserved by an exclusive workload"),
        vram_used_mb_, ram_used_mb_, cpu_threads_used_,
        vram_headroom, ram_headroom, cpu_headroom);
  }
  if (request.exclusive_gpu && active_gpu_workloads_ > 0) {
    return rejected_decision(
        core::Status::failure(core::ErrorCode::kBusy,
                              "exclusive GPU workload requires existing GPU work to drain"),
        vram_used_mb_, ram_used_mb_, cpu_threads_used_,
        vram_headroom, ram_headroom, cpu_headroom);
  }

  if (request.vram_mb > vram_headroom) {
    return rejected_decision(
        core::Status::failure(core::ErrorCode::kResourceExhausted,
                              "VRAM admission budget exceeded"),
        vram_used_mb_, ram_used_mb_, cpu_threads_used_,
        vram_headroom, ram_headroom, cpu_headroom);
  }
  if (request.ram_mb > ram_headroom) {
    return rejected_decision(
        core::Status::failure(core::ErrorCode::kResourceExhausted,
                              "RAM admission budget exceeded"),
        vram_used_mb_, ram_used_mb_, cpu_threads_used_,
        vram_headroom, ram_headroom, cpu_headroom);
  }
  if (request.cpu_threads > cpu_headroom) {
    return rejected_decision(
        core::Status::failure(core::ErrorCode::kResourceExhausted,
                              "CPU thread admission budget exceeded"),
        vram_used_mb_, ram_used_mb_, cpu_threads_used_,
        vram_headroom, ram_headroom, cpu_headroom);
  }

  return AdmissionDecision{
      .status = core::Status::success(),
      .projected_vram_mb = vram_used_mb_ + request.vram_mb,
      .projected_ram_mb = ram_used_mb_ + request.ram_mb,
      .projected_cpu_threads = cpu_threads_used_ + request.cpu_threads,
      .vram_headroom_after_mb = vram_headroom - request.vram_mb,
      .ram_headroom_after_mb = ram_headroom - request.ram_mb,
      .cpu_headroom_after = cpu_headroom - request.cpu_threads,
      .would_activate_exclusive_gpu = request.exclusive_gpu,
  };
}

AdmissionDecision ResourceManager::preview_admission(const WorkloadRequest& request) const {
  if (const auto status = validate_request(request); !status.ok()) {
    return AdmissionDecision{.status = status};
  }
  std::scoped_lock lock(mutex_);
  return evaluate_locked(request);
}

core::Status ResourceManager::try_acquire(const WorkloadRequest& request) {
  if (const auto status = validate_request(request); !status.ok()) {
    return status;
  }

  std::scoped_lock lock(mutex_);
  const auto decision = evaluate_locked(request);
  if (!decision.allowed()) {
    ++rejections_total_;
    return decision.status;
  }

  active_.emplace(request.workload_id.value(), request);
  vram_used_mb_ = decision.projected_vram_mb;
  ram_used_mb_ = decision.projected_ram_mb;
  cpu_threads_used_ = decision.projected_cpu_threads;
  if (uses_gpu(request)) ++active_gpu_workloads_;
  exclusive_gpu_active_ = exclusive_gpu_active_ || request.exclusive_gpu;
  vram_peak_mb_ = std::max(vram_peak_mb_, vram_used_mb_);
  ram_peak_mb_ = std::max(ram_peak_mb_, ram_used_mb_);
  cpu_threads_peak_ = std::max(cpu_threads_peak_, cpu_threads_used_);
  ++admissions_total_;
  return core::Status::success();
}

LeaseAcquireResult ResourceManager::try_acquire_scoped(const WorkloadRequest& request) {
  const auto status = try_acquire(request);
  if (!status.ok()) return LeaseAcquireResult{status, {}};
  return LeaseAcquireResult{
      core::Status::success(),
      ResourceLease{this, request.workload_id},
  };
}

core::Status ResourceManager::release(const core::EntityId& workload_id) {
  std::scoped_lock lock(mutex_);
  const auto it = active_.find(workload_id.value());
  if (it == active_.end()) {
    return core::Status::failure(core::ErrorCode::kNotFound,
                                 "workload is not active");
  }

  const auto request = it->second;
  active_.erase(it);
  vram_used_mb_ -= request.vram_mb;
  ram_used_mb_ -= request.ram_mb;
  cpu_threads_used_ -= request.cpu_threads;
  if (uses_gpu(request) && active_gpu_workloads_ > 0) {
    --active_gpu_workloads_;
  }
  if (request.exclusive_gpu) {
    exclusive_gpu_active_ = false;
  }
  return core::Status::success();
}

ResourceSnapshot ResourceManager::snapshot_locked() const {
  return ResourceSnapshot{
      .budget = budget_,
      .vram_used_mb = vram_used_mb_,
      .ram_used_mb = ram_used_mb_,
      .cpu_threads_used = cpu_threads_used_,
      .active_workloads = active_.size(),
      .active_gpu_workloads = active_gpu_workloads_,
      .exclusive_gpu_active = exclusive_gpu_active_,
      .vram_peak_mb = vram_peak_mb_,
      .ram_peak_mb = ram_peak_mb_,
      .cpu_threads_peak = cpu_threads_peak_,
      .admissions_total = admissions_total_,
      .rejections_total = rejections_total_,
  };
}

ResourceSnapshot ResourceManager::snapshot() const {
  std::scoped_lock lock(mutex_);
  return snapshot_locked();
}

}  // namespace makewatch::runtime
