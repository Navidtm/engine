# ADR 003: Shared Memory Transport

## Status

Accepted

## Date

2026-08-02

# Context

The engine runs JavaScript API code separately from the Rust/WASM runtime.

A naive communication model:

```
JavaScript

↓

postMessage

↓

Worker

↓

WASM
```

creates problems:

- structured clone overhead
- object allocations
- many small messages
- unpredictable latency

For large scenes, transform updates can become the bottleneck.

# Decision

Use SharedArrayBuffer as the primary high-frequency transport mechanism.

Architecture:

```
TypeScript

↓

SharedArrayBuffer

↓

Worker

↓

Rust/WASM
```

Use message passing only for:

- initialization
- structural commands
- low-frequency operations

# Synchronization Model

The transport uses:

- atomic operations
- seqlock patterns
- dirty tracking
- SPSC queues

The goal:

minimize synchronization overhead while maintaining correctness.

# Consequences

## Positive

### Lower latency

Data is shared instead of serialized.

### Better batching

Thousands of updates can be processed together.

### Predictable performance

Less dependence on browser message queues.

## Negative

### More complexity

Requires careful synchronization.

### Memory management

Shared memory requires explicit layout design.

### Browser Requirements

Requires:

- cross-origin isolation
- SharedArrayBuffer support

# Alternatives Considered

## postMessage Only

Rejected.

Reason:

does not scale for high-frequency updates.

## Full Zero Copy WASM Memory Sharing

Future possibility.

Current design keeps explicit staging boundaries.

# Future Impact

Future systems should consider:

- direct typed views
- partial component updates
- command ring buffers
- GPU-compatible memory layouts

The transport layer is a core performance subsystem.
