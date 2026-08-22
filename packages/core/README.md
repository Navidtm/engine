# `lume-core`

Rust simulation core compiled into the raw WASM module. It owns generational
entities, sparse-set components, systems, render extraction, and CPU visibility.
It does not own WebGPU resources or browser memory.

Mesh components store typed geometry/material resource keys, never entity IDs.
The worker owns logical resource lifetime; Rust keeps only the fixed-capacity
basic-material mirror required for allocation-free render extraction.

Use `World` for canonical ECS state, run `update`, then extract into
`RenderWorld`. Capacities are hard limits: insertion reports failure instead of
growing storage during a frame. Entity capacity is clamped once to the 20-bit
handle limit, and all entity-indexed stores use that same effective capacity.

Meshes without explicit local bounds are treated as conservatively unbounded;
the core never assumes that an arbitrary geometry fits a unit cube. Camera and
transform authoring values are finite-validated at `World` mutation boundaries,
and accepted quaternions are normalized before derived matrices are computed.

Public Rust items use Rustdoc comments; run `cargo doc -p lume-core --open` to
browse them locally.
