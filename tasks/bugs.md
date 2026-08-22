# 1. `[Bug] EntityAllocator::claim can leave a claimed slot in the free list`

## Evidence

`EntityAllocator::despawn()` pushes the recycled entity index into `self.free`. If the same index and current generation are later reclaimed through `EntityAllocator::claim()`, the method marks the slot alive but does not remove that index from the free list.

A later `spawn()` can therefore pop the same index and return an entity handle that is already alive:

```rust
let mut entities = EntityAllocator::with_capacity(1);

let first = entities.spawn().unwrap();
assert!(entities.despawn(first));

let claimed = Entity::from_parts(first.index() as u32, 1).unwrap();
assert!(entities.claim(claimed));

let spawned = entities.spawn().unwrap();

// Both handles identify the same live entity.
assert_eq!(claimed, spawned);
```

`alive_count` is also incremented by both `claim()` and the subsequent `spawn()`, so allocator liveness accounting can diverge from the actual number of live slots.

## Why this matters

The allocator can return the same entity identity to two independent callers while reporting both allocations as live. This breaks the core generational-entity uniqueness invariant and can cause unrelated objects to overwrite or share ECS components.

It can also make `World::entity_count()` report more live entities than actually exist.

## Scope

- remove a successfully claimed recycled index from the allocator free list;
- preserve free-list correctness across `spawn()`, `claim()`, and `despawn()`;
- add regression coverage for claiming a previously recycled slot and spawning afterward;
- verify that `alive_count` always matches the number of live slots.

## Non-goals

- redesigning entity ID packing;
- changing the worker-side entity allocation protocol;
- changing component storage behavior.

## Acceptance criteria

- a successfully claimed entity index cannot subsequently be returned by `spawn()` while still alive;
- `alive_count` remains consistent after arbitrary `spawn` / `despawn` / `claim` sequences;
- claiming an already-live or stale handle still fails;
- deterministic allocator tests cover recycled-slot claiming;
- formatting, lint, and tests pass.

---

# 2. `[Bug] Claiming a high entity index makes lower vacant slots unavailable to spawn`

## Evidence

`EntityAllocator::claim()` resizes `generations` and `alive` directly to `index + 1` when an externally allocated entity uses an index beyond the current vector length:

```rust
if index >= self.generations.len() {
    self.generations.resize(index + 1, 0);
    self.alive.resize(index + 1, false);
}
```

The newly created lower slots are left dead but are not inserted into `self.free`.

For example, claiming entity index `3` in an allocator with capacity `4` produces logically vacant slots `0`, `1`, and `2`, but `spawn()` sees `generations.len() == capacity` and returns `None`.

```rust
let mut entities = EntityAllocator::with_capacity(4);

let external = Entity::from_parts(3, 0).unwrap();
assert!(entities.claim(external));

// Three entity slots are still unused.
assert_eq!(entities.len(), 1);

// Currently returns None.
assert!(entities.spawn().is_some());
```

## Why this matters

The worker bridge can claim externally generated entity IDs. A single non-contiguous claim can therefore make most of the configured entity capacity permanently unreachable by normal `spawn()` calls.

The allocator can report capacity exhaustion even though several entity slots are unused.

## Scope

- make intermediate vacant slots created by `claim()` available to subsequent `spawn()` calls;
- preserve generation values and free-list consistency;
- add coverage for sparse/non-contiguous external claims;
- preserve the configured hard entity capacity.

## Non-goals

- requiring externally allocated entity IDs to be contiguous;
- redesigning the worker bridge;
- changing the packed entity representation.

## Acceptance criteria

- claiming index `N` does not make unused indices below `N` unavailable;
- `spawn()` can consume all genuinely vacant slots after a high-index claim;
- no slot can simultaneously be live and present in the free list;
- allocator capacity is exhausted only when all representable configured slots are live;
- deterministic regression tests cover high-index claims;
- formatting, lint, and tests pass.

---

# 3. `[Bug] SparseSet can retain orphaned components when the same index is inserted with a new generation`

## Evidence

`SparseSet::insert()` determines replacement through `dense_index(entity)`, which requires both entity index and generation to match.

If a component already exists for `(index=0, generation=0)` and `(index=0, generation=1)` is inserted without removing the old entry first, `dense_index()` returns `None` and a second dense entry is appended.

The sparse lookup is then overwritten to point at the new entry:

