# 1. `[Architecture] Introduce RenderView as the explicit unit of camera-driven rendering`

## Evidence

`core` currently exposes `RenderWorld` and `VisibleRenderBuffer`, but there is no first-class representation for the result of rendering the scene from one specific camera/view.

As camera support expands, visibility output, draw batches, and view-specific metadata will otherwise need to be associated implicitly.

A lightweight representation could look conceptually like:

```rust
pub struct RenderView {
    pub camera: Entity,
    pub visible_range: Range<u32>,
    pub batch_range: Range<u32>,
}
```

## Why this matters

A first-class view abstraction provides a clean foundation for multiple cameras, editor views, minimaps, previews, and future shadow/reflection views without coupling `core` to GPU render targets.

It also makes ownership of camera-specific visibility output explicit.

## Scope

- introduce a renderer-independent `RenderView` abstraction;
- associate a view with an explicit camera;
- associate visibility/batch output with the originating view;
- support more than one prepared view in a frame;
- keep view metadata allocation-conscious and suitable for WASM use.

## Non-goals

- creating GPU render targets;
- managing WebGPU textures or framebuffers;
- encoding render passes in `core`;
- implementing stereo rendering;
- implementing shadow maps in this issue.

## Acceptance criteria

- a prepared view identifies its source camera explicitly;
- visibility output can be associated with a specific view without relying on global camera state;
- multiple views can coexist deterministically;
- view data contains no WebGPU-specific objects;
- tests cover zero, one, and multiple prepared views;
- formatting, lint, and tests pass.

---

# 2. `[Reliability] Add an explicit core frame lifecycle and stage validation`

## Evidence

The expected lifecycle is currently based largely on caller discipline:

```text
mutate
→ update
→ extract
→ visibility
```

Calling stages out of order can produce stale derived data or inconsistent render snapshots.

`core` already has epochs/revisions, which can be extended to track stage progression.

## Why this matters

Lifecycle mistakes should be detected near the call that violates the contract rather than surfacing later as stale rendering or corrupted frame output.

A lightweight frame-state model also makes tests and runtime integration easier to reason about.

## Scope

- define explicit mutation/update/extraction stage epochs or states;
- detect extraction performed against outdated derived state;
- make stage relationships inspectable in debug builds;
- document valid frame-stage ordering;
- preserve low-level APIs for controlled advanced use.

## Non-goals

- implementing the application main loop in `core`;
- scheduling workers from `core`;
- submitting GPU work;
- requiring a heavyweight runtime state machine.

## Acceptance criteria

- `core` can detect when derived state is older than canonical mutations;
- valid stage ordering is documented;
- out-of-order usage produces deterministic failure or debug validation;
- correctly ordered frame processing has negligible additional overhead;
- regression tests cover valid and invalid stage sequences;
- formatting, lint, and tests pass.

---

# 3. `[Performance] Add a render change journal for incremental frame processing`

## Evidence

Current revision tracking primarily communicates that render-relevant state changed, but not which category of state changed.

A transform modification, geometry replacement, bounds mutation, spawn, and despawn can therefore lead to broader work than necessary.

## Why this matters

Incremental extraction becomes significantly more efficient when downstream systems know exactly what changed.

A compact change journal can avoid repeatedly scanning the whole World to reconstruct change information.

## Scope

- track render-relevant mutations in fixed-capacity change collections;
- distinguish at least transform, material, geometry, bounds, spawn, and despawn changes;
- deduplicate repeated mutations to the same entity where appropriate;
- expose change data to extraction;
- reset or rotate journal state at a documented frame boundary.

## Non-goals

- implementing a general-purpose event bus;
- allocating arbitrary event objects every frame;
- exposing renderer GPU resources through the change journal;
- making the journal a persistent gameplay event history.

## Acceptance criteria

- extraction can identify affected entities without reconstructing all changes from the full world;
- repeated mutations are safely coalesced where semantics permit;
- journal capacity and overflow behavior are explicit;
- steady-state journal operation introduces no unexpected heap allocations;
- tests cover mutation, spawn, despawn, and repeated changes;
- formatting, lint, and tests pass.

