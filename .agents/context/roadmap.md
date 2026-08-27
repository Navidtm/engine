# Engine Roadmap

## Vision

Build a modern WebGPU-native 3D engine runtime for the web.

The engine prioritizes:

- performance
- memory efficiency
- developer experience
- scalable architecture

The roadmap follows a foundation-first approach.

Features are added only after the underlying architecture is proven.

# Development Philosophy

Priority order:

1. Runtime foundation

2. Memory and data flow

3. Rendering scalability

4. Developer experience

5. Asset ecosystem

6. Advanced graphics features

Do not reverse this order unless there is a strong architectural reason.

---

# Milestone 1: Runtime Foundation

## Status

Completed

## Goals

Create the fundamental engine architecture.

Implemented:

- Rust/WASM core
- TypeScript API layer
- Worker runtime
- Sparse-set ECS
- Generational entities
- Component storage
- System execution
- Basic WebGPU renderer

Architecture established:

```
TypeScript

↓

Worker

↓

Rust/WASM

↓

ECS

↓

Renderer

↓

WebGPU
```

---

# Milestone 2: ECS-Driven Mesh Rendering

## Status

Completed

## Goals

Separate simulation and rendering.

Implemented:

- RenderWorld
- Render Extraction
- Transform pipeline
- Camera system
- Mesh registry
- Material registry
- FrameGraph foundation
- Visibility system
- Frustum culling

Architecture:

```
ECS World

↓

Extraction

↓

RenderWorld

↓

Renderer

↓

GPU
```

---

# Milestone 3: Visibility and Frame Orchestration

## Status

Completed

## Goals

Add scalable visibility, frame orchestration, material grouping, and controlled
rendering evidence on top of the ECS-to-RenderWorld boundary.

Implemented:

- allocation-free CPU frustum culling and reusable visibility output;
- grouping by pipeline, material, and geometry;
- reusable FrameGraph compilation and execution order;
- color-only basic materials and optional GPU timestamps;
- high-level authoring APIs over the advanced ECS surface; and
- ECS, renderer, memory, and controlled comparison benchmarks.

Rules established:

- no performance claims without benchmarks
- no fake comparisons
- reproducible measurements only

---

# Milestone 4: High-Throughput Transport

## Status

Completed

## Objective

Move hot transform publication from structured-clone commands to a versioned
SharedArrayBuffer path with one batched WASM boundary crossing.

Delivered: shared transform state, dirty-index publication, worker-side
coalescing into preallocated WASM staging, one batch apply call, capability
fallback to worker messages, and controlled transport comparison infrastructure.

---

# Milestone 5: Transport Hardening

## Status

Completed

## Objective

Make the transport and public lifecycle generation-safe, capacity-bounded, and
observable under partial updates, overflow, reuse, failure, and scale.

Delivered:

- per-field transform masks and adjacent dirty-range staging;
- generation-aware seqlock publication;
- a bounded structural SPSC ring with ordered message overflow fallback;
- complete generational handles across main thread, worker, WASM, and renderer;
- entity slot recycling and retirement before generation wrap;
- explicit component/resource/render capacities and transactional creation;
- transport metrics, composed lifecycle coverage, and Node scale evidence.

Browser end-to-end measurement remains an acceptance activity, not unfinished
transport architecture.

---

# Milestone 6: Renderer Scalability

## Status

Completed

## Objective

Move from basic rendering to large-scale GPU rendering.

Implemented:

- persistent entity-indexed RenderWorld and renderer instance storage (ADR 007)
- coalesced changed-slot uploads and stable visible-slot indirection (ADR 007)
- epoch-gated RenderWorld snapshot and visibility reuse (ADR 008)
- controlled browser evidence for static and dirty workloads
- explicit active/generational slot state and domain-specific dirty publication
- compute frustum visibility validated against the CPU oracle
- per-run indirect commands and indexed indirect drawing
- automatic renderer/resource reconstruction after device loss
- controlled scalability/equivalence matrix

## Instancing

Preserve:

- thousands of identical objects
- the existing efficient persistent instance buffers

## GPU Buffers

Implemented:

- explicit active/generational slot-state storage from ADR 009
- indirect buffers
- domain-specific dirty publication required by ADR 009

## GPU Driven Rendering

Validate and move toward:

```
Scene Data

↓

GPU Compute

↓

Culling

↓

Indirect Draw

↓

GPU
```

ADR 009 is implemented. CPU visibility remains the reference and automatic
fallback; `auto` selects CPU because no portable crossover threshold was proven.
GPU visibility is explicit opt-in and is accompanied by pull-sampled
same-frame count/hash equivalence diagnostics in benchmarks.

