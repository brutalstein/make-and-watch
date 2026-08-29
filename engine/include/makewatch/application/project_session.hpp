#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

#include "makewatch/core/status.hpp"
#include "makewatch/persistence/snapshot_store.hpp"
#include "makewatch/project/command.hpp"
#include "makewatch/project/engine.hpp"
#include "makewatch/project/impact.hpp"
#include "makewatch/project/snapshot.hpp"

namespace makewatch::application {

class ProjectSession final {
 public:
  explicit ProjectSession(persistence::SnapshotStore& store) : store_(store) {}

  [[nodiscard]] core::Status load();
  [[nodiscard]] project::CommandResult apply(
      const project::Command& command,
      const persistence::CommitContext& context = {});
  [[nodiscard]] project::CommandResult apply_batch(
      const std::vector<project::Command>& commands,
      const persistence::CommitContext& context = {});
  [[nodiscard]] project::CommandResult restore(
      const project::ProjectSnapshot& snapshot,
      std::uint64_t expected_project_revision,
      const persistence::CommitContext& context = {});
  [[nodiscard]] project::ImpactReport preview_impact(const core::EntityId& source) const;
  [[nodiscard]] project::ProjectSnapshot snapshot() const { return engine_.snapshot(); }
  [[nodiscard]] persistence::LoadJournalResult history(std::size_t limit);

  // Recovery-only primitive. Product mutation paths should use restore(),
  // which keeps project revision monotonic and journals the replacement.
  [[nodiscard]] core::Status replace(const project::ProjectSnapshot& snapshot);

  [[nodiscard]] const project::ProjectEngine& engine() const noexcept { return engine_; }

 private:
  persistence::SnapshotStore& store_;
  project::ProjectEngine engine_;
};

}  // namespace makewatch::application
