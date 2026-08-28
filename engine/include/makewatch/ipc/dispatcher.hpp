#pragma once

#include <string>
#include <string_view>

#include "makewatch/application/project_session.hpp"

namespace makewatch::ipc {

inline constexpr int kProtocolVersion = 1;

class Dispatcher final {
 public:
  explicit Dispatcher(application::ProjectSession& session) : session_(session) {}

  [[nodiscard]] std::string handle(std::string_view request_line);

 private:
  application::ProjectSession& session_;
};

}  // namespace makewatch::ipc