```text
dense[0] = Entity(index=0, generation=0)  // orphaned
dense[1] = Entity(index=0, generation=1)

sparse[0] = 1
```

The old dense entry remains in `entities` and `values`, contributes to `len()`, and appears during iteration, but can no longer be retrieved through normal sparse lookup.

## Why this matters

This breaks the central sparse-set invariant that one sparse entity index maps to at most one dense component.

Repeated generation replacement can leak logical component capacity without allocating memory, eventually causing `ComponentCapacity` errors even though some dense entries are unreachable.

Systems iterating dense storage can also process stale components.

## Scope

- enforce one dense component per entity index;
- define how insertion of a newer generation replaces or rejects an existing older-generation entry;
- repair sparse indices without leaving unreachable dense entries;
- add generation-replacement regression tests.

## Non-goals

- replacing the sparse-set ECS architecture;
- changing entity generation semantics globally;
- preserving dense iteration order during replacement/removal.

## Acceptance criteria

- two generations of the same entity index cannot coexist in dense storage;
- `len()` reflects the number of reachable components;
- iteration never exposes an orphaned stale-generation component;
- replacing/rejecting a generation conflict has explicitly tested semantics;
- existing `swap_remove` behavior remains correct;
- formatting, lint, and tests pass.

---

# 4. `[Bug] Entity generation wrap can revive stale handles and allocate Entity::INVALID`

## Evidence

Entity IDs dedicate 12 bits to generation:

```rust
const MAX_GENERATION: u16 = (1 << (32 - INDEX_BITS)) - 1;
```

`despawn()` wraps the generation with:

```rust
self.generations[index] =
    (self.generations[index] + 1) & MAX_GENERATION;
```

After 4096 recycling cycles, the generation returns to its original value. A sufficiently old stale entity handle can therefore become valid again.

There is also a collision with the sentinel:

```rust
pub const INVALID: Self = Self(u32::MAX);
```

The maximum legal entity index combined with generation `4095` also packs to `u32::MAX`, despite the documentation stating that `INVALID` is never allocated.

## Why this matters

Generational IDs exist specifically to prevent stale references from becoming valid after slot reuse. Silent generation wrap violates that guarantee.

Returning `Entity::INVALID` as a valid live allocation also makes sentinel-based checks ambiguous and can propagate an invalid-looking ID across the WASM/worker transport boundary.

## Scope

- prevent generation rollover from silently reviving stale handles;
- guarantee that `EntityAllocator` never returns `Entity::INVALID`;
- define explicit behavior when an entity slot exhausts its available generations;
- add tests around maximum index and generation boundaries.

## Non-goals

- necessarily changing Entity from its current 32-bit representation;
- changing transport serialization unless required by the chosen fix;
- increasing general world capacity.

## Acceptance criteria

- `EntityAllocator` never allocates `Entity::INVALID`;
- a stale handle cannot become valid because of silent generation rollover within the supported allocator lifecycle;
- generation exhaustion has deterministic documented behavior;
- boundary tests cover generation `MAX_GENERATION` and maximum entity index;
- formatting, lint, and tests pass.

---

# 5. `[Bug] Implicit unit-cube bounds can incorrectly cull arbitrary geometry`

## Evidence

`World::add_mesh_renderer()` automatically inserts:

```rust
Bounds::default()
```

when the entity has no bounds component.

`Bounds::default()` is `Bounds::UNIT_CUBE`, with radius approximately `0.866`:

```rust
pub const UNIT_CUBE: Self = Self {
    center: Vec3::new([0.0, 0.0, 0.0]),
    radius: 0.866_025_4,
};
```

However, `MeshRenderer::geometry` is an application-defined geometry ID and carries no guarantee that the corresponding geometry is a unit cube.

`RenderWorld::extract()` additionally uses:

```rust
world.bounds().get(entity).copied().unwrap_or_default()
```

so removing an entity's bounds does not actually produce an unbounded mesh; extraction silently restores unit-cube semantics.

## Why this matters

A mesh larger than the implicit unit cube can be classified as outside the camera frustum even while part of the actual geometry is visible.

This causes correctness failures such as meshes disappearing or popping at screen edges.

The fallback also makes `remove_component(entity, 5)` semantically surprising because the mesh continues to be culled using fabricated bounds.

## Scope

