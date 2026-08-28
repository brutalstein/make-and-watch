#pragma once

#include <string>
#include <vector>

#include "makewatch/core/id.hpp"
#include "makewatch/domain/approval.hpp"

namespace makewatch::domain {

struct Shot final {
  core::EntityId id;
  std::string title;
  double estimated_duration_seconds{0.0};
  ApprovalState approval{ApprovalState::kDraft};
};

struct Scene final {
  core::EntityId id;
  std::string title;
  std::string summary;
  ApprovalState approval{ApprovalState::kDraft};
  std::vector<Shot> shots;
};

struct Episode final {
  core::EntityId id;
  std::string title;
  ApprovalState approval{ApprovalState::kDraft};
  std::vector<Scene> scenes;
};

}  // namespace makewatch::domain
