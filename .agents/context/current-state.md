# Current Project State

## Project Phase

Current phase:

Foundation and Runtime Scalability

Current priority:

Finalize engine runtime architecture before expanding rendering features.

# Completed Architecture

## Core Runtime

Implemented:

- Rust/WASM core
- TypeScript public API
- Worker-based execution model
- Shared memory communication layer

Architecture:

```
TypeScript API

↓

Worker Runtime

↓

Rust/WASM Core
```

# ECS Status

Current ECS:

- Sparse-set ECS
- Generational entities
- Data-oriented component storage
- Explicit system execution

Implemented components:

- Transform
- MeshRenderer
- Camera
- Bounds
- Material references

ECS responsibilities:

- simulation data
- entity lifecycle
- component storage
- system execution

ECS must not own:

- GPU resources
- render pipelines
- WebGPU state

# Render Architecture Status

Current pipeline:

```
ECS World

↓

Render Extraction

↓

RenderWorld

↓

Visibility System

↓

FrameGraph

↓

WebGPU Renderer
```

Implemented:

- RenderWorld separation
- render extraction layer
- visibility pipeline
- frustum culling
- frame graph foundation

# WebGPU Renderer Status

Implemented:

- WebGPU initialization
- render pipelines
- vertex buffers
- index buffers
- uniform buffers
- depth buffer
- mesh registry
- material registry
- pipeline caching foundation

Current supported rendering:

- triangle rendering
- indexed cube rendering
- basic materials

Not implemented yet:

- textures
- PBR
- lighting systems
- shadows
- post processing

# Memory Architecture Status

Implemented:

- SharedArrayBuffer transport
- seqlock synchronization
- dirty tracking
- batch updates
- SPSC queues

Current goals:

- reduce memory copies
- improve transport scalability
- finalize runtime communication model

# Current Milestone

## Milestone 5: Transport Hardening

Goals:

- minimize SAB → WASM copying
- partial component updates
- dirty range tracking
- structural command ring buffer
- generational shared handles
- entity recycling
- transport metrics
- large scale benchmarks

# Do Not Implement Yet

The following features are intentionally postponed:

## Rendering Features

Do not add:

- PBR materials
- physically based lighting
- shadows
- reflections
- post processing

## Content Pipeline

Do not add:

- full asset pipeline
- editor tooling
- scene authoring system

## Engine Features

Do not add:

- physics
- gameplay systems
- animation framework
- networking

Reason:

The runtime architecture must be proven first.

# Performance Targets

The engine should optimize for:

## CPU

- low frame preparation time
- predictable execution
- zero allocation hot paths

## Memory

- minimal copying
- predictable usage
- explicit ownership

## GPU

- efficient batching
- pipeline reuse
- scalable rendering

# Current Known Risks

## Transport Overhead

Remaining concern:

SAB to WASM copying.

Goal:

Move toward lower-copy or zero-copy data flow.

## Large Scene Scaling

Need validation:

- 100k entities
- 500k entities
- 1M entities

## Browser Validation

Need real browser benchmarks:

- Chrome
- Edge

with:

- WebGPU enabled
- same hardware
- controlled resolution

# Benchmark Status

Implemented benchmarks:

## ECS

- entity creation
- transform updates
- extraction

## Rendering

- cube rendering
- object scaling tests

## Transport

- command transport
- shared memory transport

All performance claims require benchmark evidence.

# Current Recommended Next Steps

Priority order:

1. Complete transport hardening.

2. Validate large-scale runtime behavior.

3. Run browser-based performance comparisons.

4. Freeze core architecture.

5. Begin rendering expansion:

   - GPU instancing
   - indirect rendering
   - texture system
   - advanced materials

# Architectural Reminder

Do not optimize for adding features quickly.

The current objective is building a scalable engine foundation.

The engine should become harder to break as it grows.
