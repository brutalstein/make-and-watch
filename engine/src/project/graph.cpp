#include "makewatch/project/graph.hpp"

#include <algorithm>
#include <utility>

namespace makewatch::project {

const Node* ProjectGraph::find(const core::EntityId& id) const noexcept {
  const auto it = nodes_.find(id.value());
  return it == nodes_.end() ? nullptr : &it->second;
}

Node* ProjectGraph::find_mutable(const core::EntityId& id) noexcept {
  const auto it = nodes_.find(id.value());
  return it == nodes_.end() ? nullptr : &it->second;
}

bool ProjectGraph::contains(const core::EntityId& id) const noexcept {
  return nodes_.contains(id.value());
}

std::size_t ProjectGraph::dependency_count() const noexcept {
  std::size_t total = 0;
  for (const auto& [unused, entries] : dependencies_) {
    static_cast<void>(unused);
    total += entries.size();
  }
  return total;
}

core::Status ProjectGraph::insert(Node node) {
  if (node.id.empty()) {
    return core::Status::failure(core::ErrorCode::kInvalidArgument, "node id must not be empty");
  }
  if (contains(node.id)) {
    return core::Status::failure(core::ErrorCode::kAlreadyExists, "node already exists");
  }

  const auto key = node.id.value();
  nodes_.emplace(key, std::move(node));
  return core::Status::success();
}

core::Status ProjectGraph::erase(const core::EntityId& id) {
  const auto key = id.value();
  if (!nodes_.contains(key)) {
    return core::Status::failure(core::ErrorCode::kNotFound, "node does not exist");
  }

  if (const auto dependencies_it = dependencies_.find(key); dependencies_it != dependencies_.end()) {
    for (const auto& dependency : dependencies_it->second) {
      if (auto reverse_it = dependents_.find(dependency); reverse_it != dependents_.end()) {
        reverse_it->second.erase(key);
        if (reverse_it->second.empty()) {
          dependents_.erase(reverse_it);
        }
      }
    }
    dependencies_.erase(dependencies_it);
  }

  if (const auto dependents_it = dependents_.find(key); dependents_it != dependents_.end()) {
    for (const auto& dependent : dependents_it->second) {
      if (auto forward_it = dependencies_.find(dependent); forward_it != dependencies_.end()) {
        forward_it->second.erase(key);
        if (forward_it->second.empty()) {
          dependencies_.erase(forward_it);
        }
      }
    }
    dependents_.erase(dependents_it);
  }

  nodes_.erase(key);
  return core::Status::success();
}

bool ProjectGraph::reachable_through_dependencies(const std::string& from,
                                                  const std::string& target) const {
  if (from == target) {
    return true;
  }

  std::vector<std::string> stack{from};
  std::set<std::string> visited;
  while (!stack.empty()) {
    auto current = std::move(stack.back());
    stack.pop_back();
    if (!visited.insert(current).second) {
      continue;
    }

    const auto it = dependencies_.find(current);
    if (it == dependencies_.end()) {
      continue;
    }
    for (const auto& dependency : it->second) {
      if (dependency == target) {
        return true;
      }
      stack.push_back(dependency);
    }
  }
  return false;
}

core::Status ProjectGraph::add_dependency(const core::EntityId& dependent,
                                          const core::EntityId& dependency) {
  if (!contains(dependent) || !contains(dependency)) {
    return core::Status::failure(core::ErrorCode::kNotFound,
                                 "both dependency endpoints must exist");
  }
  if (dependent == dependency) {
    return core::Status::failure(core::ErrorCode::kCycleDetected,
                                 "a node cannot depend on itself");
  }

  const auto existing = dependencies_.find(dependent.value());
  if (existing != dependencies_.end() && existing->second.contains(dependency.value())) {
    return core::Status::success();
  }
  if (reachable_through_dependencies(dependency.value(), dependent.value())) {
    return core::Status::failure(core::ErrorCode::kCycleDetected,
                                 "dependency would create a cycle");
  }

  dependencies_[dependent.value()].insert(dependency.value());
  dependents_[dependency.value()].insert(dependent.value());
  return core::Status::success();
}

core::Status ProjectGraph::remove_dependency(const core::EntityId& dependent,
                                             const core::EntityId& dependency) {
  if (!contains(dependent) || !contains(dependency)) {
    return core::Status::failure(core::ErrorCode::kNotFound,
                                 "both dependency endpoints must exist");
  }

  const auto dependencies_it = dependencies_.find(dependent.value());
  if (dependencies_it == dependencies_.end() ||
      !dependencies_it->second.contains(dependency.value())) {
    return core::Status::failure(core::ErrorCode::kNotFound, "dependency edge does not exist");
  }

  dependencies_it->second.erase(dependency.value());
  if (dependencies_it->second.empty()) {
    dependencies_.erase(dependencies_it);
  }

  if (auto reverse_it = dependents_.find(dependency.value()); reverse_it != dependents_.end()) {
    reverse_it->second.erase(dependent.value());
    if (reverse_it->second.empty()) {
      dependents_.erase(reverse_it);
    }
  }
  return core::Status::success();
}

std::vector<core::EntityId> ProjectGraph::dependent_closure(const core::EntityId& id) const {
  std::vector<core::EntityId> result;
  std::vector<std::string> queue;
  std::set<std::string> visited;

  if (const auto it = dependents_.find(id.value()); it != dependents_.end()) {
    queue.insert(queue.end(), it->second.begin(), it->second.end());
  }

  std::size_t index = 0;
  while (index < queue.size()) {
    const auto current = queue[index++];
    if (!visited.insert(current).second) {
      continue;
    }
    result.emplace_back(current);
    if (const auto it = dependents_.find(current); it != dependents_.end()) {
      queue.insert(queue.end(), it->second.begin(), it->second.end());
    }
  }

  std::sort(result.begin(), result.end(), [](const auto& lhs, const auto& rhs) {
    return lhs.value() < rhs.value();
  });
  return result;
}

std::vector<core::EntityId> ProjectGraph::dependencies_of(const core::EntityId& id) const {
  std::vector<core::EntityId> result;
  if (const auto it = dependencies_.find(id.value()); it != dependencies_.end()) {
    for (const auto& value : it->second) {
      result.emplace_back(value);
    }
  }
  return result;
}

std::vector<core::EntityId> ProjectGraph::dependents_of(const core::EntityId& id) const {
  std::vector<core::EntityId> result;
  if (const auto it = dependents_.find(id.value()); it != dependents_.end()) {
    for (const auto& value : it->second) {
      result.emplace_back(value);
    }
  }
  return result;
}

GraphSnapshot ProjectGraph::snapshot() const {
  GraphSnapshot result;
  result.nodes.reserve(nodes_.size());
  for (const auto& [unused, node] : nodes_) {
    static_cast<void>(unused);
    result.nodes.push_back(node);
  }
  result.dependencies.reserve(dependency_count());
  for (const auto& [dependent, dependencies] : dependencies_) {
    for (const auto& dependency : dependencies) {
      result.dependencies.push_back(
          DependencyEdge{core::EntityId{dependent}, core::EntityId{dependency}});
    }
  }
  return result;
}

core::Status ProjectGraph::replace_from_snapshot(const GraphSnapshot& snapshot_value) {
  ProjectGraph staged;
  for (const auto& node : snapshot_value.nodes) {
    if (node.revision == 0) {
      return core::Status::failure(core::ErrorCode::kInvalidArgument,
                                   "persisted node revision must be greater than zero");
    }
    if (const auto status = staged.insert(node); !status.ok()) {
      return status;
    }
  }
  for (const auto& edge : snapshot_value.dependencies) {
    if (const auto status = staged.add_dependency(edge.dependent, edge.dependency); !status.ok()) {
      return status;
    }
  }
  *this = std::move(staged);
  return core::Status::success();
}

std::vector<core::EntityId> ProjectGraph::mark_stale(const std::vector<core::EntityId>& ids) {
  std::vector<core::EntityId> changed;
  for (const auto& id : ids) {
    if (auto* node = find_mutable(id); node != nullptr && !node->stale) {
      node->stale = true;
      ++node->revision;
      changed.push_back(id);
    }
  }
  return changed;
}

}  // namespace makewatch::project
