#include <cstdlib>
#include <iostream>
#include <string>
#include <utility>

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

void test_preview_is_non_mutating_and_reserves_prevent_overcommit() {
  ResourceManager manager;
  require(manager.configure(laptop_budget()).ok(), "valid resource budget should configure");

  const WorkloadRequest video{
      .workload_id = EntityId{"video.1"},
      .vram_mb = 6000,
      .ram_mb = 8000,
      .cpu_threads = 6,
      .exclusive_gpu = false,
  };

  const auto preview = manager.preview_admission(video);
  require(preview.allowed(), "preview should allow a workload that fits protected capacity");
  require(preview.projected_vram_mb == 6000 && preview.vram_headroom_after_mb == 1168,
          "preview should expose projected VRAM and protected headroom");
  require(manager.snapshot().active_workloads == 0 && manager.snapshot().admissions_total == 0,
          "preview must never mutate resource accounting or admission counters");

  require(manager.try_acquire(video).ok(), "first workload should fit protected budget");

  const WorkloadRequest too_large{
      .workload_id = EntityId{"video.2"},
      .vram_mb = 1500,
      .ram_mb = 2000,
      .cpu_threads = 2,
      .exclusive_gpu = false,
  };
  const auto rejected_preview = manager.preview_admission(too_large);
  require(!rejected_preview.allowed() && rejected_preview.status.code == ErrorCode::kResourceExhausted,
          "preview should explain an unsafe VRAM request without reserving it");
  require(manager.snapshot().rejections_total == 0,
          "non-mutating preview must not count as a rejected admission attempt");

  const auto rejected = manager.try_acquire(too_large);
  require(!rejected.ok() && rejected.code == ErrorCode::kResourceExhausted,
          "VRAM reserve must prevent unsafe overcommit");

  const auto active = manager.snapshot();
  require(active.vram_used_mb == 6000 && active.usable_vram_mb() == 7168,
          "snapshot should expose protected VRAM accounting");
  require(active.available_vram_mb() == 1168 && active.active_gpu_workloads == 1,
          "snapshot should expose remaining headroom and active GPU workload count");
  require(active.vram_peak_mb == 6000 && active.ram_peak_mb == 8000 && active.cpu_threads_peak == 6,
          "resource high-water marks should record peak admitted usage");
  require(active.admissions_total == 1 && active.rejections_total == 1,
          "resource telemetry should count real admission outcomes");

  require(manager.release(EntityId{"video.1"}).ok(), "active workload should release cleanly");
  require(manager.try_acquire(too_large).ok(), "released capacity should be reusable");
}

void test_exclusive_gpu_policy_only_blocks_gpu_work() {
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
          "exclusive GPU job must wait for existing GPU work to drain");

  require(manager.release(EntityId{"preview"}).ok(), "preview should release");
  require(manager.try_acquire(exclusive).ok(), "exclusive workload should acquire an empty GPU");
  const auto exclusive_snapshot = manager.snapshot();
  require(exclusive_snapshot.exclusive_gpu_active && exclusive_snapshot.active_gpu_workloads == 1,
          "exclusive state and GPU workload count must be visible");

  const WorkloadRequest cpu_only{
      .workload_id = EntityId{"audio-cpu"},
      .vram_mb = 0,
      .ram_mb = 256,
      .cpu_threads = 2,
      .exclusive_gpu = false,
  };
  require(manager.try_acquire(cpu_only).ok(),
          "CPU-only work must remain admissible while the GPU is exclusively reserved");
  require(manager.snapshot().active_gpu_workloads == 1,
          "CPU-only work must not inflate GPU workload accounting");

  const WorkloadRequest gpu_background{
      .workload_id = EntityId{"background-gpu"},
      .vram_mb = 64,
      .ram_mb = 64,
      .cpu_threads = 1,
      .exclusive_gpu = false,
  };
  const auto blocked = manager.try_acquire(gpu_background);
  require(!blocked.ok() && blocked.code == ErrorCode::kBusy,
          "GPU work may not enter while an exclusive GPU job is active");

  require(manager.release(EntityId{"audio-cpu"}).ok(), "CPU-only workload should release independently");
  require(manager.release(EntityId{"heavy-video"}).ok(), "exclusive workload should release cleanly");
}

void test_scoped_lease_releases_on_scope_exit_and_move() {
  ResourceManager manager;
  require(manager.configure(laptop_budget()).ok(), "manager should configure");

  const WorkloadRequest request{
      .workload_id = EntityId{"scoped-preview"},
      .vram_mb = 768,
      .ram_mb = 1024,
      .cpu_threads = 2,
      .exclusive_gpu = false,
  };

  {
    auto acquired = manager.try_acquire_scoped(request);
    require(acquired.ok() && acquired.lease.active(), "scoped acquire should return an active lease");
    require(manager.snapshot().active_workloads == 1, "lease should own one live reservation");

    auto moved = std::move(acquired.lease);
    require(!acquired.lease.active() && moved.active(), "moving a lease must transfer release ownership exactly once");
    require(manager.snapshot().active_workloads == 1, "moving a lease must not change resource accounting");
  }

  const auto after = manager.snapshot();
  require(after.active_workloads == 0 && after.active_gpu_workloads == 0,
          "lease destruction must release workload accounting on every normal scope exit");
  require(after.vram_used_mb == 0 && after.ram_used_mb == 0 && after.cpu_threads_used == 0,
          "scoped release must restore all tracked capacities");
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
  test_preview_is_non_mutating_and_reserves_prevent_overcommit();
  test_exclusive_gpu_policy_only_blocks_gpu_work();
  test_scoped_lease_releases_on_scope_exit_and_move();
  test_configuration_guards();
  std::cout << "resource_manager_test: all checks passed\n";
  return EXIT_SUCCESS;
}
