#include <cstdlib>
#include <iostream>
#include <variant>

#include "makewatch/director/operation_validator.hpp"
#include "makewatch/director/provider.hpp"

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << "FAILED: " << message << '\n';
    std::exit(EXIT_FAILURE);
  }
}

}  // namespace

int main() {
  using makewatch::core::EntityId;
  using makewatch::director::DirectorError;
  using makewatch::director::DirectorOperation;
  using makewatch::director::DirectorResponse;
  using makewatch::director::EntityType;
  using makewatch::director::OperationTarget;
  using makewatch::director::OperationType;
  using makewatch::director::OperationValidator;

  DirectorOperation valid;
  valid.operation_id = "operation-0001";
  valid.type = OperationType::kSceneUpdate;
  valid.target = OperationTarget{EntityType::kScene, EntityId{"scene-01"}};
  valid.payload_json = R"({"summary":"A quieter opening"})";
  require(OperationValidator::validate(valid).ok(), "valid operation should pass");

  DirectorOperation wrong_target = valid;
  wrong_target.target = OperationTarget{EntityType::kCharacter, EntityId{"mira"}};
  require(!OperationValidator::validate(wrong_target).ok(), "incompatible target should fail");

  DirectorOperation missing_id = valid;
  missing_id.operation_id.clear();
  require(!OperationValidator::validate(missing_id).ok(), "missing operation id should fail");

  DirectorResponse response = DirectorError{"unavailable", "Provider is unavailable.", true};
  require(std::holds_alternative<DirectorError>(response), "director response error contract should compile");

  std::cout << "makewatch_engine_tests: OK\n";
  return EXIT_SUCCESS;
}
