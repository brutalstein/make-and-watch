#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <variant>

#include "makewatch/core/id.hpp"
#include "makewatch/domain/approval.hpp"
#include "makewatch/project/node.hpp"

namespace makewatch::project {

struct CreateNode final {
  Node node;
};

struct PatchNode final {
  core::EntityId id;
  std::optional<std::uint64_t> expected_revision;
  std::optional<std::string> title;
  std::optional<domain::ApprovalState> approval;
  std::map<std::string, std::string> metadata_updates;
  std::set<std::string> metadata_removals;
};

struct SetLock final {
  core::EntityId id;
  bool locked{true};
  std::optional<std::uint64_t> expected_revision;
};

struct MarkFresh final {
  core::EntityId id;
  std::optional<std::uint64_t> expected_revision;
};

struct AddDependency final {
  core::EntityId dependent;
  core::EntityId dependency;
};

struct RemoveDependency final {
  core::EntityId dependent;
  core::EntityId dependency;
};

struct RemoveNode final {
  core::EntityId id;
  std::optional<std::uint64_t> expected_revision;
};

using Command = std::variant<CreateNode, PatchNode, SetLock, MarkFresh, AddDependency,
                             RemoveDependency, RemoveNode>;

}  // namespace makewatch::project
