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

Milestone 3 adds a visibility boundary and reusable FrameGraph. Visibility uses
fixed-capacity hash buckets to group visible render keys in linear time, then
orders only the distinct groups for deterministic submission. See
[milestone-3.md](milestone-3.md) for culling, material grouping, profiling, and
public authoring API decisions.

The WebAssembly bridge uses a small, versioned C ABI instead of generated JS
bindings. That makes ownership explicit, removes glue-code allocation from hot
paths, and lets any bundler load the module with `WebAssembly.instantiate`.
Allocations are permitted during initialization and structural world changes;
frame updates operate on preallocated storage.

[ADR 005](../.agents/decisions/005-wasm-distribution.md) defines distribution:
the version-matched raw binary ships beside `@lume/runtime`, a static
module-relative URL supports native ESM and hashed bundler assets, and the
runtime validates the binary ABI before using any other export. Applications
only provide `wasmUrl` when intentionally self-hosting or using a CDN.

WebGPU is intentionally visible in the renderer package. Adapter/device,
surface, buffers, textures, shader creation, pipeline caching, and command
encoding are separate modules, but they map directly to WebGPU concepts rather
than emulating an older graphics API.

The GPU device does not cross into the runtime package. The renderer exposes a
device-loss promise as lifecycle information while retaining ownership of the
device and every child resource. `dispose` destroys buffers, textures, profiler
resources, the surface configuration, and the device.

The lifetime contract for assets and GPU-backed resources is recorded in
[ADR 004](../.agents/decisions/004-resource-lifetime.md). Typed generational
handles cross engine boundaries; the worker coordinates logical ownership and
dependencies; ECS components retain handles rather than resources; and renderer
registries exclusively own WebGPU objects. Resource retirement is deferred
until tracked users release the resource. Built-in geometry and basic materials
now use this foundation: the main thread mirrors liveness for early validation,
the worker Resource Coordinator owns canonical lifecycle and mesh usage edges,
Rust stores only fixed-capacity render mirrors, and private renderer registries
own residency. Submission-serial retirement remains future work for resources
that can be replaced while GPU commands are in flight.

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
cross the worker boundary as mutable JavaScript objects.

Milestone 4 performs that transport split for hot transform data. Structural
changes continue through versioned worker commands, while transform values use
a fixed-capacity shared state buffer and dirty-index ring. The worker drains the
ring into preallocated WebAssembly staging arrays and crosses the WASM boundary
once per batch. See [milestone-4.md](milestone-4.md) for ownership and
synchronization invariants.

Milestone 5 hardens that boundary with partial-field updates, adjacent dirty
ranges, a bounded shared structural-command ring, and generational handles on
every side of the worker boundary. The SharedArrayBuffer remains transport
memory while Rust retains canonical ECS ownership. See
[milestone-5.md](milestone-5.md) for the copy, lifetime, overflow, and stale
handle contracts.

Renderer scalability begins with persistent, entity-indexed instance storage.
Render extraction publishes coalesced changed-slot ranges while visibility
publishes a compact list of stable slots in grouped draw order. The renderer
updates only those ranges and the mesh shader resolves each visible slot through
one storage-buffer indirection. This preserves CPU visibility and the
`RenderWorld` ownership boundary while removing full visible-instance uploads
from unchanged frames. See
[ADR 007](../.agents/decisions/007-persistent-instance-storage.md).

Mostly-static frames reuse the retained `RenderWorld` snapshot through a
world-owned render change epoch. Unchanged instance metadata and bounds are not
rebuilt, and visibility grouping is retained when camera records are also
unchanged. Any canonical render mutation takes the existing full linear path,
so dynamic scenes keep contiguous deterministic extraction without a second
incremental data structure. See
[ADR 008](../.agents/decisions/008-epoch-gated-render-extraction.md).