- remove unsafe assumptions that arbitrary geometry fits inside `UNIT_CUBE`;
- define explicit behavior for meshes without known bounds;
- ensure absence of bounds cannot cause false-negative visibility;
- define meaningful bounds-removal semantics;
- add visibility tests using geometry whose true extent exceeds the current default sphere.

## Non-goals

- implementing mesh asset loading;
- calculating geometry bounds inside the renderer;
- replacing sphere-frustum culling with another culling algorithm.

## Acceptance criteria

- a missing bounds component cannot cause visible geometry to be incorrectly culled;
- adding a mesh renderer does not silently assign incorrect geometry-specific bounds;
- bounds removal has explicit and tested semantics;
- explicitly supplied valid bounds continue to participate in frustum culling;
- formatting, lint, and tests pass.

---

# 6. `[Bug] Non-finite camera and transform values can poison projection and frustum calculations`

## Evidence

Camera parameters are public and `World::add_camera()` performs no validation.

`perspective()` only uses:

```rust
debug_assert!(aspect > 0.0 && near > 0.0 && far > near);
```

which disappears in release builds and does not validate `vertical_fov`.

`World::set_camera_aspect()` checks only:

```rust
if aspect <= 0.0 {
    return;
}
```

so `NaN` passes the check.

Transform rotations are also accepted directly by `update_transform_fields()`, while `compose()` and `view_from_transform()` explicitly require normalized quaternions.

Finally, `normalized_plane()` divides by the plane normal length without guarding against zero or non-finite values.

## Why this matters

Invalid numeric input can propagate `NaN` or infinity through projection, view, and frustum matrices.

Comparisons involving `NaN` in `intersects_sphere()` can then reject every object, potentially turning a malformed camera update into an entirely blank frame.

Non-normalized quaternions can also produce incorrect transforms and camera inverses.

## Scope

- validate finite camera projection parameters before matrix generation;
- reject or normalize invalid quaternion input at the appropriate API boundary;
- reject non-finite transform fields;
- guard frustum plane normalization against degenerate/non-finite inputs;
- add release-relevant regression tests rather than relying on `debug_assert!`.

## Non-goals

- introducing a new math library;
- changing the engine coordinate system;
- supporting intentionally degenerate projection matrices.

## Acceptance criteria

- `NaN`/infinite camera parameters cannot silently enter the active projection state;
- invalid near/far/aspect/FOV combinations are rejected deterministically;
- quaternion normalization requirements are enforced at an API boundary;
- frustum construction cannot silently create non-finite planes from accepted input;
- regression tests cover non-finite and degenerate values;
- formatting, lint, and tests pass.

---

# 7. `[Bug] RenderWorld can permanently cache stale matrices when extract runs before World::update`

## Evidence

The documented lifecycle is:

```text
World -> update -> RenderWorld::extract
```

but the API does not enforce this ordering.

Transform mutation increments the entity render revision and global render epoch before `world_matrix` is recomputed.

If `RenderWorld::extract()` runs at that point, it stores the old `world_matrix` while also caching the new render revision.

A later `World::update()` recomputes the matrix but does not update `render_epoch` or the entity render revision.

The next extraction therefore observes:

```text
self.source_epoch == world.render_epoch()
```

and skips rebuilding the snapshot, leaving the pre-update matrix cached until another render-visible mutation occurs.

## Why this matters

A single accidental scheduling mistake can produce stale rendering for more than one frame. The snapshot does not automatically recover on the next correctly ordered frame.

This makes an ordering bug significantly harder to diagnose than simply rendering one stale frame.

## Scope

- prevent derived transform/camera recomputation from becoming invisible to render extraction;
- ensure an out-of-order extraction cannot permanently poison cached instance data;
- add a regression test covering mutate → extract → update → extract;
- preserve incremental extraction where possible.

## Non-goals

- redesigning the whole engine scheduler;
- removing `RenderWorld` caching;
- requiring every system update to rebuild every GPU instance.

## Acceptance criteria

- after `World::update()` computes a new world matrix, a subsequent extraction can observe it even if an extraction occurred before the update;
- dirty-slot reporting remains correct;
- correctly ordered `update → extract` behavior is unchanged;
- a deterministic regression test covers the out-of-order sequence;
- formatting, lint, and tests pass.

---

# 8. `[Bug] Public camera storage bypasses World liveness and mutation invariants`

## Evidence

Unlike the other component stores, `World::cameras` is public:

```rust
pub cameras: SparseSet<Camera>,
```

A caller can therefore insert a camera directly:

