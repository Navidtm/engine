# Memory model

## Ownership and lifetime

Lume has three non-overlapping memory domains:

| Domain            | Owner                                 | Lifetime            | Contents                                               |
| ----------------- | ------------------------------------- | ------------------- | ------------------------------------------------------ |
| Authoring         | main-thread TypeScript                | engine lifetime     | immutable entity handles, controls, free list          |
| Transport         | main thread produces; worker consumes | `init` to `dispose` | transform slots, dirty ring, structural ring, counters |
| Canonical runtime | Rust/WASM worker                      | `init` to `dispose` | ECS, RenderWorld, visibility and fixed staging arrays  |

Shared memory is transport state, never the ECS. Rust does not retain references
into the browser `SharedArrayBuffer`, and JavaScript cannot mutate sparse-set
storage. This preserves Rust's exclusive mutation and allows ECS relocation.

All hot-path arrays are capacity-sized once. A WASM memory growth refreshes
JavaScript typed views but does not change the exported staging offsets.

## Shared allocation

The allocation is derived from `entityCapacity`:

```text
header:              15 × i32
sequences:           capacity × i32
dirty flags:         capacity × i32
publications:        capacity × i32 (generation + field mask)
transform queue:     capacity × i32
transforms:          capacity × 10 × f32
structural commands: capacity × 16 × i32
```

The structural words also have a `Float32Array` view, so command encoding does
not allocate or convert payload buffers. Transform slots contain position,
quaternion and scale. Packed entity indices select slots. A single atomic
publication word stores the 12-bit generation and four-bit field mask so masks
cannot cross a recycled entity generation.

## Lowest-copy transform path

Browser SAB memory cannot become ordinary Rust-owned WASM linear memory. A
shared-memory WASM build would make canonical component storage concurrently
writable and invalidate sparse-set and Rust aliasing guarantees. True zero-copy
is therefore not compatible with the current ownership model.

The implemented path is:

```text
authoring value
  -> selected fields in a fixed SAB slot
  -> selected fields in fixed index-based WASM staging
  -> canonical Transform fields in Rust
```

There is one unavoidable SAB-to-WASM copy. There is no structured clone, compact
temporary array, per-entity ABI call, or per-frame allocation. Generation and
mask cost 8 bytes per updated slot; range descriptors cost 8 bytes per range.
Position-only updates copy 12 payload bytes instead of the full 40-byte
transform. The fourth mask bit marks a derived matrix refresh; it has no
transport payload because the matrix is composed by the Rust transform system.

## Dirty ranges

The worker drains indices in producer order. Consecutive unique indices become
one reusable `{start, count}` descriptor in WASM memory. A fixed epoch array
deduplicates repeated indices without clearing or allocating. Non-adjacent queue
order intentionally remains separate ranges; sorting would add work and storage.

Rust receives the range count in one ABI call, reconstructs packed handles from
index plus generation, validates liveness, applies masked fields, and clears the
staging masks for reuse.

## Entity lifecycle

Public handles are immutable `{index, generation}` values associated with one
engine. Transport packs 20 index bits and 12 generation bits into a `u32`.
Destroy advances the generation and pushes the index onto a fixed TypeScript
free list. Recreate pops that slot. TypeScript rejects stale or foreign handles
before publication; Rust validates the packed generation again.

When a producer publishes a transform for a new generation, its mask replaces
rather than merges with the prior generation's mask. The consumer claims the
generation and mask as one atomic word and verifies the seqlock again after the
claim. This prevents both cross-generation field leakage and a same-field write
from being swallowed during consumption.

Generation wraps after 4096 reuses of the same slot. Applications that retain a
handle across that many destroy/recreate cycles exceed the protection window of
the compact format.

## Capacity and fallback

Transform and structural queues are bounded by `entityCapacity`. Dirty-bit
coalescing means the transform queue cannot exceed one pending entry per slot.
Structural overflow increments `droppedCommands`; the attempted command and all
later structural commands switch to ordered `postMessage` fallback, so scene
operations are not semantically dropped.

Without cross-origin isolation, the engine selects the versioned message path.
Production hosting must provide COOP and COEP headers to enable shared transport.
