# ADR 001: Functional Module Architecture

## Status

Accepted

## Date

2026-08-02

# Context

Traditional 3D engines often use object-oriented architectures.

Common patterns:

```
Scene

↓

Objects

↓

Meshes

↓

Materials

↓

Behaviors
```

This approach is familiar but introduces problems for a modern WebGPU runtime:

- hidden state
- unpredictable memory behavior
- difficult parallelization
- poor cache locality
- object traversal overhead
- tight coupling between systems

The goal of this engine is to build a scalable browser-native graphics runtime.

The runtime must support:

- large numbers of entities
- predictable performance
- efficient WebAssembly execution
- GPU-friendly data flow

# Decision

The engine uses a functional module-based architecture.

Core principles:

- data is stored explicitly
- systems transform data
- modules expose functions
- ownership is visible
- state transitions are explicit

The architecture follows:

```
Data

↓

Systems

↓

New Data
```

Instead of:

```
Object

↓

Method Mutation
```

# Examples

Preferred:

```rust
update_transforms(
    transforms,
    delta_time
)
```

Avoid:

```rust
transform.update()
```

# Consequences

## Positive

### Performance

Data-oriented systems allow:

- better cache locality
- batch processing
- predictable execution

### Memory

No hidden object allocations.

Ownership remains explicit.

### Parallelism

Independent systems are easier to execute concurrently.

### WASM Compatibility

Simple data layouts map better to linear memory.

## Negative

### Learning Curve

Developers familiar with traditional engines need to adapt.

### More Explicit Code

Some convenience abstractions are intentionally avoided.

### Less Familiar Patterns

The API design requires more careful thought.

# Alternatives Considered

## Object-Oriented Scene Graph

Rejected.

Reasons:

- poor scalability for large datasets
- hidden state
- difficult GPU-oriented optimization

## Hybrid Object/ECS Architecture

Rejected for core runtime.

Could exist as an optional high-level layer in the future.

# Future Impact

All future engine systems must preserve this architectural direction.

New features should be evaluated based on:

- data flow
- memory layout
- system boundaries

not object relationships.

# Rule

The engine is data-oriented internally.

Convenience belongs in the public API layer, not the runtime architecture.

```

```
