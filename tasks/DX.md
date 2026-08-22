# 1. `[DX] Separate ergonomic Rust APIs from transport and ABI APIs`

## Evidence

`World` currently exposes low-level operations such as raw component IDs, field masks, raw arrays, and transport-oriented mutation methods directly alongside normal Rust APIs.

Examples include APIs conceptually equivalent to:

```rust
world.update_transform_fields(entity, mask, values);
world.remove_component(entity, 4);
```

Using these APIs requires knowledge of transport-specific details such as component numeric IDs and transform field-mask bits.

## Why this matters

Transport and ABI concerns are valid implementation requirements, but they should not define the normal developer experience of the Rust crate.

A developer using `core` directly should be guided toward typed, intention-revealing APIs without needing to understand worker protocol details.

## Scope

- separate transport/ABI-oriented APIs from normal ergonomic Rust APIs;
- move raw component IDs, transform masks, raw pointer helpers, and equivalent low-level contracts under a clearly named module such as `abi` or `transport`;
- provide typed high-level mutation APIs on `World`;
- preserve zero-copy/runtime integration requirements.

## Non-goals

- removing raw transport APIs;
- changing the worker protocol in this issue;
- introducing runtime allocations to make APIs ergonomic;
- hiding advanced APIs from internal runtime code.

## Acceptance criteria

- normal Rust usage does not require numeric component IDs or field-mask knowledge;
- transport-specific APIs are clearly isolated and documented;
- runtime can continue using efficient ABI-oriented operations;
- high-level and low-level APIs produce equivalent valid core state;
- examples use the ergonomic API by default;
- formatting, lint, and tests pass.

---

# 2. `[DX] Replace boolean mutation results with structured World errors`

## Evidence

Several important `World` mutation APIs currently return `bool` or similarly low-information values.

A `false` result does not tell the caller whether the entity was dead, stale, out of capacity, missing a dependency, or otherwise invalid.

Other areas of the package already use structured errors such as insertion and extraction errors, so error handling is inconsistent across the public API.

## Why this matters

Developers need actionable failure information to debug scene construction and mutation failures.

Boolean error reporting pushes implementation knowledge onto callers and makes runtime/API error propagation unnecessarily difficult.

## Scope

- introduce a structured `WorldError` or equivalent error hierarchy;
- migrate major mutation APIs from `bool` to `Result`;
- distinguish dead/stale entity, capacity, invalid input, and dependency errors;
- keep error values lightweight and allocation-conscious.

## Non-goals

- returning heap-allocated strings from hot paths;
- turning expected failures into panics;
- defining user-facing localized messages inside `core`.

## Acceptance criteria

- callers can programmatically distinguish major mutation failure categories;
- success paths remain lightweight;
- errors include relevant context such as component kind or configured capacity where useful;
- existing boolean ambiguity is removed from normal public mutation APIs;
- tests cover each major error variant;
- formatting, lint, and tests pass.

---

# 3. `[DX] Eliminate silent rejection of invalid mutation input`

## Evidence

Some mutation paths silently ignore invalid values.

For example, camera aspect mutation can reject an invalid aspect value simply by returning without reporting that the requested operation was not applied.

## Why this matters

Silent failure creates state that differs from developer intent without providing any observable signal.

This is especially difficult to debug when the mutation originates across a runtime or worker boundary.

## Scope

- audit public mutation APIs for silently ignored invalid input;
- return structured errors for rejected mutations;
- preserve previous valid state when validation fails;
- document validation requirements.

## Non-goals

- automatically repairing arbitrary invalid data;
- panicking on normal invalid user input;
- performing logging inside `core`.

## Acceptance criteria

- rejected public mutations always produce an observable failure result;
- failed mutations preserve the previous valid state;
- documentation states relevant numeric/input constraints;
- regression tests cover invalid camera, transform, and bounds values;
- formatting, lint, and tests pass.

---

# 4. `[DX] Make camera mutation APIs explicit about which cameras they affect`

## Evidence

An API named like:

```rust
world.set_camera_aspect(aspect);
```

can currently apply the new aspect ratio to all cameras rather than one explicitly selected camera.

The method name does not communicate that global behavior.

## Why this matters

Developers generally expect a singular `set_camera_*` operation to target one camera.

Implicitly mutating every camera becomes increasingly surprising as multi-camera support grows.

## Scope

- provide entity-specific camera setters;
- rename bulk camera operations so their global scope is explicit;
- validate the target entity and camera component;
- preserve an efficient bulk aspect-update API where runtime resizing needs it.

## Non-goals

- removing bulk camera updates;
- implementing active-camera selection in this issue;
- managing viewport or swap-chain state inside `core`.

