#include "worker_process.hpp"

#include <algorithm>
#include <cstring>
#include <mutex>
#include <utility>

namespace makewatch::runtime::detail {
namespace {

constexpr std::string_view kReadyPrefix = "MW_READY_V1\t";
constexpr std::size_t kMaxHandshakeLineBytes = 8192;
constexpr std::size_t kMaxWorkerNameBytes = 128;
constexpr std::size_t kMaxCapabilityBytes = 96;
constexpr std::size_t kMaxCapabilities = 32;

class BoundedByteTail final {
 public:
  explicit BoundedByteTail(std::size_t capacity)
      : storage_(capacity == 0 ? 1 : capacity), capacity_(capacity) {}

  void append(std::string_view bytes) {
    if (bytes.empty()) return;
    if (capacity_ == 0) {
      dropped_ += static_cast<std::uint64_t>(bytes.size());
      return;
    }

    if (bytes.size() >= capacity_) {
      dropped_ += static_cast<std::uint64_t>(size_ + bytes.size() - capacity_);
      const auto tail = bytes.substr(bytes.size() - capacity_);
      std::memcpy(storage_.data(), tail.data(), capacity_);
      begin_ = 0;
      size_ = capacity_;
      return;
    }

    const std::size_t free = capacity_ - size_;
    if (bytes.size() > free) {
      const std::size_t overwritten = bytes.size() - free;
      begin_ = (begin_ + overwritten) % capacity_;
      size_ -= overwritten;
      dropped_ += static_cast<std::uint64_t>(overwritten);
    }

    const std::size_t write_begin = (begin_ + size_) % capacity_;
    const std::size_t first = std::min(bytes.size(), capacity_ - write_begin);
    std::memcpy(storage_.data() + write_begin, bytes.data(), first);
    const std::size_t second = bytes.size() - first;
    if (second > 0) std::memcpy(storage_.data(), bytes.data() + first, second);
    size_ += bytes.size();
  }

  [[nodiscard]] std::string snapshot() const {
    std::string result(size_, '\0');
    if (size_ == 0) return result;
    const std::size_t first = std::min(size_, capacity_ - begin_);
    std::memcpy(result.data(), storage_.data() + begin_, first);
    const std::size_t second = size_ - first;
    if (second > 0) std::memcpy(result.data() + first, storage_.data(), second);
    return result;
  }

  [[nodiscard]] std::uint64_t dropped_bytes() const noexcept { return dropped_; }

 private:
  std::vector<char> storage_;
  std::size_t capacity_{0};
  std::size_t begin_{0};
  std::size_t size_{0};
  std::uint64_t dropped_{0};
};

bool safe_protocol_token(std::string_view token, std::size_t max_size) {
  if (token.empty() || token.size() > max_size) return false;
  return std::all_of(token.begin(), token.end(), [](unsigned char character) {
    return (character >= 'a' && character <= 'z') ||
           (character >= 'A' && character <= 'Z') ||
           (character >= '0' && character <= '9') ||
           character == '.' || character == '_' || character == '-' ||
           character == ':' || character == '/';
  });
}

std::optional<WorkerReadyHandshake> parse_ready_line(
    std::string_view line,
    std::string& error) {
  if (!line.starts_with(kReadyPrefix)) return std::nullopt;

  const auto payload = line.substr(kReadyPrefix.size());
  const auto separator = payload.find('\t');
  if (separator == std::string_view::npos) {
    error = "worker ready handshake must contain worker name and capability field";
    return std::nullopt;
  }

  const auto worker_name = payload.substr(0, separator);
  if (!safe_protocol_token(worker_name, kMaxWorkerNameBytes)) {
    error = "worker ready handshake contains an invalid worker name";
    return std::nullopt;
  }

  std::vector<std::string> capabilities;
  auto remaining = payload.substr(separator + 1);
  while (!remaining.empty()) {
    const auto comma = remaining.find(',');
    const auto token = comma == std::string_view::npos ? remaining : remaining.substr(0, comma);
    if (!safe_protocol_token(token, kMaxCapabilityBytes)) {
      error = "worker ready handshake contains an invalid capability token";
      return std::nullopt;
    }
    capabilities.emplace_back(token);
    if (capabilities.size() > kMaxCapabilities) {
      error = "worker ready handshake exceeds the capability-count bound";
      return std::nullopt;
    }
    if (comma == std::string_view::npos) break;
    remaining.remove_prefix(comma + 1);
    if (remaining.empty()) {
      error = "worker ready handshake contains an empty trailing capability";
      return std::nullopt;
    }
  }

  std::sort(capabilities.begin(), capabilities.end());
  capabilities.erase(std::unique(capabilities.begin(), capabilities.end()), capabilities.end());
  return WorkerReadyHandshake{std::string(worker_name), std::move(capabilities)};
}

}  // namespace

class OutputCapture::Impl final {
 public:
  Impl(std::size_t stdout_capacity, std::size_t stderr_capacity)
      : stdout_tail(stdout_capacity), stderr_tail(stderr_capacity) {}

