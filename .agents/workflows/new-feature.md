# New Feature Workflow

## Purpose

Define the required process before implementing any new engine feature.

The goal is to prevent feature-driven architecture degradation.

# Step 1: Understand The Feature

Before writing code:

Identify:

- What problem does this feature solve?
- Who consumes this feature?
- Which engine layers are affected?

Classify the feature:

- API
- ECS
- Runtime
- Memory
- Renderer
- WebGPU
- Asset system

# Step 2: Architecture Analysis

Review:

- engine architecture rules
- existing ADRs
- current milestone state

Determine:

## Data Flow

How does data move through the engine?

Example:

```
Input

↓

API

↓

Runtime

↓

ECS

↓

Extraction

↓

RenderWorld

↓

GPU
```

## Ownership

Determine:

- who creates data
- who owns data
- who modifies data
- who destroys data

# Step 3: Design Before Implementation

Create a short design proposal:

Required sections:

## Problem

What is being solved?

## Proposed Solution

How will the system work?

## Alternatives

What other approaches were considered?

## Tradeoffs

Performance, memory, complexity.

## Benchmark Plan

How will success be measured?

Do not implement large features without this step.

# Step 4: Check Architectural Constraints

Verify:

- Does this introduce OOP patterns?
- Does this break layer separation?
- Does this add hidden state?
- Does this introduce allocations?
- Does this couple systems unnecessarily?

If yes:

redesign before implementation.

# Step 5: Implementation

During implementation:

Prefer:

- small modules
- explicit data flow
- reusable buffers
- clear ownership

Avoid:

- premature abstractions
- unnecessary dependencies
- large refactors mixed with features

# Step 6: Validation

Run:

Code quality:

- formatter
- lint
- typecheck

Rust:

- tests
- clippy

Runtime:

- benchmarks if performance related

# Step 7: Documentation

Update:

- architecture docs
- ADRs when decisions change
- current-state.md when milestones change

# Final Rule

A feature is not complete when code exists.

A feature is complete when:

- architecture is preserved
- performance impact is understood
- tests pass
- documentation is updated
