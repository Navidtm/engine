# 1. `[Feature] Expose explicit draw batches from visibility output`

**Suggested ownership:** `core` + `renderer`

## Evidence

`core` already groups visible instances by renderer-relevant state such as pipeline, material, and geometry, but the output is still exposed primarily as parallel arrays.

The renderer must therefore infer batch boundaries itself even though `core` has already performed the grouping work.

A renderer-facing batch descriptor could formalize the existing grouping result:

```rust
pub struct DrawBatch {
    pub pipeline: PipelineId,
    pub material: MaterialHandle,
    pub geometry: GeometryId,
    pub first_instance: u32,
    pub instance_count: u32,
}
```

## Why this matters

Explicit batches reduce duplicated interpretation between `core` and `renderer`, make the render contract easier to test, and give the renderer a direct representation of the work it needs to submit.

They also provide a natural place for future batching statistics and indirect-draw preparation.

## Scope

- add an explicit allocation-free draw-batch representation to `core`;
- generate batches after visibility sorting/grouping;
- expose stable batch ranges into the visible instance-slot buffer;
- update `renderer` to consume batches directly;
- expose batch counts through diagnostics where useful.

## Non-goals

- creating WebGPU render pipelines inside `core`;
- encoding WebGPU commands inside `core`;
- calling `draw()` or `drawIndexed()` from `core`;
- moving shader compilation or GPU resource ownership out of `renderer`;
- implementing GPU-driven indirect rendering in this issue.

## Acceptance criteria

- visible instances with identical pipeline/material/geometry keys are represented by one contiguous batch where possible;
- each batch exposes a valid instance range;
- the renderer no longer needs to rediscover batch boundaries from parallel arrays;
- batch generation performs no steady-state frame allocation;
- ordering is deterministic for the same scene state;
- tests cover one batch, multiple batches, empty visibility output, and batch-boundary changes;
- formatting, lint, typecheck, and tests pass.

---

# 2. `[Performance] Add fine-grained transform and render dirty tracking`

**Suggested ownership:** `core`

## Evidence

Current transform and render dirtiness is significantly broader than the actual mutation.

Transform update paths can recompute many matrices, global render epochs can force broad extraction work, and material changes can require scanning mesh renderers to discover dependent entities.

The existing architecture already tracks revisions, so the package has the foundation for more precise dependency tracking.

## Why this matters

Sparse scene mutations should cost approximately proportional to the number of changed renderables rather than the total scene size.

This is especially important for a real-time engine that otherwise emphasizes fixed capacities and allocation-free frame work.

## Scope

- track local transform dirtiness explicitly;
- recompute world matrices only when required;
- preserve dirty propagation for dependent render data;
- track material-to-renderable dependencies without repeated full mesh scans;
- make extraction consume precise dirty sets/ranges where possible;
- add benchmarks for sparse mutations.

## Non-goals

- moving render scheduling into `core`;
- adding GPU synchronization primitives to `core`;
- managing GPU buffers from `core`;
- introducing a general-purpose reactive ECS;
- requiring per-frame heap allocation.

## Acceptance criteria

- mutating one independent transform does not recompute every unrelated transform;
- unchanged entities are not marked dirty merely because they were iterated;
- one material mutation does not require a full mesh scan to rediscover its users;
- unchanged frames preserve the current fast path;
- representative sparse-update benchmarks show work scaling with changed entities rather than total scene size;
- steady-state frame processing remains allocation-free;
- formatting, lint, and tests pass.

---

# 3. `[Feature] Introduce geometry metadata and authoritative local bounds`

**Suggested ownership:** `scene` + `core` + `renderer`

## Evidence

`core` currently treats geometry primarily as an opaque numeric identifier, while visibility requires local bounds.

Without authoritative geometry metadata, `core` cannot know the real extent of arbitrary geometry and currently falls back to generic bounds.

The monorepo already has separate `scene`, `core`, and `renderer` packages, which provides a natural separation between asset metadata, CPU visibility data, and GPU geometry resources.

## Why this matters

Geometry bounds should originate from actual geometry metadata rather than assumptions inside `core`.

A shared metadata contract also provides a foundation for LOD selection, diagnostics, asset validation, and geometry statistics without coupling `core` to GPU buffers.

