#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>

namespace {

using namespace std::chrono_literals;

void ready(const char* capabilities = "image,voice") {
  std::cout << "MW_READY_V1\tmakewatch-test-worker\t" << capabilities << '\n' << std::flush;
}

int cooperative() {
  ready();
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line == "MW_STOP_V1") return EXIT_SUCCESS;
  }
  return EXIT_SUCCESS;
}

int ignore_stop() {
  ready();
  std::string line;
  while (std::getline(std::cin, line)) {
    // Intentionally ignore the cooperative stop request. The supervisor must
    // escalate only this owned process tree after its grace deadline.
  }
  for (;;) std::this_thread::sleep_for(1s);
}

int quick_exit() {
  ready();
  return EXIT_SUCCESS;
}

int limited_capabilities() {
  ready("image");
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line == "MW_STOP_V1") return EXIT_SUCCESS;
  }
  return EXIT_SUCCESS;
}

int noisy() {
  ready();
  for (int index = 0; index < 2048; ++index) {
    std::cout << "fixture-log-" << index << "-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n";
  }
  std::cout << std::flush;
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line == "MW_STOP_V1") return EXIT_SUCCESS;
  }
  return EXIT_SUCCESS;
}

}  // namespace

int main(int argc, char** argv) {
  const std::string mode = argc >= 2 ? argv[1] : "cooperative";
  if (mode == "cooperative") return cooperative();
  if (mode == "ignore-stop") return ignore_stop();
  if (mode == "quick-exit") return quick_exit();
  if (mode == "limited-capabilities") return limited_capabilities();
  if (mode == "noisy") return noisy();
  std::cerr << "unknown worker fixture mode: " << mode << '\n';
  return 2;
}
