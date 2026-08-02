# Memory model

## Ownership boundaries

Lume uses three explicit memory domains:

| Domain            | Owner                        | Contents                                                                      |
| ----------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| Public authoring  | Main-thread TypeScript       | Immutable resource handles and transform controls                             |
| Transport         | Main thread + runtime worker | Shared transform slots, sequence counters, dirty flags, and dirty-index queue |
| Canonical runtime | Rust/WASM worker             | ECS components, materials, RenderWorld, visibility, and bulk staging arrays   |

The shared transport is not the ECS. JavaScript cannot mutate Rust component
storage directly, and Rust never retains references into SharedArrayBuffer.
This preserves ECS invariants and keeps future storage changes independent of
the public API.

## Shared transform layout

The transport layout is calculated once from `entityCapacity`:

```text
header:       9 × i32
sequences:    capacity × i32
dirty flags:  capacity × i32
generations:  capacity × i32
field masks:  capacity × i32
dirty queue:  capacity × i32
transforms:   capacity × 10 × f32
```

Each transform contains position `[x, y, z]`, quaternion `[x, y, z, w]`, and
scale `[x, y, z]`. The packed entity index selects a fixed slot while its
generation travels beside the values. A three-bit mask marks position, rotation,
and scale independently, so publishing an update does not allocate, search, or
copy unchanged fields.

## Publication and draining

The main thread uses an odd/even sequence counter around each float write. A
dirty compare-and-exchange ensures repeated writes to the same pending entity
coalesce into one queue entry. The worker takes a stable sequence snapshot into
a reusable ten-float scratch array.

Drained values are copied into two preallocated WASM arrays: entity IDs and
packed transform values. A single bulk ABI call applies the entire batch before
the world update. There is one necessary transport-to-WASM copy, no structured
clone, and no per-transform boundary crossing.

## Capacity and failure

All shared and WASM staging storage is fixed at engine initialization. The
dirty ring has the same capacity as entity slots and each slot has at most one
pending entry. Overflow is therefore an invariant failure and is surfaced in
`engine.getStats().transport.overflows` rather than silently dropping data.

When cross-origin isolation or SharedArrayBuffer is unavailable, public
transform controls fall back to the versioned command channel. Structural
commands always use that channel.