## Scope

- define geometry metadata containing at least authoritative local bounds;
- let `scene` associate scene geometry references with metadata;
- let `core` consume compact geometry metadata required for extraction/culling;
- let `renderer` continue to own vertex/index buffers and GPU geometry resources;
- define behavior for geometry whose bounds are unavailable.

## Non-goals

- storing vertex buffers in `core`;
- loading mesh files in `core`;
- creating WebGPU buffers in `core`;
- uploading geometry from `core`;
- making `core` responsible for asset decoding.

## Acceptance criteria

- every cullable geometry can resolve authoritative local bounds;
- missing bounds have explicit safe semantics;
- visibility no longer depends on a fabricated unit-cube assumption;
- `renderer` remains the owner of GPU geometry resources;
- geometry metadata can be queried without exposing GPU implementation details;
- tests cover known bounds, missing bounds, transformed bounds, and geometry replacement;
- formatting, lint, typecheck, and tests pass.

---

# 4. `[Feature] Make the active visibility camera explicit`

**Suggested ownership:** `scene` + `core` + `api`

## Evidence

`core` supports multiple cameras, but visibility currently derives its camera from storage order rather than an explicit application-level selection.

With separate `scene` and `api` packages, camera identity and scene-level intent can be expressed without making ECS storage order part of the public contract.

## Why this matters

Editor cameras, gameplay cameras, minimaps, previews, and future multi-view rendering require deterministic camera selection.

Internal sparse-set ordering should never determine which camera controls visibility.

## Scope

- introduce an explicit active-camera or visibility-camera concept;
- expose camera selection through `scene` and public `api`;
- pass the selected camera explicitly into `core` visibility;
- validate that the selected camera is alive and has a camera component;
- preserve deterministic no-camera behavior.

## Non-goals

- implementing stereo rendering;
- rendering all cameras simultaneously;
- creating render targets in `core`;
- managing WebGPU camera buffers in `core`;
- implementing editor UI for camera switching.

## Acceptance criteria

- camera selection is explicit and deterministic;
- component insertion/removal order cannot change the active camera implicitly;
- invalid/stale active-camera references are handled predictably;
- single-camera scenes retain equivalent behavior;
- tests cover camera switching, removal, and multiple-camera scenes;
- formatting, lint, typecheck, and tests pass.

---

# 5. `[Feature] Add visibility layers and camera culling masks`

**Suggested ownership:** `scene` + `core` + `api`

## Evidence

Current visibility is primarily determined by geometric frustum intersection.

There is no first-class mechanism for expressing that a renderable belongs to a logical visibility layer or that a camera should ignore particular categories of objects.

## Why this matters

Visibility masks are useful for editor gizmos, debug objects, world/UI separation, minimaps, reflection views, gameplay-specific cameras, and selective rendering.

Layer checks are also significantly cheaper than geometric visibility work and can reject objects early.

## Scope

- add a compact render visibility mask to renderable scene state;
- add a culling mask to cameras;
- perform layer-mask rejection before frustum tests;
- expose layer configuration through `scene` and `api`;
- preserve sensible defaults where all standard objects remain visible.

## Non-goals

- implementing render-target routing;
- implementing WebGPU bind-group visibility;
- creating separate render passes inside `core`;
- using layers as a replacement for material or pipeline selection.

## Acceptance criteria

- renderables can belong to one or more visibility layers;
- cameras can include/exclude layers deterministically;
- layer rejection occurs before unnecessary frustum work;
- default scenes retain current visible behavior;
- tests cover single-layer, multi-layer, excluded, and all-visible cases;
- formatting, lint, typecheck, and tests pass.

---

# 6. `[Feature] Add transform hierarchy and parent-child scene relationships`

**Suggested ownership:** `scene` + `core`

## Evidence

Current transforms are effectively independent and world matrices are derived directly from each entity's local transform.

The repository now has a dedicated `scene` package, making it possible to keep scene-graph semantics separate from low-level render preparation.

## Why this matters

Most non-trivial scenes require hierarchical transforms for vehicles, characters, articulated objects, imported models, grouped objects, cameras attached to entities, and nested scene composition.

Hierarchy-aware dirty propagation also enables efficient subtree updates.

## Scope

