#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <mutex>

#include "makewatch/core/id.hpp"
#include "makewatch/core/status.hpp"

namespace makewatch::runtime {

struct ResourceBudget final {
  std::uint64_t vram_total_mb{0};
  std::uint64_t vram_reserve_mb{0};
  std::uint64_t ram_total_mb{0};
  std::uint64_t ram_reserve_mb{0};
  std::uint32_t cpu_threads{1};
};

struct WorkloadRequest final {
  core::EntityId workload_id;
  std::uint64_t vram_mb{0};
  std::uint64_t ram_mb{0};
  std::uint32_t cpu_threads{1};
  bool exclusive_gpu{false};
};

struct ResourceSnapshot final {
  ResourceBudget budget;
  std::uint64_t vram_used_mb{0};
  std::uint64_t ram_used_mb{0};
  std::uint32_t cpu_threads_used{0};
  std::size_t active_workloads{0};
  std::size_t active_gpu_workloads{0};
  bool exclusive_gpu_active{false};
  std::uint64_t vram_peak_mb{0};
  std::uint64_t ram_peak_mb{0};
  std::uint32_t cpu_threads_peak{0};
  std::uint64_t admissions_total{0};
  std::uint64_t rejections_total{0};

  [[nodiscard]] std::uint64_t usable_vram_mb() const noexcept {
    return budget.vram_total_mb >= budget.vram_reserve_mb
               ? budget.vram_total_mb - budget.vram_reserve_mb
               : 0;
  }

  [[nodiscard]] std::uint64_t usable_ram_mb() const noexcept {
    return budget.ram_total_mb >= budget.ram_reserve_mb
               ? budget.ram_total_mb - budget.ram_reserve_mb
               : 0;
  }

  [[nodiscard]] std::uint64_t available_vram_mb() const noexcept {
    const auto usable = usable_vram_mb();
    return usable >= vram_used_mb ? usable - vram_used_mb : 0;
  }

  [[nodiscard]] std::uint64_t available_ram_mb() const noexcept {
    const auto usable = usable_ram_mb();
    return usable >= ram_used_mb ? usable - ram_used_mb : 0;
  }

  [[nodiscard]] std::uint32_t available_cpu_threads() const noexcept {
    return budget.cpu_threads >= cpu_threads_used ? budget.cpu_threads - cpu_threads_used : 0;
  }
};

struct AdmissionDecision final {
  core::Status status;
  std::uint64_t projected_vram_mb{0};
  std::uint64_t projected_ram_mb{0};
  std::uint32_t projected_cpu_threads{0};
  std::uint64_t vram_headroom_after_mb{0};
  std::uint64_t ram_headroom_after_mb{0};
  std::uint32_t cpu_headroom_after{0};
  bool would_activate_exclusive_gpu{false};

  [[nodiscard]] bool allowed() const noexcept { return status.ok(); }
};

class ResourceManager;

// Scoped lease for exception/early-return safe workload accounting.
// ResourceManager must outlive all leases it creates.
class ResourceLease final {
 public:
  ResourceLease() = default;
  ~ResourceLease() noexcept;

  ResourceLease(const ResourceLease&) = delete;
  ResourceLease& operator=(const ResourceLease&) = delete;

  ResourceLease(ResourceLease&& other) noexcept;
  ResourceLease& operator=(ResourceLease&& other) noexcept;

  [[nodiscard]] bool active() const noexcept { return manager_ != nullptr; }
  [[nodiscard]] const core::EntityId& workload_id() const noexcept { return workload_id_; }
  [[nodiscard]] core::Status release();

 private:
  friend class ResourceManager;
  ResourceLease(ResourceManager* manager, core::EntityId workload_id) noexcept;

  ResourceManager* manager_{nullptr};
  core::EntityId workload_id_;
};

struct LeaseAcquireResult final {
  core::Status status;
  ResourceLease lease;

  [[nodiscard]] bool ok() const noexcept { return status.ok(); }
};

class ResourceManager final {
 public:
  [[nodiscard]] core::Status configure(ResourceBudget budget);
  [[nodiscard]] AdmissionDecision preview_admission(const WorkloadRequest& request) const;
  [[nodiscard]] core::Status try_acquire(const WorkloadRequest& request);
  [[nodiscard]] LeaseAcquireResult try_acquire_scoped(const WorkloadRequest& request);
  [[nodiscard]] core::Status release(const core::EntityId& workload_id);
  [[nodiscard]] ResourceSnapshot snapshot() const;

 private:
  [[nodiscard]] static core::Status validate_budget(const ResourceBudget& budget);
  [[nodiscard]] static core::Status validate_request(const WorkloadRequest& request);
  [[nodiscard]] static bool uses_gpu(const WorkloadRequest& request) noexcept;
  [[nodiscard]] AdmissionDecision evaluate_locked(const WorkloadRequest& request) const;
  [[nodiscard]] ResourceSnapshot snapshot_locked() const;

  mutable std::mutex mutex_;
  ResourceBudget budget_{};
  bool configured_{false};
  std::map<std::string, WorkloadRequest> active_;
  std::uint64_t vram_used_mb_{0};
  std::uint64_t ram_used_mb_{0};
  std::uint32_t cpu_threads_used_{0};
  std::size_t active_gpu_workloads_{0};
  bool exclusive_gpu_active_{false};
  std::uint64_t vram_peak_mb_{0};
  std::uint64_t ram_peak_mb_{0};
  std::uint32_t cpu_threads_peak_{0};
  std::uint64_t admissions_total_{0};
  std::uint64_t rejections_total_{0};
};

}  // namespace makewatch::runtime
