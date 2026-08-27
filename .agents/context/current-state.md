# Current Project State

Last verified: 2026-08-27 on master after Milestone 7 completion

This document records the implementation that exists in the repository. It is
an evidence-based snapshot, not a description of intended future architecture.

## Executive Status

The engine has completed its runtime-foundation, transport-hardening, and
renderer-scalability work. ADR 007 persistent storage, ADR 008 epoch-gated
reuse, and ADR 009 active/generational slot state, compute visibility, and
indirect drawing are implemented and measured. The geometry-only Asset Pipeline
Foundation is also complete: constrained GLB decode, bounded worker loading,
external GPU residency/replay, public loading, controlled evidence, and browser
examples are implemented.

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
  -> CPU reference visibility and GPU compute visibility
  -> compiled FrameGraph
  -> direct or indexed-indirect WebGPU submission
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
- Worker scheduler epochs invalidate callbacks queued before stop, restart,
  failure, device loss, or disposal.
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
- Idempotent start/stop intent with lifecycle-epoch acknowledgement correlation;
  stop becomes externally final only after the matching worker confirmation.
- High-level mesh, perspective-camera, and basic-material creation.
- Lower-level `world` API for entity creation/destruction and component
  addition/removal.
- Immutable engine-owned entity handles shaped as `{ index, generation }`.
- Typed engine-owned generational geometry and basic-material handles with
  main-thread ownership/liveness validation.
- Validation of handle ownership, liveness, index, and generation before use.
- Validation of authoring tuples, camera/bounds ranges, and foreign material
  handles before an entity slot is allocated or a command is published.
- Fixed-capacity entity allocation, free-list reuse, permanent retirement before
  12-bit generation wrap, and engine-lifetime stale-handle rejection.
- Observable effective entity, component, typed-resource, and render capacities
  through `engine.capacities`; the engine-owned camera reservations are excluded
  from public limits.
- Machine-readable synchronous capacity errors and transactional high-level mesh
  creation, including rollback of lazy default-material allocation.
- Declarative scene components for transform, mesh, bounds, camera, and basic
  material data.

Current content support is deliberately small: worker-coordinated built-in
triangle and box resources, constrained external static GLB geometry, and
color-only basic-material resources. Mesh replacement/removal updates tracked
usage edges transactionally, and retirement waits for existing mesh users before
logical destruction.

### Asset Pipeline Foundation

Implemented for Milestone 7:

- A standalone `@lume/assets` package with no API, runtime, ECS, renderer, DOM
  canvas, or WebGPU dependency.
- Required immutable per-request limits for encoded bytes, decoded bytes,
  vertices, and indices; no unmeasured production defaults.
- Stable typed asset error codes/stages across the public/worker contract.
- Strict GLB 2.0 header/chunk, UTF-8/JSON, accepted-profile, accessor,
  alignment, bounds, overflow, finite-value, position-bound, index-range, and
  budget validation.
- Decoding to replayable six-float interleaved position/normal vertices and
  widened `uint32` triangle-list indices with exact owned-array byte accounting.
- Deterministic generated fixtures and regression tests covering valid
  16/32-bit inputs and malformed/unsupported/budget boundaries.
- Worker-owned bounded fetch/read/decode/upload transactions with attempt epochs,
  cancellation, rollback, typed failures, and aggregate byte admission.
- Resource Coordinator loading/ready/retirement states, replayable decoded
  descriptors, usage edges, and exact temporary/retained/resident accounting.
- Transactional renderer registration/removal and unchanged-handle replay across
  recoverable device loss.
- Public `engine.load.geometry()` promise correlation, optional `AbortSignal`,
  atomic ready-handle publication, terminal lifecycle rejection, and normal
  deferred destruction.
- Pull-based asset statistics with peak temporary reservations and cold-path
  fetch/read, decode, renderer-wait, upload, and total timing diagnostics.
- Deterministic small/medium/large controlled browser measurements committed at
  `benchmarks/results/asset-pipeline-latest.json`.
- Focused geometry-loading and heavier asset-showcase browser examples plus
  production-build Chrome/WebGPU smoke coverage.

### Rust/WASM Core and ECS

Implemented:

- Sparse-set component storage with generational entity validation and hard
  entity/component capacity limits; normal operation does not grow WASM memory.
- A 32-bit packed handle: 20-bit index and 12-bit generation.
- Safe destroy/recycle behavior in both TypeScript and Rust allocators.
- Data-oriented stores for transforms, mesh renderers, cameras, bounds, and a
  derived fixed-capacity material resource mirror.
- Preallocated WASM staging arrays for shared transform updates.
- ABI versioning and capacity checks at the TypeScript/WASM boundary.
- Batched application of dirty transform ranges with per-field masks.

