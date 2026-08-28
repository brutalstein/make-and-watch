include(FetchContent)

FetchContent_Declare(
  nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz
  URL_HASH SHA256=42f6e95cad6ec532fd372391373363b62a14af6d771056dbfc86160e6dfff7aa
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(nlohmann_json)

FetchContent_Declare(
  sqlite_amalgamation
  URL https://www.sqlite.org/2026/sqlite-amalgamation-3530400.zip
  URL_HASH SHA3_256=628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(sqlite_amalgamation)

add_library(makewatch_sqlite STATIC
  ${sqlite_amalgamation_SOURCE_DIR}/sqlite3.c
)
target_include_directories(makewatch_sqlite PUBLIC ${sqlite_amalgamation_SOURCE_DIR})
target_compile_definitions(makewatch_sqlite PRIVATE
  SQLITE_THREADSAFE=1
  SQLITE_DQS=0
  SQLITE_OMIT_LOAD_EXTENSION=1
)
if(MSVC)
  target_compile_options(makewatch_sqlite PRIVATE /W0)
else()
  target_compile_options(makewatch_sqlite PRIVATE -w)
endif()

add_library(makewatch_engine STATIC
  src/application/project_session.cpp
  src/director/operation_validator.cpp
  src/ipc/dispatcher.cpp
  src/project/graph.cpp
  src/project/engine.cpp
  src/runtime/resource_manager.cpp
  src/persistence/sqlite_snapshot_store.cpp
)

add_library(makewatch::engine ALIAS makewatch_engine)

target_include_directories(makewatch_engine
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_link_libraries(makewatch_engine PRIVATE makewatch_sqlite nlohmann_json::nlohmann_json)
target_compile_features(makewatch_engine PUBLIC cxx_std_20)

if(MSVC)
  target_compile_options(makewatch_engine PRIVATE /W4 /permissive-)
else()
  target_compile_options(makewatch_engine PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion)
endif()

add_executable(makewatch_engine_host apps/engine_host.cpp)
target_link_libraries(makewatch_engine_host PRIVATE makewatch::engine)
if(MSVC)
  target_compile_options(makewatch_engine_host PRIVATE /W4 /permissive-)
else()
  target_compile_options(makewatch_engine_host PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(MAKEWATCH_BUILD_TESTS)
  add_executable(makewatch_engine_tests tests/operation_validator_test.cpp)
  target_link_libraries(makewatch_engine_tests PRIVATE makewatch::engine)

  add_executable(makewatch_project_engine_tests tests/project_engine_test.cpp)
  target_link_libraries(makewatch_project_engine_tests PRIVATE makewatch::engine)

  add_executable(makewatch_resource_manager_tests tests/resource_manager_test.cpp)
  target_link_libraries(makewatch_resource_manager_tests PRIVATE makewatch::engine)

  add_executable(makewatch_sqlite_snapshot_store_tests tests/sqlite_snapshot_store_test.cpp)
  target_link_libraries(makewatch_sqlite_snapshot_store_tests PRIVATE makewatch::engine)

  add_executable(makewatch_project_session_tests tests/project_session_test.cpp)
  target_link_libraries(makewatch_project_session_tests PRIVATE makewatch::engine)

  add_executable(makewatch_ipc_dispatcher_tests tests/ipc_dispatcher_test.cpp)
  target_link_libraries(makewatch_ipc_dispatcher_tests PRIVATE makewatch::engine nlohmann_json::nlohmann_json)

  foreach(test_target IN ITEMS
      makewatch_engine_tests
      makewatch_project_engine_tests
      makewatch_resource_manager_tests
      makewatch_sqlite_snapshot_store_tests
      makewatch_project_session_tests
      makewatch_ipc_dispatcher_tests)
    if(MSVC)
      target_compile_options(${test_target} PRIVATE /W4 /permissive-)
    else()
      target_compile_options(${test_target} PRIVATE -Wall -Wextra -Wpedantic)
    endif()
  endforeach()

  add_test(NAME makewatch_engine_tests COMMAND makewatch_engine_tests)
  add_test(NAME makewatch_project_engine_tests COMMAND makewatch_project_engine_tests)
  add_test(NAME makewatch_resource_manager_tests COMMAND makewatch_resource_manager_tests)
  add_test(NAME makewatch_sqlite_snapshot_store_tests COMMAND makewatch_sqlite_snapshot_store_tests)
  add_test(NAME makewatch_project_session_tests COMMAND makewatch_project_session_tests)
  add_test(NAME makewatch_ipc_dispatcher_tests COMMAND makewatch_ipc_dispatcher_tests)
endif()
