# ADR 002: Separate RenderWorld From ECS World

## Status

Accepted

## Date

2026-08-02

# Context

The engine requires a scalable rendering architecture.

A common approach is allowing the renderer to directly consume ECS data.

Example:

```
Renderer

↓

ECS World

↓

Components
```

This creates problems:

- renderer becomes coupled to simulation
- GPU requirements leak into ECS
- difficult interpolation
- difficult multi-camera support
- harder GPU-driven rendering evolution

# Decision

The engine separates simulation data and rendering data.

Architecture:

```
ECS World

↓

Render Extraction

↓

RenderWorld

↓

Renderer

↓

GPU
```

# Responsibilities

## ECS World

Owns:

- entities
- simulation components
- logical state

## Render Extraction

Responsible for:

- converting simulation state
- preparing render representation
- batching data

## RenderWorld

Owns:

- render-specific data
- GPU preparation structures
- visibility inputs

## Renderer

Consumes RenderWorld only.

# Consequences

## Positive

### Better scalability

Rendering can evolve independently.

### Multiple representations

Possible support:

- interpolation
- multiple cameras
- different render passes

### GPU-driven future

RenderWorld can become a GPU-friendly data source.

## Negative

### Additional memory

Some data exists in both representations.

### Extraction cost

Data synchronization must be optimized.

# Alternatives Considered

## Direct ECS Rendering

Rejected.

Reason:

creates excessive coupling.

## Single Unified World

Rejected.

Reason:

simulation and rendering have different optimization goals.

# Future Impact

All rendering features must respect:

```
ECS

↓

Extraction

↓

RenderWorld

↓

GPU
```

The renderer must never become an ECS consumer.
