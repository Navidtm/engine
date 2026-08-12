# ADR 007: Persistent GPU Instance Storage

## Status

Accepted

## Date

2026-08-12

## Context

The initial renderer compacted complete `GpuInstance` records into visible draw
order and uploaded that complete range on every frame. A static 10,000-instance
scene therefore issued 800,128 bytes of CPU-to-GPU writes per frame: 800,000
instance bytes plus one 128-byte camera record. This work scaled with visible
count rather than changed count and prevented later GPU-driven visibility from
using stable scene records.

The replacement must preserve the ECS -> RenderWorld -> renderer boundary,
remain fixed-capacity and allocation-free in frame hot paths, handle
generational entity-slot reuse, and keep CPU-prepared grouped draws working.

## Options considered

1. Retain compact visible records and diff them after sorting. This minimizes
   shader changes but reordering makes otherwise unchanged records appear dirty
   and still copies 80 bytes per visible instance on the CPU.
2. Keep a persistent entity-indexed instance buffer and upload a compact list
   of visible slot indices. This adds four GPU bytes per configured entity and
   one shader indirection while making instance writes proportional to changed
   slots.
3. Introduce a complete GPU scene database, compute culling, and indirect draws
   immediately. This is the long-term direction, but combines several
   independently measurable architecture changes and is beyond this issue.

## Decision

Use a fixed-capacity, entity-indexed persistent instance array in
`RenderWorld` and a matching renderer-owned GPU storage buffer. Each slot keeps
the entity generation and render revision last written to it. Extraction writes
the 80-byte matrix/color record only when either changes, sorts changed slot
indices in reusable storage, and exposes coalesced ranges through the versioned
WASM ABI.

Material changes fan out a render-revision bump to referencing meshes at the
structural mutation point. This avoids a second material-revision lookup for
every mesh on every extraction while keeping material replacement observable.

Visibility retains grouped CPU draw order but emits `u32` persistent slot
indices instead of copying instance records. The renderer uploads this compact
mapping only when it changes. The mesh shader resolves
`instances[visibleSlots[instance_index]]`. Camera data is also uploaded only
when its extracted record changes.

Renderer statistics expose bytes and write-call counts for the most recently
encoded frame. The browser benchmark records raw samples across 1k, 10k, 50k,
and 100k entities at 0%, 1%, 10%, and 100% update ratios.

## Ownership and lifetime

- Rust `RenderWorld` owns canonical persistent CPU instance records, slot
  generations/revisions, and reusable dirty-range storage.
- Visibility owns the reusable compact visible-slot list and its change state.
- The renderer exclusively owns persistent instance and visible-slot GPU
  buffers.
- JavaScript typed arrays are borrowed views into stable WASM allocations. They
  do not own or resize those allocations.
- Slot identity is an implementation detail and never crosses the public API.
  Recycled entity indices are overwritten when their generation changes.

## Consequences

- Static frames issue no instance, visible-slot, or camera buffer writes.
- Instance upload bytes scale with dirty ranges, except that sparse adjacent
  changes may be coalesced only when their slot indices are consecutive.
- The visible indirection buffer costs four GPU bytes per render-capacity slot
  and adds one storage-buffer read per vertex invocation.
- Extraction still walks renderable meshes and rebuilds transient grouping and
  bounds arrays. It is not an incremental RenderWorld or GPU-driven culling
  implementation.
- Render mutations must pass through `World` mutation methods so revisions are
  advanced. Engine systems that mutate render-consumed component storage
  directly must add an explicit dirty-publication contract before production
  use.
- The WASM ABI and worker protocol versions advance because frame-view shape
  and renderer metrics changed.

## Future work

Indirect command storage and compute visibility can consume the same stable
instance slots. Before removing CPU grouping, that work must separately measure
shader indirection, GPU culling, command generation, total frame CPU/GPU time,
and memory at the existing benchmark scales.
