# Milestone 7: Asset Pipeline Foundation

## Status vocabulary

This milestone distinguishes:

- **Implemented fact:** production code and regression coverage exist.
- **Accepted design:** an ADR fixes required semantics; code may still be absent.
- **Pending implementation:** a listed deliverable has not been built.
- **Measured evidence:** committed results describe one controlled workload and
  environment, not a general performance claim.

Milestone 7 currently has accepted design and implementation in progress.

## Implementation progress

| Phase | Status      | Evidence                                                          |
| ----- | ----------- | ----------------------------------------------------------------- |
| 1     | Implemented | `@lume/assets` contracts, decoder, fixtures, and regression suite |
| 2     | Implemented | Renderer external geometry registration, lifecycle, and replay    |
| 3     | Implemented | Worker transaction, budgets, cancellation, and recovery replay    |
| 4     | Implemented | Public `engine.load.geometry()` API and browser integration       |
| 5     | Pending     | Controlled measurements, final documentation, and completion gate |

Phases 1 through 4 provide the complete public loading path. Controlled
measurement and the milestone completion gate remain Phase 5.

## Objective

Introduce the first external, replayable geometry-loading path without adding a
scene graph, texture system, or asset work to frame hot paths.

The developer-facing target is:

```ts
const geometry = await engine.load.geometry("/assets/product.glb");
const product = engine.create.mesh({ geometry });
```

The architecture target is:

```text
Application URL
  -> public load request and promise correlation
  -> worker fetch / GLB validation / decode
  -> Resource Coordinator geometry record
  -> renderer-owned GPU geometry buffers
  -> existing GeometryHandle usage in ECS mesh components
```

## Accepted decisions

- [ADR 004](../.agents/decisions/004-resource-lifetime.md) remains authoritative
  for generational handles, ownership edges, retirement, budgets, and replay.
- [ADR 011](../.agents/decisions/011-glb-geometry-ingestion.md) selects a limited
  GLB 2.0 static-geometry profile and an internal device-independent descriptor.
- [ADR 012](../.agents/decisions/012-async-geometry-loading.md) selects
  `engine.load.geometry()`, worker-owned loading, optional abort, and atomic
  ready-handle publication.

These decisions are implemented through Phase 4; measurement-gated completion
remains pending.

## Implemented starting point

The repository already provides:

- opaque engine-owned generational `GeometryHandle` values;
- a main-thread resource liveness mirror;
- a worker Resource Coordinator with usage edges and retirement;
- fixed-capacity renderer geometry registries;
- immutable built-in indexed geometry uploads;
- transactional GPU buffer creation for a mesh;
- ordered mesh/resource structural commands;
- device-loss reconstruction from built-in descriptors; and
- explicit resource and render capacities.

Milestone 7 extends this path to external decoded geometry. It does not replace
the existing ECS -> RenderWorld -> renderer boundary.

## Delivery scope

### Public API

Add a framework-neutral `engine.load` facade with:

```ts
interface LoadApi {
  geometry(source: string | URL, options?: GeometryLoadOptions): Promise<GeometryHandle>;
}

interface GeometryLoadOptions {
  readonly signal?: AbortSignal;
}
```

The promise resolves only when geometry is ready and renderer-resident. Existing
`engine.create.mesh({ geometry })` performs instantiation. The loader does not
create entities automatically.

### Asset decoder — Phase 1 implemented

The pure `@lume/assets` package now provides:

```text
GLB ArrayBuffer + immutable limits
  -> validated DecodedGeometry
```

It requires explicit positive safe-integer limits because production defaults
remain measurement-gated. It validates container/chunk structure, UTF-8/JSON,
the accepted profile, accessor layout/alignment/bounds, safe byte arithmetic,
finite attributes, position bounds, index ranges, and output budgets before
returning renderer-independent arrays and verified mesh-local POSITION bounds.
It has no dependency on DOM canvas APIs,
ECS, RenderWorld, runtime, or WebGPU and may be reused by a future offline CLI.
Its accepted profile and rejection rules are fixed by ADR 011.

### Runtime orchestration — Phase 3 implemented

Protocol version 13 adds correlated load, abort, ready, and typed-failure
records. Fetch, bounded response reading, byte admission, parse, validation,
index widening, decoded ownership, abort, and cleanup run in the worker. Large
bytes never cross the structural SPSC ring or return to the main thread.

The Resource Coordinator owns fixed-capacity loading records keyed by complete
generational handles. Each request has a monotonic attempt epoch and a
worker-owned `AbortController`; every async continuation revalidates both before
decode, renderer acquisition, upload, and publication. Failure or cancellation
releases reservations, advances the failed slot generation, and cannot publish a
late descriptor into a reused slot.