- let `scene` own parent/child relationships and scene-graph semantics;
- define a compact hierarchy representation consumable by `core`;
- compute child world transforms from parent world transforms;
- propagate transform dirtiness through affected descendants;
- reject hierarchy cycles;
- define behavior for parent deletion/reparenting.

## Non-goals

- turning `core` into a full scene-authoring system;
- storing editor tree UI state in `core`;
- loading scene files in `core`;
- implementing skeleton animation in this issue;
- making `renderer` aware of scene hierarchy.

## Acceptance criteria

- parent transforms affect descendant world transforms correctly;
- reparenting updates descendants deterministically;
- cycles cannot enter the scene hierarchy;
- destroying a parent follows documented child semantics;
- unrelated subtrees are not recomputed unnecessarily;
- renderer-facing data remains flattened to world-space state;
- formatting, lint, typecheck, and tests pass.

---

# 7. `[Feature] Add orthographic camera projection support`

**Suggested ownership:** `core` + `scene` + `api`

## Evidence

Camera math currently centers on perspective projection.

The existing camera representation already separates projection-related parameters from view transforms, making projection mode a natural extension.

## Why this matters

Orthographic cameras are required for CAD-style views, editor tools, strategy games, 2D/3D overlays, previews, and several future rendering techniques.

## Scope

- introduce explicit perspective and orthographic projection modes;
- implement orthographic projection math in `core`;
- expose projection configuration through `scene` and `api`;
- ensure visibility/frustum construction works with both projection types;
- validate projection-specific parameters.

## Non-goals

- creating render textures;
- implementing shadow mapping;
- managing WebGPU depth textures in `core`;
- adding editor camera controls.

## Acceptance criteria

- cameras can select perspective or orthographic projection explicitly;
- both projection types produce valid camera/frustum data;
- invalid projection parameters are rejected;
- switching projection mode invalidates the required derived data;
- tests cover both projection types and edge cases;
- formatting, lint, typecheck, and tests pass.

---

# 8. `[Feature] Add scene-level Level of Detail selection`

**Suggested ownership:** `scene` + `core` + `renderer`

## Evidence

Visibility already determines which renderables should reach the renderer and has access to camera-relative spatial information.

Geometry is represented by handles, making it possible to select one of several geometry handles without requiring `core` to understand GPU buffers.

## Why this matters

LOD reduces geometry workload for distant objects and provides a predictable CPU-side mechanism for controlling scene complexity.

Keeping selection outside the renderer also makes behavior deterministic and testable independently of GPU state.

## Scope

- define LOD groups in `scene`;
- associate distance or projected-size thresholds with geometry variants;
- select an active geometry variant during core frame preparation;
- expose the selected geometry to renderer batching;
- add diagnostics for LOD distribution where useful.

## Non-goals

- generating lower-detail meshes;
- loading LOD assets in `core`;
- creating or uploading vertex buffers in `core`;
- implementing GPU mesh shading;
- implementing texture mip selection.

## Acceptance criteria

- an entity can reference multiple geometry LOD levels;
- selection is deterministic for a given camera and transform;
- threshold transitions are tested;
- renderer receives only the selected geometry handle;
- `core` remains unaware of WebGPU geometry resources;
- formatting, lint, typecheck, and tests pass.

---

# 9. `[Performance] Add a spatial acceleration structure for large-scene visibility`

**Suggested ownership:** `core`

## Evidence

Current frustum culling conceptually evaluates renderable bounds individually.

This is simple and appropriate for small/medium scenes, but work remains proportional to the total renderable population even when only a small region intersects the camera.

## Why this matters

Large scenes can benefit from rejecting groups of objects before performing individual sphere/frustum tests.

A spatial index also lays groundwork for other CPU-side spatial queries.

## Scope

- benchmark the existing linear visibility path first;
- introduce a fixed-capacity spatial structure such as a BVH, loose octree, or grid if measurements justify it;
- incrementally update entries when bounds change;
- query candidates before exact frustum testing;
- retain a linear path for small scenes if beneficial.

## Non-goals

- implementing GPU occlusion culling;
- implementing Hi-Z culling in `core`;
- storing WebGPU buffers in the acceleration structure;
- introducing the structure without benchmark evidence;
- making `scene` asset loading dependent on the spatial index.

## Acceptance criteria

