#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "makewatch/core/id.hpp"
#include "makewatch/core/status.hpp"
#include "makewatch/domain/approval.hpp"
#include "makewatch/project/snapshot.hpp"

namespace makewatch::media {

struct CharacterContinuityAnchor final {
  core::EntityId character_id;
  std::string title;
  std::uint64_t revision{0};
  domain::ApprovalState approval{domain::ApprovalState::kDraft};
  bool locked{false};
  bool stale{false};
  bool cross_episode{false};
  std::vector<core::EntityId> episode_ids;
};

struct ShotContinuityBinding final {
  core::EntityId shot_id;
  core::EntityId scene_id;
  core::EntityId episode_id;
  std::vector<core::EntityId> character_ids;
};

struct EpisodeContinuitySummary final {
  core::EntityId episode_id;
  std::vector<core::EntityId> scene_ids;
  std::vector<core::EntityId> shot_ids;
  std::vector<core::EntityId> character_ids;
};

struct SeriesContinuityManifest final {
  std::uint64_t project_revision{0};
  core::EntityId series_id;
  std::vector<CharacterContinuityAnchor> characters;
  std::vector<EpisodeContinuitySummary> episodes;
  std::vector<ShotContinuityBinding> shots;
  std::vector<std::string> issues;
  bool ready_for_final_synthesis{false};
};

class SeriesContinuityCompiler final {
 public:
  [[nodiscard]] core::Status compile(
      const project::ProjectSnapshot& snapshot,
      const core::EntityId& series_id,
      SeriesContinuityManifest& output) const;
};

}  // namespace makewatch::media
