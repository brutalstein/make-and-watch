add_library(makewatch_engine STATIC
  src/director/operation_validator.cpp
  src/project/graph.cpp
  src/project/engine.cpp
)

add_library(makewatch::engine ALIAS makewatch_engine)

target_include_directories(makewatch_engine
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_compile_features(makewatch_engine PUBLIC cxx_std_20)

if(MSVC)
  target_compile_options(makewatch_engine PRIVATE /W4 /permissive-)
else()
  target_compile_options(makewatch_engine PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion)
endif()

if(MAKEWATCH_BUILD_TESTS)
  add_executable(makewatch_engine_tests
    tests/operation_validator_test.cpp
  )
  target_link_libraries(makewatch_engine_tests PRIVATE makewatch::engine)

  add_executable(makewatch_project_engine_tests
    tests/project_engine_test.cpp
  )
  target_link_libraries(makewatch_project_engine_tests PRIVATE makewatch::engine)

  foreach(test_target IN ITEMS makewatch_engine_tests makewatch_project_engine_tests)
    if(MSVC)
      target_compile_options(${test_target} PRIVATE /W4 /permissive-)
    else()
      target_compile_options(${test_target} PRIVATE -Wall -Wextra -Wpedantic)
    endif()
  endforeach()

  add_test(NAME makewatch_engine_tests COMMAND makewatch_engine_tests)
  add_test(NAME makewatch_project_engine_tests COMMAND makewatch_project_engine_tests)
endif()
