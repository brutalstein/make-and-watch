cmake_minimum_required(VERSION 3.28)

project(makewatch VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(MAKEWATCH_BUILD_TESTS "Build Make & Watch native tests" ON)

if(MAKEWATCH_BUILD_TESTS)
  enable_testing()
endif()

add_subdirectory(engine)
