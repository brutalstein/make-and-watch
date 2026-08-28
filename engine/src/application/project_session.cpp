#include "makewatch/application/project_session.hpp"

#include <utility>

namespace makewatch::application {

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

project::CommandResult ProjectSession::apply(const project::Command& command) {
  return apply_batch(std::vector<project::Command>{command});
}

project::CommandResult ProjectSession::apply_batch(const std::vector<project::Command>& commands) {
  project::ProjectEngine staged = engine_;
  auto result = staged.apply_batch(commands);
  if (!result.ok()) {
    return result;
  }

  if (const auto status = store_.save_commit(staged.snapshot(), result.events); !status.ok()) {
    return project::CommandResult{status, engine_.project_revision(), {}};
  }

  engine_ = std::move(staged);
  return result;
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
