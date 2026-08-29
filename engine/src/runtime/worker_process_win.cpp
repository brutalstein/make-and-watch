#ifdef _WIN32

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0602
#endif
#define NOMINMAX
#include <Windows.h>

#include "worker_process.hpp"

#include <array>
#include <chrono>
#include <cstddef>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace makewatch::runtime::detail {
namespace {

constexpr std::string_view kStopLine = "MW_STOP_V1\n";

std::string narrow_windows_error(DWORD code) {
  LPWSTR buffer = nullptr;
  const DWORD flags = FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
                      FORMAT_MESSAGE_IGNORE_INSERTS;
  const DWORD length = FormatMessageW(
      flags, nullptr, code, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
      reinterpret_cast<LPWSTR>(&buffer), 0, nullptr);
  if (length == 0 || buffer == nullptr) return "Windows error " + std::to_string(code);

  const int utf8_length = WideCharToMultiByte(
      CP_UTF8, 0, buffer, static_cast<int>(length), nullptr, 0, nullptr, nullptr);
  std::string result;
  if (utf8_length > 0) {
    result.resize(static_cast<std::size_t>(utf8_length));
    WideCharToMultiByte(
        CP_UTF8, 0, buffer, static_cast<int>(length), result.data(), utf8_length,
        nullptr, nullptr);
  } else {
    result = "Windows error " + std::to_string(code);
  }
  LocalFree(buffer);
  while (!result.empty() && (result.back() == '\r' || result.back() == '\n')) {
    result.pop_back();
  }
  return result;
}

core::Status windows_error(std::string prefix, DWORD code = GetLastError()) {
  prefix += ": ";
  prefix += narrow_windows_error(code);
  return core::Status::failure(core::ErrorCode::kIoError, std::move(prefix));
}

void close_handle(HANDLE& handle) noexcept {
  if (handle != nullptr && handle != INVALID_HANDLE_VALUE) {
    CloseHandle(handle);
    handle = nullptr;
  }
}

std::optional<std::wstring> utf8_to_wide(std::string_view text) {
  if (text.empty()) return std::wstring{};
  const int size = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
  if (size <= 0) return std::nullopt;
  std::wstring result(static_cast<std::size_t>(size), L'\0');
  if (MultiByteToWideChar(
          CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()),
          result.data(), size) <= 0) {
    return std::nullopt;
  }
  return result;
}

std::wstring quote_windows_argument(std::wstring_view argument) {
  if (argument.empty()) return L"\"\"";
  const bool needs_quotes = argument.find_first_of(L" \t\n\v\"") != std::wstring_view::npos;
  if (!needs_quotes) return std::wstring(argument);

  std::wstring result;
  result.push_back(L'\"');
  std::size_t backslashes = 0;
  for (const wchar_t character : argument) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'\"') {
      result.append(backslashes * 2 + 1, L'\\');
      result.push_back(L'\"');
      backslashes = 0;
      continue;
    }
    result.append(backslashes, L'\\');
    backslashes = 0;
    result.push_back(character);
  }
  result.append(backslashes * 2, L'\\');
  result.push_back(L'\"');
  return result;
}

void windows_reader(HANDLE handle, std::shared_ptr<OutputCapture> capture, bool stdout_stream) {
  std::array<char, 4096> buffer{};
  for (;;) {
    DWORD bytes_read = 0;
    if (!ReadFile(handle, buffer.data(), static_cast<DWORD>(buffer.size()), &bytes_read, nullptr)) {
      const DWORD error = GetLastError();
      if (error == ERROR_BROKEN_PIPE || error == ERROR_HANDLE_EOF) break;
      break;
    }
    if (bytes_read == 0) break;
    const std::string_view chunk(buffer.data(), static_cast<std::size_t>(bytes_read));
    if (stdout_stream) capture->append_stdout(chunk);
    else capture->append_stderr(chunk);
  }
  CloseHandle(handle);
}

}  // namespace

