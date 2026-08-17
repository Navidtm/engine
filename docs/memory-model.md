# Memory model

## Ownership and lifetime

Lume has three non-overlapping memory domains:

| Domain            | Owner                                 | Lifetime            | Contents                                               |
| ----------------- | ------------------------------------- | ------------------- | ------------------------------------------------------ |
| Authoring         | main-thread TypeScript                | engine lifetime     | readonly handles, controls, free list                  |
| Transport         | main thread produces; worker consumes | `init` to `dispose` | transform slots, dirty ring, structural ring, counters |
| Canonical runtime | Rust/WASM worker                      | `init` to `dispose` | ECS, RenderWorld, visibility and fixed staging arrays  |

Shared memory is transport state, never the ECS. Rust does not retain references
into the browser `SharedArrayBuffer`, and JavaScript cannot mutate sparse-set
storage. This preserves Rust's exclusive mutation and allows ECS relocation.

All ECS and hot-path arrays are capacity-sized once. `WorldCapacity` is a hard
budget: entity allocation, externally claimed handles, and every component
sparse set reject capacity overflow instead of growing WASM memory. A WASM
memory growth refreshes JavaScript typed views but does not change the exported
staging offsets; normal engine operation must not require one.

## Persistent renderer data

`RenderWorld` owns one 80-byte `GpuInstance` record per configured entity slot.
The record is indexed by entity index and overwritten when its generation or
render revision changes. Extraction exposes changed slots as reusable,
coalesced `{start, count}` arrays. The worker borrows stable WASM views and the
renderer writes only those byte ranges into its persistent storage buffer.

Visibility keeps render-key grouping compact, but its output is a four-byte
slot index rather than a copied 80-byte instance. A renderer-owned visible-slot
storage buffer maps `instance_index` to the persistent record. It is uploaded
only when visibility or ordering changes. Camera records use the same
compare-before-upload rule. These arrays have fixed capacity and create no
per-frame JavaScript allocation.

At 10,000 configured slots, the GPU indirection buffer adds 40,000 bytes. This
is the explicit memory trade-off for making static instance upload zero and
dirty instance upload proportional to changed ranges. Exact browser evidence is
stored in `benchmarks/results/persistent-instance-upload-latest.json`.

Render snapshot reuse adds constant scalar state rather than capacity-sized
metadata: the ECS world owns a render change epoch, `RenderWorld` retains its
last successful source epoch and change flag, and the WASM core retains one
visibility-valid flag. Browser measurements report identical WASM heap and GPU
buffer sizes before and after. Snapshot arrays remain owned by `RenderWorld` and
visibility; reuse changes their logical lifetime, not their capacity or owner.

## Shared allocation and budget

The allocation has three explicit, immutable budgets: public `entityCapacity`
for application ECS entities and rendering, advanced
`transport.transformCapacity` for transform slots and WASM staging, and
`transport.structuralCommandCapacity` for the SPSC command ring. The engine
adds one internal entity and transform slot for its active camera, so this does
not reduce the public entity budget. `transport.transformCapacity` defaults to
`entityCapacity`; it can be lower when transform-bearing entities are allocated
in the lower entity index range. The command budget defaults to
`min(entityCapacity, 1,024)`, because short structural bursts
do not justify reserving 64 bytes per entity. Overflow preserves ordering by
draining older shared structural and transform publications before the attempted
command, then switching subsequent structural and transform authoring to the
message fallback.

```text
SAB bytes = 64-byte header + transformCapacity × 56 bytes
          + structuralCommandCapacity × 64 bytes
```

The allocation is therefore:

```text
header:              16 × i32
sequences:           capacity × i32
dirty flags:         capacity × i32
publications:        capacity × i32 (generation + field mask)
transform queue:     capacity × i32
transforms:          capacity × 10 × f32
structural commands: commandCapacity × 16 × i32
```

Reference transport budgets (excluding ECS, RenderWorld, visibility, JS entity
metadata, and GPU buffers) use the default 1,024 command records:

| Entity capacity | Transform capacity |       SAB | WASM staging | Transport total |
| --------------: | -----------------: | --------: | -----------: | --------------: |
|          10,000 |             10,000 |  0.60 MiB |     0.53 MiB |        1.13 MiB |
|         100,000 |            100,000 |  5.40 MiB |     5.34 MiB |       10.74 MiB |
|         500,000 |            500,000 | 26.77 MiB |    26.70 MiB |       53.47 MiB |
|       1,000,000 |          1,000,000 | 53.47 MiB |    53.41 MiB |      106.88 MiB |
|       1,000,000 |            100,000 |  5.40 MiB |     5.34 MiB |       10.74 MiB |

The browser benchmark must record `performance.memory.usedJSHeapSize` when the
browser exposes it, together with the configured capacities. It is a
browser-specific peak measurement; the deterministic table above is the memory
budget used before a scene is created.

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

Public handles are readonly TypeScript `{index, generation}` values associated
with one engine; ordinary API objects are not runtime-frozen. Transport packs
20 index bits and 12 generation bits into a `u32`. Destroy advances the
generation and pushes the index onto a fixed TypeScript free list. Recreate pops
that slot. TypeScript rejects stale or foreign handles before publication; Rust
validates the packed generation again.

When a producer publishes a transform for a new generation, its mask replaces
rather than merges with the prior generation's mask. The consumer claims the
generation and mask as one atomic word and verifies the seqlock again after the
claim. This prevents both cross-generation field leakage and a same-field write
from being swallowed during consumption.

Generation wraps after 4096 reuses of the same slot. Applications that retain a
handle across that many destroy/recreate cycles exceed the protection window of
the compact format.

## Capacity, allocation failure, and fallback

The transform queue is bounded by `transport.transformCapacity`; dirty-bit
coalescing means it cannot exceed one pending entry per slot. The structural
queue is separately bounded by `transport.structuralCommandCapacity`.
Structural overflow increments `droppedCommands`. Before applying the attempted
command from `postMessage`, the worker drains older shared structural commands
and transform publications. The attempted command and all later structural and
transform authoring then use that FIFO message stream, so operations cannot
overtake either side of the transport boundary and are not semantically dropped.

Capacity is a contract, not a request to grow storage:

| Condition                                           | Observable behavior                                                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Invalid capacity configuration                      | `createEngine` throws `RangeError` before allocating a worker or shared memory.                                                                                                            |
| Entity or transform capacity exhausted              | The public API throws before publishing the command.                                                                                                                                       |
| Rust component capacity exhausted                   | The structural command is rejected by Rust; the worker reports an error and the engine transitions to failed rather than silently growing WASM storage.                                    |
| SAB allocation fails due to browser memory pressure | Browser allocation throws during engine creation; no worker initialization starts. The application must choose a smaller budget or run in the message-transport compatibility environment. |
| GPU storage-buffer/device limit is exceeded         | Renderer initialization rejects, disposes resources created so far, and initialization rejects.                                                                                            |

JavaScript has no portable API to reserve or query a browser process memory
limit. The deterministic budget above is therefore the preflight mechanism;
`performance.memory.usedJSHeapSize`, where exposed, is diagnostic peak data and
not an admission-control signal.

Without cross-origin isolation, the engine selects the versioned message path.
Production hosting must provide COOP and COEP headers to enable shared transport.
