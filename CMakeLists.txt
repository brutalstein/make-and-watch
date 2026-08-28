cmake_minimum_required(VERSION 3.28)

project(makewatch VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(MAKEWATCH_BUILD_TESTS "Build Make & Watch native tests" ON)

add_subdirectory(engine)