```rust
world.cameras.insert(entity, Camera::default());
```

without going through `World::add_camera()` and without proving that the entity is alive.

`RenderWorld::extract()` directly iterates:

```rust
for (entity, camera) in world.cameras.iter()
```

and does not independently validate entity liveness.

As a result, a dead or never-allocated entity can participate in camera extraction.

## Why this matters

`World` is intended to own canonical ECS state and enforce entity/component invariants. Exposing one mutable component store publicly creates a bypass around those guarantees.

It also makes future camera dirtiness or validation changes difficult to enforce consistently.

## Scope

- make mutable camera storage private to `World`;
- expose immutable camera queries where required;
- route camera mutation through invariant-preserving `World` APIs;
- reject components attached to non-live entities;
- add tests covering stale/dead camera entities.

## Non-goals

- hiding all immutable ECS query APIs;
- redesigning `SparseSet`;
- changing camera GPU layout.

## Acceptance criteria

- external callers cannot insert/remove/mutate camera components without passing through the intended World API;
- extracted cameras always belong to generation-valid live entities;
- current allocation-free read/query use cases remain available;
- regression tests cover dead/stale camera handles;
- formatting, lint, and tests pass.

---

# 9. `[Design] Make visibility camera selection explicit instead of relying on first SparseSet entry`

## Evidence

`World` and `RenderWorld` support multiple cameras, but `VisibleRenderBuffer::cull()` selects the visibility camera with:

```rust
let frustum = render_world
    .cameras()
    .first()
    .map(Frustum::from_camera);
```

Camera storage is backed by `SparseSet`, whose dense order is explicitly not stable because removal uses `swap_remove`.

There is currently no active-camera identifier or explicit camera argument supplied to visibility.

## Why this matters

In a multi-camera scene, culling behavior depends on internal component storage order rather than explicit application intent.

Removing or reinserting a camera can change which remaining camera becomes `first()`, potentially changing the visible set without any explicit active-camera change.

This becomes especially problematic for editor cameras, shadow cameras, minimaps, or future multi-view rendering.

## Scope

- make the camera used for visibility explicit;
- avoid using dense ECS storage order as application-visible camera priority;
- add tests with multiple cameras and removal/reordering;
- preserve the no-camera behavior where all instances are considered visible, unless intentionally changed.

## Non-goals

- implementing full multi-camera rendering;
- implementing multi-view or stereo rendering;
- changing camera matrix representation.

## Acceptance criteria

- the caller can deterministically identify which camera drives visibility;
- sparse-set insertion/removal order cannot silently change the active visibility camera;
- multi-camera regression tests cover deterministic selection;
- single-camera behavior remains equivalent;
- formatting, lint, and tests pass.

---

# 10. `[Design] VisibleRenderBuffer has no dirty signal for geometry/material/pipeline-only changes`

## Evidence

`VisibleRenderBuffer` emits four grouped renderer-facing arrays:

```text
geometries
pipelines
materials
slots
```

but change detection compares only:

```rust
self.slots != self.previous_slots
```

to produce `slots_dirty`.

For example, an instance can remain in the same persistent slot while changing geometry:

```text
before: slot=5, geometry=10
after:  slot=5, geometry=20
```

With a single visible instance, the slot list remains `[5]`, so `slots_dirty()` remains false even though `geometries()` changed.

The same applies to material or pipeline metadata when grouping does not alter final slot order.

## Why this matters

There is no visibility-buffer-level signal indicating that grouped renderer metadata changed while slot membership/order remained identical.

A downstream consumer performing incremental uploads based on visibility dirtiness can therefore retain stale geometry/material/pipeline data unless it separately understands `RenderWorld` snapshot semantics.

## Scope

- define dirty semantics for the complete renderer-facing visible output;
- either broaden the existing dirty state or add explicit metadata/grouping dirtiness;
- test geometry-, material-, and pipeline-only changes with unchanged slots;
- document which buffers must be refreshed for each dirty condition.

## Non-goals

- changing the grouping key;
- changing persistent GPU instance slots;
- forcing unconditional uploads every frame.

## Acceptance criteria

- downstream code can determine when any grouped visible metadata buffer changed;
- geometry/material/pipeline-only changes are detectable even when `slots()` is unchanged;
- unchanged frames still report no unnecessary metadata changes;
- regression tests cover each grouped metadata field;
- formatting, lint, and tests pass.

---

