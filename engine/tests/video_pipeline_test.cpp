#include <algorithm>
#include <cassert>
#include <limits>
#include <string>
#include <utility>

#include "makewatch/media/video_pipeline.hpp"
#include "makewatch/project/node.hpp"

namespace {

using makewatch::core::EntityId;
using makewatch::domain::ApprovalState;
using makewatch::project::Node;
using makewatch::project::NodeKind;
using makewatch::project::ProjectSnapshot;

Node node(std::string id, NodeKind kind, std::string title) {
  Node value;
  value.id = EntityId{std::move(id)};
  value.kind = kind;
  value.title = std::move(title);
  value.revision = 1U;
  value.approval = ApprovalState::kApproved;
  value.locked = true;
  return value;
}

void edge(ProjectSnapshot& snapshot, const char* dependent, const char* dependency) {
  snapshot.graph.dependencies.push_back({EntityId{dependent}, EntityId{dependency}});
}

}  // namespace

int main() {
  ProjectSnapshot snapshot;
  snapshot.project_revision = 12U;
  snapshot.graph.nodes = {
      node("series.one", NodeKind::kSeries, "Series"),
      node("episode.1", NodeKind::kEpisode, "Episode 1"),
      node("scene.1", NodeKind::kScene, "Scene 1"),
      node("shot.1", NodeKind::kShot, "Shot 1"),
      node("shot.2", NodeKind::kShot, "Shot 2"),
      node("character.mira", NodeKind::kCharacter, "Mira"),
  };
  snapshot.graph.nodes[3].metadata["index"] = "1";
  snapshot.graph.nodes[3].metadata["durationSeconds"] = "4.5";
  snapshot.graph.nodes[3].metadata["generationStrategy"] = "image_to_video";
  snapshot.graph.nodes[4].metadata["index"] = "2";
  snapshot.graph.nodes[4].metadata["durationSeconds"] = "3.0";
  snapshot.graph.nodes[4].metadata["generationStrategy"] = "static_camera";

  edge(snapshot, "episode.1", "series.one");
  edge(snapshot, "scene.1", "episode.1");
  edge(snapshot, "scene.1", "character.mira");
  edge(snapshot, "shot.1", "scene.1");
  edge(snapshot, "shot.2", "scene.1");

  makewatch::media::VideoRenderPlan plan;
  makewatch::media::VideoPipelineCompiler compiler;
  const auto status = compiler.compile(snapshot, EntityId{"episode.1"}, {}, plan);
  assert(status.ok());
  assert(plan.project_revision == 12U);
  assert(plan.tasks.size() == 5U);
  assert(plan.tasks[0].kind == makewatch::media::VideoRenderTaskKind::kSynthesizeShot);
  assert(plan.tasks[0].generation_strategy == "image_to_video");
  assert(plan.tasks[0].continuity_characters.size() == 1U);
  assert(plan.tasks[1].depends_on.size() == 1U);
  assert(plan.tasks.back().kind == makewatch::media::VideoRenderTaskKind::kAssembleEpisode);
  assert(plan.tasks.back().depends_on.size() == 2U);
  assert(plan.total_duration_seconds == 7.5);
  assert(plan.continuity_characters.size() == 1U);
  assert(plan.ready_for_final_synthesis);

  makewatch::media::VideoProfile invalid_profile;
  invalid_profile.frames_per_second = std::numeric_limits<double>::quiet_NaN();
  const auto invalid_profile_status = compiler.compile(snapshot, EntityId{"episode.1"}, invalid_profile, plan);
  assert(!invalid_profile_status.ok());
  assert(invalid_profile_status.code == makewatch::core::ErrorCode::kInvalidArgument);

  snapshot.graph.nodes[4].metadata["durationSeconds"] = "nan";
  const auto nan_duration_status = compiler.compile(snapshot, EntityId{"episode.1"}, {}, plan);
  assert(nan_duration_status.ok());
  assert(!plan.ready_for_final_synthesis);
  assert(plan.total_duration_seconds == 4.5);
  snapshot.graph.nodes[4].metadata["durationSeconds"] = "3.0";

  snapshot.graph.nodes[0].stale = true;
  const auto stale_series_status = compiler.compile(snapshot, EntityId{"episode.1"}, {}, plan);
  assert(stale_series_status.ok());
  assert(!plan.ready_for_final_synthesis);
  snapshot.graph.nodes[0].stale = false;

  snapshot.graph.nodes[2].stale = true;
  const auto stale_scene_status = compiler.compile(snapshot, EntityId{"episode.1"}, {}, plan);
  assert(stale_scene_status.ok());
  assert(!plan.ready_for_final_synthesis);
  snapshot.graph.nodes[2].stale = false;

  snapshot.graph.nodes[1].approval = ApprovalState::kDraft;
  const auto draft_episode_status = compiler.compile(snapshot, EntityId{"episode.1"}, {}, plan);
  assert(draft_episode_status.ok());
  assert(!plan.ready_for_final_synthesis);
  snapshot.graph.nodes[1].approval = ApprovalState::kApproved;

  snapshot.graph.nodes.push_back(node("episode.other", NodeKind::kEpisode, "Other Episode"));
  edge(snapshot, "scene.1", "episode.other");
  const auto ambiguous_scene_status = compiler.compile(snapshot, EntityId{"episode.1"}, {}, plan);
  assert(ambiguous_scene_status.ok());
  assert(!plan.ready_for_final_synthesis);
  assert(std::any_of(plan.issues.begin(), plan.issues.end(), [](const std::string& issue) {
    return issue.find("scene scene.1 must belong to exactly one episode") != std::string::npos;
  }));
  snapshot.graph.dependencies.pop_back();
  snapshot.graph.nodes.pop_back();

  snapshot.graph.nodes.push_back(node("scene.2", NodeKind::kScene, "Scene 2"));
  snapshot.graph.nodes.back().metadata["index"] = "2";
  edge(snapshot, "scene.2", "episode.1");
  edge(snapshot, "shot.1", "scene.2");
  const auto duplicate_shot_status = compiler.compile(snapshot, EntityId{"episode.1"}, {}, plan);
  assert(duplicate_shot_status.ok());
  assert(!plan.ready_for_final_synthesis);
  const auto synth_shot_one_count = std::count_if(
      plan.tasks.begin(), plan.tasks.end(),
      [](const makewatch::media::VideoRenderTask& task) {
        return task.kind == makewatch::media::VideoRenderTaskKind::kSynthesizeShot
            && task.entity_id == EntityId{"shot.1"};
      });
  assert(synth_shot_one_count == 1);
  snapshot.graph.dependencies.pop_back();
  snapshot.graph.dependencies.pop_back();
  snapshot.graph.nodes.pop_back();

  snapshot.graph.nodes[4].metadata.erase("generationStrategy");
  const auto incomplete_status = compiler.compile(snapshot, EntityId{"episode.1"}, {}, plan);
  assert(incomplete_status.ok());
  assert(!plan.ready_for_final_synthesis);
  assert(!plan.issues.empty());
  return 0;
}
