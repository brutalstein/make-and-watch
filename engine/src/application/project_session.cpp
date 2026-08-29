#include "makewatch/application/project_session.hpp"

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

project::Event restore_commit_event(
    std::uint64_t project_revision,
    std::string detail) {
  project::Event event;
  event.type = project::EventType::kTransactionCommitted;
  event.project_revision = project_revision;
  event.detail = std::move(detail);
  return event;
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

  std::string detail{"atomic workflow restore committed: "};
  detail += std::to_string(before.graph.nodes.size());
  detail += " nodes / ";
  detail += std::to_string(before.graph.dependencies.size());
  detail += " dependencies -> ";
  detail += std::to_string(target.graph.nodes.size());
  detail += " nodes / ";
  detail += std::to_string(target.graph.dependencies.size());
  detail += " dependencies";

  std::vector<project::Event> events;
  events.reserve(1);
  events.push_back(restore_commit_event(target.project_revision, std::move(detail)));
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
