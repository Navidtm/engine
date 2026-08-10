# ADR 004: Asset and GPU Resource Lifetime

## Status

Accepted

## Date

2026-08-10

# Context

The engine currently has a deliberately small resource model:

- geometry is a built-in numeric identifier resolved by the renderer;
- a basic material is stored as an entity-backed Rust component;
- a mesh component stores geometry and material identifiers;
- render extraction skips a mesh when its referenced material is absent; and
- renderer disposal destroys the device and every renderer-owned WebGPU object.

This is sufficient for built-in geometry and color-only materials, but it does
not define a scalable contract for glTF assets, textures, samplers, shared
materials, streaming, eviction, or device-loss recovery. In particular,
destroying an entity-backed material that is still referenced by a mesh makes
the mesh disappear during extraction. Resource lifetime must not depend on
component presence or JavaScript garbage collection.

The target architecture must preserve these boundaries:

```text
Application handles
  -> main-thread API mirror
  -> worker Resource Coordinator and Asset Registry
  -> Rust ECS resource references
  -> Render Extraction resource keys
  -> renderer GPU registries
  -> WebGPU objects
```

# Decision

Use generational resource handles, explicit retirement, tracked strong
references, and renderer-owned GPU registries. The worker-side Resource
Coordinator is the authoritative owner of logical resource lifetime. WebGPU
objects never enter ECS components or the public API.

The current entity-backed basic material remains a compatibility implementation
until the resource registry is introduced. New asset, texture, sampler, and PBR
work must use this decision, and the basic material path must migrate before it
can participate in those systems.

## Resource identity

Every geometry, material, texture, sampler, and asset record has a typed,
engine-owned, generational handle. A handle contains a registry slot and a
generation; its exact bit allocation is a versioned ABI detail and must not be
assumed by application code. Resource handles are not entities and an entity ID
must never be reinterpreted as a resource handle.

Public TypeScript handles are immutable and opaque. They also carry an
engine-ownership marker so foreign handles can be rejected on the main thread.
The packed slot and generation are the only values sent through transport or
stored in Rust component data.

A registry slot is not reused until its record is logically destroyed. Reuse
increments the generation. An operation using the wrong resource kind, a
foreign engine handle, a retired handle, or a destroyed generation fails
deterministically and can never resolve to a newer resource in the same slot.

## Ownership by layer

| Layer                       | Owns                                                                                                                                         | Does not own                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Main-thread API             | Opaque handles, authoring descriptors, promise state, and a liveness mirror for early validation                                             | Decoded asset bytes, canonical lifecycle state, Rust data, or WebGPU objects |
| Worker Resource Coordinator | Canonical resource records, lifecycle states, dependency graph, memory accounting, replayable descriptors, loading work, and disposal policy | ECS entities or WebGPU objects                                               |
| Rust/WASM core              | ECS entities/components and fixed-capacity render-oriented mirrors needed by systems and extraction                                          | Logical resource lifetime, source assets, or WebGPU objects                  |
| RenderWorld/extraction      | Transient resource keys and render-ready values for the current frame                                                                        | Resource lifetime or GPU allocation                                          |
| Renderer registries         | `GPUBuffer`, `GPUTexture`, `GPUSampler`, bind groups, pipelines, residency state, and deferred-destruction queues                            | ECS state, application ownership, or asset loading policy                    |

CPU source bytes and decoded payloads belong to worker asset records. A Rust
mirror may contain compact material or bounds data when that is required for
allocation-free extraction, but it is a derived runtime view, not the lifecycle
authority. The worker publishes structural resource changes to Rust and the
renderer in order.

## References and disposal

The system uses explicit ownership plus tracked strong references. It does not
use JavaScript object reachability, `FinalizationRegistry`, or public
reference-counting APIs to determine lifetime.

The Resource Coordinator tracks three kinds of edges:

1. Owner edges from an explicit resource or containing asset record.
2. Dependency edges, such as material to texture and texture to sampler.
3. Usage edges, such as an ECS mesh component to geometry and material.

Creating or replacing an ECS component and changing an asset dependency updates
these edges transactionally with the corresponding structural command. A
command is rejected without partial mutation if any new dependency is invalid,
retired, failed where readiness is required, or over capacity.

`dispose(handle)` releases the owner's claim and retires the record. Retirement:

