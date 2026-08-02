# Project Identity

## Overview

This project is a next-generation WebGPU-native 3D engine runtime.

It is designed to provide a modern foundation for high-performance interactive 3D experiences on the web.

The engine is not a Three.js wrapper and should not replicate Three.js architecture.

The goal is to create a new generation browser graphics runtime focused on:

- performance
- memory efficiency
- developer experience
- scalability
- clean architecture

# Primary Use Cases

The engine targets:

- interactive 3D websites
- product visualization
- digital experiences
- browser-based 3D applications
- data visualization

This project is not primarily a game engine.

Game-engine patterns should not be introduced unless they directly benefit web 3D workloads.

# Core Vision

The engine should provide:

## Internal Complexity

A highly optimized runtime based on:

- Rust
- WebAssembly
- WebGPU
- ECS
- data-oriented design
- explicit memory management

## External Simplicity

A developer-friendly TypeScript API where users do not need to understand:

- WASM internals
- worker communication
- GPU resources
- memory synchronization
- rendering pipelines

The internal architecture may be complex.

The public API must remain simple.

# Technology Stack

Core:

- Rust
- WebAssembly

Public API:

- TypeScript

Graphics:

- WebGPU

Shader language:

- WGSL

Execution model:

- Web Worker
- SharedArrayBuffer communication

Architecture:

Application

↓

TypeScript API

↓

Worker Runtime

↓

Shared Memory Layer

↓

Rust/WASM Core

↓

ECS

↓

Render Extraction

↓

RenderWorld

↓

FrameGraph

↓

WebGPU

# Non-Negotiable Principles

## 1. Functional Architecture

Prefer:

- modules
- pure functions
- explicit state
- composition

Avoid:

- inheritance
- deep class hierarchies
- mutable object graphs
- hidden state

The engine should not become an object-oriented scene graph system.

## 2. Data-Oriented Design

Performance-critical systems must prioritize:

- memory layout
- cache locality
- batch processing
- predictable execution

Prefer:

- Structure of Arrays
- typed storage
- contiguous memory

Avoid:

- pointer-heavy structures
- scattered allocations
- object graphs

## 3. Explicit Ownership

Every important resource must have clear ownership.

Always know:

- who creates it
- who owns it
- who mutates it
- who destroys it

This applies to:

- ECS data
- GPU resources
- shared memory
- assets

## 4. Zero Allocation Runtime

The frame loop and hot paths must avoid allocations.

Avoid:

- temporary objects
- repeated vector creation
- unnecessary cloning
- per-frame memory growth

Prefer:

- reusable buffers
- preallocated storage
- batch updates

## 5. WebGPU First

Do not design around WebGL limitations.

Use WebGPU concepts:

- pipelines
- bind groups
- explicit resources
- command encoding
- GPU-friendly buffers

# Architecture Boundaries

## ECS

Responsible for:

- simulation data
- entity lifecycle
- components
- systems

ECS does not own GPU resources.

## RenderWorld

Responsible for:

- GPU preparation data
- render-specific representation

Renderer consumes RenderWorld.

Renderer does not query ECS directly.

## Renderer

Responsible for:

- WebGPU execution
- pipelines
- buffers
- render passes
- GPU resources

Renderer does not manage application state.

## TypeScript API

Responsible for:

- developer experience
- ergonomic API
- framework integration

It must hide:

- WASM details
- worker communication
- GPU complexity

# Development Priorities

Always prioritize in this order:

1. Architecture correctness

2. Performance scalability

3. Memory efficiency

4. Developer experience

5. Feature completeness

Do not sacrifice architecture to implement features faster.

# Feature Development Policy

Before adding a new feature:

1. Identify affected architecture layers.

2. Evaluate memory impact.

3. Evaluate performance impact.

4. Design the data flow.

5. Add benchmarks if performance-related.

6. Implement.

7. Document decisions.

# Features That Should Not Be Added Early

Avoid adding:

- advanced materials
- PBR
- physics
- animation systems
- editor systems
- complex asset pipelines

until the runtime foundation is proven.

# Benchmark Culture

Performance claims require measurements.

Every optimization should include:

- baseline measurement
- implementation change
- new measurement
- explanation

Never accept:

"this should be faster"

Prefer:

"benchmark shows this reduced frame preparation time by X."

# Documentation Culture

Important architectural decisions must be documented.

Use Architecture Decision Records (ADR).

Each major decision should explain:

- context
- alternatives
- decision
- consequences

# Final Goal

The goal is not to create another 3D library.

The goal is to create a modern WebGPU-native engine runtime that combines:

- native-level performance
- browser-native delivery
- excellent developer experience
- scalable architecture