# 11. `[Bug] RenderWorld entity_capacity is documented as instance count but also limits entity index`

## Evidence

`RenderWorld::entity_capacity()` is documented as:

> Returns the maximum number of renderable instances.

However extraction rejects an instance when either:

```rust
self.entities.len() == self.entity_capacity
```

or:

```rust
slot >= self.entity_capacity
```

where:

```rust
let slot = entity.index();
```

Therefore a `RenderWorld` with capacity `10` cannot extract a single renderable entity whose index is `100`, even though the number of renderable instances is only one.

## Why this matters

The public capacity contract does not match actual storage semantics.

This is especially relevant because external entity claiming allows valid entity IDs to be sparse or high-indexed. A caller can configure enough capacity for the number of renderables and still receive `InstanceCapacity`.

The resulting error also reports the failure as instance-count exhaustion, which is misleading.

## Scope

- align `RenderWorld` capacity semantics, implementation, and documentation;
- explicitly separate persistent entity-slot capacity from extracted instance-count capacity if both are required;
- improve the extraction error so the failed constraint is identifiable;
- add sparse/high-index entity tests.

## Non-goals

- removing persistent entity-indexed GPU slots;
- changing packed Entity IDs;
- introducing dynamically growing per-frame storage.

## Acceptance criteria

- capacity names and documentation accurately describe the constraints they enforce;
- sparse/high entity indices have deterministic supported behavior;
- capacity errors distinguish slot-index exhaustion from extracted-instance exhaustion when relevant;
- regression tests cover one high-index renderable and multiple low-index renderables;
- formatting, lint, and tests pass.

---

# 12. `[Bug] Entity capacity clamping is not applied consistently to backing allocations`

## Evidence

`EntityAllocator::with_capacity()` clamps the logical allocator capacity:

```rust
capacity: capacity.min((INDEX_MASK as usize) + 1),
```

but its backing vectors reserve using the original unbounded argument:

```rust
generations: Vec::with_capacity(capacity),
alive: Vec::with_capacity(capacity),
free: Vec::with_capacity(capacity),
```

`World::with_capacity()` also uses the original `capacity.entities` for:

```rust
render_revisions: vec![0; capacity.entities]
```

and for each component sparse lookup.

Entity indices only have 20 bits, so capacities beyond `1 << 20` cannot be addressed by an Entity handle even though the code can allocate memory for them.

## Why this matters

A caller supplying an accidentally huge entity capacity can trigger extremely large or failed allocations for storage that can never be addressed.

The logical entity allocator and the surrounding World storage can also disagree about their effective entity capacity.

## Scope

- validate or clamp entity capacity exactly once at the World/allocator boundary;
- use the effective representable capacity for all entity-indexed storage;
- prevent allocations for unreachable entity indices;
- add boundary tests at and above the 20-bit index limit.

## Non-goals

- increasing the 20-bit entity index width;
- changing individual component-count capacities;
- introducing runtime growth during frames.

## Acceptance criteria

- no entity-indexed backing store allocates beyond the maximum representable entity index capacity;
- `World`, `EntityAllocator`, and `SparseSet` agree on effective entity capacity;
- over-limit configuration has deterministic documented behavior;
- tests cover `MAX_ENTITY_CAPACITY`, `MAX + 1`, and substantially larger requested values;
- formatting, lint, and tests pass.

---

# 13. `[API] Entity::default and MaterialHandle::default produce valid-looking handle zero`

## Evidence

`Entity` derives `Default`:

```rust
#[derive(Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct Entity(u32);
```

so:

```rust
Entity::default().raw() == 0
```

Raw value `0` is also the first normally allocated entity:

```text
index = 0
generation = 0
```

Despite this, the type defines an explicit invalid sentinel:

```rust
pub const INVALID: Self = Self(u32::MAX);
```

`MaterialHandle` similarly derives `Default`, producing raw handle `0`, which can refer to the material owned by entity zero.

## Why this matters

Default-initialized handles can accidentally alias a real object instead of representing absence or invalid state.

This is particularly dangerous in C/WASM-oriented records or temporary state where zero initialization is common.

The existence of `Entity::INVALID` also makes the current `Default` behavior unintuitive.

## Scope

- define explicit default/invalid semantics for entity-backed handles;
- prevent accidental zero-initialized handles from silently referring to entity zero;
- review `MaterialHandle` for the same behavior;
- add tests documenting the chosen default semantics.

