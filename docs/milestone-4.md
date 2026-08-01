# Milestone 4 — shared runtime transport

## Scope

Milestone 4 replaces per-update structured-clone messages with a shared-memory
transport for hot component data. Structural operations remain commands. The
runtime pipeline becomes:

```text
TypeScript authoring API
  -> SharedArrayBuffer transform state + dirty-index queue
  -> worker bulk staging into WebAssembly memory
  -> one WASM call per drained batch
  -> ECS systems -> RenderWorld -> visibility -> FrameGraph -> WebGPU
```

The shared buffer is transport memory, not canonical ECS storage. This keeps
Rust as the sole owner of ECS invariants and avoids exposing WebAssembly linear
memory to concurrent JavaScript mutation.

## Ownership

- Rust owns entities, components, material data, extracted render data, and
  visible render buffers.
- TypeScript owns public handles and authoring adapters.
- The main thread owns writes to shared transform slots and the dirty-queue
  tail.
- The worker owns reads from shared transform slots and the dirty-queue head.
- Structural commands remain worker messages because they change storage shape
  or resource lifetime.

## Shared layout

The buffer contains a fixed header, one seqlock counter and dirty flag per
entity slot, a single-producer/single-consumer dirty-index ring, and ten `f32`
transform values per entity: position, quaternion, and scale.

The producer writes a slot under an odd/even sequence counter, marks the slot
dirty once, publishes its entity index to the ring, and increments a write
epoch. Repeated writes to an already-dirty slot coalesce. The consumer clears
the dirty flag before taking a stable seqlock snapshot, allowing a concurrent
rewrite to enqueue the slot again without loss.

The ring capacity equals entity capacity. Because each entity can own at most
one pending dirty entry, a correctly initialized ring cannot overflow. An
overflow counter remains part of the ABI so invariant violations are visible.

## Synchronization

Synchronization uses sequentially consistent `Atomics` operations over
`Int32Array` views. No locks or blocking waits are used in the render loop.
Frame/write and consumed/read epochs are diagnostic counters; the worker drains
updates at the beginning of its normal animation frame.

## Compatibility

Shared transport is enabled only when `SharedArrayBuffer` and cross-origin
isolation are available. Otherwise transform updates retain the structural
command path. The public API does not expose which transport is active.

## Hot-path contract

- No object serialization or `postMessage` for shared transform updates.
- No allocation while publishing or draining updates.
- One contiguous copy from shared transport into preallocated WASM staging
  memory per changed transform.
- One WASM boundary crossing per drained batch, not per transform.
- Visibility and animation outputs are never sent back through the command
  channel.
