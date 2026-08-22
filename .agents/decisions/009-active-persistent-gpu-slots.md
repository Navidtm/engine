# ADR 009: Active Persistent GPU Slot Lifecycle

## Status

Implemented

## Date

2026-08-23

## Context

ADR 007 introduced fixed-capacity, entity-indexed instance records in
`RenderWorld` and a matching persistent renderer buffer. The current CPU
visibility path is correct because it iterates the compact extracted bounds list
and publishes only slots that belong to current renderables.

The persistent arrays have a different lifetime. Removing a mesh, transform, or
required resource removes that item from the compact snapshot, but the previous
instance bytes and slot identity remain in the persistent arrays. Those bytes
are harmless while only the compact CPU list is consumed. They are not a safe
input for a future compute pass that scans persistent slots directly: the pass
cannot distinguish a current renderable from a removed record.

The lifecycle contract must be defined before compute visibility or indirect
command generation is implemented. It must preserve:

- ECS as canonical simulation state;
- `RenderWorld` as the renderer-facing derived CPU representation;
- renderer ownership of WebGPU objects;
- generation-safe entity-slot reuse;
- fixed-capacity, allocation-free frame paths;
- the existing CPU visibility path; and
- epoch-gated reuse from ADR 008.

## Options considered

### Keep compact CPU membership as the only liveness state

Compute could receive the compact active-slot list rather than scan persistent
storage. This keeps today's representation unchanged, but makes the GPU depend
on CPU membership construction and leaves persistent slots unsafe for direct
scans or later GPU-maintained work queues.

### Compact persistent records on removal

Keeping only a dense active prefix reduces sparse scans. It also destroys stable
entity-indexed identity, turns removals into record moves, expands dirty uploads,
and requires every downstream reference to be repaired after compaction.

### Make the GPU scene authoritative

Structural commands could mutate GPU storage directly and treat CPU data as a
mirror. This violates the ECS -> RenderWorld -> renderer boundary, complicates
device-loss recovery, and makes deterministic CPU fallback unavailable.

### Add explicit active and generational metadata to stable slots

Each persistent slot retains its stable entity index and carries an explicit
active flag plus the packed generational entity identity. Payload bytes may
remain after removal, but no consumer may use them unless the metadata validates.
This adds bounded metadata and lifecycle uploads while preserving stable slots,
CPU fallback, and derived-cache ownership.

## Decision

Use explicit active, generational metadata for every persistent slot that may be
scanned by the GPU. Stable slot index alone is never proof that a record is
current.

The logical CPU metadata for a slot contains at least:

```text
PersistentSlotState
  entity: packed generational entity identity
  active: boolean
  transform revision
  bounds revision
  resource revision
  visitation/publication epoch
```

The exact CPU layout is an implementation detail. The GPU representation uses a
compact storage-buffer record containing the packed entity identity and flags;
bit zero is `ACTIVE`. The initial implementation should use a 16-byte record so
WGSL layout and future flags remain explicit, but a measured layout change may
replace it without changing these semantics.

A slot is eligible for compute visibility only when all of the following hold:

1. its published `ACTIVE` bit is set;
2. its packed identity matches the generation of the payload installed in that
   slot;
3. all required transform, bounds, geometry, material, and pipeline data were
   successfully extracted; and
4. the metadata and payload belong to the scene publication consumed by the
   visibility pass.

Inactive payload bytes are unspecified cache contents. Shaders and CPU systems
must not interpret them.

## Slot transitions

### Creation and activation

A newly renderable entity installs its complete identity, transform, bounds,
and resource payload before becoming active in a published scene snapshot. New
activation is a full-slot dirty event even if the slot's bytes happen to equal a
previous occupant.

### Mutation

An active slot remains active while individual domains change. Transform,
bounds, and resource-key changes are tracked independently so the renderer can
upload only the affected ranges. A physical buffer layout may combine domains,
but it must preserve the logical dirty distinction and correctness of full-slot
replacement.

### Removal and deactivation

Removing a mesh, despawning its entity, removing a required transform, or losing
a required resource makes the slot inactive at the next successful extraction.
Deactivation publishes `ACTIVE = 0` before any visibility dispatch can consume
that scene publication. The payload does not need to be zeroed and the slot is
not eligible for CPU or GPU visibility after deactivation.

### Generation replacement

