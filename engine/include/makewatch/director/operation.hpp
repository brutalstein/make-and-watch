#pragma once

#include <cstdint>
#include <string>

#include "makewatch/core/id.hpp"

namespace makewatch::director {

enum class OperationType {
  kSceneUpdate,
  kSceneApprove,
  kSceneLock,
  kShotUpdate,
  kShotApprove,
  kShotLock,
  kVoiceUpdate,
  kCameraUpdate,
};

enum class EntityType {
  kScene,
  kShot,
  kCharacter,
};

enum class RequestedBy {
  kUser,
  kDirector,
  kSystem,
};

struct OperationTarget final {
  EntityType entity_type{EntityType::kScene};
  core::EntityId entity_id;
};

struct DirectorOperation final {
  std::uint32_t schema_version{1};
  std::string operation_id;
  OperationType type{OperationType::kSceneUpdate};
  OperationTarget target;
  std::string payload_json{"{}"};
  std::string reason;
  RequestedBy requested_by{RequestedBy::kDirector};
};

}  // namespace makewatch::director