- is idempotent for the same owner;
- rejects all new dependency and usage edges;
- does not invalidate existing internal edges;
- does not remove an in-use mesh or substitute a different resource; and
- completes logical destruction automatically after the last strong edge is
  released.

This is deferred destruction, not cascading destruction. Disposing an asset
releases its owner/dependency edges in dependency order. A shared child remains
alive while another asset or ECS component references it. Cycles in asset
dependencies are invalid and are rejected during graph validation.

Once logical destruction completes, the registry removes CPU payloads and
derived mirrors, increments the slot generation, and enqueues associated GPU
objects for safe retirement. An explicit engine-wide `dispose` is the terminal
exception: it first stops frame production, rejects pending work, disposes the
WASM core and registries, and then destroys the renderer device and its child
resources.

## Lifecycle states

Asset and resource records use an explicit state machine:

```text
allocated -> loading -> ready <-> evicted
                 |          \
                 v           -> retired -> destroyed
               failed
                 |
                 +-- explicit retry --> loading

allocated, loading, ready, failed, or evicted -- dispose --> retired
```

- **allocated:** identity exists, but loading has not started.
- **loading:** fetch, decode, validation, or GPU preparation is in progress.
- **ready:** validated CPU descriptor exists; GPU-backed resources may be
  resident or may be made resident before use.
- **failed:** loading ended with a retained typed error. The handle remains
  inspectable and disposable; retry creates a new load attempt under an explicit
  API and never silently changes the descriptor.
- **evicted:** the logical record and replayable descriptor remain valid, while
  disposable CPU payloads and/or GPU residency have been released. Use requests
  residency again.
- **retired:** the owner requested disposal. New references are forbidden, but
  existing strong references remain valid until released.
- **destroyed:** payloads and dependencies are released and the generation is
  stale. This state is terminal.

Loading can be cancelled by retirement. Completion callbacks must compare both
slot generation and load-attempt epoch before publishing results, so a late
completion cannot resurrect or overwrite a recycled resource.

## Rendering behavior for unavailable dependencies

Behavior is deterministic and observable:

| Dependency state                   | Reference behavior                          | Extraction/render behavior                                                          |
| ---------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `loading`                          | Existing compatible references remain valid | Item is pending and emits no draw until ready                                       |
| `ready`, resident                  | Accepted                                    | Item renders normally                                                               |
| `ready`, non-resident or `evicted` | Accepted                                    | Residency is requested; item emits no draw until available                          |
| `failed`                           | New references are rejected                 | Existing item emits no draw and exposes the retained error                          |
| `retired`                          | New references are rejected                 | Existing references may restore residency and continue rendering until released     |
| `destroyed` or stale               | Rejected                                    | Defensive extraction drops the item and increments an invalid-dependency diagnostic |

There is no silent fallback material or geometry in the core contract. A future
opt-in placeholder policy belongs in the public authoring layer and must remain
observable in diagnostics.

## GPU residency and in-flight safety

Renderer registries map the complete generational resource key to WebGPU
objects. Creation, upload, replacement, and destruction occur outside ECS and
outside extraction.

Each submitted frame receives a monotonically increasing submission serial.
When a GPU object is replaced, evicted, or logically destroyed, it is detached
from future submissions immediately and placed in a retirement queue tagged
with the last serial that may reference it. The renderer calls `destroy()` only
after a coarse `GPUQueue.onSubmittedWorkDone()` completion watermark covers
that serial. Completion tracking is batched and must not create a promise per
resource or per frame.

Device loss invalidates all device-owned objects regardless of retirement
state. They are discarded as a group; logical resource handles and CPU
descriptors remain valid.

## Memory budgets and eviction

The Resource Coordinator maintains byte accounting at minimum for:

- retained source/download data;
- decoded CPU geometry and texture data;
- Rust/WASM resource mirrors;
- resident GPU buffers and textures; and
- temporary load/decode/upload reservations.

Configuration exposes separate CPU and GPU budgets plus hard registry
capacities. Exact defaults are an implementation decision and require browser
memory measurements. Admission reserves estimated peak bytes before expensive
work begins. A request that cannot fit after eligible eviction fails with a
typed budget error rather than causing unbounded growth.

Only ready resources with no usage edge and no explicit pin are automatically
evictable. Eviction order uses a replaceable policy hook; the initial policy may
use least-recently-used residency epochs maintained outside frame hot paths.
Eviction never changes handle generation and never removes the minimal
descriptor needed to restore residency. Applications can explicitly
`dispose`, pin/unpin, request eviction, and inspect budget/residency statistics.

