#pragma once

#include <filesystem>

#include "makewatch/core/status.hpp"
#include "makewatch/persistence/snapshot_store.hpp"

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
  [[nodiscard]] LoadSnapshotResult load() override;

 private:
  [[nodiscard]] core::Status migrate();

  sqlite3* db_{nullptr};
};

}  // namespace makewatch::persistence
