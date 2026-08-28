#include <cstdlib>
#include <iostream>
#include <string>

#include "makewatch/core/status.hpp"
#include "makewatch/runtime/resource_manager.hpp"

namespace {

using makewatch::core::EntityId;
using makewatch::core::ErrorCode;
using makewatch::runtime::ResourceBudget;
using makewatch::runtime::ResourceManager;
using makewatch::runtime::WorkloadRequest;

void require(bool condition, const std::string& message) {
  if (!condition) {
    std::cerr << "FAILED: " << message << '\n';
    std::exit(EXIT_FAILURE);
  }
}

ResourceBudget laptop_budget() {
  return ResourceBudget{
      .vram_total_mb = 8192,
      .vram_reserve_mb = 1024,
      .ram_total_mb = 32768,
      .ram_reserve_mb = 4096,
      .cpu_threads = 16,
  };
}

void test_reserves_prevent_overcommit_and_release_restores_capacity() {
  ResourceManager manager;
  require(manager.configure(laptop_budget()).ok(), "valid resource budget should configure");

  const WorkloadRequest video{
      .workload_id = EntityId{"video.1"},
      .vram_mb = 6000,
      .ram_mb = 8000,
      .cpu_threads = 6,
      .exclusive_gpu = false,
  };
  require(manager.try_acquire(video).ok(), "first workload should fit protected budget");

  const WorkloadRequest too_large{
      .workload_id = EntityId{"video.2"},
      .vram_mb = 1500,
      .ram_mb = 2000,
      .cpu_threads = 2,
      .exclusive_gpu = false,
  };
  const auto rejected = manager.try_acquire(too_large);
  require(!rejected.ok() && rejected.code == ErrorCode::kResourceExhausted,
          "VRAM reserve must prevent unsafe overcommit");

  const auto active = manager.snapshot();
  require(active.vram_used_mb == 6000 && active.usable_vram_mb() == 7168,
          "snapshot should expose protected VRAM accounting");

  require(manager.release(EntityId{"video.1"}).ok(), "active workload should release cleanly");
  require(manager.try_acquire(too_large).ok(), "released capacity should be reusable");
}

void test_exclusive_gpu_policy_and_duplicate_protection() {
  ResourceManager manager;
  require(manager.configure(laptop_budget()).ok(), "manager should configure");

  const WorkloadRequest preview{
      .workload_id = EntityId{"preview"},
      .vram_mb = 512,
      .ram_mb = 512,
      .cpu_threads = 1,
      .exclusive_gpu = false,
  };
  require(manager.try_acquire(preview).ok(), "preview should acquire resources");
  const auto duplicate = manager.try_acquire(preview);
  require(!duplicate.ok() && duplicate.code == ErrorCode::kAlreadyExists,
          "duplicate workload id must be rejected");

  const WorkloadRequest exclusive{
      .workload_id = EntityId{"heavy-video"},
      .vram_mb = 5000,
      .ram_mb = 6000,
      .cpu_threads = 8,
      .exclusive_gpu = true,
  };
  const auto busy = manager.try_acquire(exclusive);
  require(!busy.ok() && busy.code == ErrorCode::kBusy,
          "exclusive GPU job must wait for active work to drain");

  require(manager.release(EntityId{"preview"}).ok(), "preview should release");
  require(manager.try_acquire(exclusive).ok(), "exclusive workload should acquire empty GPU");
  require(manager.snapshot().exclusive_gpu_active, "exclusive state must be visible in telemetry");

  const WorkloadRequest background{
      .workload_id = EntityId{"background"},
      .vram_mb = 64,
      .ram_mb = 64,
      .cpu_threads = 1,
      .exclusive_gpu = false,
  };
  const auto blocked = manager.try_acquire(background);
  require(!blocked.ok() && blocked.code == ErrorCode::kBusy,
          "no GPU workload may enter while exclusive job is active");
}

void test_configuration_guards() {
  ResourceManager manager;
  const auto impossible = manager.configure(ResourceBudget{
      .vram_total_mb = 8192,
      .vram_reserve_mb = 8192,
      .ram_total_mb = 32768,
      .ram_reserve_mb = 4096,
      .cpu_threads = 16,
  });
  require(!impossible.ok() && impossible.code == ErrorCode::kInvalidArgument,
          "reserve equal to total must be rejected");

  const WorkloadRequest request{
      .workload_id = EntityId{"work"},
      .vram_mb = 1,
      .ram_mb = 1,
      .cpu_threads = 1,
      .exclusive_gpu = false,
  };
  const auto unconfigured = manager.try_acquire(request);
  require(!unconfigured.ok() && unconfigured.code == ErrorCode::kInvalidArgument,
          "unconfigured manager must reject admission");

  require(manager.configure(laptop_budget()).ok(), "valid configuration should succeed");
  require(manager.try_acquire(request).ok(), "workload should acquire after configuration");
  const auto reconfigure = manager.configure(laptop_budget());
  require(!reconfigure.ok() && reconfigure.code == ErrorCode::kBusy,
          "live resource manager must not be reconfigured under active workloads");
}

}  // namespace

int main() {
  test_reserves_prevent_overcommit_and_release_restores_capacity();
  test_exclusive_gpu_policy_and_duplicate_protection();
  test_configuration_guards();
  std::cout << "resource_manager_test: all checks passed\n";
  return EXIT_SUCCESS;
}