- benchmark evidence demonstrates the scene sizes where acceleration improves performance;
- candidate queries never exclude genuinely visible objects;
- moving entities update spatial membership correctly;
- steady-state visibility avoids unnecessary allocation;
- small-scene performance does not regress materially;
- formatting, lint, benchmarks, and tests pass.

---

# 10. `[Architecture] Separate instance transforms from GPU material storage`

**Suggested ownership:** `core` + `renderer`

## Evidence

Current renderer-facing instance data includes material-derived values such as color per instance.

When many objects share one material, identical material state can therefore be repeated across many instance records.

## Why this matters

Material state and instance state have different mutation frequencies and sharing behavior.

Separating them reduces duplicated data and allows a single material update to modify one material record instead of every instance using that material.

## Scope

- make `core` extract a stable material slot/handle for each renderable;
- keep per-instance data focused on transform and instance-specific values;
- let `renderer` maintain a separate GPU material buffer/resource representation;
- track material dirty ranges independently from instance dirty ranges;
- preserve batching by material identity.

## Non-goals

- making `core` own GPU material buffers;
- creating bind groups in `core`;
- uploading uniforms/storage buffers from `core`;
- compiling material shaders in `core`;
- implementing PBR in this issue.

## Acceptance criteria

- shared material data is not duplicated into every GPU instance record unnecessarily;
- one material mutation can be represented independently of unrelated instance transforms;
- renderer owns GPU material allocation and uploads;
- batching remains deterministic;
- tests cover shared material mutation and independent transform mutation;
- formatting, lint, typecheck, and tests pass.

---

# 11. `[Architecture] Make the material model extensible without coupling core to shader features`

**Suggested ownership:** `scene` + `renderer` + `api`, with opaque handles in `core`

## Evidence

The current material model is centered around a basic material containing a color and pipeline identity.

That representation will become restrictive as the renderer gains unlit, textured, PBR, depth-only, wireframe, custom, or other material types.

## Why this matters

`core` should understand enough material identity to extract, sort, and batch renderables, but it should not become the owner of shader-specific material schemas.

Separating generic material identity from renderer material payloads allows both packages to evolve independently.

## Scope

- keep an opaque/stable material handle in `core`;
- let `scene` reference material assets/descriptors;
- let `renderer` own renderer-specific material payloads and GPU representation;
- expose ergonomic material creation/configuration through `api`;
- retain pipeline/grouping information required for batching.

## Non-goals

- adding PBR fields directly to `core::Material`;
- loading textures in `core`;
- compiling shaders in `core`;
- creating bind groups in `core`;
- making `core` understand WebGPU texture/sampler objects.

## Acceptance criteria

- multiple renderer material types can share the same core extraction path;
- `core` can batch by opaque material/pipeline identity without knowing shader-specific fields;
- renderer-specific material changes do not require expanding core ECS types for every shader feature;
- public API can expose typed material descriptors;
- formatting, lint, typecheck, and tests pass.

---

# 12. `[DX] Replace raw numeric component IDs with typed component identifiers`

**Suggested ownership:** `core` + `api` + `runtime`

## Evidence

Component operations currently rely on raw numeric identifiers for component kinds.

Numeric IDs are useful across transport/ABI boundaries but are error-prone when exposed directly to Rust or public API callers.

## Why this matters

Typed identifiers make call sites self-documenting, reduce accidental mismatches, and allow invalid transport values to be rejected at a single boundary.

## Scope

- introduce a typed `ComponentKind`;
- retain stable numeric discriminants for transport compatibility;
- convert raw command IDs to typed values in `runtime`;
- expose typed component operations through `api`;
- document the transport mapping.

## Non-goals

- replacing the ECS with trait-object components;
- making component IDs dynamically allocated;
- exposing internal Rust enum layout directly as an unstable ABI.

## Acceptance criteria

- internal/public code does not rely on unexplained component magic numbers;
- runtime rejects unknown component discriminants predictably;
- transport numeric values remain explicitly versioned/stable where required;
- tests cover every valid component mapping and invalid values;
- formatting, lint, typecheck, and tests pass.

---

# 13. `[DX] Return structured errors from world and scene mutation APIs`

**Suggested ownership:** `core` + `scene` + `api` + `runtime`

