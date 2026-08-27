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

# Automatic Issue Tracking

When an AI agent discovers a new actionable problem in this repository, it must
create a GitHub issue in `Navidtm/engine` automatically. Do not wait for a separate
request from the user.

Actionable problems include, but are not limited to:

- bugs and incorrect behavior
- performance regressions or scalability bottlenecks
- memory, ownership, lifetime, or synchronization risks
- architectural violations or structural enhancements
- missing validation, tests, benchmarks, or documentation
- security, dependency, build, packaging, CI, or tooling problems
- developer-experience and public-API improvements

Before creating an issue:

1. Search open and closed GitHub issues for the same root cause.
2. Do not create a duplicate; add relevant evidence to the existing issue instead.
3. Confirm the problem is actionable and provide concrete repository evidence.
4. Never include credentials, tokens, private URLs, or other sensitive data.

Every automatically created issue must:

- follow the structure in `.github/ISSUE_TEMPLATE/project-issue.yml`
- explain the problem, impact, evidence, scope, acceptance criteria, and validation
- include repository file paths and line references when available
- include a benchmark baseline and measurement plan for performance claims
- have at least one classification label such as `bug`, `enhancement`,
  `performance`, `design`, `documentation`, `testing`, `ci`, `tooling`, `security`,
  or `dependencies`
- have exactly one severity label: `sev/critical`, `sev/high`, `sev/medium`, or
  `sev/low`
- remove the `triage` label once classification and severity are known

Use `gh issue create` and `gh issue edit` for issue management. If GitHub access or
authentication is unavailable, do not silently skip the issue: prepare the exact
issue body, report the blocker to the user, and publish it as soon as access is
restored.

After creating or updating an issue, include its GitHub link in the final response.

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
