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
| 2     | Pending     | Renderer external geometry registration and replay                |
| 3     | Pending     | Worker loading transaction and Resource Coordinator integration   |
| 4     | Pending     | Public `engine.load.geometry()` API and browser integration       |
| 5     | Pending     | Controlled measurements, final documentation, and completion gate |

Phase 1 implementation does not make external geometry loadable through the
engine yet.

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

These decisions do not mark implementation complete.

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

### Runtime orchestration

Add request-correlated worker messages and Resource Coordinator loading records.
Fetch, byte admission, parse, validation, index widening, decoded ownership,
abort, and cleanup run in the worker. Large bytes never cross the structural
SPSC ring or return to the main thread.

### Renderer residency

Extend the geometry registry to accept validated immutable vertex/index arrays
under a complete generational resource key. Buffer creation remains
transactional. Failed upload destroys partial buffers and publishes no ready
resource.

External geometry retains a replayable worker-owned decoded descriptor.
Recoverable device loss recreates currently live external geometry before frame
scheduling resumes. Handles remain unchanged.

### Budgets and diagnostics

Define immutable engine-level limits for at least:

- maximum GLB download bytes per request;
- maximum decoded geometry bytes per request;
- total retained decoded geometry bytes;
- geometry registry capacity; and
- renderer GPU geometry bytes.

Admission reserves estimated peak bytes before decode/upload. Failure is typed
and deterministic. Exact defaults require committed fixture measurements.

Expose pull-based asset statistics only if they can be produced without
frame-time polling or allocation. Required implementation diagnostics include
pending loads, successes, failures, aborted loads, encoded bytes, decoded CPU
bytes, and resident GPU geometry bytes.

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

### Phase 2: Renderer external geometry

- Generalize immutable mesh upload from built-ins to decoded descriptors.
- Preserve the current six-float vertex layout and `uint32` indices.
- Test partial buffer creation failure, complete destruction, stale generation,
  resource-capacity failure, and generation retirement.

Exit gate: external descriptors can be registered/removed/replayed without ECS
or public API changes.

### Phase 3: Worker loading transaction

- Add versioned load/abort/result protocol records.
- Add worker fetch, reservation, attempt epochs, decode, renderer upload, and
  rollback.
- Integrate external geometry records into Resource Coordinator usage edges and
  device-loss replay.

Exit gate: concurrent, aborted, failed, late, and recovery-interleaved loads are
transactional under deterministic state-machine tests.

### Phase 4: Public API

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
- replay of all live external geometry and no retired geometry;
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
