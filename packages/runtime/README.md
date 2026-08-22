# `@lume/runtime`

Worker runtime and transport primitives used by `@lume/api`. Application code
normally imports only `createDefaultWorker` indirectly through `createEngine`.

The package publishes `dist/lume_core.wasm` beside its ESM runtime. The opt-in
`@lume/runtime/wasm-url` entry point exposes `getLumeWasmUrl()` for bundlers and
native ESM servers; keeping it separate prevents transport-only consumers from
emitting the asset. `@lume/api` uses it automatically. Applications should
override `EngineConfig.wasmUrl` only for intentional CDN or self-hosted layouts,
and must copy the binary from the same runtime package version.

The server should return `application/wasm`; the raw-buffer loader also accepts
`application/octet-stream` for compatibility. Fetch, MIME, compilation/CSP, and
ABI failures produce separate initialization diagnostics. The runtime continues
to instantiate the raw ABI directly and does not require generated glue.

The exported shared-memory helpers are intended for runtime integration and
benchmarks: allocate once, publish with `writeSharedTransform`, and drain only
from the single worker consumer. Do not expose transport buffers as application
state or mutate them from more than one producer.

The worker Resource Coordinator is the canonical owner of logical geometry and
basic-material lifetime. It validates generational keys, tracks ECS mesh usage
edges, and publishes ordered changes to Rust render mirrors and private renderer
registries. Resource lifecycle state is not exposed as transport state.

On WebGPU device loss, the worker pauses scheduling, recreates the renderer,
replays every live built-in geometry/material descriptor, invalidates the WASM
renderer cache, and resumes only after a full derived-scene publication.
Commands received during reconstruction remain ordered and are replayed after
the replacement renderer is ready.
