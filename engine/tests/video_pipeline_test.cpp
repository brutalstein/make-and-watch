#include <cassert>
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

  snapshot.graph.nodes[4].metadata.erase("generationStrategy");
  const auto incomplete_status = compiler.compile(snapshot, EntityId{"episode.1"}, {}, plan);
  assert(incomplete_status.ok());
  assert(!plan.ready_for_final_synthesis);
  assert(!plan.issues.empty());
  return 0;
}
