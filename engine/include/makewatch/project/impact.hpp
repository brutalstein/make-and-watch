#pragma once

#include <vector>

#include "makewatch/core/id.hpp"
#include "makewatch/core/status.hpp"

namespace makewatch::project {

struct ImpactReport final {
  core::Status status;
  std::vector<core::EntityId> affected;
  std::vector<core::EntityId> locked;
  std::vector<core::EntityId> already_stale;

  [[nodiscard]] bool ok() const noexcept { return status.ok(); }
};

}  // namespace makewatch::project
