#pragma once

#include <string>
#include <string_view>

namespace makewatch::core {

class EntityId final {
 public:
  EntityId() = default;
  explicit EntityId(std::string value) : value_(std::move(value)) {}

  [[nodiscard]] const std::string& value() const noexcept { return value_; }
  [[nodiscard]] bool empty() const noexcept { return value_.empty(); }

  friend bool operator==(const EntityId&, const EntityId&) = default;

 private:
  std::string value_;
};

}  // namespace makewatch::core
