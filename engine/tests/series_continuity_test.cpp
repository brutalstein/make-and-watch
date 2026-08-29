#include <cassert>
#include <cstdint>
#include <string>
#include <utility>

#include "makewatch/media/series_continuity.hpp"
#include "makewatch/project/node.hpp"

namespace {

using makewatch::core::EntityId;
using makewatch::domain::ApprovalState;
using makewatch::project::Node;
using makewatch::project::NodeKind;
using makewatch::project::ProjectSnapshot;

Node node(std::string id, NodeKind kind, std::string title, std::uint64_t revision = 1U) {
  Node value;
  value.id = EntityId{std::move(id)};
  value.kind = kind;
  value.title = std::move(title);
  value.revision = revision;
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
  snapshot.project_revision = 44U;
  snapshot.graph.nodes = {
      node("series.one", NodeKind::kSeries, "Series"),
      node("episode.1", NodeKind::kEpisode, "Episode 1"),
      node("episode.2", NodeKind::kEpisode, "Episode 2"),
      node("scene.1", NodeKind::kScene, "Scene 1"),
      node("scene.2", NodeKind::kScene, "Scene 2"),
      node("shot.1", NodeKind::kShot, "Shot 1"),
      node("shot.2", NodeKind::kShot, "Shot 2"),
      node("character.mira", NodeKind::kCharacter, "Mira", 7U),
  };

  edge(snapshot, "episode.1", "series.one");
  edge(snapshot, "episode.2", "series.one");
  edge(snapshot, "scene.1", "episode.1");
  edge(snapshot, "scene.2", "episode.2");
  edge(snapshot, "scene.1", "character.mira");
  edge(snapshot, "scene.2", "character.mira");
  edge(snapshot, "shot.1", "scene.1");
  edge(snapshot, "shot.2", "scene.2");

  makewatch::media::SeriesContinuityManifest manifest;
  makewatch::media::SeriesContinuityCompiler compiler;
  const auto status = compiler.compile(snapshot, EntityId{"series.one"}, manifest);
  assert(status.ok());
  assert(manifest.project_revision == 44U);
  assert(manifest.episodes.size() == 2U);
  assert(manifest.characters.size() == 1U);
  assert(manifest.characters.front().character_id.value() == "character.mira");
  assert(manifest.characters.front().revision == 7U);
  assert(manifest.characters.front().cross_episode);
  assert(manifest.characters.front().episode_ids.size() == 2U);
  assert(manifest.shots.size() == 2U);
  assert(manifest.shots.front().character_ids.size() == 1U);
  assert(manifest.ready_for_final_synthesis);

  snapshot.graph.nodes.back().locked = false;
  snapshot.graph.nodes.back().revision = 8U;
  const auto changed_status = compiler.compile(snapshot, EntityId{"series.one"}, manifest);
  assert(changed_status.ok());
  assert(!manifest.ready_for_final_synthesis);
  assert(manifest.characters.front().revision == 8U);
  assert(!manifest.issues.empty());
  return 0;
}
