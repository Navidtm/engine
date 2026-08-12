# Current Project State

Last verified: 2026-08-12 on the issue #8 implementation branch

This document records the implementation that exists in the repository. It is
an evidence-based snapshot, not a description of intended future architecture.

## Executive Status

The engine has completed its runtime-foundation and transport-hardening work.
The actual implementation is ready to move from Milestone 5 into Milestone 6,
Renderer Scalability, with controlled browser validation retained as an
acceptance task.

Transport Hardening is complete. All Phase 4 mechanisms are implemented,
tested, documented, and covered by a committed Node benchmark result. Controlled
browser validation remains an acceptance activity, not a transport architecture
gap.

Current boundary:

```text
Application
  -> public TypeScript API
  -> worker runtime
  -> shared-memory or message transport
  -> Rust/WASM ECS
  -> extraction into RenderWorld
  -> CPU visibility and ordering
  -> compiled FrameGraph
  -> WebGPU renderer
  -> GPU
```

## Architecture Compliance

The implementation follows the project architecture rules:

- Public API, runtime, renderer, and scene packages use functional modules and
  explicit state objects; engine-owned classes and inheritance are absent.
- The Rust ECS owns simulation entities and components but no GPU objects.
- Rendering consumes extracted, contiguous `RenderFrame` typed-array views and
  does not query ECS storage.
- `RenderWorld` is a distinct transient representation between ECS and the
  renderer.
- The worker owns the WASM core, WebGPU renderer, and frame loop. The main
  thread owns the public API and is the producer for shared runtime writes.
- Pipelines and persistent GPU buffers are created during renderer
  initialization, not during frame execution.
- Hot-path transport, extraction, visibility, and frame-graph storage are
  capacity-bounded and reused. Capacity exhaustion is explicit rather than
  silently growing frame-time storage.

No architecture-rule violation was found in the inspected implementation. ADR
003 records the shared structural SPSC ring as the primary path and the ordered
message path as overflow/initialization fallback.

## Implemented Subsystems

### Public TypeScript API and Scene Descriptors

Implemented:

- Functional `createEngine` API with explicit lifecycle states.
- High-level mesh, perspective-camera, and basic-material creation.
- Lower-level `world` API for entity creation/destruction and component
  addition/removal.
- Immutable engine-owned entity handles shaped as `{ index, generation }`.
- Validation of handle ownership, liveness, index, and generation before use.
- Validation of authoring tuples, camera/bounds ranges, and foreign material
  handles before an entity slot is allocated or a command is published.
- Fixed-capacity entity allocation, free-list reuse, and stale-handle rejection.
- Declarative scene components for transform, mesh, bounds, camera, and basic
  material data.

Current content support is deliberately small: built-in triangle and box
geometry plus a color-only basic material.

### Rust/WASM Core and ECS

Implemented:

- Sparse-set component storage with generational entity validation and hard
  entity/component capacity limits; normal operation does not grow WASM memory.
- A 32-bit packed handle: 20-bit index and 12-bit generation.
- Safe destroy/recycle behavior in both TypeScript and Rust allocators.
- Data-oriented stores for transforms, mesh renderers, cameras, bounds, and
  materials.
- Preallocated WASM staging arrays for shared transform updates.
- ABI versioning and capacity checks at the TypeScript/WASM boundary.
- Batched application of dirty transform ranges with per-field masks.

The 12-bit generation wraps after 4,096 destructions of the same slot. This is
an accepted compact-handle tradeoff, but it is not protection against an
indefinitely retained handle across that full wrap interval.

### Render Extraction and Visibility

Implemented:

- Separate, reusable `RenderWorld` storage.
- Extraction of instance matrices, colors, geometry/material/pipeline IDs,
  camera matrices, and bounding spheres.
- Persistent entity-indexed instance records with generational/revision dirty
  tracking and coalesced upload ranges.
- CPU frustum culling using sphere bounds.
- Reusable visibility output buffers.
- CPU ordering by pipeline, material, and geometry for consecutive draw runs.
- Capacity limits with explicit failure when extracted data exceeds the
  configured entity capacity.

The visibility system currently uses the first extracted camera. Storage can
hold multiple cameras, but true multi-camera rendering is not implemented.

### FrameGraph

Implemented:

- Functional pass/resource declarations.
- Dependency validation and topological compilation.
- Reusable compiled execution order.
- Current renderer graph with an upload pass followed by a main render pass.

This is a frame-graph foundation, not yet a production transient-resource
allocator or multi-pass scheduling system.

