#include <filesystem>
#include <iostream>
#include <string>

#include "makewatch/application/project_session.hpp"
#include "makewatch/ipc/dispatcher.hpp"
#include "makewatch/persistence/sqlite_snapshot_store.hpp"

namespace {

int usage(const char* program) {
  std::cerr << "usage: " << program << " [--db <project.sqlite3>]\n";
  return 2;
}

}  // namespace

int main(int argc, char** argv) {
  std::filesystem::path database_path = ".makewatch/dev-project.sqlite3";
  for (int index = 1; index < argc; ++index) {
    const std::string argument = argv[index];
    if (argument == "--db") {
      if (index + 1 >= argc) return usage(argv[0]);
      database_path = argv[++index];
    } else {
      return usage(argv[0]);
    }
  }

  std::error_code directory_error;
  if (const auto parent = database_path.parent_path(); !parent.empty()) {
    std::filesystem::create_directories(parent, directory_error);
    if (directory_error) {
      std::cerr << "makewatch-engine: failed to create database directory: "
                << directory_error.message() << '\n';
      return 3;
    }
  }

  makewatch::persistence::SqliteSnapshotStore store;
  if (const auto status = store.open(database_path); !status.ok()) {
    std::cerr << "makewatch-engine: " << status.message << '\n';
    return 4;
  }

  makewatch::application::ProjectSession session{store};
  if (const auto status = session.load(); !status.ok()) {
    std::cerr << "makewatch-engine: failed to load project: " << status.message << '\n';
    return 5;
  }

  makewatch::ipc::Dispatcher dispatcher{session};
  std::string line;
  while (std::getline(std::cin, line)) {
    std::cout << dispatcher.handle(line) << '\n' << std::flush;
  }
  return 0;
}
