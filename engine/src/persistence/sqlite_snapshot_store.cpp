#include "makewatch/persistence/sqlite_snapshot_store.hpp"

#include <cstdint>
#include <limits>
#include <map>
#include <string>
#include <utility>

#include <sqlite3.h>

namespace makewatch::persistence {
namespace {

constexpr int kSchemaVersion = 1;

class Statement final {
 public:
  Statement() = default;
  ~Statement() {
    if (statement_ != nullptr) {
      sqlite3_finalize(statement_);
    }
  }

  Statement(const Statement&) = delete;
  Statement& operator=(const Statement&) = delete;

  [[nodiscard]] sqlite3_stmt** out() noexcept { return &statement_; }
  [[nodiscard]] sqlite3_stmt* get() const noexcept { return statement_; }

 private:
  sqlite3_stmt* statement_{nullptr};
};

core::Status sqlite_failure(sqlite3* db, const char* context) {
  std::string message{context};
  message += ": ";
  message += db != nullptr ? sqlite3_errmsg(db) : "SQLite database is not open";
  return core::Status::failure(core::ErrorCode::kIoError, std::move(message));
}

core::Status exec(sqlite3* db, const char* sql) {
  char* error_message = nullptr;
  const int rc = sqlite3_exec(db, sql, nullptr, nullptr, &error_message);
  if (rc == SQLITE_OK) {
    return core::Status::success();
  }

  std::string message = error_message != nullptr ? error_message : sqlite3_errmsg(db);
  sqlite3_free(error_message);
  return core::Status::failure(core::ErrorCode::kIoError, std::move(message));
}

core::Status prepare(sqlite3* db, const char* sql, Statement& statement) {
  if (sqlite3_prepare_v2(db, sql, -1, statement.out(), nullptr) != SQLITE_OK) {
    return sqlite_failure(db, "failed to prepare SQLite statement");
  }
  return core::Status::success();
}

core::Status step_done(sqlite3* db, sqlite3_stmt* statement, const char* context) {
  if (sqlite3_step(statement) != SQLITE_DONE) {
    return sqlite_failure(db, context);
  }
  sqlite3_reset(statement);
  sqlite3_clear_bindings(statement);
  return core::Status::success();
}

core::Status bind_text(sqlite3* db, sqlite3_stmt* statement, int index, const std::string& value) {
  if (value.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                 "string is too large for SQLite binding");
  }
  if (sqlite3_bind_text(statement, index, value.data(), static_cast<int>(value.size()),
                        SQLITE_TRANSIENT) != SQLITE_OK) {
    return sqlite_failure(db, "failed to bind SQLite text");
  }
  return core::Status::success();
}

std::string column_text(sqlite3_stmt* statement, int column) {
  const auto* value = sqlite3_column_text(statement, column);
  const int bytes = sqlite3_column_bytes(statement, column);
  if (value == nullptr || bytes <= 0) {
    return {};
  }
  return std::string{reinterpret_cast<const char*>(value), static_cast<std::size_t>(bytes)};
}

bool valid_node_kind(int value) {
  return value >= static_cast<int>(project::NodeKind::kSeries) &&
         value <= static_cast<int>(project::NodeKind::kGeneration);
}

bool valid_approval(int value) {
  return value >= static_cast<int>(domain::ApprovalState::kDraft) &&
         value <= static_cast<int>(domain::ApprovalState::kFailed);
}

}  // namespace

SqliteSnapshotStore::~SqliteSnapshotStore() { close(); }

core::Status SqliteSnapshotStore::open(const std::filesystem::path& path) {
  close();

  const auto utf8_path = path.u8string();
  const auto* filename = reinterpret_cast<const char*>(utf8_path.c_str());
  const int flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX;
  if (sqlite3_open_v2(filename, &db_, flags, nullptr) != SQLITE_OK) {
    const auto status = sqlite_failure(db_, "failed to open project database");
    close();
    return status;
  }

  sqlite3_busy_timeout(db_, 5000);
  if (const auto status = exec(db_, "PRAGMA foreign_keys=ON;"); !status.ok()) {
    close();
    return status;
  }
  if (const auto status = exec(db_, "PRAGMA journal_mode=WAL;"); !status.ok()) {
    close();
    return status;
  }
  if (const auto status = exec(db_, "PRAGMA synchronous=FULL;"); !status.ok()) {
    close();
    return status;
  }
  return migrate();
}