## Evidence

Several mutation APIs communicate failure with boolean or similarly low-information return values.

A caller cannot reliably distinguish conditions such as dead entity, exhausted component capacity, invalid camera parameters, missing dependencies, or invalid scene relationships.

## Why this matters

Structured errors improve debugging, worker error propagation, public API ergonomics, tests, and observability without changing the underlying fixed-capacity architecture.

## Scope

- define structured domain errors for core mutation failures;
- map scene-specific errors separately where appropriate;
- propagate machine-readable errors through runtime boundaries;
- expose ergonomic public errors through `api`;
- keep hot-path error handling allocation-conscious.

## Non-goals

- putting user-facing localized error strings in `core`;
- throwing JavaScript exceptions for all runtime failures;
- replacing expected capacity errors with panics;
- hiding the original error category at package boundaries.

## Acceptance criteria

- callers can distinguish major failure categories programmatically;
- runtime preserves error identity across package boundaries;
- public API errors contain actionable context;
- hot-path success behavior remains lightweight;
- tests cover representative failures and error mapping;
- formatting, lint, typecheck, and tests pass.

---

# 14. `[Safety] Encapsulate derived transform/camera state and ABI padding`

**Suggested ownership:** `core`

## Evidence

Some component fields combine canonical user input with derived engine state such as world, view, or projection matrices, alongside explicit layout/padding fields.

If all fields remain freely mutable, callers can violate assumptions that update systems depend on.

## Why this matters

The type system should distinguish authoritative input from derived/cache state.

This makes dirty tracking reliable and prevents callers from accidentally creating a transform whose local values disagree with its world matrix.

## Scope

- make derived matrices non-publicly mutable;
- expose controlled mutation methods for canonical transform/camera input;
- keep required ABI layout guarantees;
- hide padding fields from normal application APIs;
- ensure mutations correctly mark derived state dirty.

## Non-goals

- changing GPU/WASM layout without an explicit ABI migration;
- moving matrices to `renderer`;
- removing direct read access where zero-copy consumers require it;
- storing WebGPU objects in components.

## Acceptance criteria

- external callers cannot create contradictory canonical/derived component state through safe APIs;
- transform/camera setters trigger the correct dirty state;
- required ABI layout remains verified;
- padding exists only as an implementation/layout detail;
- tests cover mutation and derived-state recomputation;
- formatting, lint, typecheck, and tests pass.

---

# 15. `[Reliability] Make RenderWorld extraction transactional`

**Suggested ownership:** `core`

## Evidence

Render extraction can fail because of fixed-capacity constraints.

A partial snapshot is dangerous because downstream code must know whether a failed extraction left renderer-facing arrays in a valid state.

## Why this matters

The renderer should consume either the last complete snapshot or a newly completed snapshot—never ambiguous partially rebuilt state.

Transactional extraction greatly simplifies runtime error handling and prevents failed frame preparation from corrupting a previously renderable scene.

## Scope

- build extraction output in preallocated staging storage;
- commit the new snapshot only after successful completion;
- preserve the previous valid snapshot when extraction fails;
- preserve dirty-range semantics after commit;
- make failure-state behavior explicit in documentation.

## Non-goals

- allocating a fresh snapshot every frame;
- moving renderer resources into `core`;
- automatically resizing capacities on failure;
- swallowing extraction errors.

## Acceptance criteria

- failed extraction leaves the previous committed snapshot intact;
- successful extraction atomically replaces the previous logical snapshot;
- no partially rebuilt data is exposed as current;
- steady-state extraction remains allocation-free;
- regression tests cover failures at multiple extraction stages;
- formatting, lint, and tests pass.

---

# 16. `[Feature] Add a canonical frame-preparation pipeline in runtime`

**Suggested ownership:** `runtime`

## Evidence

The required frame sequence currently spans multiple low-level operations such as world updates, render extraction, visibility processing, and renderer submission preparation.

Correctness depends on callers preserving this order.

The repository already includes a dedicated `runtime` package, which is the appropriate layer for cross-package orchestration.

## Why this matters

A canonical frame pipeline reduces lifecycle mistakes and provides one place to coordinate statistics, errors, synchronization, and future frame stages.

It also keeps orchestration out of `core`.

## Scope

