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

## 2026-08-28 — GitHub Actions foundation CI

After opening draft PR #1, the CI workflow executed both jobs against the branch.

### Native core

- checkout: passed
- Ninja install: passed
- CMake configure: passed
- C++ build: passed
- CTest: passed

### Studio contracts and build

The first CI iteration exposed two legitimate setup issues that were fixed on the branch:

1. `actions/setup-node` attempted pnpm caching before a lockfile existed.
2. `tsconfig.node.json` used `allowImportingTsExtensions` without `noEmit`.

The final run then passed:

- pnpm setup: passed
- Node.js 22 setup: passed
- workspace install: passed
- strict TypeScript typecheck: passed
- Vite production build: passed

The root pnpm policy explicitly allows only the vetted `esbuild` dependency build script required by the current Vite toolchain.

## Remaining validation before merge

CI is green. The remaining gate is product-machine validation and visual review:

```text
.\doctor.ps1
.\scripts\bootstrap.ps1
pnpm typecheck
pnpm build:web
cmake --build --preset dev
ctest --preset dev
```

Also open the Studio on the primary Windows machine and review layout, scaling, interaction, typography, and GPU/system telemetry placeholders before merging the foundation into `main`.
