#include "makewatch/project/engine.hpp"

#include <algorithm>
#include <type_traits>
#include <utility>

namespace makewatch::project {
namespace {

Event make_event(EventType type, const core::EntityId& entity, std::string detail = {}) {
  Event event;
  event.type = type;
  event.entity_id = entity;
  event.detail = std::move(detail);
  return event;
}

void append_invalidation_event(std::vector<Event>& events, const core::EntityId& source,
                               std::vector<core::EntityId> affected) {
  if (affected.empty()) {
    return;
  }
  auto event = make_event(EventType::kDependentsInvalidated, source,
                          "dependent project nodes require refresh");
  event.affected = std::move(affected);
  events.push_back(std::move(event));
}

}  // namespace

core::Status ProjectEngine::check_revision(
    const Node& node, const std::optional<std::uint64_t>& expected) {
  if (expected.has_value() && node.revision != *expected) {
    return core::Status::failure(core::ErrorCode::kRevisionConflict,
                                 "node revision does not match expected revision");
  }
  return core::Status::success();
}

CommandResult ProjectEngine::apply(const Command& command) {
  return apply_batch(std::vector<Command>{command});
}

CommandResult ProjectEngine::apply_batch(const std::vector<Command>& commands) {
  if (commands.empty()) {
    return CommandResult{core::Status::failure(core::ErrorCode::kInvalidArgument,
                                               "transaction must contain at least one command"),
                         project_revision_, {}};
  }

  ProjectGraph staged = graph_;
  std::vector<Event> staged_events;
  for (const auto& command : commands) {
    const auto status = apply_one(staged, command, staged_events);
    if (!status.ok()) {
      return CommandResult{status, project_revision_, {}};
    }
  }

  ++project_revision_;
  for (auto& event : staged_events) {
    event.project_revision = project_revision_;
  }

  auto committed = make_event(EventType::kTransactionCommitted, core::EntityId{},
                              "atomic project transaction committed");
  committed.project_revision = project_revision_;
  staged_events.push_back(std::move(committed));

  graph_ = std::move(staged);
  event_log_.insert(event_log_.end(), staged_events.begin(), staged_events.end());
  return CommandResult{core::Status::success(), project_revision_, std::move(staged_events)};
}

ImpactReport ProjectEngine::preview_impact(const core::EntityId& source) const {
  if (graph_.find(source) == nullptr) {
    return ImpactReport{core::Status::failure(core::ErrorCode::kNotFound,
                                              "impact source node does not exist"),
                        {}, {}, {}};
  }

  ImpactReport report;
  report.status = core::Status::success();
  report.affected = graph_.dependent_closure(source);
  for (const auto& id : report.affected) {
    if (const auto* node = graph_.find(id); node != nullptr) {
      if (node->locked) {
        report.locked.push_back(id);
      }
      if (node->stale) {
        report.already_stale.push_back(id);
      }
    }
  }
  return report;
}

ProjectSnapshot ProjectEngine::snapshot() const {
  return ProjectSnapshot{project_revision_, graph_.snapshot()};
}

core::Status ProjectEngine::hydrate(const ProjectSnapshot& snapshot_value) {
  if (project_revision_ != 0 || graph_.node_count() != 0 || !event_log_.empty()) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                 "hydrate is only allowed on a pristine engine");
  }
  ProjectGraph staged;
  if (const auto status = staged.replace_from_snapshot(snapshot_value.graph); !status.ok()) {
    return status;
  }
  graph_ = std::move(staged);
  project_revision_ = snapshot_value.project_revision;
  return core::Status::success();
}

