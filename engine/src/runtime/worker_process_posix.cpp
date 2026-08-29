#ifndef _WIN32

#include "worker_process.hpp"

#include <array>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <pthread.h>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

namespace makewatch::runtime::detail {
namespace {

constexpr std::string_view kStopLine = "MW_STOP_V1\n";

core::Status posix_error(std::string prefix, int error_number = errno) {
  prefix += ": ";
  prefix += std::strerror(error_number);
  return core::Status::failure(core::ErrorCode::kIoError, std::move(prefix));
}

void close_fd(int& fd) noexcept {
  if (fd >= 0) {
    while (::close(fd) < 0 && errno == EINTR) {
    }
    fd = -1;
  }
}

bool set_cloexec(int fd) noexcept {
  const int flags = ::fcntl(fd, F_GETFD);
  if (flags < 0) return false;
  return ::fcntl(fd, F_SETFD, flags | FD_CLOEXEC) == 0;
}

bool create_pipe(int (&fds)[2]) noexcept {
  if (::pipe(fds) != 0) return false;
  if (!set_cloexec(fds[0]) || !set_cloexec(fds[1])) {
    const int saved = errno;
    ::close(fds[0]);
    ::close(fds[1]);
    errno = saved;
    return false;
  }
  return true;
}

ssize_t write_without_sigpipe(int fd, const void* data, std::size_t size) noexcept {
  sigset_t block_set{};
  sigset_t old_set{};
  sigset_t pending_before{};
  sigemptyset(&block_set);
  sigaddset(&block_set, SIGPIPE);
  const bool mask_changed = pthread_sigmask(SIG_BLOCK, &block_set, &old_set) == 0;
  const bool was_pending = mask_changed && sigpending(&pending_before) == 0 &&
                           sigismember(&pending_before, SIGPIPE) == 1;

  ssize_t result = -1;
  do {
    result = ::write(fd, data, size);
  } while (result < 0 && errno == EINTR);
  const int saved = errno;

  if (mask_changed && result < 0 && saved == EPIPE && !was_pending) {
    timespec timeout{0, 0};
    while (sigtimedwait(&block_set, nullptr, &timeout) >= 0) {
    }
  }
  if (mask_changed) (void)pthread_sigmask(SIG_SETMASK, &old_set, nullptr);
  errno = saved;
  return result;
}

void write_exec_error_and_exit(int fd, int error_number) noexcept {
  const auto* data = reinterpret_cast<const char*>(&error_number);
  std::size_t written = 0;
  while (written < sizeof(error_number)) {
    const auto result = ::write(fd, data + written, sizeof(error_number) - written);
    if (result > 0) {
      written += static_cast<std::size_t>(result);
      continue;
    }
    if (result < 0 && errno == EINTR) continue;
    break;
  }
  _exit(127);
}

#ifdef __linux__
bool linux_process_group_has_live_members(pid_t process_group) noexcept {
  DIR* directory = ::opendir("/proc");
  if (directory == nullptr) return true;

  bool live = false;
  while (const dirent* entry = ::readdir(directory)) {
    if (entry->d_name[0] < '0' || entry->d_name[0] > '9') continue;
    char path[128]{};
    const int written = std::snprintf(path, sizeof(path), "/proc/%s/stat", entry->d_name);
    if (written <= 0 || static_cast<std::size_t>(written) >= sizeof(path)) continue;

    FILE* file = std::fopen(path, "r");
    if (file == nullptr) continue;
    char line[1024]{};
    const char* read = std::fgets(line, static_cast<int>(sizeof(line)), file);
    std::fclose(file);
    if (read == nullptr) continue;

    char* close_paren = std::strrchr(line, ')');
    if (close_paren == nullptr) continue;
    char state = '\0';
    long parent = 0;
    long group = 0;
    if (std::sscanf(close_paren + 2, "%c %ld %ld", &state, &parent, &group) != 3) continue;
    static_cast<void>(parent);
    if (group == static_cast<long>(process_group) && state != 'Z' && state != 'X') {
      live = true;
      break;
    }
  }
  ::closedir(directory);
  return live;
}
#endif

void posix_reader(int fd, std::shared_ptr<OutputCapture> capture, bool stdout_stream) {
  std::array<char, 4096> buffer{};
  for (;;) {
    const auto count = ::read(fd, buffer.data(), buffer.size());
    if (count > 0) {
      const std::string_view chunk(buffer.data(), static_cast<std::size_t>(count));
      if (stdout_stream) capture->append_stdout(chunk);
      else capture->append_stderr(chunk);
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    break;
  }
  (void)::close(fd);
}

}  // namespace

class NativeProcess::Impl final {
 public:
  explicit Impl(std::shared_ptr<OutputCapture> output_capture)
      : capture(std::move(output_capture)) {}
  ~Impl() noexcept { (void)emergency_kill_and_wait(); }

