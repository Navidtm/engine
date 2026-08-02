# Engine Glossary

## Purpose

This document defines project-specific terminology.

Terms in this file have precise meanings inside this engine.

Do not assume meanings from other engines, frameworks, or game engine conventions.

---

# Engine

## Engine Runtime

The complete execution system responsible for:

- managing runtime state
- processing data
- preparing rendering
- communicating with GPU

It does not mean only the renderer.

---

# Entity

## Entity

A lightweight identifier representing an object in the runtime.

An entity contains:

- index
- generation

Example:

```rust
Entity {
    index: u32,
    generation: u32
}
```

Entities do not contain:

- behavior
- data
- GPU resources

Data belongs to components.

---

# Component

## Component

A pure data container attached to entities.

Examples:

- Transform
- Camera
- MeshRenderer
- Bounds

Components must not contain:

- update methods
- rendering logic
- GPU resources

---

# System

## System

A function or module that processes component data.

Example:

```
Input Data

↓

System

↓

Updated Data
```

Systems contain logic.

Components contain data.

---

# World

## ECS World

The primary simulation data container.

Owns:

- entities
- components
- ECS storage

Responsible for:

- simulation state
- component queries
- system execution

Does not own:

- GPU resources
- render pipelines

---

# RenderWorld

## RenderWorld

A rendering-specific data representation extracted from ECS World.

Purpose:

- prepare GPU-friendly data
- separate simulation from rendering
- enable future GPU-driven rendering

Flow:

```
ECS World

↓

Extraction

↓

RenderWorld

↓

Renderer
```

RenderWorld is not a second ECS.

It is a render preparation structure.

---

# Render Extraction

## Extraction

The process of converting simulation data into render data.

Example:

Input:

```
Transform Component
Mesh Component
Camera Component
```

Output:

```
Render Instance Data
Camera Buffers
GPU Preparation Data
```

Extraction creates a boundary between simulation and rendering.

---

# Handle

## Handle

A lightweight stable reference to a resource.

Examples:

- MeshHandle
- MaterialHandle
- TextureHandle

A handle does not contain the resource.

Structure:

```
Handle

↓

Registry

↓

Resource
```

---

# Registry

## Registry

A storage system responsible for owning resources.

Examples:

```
MeshHandle

↓

MeshRegistry

↓

GPU Buffer
```

Responsibilities:

- resource ownership
- lookup
- lifetime management

---

# Resource

## Resource

An owned runtime object required for execution.

Examples:

- GPUBuffer
- Texture
- Pipeline
- Asset

Resources must have:

- owner
- lifetime
- destruction strategy

---

# GPU Resource

## GPU Resource

A resource managed by the WebGPU renderer.

Examples:

- GPUBuffer
- GPUTexture
- GPURenderPipeline

GPU resources belong to renderer-side systems.

They do not belong to ECS components.

---

# Renderer

## Renderer

The low-level GPU execution system.

Responsible for:

- WebGPU commands
- pipelines
- render passes
- GPU resource management

The renderer consumes RenderWorld.

The renderer does not query ECS.

---

# FrameGraph

## FrameGraph

A system describing rendering execution order and dependencies.

Responsibilities:

- pass ordering
- resource dependencies
- resource lifetime

Example:

```
Shadow Pass

↓

Main Pass

↓

Post Process
```

---

# Pipeline

## Render Pipeline

A compiled GPU rendering configuration.

Contains:

- shaders
- vertex layout
- depth state
- blend state
- bind layouts

Pipelines should be cached and reused.

---

# Material

## Material

A GPU-facing description of how geometry is rendered.

A material is data.

It is not an object hierarchy.

Preferred:

```
Material Data

↓

Material Registry

↓

GPU Bindings
```

---

# Geometry

## Geometry

Mesh data used for rendering.

Contains:

- vertices
- indices
- attributes

Geometry is not a render object.

---

# Transport

## Transport Layer

The communication mechanism between TypeScript runtime and Rust/WASM core.

Current approach:

```
TypeScript

↓

SharedArrayBuffer

↓

Worker

↓

WASM
```

Responsibilities:

- move data efficiently
- minimize copying
- synchronize updates

---

# SharedArrayBuffer

## SharedArrayBuffer (SAB)

Shared memory region used for high-frequency communication.

Used for:

- transform updates
- batch data transfer

Not used for:

- arbitrary object communication

---

# Command

## Command

A structured operation sent between systems.

Examples:

- create entity
- destroy entity
- update resource

Commands should be:

- batchable
- predictable
- low overhead

---

# Hot Path

## Hot Path

Code executed frequently during runtime.

Examples:

- frame loop
- transform update
- extraction
- visibility calculation

Hot paths must avoid:

- allocations
- unnecessary branching
- expensive synchronization

---

# Zero Allocation Runtime

## Zero Allocation Runtime

A runtime design where critical execution paths do not allocate new memory during execution.

Does not mean:

"No memory allocation exists."

It means:

Memory allocation happens outside critical loops.

---

# Data-Oriented Design

## Data-Oriented Design

An architecture that prioritizes:

- memory layout
- cache behavior
- batch processing

The question is:

"How is data stored and processed?"

not:

"What object owns this behavior?"

---

# Worker

## Worker Runtime

A browser worker responsible for running engine execution away from the main thread.

Responsibilities:

- WASM execution
- runtime processing
- rendering preparation

---

# WebGPU Renderer

## WebGPU Renderer

The GPU backend using WebGPU APIs.

It manages:

- command encoding
- pipelines
- buffers
- render passes

It is not responsible for:

- simulation
- ECS
- application state

---

# Benchmark

## Benchmark

A reproducible measurement of engine behavior.

A benchmark requires:

- defined workload
- environment
- methodology
- results

Benchmarks are evidence.

They are not marketing numbers.

---

# Milestone

## Milestone

A validated architectural development step.

A milestone is complete only when:

- implementation exists
- tests pass
- benchmarks are understood
- documentation is updated

---

# Architecture Principle

The engine follows this mental model:

```
Data

↓

Systems

↓

Prepared Data

↓

GPU Execution
```

Not:

```
Objects

↓

Methods

↓

Rendering
```

All future terminology should preserve this distinction.