ADR 010 keeps the compact 20-bit index and 12-bit generation ABI but retires a
slot after its generation-4095 entity is destroyed. Retained stale handles
therefore cannot alias a new entity during the engine lifetime. The bounded
tradeoff is at most 4,096 allocations per slot before reusable capacity
declines; measured Node lifecycle cost remains within the wrapping baseline's
observed range.

### Render Extraction and Visibility

Implemented:

- Separate, reusable `RenderWorld` storage.
- Extraction of instance matrices, colors, geometry/material/pipeline IDs,
  camera matrices, and bounding spheres.
- Persistent entity-indexed instance records with generational/revision dirty
  tracking and coalesced upload ranges.
- Epoch-gated reuse of unchanged instance metadata and bounds, plus retained
  visibility when the active camera is also unchanged.
- CPU frustum culling using sphere bounds.
- Reusable visibility output buffers.
- CPU ordering by pipeline, material, and geometry for consecutive draw runs.
- Capacity limits with explicit failure when extracted data exceeds the
  configured entity capacity.
- Persistent 16-byte active/generational slot state, bounds, and resource-key
  domains with independent coalesced dirty ranges.
- Transactional extraction: dependency/capacity failure preserves the last
  successful snapshot and publishes no partial domains.
- Generation replacement performs a full-domain publication; deactivation
  clears eligibility without interpreting stale payload bytes.
- Independent CPU visibility output for one, two, and four cameras over shared
  persistent scene state.

The visibility system currently uses the first extracted camera. Storage can
hold multiple cameras, but true multi-camera rendering is not implemented.

### FrameGraph

Implemented:

- Functional pass/resource declarations.
- Dependency validation and topological compilation.
- Reusable compiled execution order.
- Current renderer graph with ordered upload, compute-visibility, and main
  render passes.

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
- Private generational geometry/material registries; geometry registry entries
  own the built-in vertex/index buffers.
- Depth target creation and resize handling.
- Pull-triggered, single-in-flight timestamp-query sampling when supported;
  ordinary frames create no timestamp mapping promise or result wrapper.
- Pull-sampled split CPU instrumentation for transport apply, systems,
  extraction, visibility, upload, render preparation, encoding, and submission;
  fixed latest/cumulative counters add no stage clocks to ordinary frames.
- Indexed drawing and CPU-prepared instancing: consecutive compatible visible
  items are submitted with one `drawIndexed` call using `instanceCount`.
- Persistent state, bounds, resource, candidate, visible-output, indirect, and
  compute-parameter buffers sized at renderer initialization.
- GPU compute frustum visibility with active, payload-generation, and resource
  identity validation, followed by per-run `drawIndexedIndirect` submission.
- Public `cpu`, `gpu`, and `auto` visibility policy; `auto` intentionally uses
  CPU until measurements establish a portable crossover threshold.
- Pull-only GPU visibility diagnostics with transactionally paired CPU/GPU
  counts and order-independent membership hashes; normal frames do no readback.
- Automatic device-loss reconstruction of renderer buffers/pipelines and live
  built-in resource descriptors, followed by a full derived-scene republish.
- Transactional renderer/WASM initialization with cleanup of partial and late
  successful resources.

Current limitations:

- One basic pipeline and color-only material path.
- `auto` has no GPU crossover heuristic and therefore retains CPU visibility.
- Public presentation still renders the first camera, although core visibility
  supports independent multi-camera results.
- No occlusion culling, hierarchical active masks, or GPU-authoritative scene.

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
- Race-safe inline reclaim when a producer updates a slot during consumption,
  preserving exclusive producer ownership of the SPSC queue tail.
- One ranged WASM apply call after staging.

The matrix mask is a protocol marker; matrices are currently derived by Rust
rather than copied as transform input.

### Structural Commands

Implemented shared SPSC commands include:

- create and destroy entity;
- add transform, material, camera, mesh, and bounds;
- remove component.

The ring is lock-free, FIFO, bounded, and fixed-record-width. Overflow is
observable through `droppedCommands`; the worker drains older shared structural
and transform publications before applying the attempted command, then the API
routes all later structural and transform authoring through the ordered
`postMessage` stream. Initialization batches and non-SAB environments also use
messages.

### Transport Metrics

`engine.getStats().transport` exposes:

- `messages`;
- `sharedWrites`;
- `dirtyRanges`;
- `bytesUploaded`;
- `queueDepth`;
- `droppedCommands`;
- `droppedTransforms`.

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
renderer/comparison/transport harnesses. Controlled Chrome results now cover
persistent upload and incremental RenderWorld decisions; equivalent Edge
results remain outstanding.

`benchmarks/results/entity-generation-latest.json` compares one million
same-slot lifecycle operations, five million validation operations, Node Atomics
publication cost, and deterministic memory/layout effects for wrapping 20/12,
retiring 20/12, packed 16/16, split 32/32, and BigUint64 identities. Retirement
measured within the wrapping lifecycle range while preserving the existing ABI;
ADR 010 records the decision and its bounded lifetime reuse budget.

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
and timestamp profiling. Deterministic seeded state machines additionally
compose entity reuse, partial/repeated transforms, conceptual drains, structural
overflow, ordered fallback, initialization races, resize, scheduler epochs,
device loss, and disposal. A failing state-machine seed can be rerun with
`LUME_TEST_SEED=<unsigned-u32>`. End-to-end browser tests for the complete
main-thread/worker/WASM/WebGPU path are not yet part of CI.

