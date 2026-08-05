# Roadmap and bottleneck register

## Milestone 1 — foundation (implemented)

Repository layout, Rust workspace, raw-WASM bridge, sparse-set ECS, internal
math, worker lifecycle, WebGPU initialization, pipeline cache, depth texture,
and a vertex-buffer triangle.

Benchmark focus: initialization time, steady-state JS heap growth, command
latency, and idle frame CPU cost. The triangle is a plumbing benchmark, not a
render-throughput benchmark.

## Milestone 2 — ECS-driven mesh rendering (implemented)

Adds immutable geometry handles, indexed cube geometry, a dedicated RenderWorld,
camera uniforms, fixed-capacity instance storage, explicit GPU mesh ownership,
and consecutive-geometry instanced submission. Dirty-range uploads, visibility
lists, and material arenas remain follow-up optimizations.

Benchmark focus: transform updates per millisecond, draw preparation cost,
buffer upload bytes, and CPU cost per visible mesh.

## Milestone 3 — visibility and frame orchestration (implemented)

Adds world-space bounding spheres, allocation-free CPU frustum culling, compact
visible buffers grouped by pipeline/material/mesh, a reusable FrameGraph,
color-only BasicMaterial, optional WebGPU timestamp queries, and a high-level
authoring facade over the advanced ECS API.

Benchmark focus: 100k-object culling at 100%, 50%, 10%, and 1% visibility;
rendering at 1k, 10k, 50k, and 100k objects; and controlled raw Three.js data.

## Milestone 4 — high-throughput transport (implemented)

Moves hot transform state to a versioned `SharedArrayBuffer` layout when
cross-origin isolation is available. Structural commands remain messages, and
the command transform path remains a compatibility mode. The worker drains a
coalescing dirty-index ring into preallocated WASM staging and applies each
frame's batch with one boundary crossing.

Benchmark focus: main-to-worker latency, structured-clone bytes, ring pressure,
and missed-frame rate under input load.

## Milestone 5 — transport hardening (implemented)

Finalizes partial transform masks, index-based dirty-range WASM staging, the
bounded structural SPSC ring, ordered overflow fallback, generational shared
handles, entity slot recycling, transport metrics, and scale benchmarks.

Benchmark focus: 10k through 1M shared updates, 10k through 500k structural
commands, lifecycle reuse, staging bytes, ranges, and overflow visibility.

## Milestone 6 — rendering scalability (planned)

Introduce persistent GPU instance storage, dirty-range uploads, indirect command
storage, GPU culling, scalable instancing, and render-graph resource lifetime
analysis. Textures, lighting, material variants, and asset streaming remain out
of scope until this scalability baseline is measured and stable.

Benchmark focus: pipeline-cache hit rate, bind-group churn, transient GPU memory,
draw/dispatch counts, and GPU frame time.

## Known future bottlenecks

1. **SAB-to-WASM staging:** one copy remains necessary to preserve canonical
   Rust ownership. Field masks and ranges bound it to changed data.
2. **Sparse-set removal order:** swap removal is fast but unstable. Systems must
   never depend on dense order; deterministic sorting should be opt-in.
3. **Pipeline compilation stalls:** the cache prevents duplicates but cannot
   hide first use. Material manifests will support asynchronous prewarming.
4. **Uniform alignment and fragmentation:** one buffer per material will not
   scale. Phase 2 uses aligned arenas and dynamic offsets.
5. **Device loss:** recovery currently terminates the runtime with a clear error.
   Asset descriptors must become replayable before transparent recovery.
6. **Generation wrap:** compact 12-bit generations repeat after 4096 reuses of
   one slot. Long-retained handles beyond that window are unsupported.
7. **Browser worker variance:** WebGPU worker support and canvas transfer remain
   platform-sensitive. Capability errors are explicit and testable.
