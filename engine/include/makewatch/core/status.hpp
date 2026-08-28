#pragma once

#include <string>
#include <utility>

namespace makewatch::core {

enum class ErrorCode {
  kNone,
  kInvalidArgument,
  kAlreadyExists,
  kNotFound,
  kLocked,
  kRevisionConflict,
  kCycleDetected,
};

struct Status final {
  ErrorCode code{ErrorCode::kNone};
  std::string message;

  [[nodiscard]] bool ok() const noexcept { return code == ErrorCode::kNone; }

  [[nodiscard]] static Status success() { return {}; }

  [[nodiscard]] static Status failure(ErrorCode error_code, std::string error_message) {
    return Status{error_code, std::move(error_message)};
  }
};

}  // namespace makewatch::core
