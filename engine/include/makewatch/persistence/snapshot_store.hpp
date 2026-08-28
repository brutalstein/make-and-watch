#pragma once

#include <cstddef>
#include <vector>

#include "makewatch/core/status.hpp"
#include "makewatch/project/event.hpp"
#include "makewatch/project/snapshot.hpp"

namespace makewatch::persistence {

struct LoadSnapshotResult final {
  core::Status status;
  project::ProjectSnapshot snapshot;

  [[nodiscard]] bool ok() const noexcept { return status.ok(); }
};

struct LoadJournalResult final {
  core::Status status;
  std::vector<project::Event> events;

  [[nodiscard]] bool ok() const noexcept { return status.ok(); }
};

class SnapshotStore {
 public:
  virtual ~SnapshotStore() = default;

  [[nodiscard]] virtual core::Status save(const project::ProjectSnapshot& snapshot) = 0;
  [[nodiscard]] virtual LoadSnapshotResult load() = 0;

  // A persistence implementation may override this to atomically commit the
  // authoritative snapshot and its append-only event journal. The default
  // preserves compatibility for in-memory/test stores while keeping semantic
  // correctness owned by ProjectSession.
  [[nodiscard]] virtual core::Status save_commit(
      const project::ProjectSnapshot& snapshot,
      const std::vector<project::Event>& events) {
    static_cast<void>(events);
    return save(snapshot);
  }

  // Journal support is optional at the storage boundary. Production SQLite
  // persistence overrides this; lightweight test stores can remain snapshot-only.
  [[nodiscard]] virtual LoadJournalResult load_journal(std::size_t limit) {
    static_cast<void>(limit);
    return LoadJournalResult{core::Status::success(), {}};
  }
};

}  // namespace makewatch::persistence