Runtime initialization accepts optional immutable geometry limits but supplies
no unmeasured defaults. When configured, the coordinator reserves aggregate
temporary download/decode bytes and enforces retained decoded and resident GPU
geometry budgets before publication. Pull-based engine statistics expose
pending/success/failed/aborted counts plus encoded, temporary, retained, and GPU
byte accounting without frame-time polling.

Publication is atomic: renderer upload succeeds first, then the replayable
descriptor, accounting, and ready state commit together. Abort immediately
before commit removes the just-uploaded buffers. Engine failure/disposal aborts
all active attempts and suppresses late results.

### Renderer residency — Phase 2 implemented

The geometry registry accepts a renderer-owned structural descriptor containing
validated immutable six-float interleaved vertices and `uint32` triangle-list
indices under a complete generational resource key. The type is structurally
compatible with the array fields of `DecodedGeometry` without making the
renderer depend on the asset decoder package. Built-ins and external geometry
share the same upload and ownership path.

Buffer creation is transactional. A failed upload destroys partial buffers and
publishes no registry entry or GPU-byte accounting. Remove and renderer disposal
destroy all owned geometry buffers, stale generations cannot resolve or be
re-registered, resource capacity is checked before GPU allocation, and slots
retire before packed-generation wrap.

External geometry retains a replayable worker-owned decoded descriptor.
Recoverable device loss recreates currently live external geometry before frame
scheduling resumes. Phase 3 makes the Resource Coordinator retain and replay
external descriptors under unchanged handles. A load that finishes decoding
during recovery waits for the replacement renderer, while failed recovery or
disposal invalidates the attempt.

### Budgets and diagnostics — Phase 3 implemented

Runtime initialization now defines immutable engine-level limits for:

- maximum GLB download bytes per request;
- maximum decoded geometry bytes per request;
- total retained decoded geometry bytes;
- geometry registry capacity; and
- renderer GPU geometry bytes.

Admission reserves estimated peak bytes before decode/upload. Failure is typed
and deterministic. No production defaults are selected before committed fixture
measurements.

Pull-based asset statistics are included in the existing worker stats response;
they add no frame-time polling or allocation. Diagnostics include pending loads,
successes, failures, aborted loads, fetched encoded bytes, temporary
reservations, retained decoded CPU bytes, and resident GPU geometry bytes.

### Public loading — Phase 4 implemented

`engine.load.geometry(source, { signal })` is available after initialization
when explicit `geometryLimits` were supplied in `EngineConfig`. Relative string
sources resolve against `document.baseURI`; `URL` values are accepted directly.
The main thread reserves a private generational slot, correlates the worker
transaction by request and complete handle, and installs the opaque public
handle only after renderer residency succeeds.

Failures reject with `GeometryLoadError`, whose stable `code` and `stage`
categorize the failure and identify the boundary. Stable stages are `request`,
`fetch`, `container`, `json`, `schema`, `geometry`, `budget`, `upload`,
`recovery`, and `lifecycle`. Cancellation requested through `AbortSignal` uses
the same class with `name === "AbortError"` and waits for the worker's correlated
cleanup result before releasing the slot. Engine failure and disposal reject
every pending promise with `name === "GeometryLoadError"`; late or duplicate
results cannot publish a handle. When `geometryLimits` are absent, loading is
disabled and rejects with `LUME_ASSET_BUDGET_EXCEEDED` at stage `budget`.

The `geometry-loading` browser example exercises a deterministic constrained
GLB through fetch, worker decode, renderer upload, mesh creation, and pull-based
asset statistics. Its result proves the worker transaction completed rather
than substituting a built-in geometry.

## Explicit non-goals

Milestone 7 does not include:

- `.gltf` plus external buffer/image resolution;
- multiple meshes or primitives in one load;
- materials, textures, samplers, KTX2, or Basis Universal;
- UVs, tangents, vertex colors, morph targets, skinning, or animation;
- Draco or meshopt runtime decode;
- node hierarchy, scene instantiation, transform parenting, or Object3D APIs;
- runtime normal generation, mesh simplification, LODs, or optimization;
- URL deduplication, persistent caches, eviction, pinning, retry, or progress UI;
- progressive/partial rendering;
- an optimizer CLI or custom engine bundle; or
- PBR, lighting, shadows, or other advanced graphics work.

Textures/KTX2 move to a later milestone after geometry ownership, loading,
budgeting, and replay are measured. An offline CLI is designed after the runtime
descriptor stabilizes; production assets should meanwhile be prepared into the
accepted GLB profile before deployment.

## Implementation sequence

### Phase 1: Contracts and fixtures

