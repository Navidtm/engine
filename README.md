# Lume Engine

Lume is an experimental WebGPU-first runtime for interactive 3D websites and
product experiences. Phase 1 deliberately keeps the surface area small: a
data-oriented Rust core compiled to WebAssembly, a worker-owned WebGPU renderer,
and a functional TypeScript API.

The repository currently contains five completed foundation milestones:

- a generational-entity, sparse-set ECS in Rust;
- allocation-free math primitives and reusable frame memory;
- a dependency-free C-ABI WebAssembly bridge;
- worker-owned WebGPU initialization and lifecycle management;
- a cached indexed-mesh pipeline, owned GPU mesh buffers, camera uniforms, and
  fixed-capacity instance storage;
- allocation-free CPU frustum culling and grouped visible render buffers;
- a reusable FrameGraph and optional real GPU timestamp profiling;
- SharedArrayBuffer transform transport with a bulk WASM update boundary;
- generation-safe partial transform publication, a structural SPSC ring, and
  transport metrics;
- a high-level functional TypeScript API plus Vite triangle and cube examples.

See [the architecture notes](docs/architecture.md) and
[the implementation roadmap](docs/roadmap.md) before extending the runtime.

## Prerequisites

- Rust 1.85 or newer
- Node.js 22 or newer
- pnpm 11 or newer
- a browser with WebGPU and WebGPU-in-worker support

## Setup

```sh
rustup target add wasm32-unknown-unknown
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm format:check
```

Run the indexed cube example with:

```sh
pnpm dev
```

Run the internal release benchmarks with:

```sh
pnpm benchmark
```

The latest raw internal results are stored in
`benchmarks/results/internal-latest.json`. Browser renderer and Three.js
comparison harnesses live under `benchmarks/renderer` and
`benchmarks/comparison`; their reports must be captured on the same browser,
hardware, resolution, and configuration before numbers are compared.

The main-thread/worker transport comparison lives under `benchmarks/transport`.
See [benchmarking.md](docs/benchmarking.md) for the complete measurement policy.

The examples expect the raw WebAssembly artifact in their `public` directories.
`pnpm build:wasm` builds and copies that artifact before TypeScript packages are
built.

## Package map

| Package                 | Responsibility                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| `packages/core`         | Rust ECS, math, components, and reusable memory                    |
| `packages/renderer`     | WebGPU device, surface, mesh ownership, pipeline cache, and passes |
| `packages/scene`        | Public component constructors and geometry descriptors             |
| `packages/runtime/wasm` | Raw-WASM ABI over World and extracted RenderWorld                  |
| `packages/runtime`      | Main-thread/worker protocol and worker orchestration               |
| `packages/api`          | Functional browser-facing API                                      |

The build uses Rust's `wasm32-unknown-unknown` target directly. `wasm-pack` is
not required for this repository.

## Browser support

Lume is WebGPU-only. Initialization returns a descriptive error when WebGPU,
`OffscreenCanvas`, or worker rendering is unavailable; it intentionally has no
WebGL fallback.