  void append_stdout(std::string_view bytes) {
    std::scoped_lock lock(mutex);
    stdout_tail.append(bytes);
    if (ready.has_value() || ready_error.has_value()) return;

    for (const char character : bytes) {
      if (line_overflow) {
        if (character == '\n') {
          line_overflow = false;
          line.clear();
        }
        continue;
      }
      if (character == '\n') {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        std::string parse_error;
        auto parsed = parse_ready_line(line, parse_error);
        if (parsed.has_value()) ready = std::move(parsed);
        else if (!parse_error.empty()) ready_error = std::move(parse_error);
        line.clear();
        if (ready.has_value() || ready_error.has_value()) return;
        continue;
      }
      if (line.size() >= kMaxHandshakeLineBytes) {
        if (line.starts_with(kReadyPrefix.substr(0, std::min(line.size(), kReadyPrefix.size())))) {
          ready_error = "worker ready handshake line exceeds the 8 KiB bound";
          line.clear();
          return;
        }
        line_overflow = true;
        line.clear();
        continue;
      }
      line.push_back(character);
    }
  }

  mutable std::mutex mutex;
  BoundedByteTail stdout_tail;
  BoundedByteTail stderr_tail;
  std::string line;
  bool line_overflow{false};
  std::optional<WorkerReadyHandshake> ready;
  std::optional<std::string> ready_error;
};

OutputCapture::OutputCapture(std::size_t stdout_capacity, std::size_t stderr_capacity)
    : impl_(std::make_unique<Impl>(stdout_capacity, stderr_capacity)) {}
OutputCapture::~OutputCapture() = default;
void OutputCapture::append_stdout(std::string_view bytes) { impl_->append_stdout(bytes); }
void OutputCapture::append_stderr(std::string_view bytes) {
  std::scoped_lock lock(impl_->mutex);
  impl_->stderr_tail.append(bytes);
}
std::optional<WorkerReadyHandshake> OutputCapture::ready_handshake() const {
  std::scoped_lock lock(impl_->mutex);
  return impl_->ready;
}
std::optional<std::string> OutputCapture::handshake_error() const {
  std::scoped_lock lock(impl_->mutex);
  return impl_->ready_error;
}
std::string OutputCapture::stdout_tail() const {
  std::scoped_lock lock(impl_->mutex);
  return impl_->stdout_tail.snapshot();
}
std::string OutputCapture::stderr_tail() const {
  std::scoped_lock lock(impl_->mutex);
  return impl_->stderr_tail.snapshot();
}
std::uint64_t OutputCapture::stdout_dropped_bytes() const {
  std::scoped_lock lock(impl_->mutex);
  return impl_->stdout_tail.dropped_bytes();
}
std::uint64_t OutputCapture::stderr_dropped_bytes() const {
  std::scoped_lock lock(impl_->mutex);
  return impl_->stderr_tail.dropped_bytes();
}

}  // namespace makewatch::runtime::detail