## Non-goals

- changing valid entity index zero itself;
- introducing nullable entity storage everywhere;
- redesigning all renderer IDs.

## Acceptance criteria

- the meaning of a default entity/material handle is explicit and safe;
- default initialization cannot silently masquerade as a valid entity-zero reference unless that behavior is intentionally and explicitly documented;
- sentinel/default semantics are internally consistent;
- tests cover raw zero, default values, and invalid values;
- formatting, lint, and tests pass.

---

# 14. `[Bug] World::render_revision can panic for externally constructed out-of-range entities`

## Evidence

`Entity::from_raw()` is a public safe constructor and performs no validation:

```rust
pub const fn from_raw(raw: u32) -> Self
```

`World::render_revision()` is also public and directly indexes:

```rust
pub fn render_revision(&self, entity: Entity) -> u32 {
    self.render_revisions[entity.index()]
}
```

There is no capacity or liveness check before indexing.

A caller can therefore construct an Entity whose index exceeds the world's configured capacity and cause a bounds panic through a safe public API.

## Why this matters

Entity handles can arrive through transport or external worker code, so malformed, stale, or simply foreign-world handles should not be able to crash the core through an unchecked vector index.

The rest of the World API generally rejects invalid entities using boolean/optional results, making this panic inconsistent with surrounding behavior.

## Scope

- make `render_revision()` safe for out-of-capacity entity handles;
- define whether invalid entities return `Option`, a sentinel revision, or remain internal-only;
- audit direct `entity.index()` indexing in public World paths for the same assumption;
- add out-of-capacity regression tests.

## Non-goals

- validating every `Entity::from_raw()` call globally;
- removing raw entity transport;
- changing the revision counter format.

## Acceptance criteria

- a safe public call involving an out-of-capacity entity cannot panic through `render_revision()`;
- internal hot paths retain efficient access where their invariants are already guaranteed;
- malformed/foreign handles have deterministic documented behavior;
- regression tests cover maximum packed index against a small World;
- formatting, lint, and tests pass.

---

# 15. `[Performance] Render dirtiness causes unnecessary full-world transform and material scans`

## Evidence

Several render-dirty paths operate at a broader granularity than the actual change.

`World::for_each_transform_mut()` increments the revision for every visited transform regardless of whether the callback changed it:

```rust
for (entity, transform) in transforms.iter_mut() {
    operation(entity, transform);
    bump_revision(&mut render_revisions[entity.index()]);
}
```

`update_transforms()` then recomputes every transform matrix on every update:

```rust
for transform in transforms.values_mut() {
    compose(...);
}
```

Material mutation additionally searches all mesh renderers to discover users of that material:

```rust
for (mesh_entity, mesh) in self.mesh_renderers.iter() {
    if mesh.material == material {
        bump_revision(&mut self.render_revisions[mesh_entity.index()]);
    }
}
```

Multiple material updates in one frame therefore repeat full mesh scans.

Any render-dirty transform also advances the global `render_epoch`, causing `RenderWorld::extract()` to traverse the complete renderable snapshot again.

## Why this matters

The core is designed for predictable real-time rendering with fixed-capacity, allocation-free frame processing. Broad O(N) scans for small changes undermine that goal as scene size grows.

Updating one object or several materials can result in work proportional to the whole transform/mesh population rather than the number of affected renderables.

## Scope

- introduce finer-grained transform dirtiness so unchanged transforms do not require matrix recomputation/revision updates;
- avoid repeated whole-mesh scans when materials change;
- avoid forcing full snapshot extraction for changes that can be propagated incrementally;
- add workload-oriented tests or benchmarks for sparse mutations in large configured worlds;
- preserve fixed-capacity/no-per-frame-allocation constraints.

## Non-goals

- changing visual/rendering semantics;
- introducing an allocation-heavy reactive ECS;
- optimizing before correctness fixes in the allocator and sparse-set paths;
- redesigning the renderer itself.

## Acceptance criteria

- mutating one transform does not require recomputing every unrelated transform matrix;
- unchanged entities are not marked render-dirty merely because they were visited;
- updating multiple materials does not require one full mesh scan per changed material;
- incremental extraction remains correct for transform, material, geometry, and bounds changes;
- representative sparse-update benchmarks demonstrate reduced work with increasing world size;
- no new per-frame allocations are introduced in steady-state systems;
- formatting, lint, and tests pass.
