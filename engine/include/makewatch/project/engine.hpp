#pragma once

#include <cstdint>
#include <vector>

#include "makewatch/core/status.hpp"
#include "makewatch/project/command.hpp"
#include "makewatch/project/event.hpp"
#include "makewatch/project/graph.hpp"
#include "makewatch/project/impact.hpp"
#include "makewatch/project/snapshot.hpp"

namespace makewatch::project {

struct CommandResult final {
  core::Status status;
  std::uint64_t project_revision{0};
  std::vector<Event> events;

  [[nodiscard]] bool ok() const noexcept { return status.ok(); }
};

class ProjectEngine final {
 public:
  [[nodiscard]] const ProjectGraph& graph() const noexcept { return graph_; }
  [[nodiscard]] std::uint64_t project_revision() const noexcept { return project_revision_; }
  [[nodiscard]] const std::vector<Event>& event_log() const noexcept { return event_log_; }

  [[nodiscard]] CommandResult apply(const Command& command);
  [[nodiscard]] CommandResult apply_batch(const std::vector<Command>& commands);
  [[nodiscard]] ImpactReport preview_impact(const core::EntityId& source) const;

  [[nodiscard]] ProjectSnapshot snapshot() const;
  [[nodiscard]] core::Status hydrate(const ProjectSnapshot& snapshot);

 private:
  [[nodiscard]] static core::Status apply_one(ProjectGraph& graph, const Command& command,
                                              std::vector<Event>& events);
  [[nodiscard]] static core::Status check_revision(const Node& node,
                                                   const std::optional<std::uint64_t>& expected);

  ProjectGraph graph_;
  std::uint64_t project_revision_{0};
  std::vector<Event> event_log_;
};

}  // namespace makewatch::project