Before persistent slots become direct compute-visibility input, every slot will
gain explicit active and packed generational identity metadata. Removal makes a
slot ineligible without requiring payload zeroing, generation replacement
publishes a complete new record, and GPU buffers remain rebuildable derived
cache state. CPU visibility remains the reference and fallback path. The
lifecycle, multi-camera constraints, correctness tests, and benchmark matrix are
defined in
[ADR 009](../.agents/decisions/009-active-persistent-gpu-slots.md).

Detailed byte layout and browser-thread responsibilities are documented in
[memory-model.md](memory-model.md) and [threading-model.md](threading-model.md).

[ADR 006](../.agents/decisions/006-frame-scheduling.md) defines the target frame
coordination contract before animation, physics, replay, editor, or framework
adapters depend on timing behavior. The worker remains the scheduling owner;
automatic presentation advances bounded fixed simulation ticks, while an
advanced manual mode executes exact ticks without wall-clock time. Input is
sampled at tick boundaries, visibility suspension performs no catch-up, and
profiling remains pull-based rather than emitting per-frame messages. Lifecycle
request correlation, idempotent start/stop, and worker scheduler epochs are
implemented; fixed-step, visibility, fallback, input, and manual-mode semantics
remain accepted design rather than an available public API.

## Memory model

- Entity and component capacity is chosen in immutable engine configuration.
- Entity and component capacities are hard limits. Sparse sets reserve every
  slot up front and reject a structural command that would exceed its explicit
  entity or component capacity; they never grow at runtime.
- Component values are `#[repr(C)]`, contiguous, and use GPU-friendly alignment.
- Math APIs write into caller-provided values and never allocate.
- Render-pass descriptors, attachment arrays, clear values, and submission
  arrays are reused. WebGPU-mandated per-frame handles (the current texture,
  view, encoder, pass, and command buffer) are the remaining JS objects and
  are reported as `getStats().allocationsPerFrame`; this is not a heap-allocation
  counter.
- Pipeline and shader creation is confined to initialization/cache misses.
- Persistent instance, visible-slot, dirty-range, camera, and visibility arrays
  are capacity-sized or reserved during initialization and reused per frame.

## Public API

`createEngine(canvas, options?)` returns a plain record of functions and state
adapters. Every engine owns one active perspective camera, exposed as
`engine.camera`; it is created before authoring entities and is not part of the
application's entity budget. `engine.create`, `engine.set`, and readonly handles
cover normal authoring without exposing ECS vocabulary. No mutable class
hierarchy or singleton is exposed. The `world` surface and
`@lume/api/advanced` component helpers remain an explicit advanced compatibility
layer; `world.add` converts their serializable descriptions into versioned worker
commands.

Entity handles are allocated synchronously on the main thread so authoring
remains ergonomic. Each handle carries an index and generation and is packed to
the same representation used by Rust when crossing the transport boundary.
Destroyed slots return to a fixed free list; reuse increments the generation so
stale references fail validation.

All public numeric tuples and camera/bounds values are checked for finite,
valid ranges before an entity slot is allocated. Material and advanced mesh
component handles are validated against the owning engine before commands are
published, so a foreign or stale handle cannot enter the transport stream.
Scene constructors enforce the same contract for advanced authoring: transform
vectors must be finite, quaternions must be finite and non-zero, and linear
RGBA color channels must be finite values in the inclusive `[0, 1]` range.

## Failure model

Initialization is an explicit promise. Renderer and WASM creation run in
parallel, but the worker waits for both branches to settle before reporting a
failure. Any branch that succeeded is disposed, including a success that arrives
after its sibling failed. Renderer construction also unwinds partially created
GPU resources in reverse ownership order. Device loss is reported as a typed
worker event. `start`, `stop`, `resize`, and `dispose` are idempotent. A failed
initialization rejects pending work rather than silently falling back to a
different graphics backend.

## Testing seams

The Rust ECS and math code are tested without a browser. Renderer ownership is
tested with mock GPU devices, including partial initialization failure. Worker
tests use deferred renderer/WASM promises to prove late successes are disposed.
The worker protocol is a discriminated union that can be validated independently
of rendering. Browser integration belongs in an end-to-end test layer.
