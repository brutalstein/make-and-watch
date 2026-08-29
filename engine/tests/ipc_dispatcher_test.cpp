#include <algorithm>
#include <cstddef>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

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
using makewatch::persistence::CommitContext;
using makewatch::persistence::LoadJournalResult;
using makewatch::persistence::LoadSnapshotResult;
using makewatch::persistence::SnapshotStore;
using makewatch::project::Event;
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

  Status save_commit(
      const ProjectSnapshot& snapshot,
      const std::vector<Event>& events,
      const CommitContext& context) override {
    persisted = snapshot;
    last_context = context;
    journal.insert(journal.end(), events.begin(), events.end());
    return Status::success();
  }

  LoadSnapshotResult load() override { return {Status::success(), persisted}; }

  LoadJournalResult load_journal(std::size_t limit) override {
    std::vector<Event> result;
    if (limit == 0 || journal.empty()) return {Status::success(), {}};
    const auto take = std::min(limit, journal.size());
    result.reserve(take);
    result.insert(result.end(), journal.end() - static_cast<std::ptrdiff_t>(take), journal.end());
    return {Status::success(), std::move(result)};
  }

  ProjectSnapshot persisted;
  CommitContext last_context;
  std::vector<Event> journal;
};

Json call(Dispatcher& dispatcher, const Json& request) {
  return Json::parse(dispatcher.handle(request.dump()));
}

void test_protocol_project_history_and_context_roundtrip() {
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
  const Json context{{"actor", "user"},
                     {"source", "studio-inspector"},
                     {"planId", ""},
                     {"reason", "create first shot"}};
  auto applied = call(dispatcher, Json{{"protocol", 1},
                                       {"id", "apply-1"},
                                       {"method", "project.apply"},
                                       {"params", Json{{"expectedProjectRevision", 0}, {"commands", commands}, {"context", context}}}});
  require(applied["ok"].get<bool>() && applied["result"]["projectRevision"] == 1,
          "project.apply should route through native session");
  require(store.persisted.project_revision == 1,
          "IPC mutation must persist before success response");
  require(store.last_context.source == "studio-inspector" &&
              store.last_context.reason == "create first shot",
          "validated IPC commit context must reach persistence boundary");

  auto stale_apply = call(dispatcher, Json{{"protocol", 1},
                                           {"id", "apply-stale"},
                                           {"method", "project.apply"},
                                           {"params", Json{{"expectedProjectRevision", 0}, {"commands", Json::array({Json{{"type", "node.markFresh"}, {"id", "shot.001"}}})}}}});
  require(!stale_apply["ok"].get<bool>() && stale_apply["error"]["code"] == "revision_conflict",
          "project.apply should reject stale expected project revisions");

  auto snapshot = call(dispatcher, Json{{"protocol", 1}, {"id", "snapshot-1"}, {"method", "project.snapshot"}, {"params", Json::object()}});
  require(snapshot["ok"].get<bool>() && snapshot["result"]["nodes"].size() == 2 &&
              snapshot["result"]["dependencies"].size() == 1,
          "snapshot should serialize real C++ graph");

  auto impact = call(dispatcher, Json{{"protocol", 1}, {"id", "impact-1"}, {"method", "project.impact"}, {"params", Json{{"source", "character.mira"}}}});
  require(impact["ok"].get<bool>() && impact["result"]["affected"].size() == 1 &&
              impact["result"]["affected"][0] == "shot.001",
          "impact should be computed by native dependency graph");

  auto history = call(dispatcher, Json{{"protocol", 1},
                                       {"id", "history-1"},
                                       {"method", "project.history"},
                                       {"params", Json{{"limit", 8}}}});
  require(history["ok"].get<bool>() && history["result"]["transactions"].size() == 1,
          "history should expose one complete committed revision");
  const auto& transaction = history["result"]["transactions"][0];
  require(transaction["projectRevision"] == 1 && transaction["actor"] == "user" &&
              transaction["source"] == "studio-inspector" &&
              transaction["reason"] == "create first shot",
          "history should parse durable commit provenance into typed fields");
  require(transaction["events"].is_array() && transaction["events"].size() >= 4,
          "history transaction should preserve committed native events");
}