If an entity index is recycled with a different generation, extraction treats
it as replacement rather than mutation. Replacement installs every payload
domain and the new packed identity as one publication. It never inherits dirty
or active state from the previous generation, and there is no published frame
in which both generations own the slot.

Multiple structural mutations before extraction collapse to the final canonical
ECS state. A remove-then-recreate sequence at one index therefore publishes
either the old generation, an inactive slot, or the fully installed new
generation—never a partially mixed record.

## Extraction and publication

`World` remains the canonical source. `RenderWorld` maintains a reusable active
slot list and visitation state so it can detect records that were active in the
previous successful snapshot but are absent from the next one. A later
incremental implementation may use fixed-capacity dirty queues; a linear rebuild
may compare the previous and next active lists. Both must produce the same state
transitions.

Scene publication is transactional at the frame boundary:

1. extraction derives the next CPU snapshot and all dirty domains;
2. capacity or dependency failure publishes neither a partial snapshot nor a
   GPU frame;
3. renderer uploads/copies for identity, activity, and payload complete in
   frame-graph order before visibility reads them; and
4. compute visibility and command generation consume exactly that successful
   publication.

No device-memory atomic is required for ordinary publication because the worker
is the sole renderer owner and does not mutate the scene buffers concurrently
with their dispatch. If that execution model changes, synchronization requires a
new decision.

Epoch-gated reuse remains valid. An unchanged world epoch reuses the active set
and payloads. Any lifecycle transition advances the render epoch. A failed
extraction invalidates reuse until canonical state is successfully rebuilt.

## Persistent and transient data

Persistent derived CPU state includes slot identity/activity, render payloads,
domain revisions, the reusable active list, and reusable dirty-range storage.
Persistent renderer state includes matching scene storage buffers and upload
revision state.

Visibility results are transient per scene publication and camera. Frustum
results, visible references, sorting/grouping output, counters, and indirect
commands must be cleared or overwritten before reuse. A transient result may be
identified by the scene publication epoch instead of storing a generation beside
every output entry. Any result retained across a publication boundary must carry
and validate the complete packed generational identity, not only the slot index.

GPU buffers are derived cache state. They are never the authority for entity
liveness, resource ownership, or component values. Device-loss recovery rebuilds
them from the current successful `RenderWorld` snapshot; it does not reconstruct
ECS state from GPU memory.

## CPU visibility and multi-camera behavior

The existing compact CPU visibility path remains supported and is the reference
correctness path. It consumes only the current active snapshot and may be used
for unsupported devices, diagnostics, small scenes, or measured runtime policy.
Introducing compute visibility must not make CPU visibility depend on reading
back GPU state.

All cameras consume the same persistent scene slots. Activity and generation are
global scene properties, not camera properties. Each camera has independent
transient visibility and command output, either in disjoint fixed-capacity
regions or in a sequentially reused region with explicit frame-graph ordering.
Processing one camera must not mutate slot activity or invalidate another
camera's scene input.

The current first-camera behavior remains unchanged until multi-camera rendering
is implemented. This ADR defines its storage semantics but does not add a public
multi-camera API.

## Capacity and memory

Slot-state and payload buffers are sized from immutable render capacity. Every
slot begins inactive. Activation beyond capacity fails before GPU publication;
buffers do not grow in a frame hot path.

The initial 16-byte state record adds:

```text
slot-state bytes = render capacity * 16
```

Transient visibility and indirect-command capacities are separate explicit
budgets. Implementations must report owned CPU/WASM/GPU bytes and must fail
deterministically when a configured capacity exceeds WebGPU buffer limits.
Sparse occupancy must be benchmarked because a full-capacity compute scan can
trade reduced CPU work for wasted GPU work. Hierarchical active masks or compact
GPU work lists may optimize that scan later without changing slot identity.

## Required correctness tests for implementation

Implementation is not complete without automated coverage for:

- create -> active with every payload domain initialized;
- mesh removal, entity destruction, missing transform, and invalid dependency
  each producing inactive state and zero subsequent visibility eligibility;
- destroy/recreate at the same index publishing only the new generation and a
  full-slot upload;
- remove/recreate and multiple mutations collapsed within one extraction;
- transform-only, bounds-only, resource-only, activation, and deactivation dirty
  classification;
- extraction/capacity failure publishing no partial CPU snapshot or GPU frame;
- unchanged-epoch reuse preserving activity without new uploads;
- CPU and GPU visibility producing equivalent active membership across empty,
  fully visible, fully culled, sparse, and randomized scenes;
