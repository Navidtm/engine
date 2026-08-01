# Architecture

## Boundary decisions

The browser-facing API is functional and command-oriented. The main thread owns
only immutable configuration, entity-ID allocation, and a queue of compact
commands. A dedicated worker owns the mutable runtime, WebAssembly instance,
canvas context, GPU device, and frame loop. This keeps rendering off the main
thread from the first milestone and avoids an expensive later migration.

The Rust core owns simulation data. Entities are packed generational IDs, while
components live in independent sparse sets. Systems iterate dense component
arrays rather than traversing an object graph. The renderer sees prepared data,
never scene objects.

Beginning with milestone 2, the renderer-facing data is an explicit
`RenderWorld` extracted after simulation systems run. See
[milestone-2.md](milestone-2.md) for its fixed-capacity layout and ownership
contract.

Milestone 3 adds a visibility boundary and reusable FrameGraph. See
[milestone-3.md](milestone-3.md) for culling, material grouping, profiling, and
public authoring API decisions.

The WebAssembly bridge uses a small, versioned C ABI instead of generated JS
bindings. That makes ownership explicit, removes glue-code allocation from hot
paths, and lets any bundler load the module with `WebAssembly.instantiate`.
Allocations are permitted during initialization and structural world changes;
frame updates operate on preallocated storage.

WebGPU is intentionally visible in the renderer package. Adapter/device,
surface, buffers, textures, shader creation, pipeline caching, and command
encoding are separate modules, but they map directly to WebGPU concepts rather
than emulating an older graphics API.

## Runtime flow

```text
Application
  -> functional TypeScript API
  -> transferable command messages
  -> dedicated module worker
  -> Rust/WASM world + systems
  -> WebGPU renderer
  -> canvas presentation
```

Commands are buffered until initialization completes. Runtime state does not
cross the worker boundary as mutable JavaScript objects. Future milestones can
replace structured-clone command batches with a `SharedArrayBuffer` ring without
changing the public API or ECS storage.

## Memory model

- Entity and component capacity is chosen in immutable engine configuration.
- Sparse sets reserve dense storage up front and grow only during structural
  changes if configured capacity is exceeded.
- Component values are `#[repr(C)]`, contiguous, and use GPU-friendly alignment.
- Math APIs write into caller-provided values and never allocate.
- Render-pass descriptors, attachment arrays, clear values, and submission
  arrays are reused. WebGPU-mandated per-frame handles (the current texture,
  view, encoder, pass, and command buffer) are the remaining JS objects.
- Pipeline and shader creation is confined to initialization/cache misses.

## Public API

`createEngine(canvas, options?)` returns a plain record of functions and state
adapters. `engine.create`, `engine.set`, and immutable handles cover normal
authoring without exposing ECS vocabulary. No mutable class hierarchy or
singleton is exposed. The `world` surface and `@lume/api/advanced` component
helpers remain an explicit advanced compatibility layer; `world.add` converts
their serializable descriptions into versioned worker commands.

Entity IDs are allocated synchronously on the main thread so authoring remains
ergonomic. The worker validates every ID before inserting it into the canonical
Rust world. Destroyed IDs are not reused in Phase 1; a worker-acknowledged
generational free list is planned before high-churn entity workloads.

## Failure model

Initialization is an explicit promise. Device-loss and uncaptured GPU errors are
reported as typed worker events. `start`, `stop`, `resize`, and `dispose` are
idempotent. A failed initialization rejects pending work rather than silently
falling back to a different graphics backend.

## Testing seams

The Rust ECS and math code are tested without a browser. Renderer setup accepts
explicit WebGPU objects at module boundaries, allowing future mock-device tests.
The worker protocol is a discriminated union that can be validated independently
of rendering. Browser integration belongs in an end-to-end test layer.