void SqliteSnapshotStore::close() noexcept {
  if (db_ != nullptr) {
    sqlite3_close_v2(db_);
    db_ = nullptr;
  }
}

core::Status SqliteSnapshotStore::migrate() {
  if (db_ == nullptr) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                 "database must be open before migration");
  }

  Statement version_statement;
  if (const auto status = prepare(db_, "PRAGMA user_version;", version_statement); !status.ok()) {
    return status;
  }
  if (sqlite3_step(version_statement.get()) != SQLITE_ROW) {
    return sqlite_failure(db_, "failed to read schema version");
  }
  const int version = sqlite3_column_int(version_statement.get(), 0);
  if (version > kSchemaVersion) {
    return core::Status::failure(core::ErrorCode::kUnsupportedVersion,
                                 "project database schema is newer than this engine");
  }
  if (version == kSchemaVersion) {
    return core::Status::success();
  }
  if (version != 0) {
    return core::Status::failure(core::ErrorCode::kUnsupportedVersion,
                                 "unsupported project database migration path");
  }

  const char* schema =
      "BEGIN IMMEDIATE;"
      "CREATE TABLE IF NOT EXISTS project_meta("
      "  key TEXT PRIMARY KEY NOT NULL,"
      "  integer_value INTEGER"
      ");"
      "CREATE TABLE IF NOT EXISTS nodes("
      "  id TEXT PRIMARY KEY NOT NULL,"
      "  kind INTEGER NOT NULL,"
      "  title TEXT NOT NULL,"
      "  revision INTEGER NOT NULL CHECK(revision > 0),"
      "  approval INTEGER NOT NULL,"
      "  locked INTEGER NOT NULL CHECK(locked IN (0,1)),"
      "  stale INTEGER NOT NULL CHECK(stale IN (0,1))"
      ");"
      "CREATE TABLE IF NOT EXISTS node_metadata("
      "  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,"
      "  key TEXT NOT NULL,"
      "  value TEXT NOT NULL,"
      "  PRIMARY KEY(node_id, key)"
      ");"
      "CREATE TABLE IF NOT EXISTS dependencies("
      "  dependent TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,"
      "  dependency TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,"
      "  PRIMARY KEY(dependent, dependency),"
      "  CHECK(dependent <> dependency)"
      ");"
      "PRAGMA user_version=1;"
      "COMMIT;";
  return exec(db_, schema);
}

