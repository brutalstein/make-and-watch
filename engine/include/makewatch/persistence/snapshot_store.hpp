#pragma once

#include "makewatch/core/status.hpp"
#include "makewatch/project/snapshot.hpp"

namespace makewatch::persistence {

struct LoadSnapshotResult final {
  core::Status status;
  project::ProjectSnapshot snapshot;

  [[nodiscard]] bool ok() const noexcept { return status.ok(); }
};

class SnapshotStore {
 public:
  virtual ~SnapshotStore() = default;

  [[nodiscard]] virtual core::Status save(const project::ProjectSnapshot& snapshot) = 0;
  [[nodiscard]] virtual LoadSnapshotResult load() = 0;
};

}  // namespace makewatch::persistence