---

# 4. `[Feature] Expose removed render-instance slots explicitly`

## Evidence

When an entity is despawned or loses renderability, downstream consumers need to know that its previously used renderer-facing instance slot is no longer valid.

Without an explicit removal stream, the renderer/runtime may need to compare snapshots or reconstruct removals indirectly.

## Why this matters

Creation, modification, and removal are distinct incremental operations.

Providing explicit removed slots simplifies GPU-buffer maintenance and prevents stale instances from surviving after their source entity disappears.

## Scope

- track instance slots that cease to be renderable;
- expose removed slots from `RenderWorld`;
- coalesce duplicate removals;
- ensure removal data participates in the frame commit lifecycle;
- define removal semantics when an entity becomes renderable again in the same frame.

## Non-goals

- freeing GPU memory directly from `core`;
- calling WebGPU buffer APIs;
- defining renderer resource lifetime policy;
- implementing compaction in this issue.

## Acceptance criteria

- despawning a rendered entity emits its previous instance slot exactly once;
- removing required render components emits the same removal information;
- unchanged entities never appear in the removal stream;
- removal output is deterministic;
- tests cover despawn, component removal, and remove/re-add sequences;
- formatting, lint, and tests pass.

---

# 5. `[Architecture] Separate structural render changes from value-only changes`

## Evidence

Not all mutations have the same downstream consequences.

Changes such as entity spawn/despawn or geometry/material binding changes alter render structure, while changes such as a world matrix update may only require updating existing instance data.

Treating these categories identically forces downstream systems to perform more work than necessary.

## Why this matters

Structural changes can affect visibility ordering, batches, slot ownership, or collection membership.

Value changes often require only targeted buffer updates.

Separating them provides a cleaner incremental rendering contract.

## Scope

- define structural render changes separately from value changes;
- classify component addition/removal and binding changes as structural;
- classify transform and other in-place payload changes appropriately;
- allow extraction/visibility to choose the minimum required rebuild path;
- document change-category semantics.

## Non-goals

- moving GPU upload policy into `core`;
- exposing WebGPU buffer dirty flags directly;
- implementing a generic reactive dependency engine.

## Acceptance criteria

- structural and value-only mutations are distinguishable programmatically;
- transform-only updates do not unnecessarily trigger structural rebuild paths;
- add/remove component operations trigger structural invalidation;
- category behavior is covered by deterministic tests;
- formatting, lint, and tests pass.

---

# 6. `[DX] Introduce strong typed IDs for renderer-facing identities`

## Evidence

Several renderer-facing concepts are represented by primitive integers such as geometry IDs, pipeline IDs, and slots.

Primitive IDs are easy to accidentally interchange while still compiling successfully.

## Why this matters

Strong types move whole classes of identity mixups from runtime to compile time while preserving compact raw representations for WASM and transport.

## Scope

- introduce newtypes such as `GeometryId`, `PipelineId`, and `InstanceSlot`;
- preserve explicit `raw()` / `from_raw()` conversion where ABI boundaries require it;
- migrate internal APIs away from ambiguous primitive IDs;
- keep layouts compact and predictable.

## Non-goals

- introducing dynamically allocated UUIDs;
- changing the packed `Entity` representation as part of this issue;
- exposing Rust enum layout directly as ABI.

## Acceptance criteria

- geometry, pipeline, material, and instance-slot identities are not accidentally interchangeable in typed Rust APIs;
- raw numeric conversion remains explicit at transport boundaries;
- no additional per-ID heap allocation is introduced;
- layout expectations are tested where ABI-relevant;
- formatting, lint, and tests pass.

---

# 7. `[Architecture] Decouple persistent render instance slots from Entity indices`

## Evidence

Persistent renderer-facing instance slots are currently strongly tied to `Entity::index()`.

This means sparse/high entity IDs require correspondingly large slot capacities even when only a small number of entities are renderable.

## Why this matters

ECS identity and renderer storage identity serve different purposes.

Separating them allows dense render storage, avoids wasted capacity for sparse external entity IDs, and makes render capacity correspond to actual renderable count.