  [[nodiscard]] bool emergency_kill_and_wait() noexcept {
    const pid_t group = process_group > 0 ? process_group : pid;
    if (group > 0) (void)::killpg(group, SIGKILL);
    if (pid > 0) {
      int status = 0;
      while (::waitpid(pid, &status, 0) < 0 && errno == EINTR) {
      }
    }

    bool confirmed = group <= 0;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (!confirmed && std::chrono::steady_clock::now() < deadline) {
#ifdef __linux__
      confirmed = !linux_process_group_has_live_members(group);
#else
      confirmed = ::killpg(group, 0) != 0 && errno == ESRCH;
#endif
      if (confirmed) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    if (confirmed) {
      pid = -1;
      process_group = -1;
    }
    close_fd(stdin_write);
    return confirmed;
  }

  std::shared_ptr<OutputCapture> capture;
  std::jthread stdout_reader;
  std::jthread stderr_reader;
  bool leader_exited{false};
  std::optional<std::int64_t> exit_code;
  pid_t pid{-1};
  pid_t process_group{-1};
  int stdin_write{-1};
};

NativeProcess::NativeProcess(std::unique_ptr<Impl> impl) noexcept : impl_(std::move(impl)) {}
NativeProcess::~NativeProcess() noexcept = default;

SpawnNativeProcessResult NativeProcess::spawn(
    const WorkerLaunchSpec& spec,
    std::shared_ptr<OutputCapture> capture) {
  int stdin_pipe[2]{-1, -1};
  int stdout_pipe[2]{-1, -1};
  int stderr_pipe[2]{-1, -1};
  int exec_error_pipe[2]{-1, -1};

  auto cleanup = [&]() noexcept {
    close_fd(stdin_pipe[0]);
    close_fd(stdin_pipe[1]);
    close_fd(stdout_pipe[0]);
    close_fd(stdout_pipe[1]);
    close_fd(stderr_pipe[0]);
    close_fd(stderr_pipe[1]);
    close_fd(exec_error_pipe[0]);
    close_fd(exec_error_pipe[1]);
  };

  if (!create_pipe(stdin_pipe) || !create_pipe(stdout_pipe) ||
      !create_pipe(stderr_pipe) || !create_pipe(exec_error_pipe)) {
    const auto status = posix_error("failed to create worker stdio pipes");
    cleanup();
    return {status, nullptr};
  }

  std::string executable_string = spec.executable.string();
  std::vector<std::string> owned_arguments;
  owned_arguments.reserve(spec.arguments.size() + 1);
  owned_arguments.push_back(executable_string);
  owned_arguments.insert(owned_arguments.end(), spec.arguments.begin(), spec.arguments.end());
  std::vector<char*> argv;
  argv.reserve(owned_arguments.size() + 1);
  for (auto& argument : owned_arguments) argv.push_back(argument.data());
  argv.push_back(nullptr);
  const bool executable_has_parent = spec.executable.has_parent_path();
  const std::string working_directory =
      spec.working_directory.has_value() ? spec.working_directory->string() : std::string{};

  const pid_t pid = ::fork();
  if (pid < 0) {
    const auto status = posix_error("failed to fork worker process");
    cleanup();
    return {status, nullptr};
  }

  if (pid == 0) {
    close_fd(stdin_pipe[1]);
    close_fd(stdout_pipe[0]);
    close_fd(stderr_pipe[0]);
    close_fd(exec_error_pipe[0]);

    if (::setpgid(0, 0) != 0) write_exec_error_and_exit(exec_error_pipe[1], errno);
    if (::dup2(stdin_pipe[0], STDIN_FILENO) < 0 ||
        ::dup2(stdout_pipe[1], STDOUT_FILENO) < 0 ||
        ::dup2(stderr_pipe[1], STDERR_FILENO) < 0) {
      write_exec_error_and_exit(exec_error_pipe[1], errno);
    }

    close_fd(stdin_pipe[0]);
    close_fd(stdout_pipe[1]);
    close_fd(stderr_pipe[1]);

    if (!working_directory.empty() && ::chdir(working_directory.c_str()) != 0) {
      write_exec_error_and_exit(exec_error_pipe[1], errno);
    }
    if (executable_has_parent) ::execv(executable_string.c_str(), argv.data());
    else ::execvp(executable_string.c_str(), argv.data());
    write_exec_error_and_exit(exec_error_pipe[1], errno);
  }

  close_fd(stdin_pipe[0]);
  close_fd(stdout_pipe[1]);
  close_fd(stderr_pipe[1]);
  close_fd(exec_error_pipe[1]);
  (void)::setpgid(pid, pid);

  int exec_error = 0;
  std::size_t error_bytes = 0;
  auto* error_buffer = reinterpret_cast<char*>(&exec_error);
  while (error_bytes < sizeof(exec_error)) {
    const auto count = ::read(
        exec_error_pipe[0], error_buffer + error_bytes, sizeof(exec_error) - error_bytes);
    if (count > 0) {
      error_bytes += static_cast<std::size_t>(count);
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    break;
  }
  close_fd(exec_error_pipe[0]);
  if (error_bytes != 0) {
    (void)::killpg(pid, SIGKILL);
    int status = 0;
    while (::waitpid(pid, &status, 0) < 0 && errno == EINTR) {
    }
    close_fd(stdin_pipe[1]);
    close_fd(stdout_pipe[0]);
    close_fd(stderr_pipe[0]);
    return {posix_error("failed to exec worker process", exec_error), nullptr};
  }

  bool process_transferred = false;
  try {
    auto impl = std::make_unique<Impl>(std::move(capture));
    impl->pid = pid;
    impl->process_group = pid;
    impl->stdin_write = std::exchange(stdin_pipe[1], -1);
    process_transferred = true;
    impl->stdout_reader = std::jthread(posix_reader, stdout_pipe[0], impl->capture, true);
    stdout_pipe[0] = -1;
    impl->stderr_reader = std::jthread(posix_reader, stderr_pipe[0], impl->capture, false);
    stderr_pipe[0] = -1;
    return {core::Status::success(),
            std::unique_ptr<NativeProcess>(new NativeProcess(std::move(impl)))};
  } catch (...) {
    if (!process_transferred) {
      (void)::killpg(pid, SIGKILL);
      int status = 0;
      while (::waitpid(pid, &status, 0) < 0 && errno == EINTR) {
      }
    }
    close_fd(stdin_pipe[1]);
    close_fd(stdout_pipe[0]);
    close_fd(stderr_pipe[0]);
    throw;
  }
}

std::uint64_t NativeProcess::process_id() const noexcept {
  return impl_ && impl_->pid > 0 ? static_cast<std::uint64_t>(impl_->pid) : 0;
}

ProcessObservation NativeProcess::observe() noexcept {
  if (!impl_) return {.leader_exited = true, .tree_exited = true, .exit_code = std::nullopt};
  if (!impl_->leader_exited && impl_->pid > 0) {
    int status = 0;
    const pid_t result = ::waitpid(impl_->pid, &status, WNOHANG);
    if (result == impl_->pid) {
      impl_->leader_exited = true;
      if (WIFEXITED(status)) {
        impl_->exit_code = static_cast<std::int64_t>(WEXITSTATUS(status));
      } else if (WIFSIGNALED(status)) {
        impl_->exit_code = static_cast<std::int64_t>(128 + WTERMSIG(status));
      }
    } else if (result < 0 && errno == ECHILD) {
      impl_->leader_exited = true;
    }
  }

  bool tree_exited = impl_->leader_exited;
  if (impl_->leader_exited && impl_->process_group > 0) {
#ifdef __linux__
    tree_exited = !linux_process_group_has_live_members(impl_->process_group);
#else
    if (::killpg(impl_->process_group, 0) == 0 || errno == EPERM) tree_exited = false;
    else if (errno == ESRCH) tree_exited = true;
    else tree_exited = false;
#endif
  } else if (!impl_->leader_exited) {
    tree_exited = false;
  }
  if (tree_exited && impl_->leader_exited) {
    impl_->pid = -1;
    impl_->process_group = -1;
  }
  return {impl_->leader_exited, tree_exited, impl_->exit_code};
}

core::Status NativeProcess::request_graceful_stop() noexcept {
  if (!impl_ || impl_->stdin_write < 0) return core::Status::success();
  std::size_t written = 0;
  while (written < kStopLine.size()) {
    const auto count = write_without_sigpipe(
        impl_->stdin_write, kStopLine.data() + written, kStopLine.size() - written);
    if (count > 0) {
      written += static_cast<std::size_t>(count);
      continue;
    }
    const int error = errno;
    close_fd(impl_->stdin_write);
    if (error == EPIPE) return core::Status::success();
    return posix_error("failed to send graceful worker stop", error);
  }
  close_fd(impl_->stdin_write);
  return core::Status::success();
}

core::Status NativeProcess::terminate_tree() noexcept {
  if (!impl_ || impl_->process_group <= 0) return core::Status::success();
  if (::killpg(impl_->process_group, SIGTERM) != 0 && errno != ESRCH) {
    return posix_error("failed to terminate worker process group");
  }
  return core::Status::success();
}

core::Status NativeProcess::hard_kill_tree() noexcept {
  if (!impl_ || impl_->process_group <= 0) return core::Status::success();
  if (::killpg(impl_->process_group, SIGKILL) != 0 && errno != ESRCH) {
    return posix_error("failed to hard-kill worker process group");
  }
  return core::Status::success();
}

bool NativeProcess::emergency_kill_and_wait() noexcept {
  return !impl_ || impl_->emergency_kill_and_wait();
}

}  // namespace makewatch::runtime::detail

#endif
