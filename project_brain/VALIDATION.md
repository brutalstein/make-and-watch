# Validation Record

This file records what was actually executed, not what is merely expected to work.

## 2026-08-28 — Foundation native core

Reconstructed the committed native foundation in an isolated local test directory and executed:

```text
cmake -S . -B build -G Ninja -DMAKEWATCH_BUILD_TESTS=ON
cmake --build build
ctest --test-dir build --output-on-failure
```

Environment:

- GCC 14.2.0
- CMake 3.31.6
- Ninja 1.12.1

Result:

```text
1/1 tests passed
0 tests failed
```

Validated contracts include the C++20 static engine library, `OperationValidator`, `DirectorProvider` header contract, and test discovery from the root CMake project.

## Studio validation status

The current execution environment has Node.js 22 but does not have `pnpm`, and outbound network access is unavailable. Therefore the Studio dependency installation, TypeScript typecheck, and Vite production build have **not yet been executed** against the committed branch.

Required before merge:

```text
pnpm install
pnpm typecheck
pnpm build:web
```

Any failure discovered there must be fixed on the foundation branch before merge.