- add a runtime-level frame preparation operation;
- coordinate core update, extraction, visibility, and renderer-facing preparation in one documented order;
- preserve lower-level APIs for tests/advanced use;
- surface stage failures consistently;
- make frame diagnostics observable.

## Non-goals

- moving WebGPU rendering into `core`;
- making `core` responsible for the application loop;
- putting worker scheduling logic into `scene`;
- hiding every low-level package API.

## Acceptance criteria

- the standard runtime path executes frame stages in a deterministic documented order;
- a caller using the standard API cannot accidentally extract before required core updates;
- stage errors prevent invalid downstream submission;
- low-level APIs remain available where explicitly required;
- integration tests verify stage ordering;
- formatting, lint, typecheck, and tests pass.

---

# 17. `[Performance] Add batched scene/core mutation commands across the runtime boundary`

**Suggested ownership:** `runtime` + `api` + `core`

## Evidence

Worker/WASM-oriented architectures frequently receive multiple structural or transform changes together.

Applying each command independently can repeat validation, dirty propagation, epoch changes, and transport overhead.

## Why this matters

A batch mutation path can amortize runtime/ABI overhead and allow `core` to coalesce dirty sets before frame preparation.

This is especially useful for scene loading, animation updates, editor operations, and network/state synchronization.

## Scope

- define a compact batch command representation in `runtime`;
- expose batched mutation through `api` where useful;
- let `core` process a command batch without unnecessary repeated global invalidation;
- collect affected entities/materials/transforms before publishing final dirty state;
- preserve deterministic command ordering.

## Non-goals

- making `core` responsible for worker message transport;
- embedding JavaScript objects directly into core commands;
- uploading GPU data from the batch mutation path;
- introducing unbounded per-batch allocations.

## Acceptance criteria

- multiple mutations can cross the runtime boundary in one batch;
- command order has deterministic semantics;
- dirty/revision updates are coalesced where safe;
- failure behavior for partially invalid batches is explicitly defined;
- representative command-heavy workloads perform less boundary/control-flow work;
- formatting, lint, typecheck, and tests pass.

---

# 18. `[Feature] Add unified runtime/core/renderer diagnostics and frame statistics`

**Suggested ownership:** `runtime`, aggregating `core` + `renderer`; exposed through `api`

## Evidence

`core` already has enough state to report scene/extraction/visibility information, while `renderer` owns GPU-specific counters and `runtime` coordinates the complete frame.

No single lower-level package has enough context to provide complete engine statistics.

## Why this matters

A unified stats surface is valuable for profiling, capacity planning, editor overlays, automated regression tests, and diagnosing scene/renderer bottlenecks.

## Scope

- let `core` expose lightweight core-specific counters;
- let `renderer` expose renderer/GPU submission counters;
- aggregate them in `runtime`;
- expose a stable stats snapshot through `api`;
- include capacity utilization and dirty/visible/batch counts where useful.

Example categories:

```text
entities
transforms
renderables
materials
visible_instances
culled_instances
dirty_instances
draw_batches
draw_calls
buffer_uploads
capacity_usage
```

## Non-goals

- making `core` query WebGPU statistics;
- making `renderer` understand ECS internals;
- adding a heavyweight tracing framework in this issue;
- exposing unstable internal pointers as public API statistics.

## Acceptance criteria

- one runtime stats request can report coherent core and renderer metrics;
- package-specific counters remain owned by the relevant package;
- requesting statistics does not mutate frame state unexpectedly;
- counter semantics are documented and deterministic;
- integration tests validate aggregation;
- formatting, lint, typecheck, and tests pass.

---

# 19. `[Architecture] Define and verify a stable WASM/runtime ABI contract`

**Suggested ownership:** `runtime` + `core` + `renderer`

## Evidence

`core` exposes raw-memory-oriented data and pointers intended for efficient consumption across a WASM/runtime boundary.

This makes record size, alignment, field order, buffer capacity, and ABI version part of the effective integration contract even when they are not represented explicitly.

## Why this matters

A layout mismatch between Rust, runtime code, and renderer consumers can silently reinterpret memory and produce corruption that is difficult to diagnose.

The ABI should therefore be explicit and testable.

## Scope