core::Status SqliteSnapshotStore::save(const project::ProjectSnapshot& snapshot_value) {
  if (db_ == nullptr) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                 "database is not open");
  }
  if (snapshot_value.project_revision >
      static_cast<std::uint64_t>(std::numeric_limits<sqlite3_int64>::max())) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                 "project revision exceeds SQLite integer range");
  }

  if (const auto status = exec(db_, "BEGIN IMMEDIATE;"); !status.ok()) {
    return status;
  }
  const auto rollback = [&]() { static_cast<void>(exec(db_, "ROLLBACK;")); };

  if (const auto status = exec(db_,
                               "DELETE FROM dependencies;"
                               "DELETE FROM node_metadata;"
                               "DELETE FROM nodes;"
                               "DELETE FROM project_meta;");
      !status.ok()) {
    rollback();
    return status;
  }

  Statement node_statement;
  if (const auto status = prepare(
          db_,
          "INSERT INTO nodes(id,kind,title,revision,approval,locked,stale) VALUES(?,?,?,?,?,?,?);",
          node_statement);
      !status.ok()) {
    rollback();
    return status;
  }

  Statement metadata_statement;
  if (const auto status = prepare(
          db_, "INSERT INTO node_metadata(node_id,key,value) VALUES(?,?,?);", metadata_statement);
      !status.ok()) {
    rollback();
    return status;
  }

  for (const auto& node : snapshot_value.graph.nodes) {
    if (node.revision == 0 || node.revision >
                                  static_cast<std::uint64_t>(std::numeric_limits<sqlite3_int64>::max())) {
      rollback();
      return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                   "node revision is outside persisted range");
    }
    if (const auto status = bind_text(db_, node_statement.get(), 1, node.id.value()); !status.ok()) {
      rollback();
      return status;
    }
    sqlite3_bind_int(node_statement.get(), 2, static_cast<int>(node.kind));
    if (const auto status = bind_text(db_, node_statement.get(), 3, node.title); !status.ok()) {
      rollback();
      return status;
    }
    sqlite3_bind_int64(node_statement.get(), 4, static_cast<sqlite3_int64>(node.revision));
    sqlite3_bind_int(node_statement.get(), 5, static_cast<int>(node.approval));
    sqlite3_bind_int(node_statement.get(), 6, node.locked ? 1 : 0);
    sqlite3_bind_int(node_statement.get(), 7, node.stale ? 1 : 0);
    if (const auto status = step_done(db_, node_statement.get(), "failed to insert project node");
        !status.ok()) {
      rollback();
      return status;
    }

    for (const auto& [key, value] : node.metadata) {
      if (const auto status = bind_text(db_, metadata_statement.get(), 1, node.id.value());
          !status.ok()) {
        rollback();
        return status;
      }
      if (const auto status = bind_text(db_, metadata_statement.get(), 2, key); !status.ok()) {
        rollback();
        return status;
      }
      if (const auto status = bind_text(db_, metadata_statement.get(), 3, value); !status.ok()) {
        rollback();
        return status;
      }
      if (const auto status = step_done(db_, metadata_statement.get(), "failed to insert node metadata");
          !status.ok()) {
        rollback();
        return status;
      }
    }
  }

  Statement dependency_statement;
  if (const auto status = prepare(
          db_, "INSERT INTO dependencies(dependent,dependency) VALUES(?,?);", dependency_statement);
      !status.ok()) {
    rollback();
    return status;
  }
  for (const auto& edge : snapshot_value.graph.dependencies) {
    if (const auto status = bind_text(db_, dependency_statement.get(), 1, edge.dependent.value());
        !status.ok()) {
      rollback();
      return status;
    }
    if (const auto status = bind_text(db_, dependency_statement.get(), 2, edge.dependency.value());
        !status.ok()) {
      rollback();
      return status;
    }
    if (const auto status = step_done(db_, dependency_statement.get(),
                                      "failed to insert dependency edge");
        !status.ok()) {
      rollback();
      return status;
    }
  }

  Statement meta_statement;
  if (const auto status = prepare(
          db_, "INSERT INTO project_meta(key,integer_value) VALUES('project_revision',?);",
          meta_statement);
      !status.ok()) {
    rollback();
    return status;
  }
  sqlite3_bind_int64(meta_statement.get(), 1,
                     static_cast<sqlite3_int64>(snapshot_value.project_revision));
  if (const auto status = step_done(db_, meta_statement.get(), "failed to persist project revision");
      !status.ok()) {
    rollback();
    return status;
  }

  if (const auto status = exec(db_, "COMMIT;"); !status.ok()) {
    rollback();
    return status;
  }
  return core::Status::success();
}