## Renderer Scalability Completion

The transition from transport hardening into renderer scalability is based on
explicit completed issues rather than a general readiness claim:

| Gate                                           | Completed issue                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Persistent instance storage and dirty uploads  | [#8](https://github.com/Navidtm/engine/issues/8)                                                       |
| Epoch-gated extraction and controlled evidence | [#9](https://github.com/Navidtm/engine/issues/9)                                                       |
| SAB/message fallback ordering                  | [#16](https://github.com/Navidtm/engine/issues/16)                                                     |
| Stop/restart scheduler epochs                  | [#17](https://github.com/Navidtm/engine/issues/17)                                                     |
| Typed generational resource identity           | [#18](https://github.com/Navidtm/engine/issues/18)                                                     |
| Active persistent-slot design gate             | [#19](https://github.com/Navidtm/engine/issues/19)                                                     |
| Allocation-safe and pull-sampled profiling     | [#20](https://github.com/Navidtm/engine/issues/20), [#21](https://github.com/Navidtm/engine/issues/21) |
| Explicit capacity and transactional creation   | [#22](https://github.com/Navidtm/engine/issues/22)                                                     |
| Generation exhaustion without stale aliasing   | [#23](https://github.com/Navidtm/engine/issues/23)                                                     |
| Deterministic composed boundary coverage       | [#24](https://github.com/Navidtm/engine/issues/24)                                                     |

The gates above enabled the now-completed ADR 009 implementation. Lifecycle,
transactionality, multi-camera, reconstruction, and disposal tests pass; the
controlled CPU/GPU/AUTO matrix and correctness hashes are committed in
`benchmarks/results/renderer-scalability-latest.json`. The complete delivered
scope and non-goals are in [`docs/milestone-6.md`](../../docs/milestone-6.md).

## Roadmap Comparison

| Roadmap phase                 | Roadmap label | Actual repository state                           |
| ----------------------------- | ------------- | ------------------------------------------------- |
| 1. Runtime Foundation         | Completed     | Implemented                                       |
| 2. Render Architecture        | Completed     | Implemented                                       |
| 3. Performance Infrastructure | Completed     | Implemented                                       |
| 4. Transport Hardening        | Completed     | Implemented                                       |
| 6. Renderer Scalability       | Completed     | ADR 007/008/009 implemented, tested, and measured |
| 6. Asset Pipeline             | Completed     | Milestone 7 implemented, tested, and measured     |
| 7. Advanced Graphics          | Planned       | Not implemented                                   |
| 8. Developer Ecosystem        | Planned       | Not implemented                                   |

## Intentionally Not Implemented

- Textures, samplers, texture streaming, and texture compression.
- PBR materials, lighting, shadows, reflections, and post-processing.
- General glTF scenes, multi-primitive loading, textures, and asset streaming.
- Animation, skinning, morph targets, and skeletal systems.
- Physics, networking, gameplay systems, editor, or scene authoring.
- Occlusion culling, hierarchical active masks, and GPU-authoritative scenes.
- Public multi-camera presentation; only the first camera is rendered.

These omissions match the roadmap and the scope constraints of the completed
renderer-scalability milestone.

## Remaining Runtime and Rendering Bottlenecks

1. The required SAB-to-WASM staging copy still scales linearly with the number
   and size of dirty fields.
2. Changed scenes still use CPU extraction and render-key grouping. GPU
   visibility consumes a compact candidate list rather than scanning a
   hierarchical active mask.
3. Static frames reuse extraction and visibility, but any render mutation still
   rebuilds the complete compact snapshot.
4. Indirect commands are partitioned by CPU-prepared resource runs; fully
   GPU-generated resource grouping is not implemented.
5. The committed browser matrix is device-specific evidence, not a portable
   crossover threshold. `auto` therefore remains on CPU visibility.
6. The current frame graph and resource model are sufficient for one basic
   render pass but not yet proven for a larger renderer.

## Current Priority

Runtime transport, renderer-scalability, and Milestone 7 geometry-loading
semantics should now be treated as stable unless browser evidence finds a
correctness or material performance problem. ADR 011, ADR 012, and
`docs/milestone-7.md` define the completed constrained-geometry scope and gates.
The next architecture design step is texture/sampler ingestion with KTX2,
GPU-format selection, color-space and mip policy, material dependencies,
CPU/GPU budgets, and replay. General materials, hierarchy, compression,
streaming, caching, and an offline optimizer remain future work. All asset work
must preserve the existing ECS -> RenderWorld -> renderer ownership boundary.
