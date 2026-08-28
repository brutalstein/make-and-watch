#pragma once

#include <string>
#include <vector>

namespace makewatch::core {

struct ValidationIssue final {
  std::string code;
  std::string message;
};

struct ValidationResult final {
  std::vector<ValidationIssue> issues;

  [[nodiscard]] bool ok() const noexcept { return issues.empty(); }

  void add(std::string code, std::string message) {
    issues.push_back(ValidationIssue{std::move(code), std::move(message)});
  }
};

}  // namespace makewatch::core
