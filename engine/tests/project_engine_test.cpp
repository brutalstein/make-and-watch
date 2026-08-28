#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include "makewatch/core/status.hpp"
#include "makewatch/project/engine.hpp"

namespace {

using makewatch::core::EntityId;
using makewatch::core::ErrorCode;
using makewatch::domain::ApprovalState;
using makewatch::project::AddDependency;
using makewatch::project::Command;
using makewatch::project::CreateNode;
using makewatch::project::MarkFresh;
using makewatch::project::Node;
using makewatch::project::NodeKind;
using makewatch::project::PatchNode;
using makewatch::project::ProjectEngine;
using makewatch::project::RemoveNode;
using makewatch::project::SetLock;

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

void test_transitive_invalidation_and_lock_semantics() {
  ProjectEngine engine;
  const std::vector<Command> setup{
      CreateNode{make_node("character.mira", NodeKind::kCharacter, "Mira")},
      CreateNode{make_node("shot.001", NodeKind::kShot, "Close-up")},
      CreateNode{make_node("generation.001", NodeKind::kGeneration, "Rendered clip")},
      AddDependency{EntityId{"shot.001"}, EntityId{"character.mira"}},
      AddDependency{EntityId{"generation.001"}, EntityId{"shot.001"}},
      MarkFresh{EntityId{"shot.001"}, {}},
      MarkFresh{EntityId{"generation.001"}, {}},
      SetLock{EntityId{"shot.001"}, true, {}},
  };
  require(engine.apply_batch(setup).ok(), "setup transaction should commit");

  PatchNode patch;
  patch.id = EntityId{"character.mira"};
  patch.metadata_updates["wardrobe"] = "detective-black-v2";
  require(engine.apply(patch).ok(), "upstream character edit should commit");

  const auto* shot = engine.graph().find(EntityId{"shot.001"});
  const auto* generation = engine.graph().find(EntityId{"generation.001"});
  require(shot != nullptr && shot->locked, "shot must remain locked");
  require(shot != nullptr && shot->stale, "locked dependent must still become stale");
  require(generation != nullptr && generation->stale, "transitive dependent must become stale");

  PatchNode blocked;
  blocked.id = EntityId{"shot.001"};
  blocked.title = "AI should not mutate this";
  const auto blocked_result = engine.apply(blocked);
  require(!blocked_result.ok() && blocked_result.status.code == ErrorCode::kLocked,
          "direct edits to locked node must be rejected");
}

void test_cycle_rejection_and_atomic_batch_rollback() {
  ProjectEngine engine;
  require(engine.apply(CreateNode{make_node("a", NodeKind::kScene, "A")}).ok(),
          "node A should exist");
  require(engine.apply(CreateNode{make_node("b", NodeKind::kScene, "B")}).ok(),
          "node B should exist");
  require(engine.apply(AddDependency{EntityId{"a"}, EntityId{"b"}}).ok(),
          "A may depend on B");

  const auto revision_before = engine.project_revision();
  const auto cycle_result = engine.apply(AddDependency{EntityId{"b"}, EntityId{"a"}});
  require(!cycle_result.ok() && cycle_result.status.code == ErrorCode::kCycleDetected,
          "cycle must be rejected");
  require(engine.project_revision() == revision_before,
          "failed transaction must not advance project revision");
  require(engine.graph().dependency_count() == 1, "failed cycle must not mutate graph");

  const std::vector<Command> invalid_batch{
      CreateNode{make_node("temporary", NodeKind::kScene, "Temporary")},
      CreateNode{make_node("a", NodeKind::kScene, "Duplicate")},
  };
  const auto batch_result = engine.apply_batch(invalid_batch);
  require(!batch_result.ok(), "invalid batch should fail");
  require(!engine.graph().contains(EntityId{"temporary"}),
          "failed batch must roll back earlier staged commands");
}

void test_optimistic_revision_and_refresh_approval_gate() {
  ProjectEngine engine;
  require(engine.apply(CreateNode{make_node("shot", NodeKind::kShot, "Shot")}).ok(),
          "shot should be created");
  require(engine.apply(CreateNode{make_node("render", NodeKind::kGeneration, "Render")}).ok(),
          "render should be created");
  require(engine.apply(AddDependency{EntityId{"render"}, EntityId{"shot"}}).ok(),
          "render should depend on shot");
  require(engine.apply(MarkFresh{EntityId{"render"}, {}}).ok(), "render should be fresh");

  const auto* shot_before = engine.graph().find(EntityId{"shot"});
  require(shot_before != nullptr, "shot should exist");
  const auto expected_revision = shot_before->revision;

  PatchNode update;
  update.id = EntityId{"shot"};
  update.expected_revision = expected_revision;
  update.title = "Updated Shot";
  require(engine.apply(update).ok(), "matching optimistic revision should commit");

  PatchNode stale_client_update;
  stale_client_update.id = EntityId{"shot"};
  stale_client_update.expected_revision = expected_revision;
  stale_client_update.title = "Lost update";
  const auto conflict = engine.apply(stale_client_update);
  require(!conflict.ok() && conflict.status.code == ErrorCode::kRevisionConflict,
          "stale client write must be rejected");

  const auto* render = engine.graph().find(EntityId{"render"});
  require(render != nullptr && render->stale, "render should become stale after shot edit");

  PatchNode premature_approval;
  premature_approval.id = EntityId{"render"};
  premature_approval.approval = ApprovalState::kApproved;
  require(!engine.apply(premature_approval).ok(), "stale render must not be approvable");

  require(engine.apply(MarkFresh{EntityId{"render"}, {}}).ok(), "refresh should clear stale flag");
  require(engine.apply(premature_approval).ok(), "fresh render may be approved");
}

void test_remove_invalidates_dependents_and_cleans_edges() {
  ProjectEngine engine;
  const std::vector<Command> setup{
      CreateNode{make_node("character", NodeKind::kCharacter, "Character")},
      CreateNode{make_node("shot", NodeKind::kShot, "Shot")},
      AddDependency{EntityId{"shot"}, EntityId{"character"}},
      MarkFresh{EntityId{"shot"}, {}},
  };
  require(engine.apply_batch(setup).ok(), "remove test setup should commit");
  require(engine.graph().dependency_count() == 1, "dependency should exist before removal");

  const auto* character = engine.graph().find(EntityId{"character"});
  require(character != nullptr, "character should exist before removal");
  const auto result = engine.apply(RemoveNode{EntityId{"character"}, character->revision});
  require(result.ok(), "unlocked character should be removable");
  require(!engine.graph().contains(EntityId{"character"}), "removed node must disappear");
  require(engine.graph().dependency_count() == 0, "incident edges must be removed");
  const auto* shot = engine.graph().find(EntityId{"shot"});
  require(shot != nullptr && shot->stale, "dependent shot must become stale after removal");
}

}  // namespace

int main() {
  test_transitive_invalidation_and_lock_semantics();
  test_cycle_rejection_and_atomic_batch_rollback();
  test_optimistic_revision_and_refresh_approval_gate();
  test_remove_invalidates_dependents_and_cleans_edges();
  std::cout << "project_engine_test: all checks passed\n";
  return EXIT_SUCCESS;
}
