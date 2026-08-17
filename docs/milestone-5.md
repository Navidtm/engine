# Milestone 5: Transport Hardening

Milestone 5 freezes the runtime communication model before rendering scale work.
It changes memory transport only; it does not add rendering or simulation
features.

## Ownership and lifetime

- The main thread owns public entity handles and is the sole producer of shared
  transform updates and structural commands.
- The worker is the sole consumer of both shared queues. It owns the WebAssembly
  instance, frame loop, and all temporary staging views.
- Rust owns the canonical entity allocator, ECS components, and render-world
  extraction. Shared memory is transport state, never canonical scene state.
- Shared buffers and WebAssembly staging buffers are allocated once during
  initialization and remain valid until `dispose`.
- Entity references use a packed index plus generation at every boundary. A
  destroyed slot may be reused only after its generation changes.

## Lowest-copy path

A browser `SharedArrayBuffer` cannot directly become ordinary Rust-owned WASM
linear memory. Sharing WebAssembly memory itself would require a shared-memory
WASM build and would expose canonical ECS storage to concurrent JavaScript
writes. That conflicts with Rust's exclusive-mutation model and makes sparse-set
relocation unsafe.

The engine therefore uses the following lowest-copy path:

```text
main-thread values
  -> fixed SharedArrayBuffer slots (only changed fields)
  -> fixed indexed WebAssembly staging (only dirty ranges and fields)
  -> canonical Rust components (one ABI call)
```

There is no per-frame allocation and no intermediate compact JavaScript copy.
The worker drains directly into typed views over WebAssembly staging memory.
Range descriptors allow one bulk ABI call while field masks avoid copying or
assigning unchanged transform fields.

## Transform synchronization

Each transform slot contains a seqlock sequence and one atomic publication word
packing generation plus field mask. The producer makes the sequence odd, writes
selected values, merges the mask only when the generation matches, and makes the
sequence even. It then enqueues the index once using an atomic dirty bit. The
consumer claims the packed publication only after a stable read and verifies the
sequence again after claiming it.

Field bits are:

| Bit | Field    |                              Float values |
| --- | -------- | ----------------------------------------: |
| `1` | position |                                         3 |
| `2` | rotation |                                         4 |
| `4` | scale    |                                         3 |
| `8` | matrix   | reserved for a later renderer-facing path |

Adjacent drained indices are merged into reusable `{ start, count }` ranges.
Queue order is preserved; no sort or temporary allocation is allowed. Duplicate
updates collapse through the dirty bit and generation-aware field-mask merge.
If a producer repeats the same field while consumption is in progress, the
post-claim sequence check restores that field for a retry rather than losing the
new value.

Generation and field mask are inseparable at publication and claim time: the
consumer claims one packed `(generation, mask)` word after a stable seqlock
snapshot, then verifies the sequence again. A replacement generation overwrites
the prior generation's mask instead of merging with it. If a same-generation
write races the claim without changing the mask value, the changed sequence
causes a restore-and-retry; the restore is conditional on the generation still
matching, so it cannot overwrite a replacement publication.

## Structural command queue

Create, destroy, add-component, and remove-component operations use a separate
bounded SPSC ring in the same shared allocation. Its capacity is independently
configured as `transport.structuralCommandCapacity` (default
`min(entityCapacity, 1,024)`),
so short structural bursts do not reserve one command record per entity. Each slot is a fixed-width
command record. Publishing the tail is the release point; consuming the head is
the acquire point. Commands are applied in FIFO order before transform ranges so
a newly created entity exists before its component data arrives.

If the ring is full, the write fails explicitly and increments
`droppedCommands`. The worker drains older shared structural and transform
publications before applying the attempted command; all later structural and
transform authoring then uses the ordered message stream. Initialization batches
remain message based because they can exceed the runtime ring before the worker
starts.

## Generational lifecycle

An entity handle is `{ index, generation }`. The packed transport value reserves
20 bits for the index and 12 bits for the generation. Destroy returns the index
to a fixed free list and advances the generation before reuse. Every TypeScript,
worker, and Rust operation validates both fields, so a retained old handle cannot
mutate a replacement entity occupying the same slot.

## Metrics contract

`engine.getStats().transport` exposes cumulative transport counters plus current
queue depth:

- `messages`: worker messages received;
- `sharedWrites`: successfully published shared transform/command writes;
- `dirtyRanges`: transform ranges applied by the worker;
- `bytesUploaded`: bytes copied into WebAssembly staging;
- `queueDepth`: pending transform plus structural records;
- `droppedCommands`: structural-ring overflow attempts.

These values make transport regressions observable without a profiler and are
also emitted by the benchmark harness.
