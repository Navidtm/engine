# `lume-core`

Rust simulation core compiled into the raw WASM module. It owns generational
entities, sparse-set components, systems, render extraction, and CPU visibility.
It does not own WebGPU resources or browser memory.

Mesh components store typed geometry/material resource keys, never entity IDs.
The worker owns logical resource lifetime; Rust keeps only the fixed-capacity
basic-material mirror required for allocation-free render extraction.

Use `World` for canonical ECS state, run `update`, then extract into
`RenderWorld`. Capacities are hard limits: insertion reports failure instead of
growing storage during a frame. Public Rust items use Rustdoc comments; run
`cargo doc -p lume-core --open` to browse them locally.