## Acceptance criteria

- singular camera setters target one explicit camera;
- bulk setters are named to clearly communicate their scope;
- invalid camera targets return structured errors;
- multi-camera tests demonstrate deterministic behavior;
- formatting, lint, and tests pass.

---

# 5. `[DX] Rename component insertion APIs to match replace-on-insert semantics`

## Evidence

Methods such as `add_transform` are documented or implemented as "add or replace".

The name `add_*` suggests an operation that fails or behaves differently if the component already exists.

## Why this matters

Rust APIs commonly use `insert` for operations that add when absent and replace when present.

Matching established conventions makes behavior discoverable without reading implementation details.

## Scope

- rename add-or-replace component methods to `insert_*` or another explicitly documented convention;
- preserve deprecated compatibility aliases temporarily if needed;
- document whether existing values are replaced;
- align naming consistently across component types.

## Non-goals

- changing actual replacement semantics;
- redesigning component storage;
- introducing generic trait-based insertion.

## Acceptance criteria

- method names accurately communicate replacement behavior;
- all component insertion APIs follow one naming convention;
- documentation contains simple replacement examples;
- migration path is documented if public compatibility matters;
- formatting, lint, and tests pass.

---

# 6. `[DX] Add typed component-specific removal APIs`

## Evidence

Component removal currently supports raw numeric component identifiers, requiring callers to know mappings such as which integer represents `MeshRenderer`, `Bounds`, or `Camera`.

## Why this matters

Magic numbers are difficult to discover, easy to misuse, and provide no compile-time protection.

## Scope

- add methods such as `remove_transform`, `remove_camera`, `remove_bounds`, and `remove_mesh_renderer`;
- add a typed `ComponentKind` for generic removal where needed;
- keep raw component ID conversion at ABI boundaries.

## Non-goals

- removing transport numeric IDs;
- implementing dynamic runtime component registration;
- replacing SparseSet storage.

## Acceptance criteria

- normal Rust callers never need a magic number to remove a component;
- generic removal accepts a typed component identifier;
- invalid transport IDs are rejected at the ABI boundary;
- tests cover every component removal path;
- formatting, lint, and tests pass.

---

# 7. `[DX] Add ergonomic Transform constructors and mutation APIs`

## Evidence

Constructing a `Transform` currently exposes fields that include canonical values, padding, and derived state.

Developers should not need to manually populate layout details to express common operations such as translation, rotation, and scale.

## Why this matters

Transforms are one of the most frequently used core types.

A concise and intention-revealing transform API significantly improves the day-to-day experience of using the crate.

## Scope

- add constructors such as `Transform::identity`, `from_translation`, and `from_trs`;
- add fluent or setter APIs for position, rotation, and scale;
- keep derived state synchronized through `World`;
- expose useful constants where appropriate.

## Non-goals

- implementing hierarchy in this issue;
- implementing animation;
- hiding read-only transform state required by inspection tools.

## Acceptance criteria

- common transforms can be created without struct literals;
- developers never need to initialize padding fields;
- transform mutation APIs correctly participate in dirty tracking;
- examples cover identity, translation, rotation, and scale;
- formatting, lint, and tests pass.

---

# 8. `[Safety/DX] Hide ABI padding fields from normal component construction`

## Evidence

Public component structures expose fields whose only purpose is alignment or ABI layout, such as `_padding`, `_position_padding`, or `_scale_padding`.

Documentation may require callers to keep those fields at specific values.

## Why this matters

Padding is an implementation detail.

Requiring developers to understand or initialize it makes the public API noisy and creates unnecessary opportunities for invalid states.

## Scope

- make padding fields private where layout permits;
- provide constructors that initialize layout details internally;
- preserve required `repr(C)` and ABI layout;
- expose layout metadata through ABI-specific APIs instead.

## Non-goals

- changing the established binary layout without versioning;
- removing padding required for GPU/WASM compatibility;
- hiding actual domain data.

## Acceptance criteria

- normal component construction never requires specifying padding;
- ABI layout remains unchanged or is explicitly versioned;
- layout tests verify size/alignment;
- public documentation treats padding as an implementation detail;
- formatting, lint, and tests pass.

---

# 9. `[Safety/DX] Make derived transform and camera matrices read-only`

## Evidence

Fields such as world, view, and projection matrices represent derived engine state but can currently be publicly mutated alongside canonical input values.

A caller can therefore create states where local transform or camera parameters disagree with their derived matrices.

## Why this matters

Developers should immediately understand which fields they own and which values are computed by the engine.

Writable derived state also undermines dirty tracking and makes debugging state mismatches difficult.

## Scope

