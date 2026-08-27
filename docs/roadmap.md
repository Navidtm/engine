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
and consecutive-geometry instanced submission. Persistent dirty-range uploads
and stable visibility-slot lists were delivered later by ADR 007; material
arenas remain future work.

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
cross-origin isolation is available. Milestone 5 subsequently replaces normal
runtime structural messages with a bounded SPSC ring and ordered message
overflow fallback. The worker drains a coalescing dirty-index ring into
preallocated WASM staging and applies each frame's batch with one boundary
crossing.

Benchmark focus: main-to-worker latency, structured-clone bytes, ring pressure,
and missed-frame rate under input load.

## Milestone 5 — transport hardening (implemented)

Finalizes partial transform masks, index-based dirty-range WASM staging, the
bounded structural SPSC ring, ordered overflow fallback, generational shared
handles, entity slot recycling, transport metrics, and scale benchmarks.

Benchmark focus: 10k through 1M shared updates, 10k through 500k structural
commands, lifecycle reuse, staging bytes, ranges, and overflow visibility.

## Milestone 6 — rendering scalability (implemented)

The implemented starting point is the persistent entity-indexed GPU instance
representation and dirty-range upload path from
[ADR 007](../.agents/decisions/007-persistent-instance-storage.md), plus the
epoch-gated RenderWorld/visibility reuse from
[ADR 008](../.agents/decisions/008-epoch-gated-render-extraction.md). Their
controlled measurements are committed; they are not future Milestone 6 work.

Explicit active/generational GPU slot metadata, domain-specific dirty uploads,
compute frustum visibility, per-run indirect command generation, and indexed
indirect drawing are implemented under
[ADR 009](../.agents/decisions/009-active-persistent-gpu-slots.md). CPU visibility
remains the reference/fallback, and pull-sampled count/hash diagnostics prove
same-frame membership equivalence. Automatic device-loss reconstruction replays
live resource descriptors and republishes derived scene state.

The completed entry gates, implementation, measurement evidence, and remaining
non-goals are separated in [milestone-6.md](milestone-6.md).

The controlled matrix is committed at
`benchmarks/results/renderer-scalability-latest.json`. It covers scale,
occupancy, visibility, transform/bounds/resource dirtiness, churn, and camera
counts with CPU/GPU/CPU/GPU ordering and correctness hashes. Render-graph
resource lifetime analysis, occlusion culling, public multi-camera presentation,
textures, lighting, material variants, and asset streaming remain pending.

## Milestone 7 — asset pipeline foundation (implemented)

Milestone 7 introduces worker-owned loading of one validated static geometry
from a constrained GLB 2.0 profile. The public target is
`await engine.load.geometry(url)`, followed by existing
`engine.create.mesh({ geometry })`; loading does not instantiate ECS entities or
file node hierarchies.

[ADR 011](../.agents/decisions/011-glb-geometry-ingestion.md) fixes the input and
decoded geometry boundary. [ADR 012](../.agents/decisions/012-async-geometry-loading.md)
fixes request correlation, abort, worker ownership, and atomic ready-handle
publication. [milestone-7.md](milestone-7.md) defines implementation phases,
correctness coverage, benchmarks, and completion gates.

Phase 1 is implemented as the dependency-free `@lume/assets` package: immutable
decode-limit contracts, typed asset errors, deterministic GLB fixtures, strict
container/accessor validation, `uint32` index widening, exact owned-array byte
accounting, and regression tests. Phase 2 adds renderer registration, removal,
and unchanged-handle replay for structurally compatible external descriptors,
with transactional GPU-buffer ownership and generational/capacity coverage.
Phase 3 adds versioned worker load/abort/result messages, bounded fetch/decode
transactions, immutable budget accounting, attempt-epoch cancellation, atomic
renderer publication/rollback, typed failures, and external descriptor replay
across device recovery. Phase 4 adds the public `engine.load.geometry()` facade,
optional cancellation, typed errors, atomic ready-handle publication, terminal
lifecycle rejection, and a browser integration example that verifies worker
decode and the existing mesh/resource lifecycle. Phase 5 commits deterministic
small/medium/large browser measurements, cold-path timing and peak-memory
diagnostics, exact CPU/GPU accounting validation, cleanup checks, and a heavier
multi-feature asset showcase. Textures/KTX2, imported materials,
multi-primitive assets, hierarchy, streaming, caching, compression, and an
offline optimizer remain outside Milestone 7.

