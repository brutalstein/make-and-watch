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
  bool exclusive_gpu_active{false};

  [[nodiscard]] std::uint64_t usable_vram_mb() const noexcept {
    return budget.vram_total_mb - budget.vram_reserve_mb;
  }

  [[nodiscard]] std::uint64_t usable_ram_mb() const noexcept {
    return budget.ram_total_mb - budget.ram_reserve_mb;
  }
};

class ResourceManager final {
 public:
  [[nodiscard]] core::Status configure(ResourceBudget budget);
  [[nodiscard]] core::Status try_acquire(const WorkloadRequest& request);
  [[nodiscard]] core::Status release(const core::EntityId& workload_id);
  [[nodiscard]] ResourceSnapshot snapshot() const;

 private:
  [[nodiscard]] static core::Status validate_budget(const ResourceBudget& budget);
  [[nodiscard]] static core::Status validate_request(const WorkloadRequest& request);

  mutable std::mutex mutex_;
  ResourceBudget budget_{};
  bool configured_{false};
  std::map<std::string, WorkloadRequest> active_;
  std::uint64_t vram_used_mb_{0};
  std::uint64_t ram_used_mb_{0};
  std::uint32_t cpu_threads_used_{0};
  bool exclusive_gpu_active_{false};
};

}  // namespace makewatch::runtime