- make derived matrices privately mutable;
- expose read-only getters;
- keep canonical transform/camera parameters editable through controlled APIs;
- recompute derived values through core update paths.

## Non-goals

- preventing renderer/runtime code from reading derived matrices;
- changing matrix formats;
- moving derived matrices into `renderer`.

## Acceptance criteria

- safe external APIs cannot create contradictory canonical and derived state;
- derived matrices remain cheaply readable;
- canonical mutations correctly invalidate derived state;
- tests verify recomputation after each relevant mutation;
- formatting, lint, and tests pass.

---

# 10. `[DX] Improve math type construction, constants, and conversions`

## Evidence

Common vector creation currently favors array-style construction such as:

```rust
Vec3::new([1.0, 2.0, 3.0])
```

Common constants and ergonomic conversion helpers are limited.

## Why this matters

Math types appear throughout nearly every core call site.

Small usability improvements compound significantly across scene and engine code.

## Scope

- provide ergonomic scalar constructors where compatible;
- add constants such as `ZERO`, `ONE`, and `IDENTITY`;
- add useful `From<[f32; N]>` and inverse conversions;
- preserve packed and ABI-friendly representation.

## Non-goals

- replacing the math module with a third-party crate;
- adding every possible vector operation;
- changing coordinate-system conventions.

## Acceptance criteria

- common vector/quaternion construction is concise;
- common identity/zero values have named constants;
- array conversion is explicit and ergonomic;
- layout and performance characteristics remain unchanged;
- formatting, lint, and tests pass.

---

# 11. `[DX] Add named component accessors to vector and quaternion types`

## Evidence

Inspecting individual coordinates currently requires accessing internal arrays or numeric indexes.

## Why this matters

Named coordinate access is substantially more readable in camera, transform, culling, and debugging code.

## Scope

- expose `x`, `y`, `z`, and `w` accessors where applicable;
- provide mutation support only where consistent with type invariants;
- retain array access for ABI/math loops.

## Non-goals

- changing internal storage layout;
- introducing dynamically named swizzles;
- implementing a complete SIMD vector API.

## Acceptance criteria

- vector and quaternion components can be read through named APIs;
- array conversion remains available;
- no additional allocation or storage overhead is introduced;
- documentation shows both ergonomic and raw representations;
- formatting, lint, and tests pass.

---

# 12. `[DX] Add first-class material creation APIs returning MaterialHandle`

## Evidence

Material creation exposes the implementation detail that materials are tied to entities and requires callers to manually construct the appropriate entity/handle relationship.

## Why this matters

A developer conceptually wants to create a material and receive a material handle.

The internal storage mechanism should not dominate the public workflow.

## Scope

- add `World::create_material` or equivalent;
- return a valid `MaterialHandle` directly;
- validate material capacity and input;
- keep entity-backed storage internal or advanced.

## Non-goals

- moving GPU material storage into `core`;
- implementing PBR;
- changing renderer material resource ownership.

## Acceptance criteria

- creating a material requires one intention-revealing call;
- normal callers do not need to manually convert an Entity to MaterialHandle;
- capacity failures return structured errors;
- material lifecycle remains compatible with renderer extraction;
- formatting, lint, and tests pass.

---

# 13. `[DX] Add constructors for MeshRenderer, Bounds, Material, and Camera`

## Evidence

Several core component types require struct literals for common creation paths.

This exposes internal fields and makes common code unnecessarily verbose.

## Why this matters

High-frequency domain types benefit from constructors that communicate intent and validate state at the creation boundary.

## Scope

- add `MeshRenderer::new(geometry, material)`;
- add bounds constructors such as `Bounds::sphere`;
- add material constructors with sensible defaults;
- add `Camera::perspective` and future-friendly projection constructors;
- validate constructor input.

## Non-goals

- adding complex builder frameworks;
- moving geometry or GPU resource ownership into components;
- implementing orthographic cameras unless already planned separately.

## Acceptance criteria

- common component construction does not require struct literals;
- constructors prevent invalid obvious states;
- default behavior remains documented;
- ABI/layout internals remain hidden;
- formatting, lint, and tests pass.

---

# 14. `[DX] Add direct component lookup helpers on World`

## Evidence

Reading a component currently often requires navigating through the corresponding SparseSet:

```rust
world.transforms().get(entity)
```

The storage implementation becomes visible in common call sites.

## Why this matters

High-level World APIs should answer common questions directly while leaving SparseSet access available to advanced internal code.

## Scope

- add methods such as `transform(entity)`, `camera(entity)`, `bounds(entity)`, and `mesh_renderer(entity)`;
- expose material lookup by handle;
- return predictable `Option`/`Result` values;
- preserve efficient immutable access.