class NativeProcess::Impl final {
 public:
  explicit Impl(std::shared_ptr<OutputCapture> output_capture)
      : capture(std::move(output_capture)) {}
  ~Impl() noexcept { (void)emergency_kill_and_wait(); }

  [[nodiscard]] bool emergency_kill_and_wait() noexcept {
    if (job != nullptr) (void)TerminateJobObject(job, 0xE0000001U);
    else if (process != nullptr) (void)TerminateProcess(process, 0xE0000001U);

    bool confirmed = process == nullptr;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (!confirmed && std::chrono::steady_clock::now() < deadline) {
      if (job != nullptr) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
        if (QueryInformationJobObject(
                job, JobObjectBasicAccountingInformation, &accounting,
                sizeof(accounting), nullptr) &&
            accounting.ActiveProcesses == 0) {
          confirmed = true;
          break;
        }
      } else if (process != nullptr && WaitForSingleObject(process, 0) == WAIT_OBJECT_0) {
        confirmed = true;
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    close_handle(stdin_write);
    close_handle(process);
    close_handle(job);
    return confirmed;
  }

  std::shared_ptr<OutputCapture> capture;
  std::jthread stdout_reader;
  std::jthread stderr_reader;
  bool leader_exited{false};
  std::optional<std::int64_t> exit_code;
  HANDLE process{nullptr};
  HANDLE job{nullptr};
  HANDLE stdin_write{nullptr};
  DWORD pid{0};
};

NativeProcess::NativeProcess(std::unique_ptr<Impl> impl) noexcept : impl_(std::move(impl)) {}
NativeProcess::~NativeProcess() noexcept = default;

SpawnNativeProcessResult NativeProcess::spawn(
    const WorkerLaunchSpec& spec,
    std::shared_ptr<OutputCapture> capture) {
  SECURITY_ATTRIBUTES security{};
  security.nLength = sizeof(security);
  security.bInheritHandle = TRUE;

  HANDLE stdin_read = nullptr;
  HANDLE stdin_write = nullptr;
  HANDLE stdout_read = nullptr;
  HANDLE stdout_write = nullptr;
  HANDLE stderr_read = nullptr;
  HANDLE stderr_write = nullptr;

  auto cleanup = [&]() noexcept {
    close_handle(stdin_read);
    close_handle(stdin_write);
    close_handle(stdout_read);
    close_handle(stdout_write);
    close_handle(stderr_read);
    close_handle(stderr_write);
  };

  if (!CreatePipe(&stdin_read, &stdin_write, &security, 0) ||
      !CreatePipe(&stdout_read, &stdout_write, &security, 0) ||
      !CreatePipe(&stderr_read, &stderr_write, &security, 0)) {
    const auto status = windows_error("failed to create worker stdio pipes");
    cleanup();
    return {status, nullptr};
  }
  if (!SetHandleInformation(stdin_write, HANDLE_FLAG_INHERIT, 0) ||
      !SetHandleInformation(stdout_read, HANDLE_FLAG_INHERIT, 0) ||
      !SetHandleInformation(stderr_read, HANDLE_FLAG_INHERIT, 0)) {
    const auto status = windows_error("failed to isolate worker parent pipe handles");
    cleanup();
    return {status, nullptr};
  }

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) {
    const auto status = windows_error("failed to create worker Job Object");
    cleanup();
    return {status, nullptr};
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    const auto status = windows_error("failed to configure worker Job Object");
    CloseHandle(job);
    cleanup();
    return {status, nullptr};
  }

