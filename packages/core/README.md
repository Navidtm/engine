# `lume-core`

Rust simulation core compiled into the raw WASM module. It owns generational
entities, sparse-set components, systems, render extraction, and CPU visibility.
It does not own WebGPU resources or browser memory.

Use `World` for canonical ECS state, run `update`, then extract into
`RenderWorld`. Capacities are hard limits: insertion reports failure instead of
growing storage during a frame. Public Rust items use Rustdoc comments; run
`cargo doc -p lume-core --open` to browse them locally.