## Non-goals

- exposing arbitrary mutable SparseSet access;
- replacing focused iterator APIs;
- creating dynamic reflection.

## Acceptance criteria

- common component lookup requires one intention-revealing method call;
- lookup validates generation/liveness where appropriate;
- lookups allocate no memory;
- SparseSet internals remain available only where intentionally exposed;
- formatting, lint, and tests pass.

---

# 15. `[DX] Add zero-allocation typed iterators over RenderWorld`

## Evidence

`RenderWorld` stores renderer-facing metadata in parallel arrays such as entities, geometry IDs, material IDs, slots, bounds, and instance data.

Developers inspecting one renderable must manually use the same index across several slices.

## Why this matters

Parallel arrays are an efficient storage implementation but are error-prone as a public inspection API.

A typed view can improve ergonomics without changing storage.

## Scope

- add an allocation-free `RenderWorld::iter()` or `renderables()` iterator;
- yield a lightweight `RenderableRef`;
- expose entity, slot, geometry, material, pipeline, and bounds through typed accessors;
- retain raw slices for runtime/ABI consumers.

## Non-goals

- replacing the parallel-array storage layout;
- allocating temporary renderable structures;
- hiding raw buffers from ABI code.

## Acceptance criteria

- developers can iterate renderer-facing entries as typed logical records;
- iterator output maps correctly to existing parallel storage;
- iteration performs no heap allocation;
- raw slice APIs remain available for optimized integration;
- tests verify iterator/storage consistency;
- formatting, lint, and tests pass.

---

# 16. `[DX] Add zero-allocation typed iterators over VisibleRenderBuffer`

## Evidence

Visibility output similarly exposes multiple parallel arrays for geometry, pipeline, material, and slot data.

## Why this matters

A developer debugging or consuming visibility should not need to manually synchronize several same-length slices.

## Scope

- expose an allocation-free visible-item iterator;
- provide a lightweight `VisibleRenderableRef` or equivalent;
- keep raw arrays available for renderer/runtime fast paths.

## Non-goals

- changing grouping or sorting semantics;
- creating owned visible-item objects each frame;
- moving rendering into `core`.

## Acceptance criteria

- visibility output can be inspected through one typed iterator;
- all fields correspond exactly to the existing raw buffers;
- no steady-state allocation is introduced;
- raw slices remain available;
- tests verify typed and raw output equivalence;
- formatting, lint, and tests pass.

---

# 17. `[DX] Replace parallel dirty-range APIs with a typed range iterator`

## Evidence

Dirty ranges are exposed through separate arrays such as starts and counts.

Callers must manually pair the same indexes.

## Why this matters

The logical unit is one dirty range, not two unrelated arrays.

A typed view removes indexing mistakes without changing the ABI representation.

## Scope

- add a `DirtyRange` type or standard `Range<u32>` view;
- expose `dirty_ranges()` iterator;
- retain raw start/count arrays under ABI APIs.

## Non-goals

- changing the underlying dirty-range representation;
- allocating a new Vec of ranges each frame;
- changing dirty-tracking semantics.

## Acceptance criteria

- normal Rust code can iterate dirty ranges as one logical value;
- iteration allocates no memory;
- ABI consumers retain start/count slice access;
- tests verify ranges match raw storage exactly;
- formatting, lint, and tests pass.

---

# 18. `[DX] Move raw pointer and memory-layout access behind an explicit ABI surface`

## Evidence

Raw memory accessors such as capacity pointers appear directly on core renderer-facing types.

These methods are essential for runtime/WASM integration but dominate autocomplete and documentation for normal users.

## Why this matters

Advanced low-level APIs should remain available without making them appear to be the primary way to use the crate.

## Scope

- group raw pointer APIs under `core::abi` or an ABI-specific adapter;
- keep access zero-cost;
- document safety/lifetime rules in one place;
- expose ABI version and layout metadata alongside the raw access surface.

## Non-goals

- removing zero-copy access;
- wrapping every pointer operation in allocations;
- changing existing memory layouts without migration.

## Acceptance criteria

- normal RenderWorld/visibility documentation focuses on logical APIs;
- raw pointer operations remain available through a clearly advanced interface;
- pointer lifetime/layout expectations are documented;
- runtime integration tests continue to pass;
- formatting, lint, and tests pass.

---

# 19. `[DX] Reorganize public crate exports into clear API tiers`

## Evidence

Low-level implementation types such as allocators and SparseSets are exposed alongside everyday domain types at the crate root.

A new developer cannot easily tell which APIs are expected for normal application use and which are advanced internals.

## Why this matters

Module organization is part of API documentation.

