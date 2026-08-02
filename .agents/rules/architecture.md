# Architecture Rules

## Purpose

This document defines non-negotiable architecture constraints for the engine.

These rules exist to prevent short-term implementation decisions from damaging long-term scalability.

Any change violating these rules requires explicit architectural justification.

# System Boundaries

The engine must preserve these layers:

```
Application

↓

Public TypeScript API

↓

Runtime Layer

↓

Worker

↓

Shared Memory Transport

↓

Rust/WASM Core

↓

ECS World

↓

Render Extraction

↓

RenderWorld

↓

FrameGraph

↓

WebGPU Renderer

↓

GPU
```

Each layer has a specific responsibility.

Do not bypass layers without strong justification.

# Rule 1: No Scene Graph Runtime

The engine must not become a traditional scene graph engine.

Forbidden patterns:

```
Scene

 └── Object3D

      └── Mesh

           └── Material
```

Do not introduce:

- parent-child runtime object trees
- transform inheritance through object references
- object traversal rendering

Preferred:

```
Entity IDs

+

Components

+

Systems

+

Render Extraction
```

Hierarchy, if required, must be represented as data.

Example:

Allowed:

```
ParentComponent {
    parentEntity
}
```

Forbidden:

```
child.add(parentObject)
```

# Rule 2: No OOP Engine Architecture

Avoid classical object-oriented engine patterns.

Forbidden:

- inheritance hierarchies
- base engine classes
- abstract managers
- mutable object graphs

Examples:

Forbidden:

```ts
class Mesh extends RenderObject {}
```

Forbidden:

```rust
trait RendererManager {}
```

Preferred:

```ts
createMesh(data);
```

```rust
render(world, resources)
```

# Rule 3: ECS Ownership Rules

ECS owns:

- entities
- components
- simulation state
- world data

ECS does not own:

- GPU buffers
- WebGPU pipelines
- render passes
- textures

Forbidden:

```rust
MeshComponent {
    gpu_buffer: GPUBuffer
}
```

Correct:

```
MeshComponent

↓

MeshHandle

↓

MeshRegistry

↓

GPU Resource
```

# Rule 4: Renderer Isolation

The renderer must never query ECS directly.

Forbidden:

```
Renderer

↓

World.query()
```

Correct:

```
ECS

↓

Extraction System

↓

RenderWorld

↓

Renderer
```

The renderer only consumes render-ready data.

# Rule 5: RenderWorld Separation

RenderWorld exists as a separate representation.

Do not merge:

```
ECS World

+

RenderWorld
```

Reasons:

- interpolation
- multiple cameras
- visibility systems
- GPU-driven rendering
- independent optimization

# Rule 6: Data-Oriented Design

Performance-critical data must be designed around memory access.

Prefer:

```
positions[]

rotations[]

scales[]
```

Avoid:

```
objects[
 {
   position,
   rotation,
   scale
 }
]
```

unless benchmarks prove otherwise.

# Rule 7: No Hidden Allocations

The following areas must remain allocation-free:

- frame loop
- ECS systems
- extraction
- visibility
- render preparation

Forbidden:

```rust
for entity in entities {
    let temp = Vec::new();
}
```

Forbidden:

```ts
function updateFrame() {
  const objects = [];
}
```

Use:

- reusable buffers
- fixed capacity storage
- pooled memory

# Rule 8: Explicit Resource Ownership

Every resource must have a clear owner.

Applies to:

- GPU resources
- assets
- memory buffers
- shared memory

Resource ownership should follow:

```
Handle

↓

Registry

↓

Resource
```

Avoid direct ownership from temporary objects.

# Rule 9: WASM Boundary Rules

The JS/WASM boundary is expensive.

Forbidden:

```
JS

↓

one entity update

↓

WASM call
```

Preferred:

```
JS

↓

batch data

↓

single WASM call
```

Use:

- shared memory
- batch operations
- stable layouts

# Rule 10: Worker Communication Rules

Worker communication must minimize:

- serialization
- copying
- message count

Prefer:

- SharedArrayBuffer
- Atomics
- ring buffers

Use postMessage only for:

- initialization
- rare structural events
- non-performance-critical operations

# Rule 11: WebGPU Ownership

GPU resources belong to renderer-side systems.

Forbidden:

```
Component

↓

GPUBuffer
```

Preferred:

```
Resource Handle

↓

Registry

↓

GPU Resource
```

# Rule 12: Pipeline Creation

GPU pipelines must not be created inside frame rendering.

Forbidden:

```
frame()

    createRenderPipeline()
```

Preferred:

```
Initialization

↓

Pipeline Cache

↓

Runtime Reuse
```

# Rule 13: Benchmark Before Optimization

No performance-related architectural change without measurement.

Required:

Before:

benchmark

Change:

implementation

After:

benchmark

Document:

- improvement
- regression
- tradeoffs

# Rule 14: Avoid Premature Features

Do not introduce:

- physics
- animation frameworks
- complex materials
- editor systems
- networking
- gameplay systems

before core runtime scalability is proven.

# Rule 15: Documentation Requirement

Major architectural decisions require ADRs.

Required sections:

## Context

Why this problem exists.

## Options

Alternative solutions.

## Decision

Chosen approach.

## Consequences

Benefits and costs.

# Architecture Review Checklist

Before merging any major change:

## Boundaries

- Are responsibilities separated?
- Did any layer become dependent on another?

## Data

- Is ownership clear?
- Is memory layout efficient?

## Performance

- Are allocations introduced?
- Are copies minimized?

## Scalability

- Does this work for large scenes?

## DX

- Does the public API remain simple?

# Final Rule

Working code is not enough.

A change that works today but damages the engine architecture is considered incorrect.
