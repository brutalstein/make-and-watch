#include "makewatch/media/video_pipeline.hpp"

#include <algorithm>
#include <cerrno>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <map>
#include <set>
#include <string>
#include <system_error>
#include <utility>
#include <vector>

#include "makewatch/domain/approval.hpp"
#include "makewatch/media/series_continuity.hpp"
#include "makewatch/project/node.hpp"

namespace makewatch::media {
namespace {

using project::Node;
using project::NodeKind;

constexpr std::uint32_t kMaxVideoDimension = 16'384U;
constexpr double kMaxFramesPerSecond = 240.0;
constexpr std::size_t kMaxGenerationStrategyLength = 128U;

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

double duration_seconds(const Node& shot) {
  const auto iterator = shot.metadata.find("durationSeconds");
  if (iterator == shot.metadata.end() || iterator->second.empty()) return 0.0;
  char* end = nullptr;
  errno = 0;
  const auto value = std::strtod(iterator->second.c_str(), &end);
  if (errno == ERANGE || end == iterator->second.c_str() || *end != '\0' || !std::isfinite(value) || value <= 0.0) {
    return 0.0;
  }
  return value;
}

std::string generation_strategy(const Node& shot) {
  const auto iterator = shot.metadata.find("generationStrategy");
  return iterator == shot.metadata.end() ? std::string{} : iterator->second;
}

void append_final_state_issues(const Node& node, std::string_view label, std::vector<std::string>& issues) {
  if (node.stale) issues.push_back(std::string{label} + " " + node.id.value() + " is stale");
  if (!domain::allows_final_synthesis(node.approval)) {
    issues.push_back(std::string{label} + " " + node.id.value() + " is not approved for final synthesis");
  }
}

}  // namespace

core::Status VideoPipelineCompiler::compile(
    const project::ProjectSnapshot& snapshot,
    const core::EntityId& episode_id,
    const VideoProfile& profile,
    VideoRenderPlan& output) const {
  output = {};
  if (profile.width == 0U || profile.height == 0U ||
      profile.width > kMaxVideoDimension || profile.height > kMaxVideoDimension ||
      !std::isfinite(profile.frames_per_second) || profile.frames_per_second <= 0.0 ||
      profile.frames_per_second > kMaxFramesPerSecond) {
    return core::Status::failure(
        core::ErrorCode::kInvalidArgument,
        "video profile dimensions and frame rate must be finite, positive, and bounded");
  }

  const auto* episode = find_node(snapshot, episode_id);
  if (episode == nullptr) return core::Status::failure(core::ErrorCode::kNotFound, "video episode was not found");
  if (episode->kind != NodeKind::kEpisode) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument, "video pipeline source must be an episode node");
  }

  auto series_dependencies = direct_dependencies(snapshot, episode_id, NodeKind::kSeries);
  if (series_dependencies.size() != 1U) {
    return core::Status::failure(
        core::ErrorCode::kInvalidArgument,
        "episode must depend on exactly one series before video compilation");
  }
  const auto* series = series_dependencies.front();

  output.project_revision = snapshot.project_revision;
  output.episode_id = episode_id;
  output.profile = profile;
  append_final_state_issues(*episode, "episode", output.issues);

  SeriesContinuityManifest manifest;
  SeriesContinuityCompiler continuity_compiler;
  const auto continuity_status = continuity_compiler.compile(snapshot, series->id, manifest);
  if (!continuity_status.ok()) return continuity_status;

  std::map<std::string, std::vector<core::EntityId>> shot_characters;
  std::set<std::string> episode_characters;
  for (const auto& binding : manifest.shots) {
    if (!(binding.episode_id == episode_id)) continue;
    shot_characters[binding.shot_id.value()] = binding.character_ids;
    for (const auto& character_id : binding.character_ids) episode_characters.insert(character_id.value());
  }
  for (const auto& id : episode_characters) output.continuity_characters.emplace_back(id);

  auto scenes = direct_dependents(snapshot, episode_id, NodeKind::kScene);
  sort_nodes(scenes);
  std::vector<std::string> composite_tasks;
  std::set<std::string> seen_shots;
  std::size_t shot_count = 0U;

  for (const auto* scene : scenes) {
    append_final_state_issues(*scene, "scene", output.issues);
    auto shots = direct_dependents(snapshot, scene->id, NodeKind::kShot);
    sort_nodes(shots);
    if (shots.empty()) output.issues.push_back("scene " + scene->id.value() + " has no shot dependencies");

    for (const auto* shot : shots) {
      const auto [_, inserted] = seen_shots.insert(shot->id.value());
      if (!inserted) {
        output.issues.push_back("shot " + shot->id.value() + " belongs to multiple scenes in the compiled episode");
        continue;
      }
      ++shot_count;

      const auto strategy = generation_strategy(*shot);
      const auto duration = duration_seconds(*shot);
      if (strategy.empty()) {
        output.issues.push_back("shot " + shot->id.value() + " has no explicit generationStrategy");
      } else if (strategy.size() > kMaxGenerationStrategyLength) {
        output.issues.push_back("shot " + shot->id.value() + " generationStrategy exceeds the bounded contract");
      }
      if (duration <= 0.0) output.issues.push_back("shot " + shot->id.value() + " has no valid finite durationSeconds");
      append_final_state_issues(*shot, "shot", output.issues);

      VideoRenderTask synthesis;
      synthesis.id = "shot/" + shot->id.value() + "/synthesize";
      synthesis.kind = VideoRenderTaskKind::kSynthesizeShot;
      synthesis.entity_id = shot->id;
      synthesis.generation_strategy = strategy;
      synthesis.duration_seconds = duration;
      synthesis.continuity_characters = shot_characters[shot->id.value()];
      output.tasks.push_back(std::move(synthesis));

      VideoRenderTask composite;
      composite.id = "shot/" + shot->id.value() + "/composite";
      composite.kind = VideoRenderTaskKind::kCompositeShot;
      composite.entity_id = shot->id;
      composite.duration_seconds = duration;
      composite.depends_on.push_back("shot/" + shot->id.value() + "/synthesize");
      composite.continuity_characters = shot_characters[shot->id.value()];
      composite_tasks.push_back(composite.id);
      output.tasks.push_back(std::move(composite));

      output.total_duration_seconds += duration;
      if (!std::isfinite(output.total_duration_seconds)) {
        return core::Status::failure(core::ErrorCode::kInvalidArgument, "episode duration overflowed during video compilation");
      }
    }
  }

  VideoRenderTask assembly;
  assembly.id = "episode/" + episode_id.value() + "/assemble";
  assembly.kind = VideoRenderTaskKind::kAssembleEpisode;
  assembly.entity_id = episode_id;
  assembly.duration_seconds = output.total_duration_seconds;
  assembly.depends_on = std::move(composite_tasks);
  output.tasks.push_back(std::move(assembly));

  if (scenes.empty()) output.issues.push_back("episode has no scene dependencies");
  if (shot_count == 0U) output.issues.push_back("episode has no shot dependencies");

  for (const auto& anchor : manifest.characters) {
    const auto used = std::find_if(
        output.continuity_characters.begin(), output.continuity_characters.end(),
        [&anchor](const core::EntityId& id) { return id == anchor.character_id; });
    if (used == output.continuity_characters.end()) continue;
    if (!anchor.locked || anchor.stale || !domain::allows_final_synthesis(anchor.approval)) {
      output.issues.push_back("continuity anchor " + anchor.character_id.value() + " is not ready for final synthesis");
    }
  }

  output.ready_for_final_synthesis = output.issues.empty();
  return core::Status::success();
}

}  // namespace makewatch::media
