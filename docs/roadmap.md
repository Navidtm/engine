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

## Milestone 3 — high-throughput transport

Move structural commands and frame snapshots to versioned
`SharedArrayBuffer` rings when cross-origin isolation is available. Keep the
current transferable-message path as a compatibility mode.

Benchmark focus: main-to-worker latency, structured-clone bytes, ring pressure,
and missed-frame rate under input load.

## Milestone 4 — production rendering

Introduce bind-group layouts, shader/material variants, pipeline prewarming,
texture streaming, GPU culling, instancing, clustered lighting, and render-graph
resource lifetime analysis.

Benchmark focus: pipeline-cache hit rate, bind-group churn, transient GPU memory,
draw/dispatch counts, and GPU frame time.

## Known future bottlenecks

1. **Structured cloning:** adequate for Phase 1 authoring commands, but costly
   for large streaming updates. The protocol is deliberately transport-neutral.
2. **Sparse-set removal order:** swap removal is fast but unstable. Systems must
   never depend on dense order; deterministic sorting should be opt-in.
3. **Pipeline compilation stalls:** the cache prevents duplicates but cannot
   hide first use. Material manifests will support asynchronous prewarming.
4. **Uniform alignment and fragmentation:** one buffer per material will not
   scale. Phase 2 uses aligned arenas and dynamic offsets.
5. **Device loss:** recovery currently terminates the runtime with a clear error.
   Asset descriptors must become replayable before transparent recovery.
6. **Entity-ID authority:** main-thread monotonic IDs give synchronous DX but do
   not yet recycle. Generational recycling requires acknowledgements or shared
   allocation state.
7. **Browser worker variance:** WebGPU worker support and canvas transfer remain
   platform-sensitive. Capability errors are explicit and testable.
