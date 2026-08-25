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

# Phase 1: Runtime Foundation

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

# Phase 2: Render Architecture

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

# Phase 3: Performance Infrastructure

## Status

Completed

## Goals

Establish measurement-driven optimization.

Implemented:

- benchmark framework
- ECS benchmarks
- renderer benchmarks
- Three.js comparison harness
- memory statistics
- timing infrastructure

Rules established:

- no performance claims without benchmarks
- no fake comparisons
- reproducible measurements only

---

# Phase 4: Transport Hardening

## Status

Completed

## Objective

Create a scalable communication layer between JavaScript and Rust/WASM.

Goals:

## Shared Memory Improvements

Implement:

- reduced copying
- partial component updates
- dirty range tracking
- stable shared layouts

## Command Transport

Improve:

- structural command handling
- command ring buffers
- batching

## Entity Synchronization

Implement:

- generational shared handles
- safe entity recycling

## Metrics

Track:

- transport latency
- bytes transferred
- synchronization cost

Delivered: a versioned shared-memory layout, partial transform masks,
generation-aware seqlock publication, reusable dirty ranges, a bounded
structural SPSC ring with ordered fallback, hard capacity limits, generational
handles, transport metrics, and Node benchmark evidence. Browser end-to-end
measurement remains an acceptance activity, not unfinished transport design.

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

# Phase 6: Asset Pipeline

## Status

Milestone 7 implementation in progress; Phase 1 complete

## Objective

Create a production-ready web asset workflow.

Goals:

- glTF/GLB support
- mesh optimization
- texture compression
- KTX2 support
- asset registry
- streaming
- caching

The accepted first increment is geometry-only. ADR 011 constrains runtime input
to one indexed static geometry in GLB 2.0 and defines the decoded descriptor.
ADR 012 places fetch/decode in the worker and publishes an opaque
`GeometryHandle` only after atomic readiness. Textures, compression, streaming,
caching, scene hierarchy, and the offline optimizer remain later increments.

Implemented Phase 1: the standalone `@lume/assets` package defines immutable
per-request decode limits and typed asset errors, validates/decodes the accepted
GLB profile into interleaved position/normal values plus widened `uint32`
indices, accounts owned bytes, and covers deterministic malformed boundaries.
Worker orchestration, renderer residency, public loading, and measurements are
still pending.

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

# Phase 7: Advanced Graphics

## Status

Future

Only start after runtime scalability is proven.

Possible features:

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

# Phase 8: Developer Ecosystem

## Status

Future

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

Examples:

Do not add:

PBR

before:

- renderer architecture
- resource management
- material system

Do not add:

complex assets

before:

- asset lifecycle
- memory model

Do not add:

GPU-driven rendering

before:

- RenderWorld
- GPU data layout

---

# Current Focus

Current development focus:

Milestone 7: Asset Pipeline Foundation

Primary questions:

- Can a constrained GLB decoder reject malformed/unbounded input before
  publishing resource state?
- Can worker-owned fetch/decode/upload remain atomic across abort, failure,
  disposal, slot reuse, and device loss?
- What configured encoded, decoded CPU, and GPU byte budgets fit measured web
  product geometry workloads?
- Does `engine.load.geometry()` remain simple without introducing scene-graph or
  pending-handle semantics?

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
