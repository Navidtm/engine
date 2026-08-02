# Milestone Completion Workflow

## Purpose

Define the process for completing an engine development milestone.

A milestone is not complete when implementation exists.

A milestone is complete when:

- architecture goals are satisfied
- performance impact is understood
- quality checks pass
- documentation is updated
- future risks are identified

# Step 1: Verify Milestone Scope

Review the original milestone goal.

Document:

## Objective

What problem was this milestone intended to solve?

## Requirements

List:

- required features
- required behavior
- performance targets

## Non-Goals

List explicitly:

- features intentionally postponed
- systems not included

Avoid expanding milestone scope during completion.

# Step 2: Architecture Review

Review the implementation against:

- architecture.md
- ADRs
- engine-architect principles

Check:

## Layer Boundaries

Verify:

```
API

↓

Runtime

↓

Core

↓

ECS

↓

RenderWorld

↓

Renderer
```

No forbidden dependency should exist.

## Ownership

Verify:

- data ownership
- resource ownership
- lifecycle rules

## Data Flow

Verify:

- explicit transformations
- no hidden state

# Step 3: Performance Validation

Every milestone affecting runtime behavior requires measurement.

Record:

## Benchmarks

Include:

- benchmark name
- workload
- environment
- results

## Compare

Measure:

Before:

existing baseline

After:

new implementation

## Analyze

Check:

- improvement
- regression
- memory impact

Do not mark performance work complete without evidence.

# Step 4: Quality Validation

Run:

## Rust

Required:

- rustfmt
- clippy -D warnings
- cargo test

## TypeScript

Required:

- prettier check
- eslint
- typecheck
- tests

## Build

Required:

- WASM release build
- package builds
- examples build

# Step 5: Documentation Update

Update:

## Current State

File:

```
.agents/context/current-state.md
```

Include:

- completed work
- current architecture
- next priorities

## ADRs

Create or update ADRs when:

- architecture changes
- new technical decisions are introduced

## Benchmarks

Store:

- raw results
- benchmark configuration
- comparison data

# Step 6: Code Review

Run:

## Architecture Review

Check:

- scalability
- boundaries
- ownership

## Performance Review

Check:

- allocations
- benchmarks
- regressions

## Standards Review

Check:

- code quality
- consistency

## Specification Review

Check:

- milestone requirements

# Step 7: Risk Assessment

Document remaining risks.

Categories:

## Technical Risk

Examples:

- unstable APIs
- unfinished systems

## Performance Risk

Examples:

- untested scale limits

## Browser Risk

Examples:

- unsupported WebGPU features

## Architecture Risk

Examples:

- temporary solutions requiring redesign

# Step 8: Update Roadmap

After completion:

Move:

Current:

```
In Progress
```

to:

```
Completed
```

Define:

Next milestone:

- objective
- constraints
- success criteria

# Milestone Completion Checklist

Before marking complete:

- [ ] Requirements verified
- [ ] Non-goals preserved
- [ ] Architecture reviewed
- [ ] Benchmarks recorded
- [ ] Tests passed
- [ ] Documentation updated
- [ ] ADRs updated if needed
- [ ] Risks documented
- [ ] Next milestone defined

# Final Rule

A milestone represents a validated architectural step.

Do not move forward because code exists.

Move forward because the engine foundation became stronger.