Autocomplete should guide developers toward the supported high-level workflow.

## Scope

Organize public APIs into explicit tiers such as:

```text
lume_core
├── common/root domain API
├── render
├── math
├── diagnostics
├── advanced
└── abi
```

Move implementation-oriented utilities under `advanced` where appropriate.

## Non-goals

- making useful low-level types inaccessible;
- breaking module paths without a migration strategy;
- hiding math/render types required by runtime packages.

## Acceptance criteria

- normal entry points are obvious from crate-root documentation and autocomplete;
- advanced storage/allocator utilities are clearly labeled;
- ABI-specific APIs are clearly separated;
- migration aliases are provided where required;
- formatting, lint, and tests pass.

---

# 20. `[DX] Clarify World update naming and lifecycle terminology`

## Evidence

`World::update()` has a broad name while its role is primarily recomputing derived transform and camera state.

Documentation also uses internal phrases such as "Phase 1" that are not inherently meaningful to external developers.

## Why this matters

Developers should be able to predict what a lifecycle method does from its name and documentation.

Internal project terminology makes onboarding unnecessarily difficult.

## Scope

- rename or clearly document `World::update()` according to its actual responsibility;
- remove unexplained internal phase terminology from public docs;
- document exact preconditions/postconditions;
- show how update fits into extraction and visibility.

## Non-goals

- changing frame execution architecture in this issue;
- adding application simulation systems to World update;
- moving lifecycle orchestration into core.

## Acceptance criteria

- public documentation explains update behavior without internal terminology;
- developers can identify when update must be called;
- examples show correct lifecycle ordering;
- stale derived-state risks are documented;
- formatting, lint, and documentation tests pass.

---

# 21. `[DX] Add a compile-tested core Quick Start`

## Evidence

The current README explains the architecture at a high level but does not provide a complete minimal workflow for creating a world, adding renderables/cameras, updating state, extracting a render snapshot, and running visibility.

## Why this matters

A new developer should be able to get from zero context to a valid frame-preparation flow by copying one short example.

## Scope

- add a minimal complete Quick Start;
- cover World creation, Entity spawning, Transform, MeshRenderer, Material, Camera, update, extraction, and visibility;
- make the example compile-tested;
- keep renderer/WebGPU setup outside the core Quick Start.

## Non-goals

- documenting the whole monorepo in core README;
- adding WebGPU renderer setup;
- providing a production game architecture tutorial.

## Acceptance criteria

- the Quick Start compiles in CI;
- it demonstrates the canonical core lifecycle;
- it uses only ergonomic public APIs;
- no magic component IDs or ABI details appear in the introductory example;
- documentation clearly links to advanced/ABI material;
- formatting and doc tests pass.

---

# 22. `[DX] Expand crate-level Rustdoc with architecture and ownership boundaries`

## Evidence

The crate contains several distinct concepts—World, derived updates, RenderWorld extraction, visibility, and renderer-facing output—but root-level documentation provides limited guidance about how they relate.

## Why this matters

Core packages are easiest to use when ownership and data flow are explicit.

Developers also need to know which responsibilities intentionally belong to `renderer`, `runtime`, or `scene`.

## Scope

- add a crate-level architecture diagram;
- document the canonical data flow;
- document what `core` owns;
- document what `core` intentionally does not own;
- link to major public types and Quick Start.

## Non-goals

- duplicating detailed API docs for every method;
- documenting renderer internals in core;
- turning Rustdoc into a monorepo architecture book.

## Acceptance criteria

- crate-root docs explain World → update → extraction → visibility flow;
- ownership boundaries are explicit;
- WebGPU resources, shaders, textures, and render passes are explicitly identified as outside core;
- major public types are linked;
- documentation examples compile;
- formatting and docs checks pass.

---

# 23. `[DX] Add ergonomic WorldCapacity builders and validation`

## Evidence

Configuring `WorldCapacity` requires specifying several numeric fields through a struct literal.

There is limited guidance about valid relationships or representable maxima.

## Why this matters

Capacity configuration is an important part of a fixed-capacity engine and should be easy to discover, customize, and validate.

## Scope

- add fluent helpers such as `with_entities`, `with_materials`, and similar;
- validate representable limits;
- expose defaults clearly;
- return structured configuration errors when needed.

## Non-goals

- dynamically resizing World during frame execution;
- auto-tuning capacities from runtime scene usage;
- hiding fixed-capacity semantics.

## Acceptance criteria

- common capacity customization is concise;
- invalid/unrepresentable capacity requests are rejected clearly;
- defaults are documented;
- builder methods preserve unspecified default values;
- formatting, lint, and tests pass.

---