  SIZE_T attribute_bytes = 0;
  (void)InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_bytes);
  std::vector<std::byte> attribute_storage(attribute_bytes);
  auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_bytes)) {
    const auto status = windows_error("failed to initialize worker process attributes");
    CloseHandle(job);
    cleanup();
    return {status, nullptr};
  }
  HANDLE inherited_handles[] = {stdin_read, stdout_write, stderr_write};
  if (!UpdateProcThreadAttribute(
          attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited_handles,
          sizeof(inherited_handles), nullptr, nullptr)) {
    const auto status = windows_error("failed to restrict worker inherited handles");
    DeleteProcThreadAttributeList(attributes);
    CloseHandle(job);
    cleanup();
    return {status, nullptr};
  }

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = stdin_read;
  startup.StartupInfo.hStdOutput = stdout_write;
  startup.StartupInfo.hStdError = stderr_write;
  startup.lpAttributeList = attributes;

  PROCESS_INFORMATION process_info{};
  const auto executable = spec.executable.wstring();
  std::wstring command_line = quote_windows_argument(executable);
  for (const auto& argument_utf8 : spec.arguments) {
    const auto wide = utf8_to_wide(argument_utf8);
    if (!wide.has_value()) {
      DeleteProcThreadAttributeList(attributes);
      CloseHandle(job);
      cleanup();
      return {core::Status::failure(
                  core::ErrorCode::kInvalidArgument, "worker argument is not valid UTF-8"),
              nullptr};
    }
    command_line.push_back(L' ');
    command_line += quote_windows_argument(*wide);
  }
  std::vector<wchar_t> command_buffer(command_line.begin(), command_line.end());
  command_buffer.push_back(L'\0');

  std::optional<std::wstring> working_directory;
  if (spec.working_directory.has_value()) working_directory = spec.working_directory->wstring();

  constexpr DWORD creation_flags = CREATE_NO_WINDOW | CREATE_SUSPENDED |
                                   EXTENDED_STARTUPINFO_PRESENT;
  const BOOL created = CreateProcessW(
      executable.c_str(), command_buffer.data(), nullptr, nullptr, TRUE, creation_flags,
      nullptr, working_directory.has_value() ? working_directory->c_str() : nullptr,
      &startup.StartupInfo, &process_info);
  const DWORD create_error = created ? ERROR_SUCCESS : GetLastError();
  DeleteProcThreadAttributeList(attributes);
  close_handle(stdin_read);
  close_handle(stdout_write);
  close_handle(stderr_write);

  if (!created) {
    CloseHandle(job);
    close_handle(stdin_write);
    close_handle(stdout_read);
    close_handle(stderr_read);
    return {windows_error("failed to create worker process", create_error), nullptr};
  }

  if (!AssignProcessToJobObject(job, process_info.hProcess)) {
    const auto status = windows_error("failed to assign worker to isolated Job Object");
    (void)TerminateProcess(process_info.hProcess, 0xE0000002U);
    (void)ResumeThread(process_info.hThread);
    (void)WaitForSingleObject(process_info.hProcess, 5000);
    close_handle(process_info.hThread);
    close_handle(process_info.hProcess);
    CloseHandle(job);
    close_handle(stdin_write);
    close_handle(stdout_read);
    close_handle(stderr_read);
    return {status, nullptr};
  }

  if (ResumeThread(process_info.hThread) == static_cast<DWORD>(-1)) {
    const auto status = windows_error("failed to resume isolated worker process");
    (void)TerminateJobObject(job, 0xE0000003U);
    (void)WaitForSingleObject(process_info.hProcess, 5000);
    close_handle(process_info.hThread);
    close_handle(process_info.hProcess);
    CloseHandle(job);
    close_handle(stdin_write);
    close_handle(stdout_read);
    close_handle(stderr_read);
    return {status, nullptr};
  }
  close_handle(process_info.hThread);

  try {
    auto impl = std::make_unique<Impl>(std::move(capture));
    impl->process = std::exchange(process_info.hProcess, nullptr);
    impl->job = std::exchange(job, nullptr);
    impl->stdin_write = std::exchange(stdin_write, nullptr);
    impl->pid = process_info.dwProcessId;
    impl->stdout_reader = std::jthread(windows_reader, stdout_read, impl->capture, true);
    stdout_read = nullptr;
    impl->stderr_reader = std::jthread(windows_reader, stderr_read, impl->capture, false);
    stderr_read = nullptr;
    return {core::Status::success(),
            std::unique_ptr<NativeProcess>(new NativeProcess(std::move(impl)))};
  } catch (...) {
    if (job != nullptr) (void)TerminateJobObject(job, 0xE0000004U);
    else if (process_info.hProcess != nullptr) {
      (void)TerminateProcess(process_info.hProcess, 0xE0000004U);
    }
    if (process_info.hProcess != nullptr) (void)WaitForSingleObject(process_info.hProcess, 5000);
    close_handle(process_info.hProcess);
    close_handle(job);
    close_handle(stdin_write);
    close_handle(stdout_read);
    close_handle(stderr_read);
    throw;
  }
}

