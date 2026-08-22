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

Active; persistent representation foundation implemented

## Objective

Move from basic rendering to large-scale GPU rendering.

Implemented foundation:

- persistent entity-indexed RenderWorld and renderer instance storage (ADR 007)
- coalesced changed-slot uploads and stable visible-slot indirection (ADR 007)
- epoch-gated RenderWorld snapshot and visibility reuse (ADR 008)
- controlled browser evidence for static and dirty workloads

Next implementation sequence:

## Instancing

Preserve:

- thousands of identical objects
- the existing efficient persistent instance buffers

## GPU Buffers

Add:

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

ADR 009 is accepted design, not implemented state. CPU visibility remains the
reference path until compute membership equivalence and the required benchmark
matrix pass. Indirect command generation follows lifecycle correctness rather
than being developed in parallel with it.

---

# Phase 6: Asset Pipeline

## Status

Planned

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

Renderer Scalability

Primary questions:

- Can explicit active/generational slot state make persistent storage safe for
  direct compute consumption?
- Can GPU visibility match the existing CPU reference across sparse occupancy,
  churn, and multiple cameras?
- Do indirect commands improve end-to-end CPU/GPU time without compromising
  deterministic fallback or ownership?
- Can the frame graph express publication, visibility, and submission ordering
  while keeping derived GPU state rebuildable?

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
