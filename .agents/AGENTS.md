# Engine Agent Instructions

## Purpose

This file defines how AI agents should operate inside this repository.

The agent must use the project knowledge system located in:

```
.agents/
```

before making significant changes.

The goal is to preserve:

- architecture
- performance
- code quality
- long-term maintainability

# Required Reading Order

Before implementing any non-trivial change, read:

## 1. Project Identity

```
.agents/instructions/project.md
```

Understand:

- project goals
- technology stack
- architectural philosophy

## 2. Architecture Rules

```
.agents/rules/architecture.md
```

Follow all non-negotiable architecture constraints.

## 3. Current State

```
.agents/context/current-state.md
```

Understand:

- current milestone
- implemented systems
- postponed features

## 4. Roadmap

```
.agents/context/roadmap.md
```

Understand:

- development direction
- future priorities

## 5. Glossary

```
.agents/context/glossary.md
```

Use project-specific terminology correctly.

# Skill Usage

Use specialized skills when relevant.

Available skills:

## Architecture

```
engine-architect
```

Use for:

- architecture decisions
- major design changes
- system boundaries

## ECS

```
ecs-engineer
```

Use for:

- entities
- components
- systems
- storage
- queries

## Rendering

```
webgpu-specialist
```

Use for:

- WebGPU
- shaders
- pipelines
- GPU resources

## Rust Core

```
rust-systems-engineer
```

Use for:

- Rust
- WASM
- memory
- ABI
- unsafe code

## Performance

```
performance-engineer
```

Use for:

- optimization
- profiling
- benchmarks

## TypeScript API

```
typescript-api-designer
```

Use for:

- public API
- developer experience

## Graphics

```
computer-graphics-expert
```

Use for:

- math
- rendering algorithms
- culling
- lighting

## Assets

```
asset-pipeline-engineer
```

Use for:

- loading
- mesh processing
- textures

## Review

```
engine-code-reviewer
```

Use for:

- PR review
- milestone review
- architectural validation

# Before Coding

Do not immediately write code.

For significant changes:

1. Understand the requirement.

2. Identify affected systems.

3. Check architecture constraints.

4. Select relevant skills.

5. Design the approach.

6. Implement.

# Decision Making Rules

When multiple solutions exist:

Prefer:

1. Architecturally correct solution

2. Scalable solution

3. Performant solution

4. Simple solution

Avoid choosing the fastest implementation if it creates future technical debt.

# GitHub Issue Tracking

Whenever repository work discovers an actionable, evidence-backed problem or
improvement, create or update a GitHub issue before considering the review or
task complete. This includes:

- correctness and lifecycle bugs;
- architecture inconsistencies or accepted-ADR implementation gaps;
- measured performance regressions or concrete hot-path risks;
- missing regression coverage for an identified failure boundary; and
- stale documentation that can misdirect future implementation.

Before creating an issue:

1. Search both open and closed issues for an existing report.
2. If an issue already covers the finding, add the new evidence or acceptance
   criteria there instead of creating a duplicate.
3. Confirm the finding from repository code, tests, documentation, or measured
   results. Do not create issues for unsupported speculation.

Every new issue should include:

- the observed evidence and relevant file locations;
- why the problem matters;
- the intended scope and explicit non-goals;
- concrete acceptance criteria; and
- an appropriate repository label.

When GitHub access is unavailable, provide a ready-to-file issue draft and
clearly report that the external issue was not created.

When implementing work tracked by an existing GitHub issue, include the issue
reference in every resulting commit message using `#<issue-number>` (preferably
in the subject) so GitHub links the commit to the issue. Do not use an unprefixed
issue number as a substitute.

# Implementation Rules

Always prefer:

- explicit data flow
- clear ownership
- small modules
- measurable improvements

Avoid:

- unnecessary abstractions
- hidden state
- object-oriented engine patterns
- premature features

# Performance Rules

Never claim optimization without measurement.

Required for performance work:

Before:

benchmark

Change:

implementation

After:

benchmark

# Architecture Change Rules

For changes involving:

- ECS
- memory model
- transport
- renderer architecture
- WebGPU resources

Read:

```
.agents/workflows/architecture-change.md
```

Create or update ADRs when decisions change.

# Feature Development Rules

For new features:

Read:

```
.agents/workflows/new-feature.md
```

Validate:

- architecture
- performance
- tests
- documentation

# Bug Fix Rules

For bugs:

Read:

```
.agents/workflows/bug-fix.md
```

Find root causes.

Do not patch symptoms.

# Milestone Rules

When completing milestones:

Read:

```
.agents/workflows/milestone-completion.md
```

Validate:

- implementation
- benchmarks
- documentation
- risks

# Code Review Rules

Before considering work complete:

Use:

```
engine-code-reviewer
```

Review:

- architecture
- performance
- standards
- specification

# Forbidden Behaviors

Do not:

## Copy Existing Engine Architectures

Especially:

- Three.js scene graph patterns
- Unity-style object hierarchies
- Unreal-style actor systems

## Add Features Before Foundations

Do not prioritize:

- PBR
- physics
- editor
- animation
- complex assets

before runtime foundations are stable.

## Ignore Performance

Do not add:

- allocations
- unnecessary copies
- expensive abstractions

without justification.

## Hide Architectural Decisions

Important decisions must be documented.

# Communication Style

When explaining technical decisions:

Include:

- problem
- options
- tradeoffs
- decision
- consequences

Avoid:

- vague reasoning
- unsupported claims
- "this is standard practice" without explanation

# Final Principle

The agent is not only a code generator.

The agent is a member of the engine development team.

Every change should make the engine:

- faster
- cleaner
- more scalable
- easier to use

without damaging future architecture.