- define an ABI version;
- expose required structure size/alignment metadata;
- document buffer layouts and element formats;
- add compile-time layout assertions where possible;
- add runtime integration tests that verify consumer expectations;
- define a compatibility policy for ABI changes.

## Non-goals

- treating every internal Rust structure as ABI-stable;
- exposing WebGPU native handles through the ABI;
- moving renderer implementation details into `core`;
- preventing intentional ABI version bumps.

## Acceptance criteria

- every shared raw-memory record has a documented layout contract;
- runtime can verify expected ABI version before consuming shared data;
- size/alignment/layout regressions fail deterministic tests;
- ABI-breaking changes require an explicit version change;
- internal non-shared structures remain free to evolve;
- formatting, lint, typecheck, and tests pass.

---

# 20. `[Quality] Add property tests, fuzzing, and performance benchmarks across engine boundaries`

**Suggested ownership:** repository-wide

## Evidence

Core structures such as `EntityAllocator`, `SparseSet`, dirty-range generation, extraction, visibility grouping, and math have strong invariants that are difficult to cover completely with example-based tests.

The wider monorepo also contains boundaries between `api`, `runtime`, `scene`, `core`, and `renderer` where ordering and serialization regressions can occur.

## Why this matters

Property testing and fuzzing are particularly effective at finding generation/index corruption, stale references, capacity edge cases, invalid command streams, NaN propagation, grouping inconsistencies, and cross-package contract violations.

Benchmarks provide evidence before introducing complex optimizations such as BVHs or more elaborate incremental tracking.

## Scope

- add property tests for entity allocation and sparse sets;
- fuzz raw entity/component/runtime command inputs;
- property-test dirty ranges and batch grouping;
- test frustum math with finite randomized input;
- add integration tests across scene → runtime → core → renderer preparation;
- add representative performance benchmarks for large scenes and sparse mutations;
- establish baseline benchmark scenarios.

## Non-goals

- requiring GPU hardware for every core unit test;
- fuzzing WebGPU drivers;
- replacing deterministic regression tests with fuzz tests;
- optimizing solely from synthetic benchmarks without profiling real workloads.

## Acceptance criteria

- allocator properties guarantee no duplicate live entity IDs and correct liveness accounting;
- sparse-set properties guarantee one reachable dense record per entity index;
- invalid runtime command data cannot cause unchecked memory/index failures;
- visibility/grouping properties preserve all expected visible instances exactly once;
- benchmark baselines exist for small, medium, and large scene workloads;
- CI runs a practical deterministic subset of the new quality suite;
- formatting, lint, typecheck, and tests pass.

---

# 21. `[Architecture] Keep WebGPU resource management inside renderer`

**Suggested ownership:** `renderer`

## Evidence

The package split already separates CPU-side scene/render preparation from rendering implementation.

Several future features—materials, geometry metadata, batching, visibility, cameras, and LOD—will need to interact with renderer-facing identities, which creates a risk that WebGPU-specific responsibilities gradually leak into `core`.

## Why this matters

`core` remains easier to test, reuse, fuzz, and execute in non-GPU contexts when it contains no WebGPU device/resource lifecycle logic.

`renderer` is the natural owner of GPU devices, buffers, textures, pipelines, bind groups, command encoders, and render passes.

## Scope

- document `renderer` as the exclusive owner of WebGPU resource creation and destruction;
- keep GPU buffer allocation/upload logic inside `renderer`;
- keep render pipeline creation/caching inside `renderer`;
- keep bind-group and texture/sampler ownership inside `renderer`;
- define opaque IDs/metadata used by `core` when cross-package references are required.

## Non-goals

- creating WebGPU buffers in `core`;
- storing `GPUDevice`, `GPUBuffer`, `GPUTexture`, or equivalent handles in `core`;
- executing render passes from `core`;
- making scene entities own raw GPU resources.

## Acceptance criteria

- `core` has no dependency on WebGPU APIs;
- renderer-facing core records contain only portable CPU data and opaque IDs;
- resource lifetime is owned by `renderer`;
- cross-package ownership rules are documented;
- architecture tests/dependency rules prevent accidental WebGPU dependencies from entering `core`;
- formatting, lint, typecheck, and tests pass.

---

# 22. `[Architecture] Keep shader compilation and pipeline specialization inside renderer`