std::uint64_t NativeProcess::process_id() const noexcept {
  return impl_ ? static_cast<std::uint64_t>(impl_->pid) : 0;
}

ProcessObservation NativeProcess::observe() noexcept {
  if (!impl_) return {.leader_exited = true, .tree_exited = true, .exit_code = std::nullopt};
  if (!impl_->leader_exited && impl_->process != nullptr &&
      WaitForSingleObject(impl_->process, 0) == WAIT_OBJECT_0) {
    DWORD code = 0;
    if (GetExitCodeProcess(impl_->process, &code)) {
      impl_->exit_code = static_cast<std::int64_t>(code);
    }
    impl_->leader_exited = true;
  }

  bool tree_exited = impl_->leader_exited;
  if (impl_->job != nullptr) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (QueryInformationJobObject(
            impl_->job, JobObjectBasicAccountingInformation, &accounting,
            sizeof(accounting), nullptr)) {
      tree_exited = accounting.ActiveProcesses == 0;
    } else {
      tree_exited = false;
    }
  }

  // Job accounting can report zero active processes before the asynchronous
  // stdout/stderr reader threads have consumed the final bytes already buffered
  // in the anonymous pipes. Once the owned process tree is confirmed exited,
  // every inherited write handle is closed, so joining here deterministically
  // drains EOF without waiting on a live worker. This guarantees that a valid
  // MW_READY_V1 line from a very short-lived worker is visible before the
  // supervisor classifies its exit.
  if (tree_exited) {
    if (impl_->stdout_reader.joinable()) impl_->stdout_reader.join();
    if (impl_->stderr_reader.joinable()) impl_->stderr_reader.join();
  }
  return {impl_->leader_exited, tree_exited, impl_->exit_code};
}

core::Status NativeProcess::request_graceful_stop() noexcept {
  if (!impl_ || impl_->stdin_write == nullptr) return core::Status::success();
  DWORD written = 0;
  const BOOL ok = WriteFile(
      impl_->stdin_write, kStopLine.data(), static_cast<DWORD>(kStopLine.size()),
      &written, nullptr);
  const DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  close_handle(impl_->stdin_write);
  if (!ok && error != ERROR_BROKEN_PIPE && error != ERROR_NO_DATA) {
    return windows_error("failed to send graceful worker stop", error);
  }
  if (ok && written != static_cast<DWORD>(kStopLine.size())) {
    return core::Status::failure(
        core::ErrorCode::kIoError, "graceful worker stop write was truncated");
  }
  return core::Status::success();
}

core::Status NativeProcess::terminate_tree() noexcept {
  if (!impl_ || impl_->job == nullptr) return core::Status::success();
  if (!TerminateJobObject(impl_->job, 0xE0000010U)) {
    const DWORD error = GetLastError();
    if (error != ERROR_ACCESS_DENIED) return windows_error("failed to terminate worker Job Object", error);
  }
  return core::Status::success();
}

core::Status NativeProcess::hard_kill_tree() noexcept { return terminate_tree(); }

bool NativeProcess::emergency_kill_and_wait() noexcept {
  return !impl_ || impl_->emergency_kill_and_wait();
}

}  // namespace makewatch::runtime::detail

#endif
