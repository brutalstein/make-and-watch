#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

#include <sqlite3.h>

#include "makewatch/persistence/sqlite_snapshot_store.hpp"
#include "makewatch/project/engine.hpp"

namespace {

using makewatch::core::EntityId;
using makewatch::persistence::SqliteSnapshotStore;
using makewatch::project::AddDependency;
using makewatch::project::Command;
using makewatch::project::CreateNode;
using makewatch::project::EventType;
using makewatch::project::Node;
using makewatch::project::NodeKind;
using makewatch::project::PatchNode;
using makewatch::project::ProjectEngine;

void require(bool condition, const std::string& message) {
  if (!condition) {
    std::cerr << "FAILED: " << message << '\n';
    std::exit(EXIT_FAILURE);
  }
}

Node make_node(const char* id, NodeKind kind, const char* title) {
  Node node;
  node.id = EntityId{id};
  node.kind = kind;
  node.title = title;
  return node;
}

std::filesystem::path temporary_database_path() {
  const auto ticks = std::chrono::steady_clock::now().time_since_epoch().count();
  return std::filesystem::temp_directory_path() /
         ("makewatch-snapshot-test-" + std::to_string(ticks) + ".db");
}

void cleanup(const std::filesystem::path& path) {
  std::error_code ignored;
  std::filesystem::remove(path, ignored);
  std::filesystem::remove(path.string() + "-wal", ignored);
  std::filesystem::remove(path.string() + "-shm", ignored);
}

void create_v1_database(const std::filesystem::path& path) {
  sqlite3* db = nullptr;
  const auto utf8_path = path.u8string();
  const auto* filename = reinterpret_cast<const char*>(utf8_path.c_str());
  require(sqlite3_open_v2(filename, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nullptr) == SQLITE_OK,
          "raw SQLite v1 fixture should open");
  const char* schema =
      "CREATE TABLE project_meta(key TEXT PRIMARY KEY NOT NULL,integer_value INTEGER);"
      "CREATE TABLE nodes(id TEXT PRIMARY KEY NOT NULL,kind INTEGER NOT NULL,title TEXT NOT NULL,"
      "revision INTEGER NOT NULL CHECK(revision > 0),approval INTEGER NOT NULL,"
      "locked INTEGER NOT NULL CHECK(locked IN (0,1)),stale INTEGER NOT NULL CHECK(stale IN (0,1)));"
      "CREATE TABLE node_metadata(node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,"
      "key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(node_id,key));"
      "CREATE TABLE dependencies(dependent TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,"
      "dependency TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,"
      "PRIMARY KEY(dependent,dependency),CHECK(dependent <> dependency));"
      "PRAGMA user_version=1;";
  char* error = nullptr;
  const int rc = sqlite3_exec(db, schema, nullptr, nullptr, &error);
  if (rc != SQLITE_OK) {
    std::cerr << "SQLite fixture error: " << (error != nullptr ? error : "unknown") << '\n';
    sqlite3_free(error);
  }
  require(rc == SQLITE_OK, "raw SQLite v1 schema should be created");
  sqlite3_close_v2(db);
}

void test_sqlite_roundtrip_journal_and_overwrite() {
  const auto path = temporary_database_path();
  cleanup(path);

  ProjectEngine engine;
  auto character = make_node("character.mira", NodeKind::kCharacter, "Mira");
  character.metadata["voice"] = "mira-v1";
  const std::vector<Command> setup{
      CreateNode{character},
      CreateNode{make_node("shot.001", NodeKind::kShot, "Mirror reveal")},
      AddDependency{EntityId{"shot.001"}, EntityId{"character.mira"}},
  };
  const auto setup_result = engine.apply_batch(setup);
  require(setup_result.ok(), "project setup should commit");

  SqliteSnapshotStore store;
  require(store.open(path).ok(), "SQLite project store should open and migrate");
  require(store.save_commit(engine.snapshot(), setup_result.events).ok(),
          "first snapshot and journal should persist atomically");

  auto loaded = store.load();
  require(loaded.ok(), "persisted snapshot should load");
  ProjectEngine restored;
  require(restored.hydrate(loaded.snapshot).ok(), "loaded snapshot should hydrate engine");
  require(restored.graph().node_count() == 2 && restored.graph().dependency_count() == 1,
          "roundtrip should preserve graph topology");
  const auto* restored_character = restored.graph().find(EntityId{"character.mira"});
  require(restored_character != nullptr &&
              restored_character->metadata.at("voice") == "mira-v1",
          "roundtrip should preserve metadata");

  auto history = store.load_journal(32);
  require(history.ok() && history.events.size() == setup_result.events.size(),
          "journal should preserve every setup event");
  require(!history.events.empty() && history.events.back().type == EventType::kTransactionCommitted,
          "journal should preserve transaction event ordering");

  PatchNode edit;
  edit.id = EntityId{"character.mira"};
  edit.metadata_updates["voice"] = "mira-v2";
  const auto edit_result = engine.apply(edit);
  require(edit_result.ok(), "second project revision should commit");
  require(store.save_commit(engine.snapshot(), edit_result.events).ok(),
          "later snapshot and events should atomically replace state and append history");

  loaded = store.load();
  require(loaded.ok() && loaded.snapshot.project_revision == engine.project_revision(),
          "latest project revision should survive overwrite");
  ProjectEngine second_restore;
  require(second_restore.hydrate(loaded.snapshot).ok(), "latest snapshot should hydrate");
  const auto* latest_character = second_restore.graph().find(EntityId{"character.mira"});
  require(latest_character != nullptr && latest_character->metadata.at("voice") == "mira-v2",
          "latest snapshot data should replace earlier state");

  history = store.load_journal(64);
  require(history.ok() && history.events.size() == setup_result.events.size() + edit_result.events.size(),
          "journal should be append-only across snapshot replacement");
  require(history.events.front().project_revision == engine.project_revision(),
          "newest revision should be returned first while event order remains stable within it");

  store.close();
  require(store.open(path).ok(), "journal database should reopen");
  history = store.load_journal(64);
  require(history.ok() && !history.events.empty(), "journal should survive process-style reopen");
  store.close();
  cleanup(path);
}

void test_v1_database_migrates_to_journal_schema() {
  const auto path = temporary_database_path();
  cleanup(path);
  create_v1_database(path);

  SqliteSnapshotStore store;
  require(store.open(path).ok(), "schema v1 database should migrate in place to v2");

  ProjectEngine engine;
  const auto result = engine.apply(Command{CreateNode{make_node("scene.legacy", NodeKind::kScene, "Legacy")}});
  require(result.ok(), "migration fixture command should commit");
  require(store.save_commit(engine.snapshot(), result.events).ok(),
          "migrated v1 database should accept atomic snapshot+journal commit");
  const auto history = store.load_journal(16);
  require(history.ok() && history.events.size() == result.events.size(),
          "migrated database should expose appended journal events");

  store.close();
  cleanup(path);
}

void test_store_requires_open_database() {
  SqliteSnapshotStore store;
  ProjectEngine engine;
  require(!store.save(engine.snapshot()).ok(), "closed store must reject save");
  require(!store.load().ok(), "closed store must reject load");
  require(!store.load_journal(8).ok(), "closed store must reject journal load");
}

}  // namespace

int main() {
  test_sqlite_roundtrip_journal_and_overwrite();
  test_v1_database_migrates_to_journal_schema();
  test_store_requires_open_database();
  std::cout << "sqlite_snapshot_store_test: all checks passed\n";
  return EXIT_SUCCESS;
}
