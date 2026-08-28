#pragma once

#include <cstddef>
#include <filesystem>
#include <vector>

#include "makewatch/core/status.hpp"
#include "makewatch/persistence/snapshot_store.hpp"
#include "makewatch/project/event.hpp"
#include "makewatch/project/graph.hpp"

struct sqlite3;

namespace makewatch::persistence {

class SqliteSnapshotStore final : public SnapshotStore {
 public:
  SqliteSnapshotStore() = default;
  ~SqliteSnapshotStore() override;

  SqliteSnapshotStore(const SqliteSnapshotStore&) = delete;
  SqliteSnapshotStore& operator=(const SqliteSnapshotStore&) = delete;
  SqliteSnapshotStore(SqliteSnapshotStore&&) = delete;
  SqliteSnapshotStore& operator=(SqliteSnapshotStore&&) = delete;

  [[nodiscard]] core::Status open(const std::filesystem::path& path);
  void close() noexcept;
  [[nodiscard]] bool is_open() const noexcept { return db_ != nullptr; }

  [[nodiscard]] core::Status save(const project::ProjectSnapshot& snapshot) override;
  [[nodiscard]] core::Status save_commit(
      const project::ProjectSnapshot& snapshot,
      const std::vector<project::Event>& events,
      const CommitContext& context) override {
    static_cast<void>(context);
    return save_commit(snapshot, events);
  }
  [[nodiscard]] core::Status save_commit(
      const project::ProjectSnapshot& snapshot,
      const std::vector<project::Event>& events);
  [[nodiscard]] LoadSnapshotResult load() override;
  [[nodiscard]] LoadJournalResult load_journal(std::size_t limit) override;

 private:
  [[nodiscard]] core::Status migrate();

  sqlite3* db_{nullptr};
};

}  // namespace makewatch::persistence