# 24. `[DX] Implement World::default using default capacity`

## Evidence

`WorldCapacity` has a default configuration, but constructing a default World requires explicitly passing it through `World::with_capacity`.

## Why this matters

The natural Rust expectation is that a type with a clearly defined default configuration can be created through `Default`.

## Scope

- implement `Default` for `World`;
- use the canonical `WorldCapacity::default()`;
- document the intended use of default capacity.

## Non-goals

- changing current default capacity values;
- making default capacity dynamically environment-dependent.

## Acceptance criteria

- `World::default()` produces the same logical configuration as `World::with_capacity(WorldCapacity::default())`;
- documentation shows `World::default()` in simple examples;
- no hidden runtime allocation beyond normal construction behavior is introduced;
- formatting, lint, and tests pass.

---

# 25. `[DX] Derive RenderWorld and visibility capacities from World configuration`

## Evidence

Developers currently need to configure compatible capacities separately for `World`, `RenderWorld`, and visibility buffers.

This duplicates information and makes mismatched capacity configuration easy.

## Why this matters

Capacity values that can be inferred should not need to be repeated by every caller.

## Scope

- add constructors such as `RenderWorld::for_world` or `from_capacity`;
- add visibility-buffer constructors based on RenderWorld/core capacity;
- document any capacity that cannot be inferred automatically;
- preserve explicit constructors for advanced tuning.

## Non-goals

- dynamically resizing buffers during frame processing;
- hiding fixed capacities;
- coupling core to renderer GPU buffer capacity.

## Acceptance criteria

- normal setup does not require manually duplicating compatible capacity values;
- automatically derived capacities are sufficient for the documented default workflow;
- advanced explicit-capacity constructors remain available;
- tests cover derived and customized configurations;
- formatting, lint, and tests pass.

---

# 26. `[DX] Make MaterialHandle opaque in normal APIs`

## Evidence

Material handles expose conversions to and from entity identities, leaking the internal relationship between material storage and ECS entities.

## Why this matters

Developers should be able to treat a material handle as a material identity without caring how it is represented internally.

This also preserves freedom to change material storage later.

## Scope

- make normal material lifecycle APIs operate directly on `MaterialHandle`;
- move entity conversion APIs to advanced/internal surfaces where possible;
- document handle validity/lifetime;
- keep compact ABI representation.

## Non-goals

- changing material rendering semantics;
- implementing GPU material storage;
- replacing all handles with UUIDs.

## Acceptance criteria

- normal material creation and lookup never require Entity conversion;
- internal/runtime code can still access raw representation where required;
- MaterialHandle remains lightweight and copyable;
- material storage can evolve without changing normal call sites;
- formatting, lint, and tests pass.

---

# 27. `[DX] Isolate raw Entity construction from normal usage`

## Evidence

`Entity::from_raw()` allows any packed entity identity to be created without validating it against a World.

This is necessary for ABI/transport use but is easy to misuse in normal application code.

## Why this matters

Most developers should receive entities from `World::spawn()` and treat them as opaque handles.

Raw construction should look intentionally low-level.

## Scope

- move raw entity conversion toward the ABI/advanced surface;
- clearly document that raw construction does not establish liveness;
- provide explicit validated World lookup where useful;
- preserve compact raw serialization.

## Non-goals

- removing raw entity transport;
- making `Entity` heap allocated;
- globally validating every raw handle at construction time.

## Acceptance criteria

- normal docs/examples never require `Entity::from_raw`;
- raw conversion is clearly marked as transport/advanced functionality;
- World APIs validate raw-origin handles before state mutation;
- documentation explains identity versus liveness;
- formatting, lint, and tests pass.

---

# 28. `[DX] Define safe and explicit Default semantics for handle types`

## Evidence

Some handle types derive `Default`, producing raw zero, while separate invalid sentinels also exist.

This makes it unclear whether a default handle means "invalid", "uninitialized", or a potentially valid identity.

## Why this matters

Handle semantics should be obvious, particularly in zero-initialized memory and FFI/WASM-facing structures.

## Scope

- audit `Entity`, `MaterialHandle`, and other identifier types;
- either remove `Default` or make its semantics intentionally safe;
- document invalid/uninitialized representation;
- add raw/default/sentinel tests.

## Non-goals

- making entity index zero invalid unless necessary;
- introducing `Option` into every packed ABI record;
- changing handle size without a separate ABI decision.

## Acceptance criteria

- each handle type has one clearly documented default/invalid policy;
- default initialization cannot silently masquerade as an unrelated valid handle;
- ABI behavior is explicitly tested;
- formatting, lint, and tests pass.

---

# 29. `[DX] Add contextual structured error details`

## Evidence