## Scope

- introduce a dedicated `InstanceSlot` allocator;
- maintain an entity-to-instance-slot mapping;
- recycle instance slots when entities stop being renderable;
- preserve stable slots while an entity remains renderable;
- expose slot creation/removal changes incrementally.

## Non-goals

- changing Entity allocation semantics;
- creating GPU buffers in `core`;
- compacting every frame;
- requiring render slots to survive entity destruction.

## Acceptance criteria

- a high-index Entity can use a low dense instance slot;
- render capacity is based on renderable slots rather than maximum Entity index;
- active renderables never share the same slot;
- slot recycling cannot expose stale ownership;
- tests cover sparse entities, slot reuse, removal, and capacity exhaustion;
- formatting, lint, and tests pass.

---

# 8. `[Feature] Add allocation-preserving clear/reset APIs`

## Evidence

Scene reloads, benchmarks, tests, and simulation resets need to remove large amounts of state.

Reconstructing `World`, `RenderWorld`, or visibility structures can discard already-reserved fixed-capacity memory.

## Why this matters

A reset operation that preserves backing allocation aligns with the package's fixed-capacity and predictable-frame design.

It also simplifies scene lifecycle management.

## Scope

- add `clear()` or equivalent reset APIs to core containers;
- clear logical entities/components/revisions without shrinking capacity;
- reset allocator state consistently;
- reset render/extraction/visibility state;
- document handle invalidation after reset.

## Non-goals

- automatically shrinking memory;
- resetting renderer GPU resources;
- implementing scene loading;
- preserving Entity validity across a complete World reset.

## Acceptance criteria

- clearing a World removes all logical entities/components;
- configured capacities remain available without reallocation;
- stale pre-clear handles are not treated as valid new entities;
- RenderWorld/visibility reset APIs leave valid empty state;
- tests verify memory-capacity preservation and logical reset;
- formatting, lint, and tests pass.

---

# 9. `[DX] Add standardized capacity introspection`

## Evidence

`core` relies extensively on fixed capacities for entities, components, materials, render instances, and temporary output buffers.

Callers currently need package-specific knowledge to determine how close each resource is to exhaustion.

## Why this matters

Capacity usage is operational state, not merely an implementation detail, in a fixed-capacity engine.

Consistent introspection improves diagnostics, capacity planning, tests, and runtime monitoring.

## Scope

- expose `len`, `capacity`, and remaining capacity for major core stores;
- provide aggregate World capacity statistics;
- expose render/extraction buffer utilization;
- keep introspection read-only and allocation-free.

## Non-goals

- automatically resizing capacities;
- logging directly from `core`;
- enforcing global application limits.

## Acceptance criteria

- callers can inspect used and configured capacity for major storage categories;
- statistics accurately reflect live/reachable records;
- capacity reads do not mutate state;
- introspection does not allocate in steady state;
- tests cover empty, partial, and full capacities;
- formatting, lint, and tests pass.

---

# 10. `[DX] Expose capacity pressure levels before hard exhaustion`

## Evidence

Fixed-capacity failure currently becomes most visible when an insertion or extraction operation finally fails.

There is no standardized way for a caller to know that a major storage category is approaching exhaustion.

## Why this matters

Runtime and tooling can respond much earlier if core exposes capacity pressure without performing its own logging or policy decisions.

## Scope

- define capacity-pressure thresholds or normalized utilization;
- expose pressure for major fixed-capacity stores;
- keep threshold policy configurable or clearly documented;
- integrate pressure information with core diagnostics.

## Non-goals

- logging warnings directly from `core`;
- automatically allocating larger buffers;
- deciding application behavior when capacity is critical.

## Acceptance criteria

- callers can distinguish normal, elevated, and near-exhausted capacity states;
- pressure calculation is deterministic;
- hard-capacity semantics remain unchanged;
- no logging side effects are introduced;
- tests cover threshold boundaries;
- formatting, lint, and tests pass.

---

# 11. `[DX] Add explicit renderability queries and failure reasons`

## Evidence

Whether an entity is renderable currently depends on a combination of components and valid references.

