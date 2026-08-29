#include "makewatch/application/project_session.hpp"

#include <algorithm>
#include <string>
#include <string_view>
#include <utility>

namespace makewatch::application {
namespace {

const char* actor_name(persistence::CommitActor actor) noexcept {
  switch (actor) {
    case persistence::CommitActor::kUser: return "user";
    case persistence::CommitActor::kAiDirector: return "ai_director";
    case persistence::CommitActor::kSystem: return "system";
  }
  return "system";
}

std::string escape_field(std::string_view value) {
  std::string result;
  result.reserve(value.size());
  for (const char character : value) {
    if (character == '\\' || character == '|' || character == '=') result.push_back('\\');
    result.push_back(character);
  }
  return result;
}

std::string provenance_detail(
    const persistence::CommitContext& context,
    std::string_view original_detail) {
  std::string detail{"mwctx1|actor="};
  detail += actor_name(context.actor);
  detail += "|source=";
  detail += escape_field(context.source);
  detail += "|plan=";
  detail += escape_field(context.plan_id);
  detail += "|reason=";
  detail += escape_field(context.reason);
  detail += "|event=";
  detail += escape_field(original_detail);
  return detail;
}

void attach_commit_context(
    std::vector<project::Event>& events,
    const persistence::CommitContext& context) {
  for (auto iterator = events.rbegin(); iterator != events.rend(); ++iterator) {
    if (iterator->type != project::EventType::kTransactionCommitted) continue;
    iterator->detail = provenance_detail(context, iterator->detail);
    return;
  }
}

project::Event restore_event(
    project::EventType type,
    const core::EntityId& entity,
    std::uint64_t project_revision,
    std::string detail) {
  project::Event event;
  event.type = type;
  event.entity_id = entity;
  event.project_revision = project_revision;
  event.detail = std::move(detail);
  return event;
}

bool same_node(const project::Node& left, const project::Node& right) {
  return left.id == right.id && left.kind == right.kind && left.title == right.title &&
         left.metadata == right.metadata && left.revision == right.revision &&
         left.approval == right.approval && left.locked == right.locked &&
         left.stale == right.stale;
}

const project::Node* find_node(
    const project::GraphSnapshot& graph,
    const core::EntityId& id) {
  const auto iterator = std::find_if(
      graph.nodes.begin(), graph.nodes.end(),
      [&](const project::Node& node) { return node.id == id; });
  return iterator == graph.nodes.end() ? nullptr : &*iterator;
}

bool has_dependency(
    const project::GraphSnapshot& graph,
    const project::DependencyEdge& edge) {
  return std::any_of(
      graph.dependencies.begin(), graph.dependencies.end(),
      [&](const project::DependencyEdge& candidate) {
        return candidate.dependent == edge.dependent && candidate.dependency == edge.dependency;
      });
}

std::vector<project::Event> restore_events(
    const project::ProjectSnapshot& before,
    const project::ProjectSnapshot& after) {
  std::vector<project::Event> events;
  events.reserve(
      before.graph.nodes.size() + after.graph.nodes.size() +
      before.graph.dependencies.size() + after.graph.dependencies.size() + 1);

  for (const auto& edge : before.graph.dependencies) {
    if (has_dependency(after.graph, edge)) continue;
    events.push_back(restore_event(
        project::EventType::kDependencyRemoved,
        edge.dependent,
        after.project_revision,
        "workflow restore removed dependency " + edge.dependency.value()));
  }

  for (const auto& node : before.graph.nodes) {
    if (find_node(after.graph, node.id) != nullptr) continue;
    events.push_back(restore_event(
        project::EventType::kNodeRemoved,
        node.id,
        after.project_revision,
        "workflow restore removed node"));
  }

  for (const auto& node : after.graph.nodes) {
    const auto* previous = find_node(before.graph, node.id);
    if (previous == nullptr) {
      events.push_back(restore_event(
          project::EventType::kNodeCreated,
          node.id,
          after.project_revision,
          "workflow restore created node"));
      continue;
    }
    if (same_node(*previous, node)) continue;

    events.push_back(restore_event(
        project::EventType::kNodeUpdated,
        node.id,
        after.project_revision,
        "workflow restore replaced node state"));
    if (previous->approval != node.approval) {
      events.push_back(restore_event(
          project::EventType::kApprovalChanged,
          node.id,
          after.project_revision,
          "workflow restore changed approval"));
    }
    if (previous->locked != node.locked) {
      events.push_back(restore_event(
          project::EventType::kLockChanged,
          node.id,
          after.project_revision,
          "workflow restore changed lock state"));
    }
    if (previous->stale != node.stale) {
      events.push_back(restore_event(
          project::EventType::kFreshnessChanged,
          node.id,
          after.project_revision,
          "workflow restore changed freshness"));
    }
  }

  for (const auto& edge : after.graph.dependencies) {
    if (has_dependency(before.graph, edge)) continue;
    events.push_back(restore_event(
        project::EventType::kDependencyAdded,
        edge.dependent,
        after.project_revision,
        "workflow restore added dependency " + edge.dependency.value()));
  }

  events.push_back(restore_event(
      project::EventType::kTransactionCommitted,
      core::EntityId{},
      after.project_revision,
      "atomic workflow restore committed"));
  return events;
}

}  // namespace

core::Status ProjectSession::load() {
  auto loaded = store_.load();
  if (!loaded.ok()) {
    return loaded.status;
  }

  project::ProjectEngine staged;
  if (const auto status = staged.hydrate(loaded.snapshot); !status.ok()) {
    return status;
  }
  engine_ = std::move(staged);
  return core::Status::success();
}

project::CommandResult ProjectSession::apply(
    const project::Command& command,
    const persistence::CommitContext& context) {
  return apply_batch(std::vector<project::Command>{command}, context);
}

project::CommandResult ProjectSession::apply_batch(
    const std::vector<project::Command>& commands,
    const persistence::CommitContext& context) {
  project::ProjectEngine staged = engine_;
  auto result = staged.apply_batch(commands);
  if (!result.ok()) {
    return result;
  }

  attach_commit_context(result.events, context);
  if (const auto status = store_.save_commit(staged.snapshot(), result.events, context); !status.ok()) {
    return project::CommandResult{status, engine_.project_revision(), {}};
  }

  engine_ = std::move(staged);
  return result;
}

project::CommandResult ProjectSession::restore(
    const project::ProjectSnapshot& snapshot_value,
    std::uint64_t expected_project_revision,
    const persistence::CommitContext& context) {
  if (engine_.project_revision() != expected_project_revision) {
    return project::CommandResult{
        core::Status::failure(
            core::ErrorCode::kRevisionConflict,
            "project revision does not match expected revision for workflow restore"),
        engine_.project_revision(),
        {}};
  }

  const auto before = engine_.snapshot();
  project::ProjectSnapshot target = snapshot_value;
  target.project_revision = engine_.project_revision() + 1;

  project::ProjectEngine staged;
  if (const auto status = staged.hydrate(target); !status.ok()) {
    return project::CommandResult{status, engine_.project_revision(), {}};
  }

  auto events = restore_events(before, staged.snapshot());
  attach_commit_context(events, context);
  if (const auto status = store_.save_commit(staged.snapshot(), events, context); !status.ok()) {
    return project::CommandResult{status, engine_.project_revision(), {}};
  }

  engine_ = std::move(staged);
  return project::CommandResult{
      core::Status::success(), engine_.project_revision(), std::move(events)};
}

project::ImpactReport ProjectSession::preview_impact(const core::EntityId& source) const {
  return engine_.preview_impact(source);
}

persistence::LoadJournalResult ProjectSession::history(std::size_t limit) {
  return store_.load_journal(limit);
}

core::Status ProjectSession::replace(const project::ProjectSnapshot& snapshot_value) {
  project::ProjectEngine staged;
  if (const auto status = staged.hydrate(snapshot_value); !status.ok()) {
    return status;
  }
  if (const auto status = store_.save(staged.snapshot()); !status.ok()) {
    return status;
  }
  engine_ = std::move(staged);
  return core::Status::success();
}

}  // namespace makewatch::application
