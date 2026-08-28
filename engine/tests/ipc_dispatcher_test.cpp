#include <cstdlib>
#include <iostream>
#include <string>

#include <nlohmann/json.hpp>

#include "makewatch/application/project_session.hpp"
#include "makewatch/core/status.hpp"
#include "makewatch/ipc/dispatcher.hpp"
#include "makewatch/persistence/snapshot_store.hpp"

namespace {

using Json = nlohmann::json;
using makewatch::application::ProjectSession;
using makewatch::core::Status;
using makewatch::ipc::Dispatcher;
using makewatch::persistence::LoadSnapshotResult;
using makewatch::persistence::SnapshotStore;
using makewatch::project::ProjectSnapshot;

void require(bool condition, const std::string& message) {
  if (!condition) {
    std::cerr << "FAILED: " << message << '\n';
    std::exit(EXIT_FAILURE);
  }
}

class FakeStore final : public SnapshotStore {
 public:
  Status save(const ProjectSnapshot& snapshot) override {
    persisted = snapshot;
    return Status::success();
  }
  LoadSnapshotResult load() override { return {Status::success(), persisted}; }
  ProjectSnapshot persisted;
};

Json call(Dispatcher& dispatcher, const Json& request) {
  return Json::parse(dispatcher.handle(request.dump()));
}

void test_protocol_and_project_roundtrip() {
  FakeStore store;
  ProjectSession session{store};
  require(session.load().ok(), "session should load");
  Dispatcher dispatcher{session};

  auto health = call(dispatcher, Json{{"protocol", 1}, {"id", "health-1"}, {"method", "health"}, {"params", Json::object()}});
  require(health["ok"].get<bool>() && health["result"]["nodeCount"] == 0,
          "health should expose native project state");

  Json commands = Json::array({
      Json{{"type", "node.create"}, {"node", Json{{"id", "character.mira"}, {"kind", "character"}, {"title", "Mira"}, {"metadata", Json{{"voice", "mira-v1"}}}}}},
      Json{{"type", "node.create"}, {"node", Json{{"id", "shot.001"}, {"kind", "shot"}, {"title", "Mirror reveal"}}}},
      Json{{"type", "dependency.add"}, {"dependent", "shot.001"}, {"dependency", "character.mira"}},
  });
  auto applied = call(dispatcher, Json{{"protocol", 1}, {"id", "apply-1"}, {"method", "project.apply"}, {"params", Json{{"commands", commands}}}});
  require(applied["ok"].get<bool>() && applied["result"]["projectRevision"] == 1,
          "project.apply should route through native session");
  require(store.persisted.project_revision == 1,
          "IPC mutation must persist before success response");

  auto snapshot = call(dispatcher, Json{{"protocol", 1}, {"id", "snapshot-1"}, {"method", "project.snapshot"}, {"params", Json::object()}});
  require(snapshot["ok"].get<bool>() && snapshot["result"]["nodes"].size() == 2 &&
              snapshot["result"]["dependencies"].size() == 1,
          "snapshot should serialize real C++ graph");

  auto impact = call(dispatcher, Json{{"protocol", 1}, {"id", "impact-1"}, {"method", "project.impact"}, {"params", Json{{"source", "character.mira"}}}});
  require(impact["ok"].get<bool>() && impact["result"]["affected"].size() == 1 &&
              impact["result"]["affected"][0] == "shot.001",
          "impact should be computed by native dependency graph");
}

void test_typed_failures() {
  FakeStore store;
  ProjectSession session{store};
  require(session.load().ok(), "session should load");
  Dispatcher dispatcher{session};

  const auto malformed = Json::parse(dispatcher.handle("not-json"));
  require(!malformed["ok"].get<bool>() && malformed["error"]["code"] == "invalid_argument",
          "malformed input should return typed protocol error");

  auto version = call(dispatcher, Json{{"protocol", 99}, {"id", "v"}, {"method", "health"}});
  require(!version["ok"].get<bool>() && version["error"]["code"] == "unsupported_version",
          "protocol mismatch should be explicit");

  auto unknown = call(dispatcher, Json{{"protocol", 1}, {"id", "u"}, {"method", "project.magic"}, {"params", Json::object()}});
  require(!unknown["ok"].get<bool>() && unknown["error"]["code"] == "not_found",
          "unknown method should be typed failure");
}

}  // namespace

int main() {
  test_protocol_and_project_roundtrip();
  test_typed_failures();
  std::cout << "ipc_dispatcher_test: all checks passed\n";
  return EXIT_SUCCESS;
}