Callers or debugging tools need to reconstruct those requirements manually.

## Why this matters

A first-class renderability query makes the render contract discoverable and provides actionable diagnostics when an expected object does not appear.

## Scope

- add an `is_renderable(entity)` query;
- expose a detailed renderability result;
- distinguish missing transform, mesh renderer, invalid material, and other required state;
- ensure the query does not mutate World state.

## Non-goals

- performing visibility/frustum tests;
- querying GPU resource readiness;
- loading missing assets automatically.

## Acceptance criteria

- callers can determine whether an entity is structurally renderable;
- non-renderability includes a deterministic reason;
- stale/dead entities are handled explicitly;
- the query is allocation-free;
- tests cover every renderability reason;
- formatting, lint, and tests pass.

---

# 12. `[DX] Report detailed extraction skip reasons`

## Evidence

Render extraction can skip entities because required render state is missing or invalid.

A total skipped count is insufficient to determine why a scene contains fewer extracted instances than expected.

## Why this matters

Per-reason statistics make extraction failures observable without enabling expensive debug tracing.

They are especially useful across WASM/runtime boundaries where direct inspection is harder.

## Scope

- extend extraction statistics with categorized skip counts;
- include missing transform/material/bounds or other applicable reasons;
- keep statistics compact;
- ensure counting has minimal hot-path overhead.

## Non-goals

- storing a string error for every skipped entity;
- logging every skip from `core`;
- returning full entity lists for every reason in release builds.

## Acceptance criteria

- extraction stats explain why entities were skipped;
- the sum of categorized outcomes matches processed renderable candidates;
- stats remain deterministic;
- existing extraction output semantics remain unchanged;
- tests cover each skip category;
- formatting, lint, and tests pass.

---

# 13. `[DX] Add detailed visibility rejection statistics`

## Evidence

Visibility currently determines whether bounds intersect the selected frustum, but aggregate diagnostics do not fully explain where candidate objects are rejected.

Future layer masks and spatial acceleration will introduce additional rejection stages.

## Why this matters

Visibility statistics help distinguish expensive scenes from incorrectly configured scenes and make culling behavior easier to profile.

## Scope

- report total candidates and visible instances;
- report frustum rejection counts;
- extend statistics for layer/spatial rejection when those features exist;
- report invalid or uncullable bounds separately.

## Non-goals

- logging individual visibility decisions;
- performing GPU occlusion queries;
- exposing WebGPU timing information.

## Acceptance criteria

- visibility statistics account for all candidates;
- rejection categories do not double-count one candidate as multiple final outcomes unless documented;
- statistics remain allocation-free;
- tests cover visible and rejected populations;
- formatting, lint, and tests pass.

---

# 14. `[DX] Add optional debug visibility-reason inspection`

## Evidence

When an object disappears unexpectedly, current release-oriented visibility output only communicates whether the object survived culling.

It does not provide a direct answer to why a specific entity was rejected.

## Why this matters

Targeted visibility inspection can dramatically reduce debugging time for bounds, camera, layer, and frustum issues without imposing release-build overhead.

## Scope

- provide an opt-in/debug-only visibility inspection API;
- report reasons such as visible, outside-frustum, invalid-bounds, or layer-rejected;
- allow querying a specific renderable/entity;
- compile out or minimize overhead in normal release paths.

## Non-goals

- storing per-entity visibility explanations every frame in release builds;
- implementing editor UI;
- replacing aggregate visibility statistics.

## Acceptance criteria

- developers can request a deterministic reason for a specific visibility decision;
- normal release culling does not pay significant per-entity diagnostic storage cost;
- reason output matches actual culling logic;
- tests cover representative rejection causes;
- formatting, lint, and tests pass.

---

# 15. `[Feature] Add AABB bounds support alongside bounding spheres`

## Evidence

Bounding spheres are cheap to transform and test, but can be highly conservative for elongated geometry such as walls, roads, and tall structures.

`core` currently has one primary bounds representation for visibility.

## Why this matters

Supporting AABB bounds allows tighter CPU-side culling for classes of geometry where sphere bounds are inefficient.

