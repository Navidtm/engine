# Repository Agent Instructions

## Purpose

This repository contains a WebGPU-native 3D engine runtime.

AI agents working in this repository must follow the engineering guidelines defined inside:

```
.agents/
```

The `.agents` directory contains:

- project context
- architecture rules
- development workflows
- specialized engineering skills
- architectural decisions

# Before Making Changes

Before implementing any non-trivial change:

1. Read:

```
.agents/AGENTS.md
```

2. Read relevant context:

```
.agents/context/
```

3. Read relevant rules:

```
.agents/rules/
```

4. Use appropriate skills from:

```
.agents/skills/
```

5. Follow workflows from:

```
.agents/workflows/
```

Do not start large changes without understanding the project architecture.

# Project Summary

This project is:

A modern WebGPU-native 3D engine runtime for the web.

Primary goals:

- high performance
- predictable memory usage
- excellent developer experience
- scalable rendering architecture

Technology:

- Rust
- WebAssembly
- TypeScript
- WebGPU
- WGSL
- Web Workers
- SharedArrayBuffer

# Core Architecture

The engine follows:

```
Application

↓

TypeScript API

↓

Worker Runtime

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

Do not bypass these boundaries without architectural justification.

# Important Rules

## Architecture

Do not introduce:

- scene graph architecture
- Object3D-style hierarchy
- inheritance-based engine systems
- renderer/ECS coupling

Prefer:

- functional modules
- data-oriented design
- explicit ownership
- batch processing

## Performance

Never introduce:

- allocations in hot paths
- unnecessary copying
- per-object WASM calls
- runtime pipeline creation

Performance claims require benchmarks.

## Memory

Always know:

- who owns data
- who mutates data
- who destroys resources

Prefer:

- reusable buffers
- explicit lifetimes
- stable handles

## API

Public APIs should hide:

- WASM details
- worker communication
- GPU internals

Developer experience is a first-class goal.

# Development Process

For new features:

Read:

```
.agents/workflows/new-feature.md
```

For architecture changes:

Read:

```
.agents/workflows/architecture-change.md
```

For performance work:

Read:

```
.agents/workflows/performance-change.md
```

For bug fixes:

Read:

```
.agents/workflows/bug-fix.md
```

For milestone completion:

Read:

```
.agents/workflows/milestone-completion.md
```

# Code Quality

Follow:

Rust:

- rustfmt
- clippy -D warnings
- tests

TypeScript:

- strict mode
- ESLint
- Prettier
- type checking

Maintain clean commits and focused changes.

# Required Mindset

Do not optimize for:

- fastest implementation
- shortest code
- adding features quickly

Optimize for:

- correct architecture
- long-term scalability
- measurable performance
- maintainable systems

# Final Rule

Treat this repository as a long-lived engine project.

Every change should improve the foundation without creating future architectural debt.
