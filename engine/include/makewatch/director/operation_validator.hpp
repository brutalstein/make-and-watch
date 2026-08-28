#pragma once

#include "makewatch/core/validation.hpp"
#include "makewatch/director/operation.hpp"

namespace makewatch::director {

class OperationValidator final {
 public:
  [[nodiscard]] static core::ValidationResult validate(const DirectorOperation& operation);
};

}  // namespace makewatch::director