It also gives scene/geometry metadata more flexibility.

## Scope

- define AABB bounds representation;
- support transforming local AABB bounds into suitable world-space bounds;
- support frustum-vs-AABB testing;
- allow geometry metadata to specify its bounds type;
- benchmark sphere and AABB paths.

## Non-goals

- implementing oriented bounding boxes in this issue;
- implementing mesh-level triangle culling;
- performing GPU occlusion culling;
- storing vertex data in `core`.

## Acceptance criteria

- both sphere and AABB bounds can participate in visibility;
- AABB frustum tests do not produce false-negative visibility;
- bounds type selection is explicit;
- existing sphere behavior remains supported;
- tests cover inside, outside, intersecting, transformed, and scaled AABBs;
- formatting, lint, and tests pass.

---

# 16. `[Safety] Represent missing bounds explicitly instead of fabricating geometry bounds`

## Evidence

A renderable without known bounds should not be assumed to have a specific physical extent.

Using a fabricated default can lead to false-negative culling.

## Why this matters

Correctness should take precedence over culling efficiency when bounds are unknown.

An explicit unbounded/unknown state makes the visibility contract clear.

## Scope

- introduce an explicit representation for known versus unknown/unbounded bounds;
- ensure unknown bounds are conservatively considered visible;
- allow later insertion of authoritative bounds;
- preserve efficient fast paths for known bounds.

## Non-goals

- computing mesh bounds from GPU buffers;
- assigning unit-cube bounds to arbitrary geometry;
- removing frustum culling for entities with valid bounds.

## Acceptance criteria

- missing bounds cannot incorrectly hide a renderable;
- known bounds continue to use normal culling;
- bounds removal results in documented unknown/unbounded behavior;
- statistics can distinguish uncullable objects if useful;
- tests cover transitions between known and unknown bounds;
- formatting, lint, and tests pass.

---

# 17. `[Safety] Centralize finite-value and math input validation`

## Evidence

Transforms, cameras, bounds, scales, and quaternions have related numeric validity requirements.

Distributed validation makes it easy for one mutation path to accept `NaN`, infinity, degenerate scale, or invalid quaternion input while another rejects it.

## Why this matters

Non-finite values can poison matrices, frustum planes, bounds, and extraction output far away from the original mutation.

A centralized validation policy makes behavior consistent and testable.

## Scope

- add reusable validation helpers for vectors, quaternions, scales, camera projections, and bounds;
- define finite-value requirements explicitly;
- define policy for zero/negative scale;
- normalize or reject quaternions according to documented semantics;
- use validation consistently across public mutation APIs.

## Non-goals

- creating a new general-purpose math library;
- silently repairing every invalid numeric value;
- implementing physics constraints.

## Acceptance criteria

- all public transform/camera/bounds mutation paths apply the same finite-value policy;
- `NaN` and infinity cannot silently enter accepted derived state;
- quaternion handling is documented and consistent;
- validation helpers have focused unit tests;
- formatting, lint, and tests pass.

---

# 18. `[Feature] Add deterministic core output mode for testing and replay`

## Evidence

Dense-storage removal, batching, grouping, and change collection can permit implementation-dependent ordering unless deterministic ordering is explicitly preserved.

Tests, replays, and debugging benefit from stable output for equivalent state.

## Why this matters

Deterministic core output simplifies regression testing, snapshot comparison, reproducible bug reports, and future replay tooling.

## Scope

- define which core outputs must be deterministic;
- make batch/change/view ordering stable under deterministic mode;
- ensure active-camera/view selection never depends on storage accidents;
- expose configuration or guarantee deterministic behavior globally where affordable;
- document any operations whose ordering remains unspecified.

## Non-goals

- guaranteeing bit-identical floating-point behavior across all hardware architectures;
- implementing network lockstep;
- serializing complete game state.

## Acceptance criteria

- equivalent core state produces the same documented ordering;
- batch/change output is repeatable;
- tests verify deterministic behavior across insertion/removal permutations where semantics should match;
- deterministic behavior introduces acceptable overhead;
- formatting, lint, and tests pass.