core::Status ProjectEngine::apply_one(ProjectGraph& graph, const Command& command,
                                      std::vector<Event>& events) {
  return std::visit(
      [&](const auto& value) -> core::Status {
        using T = std::decay_t<decltype(value)>;

        if constexpr (std::is_same_v<T, CreateNode>) {
          Node node = value.node;
          if (node.revision != 0) {
            return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                         "new nodes must start at revision zero");
          }
          node.revision = 1;
          const auto id = node.id;
          const auto status = graph.insert(std::move(node));
          if (status.ok()) {
            events.push_back(make_event(EventType::kNodeCreated, id));
          }
          return status;
        } else if constexpr (std::is_same_v<T, PatchNode>) {
          auto* node = graph.find_mutable(value.id);
          if (node == nullptr) {
            return core::Status::failure(core::ErrorCode::kNotFound, "node does not exist");
          }
          if (const auto revision_status = check_revision(*node, value.expected_revision);
              !revision_status.ok()) {
            return revision_status;
          }
          if (node->locked) {
            return core::Status::failure(core::ErrorCode::kLocked, "node is locked");
          }
          if (value.approval.has_value() &&
              *value.approval == domain::ApprovalState::kApproved && node->stale) {
            return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                         "stale node cannot be approved before refresh");
          }

          bool changed = false;
          bool content_changed = false;
          bool approval_changed = false;
          if (value.title.has_value() && node->title != *value.title) {
            node->title = *value.title;
            changed = true;
            content_changed = true;
          }
          for (const auto& [key, metadata_value] : value.metadata_updates) {
            const auto it = node->metadata.find(key);
            if (it == node->metadata.end() || it->second != metadata_value) {
              node->metadata[key] = metadata_value;
              changed = true;
              content_changed = true;
            }
          }
          for (const auto& key : value.metadata_removals) {
            if (node->metadata.erase(key) > 0) {
              changed = true;
              content_changed = true;
            }
          }
          if (value.approval.has_value() && node->approval != *value.approval) {
            node->approval = *value.approval;
            changed = true;
            approval_changed = true;
          }

          if (!changed) {
            return core::Status::success();
          }

          ++node->revision;
          events.push_back(make_event(EventType::kNodeUpdated, value.id));
          if (approval_changed) {
            events.push_back(make_event(EventType::kApprovalChanged, value.id));
          }
          if (content_changed) {
            auto affected = graph.dependent_closure(value.id);
            affected = graph.mark_stale(affected);
            append_invalidation_event(events, value.id, std::move(affected));
          }
          return core::Status::success();
        } else if constexpr (std::is_same_v<T, SetLock>) {
          auto* node = graph.find_mutable(value.id);
          if (node == nullptr) {
            return core::Status::failure(core::ErrorCode::kNotFound, "node does not exist");
          }
          if (const auto revision_status = check_revision(*node, value.expected_revision);
              !revision_status.ok()) {
            return revision_status;
          }
          if (node->locked == value.locked) {
            return core::Status::success();
          }
          node->locked = value.locked;
          ++node->revision;
          events.push_back(make_event(EventType::kLockChanged, value.id,
                                      value.locked ? "node locked" : "node unlocked"));
          return core::Status::success();
        } else if constexpr (std::is_same_v<T, MarkFresh>) {
          auto* node = graph.find_mutable(value.id);
          if (node == nullptr) {
            return core::Status::failure(core::ErrorCode::kNotFound, "node does not exist");
          }
          if (const auto revision_status = check_revision(*node, value.expected_revision);
              !revision_status.ok()) {
            return revision_status;
          }
          if (!node->stale) {
            return core::Status::success();
          }
          node->stale = false;
          ++node->revision;
          events.push_back(make_event(EventType::kFreshnessChanged, value.id, "node refreshed"));
          return core::Status::success();
        } else if constexpr (std::is_same_v<T, AddDependency>) {
          auto* dependent = graph.find_mutable(value.dependent);
          if (dependent == nullptr || graph.find(value.dependency) == nullptr) {
            return core::Status::failure(core::ErrorCode::kNotFound,
                                         "both dependency endpoints must exist");
          }
          if (dependent->locked) {
            return core::Status::failure(core::ErrorCode::kLocked,
                                         "locked node dependency topology cannot change");
          }
          const auto before = graph.dependencies_of(value.dependent).size();
          const auto status = graph.add_dependency(value.dependent, value.dependency);
          if (!status.ok()) {
            return status;
          }
          if (graph.dependencies_of(value.dependent).size() == before) {
            return core::Status::success();
          }
          ++dependent->revision;
          dependent->stale = true;
          auto affected = graph.dependent_closure(value.dependent);
          auto changed = graph.mark_stale(affected);
          changed.insert(changed.begin(), value.dependent);
          events.push_back(make_event(EventType::kDependencyAdded, value.dependent));
          append_invalidation_event(events, value.dependent, std::move(changed));
          return core::Status::success();
        } else if constexpr (std::is_same_v<T, RemoveDependency>) {
          auto* dependent = graph.find_mutable(value.dependent);
          if (dependent == nullptr || graph.find(value.dependency) == nullptr) {
            return core::Status::failure(core::ErrorCode::kNotFound,
                                         "both dependency endpoints must exist");
          }
          if (dependent->locked) {
            return core::Status::failure(core::ErrorCode::kLocked,
                                         "locked node dependency topology cannot change");
          }
          const auto status = graph.remove_dependency(value.dependent, value.dependency);
          if (!status.ok()) {
            return status;
          }
          ++dependent->revision;
          dependent->stale = true;
          auto affected = graph.dependent_closure(value.dependent);
          auto changed = graph.mark_stale(affected);
          changed.insert(changed.begin(), value.dependent);
          events.push_back(make_event(EventType::kDependencyRemoved, value.dependent));
          append_invalidation_event(events, value.dependent, std::move(changed));
          return core::Status::success();
        } else if constexpr (std::is_same_v<T, RemoveNode>) {
          const auto* existing = graph.find(value.id);
          if (existing == nullptr) {
            return core::Status::failure(core::ErrorCode::kNotFound, "node does not exist");
          }
          if (const auto revision_status = check_revision(*existing, value.expected_revision);
              !revision_status.ok()) {
            return revision_status;
          }
          if (existing->locked) {
            return core::Status::failure(core::ErrorCode::kLocked, "node is locked");
          }
          auto affected = graph.dependent_closure(value.id);
          const auto status = graph.erase(value.id);
          if (!status.ok()) {
            return status;
          }
          affected = graph.mark_stale(affected);
          auto event = make_event(EventType::kNodeRemoved, value.id);
          event.affected = affected;
          events.push_back(std::move(event));
          append_invalidation_event(events, value.id, std::move(affected));
          return core::Status::success();
        }

        return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                     "unsupported project command");
      },
      command);
}

}  // namespace makewatch::project