void test_workflow_restore_is_revision_safe_and_journaled() {
  FakeStore store;
  ProjectSession session{store};
  require(session.load().ok(), "restore IPC session should load");
  Dispatcher dispatcher{session};

  auto setup = call(dispatcher, Json{{"protocol", 1},
                                     {"id", "restore-setup"},
                                     {"method", "project.apply"},
                                     {"params", Json{{"commands", Json::array({Json{{"type", "node.create"}, {"node", Json{{"id", "scene.old"}, {"kind", "scene"}, {"title", "Old"}}}}})}}}});
  require(setup["ok"].get<bool>() && setup["result"]["projectRevision"] == 1,
          "restore setup should commit revision one");

  Json target{{"schemaVersion", 1},
              {"projectRevision", 77},
              {"nodes", Json::array({Json{{"id", "scene.loaded"},
                                          {"kind", "scene"},
                                          {"title", "Loaded"},
                                          {"metadata", Json::object()},
                                          {"revision", 1},
                                          {"approval", "draft"},
                                          {"locked", false},
                                          {"stale", false}}})},
              {"dependencies", Json::array()}};
  const Json restore_context{{"actor", "ai_director"},
                             {"source", "director-workflow-load"},
                             {"planId", "tool-call-restore"},
                             {"reason", "load saved workflow"}};

  auto missing_expected = call(dispatcher, Json{{"protocol", 1},
                                                 {"id", "restore-missing"},
                                                 {"method", "project.restore"},
                                                 {"params", Json{{"snapshot", target}, {"context", restore_context}}}});
  require(!missing_expected["ok"].get<bool>() && missing_expected["error"]["code"] == "invalid_argument",
          "workflow restore must require expected project revision");

  auto restored = call(dispatcher, Json{{"protocol", 1},
                                        {"id", "restore-live"},
                                        {"method", "project.restore"},
                                        {"params", Json{{"expectedProjectRevision", 1}, {"snapshot", target}, {"context", restore_context}}}});
  require(restored["ok"].get<bool>() && restored["result"]["projectRevision"] == 2,
          "workflow restore should advance from live revision instead of saved revision");
  require(restored["result"]["snapshot"]["nodes"].size() == 1 &&
              restored["result"]["snapshot"]["nodes"][0]["id"] == "scene.loaded",
          "workflow restore should return the authoritative restored snapshot");

  auto stale_restore = call(dispatcher, Json{{"protocol", 1},
                                             {"id", "restore-stale"},
                                             {"method", "project.restore"},
                                             {"params", Json{{"expectedProjectRevision", 1}, {"snapshot", target}, {"context", restore_context}}}});
  require(!stale_restore["ok"].get<bool>() && stale_restore["error"]["code"] == "revision_conflict",
          "stale workflow restore must fail closed");

  auto history = call(dispatcher, Json{{"protocol", 1},
                                       {"id", "restore-history"},
                                       {"method", "project.history"},
                                       {"params", Json{{"limit", 8}}}});
  require(history["ok"].get<bool>() && history["result"]["transactions"].size() == 2,
          "restore should remain a complete durable history transaction");
  const auto& restore_transaction = history["result"]["transactions"][1];
  require(restore_transaction["projectRevision"] == 2 &&
              restore_transaction["actor"] == "ai_director" &&
              restore_transaction["source"] == "director-workflow-load" &&
              restore_transaction["reason"] == "load saved workflow",
          "restore history should retain AI provenance and reason");
  require(restore_transaction["events"].size() == 1 &&
              restore_transaction["events"][0]["type"] == "transaction.committed",
          "restore journal should use one bounded semantic commit marker");
}

void test_typed_failures_and_bounds() {
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

  auto bad_history = call(dispatcher, Json{{"protocol", 1},
                                           {"id", "history-bad"},
                                           {"method", "project.history"},
                                           {"params", Json{{"limit", 1000}}}});
  require(!bad_history["ok"].get<bool>() && bad_history["error"]["code"] == "invalid_argument",
          "history transaction count must be bounded at IPC boundary");

  auto empty_apply = call(dispatcher, Json{{"protocol", 1},
                                           {"id", "empty-apply"},
                                           {"method", "project.apply"},
                                           {"params", Json{{"commands", Json::array()}}}});
  require(!empty_apply["ok"].get<bool>() && empty_apply["error"]["code"] == "invalid_argument",
          "empty command batches must be rejected before native mutation");

  auto bad_context = call(dispatcher, Json{{"protocol", 1},
                                           {"id", "bad-context"},
                                           {"method", "project.apply"},
                                           {"params", Json{{"commands", Json::array({Json{{"type", "node.create"}, {"node", Json{{"id", "x"}, {"kind", "scene"}, {"title", "X"}}}}})},
                                                           {"context", Json{{"actor", "untrusted"}}}}}});
  require(!bad_context["ok"].get<bool>() && bad_context["error"]["code"] == "invalid_argument",
          "unknown commit actors must be rejected at IPC boundary");
}

}  // namespace

int main() {
  test_protocol_project_history_and_context_roundtrip();
  test_workflow_restore_is_revision_safe_and_journaled();
  test_typed_failures_and_bounds();
  std::cout << "ipc_dispatcher_test: all checks passed\n";
  return EXIT_SUCCESS;
}