### WebGPU Renderer

Implemented:

- Adapter/device acquisition and canvas configuration.
- Asynchronous basic render-pipeline creation and pipeline caching.
- Persistent camera and instance GPU buffers.
- Persistent visible-slot storage, with instance, visibility, and camera writes
  skipped independently when unchanged.
- A committed 16-scenario Chrome/WebGPU upload matrix: static 10k frames write
  zero bytes versus the previous 800,128 bytes; dirty 1%, 10%, and 100% medians
  are 8KB, 80KB, and 800KB with one queue write.
- Vertex/index buffers and a built-in mesh registry.
- Depth target creation and resize handling.
- Timestamp queries when supported, with CPU timing fallback metrics.
- Indexed drawing and CPU-prepared instancing: consecutive compatible visible
  items are submitted with one `drawIndexed` call using `instanceCount`.
- Device-loss reporting to the main thread without exposing the `GPUDevice`
  outside the renderer package.
- Transactional renderer/WASM initialization with cleanup of partial and late
  successful resources.

Current limitations:

- One basic pipeline and color-only material path.
- No indirect command buffers or indirect drawing.
- No GPU-driven culling, compute visibility, or GPU scene database.
- Device loss is reported but the renderer is not automatically rebuilt.

## Transport Hardening Status

Milestone 5 is implemented.

### Memory Ownership and Copy Path

- Main thread: public handles, public entity allocator, shared-memory producer.
- Worker: sole queue consumer, WASM instance, renderer, and reusable staging
  views.
- Rust: canonical entity allocator, ECS components, and render extraction.
- Shared memory: fixed-capacity transport state only; it is not canonical ECS
  storage.

Ordinary Rust-owned WASM linear memory cannot directly alias the browser's
`SharedArrayBuffer`. The implemented lowest-copy path is:

```text
changed TypeScript fields
  -> fixed SAB slots
  -> fixed WASM staging views
  -> canonical Rust components
```

One SAB-to-WASM copy remains. Only dirty entities and selected fields cross
that boundary, and the worker does not create an intermediate compact
JavaScript buffer.

### Transform Updates

Implemented:

- Per-slot seqlock synchronization.
- Field masks for position, rotation, scale, and the reserved matrix bit.
- Atomic dirty-bit deduplication.
- Fixed-capacity SPSC dirty-index queue.
- Adjacent-index merging into reusable dirty ranges.
- Race-safe requeue when a producer updates a slot during consumption.
- One ranged WASM apply call after staging.

The matrix mask is a protocol marker; matrices are currently derived by Rust
rather than copied as transform input.

### Structural Commands

Implemented shared SPSC commands include:

- create and destroy entity;
- add transform, material, camera, mesh, and bounds;
- remove component.

The ring is lock-free, FIFO, bounded, and fixed-record-width. Overflow is
observable through `droppedCommands`; the API switches to an ordered
`postMessage` fallback so later structural commands cannot overtake the dropped
command. Initialization batches and non-SAB environments also use messages.

### Transport Metrics

`engine.getStats().transport` exposes:

- `messages`;
- `sharedWrites`;
- `dirtyRanges`;
- `bytesUploaded`;
- `queueDepth`;
- `droppedCommands`.

Metrics combine worker message counts, atomic shared-memory counters, and WASM
staging counters. They are diagnostic counters, not browser-independent timing
guarantees.

## Benchmark Evidence

The committed transport result is
`benchmarks/results/transport-hardening-latest.json`, generated on macOS arm64
with Node v24.16.0. It exercises the production shared-memory and ring
implementations.

### Shared Partial Transform Transport

|  Entities |   Publish |    Drain | Dirty ranges | Allocations | Bytes staged |
| --------: | --------: | -------: | -----------: | ----------: | -----------: |
|    10,000 |   1.53 ms |  1.25 ms |            1 |           0 |      200,008 |
|   100,000 |   9.56 ms |  7.94 ms |            1 |           0 |    2,000,008 |
|   500,000 |  46.02 ms | 40.61 ms |            1 |           0 |   10,000,008 |
| 1,000,000 | 100.65 ms | 82.97 ms |            1 |           0 |   20,000,008 |

For this position-only workload, staged bytes are approximately half of the
legacy full-transform object transport. The legacy object path is faster in
this single-process Node microbenchmark, but allocates four objects per entity;
the hardened path performs zero measured runtime allocations and preserves the
cross-thread shared-memory architecture. These results must not be presented as
browser worker latency.

