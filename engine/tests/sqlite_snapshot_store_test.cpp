#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

#include "makewatch/persistence/sqlite_snapshot_store.hpp"
#include "makewatch/project/engine.hpp"

namespace {

using makewatch::core::EntityId;
using makewatch::persistence::SqliteSnapshotStore;
using makewatch::project::AddDependency;
using makewatch::project::Command;
using makewatch::project::CreateNode;
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

void test_sqlite_roundtrip_and_overwrite() {
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
  require(engine.apply_batch(setup).ok(), "project setup should commit");

  SqliteSnapshotStore store;
  require(store.open(path).ok(), "SQLite project store should open and migrate");
  require(store.save(engine.snapshot()).ok(), "first snapshot should persist");

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

  PatchNode edit;
  edit.id = EntityId{"character.mira"};
  edit.metadata_updates["voice"] = "mira-v2";
  require(engine.apply(edit).ok(), "second project revision should commit");
  require(store.save(engine.snapshot()).ok(), "later snapshot should atomically replace state");

  loaded = store.load();
  require(loaded.ok() && loaded.snapshot.project_revision == engine.project_revision(),
          "latest project revision should survive overwrite");
  ProjectEngine second_restore;
  require(second_restore.hydrate(loaded.snapshot).ok(), "latest snapshot should hydrate");
  const auto* latest_character = second_restore.graph().find(EntityId{"character.mira"});
  require(latest_character != nullptr && latest_character->metadata.at("voice") == "mira-v2",
          "latest snapshot data should replace earlier state");

  store.close();
  cleanup(path);
}

void test_store_requires_open_database() {
  SqliteSnapshotStore store;
  ProjectEngine engine;
  require(!store.save(engine.snapshot()).ok(), "closed store must reject save");
  require(!store.load().ok(), "closed store must reject load");
}

}  // namespace

int main() {
  test_sqlite_roundtrip_and_overwrite();
  test_store_requires_open_database();
  std::cout << "sqlite_snapshot_store_test: all checks passed\n";
  return EXIT_SUCCESS;
}
