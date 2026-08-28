#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include "makewatch/application/project_session.hpp"
#include "makewatch/core/id.hpp"
#include "makewatch/core/status.hpp"
#include "makewatch/persistence/snapshot_store.hpp"
#include "makewatch/project/command.hpp"
#include "makewatch/project/node.hpp"

namespace {

using makewatch::application::ProjectSession;
using makewatch::core::EntityId;
using makewatch::core::ErrorCode;
using makewatch::core::Status;
using makewatch::persistence::CommitActor;
using makewatch::persistence::CommitContext;
using makewatch::persistence::LoadSnapshotResult;
using makewatch::persistence::SnapshotStore;
using makewatch::project::Command;
using makewatch::project::CreateNode;
using makewatch::project::Event;
using makewatch::project::EventType;
using makewatch::project::Node;
using makewatch::project::NodeKind;
using makewatch::project::PatchNode;
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
    ++save_attempts;
    if (fail_save) return Status::failure(ErrorCode::kIoError, "simulated persistence failure");
    persisted = snapshot;
    return Status::success();
  }

  Status save_commit(
      const ProjectSnapshot& snapshot,
      const std::vector<Event>& events,
      const CommitContext& context) override {
    const auto status = save(snapshot);
    if (status.ok()) {
      journaled_events += events.size();
      last_events = events;
      last_context = context;
    }
    return status;
  }

  LoadSnapshotResult load() override { return {load_status, persisted}; }

  ProjectSnapshot persisted;
  Status load_status{Status::success()};
  bool fail_save{false};
  int save_attempts{0};
  std::size_t journaled_events{0};
  std::vector<Event> last_events;
  CommitContext last_context;
};

Node make_node(const char* id, NodeKind kind, const char* title) {
  Node node;
  node.id = EntityId{id};
  node.kind = kind;
  node.title = title;
  return node;
}

void test_persist_before_live_commit() {
  FakeStore store;
  ProjectSession session{store};
  require(session.load().ok(), "empty store should load");

  require(session.apply(Command{CreateNode{make_node("scene.001", NodeKind::kScene, "Opening")}}).ok(),
          "create should persist and commit");
  require(session.snapshot().project_revision == 1 && store.persisted.project_revision == 1,
          "live and persisted revisions should agree");
  require(store.journaled_events > 0, "successful commit should forward native events to persistence");

  const auto journaled_before_failure = store.journaled_events;
  const auto before = session.snapshot();
  store.fail_save = true;
  PatchNode patch;
  patch.id = EntityId{"scene.001"};
  patch.expected_revision = 1;
  patch.title = "Changed but not persisted";
  const auto failed = session.apply(Command{patch});
  require(!failed.ok() && failed.status.code == ErrorCode::kIoError,
          "persistence failure must fail the command");
  const auto after = session.snapshot();
  require(after.project_revision == before.project_revision,
          "persistence failure must not advance live revision");
  require(after.graph.nodes.front().title == "Opening",
          "persistence failure must not mutate live graph");
  require(store.persisted.graph.nodes.front().title == "Opening",
          "failed save must not replace persisted fixture state");
  require(store.journaled_events == journaled_before_failure,
          "failed persistence must not append journal events");
}

void test_commit_context_is_durable_event_provenance() {
  FakeStore store;
  ProjectSession session{store};
  require(session.load().ok(), "session should load before provenance test");

  CommitContext context;
  context.actor = CommitActor::kAiDirector;
  context.source = "studio-autopilot";
  context.plan_id = "plan-42";
  context.reason = "organize approved scene structure";

  const auto result = session.apply(
      Command{CreateNode{make_node("scene.ai", NodeKind::kScene, "AI Scene")}}, context);
  require(result.ok(), "AI-attributed command should commit");
  require(store.last_context.actor == CommitActor::kAiDirector &&
              store.last_context.source == "studio-autopilot" &&
              store.last_context.plan_id == "plan-42",
          "commit context must reach persistence unchanged");

  const Event* transaction = nullptr;
  for (const auto& event : store.last_events) {
    if (event.type == EventType::kTransactionCommitted) transaction = &event;
  }
  require(transaction != nullptr, "successful native commit should contain transaction event");
  require(transaction->detail.find("mwctx1|actor=ai_director") != std::string::npos &&
              transaction->detail.find("source=studio-autopilot") != std::string::npos &&
              transaction->detail.find("plan=plan-42") != std::string::npos &&
              transaction->detail.find("reason=organize approved scene structure") != std::string::npos,
          "transaction event should encode durable AI provenance");
}

void test_replace_validates_before_persisting() {
  FakeStore store;
  ProjectSession session{store};
  require(session.load().ok(), "session should load");

  ProjectSnapshot invalid_snapshot;
  invalid_snapshot.project_revision = 7;
  auto duplicate = make_node("scene.dup", NodeKind::kScene, "Duplicate");
  duplicate.revision = 1;
  invalid_snapshot.graph.nodes.push_back(duplicate);
  invalid_snapshot.graph.nodes.push_back(duplicate);

  const auto before_attempts = store.save_attempts;
  require(!session.replace(invalid_snapshot).ok(), "invalid replacement must be rejected");
  require(store.save_attempts == before_attempts,
          "invalid replacement must not reach persistence");
}

void test_load_failure_does_not_destroy_live_state() {
  FakeStore store;
  ProjectSession session{store};
  require(session.load().ok(), "initial load should work");
  require(session.apply(Command{CreateNode{make_node("shot.001", NodeKind::kShot, "Shot")}}).ok(),
          "setup should commit");
  store.load_status = Status::failure(ErrorCode::kIoError, "simulated load failure");
  require(!session.load().ok(), "load failure should be reported");
  require(session.snapshot().graph.nodes.size() == 1,
          "load failure must leave current live state untouched");
}

}  // namespace

int main() {
  test_persist_before_live_commit();
  test_commit_context_is_durable_event_provenance();
  test_replace_validates_before_persisting();
  test_load_failure_does_not_destroy_live_state();
  std::cout << "project_session_test: all checks passed\n";
  return EXIT_SUCCESS;
}