Even structured errors can be difficult to diagnose if they only report broad categories such as `ComponentCapacity`.

Useful contextual information is often already known at the failure point.

## Why this matters

An error like:

```text
Transform component capacity exceeded: 4096
```

is much more actionable than:

```text
ComponentCapacity
```

without requiring core to allocate formatted strings.

## Scope

- include typed context in error variants;
- include component kind, capacity, entity, or invalid parameter where appropriate;
- implement useful `Display`;
- preserve lightweight enum storage.

## Non-goals

- collecting stack traces inside `core`;
- allocating detailed diagnostic strings on successful paths;
- exposing internal implementation details unnecessarily.

## Acceptance criteria

- major public errors contain enough structured context to diagnose common failures;
- `Display` produces actionable developer-oriented messages;
- callers can still pattern-match error categories;
- success-path performance is unaffected;
- formatting, lint, and tests pass.

---

# 30. `[DX] Add lightweight World inspection and component-presence helpers`

## Evidence

Debugging entity state currently requires manually checking several component stores.

## Why this matters

Data-oriented ECS systems can be difficult to inspect, and simple query helpers significantly improve debugging without altering performance-sensitive storage.

## Scope

- add helpers such as `has_transform`, `has_camera`, `has_bounds`, and `has_mesh_renderer`;
- expose entity liveness checks clearly;
- optionally provide a lightweight structured entity description for debug tooling;
- keep release-path inspection allocation-conscious.

## Non-goals

- implementing reflection over arbitrary components;
- storing developer-facing debug strings per entity;
- building editor UI.

## Acceptance criteria

- developers can quickly inspect whether an entity contains major core components;
- stale/dead entities produce clear results;
- common helpers allocate no memory;
- tests cover live, stale, and partially configured entities;
- formatting, lint, and tests pass.

---

# 31. `[DX] Add first-class renderability diagnostics`

## Evidence

Whether an entity reaches render extraction depends on several component and handle requirements.

Developers currently have to infer these prerequisites from extraction logic.

## Why this matters

"Why is my object not rendering?" is one of the most common engine-development questions.

Core should be able to answer whether an entity is structurally renderable before GPU rendering is involved.

## Scope

- add `World::is_renderable(entity)`;
- add a detailed `renderability(entity)` result;
- report reasons such as missing transform, mesh renderer, material, or invalid bounds/material reference;
- keep the query read-only.

## Non-goals

- checking WebGPU resource readiness;
- checking camera visibility;
- replacing extraction validation.

## Acceptance criteria

- developers can determine whether an entity is structurally ready for extraction;
- non-renderability reasons are typed and deterministic;
- query does not allocate;
- tests cover every documented state;
- formatting, lint, and tests pass.

---

# 32. `[DX] Add debug-friendly RenderWorld inspection`

## Evidence

Developers debugging extraction currently need to manually inspect multiple raw buffers.

Even with typed iterators, a convenient logical debug representation is useful in tests and interactive inspection.

## Why this matters

Renderer-facing snapshots are easier to understand when they can be viewed in terms of logical renderables rather than memory layout.

## Scope

- implement useful `Debug` support for typed RenderWorld references;
- add focused inspection helpers where useful;
- ensure debug formatting is opt-in and not executed in frame hot paths.

## Non-goals

- serializing full snapshots every frame;
- adding runtime logging;
- replacing raw memory inspection tools.

## Acceptance criteria

- `Debug` output identifies entity, geometry, material, slot, and relevant bounds/state;
- no normal-frame overhead is introduced;
- tests/examples demonstrate snapshot inspection;
- formatting, lint, and tests pass.

---

# 33. `[DX] Add compile-tested Rustdoc examples to major public types`

## Evidence

Major public types have documentation, but the most important usage patterns are not consistently demonstrated through executable examples.

## Why this matters

Rustdoc examples provide documentation, onboarding guidance, and API regression tests simultaneously.

## Scope

Add concise examples for at least:

- `World`;
- `Transform`;
- `Camera`;
- `MeshRenderer`;
- `Bounds`;
- material creation;
- `RenderWorld`;
- `VisibleRenderBuffer`.

## Non-goals

- embedding full applications in Rustdoc;
- duplicating the entire README;
- adding renderer/WebGPU examples to core types.

## Acceptance criteria

- major public types have at least one representative example where useful;
- examples compile under `cargo test --doc`;
- examples use recommended ergonomic APIs rather than ABI internals;
- formatting and doc tests pass.

---

# 34. `[Quality/DX] Warn on undocumented public APIs`

## Evidence

The crate already contains meaningful Rustdoc, but future public additions can silently ship without documentation.

## Why this matters

