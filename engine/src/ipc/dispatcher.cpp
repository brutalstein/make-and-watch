#include "makewatch/ipc/dispatcher.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "makewatch/core/status.hpp"
#include "makewatch/domain/approval.hpp"
#include "makewatch/persistence/snapshot_store.hpp"
#include "makewatch/project/command.hpp"
#include "makewatch/project/event.hpp"
#include "makewatch/project/node.hpp"
#include "makewatch/project/snapshot.hpp"

namespace makewatch::ipc {
namespace {

using Json = nlohmann::json;
using core::ErrorCode;
using core::Status;
using domain::ApprovalState;
using project::NodeKind;

constexpr std::size_t kMaxApplyCommands = 128;
constexpr std::size_t kMaxSnapshotNodes = 4096;
constexpr std::size_t kMaxSnapshotDependencies = 16384;
constexpr std::size_t kDefaultHistoryTransactions = 10;
constexpr std::size_t kMaxHistoryTransactions = 24;
// A PatchNode can emit node.updated + approval.changed + dependents.invalidated.
// 128 * 3 command events + one transaction marker is the maximum normal batch.
constexpr std::size_t kHistoryEventBudgetPerTransaction = 385;
constexpr std::size_t kMaxContextSourceLength = 160;
constexpr std::size_t kMaxContextPlanLength = 192;
constexpr std::size_t kMaxContextReasonLength = 1024;

struct CommandParseResult final {
  Status status;
  std::optional<project::Command> command;
};

struct SnapshotParseResult final {
  Status status;
  project::ProjectSnapshot snapshot;
};

struct CommitContextParseResult final {
  Status status;
  persistence::CommitContext context;
};

struct ParsedProvenance final {
  std::string actor{"system"};
  std::string source;
  std::string plan_id;
  std::string reason;
  std::string event_detail;
};

const char* error_code_name(ErrorCode code) noexcept {
  switch (code) {
    case ErrorCode::kNone: return "none";
    case ErrorCode::kInvalidArgument: return "invalid_argument";
    case ErrorCode::kAlreadyExists: return "already_exists";
    case ErrorCode::kNotFound: return "not_found";
    case ErrorCode::kLocked: return "locked";
    case ErrorCode::kRevisionConflict: return "revision_conflict";
    case ErrorCode::kCycleDetected: return "cycle_detected";
    case ErrorCode::kResourceExhausted: return "resource_exhausted";
    case ErrorCode::kBusy: return "busy";
    case ErrorCode::kIoError: return "io_error";
    case ErrorCode::kCorruptData: return "corrupt_data";
    case ErrorCode::kUnsupportedVersion: return "unsupported_version";
  }
  return "unknown";
}

const char* node_kind_name(NodeKind kind) noexcept {
  switch (kind) {
    case NodeKind::kSeries: return "series";
    case NodeKind::kEpisode: return "episode";
    case NodeKind::kScene: return "scene";
    case NodeKind::kShot: return "shot";
    case NodeKind::kCharacter: return "character";
    case NodeKind::kLocation: return "location";
    case NodeKind::kAsset: return "asset";
    case NodeKind::kAudio: return "audio";
    case NodeKind::kGeneration: return "generation";
  }
  return "asset";
}

std::optional<NodeKind> parse_node_kind(std::string_view value) noexcept {
  if (value == "series") return NodeKind::kSeries;
  if (value == "episode") return NodeKind::kEpisode;
  if (value == "scene") return NodeKind::kScene;
  if (value == "shot") return NodeKind::kShot;
  if (value == "character") return NodeKind::kCharacter;
  if (value == "location") return NodeKind::kLocation;
  if (value == "asset") return NodeKind::kAsset;
  if (value == "audio") return NodeKind::kAudio;
  if (value == "generation") return NodeKind::kGeneration;
  return std::nullopt;
}

const char* approval_name(ApprovalState state) noexcept {
  switch (state) {
    case ApprovalState::kDraft: return "draft";
    case ApprovalState::kReview: return "review";
    case ApprovalState::kApproved: return "approved";
    case ApprovalState::kLocked: return "locked";
    case ApprovalState::kInvalidated: return "invalidated";
    case ApprovalState::kFailed: return "failed";
  }
  return "draft";
}

std::optional<ApprovalState> parse_approval(std::string_view value) noexcept {
  if (value == "draft") return ApprovalState::kDraft;
  if (value == "review") return ApprovalState::kReview;
  if (value == "approved") return ApprovalState::kApproved;
  if (value == "locked") return ApprovalState::kLocked;
  if (value == "invalidated") return ApprovalState::kInvalidated;
  if (value == "failed") return ApprovalState::kFailed;
  return std::nullopt;
}

const char* event_type_name(project::EventType type) noexcept {
  switch (type) {
    case project::EventType::kNodeCreated: return "node.created";
    case project::EventType::kNodeUpdated: return "node.updated";
    case project::EventType::kNodeRemoved: return "node.removed";
    case project::EventType::kDependencyAdded: return "dependency.added";
    case project::EventType::kDependencyRemoved: return "dependency.removed";
    case project::EventType::kLockChanged: return "lock.changed";
    case project::EventType::kApprovalChanged: return "approval.changed";
    case project::EventType::kFreshnessChanged: return "freshness.changed";
    case project::EventType::kDependentsInvalidated: return "dependents.invalidated";
    case project::EventType::kTransactionCommitted: return "transaction.committed";
  }
  return "transaction.committed";
}

Status invalid(std::string message) {
  return Status::failure(ErrorCode::kInvalidArgument, std::move(message));
}

Status revision_conflict(std::string message) {
  return Status::failure(ErrorCode::kRevisionConflict, std::move(message));
}

bool read_uint64(const Json& value, std::uint64_t& output) {
  if (value.is_number_unsigned()) {
    output = value.get<std::uint64_t>();
    return true;
  }
  if (value.is_number_integer()) {
    const auto signed_value = value.get<std::int64_t>();
    if (signed_value >= 0) {
      output = static_cast<std::uint64_t>(signed_value);
      return true;
    }
  }
  return false;
}

Status read_optional_bounded_string(
    const Json& source,
    const char* key,
    std::size_t maximum,
    std::string& output) {
  if (!source.contains(key)) return Status::success();
  if (!source[key].is_string()) return invalid(std::string{"context."} + key + " must be a string");
  const auto value = source[key].get<std::string>();
  if (value.size() > maximum) {
    return invalid(std::string{"context."} + key + " exceeds maximum length");
  }
  output = value;
  return Status::success();
}

CommitContextParseResult parse_commit_context(const Json& params) {
  persistence::CommitContext context;
  if (!params.contains("context") || params["context"].is_null()) {
    return {Status::success(), std::move(context)};
  }
  const auto& source = params["context"];
  if (!source.is_object()) return {invalid("commit context must be an object"), {}};

  if (source.contains("actor")) {
    if (!source["actor"].is_string()) return {invalid("context.actor must be a string"), {}};
    const auto actor = source["actor"].get<std::string>();
    if (actor == "user") context.actor = persistence::CommitActor::kUser;
    else if (actor == "ai_director") context.actor = persistence::CommitActor::kAiDirector;
    else if (actor == "system") context.actor = persistence::CommitActor::kSystem;
    else return {invalid("context.actor is unknown"), {}};
  }

  if (const auto status = read_optional_bounded_string(
          source, "source", kMaxContextSourceLength, context.source);
      !status.ok()) {
    return {status, {}};
  }
  if (const auto status = read_optional_bounded_string(
          source, "planId", kMaxContextPlanLength, context.plan_id);
      !status.ok()) {
    return {status, {}};
  }
  if (const auto status = read_optional_bounded_string(
          source, "reason", kMaxContextReasonLength, context.reason);
      !status.ok()) {
    return {status, {}};
  }
  return {Status::success(), std::move(context)};
}

std::vector<std::string> split_escaped_fields(std::string_view value) {
  std::vector<std::string> fields;
  std::string current;
  bool escaped = false;
  for (const char character : value) {
    if (escaped) {
      current.push_back(character);
      escaped = false;
      continue;
    }
    if (character == '\\') {
      escaped = true;
      continue;
    }
    if (character == '|') {
      fields.push_back(std::move(current));
      current.clear();
      continue;
    }
    current.push_back(character);
  }
  if (escaped) current.push_back('\\');
  fields.push_back(std::move(current));
  return fields;
}

ParsedProvenance parse_provenance(std::string_view detail) {
  ParsedProvenance result;
  if (!detail.starts_with("mwctx1|")) {
    result.event_detail = std::string{detail};
    return result;
  }

  const auto fields = split_escaped_fields(detail);
  if (fields.empty() || fields.front() != "mwctx1") {
    result.event_detail = std::string{detail};
    return result;
  }

  for (std::size_t index = 1; index < fields.size(); ++index) {
    const auto separator = fields[index].find('=');
    if (separator == std::string::npos) continue;
    const auto key = fields[index].substr(0, separator);
    const auto value = fields[index].substr(separator + 1);
    if (key == "actor") result.actor = value;
    else if (key == "source") result.source = value;
    else if (key == "plan") result.plan_id = value;
    else if (key == "reason") result.reason = value;
    else if (key == "event") result.event_detail = value;
  }
  if (result.actor != "user" && result.actor != "ai_director" && result.actor != "system") {
    result.actor = "system";
  }
  return result;
}

Json snapshot_json(const project::ProjectSnapshot& snapshot) {
  Json nodes = Json::array();
  for (const auto& node : snapshot.graph.nodes) {
    nodes.push_back(Json{{"id", node.id.value()},
                         {"kind", node_kind_name(node.kind)},
                         {"title", node.title},
                         {"metadata", node.metadata},
                         {"revision", node.revision},
                         {"approval", approval_name(node.approval)},
                         {"locked", node.locked},
                         {"stale", node.stale}});
  }

  Json dependencies = Json::array();
  for (const auto& edge : snapshot.graph.dependencies) {
    dependencies.push_back(
        Json{{"dependent", edge.dependent.value()}, {"dependency", edge.dependency.value()}});
  }

  return Json{{"schemaVersion", 1},
              {"projectRevision", snapshot.project_revision},
              {"nodes", std::move(nodes)},
              {"dependencies", std::move(dependencies)}};
}

Json event_json(
    const project::Event& event,
    const std::optional<std::string>& detail_override = std::nullopt) {
  Json affected = Json::array();
  for (const auto& id : event.affected) affected.push_back(id.value());
  Json item{{"type", event_type_name(event.type)},
            {"projectRevision", event.project_revision},
            {"affected", std::move(affected)}};
  if (!event.entity_id.empty()) item["entityId"] = event.entity_id.value();
  const auto& detail = detail_override.has_value() ? *detail_override : event.detail;
  if (!detail.empty()) item["detail"] = detail;
  return item;
}

Json events_json(const std::vector<project::Event>& events) {
  Json result = Json::array();
  for (const auto& event : events) result.push_back(event_json(event));
  return result;
}

Json history_json(const std::vector<project::Event>& events, std::size_t transaction_limit) {
  Json transactions = Json::array();
  Json current;
  std::uint64_t current_revision = 0;
  bool has_current = false;
  bool has_commit_marker = false;

  auto flush = [&]() {
    if (!has_current || !has_commit_marker || transactions.size() >= transaction_limit) return;
    transactions.push_back(std::move(current));
  };

  for (const auto& event : events) {
    if (!has_current || event.project_revision != current_revision) {
      flush();
      if (transactions.size() >= transaction_limit) break;
      current_revision = event.project_revision;
      current = Json{{"projectRevision", current_revision},
                     {"actor", "system"},
                     {"source", ""},
                     {"planId", ""},
                     {"reason", ""},
                     {"events", Json::array()}};
      has_current = true;
      has_commit_marker = false;
    }

    if (event.type == project::EventType::kTransactionCommitted) {
      has_commit_marker = true;
      const auto provenance = parse_provenance(event.detail);
      current["actor"] = provenance.actor;
      current["source"] = provenance.source;
      current["planId"] = provenance.plan_id;
      current["reason"] = provenance.reason;
      current["events"].push_back(event_json(event, provenance.event_detail));
    } else {
      current["events"].push_back(event_json(event));
    }
  }
  flush();
  return transactions;
}

Json ids_json(const std::vector<core::EntityId>& ids) {
  Json result = Json::array();
  for (const auto& id : ids) result.push_back(id.value());
  return result;
}

Json success_response(const std::string& id, Json result) {
  return Json{{"protocol", kProtocolVersion},
              {"id", id},
              {"ok", true},
              {"result", std::move(result)}};
}

Json failure_response(const std::string& id, const Status& status) {
  return Json{{"protocol", kProtocolVersion},
              {"id", id},
              {"ok", false},
              {"error", Json{{"code", error_code_name(status.code)}, {"message", status.message}}}};
}

CommandParseResult parse_command(const Json& input) {
  if (!input.is_object() || !input.contains("type") || !input["type"].is_string()) {
    return {invalid("command.type must be a string"), std::nullopt};
  }
  const auto type = input["type"].get<std::string>();

  if (type == "node.create") {
    if (!input.contains("node") || !input["node"].is_object()) {
      return {invalid("node.create requires node"), std::nullopt};
    }
    const auto& source = input["node"];
    if (!source.contains("id") || !source["id"].is_string() ||
        !source.contains("kind") || !source["kind"].is_string() ||
        !source.contains("title") || !source["title"].is_string()) {
      return {invalid("new node requires string id, kind, and title"), std::nullopt};
    }
    const auto kind = parse_node_kind(source["kind"].get<std::string>());
    if (!kind.has_value()) return {invalid("unknown node kind"), std::nullopt};

    project::Node node;
    node.id = core::EntityId{source["id"].get<std::string>()};
    node.kind = *kind;
    node.title = source["title"].get<std::string>();
    if (source.contains("metadata")) {
      if (!source["metadata"].is_object()) {
        return {invalid("node.metadata must be an object"), std::nullopt};
      }
      for (const auto& [key, value] : source["metadata"].items()) {
        if (!value.is_string()) {
          return {invalid("node metadata values must be strings"), std::nullopt};
        }
        node.metadata[key] = value.get<std::string>();
      }
    }
    if (source.contains("approval")) {
      if (!source["approval"].is_string()) {
        return {invalid("node.approval must be a string"), std::nullopt};
      }
      const auto approval = parse_approval(source["approval"].get<std::string>());
      if (!approval.has_value()) return {invalid("unknown approval state"), std::nullopt};
      node.approval = *approval;
    }
    if (source.contains("locked")) {
      if (!source["locked"].is_boolean()) {
        return {invalid("node.locked must be boolean"), std::nullopt};
      }
      node.locked = source["locked"].get<bool>();
    }
    if (source.contains("stale")) {
      if (!source["stale"].is_boolean()) {
        return {invalid("node.stale must be boolean"), std::nullopt};
      }
      node.stale = source["stale"].get<bool>();
    }
    return {Status::success(), project::Command{project::CreateNode{std::move(node)}}};
  }

  if (type == "node.patch") {
    if (!input.contains("id") || !input["id"].is_string()) {
      return {invalid("node.patch requires string id"), std::nullopt};
    }
    project::PatchNode patch;
    patch.id = core::EntityId{input["id"].get<std::string>()};
    if (input.contains("expectedRevision")) {
      std::uint64_t value = 0;
      if (!read_uint64(input["expectedRevision"], value)) {
        return {invalid("expectedRevision must be a non-negative integer"), std::nullopt};
      }
      patch.expected_revision = value;
    }
    if (input.contains("title")) {
      if (!input["title"].is_string()) return {invalid("title must be a string"), std::nullopt};
      patch.title = input["title"].get<std::string>();
    }
    if (input.contains("approval")) {
      if (!input["approval"].is_string()) {
        return {invalid("approval must be a string"), std::nullopt};
      }
      const auto approval = parse_approval(input["approval"].get<std::string>());
      if (!approval.has_value()) return {invalid("unknown approval state"), std::nullopt};
      patch.approval = *approval;
    }
    if (input.contains("metadataUpdates")) {
      if (!input["metadataUpdates"].is_object()) {
        return {invalid("metadataUpdates must be an object"), std::nullopt};
      }
      for (const auto& [key, value] : input["metadataUpdates"].items()) {
        if (!value.is_string()) {
          return {invalid("metadata update values must be strings"), std::nullopt};
        }
        patch.metadata_updates[key] = value.get<std::string>();
      }
    }
    if (input.contains("metadataRemovals")) {
      if (!input["metadataRemovals"].is_array()) {
        return {invalid("metadataRemovals must be an array"), std::nullopt};
      }
      for (const auto& value : input["metadataRemovals"]) {
        if (!value.is_string()) {
          return {invalid("metadata removal keys must be strings"), std::nullopt};
        }
        patch.metadata_removals.insert(value.get<std::string>());
      }
    }
    return {Status::success(), project::Command{std::move(patch)}};
  }

  if (type == "node.lock" || type == "node.markFresh" || type == "node.remove") {
    if (!input.contains("id") || !input["id"].is_string()) {
      return {invalid("node command requires string id"), std::nullopt};
    }
    std::optional<std::uint64_t> expected;
    if (input.contains("expectedRevision")) {
      std::uint64_t value = 0;
      if (!read_uint64(input["expectedRevision"], value)) {
        return {invalid("expectedRevision must be a non-negative integer"), std::nullopt};
      }
      expected = value;
    }
    const core::EntityId id{input["id"].get<std::string>()};
    if (type == "node.lock") {
      if (!input.contains("locked") || !input["locked"].is_boolean()) {
        return {invalid("node.lock requires boolean locked"), std::nullopt};
      }
      return {Status::success(),
              project::Command{project::SetLock{id, input["locked"].get<bool>(), expected}}};
    }
    if (type == "node.markFresh") {
      return {Status::success(), project::Command{project::MarkFresh{id, expected}}};
    }
    return {Status::success(), project::Command{project::RemoveNode{id, expected}}};
  }

  if (type == "dependency.add" || type == "dependency.remove") {
    if (!input.contains("dependent") || !input["dependent"].is_string() ||
        !input.contains("dependency") || !input["dependency"].is_string()) {
      return {invalid("dependency command requires string dependent and dependency"), std::nullopt};
    }
    const core::EntityId dependent{input["dependent"].get<std::string>()};
    const core::EntityId dependency{input["dependency"].get<std::string>()};
    if (type == "dependency.add") {
      return {Status::success(), project::Command{project::AddDependency{dependent, dependency}}};
    }
    return {Status::success(), project::Command{project::RemoveDependency{dependent, dependency}}};
  }

  return {invalid("unknown project command type"), std::nullopt};
}

SnapshotParseResult parse_snapshot(const Json& input) {
  if (!input.is_object() || !input.contains("schemaVersion") || input["schemaVersion"] != 1 ||
      !input.contains("projectRevision") ||
      !input.contains("nodes") || !input["nodes"].is_array() ||
      !input.contains("dependencies") || !input["dependencies"].is_array()) {
    return {invalid("snapshot must match protocol schema version 1"), {}};
  }
  if (input["nodes"].size() > kMaxSnapshotNodes) {
    return {invalid("snapshot exceeds maximum node count"), {}};
  }
  if (input["dependencies"].size() > kMaxSnapshotDependencies) {
    return {invalid("snapshot exceeds maximum dependency count"), {}};
  }

  project::ProjectSnapshot snapshot;
  if (!read_uint64(input["projectRevision"], snapshot.project_revision)) {
    return {invalid("projectRevision must be a non-negative integer"), {}};
  }

  for (const auto& source : input["nodes"]) {
    if (!source.is_object() || !source.contains("id") || !source["id"].is_string() ||
        !source.contains("kind") || !source["kind"].is_string() ||
        !source.contains("title") || !source["title"].is_string() ||
        !source.contains("revision") ||
        !source.contains("approval") || !source["approval"].is_string() ||
        !source.contains("locked") || !source["locked"].is_boolean() ||
        !source.contains("stale") || !source["stale"].is_boolean()) {
      return {invalid("snapshot contains malformed node"), {}};
    }

    const auto kind = parse_node_kind(source["kind"].get<std::string>());
    const auto approval = parse_approval(source["approval"].get<std::string>());
    std::uint64_t revision = 0;
    if (!kind.has_value() || !approval.has_value() ||
        !read_uint64(source["revision"], revision)) {
      return {invalid("snapshot node contains invalid enum or revision"), {}};
    }

    project::Node node;
    node.id = core::EntityId{source["id"].get<std::string>()};
    node.kind = *kind;
    node.title = source["title"].get<std::string>();
    node.revision = revision;
    node.approval = *approval;
    node.locked = source["locked"].get<bool>();
    node.stale = source["stale"].get<bool>();
    if (source.contains("metadata")) {
      if (!source["metadata"].is_object()) {
        return {invalid("snapshot metadata must be an object"), {}};
      }
      for (const auto& [key, value] : source["metadata"].items()) {
        if (!value.is_string()) {
          return {invalid("snapshot metadata values must be strings"), {}};
        }
        node.metadata[key] = value.get<std::string>();
      }
    }
    snapshot.graph.nodes.push_back(std::move(node));
  }

  for (const auto& source : input["dependencies"]) {
    if (!source.is_object() ||
        !source.contains("dependent") || !source["dependent"].is_string() ||
        !source.contains("dependency") || !source["dependency"].is_string()) {
      return {invalid("snapshot contains malformed dependency"), {}};
    }
    snapshot.graph.dependencies.push_back(project::DependencyEdge{
        core::EntityId{source["dependent"].get<std::string>()},
        core::EntityId{source["dependency"].get<std::string>()}});
  }
  return {Status::success(), std::move(snapshot)};
}

std::optional<Status> check_expected_project_revision(
    const Json& params,
    std::uint64_t live_revision,
    bool required) {
  if (!params.contains("expectedProjectRevision")) {
    if (required) return invalid("expectedProjectRevision is required");
    return std::nullopt;
  }
  std::uint64_t expected = 0;
  if (!read_uint64(params["expectedProjectRevision"], expected)) {
    return invalid("expectedProjectRevision must be a non-negative integer");
  }
  if (expected != live_revision) {
    return revision_conflict("project revision does not match expected revision");
  }
  return std::nullopt;
}

}  // namespace

std::string Dispatcher::handle(std::string_view request_line) {
  Json request = Json::parse(request_line, nullptr, false);
  if (request.is_discarded() || !request.is_object()) {
    return failure_response("", invalid("request must be valid JSON object")).dump();
  }

  std::string id;
  if (request.contains("id") && request["id"].is_string()) {
    id = request["id"].get<std::string>();
  }
  if (id.empty()) {
    return failure_response(id, invalid("request.id must be a non-empty string")).dump();
  }
  if (!request.contains("protocol") || request["protocol"] != kProtocolVersion) {
    return failure_response(
               id,
               Status::failure(
                   ErrorCode::kUnsupportedVersion,
                   "unsupported IPC protocol version"))
        .dump();
  }
  if (!request.contains("method") || !request["method"].is_string()) {
    return failure_response(id, invalid("request.method must be a string")).dump();
  }

  const auto method = request["method"].get<std::string>();
  const Json params = request.contains("params") ? request["params"] : Json::object();
  if (!params.is_object()) {
    return failure_response(id, invalid("request.params must be an object")).dump();
  }

  if (method == "health") {
    const auto snapshot = session_.snapshot();
    return success_response(
               id,
               Json{{"service", "makewatch-engine"},
                    {"protocolVersion", kProtocolVersion},
                    {"projectRevision", snapshot.project_revision},
                    {"nodeCount", snapshot.graph.nodes.size()}})
        .dump();
  }

  if (method == "project.snapshot") {
    return success_response(id, snapshot_json(session_.snapshot())).dump();
  }

  if (method == "project.impact") {
    if (!params.contains("source") || !params["source"].is_string()) {
      return failure_response(id, invalid("project.impact requires string source")).dump();
    }
    const auto report =
        session_.preview_impact(core::EntityId{params["source"].get<std::string>()});
    if (!report.ok()) return failure_response(id, report.status).dump();
    return success_response(
               id,
               Json{{"affected", ids_json(report.affected)},
                    {"locked", ids_json(report.locked)},
                    {"alreadyStale", ids_json(report.already_stale)}})
        .dump();
  }

  if (method == "project.history") {
    std::size_t transaction_limit = kDefaultHistoryTransactions;
    if (params.contains("limit")) {
      std::uint64_t requested = 0;
      if (!read_uint64(params["limit"], requested) || requested == 0 ||
          requested > kMaxHistoryTransactions) {
        return failure_response(
                   id,
                   invalid("project.history limit must be between 1 and 24"))
            .dump();
      }
      transaction_limit = static_cast<std::size_t>(requested);
    }
    const std::size_t event_budget =
        transaction_limit * kHistoryEventBudgetPerTransaction;
    auto history = session_.history(event_budget);
    if (!history.ok()) return failure_response(id, history.status).dump();
    return success_response(
               id,
               Json{{"transactions", history_json(history.events, transaction_limit)}})
        .dump();
  }

  if (method == "project.apply") {
    const auto live_revision = session_.snapshot().project_revision;
    if (const auto status =
            check_expected_project_revision(params, live_revision, false);
        status.has_value()) {
      return failure_response(id, *status).dump();
    }
    if (!params.contains("commands") || !params["commands"].is_array()) {
      return failure_response(id, invalid("project.apply requires commands array")).dump();
    }
    if (params["commands"].empty() ||
        params["commands"].size() > kMaxApplyCommands) {
      return failure_response(
                 id,
                 invalid(
                     "project.apply commands must contain between 1 and 128 items"))
          .dump();
    }
    auto parsed_context = parse_commit_context(params);
    if (!parsed_context.status.ok()) {
      return failure_response(id, parsed_context.status).dump();
    }

    std::vector<project::Command> commands;
    commands.reserve(params["commands"].size());
    for (const auto& input : params["commands"]) {
      auto parsed = parse_command(input);
      if (!parsed.status.ok() || !parsed.command.has_value()) {
        return failure_response(id, parsed.status).dump();
      }
      commands.push_back(std::move(*parsed.command));
    }

    auto result = session_.apply_batch(commands, parsed_context.context);
    if (!result.ok()) return failure_response(id, result.status).dump();
    return success_response(
               id,
               Json{{"projectRevision", result.project_revision},
                    {"events", events_json(result.events)},
                    {"snapshot", snapshot_json(session_.snapshot())}})
        .dump();
  }

  if (method == "project.restore") {
    const auto live_revision = session_.snapshot().project_revision;
    if (const auto status =
            check_expected_project_revision(params, live_revision, true);
        status.has_value()) {
      return failure_response(id, *status).dump();
    }
    if (!params.contains("snapshot")) {
      return failure_response(id, invalid("project.restore requires snapshot")).dump();
    }
    auto parsed_context = parse_commit_context(params);
    if (!parsed_context.status.ok()) {
      return failure_response(id, parsed_context.status).dump();
    }
    auto parsed = parse_snapshot(params["snapshot"]);
    if (!parsed.status.ok()) return failure_response(id, parsed.status).dump();

    auto result =
        session_.restore(parsed.snapshot, live_revision, parsed_context.context);
    if (!result.ok()) return failure_response(id, result.status).dump();
    return success_response(
               id,
               Json{{"projectRevision", result.project_revision},
                    {"events", events_json(result.events)},
                    {"snapshot", snapshot_json(session_.snapshot())}})
        .dump();
  }

  if (method == "project.replace") {
    if (!params.contains("snapshot")) {
      return failure_response(id, invalid("project.replace requires snapshot")).dump();
    }
    auto parsed = parse_snapshot(params["snapshot"]);
    if (!parsed.status.ok()) return failure_response(id, parsed.status).dump();
    if (const auto status = session_.replace(parsed.snapshot); !status.ok()) {
      return failure_response(id, status).dump();
    }
    return success_response(id, snapshot_json(session_.snapshot())).dump();
  }

  return failure_response(
             id,
             Status::failure(ErrorCode::kNotFound, "unknown IPC method"))
      .dump();
}

}  // namespace makewatch::ipc
