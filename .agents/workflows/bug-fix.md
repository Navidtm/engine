# Bug Fix Workflow

## Purpose

Define the process for fixing bugs in the engine.

The goal is not only to make the failing case disappear.

The goal is to:

- identify the root cause
- preserve architecture
- prevent regression
- improve system reliability

# Step 1: Classify The Bug

Before changing code, identify the category.

## Runtime Bug

Examples:

- incorrect state update
- lifecycle issue
- invalid behavior

## ECS Bug

Examples:

- component corruption
- entity lifecycle failure
- query inconsistency

## Memory Bug

Examples:

- invalid ownership
- data race
- memory corruption
- unexpected allocation

## WASM Boundary Bug

Examples:

- ABI mismatch
- incorrect memory layout
- invalid pointer handling

## Rendering Bug

Examples:

- incorrect GPU state
- shader issue
- pipeline problem
- resource lifetime issue

## Performance Bug

Examples:

- regression
- unexpected allocation
- increased frame time

# Step 2: Reproduce The Issue

A bug is not ready to fix until it can be reproduced.

Document:

## Environment

Include:

- OS
- browser
- GPU
- engine version

## Reproduction Steps

Provide:

- exact actions
- minimal example
- expected behavior
- actual behavior

## Frequency

Determine:

- always reproducible
- intermittent
- hardware dependent

# Step 3: Find Root Cause

Do not immediately patch symptoms.

Analyze:

## Data Flow

Where did the incorrect data originate?

Example:

```
Input

↓

API

↓

Worker

↓

WASM

↓

ECS

↓

Renderer
```

Find the first incorrect state.

## Ownership

Check:

- who owns the data?
- who modified it?
- should this layer modify it?

## Lifetime

Check:

- resource creation
- destruction
- reuse

## Synchronization

For concurrent systems check:

- atomics
- ordering
- race conditions

# Step 4: Evaluate The Fix

Before implementation verify:

## Architecture

Does the fix:

- preserve boundaries?
- introduce coupling?
- create hidden state?

## Performance

Does the fix:

- add allocations?
- increase copying?
- add synchronization?

## Maintainability

Does the fix:

- simplify the system?
- create technical debt?

# Step 5: Implement The Smallest Correct Fix

Prefer:

- minimal scope
- explicit behavior
- clear ownership

Avoid:

- unrelated refactoring
- new abstractions
- large rewrites

unless the root cause requires it.

# Step 6: Add Regression Protection

Every fixed bug should add protection.

Possible:

## Unit Test

For:

- data structures
- algorithms

## Integration Test

For:

- WASM
- worker communication
- rendering flow

## Benchmark

For:

- performance regressions

## Documentation

For:

- architectural lessons

# Step 7: Validate Across Layers

After fixing:

Run:

## Rust

- rustfmt
- clippy
- tests

## TypeScript

- lint
- typecheck
- tests

## Runtime

- reproduction case
- related examples

## Performance

If relevant:

- compare benchmarks

# Bug Severity

## CRITICAL

Examples:

- memory corruption
- data race
- GPU resource leak
- architecture violation causing instability

## HIGH

Examples:

- broken rendering
- invalid runtime state
- major performance regression

## MEDIUM

Examples:

- feature-specific failure
- recoverable error

## LOW

Examples:

- minor UX issue
- warning
- documentation issue

# Common Mistakes

## Mistake: Fixing symptoms

Example:

Adding checks everywhere instead of fixing ownership.

## Mistake: Ignoring architecture

Example:

Renderer directly accessing ECS to solve a rendering bug.

## Mistake: Adding allocations

Example:

Creating temporary objects as a quick fix.

## Mistake: No regression test

Example:

Fixing today and breaking tomorrow.

# Final Rule

A bug fix is successful only when:

- the root cause is understood
- the architecture remains clean
- the bug cannot easily return

```

```