---

# 19. `[DX] Add a lightweight render snapshot fingerprint`

## Evidence

Core revisions identify some mutations, but there is no compact way for tests/runtime tooling to compare complete renderer-facing snapshot identity.

## Why this matters

A non-cryptographic fingerprint makes it easy to detect whether render-relevant output changed between frames and is useful in regression tests and diagnostics.

## Scope

- compute or expose a lightweight snapshot fingerprint;
- include renderer-relevant identities and values according to documented semantics;
- exclude transient memory addresses;
- keep fingerprint computation optional or inexpensive.

## Non-goals

- cryptographic integrity;
- using the fingerprint as persistent asset identity;
- replacing precise dirty tracking;
- hashing GPU resources.

## Acceptance criteria

- identical renderer-facing snapshots produce identical fingerprints within the documented environment;
- render-relevant changes alter the fingerprint;
- transient pointer/address changes do not affect it;
- tests cover unchanged and changed snapshots;
- formatting, lint, and tests pass.

---

# 20. `[Feature] Add a fixed-capacity core structural event stream`

## Evidence

Runtime consumers may need to react to entity spawn/despawn and component structural changes without scanning World state again.

The information already exists at mutation time but is not exposed as a dedicated structural event stream.

## Why this matters

A compact event stream reduces repeated discovery work and provides a clean bridge between canonical ECS mutations and higher-level orchestration.

## Scope

- emit structural events for spawn/despawn and component add/remove;
- use fixed-capacity/reusable storage;
- preserve deterministic event ordering;
- define event overflow semantics;
- reset/consume events at an explicit lifecycle boundary.

## Non-goals

- implementing gameplay events;
- delivering events across workers directly from `core`;
- supporting arbitrary user-defined event payloads;
- allocating unbounded queues.

## Acceptance criteria

- structural mutations emit the corresponding event exactly once according to documented semantics;
- value-only changes do not pollute the structural stream;
- event ordering is deterministic;
- overflow behavior is explicit and tested;
- steady-state event handling is allocation-conscious;
- formatting, lint, and tests pass.

---

# 21. `[DX] Add focused ergonomic ECS query helpers for core use cases`

## Evidence

Common core operations need repeated combinations of components such as transform + mesh renderer + bounds.

Without focused query helpers, join logic and validation can become duplicated across systems.

## Why this matters

A small ergonomic query layer can reduce duplicated iteration logic without turning `core` into a general-purpose ECS framework.

## Scope

- expose clear immutable component iterators;
- add focused queries such as renderable iteration;
- preserve allocation-free dense iteration;
- keep mutation APIs invariant-safe;
- document ordering guarantees.

## Non-goals

- building a full archetype/query language;
- adding runtime reflection;
- supporting arbitrary dynamic component joins;
- replacing `SparseSet`.

## Acceptance criteria

- common render-oriented component combinations can be iterated without duplicate join logic;
- query APIs allocate no per-frame temporary collections;
- stale/dead components are not exposed as valid renderables;
- mutation remains controlled through World APIs;
- tests cover query correctness after add/remove/despawn;
- formatting, lint, and tests pass.

---

# 22. `[Architecture] Separate render change tracking from canonical World storage`

## Evidence

`World` currently owns canonical scene component state together with renderer-oriented revisions and epochs.

As core grows, rendering-specific bookkeeping can increasingly couple generic ECS mutation code to extraction behavior.

## Why this matters

Separating canonical state from render change tracking keeps responsibilities clearer and makes it easier to evolve extraction without contaminating every World operation with renderer-specific logic.

## Scope

- evaluate extracting renderer-oriented revisions/change journals into a dedicated tracker;
- preserve efficient mutation hooks;
- keep canonical component storage independent from renderer implementation details;
- expose the minimum data required by `RenderWorld`.

## Non-goals

- removing render-aware APIs from `core` entirely;
- moving change tracking into `renderer`;
- replacing ECS storage;
- introducing runtime allocations for every mutation.

## Acceptance criteria