**Suggested ownership:** `renderer`, descriptors optionally exposed by `api` / `scene`

## Evidence

Future material and draw-batching work will introduce more pipeline identities, but pipeline identity is not the same responsibility as constructing a concrete WebGPU render pipeline.

Shader source compilation and GPU pipeline specialization depend directly on renderer backend state.

## Why this matters

Keeping shader compilation outside `core` prevents the CPU scene model from becoming coupled to one rendering backend or shader language.

It also allows renderer-level pipeline caches and specialization strategies to evolve independently.

## Scope

- keep shader module creation inside `renderer`;
- keep concrete render-pipeline creation/caching inside `renderer`;
- let `core` transport only opaque pipeline IDs/grouping keys where required;
- let `api`/`scene` expose higher-level render/material descriptors when appropriate;
- define error propagation for renderer pipeline creation failures.

## Non-goals

- compiling WGSL in `core`;
- storing shader source code as core ECS component state;
- letting core visibility systems inspect shader implementation;
- moving renderer pipeline caches into runtime.

## Acceptance criteria

- `core` can group renderables by pipeline identity without constructing pipelines;
- all backend-specific shader/pipeline objects remain in `renderer`;
- pipeline creation failures propagate through runtime/API with structured errors;
- renderer pipeline caching can evolve without modifying core ECS layout;
- formatting, lint, typecheck, and tests pass.

---

# 23. `[Architecture] Keep texture loading and GPU texture ownership outside core`

**Suggested ownership:** `scene`/asset layer + `renderer` + `api`

## Evidence

An extensible material system will eventually require textures, samplers, and image assets.

These resources involve file/network decoding, color-space metadata, GPU upload, sampler state, mip generation, and lifetime management—none of which are part of core ECS/render extraction responsibilities.

## Why this matters

If texture objects or loading logic enter `core`, the package becomes coupled to asset formats, I/O, and WebGPU resource state.

A cleaner contract is for scene/material data to reference texture assets through handles while renderer owns their GPU realization.

## Scope

- represent texture references as stable/opaque handles;
- keep asset loading/decoding outside `core`;
- let `scene` reference textures in material descriptors;
- let `renderer` create and own GPU textures/samplers;
- propagate readiness/failure state through runtime/API where needed.

## Non-goals

- decoding PNG/JPEG/etc. in `core`;
- creating GPU textures in `core`;
- storing WebGPU sampler/texture handles in ECS components;
- implementing streaming or virtual texturing in this issue.

## Acceptance criteria

- material/scene state can reference textures without exposing GPU objects to `core`;
- renderer exclusively owns GPU texture/sampler resources;
- missing/loading/failed assets have explicit runtime semantics;
- core extraction remains backend-independent;
- formatting, lint, typecheck, and tests pass.

---

# 24. `[Architecture] Keep shadow rendering as a renderer feature with core-provided scene data`

**Suggested ownership:** `renderer` + `scene`; `core` only provides reusable visibility/spatial data where appropriate

## Evidence

Future lighting work may make shadow maps an attractive feature, but shadow rendering requires render targets, depth textures, pipeline variants, per-light render passes, GPU synchronization, and renderer scheduling.

Those responsibilities are outside the current CPU-side purpose of `core`.

## Why this matters

Core visibility/math can remain reusable for shadow-camera/frustum calculations without making `core` responsible for actual shadow-map rendering.

This preserves a clean separation between scene state and GPU execution.

## Scope

- let `scene` represent lights and shadow configuration if/when lighting is introduced;
- allow reusable core math/visibility utilities to operate on explicit camera/frustum data;
- implement shadow textures, passes, pipelines, and submission in `renderer`;
- orchestrate multi-pass frame execution in `runtime`.

## Non-goals

- creating depth textures in `core`;
- encoding shadow render passes in `core`;
- storing WebGPU shadow resources in scene components;
- coupling generic core visibility to a specific shadow algorithm.

## Acceptance criteria

- shadow-map GPU resources are owned entirely by `renderer`;
- runtime controls when shadow passes execute;
- core remains usable without WebGPU;
- reusable CPU visibility/math code can be shared without understanding shadow-map implementation;
- package ownership is documented before shadow implementation begins;
- formatting, lint, typecheck, and tests pass.