---

# Milestone 7: Asset Pipeline Foundation

## Status

Completed

## Objective

Establish bounded, replayable external geometry loading as the first increment
of a production-ready web asset workflow.

The accepted first increment is geometry-only. ADR 011 constrains runtime input
to one indexed static geometry in GLB 2.0 and defines the decoded descriptor.
ADR 012 places fetch/decode in the worker and publishes an opaque
`GeometryHandle` only after atomic readiness. Textures, compression, streaming,
caching, scene hierarchy, and the offline optimizer remain later increments.

Implemented Phase 1: the standalone `@lume/assets` package defines immutable
per-request decode limits and typed asset errors, validates/decodes the accepted
GLB profile into interleaved position/normal values plus widened `uint32`
indices, accounts owned bytes, and covers deterministic malformed boundaries.
Phase 2 adds transactional external renderer residency/removal and
unchanged-handle device-loss replay. Phase 3 adds bounded worker fetch/decode,
Resource Coordinator loading states, immutable CPU/GPU budgets, cancellation,
rollback, and replay. Phase 4 exposes `engine.load.geometry()` with atomic ready
publication, typed failure, abort, and lifecycle semantics. Phase 5 commits the
controlled small/medium/large measurement matrix, validates peak/retained/GPU
accounting and steady-state inactivity, and adds a heavy multi-feature browser
showcase.

Implementation and completion gates are in
[`docs/milestone-7.md`](../../docs/milestone-7.md).

Architecture:

```
Source Assets

↓

Offline Processing

↓

Runtime Assets

↓

GPU Resources
```

---

# Milestone 8: Texture and Sampler Foundation

## Status

Proposed — next design milestone

## Objective

Add bounded, replayable texture and sampler resources without introducing PBR,
general glTF scene loading, or streaming.

## Entry Gates

- Milestone 7 remains complete under its browser and accounting gates.
- A milestone document defines the accepted KTX2 profile, color-space policy,
  mip policy, sampler normalization, and capability fallback.
- ADRs define texture/sampler identity, ownership edges, async publication,
  retirement, device-loss replay, and CPU/GPU budgets.
- Deterministic color, normal, alpha, mip, malformed, and over-budget fixtures
  exist before production decoding starts.

## Planned Deliverables

- Pure container validation and device-independent texture descriptors in the
  asset package.
- Worker-owned bounded read/transcode/upload transactions with cancellation and
  atomic ready-handle publication.
- Renderer-owned texture views and samplers under typed generational handles.
- Explicit GPU-format capability selection and deterministic fallback behavior.
- Pull-based encoded, temporary, retained, resident, transcode, and upload
  diagnostics.
- Public loading and destruction APIs whose exact shape is fixed by accepted
  design rather than this roadmap.

## Evidence and Exit Gate

- Validation and lifecycle correctness matrices pass for representative 2D
  textures, mip chains, alpha modes, supported GPU formats, cancellation,
  capacity failure, disposal, and device loss.
- Controlled browser measurements record payload, transcode/upload latency,
  peak/retained/resident bytes, cleanup, and steady-state activity on at least
  one hardware GPU and the CI fallback path.
- Architecture, API, package, examples, current-state, and roadmap documents
  agree.

## Explicit Non-Goals

- PBR material evaluation, imported glTF materials, lighting, shadows, and
  post-processing.
- General PNG/JPEG runtime ingestion as the production texture path.
- Runtime mip generation, virtual texturing, streaming, caching, or eviction.
- Multi-mesh scene instantiation or a scene graph.

---

# Milestone 9: Material and Lighting Foundation

## Status

Blocked on Milestone 8

## Objective

Replace the color-only material path with a bounded WebGPU-native material
foundation that composes texture/sampler handles and supports a deliberately
small physically based product-visualization path.

## Required Scope

- Material descriptors with explicit texture/sampler dependency edges and
  transactional retirement.
- GPU parameter storage that scales beyond one buffer per material.
- Stable pipeline keys, asynchronous prewarming, and bounded variant creation.
- A minimal PBR surface model and minimal lighting set selected by an accepted
  ADR and controlled reference images.
- Device-loss replay, CPU/GPU memory accounting, and material/variant scale
  measurements.

## Explicit Non-Goals

- Material graphs, arbitrary shader injection, clustered lighting, shadows,
  reflections, and post-processing.
- Parsing arbitrary glTF material extensions.
- General scene loading.