- transient output from an older scene epoch being rejected or rebuilt;
- independent two-camera and four-camera results over the same active slots;
- device-loss reconstruction restoring only current active generations; and
- disposal releasing every slot-state, payload, visibility, and indirect buffer.

Tests that inspect GPU results must use readback only in test/benchmark code; no
production frame path may add readback synchronization.

## Required benchmark scenarios for implementation

Use controlled same-session baseline/candidate runs and retain raw samples. At
minimum measure 1k, 10k, 50k, and 100k configured slots; include 500k and 1M for
native CPU work and on WebGPU devices whose advertised limits permit them.

The matrix must cover:

- occupancy of 1%, 10%, 50%, and 100%;
- visible ratios of 0%, 10%, 50%, and 100%;
- static scenes and 1%, 10%, and 100% transform dirtiness;
- independent bounds and resource dirtiness;
- 1%, 10%, and 100% per-frame create/remove/recycle churn;
- one, two, and four cameras; and
- CPU visibility, GPU compute visibility, and any automatic policy separately.

Record CPU extraction/preparation/encoding/submission time, GPU visibility and
render timestamps, upload bytes and queue-write count by dirty domain, dispatch
and draw/indirect counts, active/tested/visible slots, missed-frame distribution,
and owned CPU/WASM/GPU bytes. Correctness hashes or readback counts must accompany
timings so stale-slot exclusion is demonstrated rather than inferred.

No CPU/GPU crossover threshold is accepted without these measurements. Browser,
GPU adapter, OS, resolution, warmup, sample count, configured capacities, and
tested commit must be recorded. Unsupported large cases are reported as skipped
with the device limit, never replaced by estimates.

## Implementation outcome

The implementation uses a 16-byte `GpuSlotState` record containing packed
entity identity, flags, payload identity, and reserved space. A separate
16-byte resource-key record contains geometry, pipeline, material, and packed
entity identity. Bounds remain 16-byte world-space spheres and instances retain
the ADR 007 80-byte layout. All four domains have reusable coalesced dirty
ranges; activation and generation replacement dirty every domain, while
deactivation only clears slot state.

GPU visibility partitions the compact candidate list by draw run. A reset
compute pass clears indirect instance counts, a cull pass validates activity,
payload/resource identities and frustum bounds, and atomic counters compact
visible slots into per-run regions. Rendering issues one `drawIndexedIndirect`
per valid run. The CPU path remains independently executable.

`auto` intentionally resolves to CPU. The committed controlled browser matrix
does not justify a portable CPU/GPU crossover threshold, so callers must opt in
to GPU visibility. Pull-requested diagnostic copies prove CPU/GPU count and
membership equivalence without adding readback to normal frames.

Renderer reconstruction after device loss replays live resource descriptors,
invalidates derived GPU cache state, and forces a full successful-scene
publication. Disposal tests cover every persistent scene, compute, indirect,
and readback buffer.

## Consequences

### Positive

- Removed and recycled slots have deterministic visibility semantics.
- Stable entity-indexed storage can safely feed compute visibility.
- GPU storage remains rebuildable derived state.
- CPU visibility stays available as fallback and correctness oracle.
- Dirty uploads can remain proportional to changed domains.
- Multi-camera rendering can share scene storage without sharing results.

### Negative

- Persistent state consumes at least 16 additional GPU bytes per render slot,
  plus matching CPU metadata.
- Structural removal now requires a small metadata upload even when stale
  payload bytes are retained.
- Publication and transient-output epochs add state and validation complexity.
- Scanning fixed capacity may be inefficient for sparse scenes and requires
  benchmark evidence before becoming the default path.

## Implementation sequence followed

1. Added CPU slot activity/identity and lifecycle tests while retaining CPU
   visibility.
2. Added renderer-owned slot-state storage and dirty uploads; continued drawing
   through the current visible-slot path.
3. Added compute visibility in parallel with CPU visibility and validated output
   equivalence.
4. Added indirect command generation after lifecycle correctness and
   benchmark evidence are stable.
5. Retained CPU as the automatic policy from measured end-to-end results and
   kept GPU visibility as explicit opt-in.

Occlusion culling, public multi-camera presentation, and an automatic CPU/GPU
crossover threshold are intentionally outside this decision.
