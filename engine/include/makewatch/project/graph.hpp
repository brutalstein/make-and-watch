#pragma once

#include <cstddef>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "makewatch/core/id.hpp"
#include "makewatch/core/status.hpp"
#include "makewatch/project/node.hpp"
#include "makewatch/project/snapshot.hpp"

namespace makewatch::project {

class ProjectGraph final {
 public:
  [[nodiscard]] const Node* find(const core::EntityId& id) const noexcept;
  [[nodiscard]] Node* find_mutable(const core::EntityId& id) noexcept;
  [[nodiscard]] bool contains(const core::EntityId& id) const noexcept;
  [[nodiscard]] std::size_t node_count() const noexcept { return nodes_.size(); }
  [[nodiscard]] std::size_t dependency_count() const noexcept;

  [[nodiscard]] core::Status insert(Node node);
  [[nodiscard]] core::Status erase(const core::EntityId& id);
  [[nodiscard]] core::Status add_dependency(const core::EntityId& dependent,
                                            const core::EntityId& dependency);
  [[nodiscard]] core::Status remove_dependency(const core::EntityId& dependent,
                                               const core::EntityId& dependency);

  [[nodiscard]] std::vector<core::EntityId> dependent_closure(
      const core::EntityId& id) const;
  [[nodiscard]] std::vector<core::EntityId> dependencies_of(
      const core::EntityId& id) const;
  [[nodiscard]] std::vector<core::EntityId> dependents_of(
      const core::EntityId& id) const;

  [[nodiscard]] GraphSnapshot snapshot() const;
  [[nodiscard]] core::Status replace_from_snapshot(const GraphSnapshot& snapshot);

  std::vector<core::EntityId> mark_stale(const std::vector<core::EntityId>& ids);

 private:
  [[nodiscard]] bool reachable_through_dependencies(const std::string& from,
                                                    const std::string& target) const;

  std::map<std::string, Node> nodes_;
  std::map<std::string, std::set<std::string>> dependencies_;
  std::map<std::string, std::set<std::string>> dependents_;
};

}  // namespace makewatch::project
