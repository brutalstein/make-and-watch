#pragma once

#include <cstddef>
#include <string>
#include <vector>

#include "makewatch/core/status.hpp"
#include "makewatch/project/event.hpp"
#include "makewatch/project/snapshot.hpp"

namespace makewatch::persistence {

enum class CommitActor {
  kUser,
  kAiDirector,
  kSystem,
};

struct CommitContext final {
  CommitActor actor{CommitActor::kSystem};
  std::string source;
  std::string plan_id;
  std::string reason;
};

struct JournalRecord final {
  project::Event event;
  CommitContext context;
};

struct LoadSnapshotResult final {
  core::Status status;
  project::ProjectSnapshot snapshot;

  [[nodiscard]] bool ok() const noexcept { return status.ok(); }
};

struct LoadJournalResult final {
  core::Status status;
  std::vector<JournalRecord> records;

  [[nodiscard]] bool ok() const noexcept { return status.ok(); }
};

class SnapshotStore {
 public:
  virtual ~SnapshotStore() = default;

  [[nodiscard]] virtual core::Status save(const project::ProjectSnapshot& snapshot) = 0;
  [[nodiscard]] virtual LoadSnapshotResult load() = 0;

  // A persistence implementation may override this to atomically commit the
  // authoritative snapshot, its append-only event journal, and commit provenance.
  [[nodiscard]] virtual core::Status save_commit(
      const project::ProjectSnapshot& snapshot,
      const std::vector<project::Event>& events,
      const CommitContext& context = {}) {
    static_cast<void>(events);
    static_cast<void>(context);
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
