#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "makewatch/core/id.hpp"
#include "makewatch/core/status.hpp"
#include "makewatch/project/snapshot.hpp"

namespace makewatch::media {

struct VideoProfile final {
  std::uint32_t width{1280};
  std::uint32_t height{720};
  double frames_per_second{24.0};
  bool preview{true};
};

enum class VideoRenderTaskKind {
  kSynthesizeShot,
  kCompositeShot,
  kAssembleEpisode,
};

struct VideoRenderTask final {
  std::string id;
  VideoRenderTaskKind kind{VideoRenderTaskKind::kSynthesizeShot};
  core::EntityId entity_id;
  std::string generation_strategy;
  double duration_seconds{0.0};
  std::vector<std::string> depends_on;
  std::vector<core::EntityId> continuity_characters;
};

struct VideoRenderPlan final {
  std::uint64_t project_revision{0};
  core::EntityId episode_id;
  VideoProfile profile;
  double total_duration_seconds{0.0};
  std::vector<VideoRenderTask> tasks;
  std::vector<core::EntityId> continuity_characters;
  std::vector<std::string> issues;
  bool ready_for_final_synthesis{false};
};

class VideoPipelineCompiler final {
 public:
  [[nodiscard]] core::Status compile(
      const project::ProjectSnapshot& snapshot,
      const core::EntityId& episode_id,
      const VideoProfile& profile,
      VideoRenderPlan& output) const;
};

}  // namespace makewatch::media
