#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include "makewatch/director/operation.hpp"

namespace makewatch::director {

enum class ConnectionState {
  kDisconnected,
  kAuthenticationRequired,
  kReady,
  kUnavailable,
};

struct ProviderDescriptor final {
  std::string id;
  std::string display_name;
  bool uses_official_local_client{false};
  bool supports_structured_operations{false};
};

struct DirectorRequest final {
  std::string project_context_json;
  std::string instruction;
  std::string response_contract_json;
};

struct DirectorProposal final {
  std::string summary;
  std::vector<DirectorOperation> operations;
};

struct DirectorError final {
  std::string code;
  std::string message;
  bool retryable{false};
};

using DirectorResponse = std::variant<DirectorProposal, DirectorError>;

class DirectorProvider {
 public:
  virtual ~DirectorProvider() = default;

  [[nodiscard]] virtual ProviderDescriptor descriptor() const = 0;
  [[nodiscard]] virtual ConnectionState connection_state() const = 0;

  // Authentication remains provider-owned. Implementations that bridge an
  // official local client may launch that client's supported login flow but
  // must not extract, persist, or repurpose subscription OAuth credentials.
  virtual void request_connection() = 0;

  [[nodiscard]] virtual DirectorResponse propose(const DirectorRequest& request) = 0;
};

}  // namespace makewatch::director