## Milestone 8 — texture and sampler foundation (proposed; next design milestone)

Milestone 8 will add bounded, replayable texture and sampler resources. Design
must be accepted before implementation: constrained KTX2 input, Basis/GPU-format
capability selection, color space, mip residency, sampler normalization,
worker-owned transcode/upload, cancellation, retirement, budgets, diagnostics,
and device-loss replay all require explicit contracts and deterministic
fixtures.

The milestone deliberately excludes PBR, imported glTF materials, general
PNG/JPEG production loading, runtime mip generation, streaming, caching,
multi-mesh composition, and scene hierarchy. Its completion evidence must cover
validation, lifecycle failure boundaries, memory cleanup, and controlled
browser transcode/upload measurements on hardware and CI fallback paths.

## Milestone 9 — material and lighting foundation (blocked on Milestone 8)

Milestone 9 will compose texture/sampler handles into a bounded material system,
replace one-buffer-per-material scaling, define stable pipeline keys and
prewarming, and introduce only the minimal physically based surface and lighting
model needed for product visualization. Material graphs, arbitrary shaders,
clustered lighting, shadows, reflections, post-processing, general glTF material
extensions, and scene loading remain outside this milestone.

## Milestone 10 — asset preparation and composition (blocked on Milestones 8–9)

Milestone 10 will make representative creative-tool exports usable through an
offline preparation path. It will apply node transforms, normalize and optimize
geometry, process textures, emit deterministic manifests, and compose multiple
geometry/material resources through flat recipes and ECS entities. It must not
introduce an Object3D-style runtime hierarchy or perform expensive creative-tool
processing in the browser.

The exit workload is a real textured multi-mesh product prepared offline,
loaded atomically, destroyed cleanly, and replayed after device loss with
committed load and memory evidence.

## Milestone 11 — streaming and cache policy (blocked on measured Milestone 10)

Streaming begins only after complete assets have deterministic identity,
dependencies, residency budgets, and representative measurements. The design
must define request deduplication, priority, cancellation, dependency-aware
eviction/pinning, partial readiness, persistent-cache versioning, and rollback
before production implementation starts.

Developer documentation, examples, profiling/debug tooling, and framework
integrations continue alongside stable public APIs. They do not determine engine
ownership or lifecycle semantics.

## Known future bottlenecks

1. **SAB-to-WASM staging:** one copy remains necessary to preserve canonical
   Rust ownership. Field masks and ranges bound it to changed data.
2. **Sparse-set removal order:** swap removal is fast but unstable. Systems must
   never depend on dense order; deterministic sorting should be opt-in.
3. **Pipeline compilation stalls:** the cache prevents duplicates but cannot
   hide first use. Material manifests will support asynchronous prewarming.
4. **Uniform alignment and fragmentation:** one buffer per material will not
   scale. Milestone 9 must select and measure a bounded parameter-storage
   strategy such as aligned arenas and dynamic offsets.
5. **Device loss beyond current descriptors:** built-in and loaded external
   geometry descriptors replay automatically; future textures, streamed chunks,
   and imported materials need equivalent descriptors before sharing recovery.
6. **Generation exhaustion:** ADR 010 preserves compact 20/12 identities and
   retires a slot after 4,096 allocations. Stale handles cannot alias, but
   extreme lifetime churn can reduce reusable capacity.
7. **Browser worker variance:** WebGPU worker support and canvas transfer remain
   platform-sensitive. Capability errors are explicit and testable.
