#include "makewatch/runtime/resource_manager.hpp"

#include <utility>

namespace makewatch::runtime {

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
  exclusive_gpu_active_ = false;
  return core::Status::success();
}

core::Status ResourceManager::try_acquire(const WorkloadRequest& request) {
  if (const auto status = validate_request(request); !status.ok()) {
    return status;
  }

  std::scoped_lock lock(mutex_);
  if (!configured_) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                 "resource manager is not configured");
  }
  if (active_.contains(request.workload_id.value())) {
    return core::Status::failure(core::ErrorCode::kAlreadyExists,
                                 "workload id is already active");
  }
  if (exclusive_gpu_active_ || (request.exclusive_gpu && !active_.empty())) {
    return core::Status::failure(core::ErrorCode::kBusy,
                                 "GPU exclusivity conflicts with active workload set");
  }

  const auto usable_vram = budget_.vram_total_mb - budget_.vram_reserve_mb;
  const auto usable_ram = budget_.ram_total_mb - budget_.ram_reserve_mb;
  if (vram_used_mb_ > usable_vram || request.vram_mb > usable_vram - vram_used_mb_) {
    return core::Status::failure(core::ErrorCode::kResourceExhausted,
                                 "VRAM admission budget exceeded");
  }
  if (ram_used_mb_ > usable_ram || request.ram_mb > usable_ram - ram_used_mb_) {
    return core::Status::failure(core::ErrorCode::kResourceExhausted,
                                 "RAM admission budget exceeded");
  }
  if (cpu_threads_used_ > budget_.cpu_threads ||
      request.cpu_threads > budget_.cpu_threads - cpu_threads_used_) {
    return core::Status::failure(core::ErrorCode::kResourceExhausted,
                                 "CPU thread admission budget exceeded");
  }

  active_.emplace(request.workload_id.value(), request);
  vram_used_mb_ += request.vram_mb;
  ram_used_mb_ += request.ram_mb;
  cpu_threads_used_ += request.cpu_threads;
  exclusive_gpu_active_ = request.exclusive_gpu;
  return core::Status::success();
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
  if (request.exclusive_gpu) {
    exclusive_gpu_active_ = false;
  }
  return core::Status::success();
}

ResourceSnapshot ResourceManager::snapshot() const {
  std::scoped_lock lock(mutex_);
  return ResourceSnapshot{budget_, vram_used_mb_, ram_used_mb_, cpu_threads_used_,
                          active_.size(), exclusive_gpu_active_};
}

}  // namespace makewatch::runtime