Documentation quality tends to degrade unless it is mechanically protected.

For a low-level core package, undocumented APIs impose significant onboarding cost.

## Scope

- enable `#![warn(missing_docs)]` or an equivalent package-level policy;
- document currently exposed public items sufficiently to keep CI useful;
- allow targeted exceptions only where justified.

## Non-goals

- immediately making every missing doc a hard compile error;
- documenting private implementation details;
- adding meaningless filler documentation.

## Acceptance criteria

- new undocumented public APIs produce CI/compiler feedback;
- major existing public items have useful documentation;
- intentional exceptions are explicit;
- formatting, lint, and docs checks pass.

---

# 35. `[DX] Add a curated core prelude`

## Evidence

Normal `core` usage requires importing several commonly used types, while low-level implementation types are also broadly exposed.

## Why this matters

A small prelude gives application and test code a discoverable default vocabulary while communicating which types are considered everyday APIs.

## Scope

- add `lume_core::prelude`;
- include only frequently used domain types such as World, Entity, Transform, Camera, MeshRenderer, Bounds, and common math types;
- exclude raw ABI and advanced storage utilities.

## Non-goals

- glob-exporting every public type;
- forcing users to use the prelude;
- hiding explicit module imports.

## Acceptance criteria

- common core examples can use `use lume_core::prelude::*`;
- advanced types are not included;
- prelude contents are intentionally documented and stable;
- formatting, lint, and tests pass.

---

# 36. `[Architecture/DX] Formalize public API tiers: common, render, diagnostics, advanced, and ABI`

## Evidence

Core serves several distinct audiences:

- normal scene/core developers;
- renderer integration;
- diagnostics/tooling;
- advanced ECS/internal development;
- runtime/WASM ABI integration.

These audiences currently interact with overlapping public surfaces.

## Why this matters

Explicit API tiers make the crate easier to learn and preserve freedom to evolve internal/advanced APIs without confusing normal users.

## Scope

Establish and document modules resembling:

```text
lume_core
├── common/root
├── render
├── math
├── diagnostics
├── advanced
└── abi
```

Classify current exports accordingly.

## Non-goals

- creating artificial wrapper layers with runtime cost;
- making advanced functionality inaccessible;
- moving renderer implementation into core.

## Acceptance criteria

- every major public API belongs to a clearly documented tier;
- normal users can avoid `advanced` and `abi`;
- internal/runtime consumers retain zero-cost access;
- crate root remains concise and discoverable;
- formatting, lint, and tests pass.

---

# 37. `[DX] Document the canonical core workflow and recommended API path`

## Evidence

Core currently exposes enough low-level functionality that multiple technically possible workflows exist, including workflows that can violate lifecycle assumptions.

## Why this matters

Good DX is not only having ergonomic methods; it is making the recommended path unmistakable.

## Scope

- document a "recommended path" for normal developers;
- distinguish it from advanced/ABI access;
- show entity/component lifecycle;
- show update → extraction → visibility ordering;
- show error handling and capacity setup.

## Non-goals

- preventing all low-level manual control;
- documenting runtime/renderer implementation internals;
- introducing a high-level application framework.

## Acceptance criteria

- README and crate docs identify one canonical workflow;
- examples follow that workflow consistently;
- advanced APIs explicitly link back to prerequisites/invariants;
- lifecycle mistakes are called out where relevant;
- formatting and documentation checks pass.

---

# 38. `[DX] Establish API ergonomics guidelines for future core changes`

## Evidence

Many current DX issues come from individually reasonable low-level decisions accumulating into a public API that exposes transport details, raw IDs, derived fields, and inconsistent error semantics.

Without an explicit API policy, future features may reintroduce the same patterns.

## Why this matters

DX should be an engineering constraint rather than a one-time cleanup.

A small set of API design rules can keep `core` low-level internally while preserving a high-quality developer-facing surface.

## Scope

Document core API guidelines covering principles such as:

- normal APIs use typed IDs;
- public mutation returns structured errors;
- transport details remain under `abi`;
- derived state is read-only;
- constructors hide padding/layout details;
- no silent failure;
- common iteration uses typed zero-allocation views;
- public APIs include Rustdoc examples;
- performance-critical raw APIs remain available through advanced tiers.

## Non-goals

- prescribing every implementation detail;
- preventing justified exceptions;
- turning guidelines into a generic Rust style guide.

## Acceptance criteria

- a concise DX/API design document exists for `core`;
- new public API reviews can reference concrete ergonomic rules;
- exceptions require explicit rationale;
- guidelines preserve both zero-cost abstractions and developer usability;
- contribution documentation references the policy;
- formatting and docs checks pass.