### Structural SPSC Ring

| Commands |  Publish |    Drain | Dropped | Allocations |
| -------: | -------: | -------: | ------: | ----------: |
|   10,000 |  0.88 ms |  0.59 ms |       0 |           0 |
|  100,000 |  4.32 ms |  4.02 ms |       0 |           0 |
|  500,000 | 23.99 ms | 18.45 ms |       0 |           0 |

### Generational Entity Lifecycle

|  Entities |  Create | Destroy |   Reuse | Stale rejected |
| --------: | ------: | ------: | ------: | :------------: |
|    10,000 | 0.15 ms | 0.18 ms | 0.23 ms |      yes       |
|   100,000 | 0.87 ms | 0.41 ms | 0.12 ms |      yes       |
| 1,000,000 | 9.72 ms | 1.22 ms | 1.05 ms |      yes       |

The repository also contains Rust ECS/extraction benchmarks and browser
renderer/comparison/transport harnesses. Controlled Chrome and Edge results on
the same hardware and resolution remain outstanding.

## Quality and Tooling

Implemented CI gates:

- Rust formatting, Clippy with warnings denied, workspace tests, and release
  `wasm32-unknown-unknown` build.
- `cargo audit` and `cargo deny` dependency policy.
- Prettier, ESLint, TypeScript checks, package tests, and builds for packages,
  examples, and benchmarks.

Tests cover generational entities, sparse-set validation, world lifecycle,
render extraction, visibility, frame-graph compilation, shared-memory masks and
ranges, structural queues, protocol behavior, WASM update staging, geometry,
and timestamp profiling. End-to-end browser tests for the complete
main-thread/worker/WASM/WebGPU path are not yet part of CI.

## Roadmap Comparison

| Roadmap phase                 | Roadmap label | Actual repository state                                                  |
| ----------------------------- | ------------- | ------------------------------------------------------------------------ |
| 1. Runtime Foundation         | Completed     | Implemented                                                              |
| 2. Render Architecture        | Completed     | Implemented                                                              |
| 3. Performance Infrastructure | Completed     | Implemented                                                              |
| 4. Transport Hardening        | Completed     | Implemented; browser validation remains an acceptance activity           |
| 6. Renderer Scalability       | Planned       | Baseline CPU instancing exists; scalable GPU-driven work has not started |
| 6. Asset Pipeline             | Planned       | Not implemented                                                          |
| 7. Advanced Graphics          | Planned       | Not implemented                                                          |
| 8. Developer Ecosystem        | Planned       | Not implemented                                                          |

## Intentionally Not Implemented

- Textures, samplers, texture streaming, and texture compression.
- PBR materials, lighting, shadows, reflections, and post-processing.
- glTF or other asset loaders and a production asset pipeline.
- Animation, skinning, morph targets, and skeletal systems.
- Physics, networking, gameplay systems, editor, or scene authoring.
- GPU compute culling, indirect rendering, and GPU-driven submission.

These omissions match the roadmap and the scope constraints of the completed
transport milestone.

## Remaining Runtime and Rendering Bottlenecks

1. The required SAB-to-WASM staging copy still scales linearly with the number
   and size of dirty fields.
2. Extraction, frustum culling, and render-key sorting are CPU-side. Visibility
   ordering performs an `O(V log V)` unstable sort each frame.
3. Persistent instance upload is change-proportional, but extraction and the
   compact visible-slot list remain CPU-prepared each frame.
4. Draw-call reduction depends on consecutive CPU ordering; there are no
   indirect batches or GPU-generated commands.
5. Large-scale measurements are transport microbenchmarks. Real worker
   scheduling, browser atomics, WASM copying, WebGPU upload, and GPU execution
   still require controlled browser measurement.
6. The current frame graph and resource model are sufficient for one basic
   render pass but not yet proven for a larger renderer.

## Current Priority

Transport semantics should now be treated as stable unless browser evidence
finds a correctness or material performance problem. The next development
milestone should focus on renderer scalability:

1. Establish controlled Chrome and Edge baselines for the complete runtime.
2. Scale batching beyond consecutive CPU-prepared instance runs.
3. Introduce indirect command storage and indirect drawing.
4. Move visibility/culling to GPU compute when measurements justify it.
5. Preserve the existing ECS/RenderWorld/renderer ownership boundaries while
   doing so.

Textures, lighting, animation, physics, and asset loading remain out of scope
until the renderer scalability foundation is measured and stable.
