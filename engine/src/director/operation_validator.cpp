#include "makewatch/director/operation_validator.hpp"

#include <string_view>

namespace makewatch::director {
namespace {

[[nodiscard]] bool target_is_compatible(OperationType type, EntityType entity_type) noexcept {
  switch (type) {
    case OperationType::kSceneUpdate:
    case OperationType::kSceneApprove:
    case OperationType::kSceneLock:
      return entity_type == EntityType::kScene;
    case OperationType::kShotUpdate:
    case OperationType::kShotApprove:
    case OperationType::kShotLock:
    case OperationType::kCameraUpdate:
      return entity_type == EntityType::kShot;
    case OperationType::kVoiceUpdate:
      return entity_type == EntityType::kCharacter || entity_type == EntityType::kShot;
  }

  return false;
}

}  // namespace

core::ValidationResult OperationValidator::validate(const DirectorOperation& operation) {
  core::ValidationResult result;

  if (operation.schema_version != 1U) {
    result.add("unsupported_schema_version", "Director operation schema version is not supported.");
  }

  if (operation.operation_id.size() < 8U || operation.operation_id.size() > 128U) {
    result.add("invalid_operation_id", "Operation id must contain between 8 and 128 characters.");
  }

  if (operation.target.entity_id.empty()) {
    result.add("missing_target", "Director operation requires a target entity id.");
  }

  if (!target_is_compatible(operation.type, operation.target.entity_type)) {
    result.add("incompatible_target", "Operation type is incompatible with the target entity type.");
  }

  if (operation.payload_json.empty()) {
    result.add("missing_payload", "Director operation payload must be present, even when empty JSON is intended.");
  }

  if (operation.reason.size() > 2000U) {
    result.add("reason_too_long", "Director operation reason exceeds the contract limit.");
  }

  return result;
}

}  // namespace makewatch::director