- canonical component data has a clearly defined responsibility separate from render tracking;
- extraction can consume change information without embedding renderer state into unrelated storage types;
- mutation performance does not materially regress;
- architecture and ownership are documented;
- formatting, lint, and tests pass.

---

# 23. `[Quality] Document core invariants as a first-class engineering contract`

## Evidence

Correctness depends on several implicit invariants across `EntityAllocator`, `SparseSet`, World mutation, render extraction, and persistent slots.

Examples include:

```text
one live entity identity per allocated slot
one component record per entity index per SparseSet
no allocation of INVALID Entity
derived matrices correspond to current canonical state
render snapshots contain only complete renderables
instance slots have unique ownership
```

These invariants are currently distributed across implementation details and comments.

## Why this matters

Explicit invariants make reviews, tests, future refactors, and bug investigations much more reliable.

They also provide the specification for property and debug validation tests.

## Scope

- add a dedicated core invariants document;
- document allocator, SparseSet, World, extraction, visibility, and slot invariants;
- link implementation comments to the invariant definitions where useful;
- convert important invariants into automated tests.

## Non-goals

- documenting every implementation detail;
- freezing internal implementation forever;
- replacing API documentation.

## Acceptance criteria

- major correctness invariants are documented centrally;
- each critical invariant has at least one corresponding automated check or regression test where practical;
- future contributors can identify whether a change preserves or intentionally changes an invariant;
- documentation stays package-specific and concise;
- formatting and documentation checks pass.

---

# 24. `[Quality] Add internal debug invariant validation for core data structures`

## Evidence

Corruption in allocator free lists, sparse/dense mappings, dirty ranges, batch ranges, or slot mappings can remain latent until much later in a frame.

These structures have inexpensive consistency rules that can be checked during debug/test builds.

## Why this matters

Failing immediately at the point an invariant becomes invalid is significantly easier to diagnose than observing later rendering artifacts.

Debug-only validation also avoids release hot-path cost.

## Scope

- add debug/test validation helpers for `EntityAllocator`;
- validate SparseSet sparse↔dense consistency;
- validate RenderWorld slot ownership and ranges;
- validate dirty ranges and batch ranges;
- call validation at selected mutation/frame boundaries in debug builds.

## Non-goals

- running full validation after every operation in release builds;
- converting recoverable API errors into panics;
- replacing property tests.

## Acceptance criteria

- allocator validation checks live counts, free-list uniqueness, and live/free exclusivity;
- SparseSet validation detects duplicate/orphaned mappings;
- RenderWorld validation detects duplicate slot ownership and invalid ranges;
- validations are compiled out or effectively free in release configurations;
- deliberate invariant corruption is detected by tests;
- formatting, lint, and tests pass.

---

# 25. `[Quality] Add no-allocation regression coverage for steady-state core frame paths`

## Evidence

A core design goal is predictable fixed-capacity frame processing.

Hot paths such as:

```text
World::update
RenderWorld::extract
VisibleRenderBuffer::cull
```

are intended to reuse preallocated storage, but this guarantee is not currently enforced by dedicated regression coverage.

## Why this matters

A future refactor can accidentally introduce temporary vectors, map growth, formatting, or other heap allocations into per-frame paths without changing functional tests.

Allocation regressions can cause frame-time spikes and undermine one of the core package's primary design goals.

## Scope

- establish representative steady-state frame scenarios;
- instrument allocation count in tests/benchmarks;
- verify update/extraction/visibility paths reuse configured storage after warmup;
- document which operations are expected to remain allocation-free;
- allow explicit initialization/growth allocations outside measured steady-state regions.

## Non-goals

- forbidding all allocation anywhere in `core`;
- measuring renderer/WebGPU driver allocation;
- treating scene setup and initial capacity construction as frame hot paths;
- replacing performance benchmarks.

## Acceptance criteria

- documented steady-state core frame paths perform zero unexpected heap allocations after initialization;
- regression tests fail when new allocations enter protected hot paths;
- test scenarios include unchanged frames and sparse-mutation frames;
- allowed initialization/setup allocations are clearly separated from measured regions;
- allocation tests are deterministic enough for CI;
- formatting, lint, and tests pass.