Exit gate: representative textured product materials render deterministically,
resource dependencies retire correctly, pipeline variants remain bounded, and
committed evidence covers material count and visible-instance scale.

---

# Milestone 10: Asset Preparation and Composition

## Status

Blocked on Milestones 8 and 9

## Objective

Turn common creative-tool glTF/GLB exports into explicit runtime-ready geometry,
texture, material, and instance recipes without making the runtime a scene graph
or a general-purpose content processor.

## Required Scope

- An offline CLI/library that validates source assets, applies node transforms,
  normalizes coordinate conventions, optimizes geometry, processes textures,
  and emits deterministic runtime-ready outputs.
- Multi-mesh and multi-primitive composition through flat data recipes and typed
  resource handles.
- Atomic public asset loading that publishes no partial entity/resource graph.
- Content manifests, reproducible builds, diagnostics, and source-to-runtime
  provenance.
- Real Blender-export fixtures covering multiple meshes, materials, textures,
  and node transforms.

## Explicit Non-Goals

- Runtime Object3D hierarchy, arbitrary editor metadata, animation, skinning,
  morph targets, or runtime mesh optimization.
- Silent support for every glTF extension.
- Streaming and persistent cache policy.

Exit gate: a representative textured multi-mesh product can be prepared
offline, loaded transactionally, instantiated through ECS data, destroyed, and
replayed after device loss with measured memory and load cost.

---

# Milestone 11: Streaming and Cache Policy

## Status

Blocked on measured Milestone 10 workloads

## Objective

Add demand-driven asset residency only after complete assets have deterministic
ownership, dependency edges, budgets, and representative measurements.

Planned design areas:

- request deduplication and cancellation;
- priority and concurrency control;
- memory-pressure-aware eviction and pinning;
- progressive geometry/texture residency and LOD policy;
- persistent cache versioning and invalidation; and
- recovery behavior for partially resident resources.

No streaming implementation starts until an ADR defines cache identity,
dependency-aware eviction, partial-readiness semantics, and failure rollback.

---

# Later Advanced Graphics

## Status

Future, ordered only after the resource foundations above

Candidate work:

## Materials

- PBR
- advanced shaders
- material graph

## Lighting

- shadows
- clustered lighting
- GPU light culling

## Effects

- post processing
- particles
- reflections

---

# Continuous Developer Ecosystem Track

## Status

Active alongside stable milestones

Goals:

- documentation
- examples
- framework integrations
- debugging tools
- profiling tools

Possible integrations:

- React
- Vue
- Svelte

Framework integrations must follow stable public APIs; they must not define
engine ownership or lifecycle semantics. Debugging and profiling tools may be
added earlier when they expose existing diagnostics without adding hot-path
work.

---

# Features Intentionally Delayed

The following are not priorities currently:

## Physics

Reason:

Not core to web visualization workloads.

## Editor

Reason:

Requires stable runtime first.

## Multiplayer

Reason:

Not part of core rendering architecture.

## Full Game Engine Features

Reason:

The project is a web graphics runtime, not a game engine.

---

# Architectural Gates

A phase cannot start unless previous foundations are stable.

- Do not implement PBR before texture/sampler ownership, budgets, and replay are
  accepted and implemented.
- Do not implement general asset composition before geometry, texture, and
  material resources have independent transactional lifecycles.
- Do not implement streaming/cache eviction before representative complete-asset
  workloads are measured and dependency-aware residency is designed.
- Do not introduce runtime object hierarchy to mirror glTF nodes; composition
  remains flat data plus ECS entities/components.
- Do not start production code for a Proposed milestone before its milestone
  document, ADRs, fixtures, issue plan, and benchmark method make it Ready.

---

# Current Focus

Current development focus:

Milestone 8 texture and sampler design gates

Required next actions before production code:

1. Create `docs/milestone-8.md` with phases, entry/exit gates, correctness
   matrix, benchmark plan, and explicit non-goals.
2. Draft ADRs for texture format/capability selection and async
   texture/sampler lifecycle; reuse ADR 004 rather than duplicating its general
   ownership rules.
3. Define deterministic KTX2/Basis fixtures and a representative hardware and
   browser matrix.
4. Turn accepted phases into focused GitHub issues with concrete acceptance
   criteria.
5. Begin implementation only after architecture, asset-pipeline, WebGPU,
   performance, and API reviews agree on the design.

---

# Long-Term Goal

The final engine should provide:

For developers:

- simple API
- fast iteration
- web-native workflow

For runtime:

- native-like performance
- scalable rendering
- predictable memory

For architecture:

- clean data flow
- maintainable systems
- future-proof design
