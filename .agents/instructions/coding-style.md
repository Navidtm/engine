# Coding Style Guidelines

## Purpose

This document defines coding conventions for the engine.

The goal is not only readable code.

The goal is code that preserves:

- architectural clarity
- performance characteristics
- maintainability
- predictable behavior

These rules apply to:

- Rust
- TypeScript
- WGSL
- documentation

# General Principles

## Prefer Explicit Code

Prefer code where:

- data flow is visible
- ownership is clear
- side effects are obvious

Avoid:

- magic behavior
- hidden mutations
- implicit lifecycle

Bad:

```ts
engine.initializeEverything();
```

Preferred:

```ts
engine.create();
engine.start();
```

---

# Module Design

## Small Focused Modules

A module should have one clear responsibility.

Good:

```
renderer/

 pipeline.ts
 buffers.ts
 commands.ts
```

Bad:

```
engine.ts

contains:

- ECS
- rendering
- assets
- transport
- API
```

---

## Avoid Generic Names

Avoid:

- manager
- helper
- utils
- common

unless the responsibility is genuinely generic.

Bad:

```
ResourceManager
```

Better:

```
MeshRegistry
TextureCache
PipelineStore
```

---

# Naming Rules

## General

Use descriptive names.

Prefer:

```
renderExtractionSystem
```

over:

```
extractor
```

unless the shorter name is unambiguous.

---

# Rust Style

## Data Structures

Prefer simple data containers.

Good:

```rust
pub struct Transform {
    pub position: Vec3,
    pub rotation: Quat,
    pub scale: Vec3,
}
```

Avoid:

```rust
pub struct Transform {
    pub position: Vec3,

    pub fn update(&mut self) {}
}
```

Components contain data.

Systems contain behavior.

---

## Functions

Prefer functions that describe transformations.

Good:

```rust
fn update_transforms(
    storage: &mut TransformStorage,
    delta_time: f32,
)
```

Avoid:

```rust
world.updateEverything()
```

---

## Ownership

Make ownership obvious.

Prefer:

```rust
fn process(
    buffer: &mut Buffer
)
```

Avoid unnecessary:

- cloning
- reference counting
- shared mutable state

---

## Clone Usage

Do not clone without justification.

Before using:

```rust
value.clone()
```

consider:

- can ownership move?
- can borrowing solve this?
- is copying actually required?

---

## Unsafe Rust

Unsafe is allowed only when necessary.

Every unsafe block requires:

```rust
// SAFETY:
// Explain invariants.
// Explain why this is valid.
unsafe {
}
```

Forbidden:

unsafe for convenience.

---

## Error Handling

Avoid:

```rust
unwrap()
```

in runtime code.

Prefer:

```rust
Result
Option
explicit handling
```

Panics are acceptable only for:

- impossible internal states
- development assertions

---

# Rust Performance Rules

## Avoid Allocation In Hot Paths

Forbidden:

```rust
fn update() {
    let mut data = Vec::new();
}
```

Hot paths include:

- frame update
- ECS systems
- extraction
- visibility
- render preparation

---

## Prefer Reuse

Prefer:

```rust
buffer.clear();
buffer.push(value);
```

over:

```rust
let buffer = Vec::new();
```

every frame.

---

## Prefer Contiguous Memory

Prefer:

```rust
Vec<ComponentData>
```

only when appropriate.

For large sequential processing prefer:

```rust
positions[]
rotations[]
scales[]
```

---

# TypeScript Style

## Strict Typing

Always prefer:

```ts
interface MeshDescriptor {
  geometry: string;
}
```

over:

```ts
const mesh: any;
```

Avoid:

- any
- unnecessary type assertions

---

## API Design

Public APIs should be:

- simple
- discoverable
- predictable

Prefer:

```ts
mesh.position.set(0, 1, 0);
```

Avoid exposing:

```ts
mesh.transformComponent.storage.write(...)
```

---

## Functions Over Classes

Prefer:

```ts
createEngine(options);
```

Avoid:

```ts
new Engine();
```

unless a class provides a clear advantage.

---

## Avoid Hidden Mutation

Bad:

```ts
createMesh().configure().initialize().start();
```

Preferred:

```ts
const mesh = createMesh(config);

initializeMesh(mesh);
```

---

# Import Rules

Keep imports:

- ordered
- minimal
- explicit

Avoid unused imports.

Prefer:

```ts
import { createEngine } from "./engine";
```

Avoid:

```ts
import * as everything from "./engine";
```

---

# Comments

Comments should explain:

- why something exists
- architectural decisions
- non-obvious constraints

Avoid comments explaining obvious code.

Bad:

```ts
// increment i
i++;
```

Good:

```ts
// Keep capacity fixed because this buffer is accessed from WASM memory.
```

---

# Documentation Style

Technical documentation should explain:

## Problem

What issue exists?

## Decision

What approach was chosen?

## Reasoning

Why?

## Tradeoffs

What was sacrificed?

Avoid:

- vague descriptions
- marketing language
- unsupported claims

---

# WGSL Style

## Shader Organization

Prefer:

```
shaders/

 common.wgsl
 camera.wgsl
 material.wgsl
 mesh.wgsl
```

Avoid:

one huge shader file.

---

## Layout Consistency

CPU layout:

must match:

GPU layout.

Always verify:

- alignment
- padding
- ordering

---

# Testing Style

Tests should verify behavior, not implementation details.

Good:

```text
entity creation returns valid handle
```

Bad:

```text
internal vector has length 100
```

unless storage behavior itself is the subject.

---

# Benchmark Style

Benchmarks must include:

- clear workload
- reproducible setup
- meaningful scale

Avoid:

micro benchmarks that do not represent real workloads.

---

# Git Commit Style

Commits should be:

- focused
- descriptive
- atomic

Good:

```
Add RenderWorld extraction buffer
```

Bad:

```
changes
```

Avoid mixing:

- refactoring
- features
- formatting

in one commit.

---

# Code Review Expectations

Before submitting code:

Check:

Architecture:

- Does this follow engine boundaries?

Performance:

- Did this add allocations?

Memory:

- Is ownership clear?

DX:

- Did public API become simpler?

Quality:

- Is the code understandable?

---

# Final Rule

Write code for the future engine, not only today's feature.

The best code in this project is:

- explicit
- measurable
- scalable
- easy to reason about
- aligned with the architecture