LoadSnapshotResult SqliteSnapshotStore::load() {
  if (db_ == nullptr) {
    return LoadSnapshotResult{core::Status::failure(core::ErrorCode::kInvalidArgument,
                                                    "database is not open"), {}};
  }

  project::ProjectSnapshot result;
  Statement meta_statement;
  if (const auto status = prepare(
          db_, "SELECT integer_value FROM project_meta WHERE key='project_revision';", meta_statement);
      !status.ok()) {
    return LoadSnapshotResult{status, {}};
  }
  const int meta_step = sqlite3_step(meta_statement.get());
  if (meta_step == SQLITE_ROW) {
    const auto value = sqlite3_column_int64(meta_statement.get(), 0);
    if (value < 0) {
      return LoadSnapshotResult{core::Status::failure(core::ErrorCode::kCorruptData,
                                                      "negative project revision in database"), {}};
    }
    result.project_revision = static_cast<std::uint64_t>(value);
  } else if (meta_step != SQLITE_DONE) {
    return LoadSnapshotResult{sqlite_failure(db_, "failed to load project revision"), {}};
  }

  Statement node_statement;
  if (const auto status = prepare(
          db_, "SELECT id,kind,title,revision,approval,locked,stale FROM nodes ORDER BY id;",
          node_statement);
      !status.ok()) {
    return LoadSnapshotResult{status, {}};
  }

  std::map<std::string, std::size_t> node_index;
  while (true) {
    const int rc = sqlite3_step(node_statement.get());
    if (rc == SQLITE_DONE) {
      break;
    }
    if (rc != SQLITE_ROW) {
      return LoadSnapshotResult{sqlite_failure(db_, "failed to load project nodes"), {}};
    }

    const int kind_value = sqlite3_column_int(node_statement.get(), 1);
    const int approval_value = sqlite3_column_int(node_statement.get(), 4);
    const auto revision = sqlite3_column_int64(node_statement.get(), 3);
    if (!valid_node_kind(kind_value) || !valid_approval(approval_value) || revision <= 0) {
      return LoadSnapshotResult{core::Status::failure(core::ErrorCode::kCorruptData,
                                                      "invalid node enum or revision in database"), {}};
    }

    project::Node node;
    node.id = core::EntityId{column_text(node_statement.get(), 0)};
    node.kind = static_cast<project::NodeKind>(kind_value);
    node.title = column_text(node_statement.get(), 2);
    node.revision = static_cast<std::uint64_t>(revision);
    node.approval = static_cast<domain::ApprovalState>(approval_value);
    node.locked = sqlite3_column_int(node_statement.get(), 5) != 0;
    node.stale = sqlite3_column_int(node_statement.get(), 6) != 0;
    if (node.id.empty()) {
      return LoadSnapshotResult{core::Status::failure(core::ErrorCode::kCorruptData,
                                                      "empty node id in database"), {}};
    }
    node_index.emplace(node.id.value(), result.graph.nodes.size());
    result.graph.nodes.push_back(std::move(node));
  }

  Statement metadata_statement;
  if (const auto status = prepare(
          db_, "SELECT node_id,key,value FROM node_metadata ORDER BY node_id,key;", metadata_statement);
      !status.ok()) {
    return LoadSnapshotResult{status, {}};
  }
  while (true) {
    const int rc = sqlite3_step(metadata_statement.get());
    if (rc == SQLITE_DONE) {
      break;
    }
    if (rc != SQLITE_ROW) {
      return LoadSnapshotResult{sqlite_failure(db_, "failed to load node metadata"), {}};
    }
    const auto node_id = column_text(metadata_statement.get(), 0);
    const auto index_it = node_index.find(node_id);
    if (index_it == node_index.end()) {
      return LoadSnapshotResult{core::Status::failure(core::ErrorCode::kCorruptData,
                                                      "metadata references missing node"), {}};
    }
    result.graph.nodes[index_it->second].metadata[column_text(metadata_statement.get(), 1)] =
        column_text(metadata_statement.get(), 2);
  }

  Statement dependency_statement;
  if (const auto status = prepare(
          db_, "SELECT dependent,dependency FROM dependencies ORDER BY dependent,dependency;",
          dependency_statement);
      !status.ok()) {
    return LoadSnapshotResult{status, {}};
  }
  while (true) {
    const int rc = sqlite3_step(dependency_statement.get());
    if (rc == SQLITE_DONE) {
      break;
    }
    if (rc != SQLITE_ROW) {
      return LoadSnapshotResult{sqlite_failure(db_, "failed to load dependencies"), {}};
    }
    result.graph.dependencies.push_back(project::DependencyEdge{
        core::EntityId{column_text(dependency_statement.get(), 0)},
        core::EntityId{column_text(dependency_statement.get(), 1)}});
  }

  project::ProjectGraph validator;
  if (const auto status = validator.replace_from_snapshot(result.graph); !status.ok()) {
    return LoadSnapshotResult{core::Status::failure(core::ErrorCode::kCorruptData,
                                                    "persisted project graph failed validation: " +
                                                        status.message), {}};
  }
  return LoadSnapshotResult{core::Status::success(), std::move(result)};
}

}  // namespace makewatch::persistence
