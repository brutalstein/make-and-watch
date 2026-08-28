#pragma once

#include <cstdint>
#include <vector>

#include "makewatch/core/id.hpp"
#include "makewatch/project/node.hpp"

namespace makewatch::project {

struct DependencyEdge final {
  core::EntityId dependent;
  core::EntityId dependency;
};

struct GraphSnapshot final {
  std::vector<Node> nodes;
  std::vector<DependencyEdge> dependencies;
};

struct ProjectSnapshot final {
  std::uint64_t project_revision{0};
  GraphSnapshot graph;
};

}  // namespace makewatch::project
