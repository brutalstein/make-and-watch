#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "makewatch/core/status.hpp"
#include "makewatch/runtime/worker_supervisor.hpp"

namespace makewatch::runtime::detail {

struct WorkerReadyHandshake final {
  std::string worker_name;
  std::vector<std::string> capabilities;
};

class OutputCapture final {
 public:
  OutputCapture(std::size_t stdout_capacity, std::size_t stderr_capacity);
  ~OutputCapture();

  OutputCapture(const OutputCapture&) = delete;
  OutputCapture& operator=(const OutputCapture&) = delete;

  void append_stdout(std::string_view bytes);
  void append_stderr(std::string_view bytes);

  [[nodiscard]] std::optional<WorkerReadyHandshake> ready_handshake() const;
  [[nodiscard]] std::optional<std::string> handshake_error() const;
  [[nodiscard]] std::string stdout_tail() const;
  [[nodiscard]] std::string stderr_tail() const;
  [[nodiscard]] std::uint64_t stdout_dropped_bytes() const;
  [[nodiscard]] std::uint64_t stderr_dropped_bytes() const;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

struct ProcessObservation final {
  bool leader_exited{false};
  bool tree_exited{false};
  std::optional<std::int64_t> exit_code;
};

struct SpawnNativeProcessResult final {
  core::Status status;
  std::unique_ptr<class NativeProcess> process;

  [[nodiscard]] bool ok() const noexcept { return status.ok(); }
};

class NativeProcess final {
 public:
  ~NativeProcess() noexcept;

  NativeProcess(const NativeProcess&) = delete;
  NativeProcess& operator=(const NativeProcess&) = delete;
  NativeProcess(NativeProcess&&) = delete;
  NativeProcess& operator=(NativeProcess&&) = delete;

  [[nodiscard]] static SpawnNativeProcessResult spawn(
      const WorkerLaunchSpec& spec,
      std::shared_ptr<OutputCapture> capture);

  [[nodiscard]] std::uint64_t process_id() const noexcept;
  [[nodiscard]] ProcessObservation observe() noexcept;
  [[nodiscard]] core::Status request_graceful_stop() noexcept;
  [[nodiscard]] core::Status terminate_tree() noexcept;
  [[nodiscard]] core::Status hard_kill_tree() noexcept;
  [[nodiscard]] bool emergency_kill_and_wait() noexcept;

 private:
  class Impl;
  explicit NativeProcess(std::unique_ptr<Impl> impl) noexcept;
  std::unique_ptr<Impl> impl_;
};

}  // namespace makewatch::runtime::detail
