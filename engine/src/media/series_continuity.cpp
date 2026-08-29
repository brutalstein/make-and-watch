#include "makewatch/media/series_continuity.hpp"

#include <algorithm>
#include <charconv>
#include <map>
#include <set>
#include <string>
#include <system_error>
#include <utility>
#include <vector>

#include "makewatch/project/node.hpp"

namespace makewatch::media {
namespace {

using project::Node;
using project::NodeKind;

const Node* find_node(const project::ProjectSnapshot& snapshot, const core::EntityId& id) {
  const auto iterator = std::find_if(
      snapshot.graph.nodes.begin(), snapshot.graph.nodes.end(),
      [&id](const Node& node) { return node.id == id; });
  return iterator == snapshot.graph.nodes.end() ? nullptr : &*iterator;
}

std::vector<const Node*> direct_dependents(
    const project::ProjectSnapshot& snapshot,
    const core::EntityId& dependency,
    NodeKind kind) {
  std::vector<const Node*> result;
  for (const auto& edge : snapshot.graph.dependencies) {
    if (!(edge.dependency == dependency)) continue;
    const auto* node = find_node(snapshot, edge.dependent);
    if (node != nullptr && node->kind == kind) result.push_back(node);
  }
  return result;
}

std::vector<const Node*> direct_dependencies(
    const project::ProjectSnapshot& snapshot,
    const core::EntityId& dependent,
    NodeKind kind) {
  std::vector<const Node*> result;
  for (const auto& edge : snapshot.graph.dependencies) {
    if (!(edge.dependent == dependent)) continue;
    const auto* node = find_node(snapshot, edge.dependency);
    if (node != nullptr && node->kind == kind) result.push_back(node);
  }
  return result;
}

int metadata_index(const Node& node) {
  const auto iterator = node.metadata.find("index");
  if (iterator == node.metadata.end()) return 0;
  int value = 0;
  const auto* begin = iterator->second.data();
  const auto* end = begin + iterator->second.size();
  const auto result = std::from_chars(begin, end, value);
  return result.ec == std::errc{} && result.ptr == end ? value : 0;
}

void sort_nodes(std::vector<const Node*>& nodes) {
  std::sort(nodes.begin(), nodes.end(), [](const Node* left, const Node* right) {
    const auto left_index = metadata_index(*left);
    const auto right_index = metadata_index(*right);
    if (left_index != right_index) return left_index < right_index;
    return left->id.value() < right->id.value();
  });
}

std::vector<core::EntityId> ids_from_set(const std::set<std::string>& values) {
  std::vector<core::EntityId> result;
  result.reserve(values.size());
  for (const auto& value : values) result.emplace_back(value);
  return result;
}

}  // namespace

core::Status SeriesContinuityCompiler::compile(
    const project::ProjectSnapshot& snapshot,
    const core::EntityId& series_id,
    SeriesContinuityManifest& output) const {
  output = {};
  const auto* series = find_node(snapshot, series_id);
  if (series == nullptr) {
    return core::Status::failure(core::ErrorCode::kNotFound, "series continuity source was not found");
  }
  if (series->kind != NodeKind::kSeries) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument, "series continuity source must be a series node");
  }

  output.project_revision = snapshot.project_revision;
  output.series_id = series_id;
  if (series->stale) output.issues.push_back("series " + series_id.value() + " is stale");
  if (!domain::allows_final_synthesis(series->approval)) {
    output.issues.push_back("series " + series_id.value() + " is not approved for final synthesis");
  }

  std::map<std::string, std::set<std::string>> character_episodes;
  std::map<std::string, const Node*> character_nodes;
  std::map<std::string, std::string> scene_owner_episode;
  std::map<std::string, std::string> shot_owner_scene;

  auto episodes = direct_dependents(snapshot, series_id, NodeKind::kEpisode);
  sort_nodes(episodes);
  for (const auto* episode : episodes) {
    EpisodeContinuitySummary episode_summary;
    episode_summary.episode_id = episode->id;
    std::set<std::string> episode_characters;

    auto scenes = direct_dependents(snapshot, episode->id, NodeKind::kScene);
    sort_nodes(scenes);
    for (const auto* scene : scenes) {
      const auto [scene_owner, scene_inserted] = scene_owner_episode.emplace(scene->id.value(), episode->id.value());
      if (!scene_inserted && scene_owner->second != episode->id.value()) {
        output.issues.push_back(
            "scene " + scene->id.value() + " belongs to multiple episodes in the same series");
        continue;
      }

      episode_summary.scene_ids.push_back(scene->id);
      auto scene_characters = direct_dependencies(snapshot, scene->id, NodeKind::kCharacter);
      std::map<std::string, const Node*> inherited;
      for (const auto* character : scene_characters) inherited.emplace(character->id.value(), character);

      auto shots = direct_dependents(snapshot, scene->id, NodeKind::kShot);
      sort_nodes(shots);
      for (const auto* shot : shots) {
        const auto shot_inserted = shot_owner_scene.emplace(shot->id.value(), scene->id.value()).second;
        if (!shot_inserted) {
          output.issues.push_back(
              "shot " + shot->id.value() + " belongs to multiple scenes in the same series");
          continue;
        }

        episode_summary.shot_ids.push_back(shot->id);
        ShotContinuityBinding binding;
        binding.shot_id = shot->id;
        binding.scene_id = scene->id;
        binding.episode_id = episode->id;

        auto characters = inherited;
        for (const auto* character : direct_dependencies(snapshot, shot->id, NodeKind::kCharacter)) {
          characters[character->id.value()] = character;
        }
        for (const auto& [id, character] : characters) {
          binding.character_ids.emplace_back(id);
          episode_characters.insert(id);
          character_nodes[id] = character;
          character_episodes[id].insert(episode->id.value());
        }
        output.shots.push_back(std::move(binding));
      }
    }

    episode_summary.character_ids = ids_from_set(episode_characters);
    output.episodes.push_back(std::move(episode_summary));
  }

  for (const auto& [id, node] : character_nodes) {
    CharacterContinuityAnchor anchor;
    anchor.character_id = core::EntityId{id};
    anchor.title = node->title;
    anchor.revision = node->revision;
    anchor.approval = node->approval;
    anchor.locked = node->locked;
    anchor.stale = node->stale;
    anchor.episode_ids = ids_from_set(character_episodes[id]);
    anchor.cross_episode = anchor.episode_ids.size() > 1U;

    if (!anchor.locked) output.issues.push_back("character " + id + " is not identity-locked");
    if (anchor.stale) output.issues.push_back("character " + id + " is stale");
    if (!domain::allows_final_synthesis(anchor.approval)) {
      output.issues.push_back("character " + id + " is not approved for final synthesis");
    }
    output.characters.push_back(std::move(anchor));
  }

  if (output.episodes.empty()) output.issues.push_back("series has no episode dependencies");
  output.ready_for_final_synthesis = output.issues.empty();
  return core::Status::success();
}

}  // namespace makewatch::media
