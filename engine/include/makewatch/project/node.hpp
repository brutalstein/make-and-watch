#pragma once

#include <cstdint>
#include <map>
#include <string>

#include "makewatch/core/id.hpp"
#include "makewatch/domain/approval.hpp"

namespace makewatch::project {

enum class NodeKind {
  kSeries,
  kEpisode,
  kScene,
  kShot,
  kCharacter,
  kLocation,
  kAsset,
  kAudio,
  kGeneration,
};

struct Node final {
  core::EntityId id;
  NodeKind kind{NodeKind::kAsset};
  std::string title;
  std::map<std::string, std::string> metadata;
  std::uint64_t revision{0};
  domain::ApprovalState approval{domain::ApprovalState::kDraft};
  bool locked{false};
  bool stale{false};
};

}  // namespace makewatch::project
