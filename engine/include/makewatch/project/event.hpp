#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "makewatch/core/id.hpp"

namespace makewatch::project {

enum class EventType {
  kNodeCreated,
  kNodeUpdated,
  kNodeRemoved,
  kDependencyAdded,
  kDependencyRemoved,
  kLockChanged,
  kApprovalChanged,
  kFreshnessChanged,
  kDependentsInvalidated,
  kTransactionCommitted,
};

struct Event final {
  EventType type{EventType::kTransactionCommitted};
  core::EntityId entity_id;
  std::uint64_t project_revision{0};
  std::vector<core::EntityId> affected;
  std::string detail;
};

}  // namespace makewatch::project
