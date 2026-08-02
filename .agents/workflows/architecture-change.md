# Architecture Change Workflow

## Purpose

Define the required process for changing core engine architecture.

Architecture changes include modifications to:

- ECS design
- memory model
- WASM boundary
- worker communication
- render pipeline
- RenderWorld
- WebGPU resource ownership
- public API foundations

Architecture changes have a higher risk than normal features.

Do not treat them as regular code changes.

# Step 1: Identify The Architectural Constraint

Before changing architecture, document:

## Current Problem

What limitation exists?

Example:

```
SharedArrayBuffer transport requires unnecessary copying.
```

## Current Architecture

Describe the existing data flow.

Example:

```
TypeScript

↓

SAB

↓

Worker

↓

WASM staging buffer

↓

ECS
```

## Why Current Design Is Insufficient

Explain:

- performance limitation
- scalability limitation
- maintainability issue

# Step 2: Review Existing Decisions

Before changing architecture:

Read:

- architecture.md
- ADR files
- current-state.md

Determine:

- Is this changing an existing decision?
- Does an ADR need to be replaced?
- Does another subsystem depend on this design?

# Step 3: Evaluate Alternatives

Every architecture change must evaluate alternatives.

Required format:

## Option A

Description.

Advantages:

-

Disadvantages:

-

## Option B

Description.

Advantages:

-

Disadvantages:

-

## Decision

Chosen approach and reasoning.

# Step 4: Analyze System Impact

Review impact on:

## ECS

Questions:

- Does data ownership change?
- Do components change?
- Do queries change?

## Runtime

Questions:

- Does worker communication change?
- Does ABI change?

## Memory

Questions:

- Are allocations introduced?
- Are copies increased?
- Is ownership still explicit?

## Renderer

Questions:

- Does RenderWorld change?
- Does GPU ownership change?

## Public API

Questions:

- Does developer experience change?

# Step 5: Performance Validation Plan

Before implementation define:

Metrics:

- CPU cost
- memory usage
- allocations
- latency
- throughput

Benchmark scenarios:

Small:

1k entities

Medium:

100k entities

Large:

1M entities

# Step 6: Implementation Strategy

Large architecture changes should be incremental.

Prefer:

Phase 1:

Introduce new architecture.

Phase 2:

Run old and new paths together if possible.

Phase 3:

Migrate users.

Phase 4:

Remove old implementation.

Avoid:

large destructive rewrites.

# Step 7: Review Requirements

Architecture changes require review from:

## Engine Architect

Checks:

- architectural consistency

## Performance Engineer

Checks:

- measurable improvement

## Relevant Domain Expert

Examples:

ECS change:

- ecs-engineer

WebGPU change:

- webgpu-specialist

Rust change:

- rust-systems-engineer

# Step 8: Update Documentation

Required updates:

Architecture docs:

if system boundaries changed.

ADR:

if a fundamental decision changed.

Current state:

if milestone status changed.

# Architecture Change Checklist

Before merge:

- [ ] Problem documented
- [ ] Existing architecture analyzed
- [ ] Alternatives evaluated
- [ ] Performance impact measured
- [ ] ADR updated
- [ ] Tests added
- [ ] Benchmarks updated
- [ ] Documentation updated

# Final Rule

Architecture changes are not code changes.

They are changes to the future shape of the engine.

Treat them accordingly.