No dependency counting, eviction search, allocation, or promise creation is
allowed in extraction or render submission hot paths. Lifecycle work is drained
at bounded structural synchronization points.

## Replayable descriptors and device-loss recovery

Every GPU-backed resource retains a device-independent replay descriptor until
logical destruction. It contains the information needed to recreate the
resource, not WebGPU objects:

- geometry: validated vertex/index layout, counts, and a recoverable data source;
- material: pipeline key, scalar parameters, and texture/sampler handles;
- texture: dimensions, format, mip metadata, color space, usage, and a
  recoverable encoded or decoded source;
- sampler: normalized sampler descriptor; and
- pipeline-dependent records: shader/program key and fixed render state.

On recoverable device loss, frame submission pauses, a replacement renderer
device and empty GPU registries are created, and currently required or pinned
resources are replayed in dependency order. The new registries become visible
to rendering only after their required entries are valid. Other ready resources
remain non-resident and are restored on demand. Handles do not change.

If replay data is unavailable or recreation fails, the record moves to `failed`
with a typed recovery error and follows the unavailable-dependency behavior
above. Unrecoverable loss is reported to the main thread and requires explicit
engine disposal or reinitialization; it never silently switches graphics
backends.

# Alternatives Considered

## Keep resources as entities

Rejected. Component removal and entity destruction are simulation lifecycle
operations, not a sufficient ownership model for shared, asynchronous, cached,
or GPU-resident resources. It also makes in-use destruction ambiguous.

## Let ECS components own GPU objects

Rejected. This violates renderer isolation, prevents worker/renderer recovery,
and couples simulation layout to WebGPU lifetime.

## Rely only on manual immediate destruction

Rejected. Immediate destruction can invalidate other users and resources still
referenced by submitted GPU work. It also makes asset sharing unsafe.

## Public reference counting or JavaScript garbage collection

Rejected. Public retain/release calls are error-prone, while garbage collection
and finalizers are nondeterministic and cannot enforce GPU budgets or in-flight
safety. Internal tracked edges provide deterministic lifetime without exposing
reference counts as the authoring model.

## Keep every loaded resource forever

Rejected. It simplifies handles but makes CPU and GPU memory growth unbounded
and prevents production-scale asset switching and streaming.

# Consequences

## Positive

- Shared assets cannot disappear because one owner requests disposal.
- Stale handles cannot alias recycled resources.
- ECS/RenderWorld/renderer separation remains intact.
- Memory use becomes measurable and enforceable.
- Eviction and device recovery preserve logical identity.
- Asset loading, PBR materials, textures, and streaming share one lifecycle
  model.

## Negative

- The worker needs a resource dependency graph, state machine, accounting, and
  ordered synchronization with Rust and renderer registries.
- Logical disposal and physical GPU destruction occur at different times.
- Recovery requires retaining or reacquiring source data, increasing either
  memory use or recovery latency.
- Pending and unavailable resources require explicit diagnostics and async DX.

# Implementation and validation requirements

Implementation must be incremental:

1. Introduce typed generational resource handles and the worker Resource
   Coordinator without changing rendering output.
2. Add transactional ECS usage edges and migrate built-in geometry/basic
   material away from entity-backed lifetime.
3. Add renderer residency registries and batched deferred GPU retirement.
4. Add budget accounting, eviction, and replay descriptors before streaming or
   device recovery is advertised.

Tests must cover wrong-kind, foreign, retired, and stale handles; late load
completion; in-use disposal; shared dependencies; dependency cycles;
spawn/despawn and component replacement; eviction/re-residency; budget failure;
submission-safe GPU retirement; device-loss replay; and engine-wide disposal.

Performance validation must measure structural-operation cost, registry memory
overhead, asset load/decode/upload time, memory before load/after load/after
eviction/after disposal, and steady-state frame allocations. This ADR does not
claim a performance improvement.

# Future Impact

glTF/GLB loading, textures, samplers, PBR materials, streaming, and device-loss
recovery are blocked on the relevant phases of this contract. Public APIs may
make loading ergonomic, but they must not expose registry slots, worker
protocol, Rust mirrors, WebGPU objects, or internal reference counts.