- Add typed asset error codes and immutable limit types.
- Add deterministic valid and malformed GLB fixtures.
- Implement pure GLB container/accessor validation and decoded byte accounting.
- Keep the decoder independent from runtime and renderer packages.

Exit gate: every ADR 011 validation boundary has a deterministic test and no
engine state is involved.

### Phase 2: Renderer external geometry — implemented

- Generalize immutable mesh upload from built-ins to decoded descriptors.
- Preserve the current six-float vertex layout and `uint32` indices.
- Test partial buffer creation failure, complete destruction, stale generation,
  resource-capacity failure, and generation retirement.

Exit gate: external descriptors can be registered/removed/replayed without ECS
or public API changes.

### Phase 3: Worker loading transaction — implemented

- Add versioned load/abort/result protocol records.
- Add worker fetch, reservation, attempt epochs, decode, renderer upload, and
  rollback.
- Integrate external geometry records into Resource Coordinator usage edges and
  device-loss replay.

Exit gate: concurrent, aborted, failed, late, and recovery-interleaved loads are
transactional under deterministic state-machine tests.

### Phase 4: Public API — implemented

- Add `engine.load.geometry` and optional `AbortSignal` support.
- Install public handles only after matching worker readiness.
- Reject pending promises on engine failure/disposal.
- Document normal loading, abort, error handling, mesh creation, and disposal.

Exit gate: browser integration proves decode executes in the worker and a loaded
handle follows the existing mesh/resource lifecycle.

### Phase 5: Measurement and completion

- Commit raw benchmark fixtures, environment, runner, and results.
- Validate peak and retained CPU/GPU memory against accounting.
- Verify zero asset-related steady-state frame allocations/messages after load.
- Update architecture, current-state, roadmap, examples, and package docs.

Exit gate: implementation, tests, controlled evidence, and documentation agree.

## Correctness matrix

Implementation is incomplete without coverage for:

- valid `UNSIGNED_SHORT` and `UNSIGNED_INT` index inputs;
- every malformed/unsupported boundary in ADR 011;
- concurrent requests completing out of order;
- abort before posting and during fetch/decode/upload/publication;
- capacity and byte-budget rejection before partial publication;
- renderer upload failure after vertex-buffer success;
- engine failure/disposal with pending requests;
- stale completion after slot generation or attempt epoch changes;
- mesh usage edges keeping retired geometry alive;
- final usage release destroying CPU and GPU ownership once;
- wrong-kind, foreign, retired, destroyed, and stale handle rejection;
- device loss during loading and after readiness;
- replay of all live external geometry, including retirement-pending usage, and
  no finalized records;
- deterministic cleanup of temporary source/decoded/upload memory; and
- unchanged frame allocation/message counters after loading settles.

## Benchmark plan

Use deterministic GLB fixtures in at least these classes:

| Class  | Vertices | Indices | Purpose                                   |
| ------ | -------: | ------: | ----------------------------------------- |
| Small  |       1k |      3k | fixed overhead and common web object      |
| Medium |     100k |    300k | product-detail geometry                   |
| Large  |       1M |      3M | limits, peak memory, and failure behavior |

For each supported index width record:

- GLB bytes and fetch/read duration;
- JSON/chunk parse and validation duration;
- index widening and total decode duration;
- renderer buffer creation/upload duration;
- end-to-end promise latency;
- temporary peak, retained decoded CPU, WASM, and GPU bytes;
- device-loss replay duration and bytes;
- abort/failure cleanup time; and
- steady-state frame allocations, messages, uploads, and CPU/GPU timings after
  the load settles.

Browser, OS, GPU adapter, sample count, warmup, tested commit, and configured
budgets must accompany results. Unsupported large cases are reported as skipped
with the exact limit.

No claim that GLB, worker decoding, index widening, or retained replay data is
fast is accepted without these measurements.

## Completion criteria

Milestone 7 is complete only when:

- ADR 011 and ADR 012 are implemented rather than merely accepted;
- the complete correctness matrix passes;
- public API and worker/browser integration tests pass;
- all repository format, lint, type, Clippy, Rust, and TypeScript gates pass;
- controlled benchmark results and memory accounting are committed;
- device-loss replay and engine disposal cover external geometry;
- docs and examples distinguish implemented support from future asset work; and
- no texture, scene-graph, streaming, cache, or optimizer scope entered the
  milestone implicitly.

## Next milestone boundary

After Milestone 7, the next design step is texture/sampler ingestion with KTX2
and GPU-format capability selection. It must define color space, mip residency,
compression fallback, material dependencies, CPU/GPU budgets, and replay before
PBR or general glTF scene loading begins.
