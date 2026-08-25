# ADR 012: Asynchronous Geometry Loading and Atomic Publication

## Status

Accepted

## Date

2026-08-25

## Context

ADR 011 selects a constrained GLB geometry profile. The engine still needs a
public and cross-thread loading contract that does not expose worker messages,
registry slots, decoded bytes, or WebGPU objects.

Loading spans URL resolution, fetch, byte admission, parse, validation, decode,
resource allocation, GPU upload, and main-thread promise settlement. Failure,
abort, disposal, or device loss may occur at any boundary. A late completion
must never publish into a retired or recycled slot.

The current synchronous `engine.create` API publishes small descriptors through
the structural transport. Large asset bytes must not use that command ring or
block the main thread.

## Options considered

### Fetch and decode on the main thread

This simplifies promise ownership but competes with application input and UI,
duplicates large bytes across the worker boundary, and makes the public API own
runtime asset data. Rejected.

### Return a public mutable loading object

A loading object could expose progress and state transitions immediately, but
would commit the public API to mutable resource-state semantics before progress,
retry, caching, and eviction are designed. Rejected for the first milestone.

### Return a promise and execute the complete load in the worker

The main thread owns only request correlation and the eventual opaque handle.
The worker owns fetch, decode, canonical lifecycle, decoded bytes, and renderer
publication. An optional `AbortSignal` supplies cancellation without exposing
internal loading state.

Selected.

## Decision

Milestone 7 adds this public API:

```ts
const geometry = await engine.load.geometry("/assets/product.glb", {
  signal,
});

const product = engine.create.mesh({ geometry });
```

The conceptual types are:

```ts
interface LoadApi {
  geometry(source: string | URL, options?: GeometryLoadOptions): Promise<GeometryHandle>;
}

interface GeometryLoadOptions {
  readonly signal?: AbortSignal;
}
```

`engine.load.geometry` resolves only after the geometry record and renderer
residency are ready. It rejects with a typed error for URL, network, abort,
format, validation, capacity, budget, upload, recovery, or engine-lifecycle
failure. It never returns a partially ready handle.

The main thread resolves the URL, validates immediate engine/abort state,
allocates a monotonically correlated request ID, and posts a small load request.
The worker performs fetch and decode. Large GLB or decoded buffers are never
sent through the structural SPSC ring and are never copied back to the main
thread.

## Worker state and identity

The worker Resource Coordinator allocates the canonical geometry slot before
loading and associates it with:

- complete slot generation;
- monotonically increasing load-attempt epoch;
- request ID;
- lifecycle state from ADR 004;
- byte reservations and temporary ownership; and
- an `AbortController` for worker-owned fetch cancellation.

Every asynchronous continuation validates both generation and attempt epoch
before mutating state. Abort, retirement, retry, disposal, or failed recovery
invalidates the attempt epoch. Late fetch/decode/upload completion disposes its
temporary resources and cannot resurrect the record.

The main-thread liveness mirror installs the public owner handle only when the
matching ready response arrives. A stale or duplicate response is ignored. If
the engine fails or is disposed, all pending promises reject and later worker
responses cannot settle them again.

## Atomic publication transaction

Loading uses a cold-path transaction:

1. Validate engine state, URL, request options, and available registry slot.
2. Reserve configured download and estimated peak decode bytes.
3. Fetch GLB bytes in the worker with size enforcement.
4. Parse, validate, and decode into temporary typed arrays under ADR 011.
5. Reserve final decoded CPU and GPU bytes.
6. Create renderer buffers transactionally under the complete resource key.
7. Commit the worker resource record, replay descriptor, accounting, and ready
   state together.
8. Notify the main thread and resolve the matching promise with its opaque
   `GeometryHandle`.

Any failure before step 7 releases temporary buffers and reservations, destroys
partial GPU objects, and leaves no ready record. A main-thread handle is never
published for the failed generation. The failed internal record may retain a
typed diagnostic until its request is settled, then follows ADR 004 disposal
rules.

Geometry load operations are ordered independently from frame-time structural
commands. Once ready, using the returned handle in `engine.create.mesh` follows
the existing ordered Resource Coordinator and usage-edge path. No mesh command
can legally reference a loading geometry because no public handle exists yet.

## Abort and lifecycle behavior

- An already-aborted signal rejects before posting work.
- Abort during fetch/decode/upload requests cancellation, invalidates the
  attempt epoch, and rejects with an `AbortError` after temporary ownership is
  released.
- Engine failure or disposal rejects all pending loads and cancels worker work.
- Aborting after the promise resolved has no effect; normal `engine.destroy`
  controls the ready resource lifetime.
- Repeated loads of the same URL are independent in Milestone 7. Deduplication
  and cache identity are deferred.

Progress events, retry, pinning, eviction, and public loading-state inspection
are not exposed until their semantics are designed with caching and streaming.

## Threading and performance

Fetch, parse, validation, decode, and replay occur on the engine worker outside
frame callbacks. GPU buffer creation/upload is renderer-owned and occurs at a
bounded asset synchronization point. The implementation may yield between
large cold-path stages, but must not split one geometry publication across
renderable frames.

Asset loading creates promises and temporary arrays by design. Steady-state
frames after loading must retain zero asset-related allocations, polling, graph
walks, or message traffic.

## Protocol and error contract

The worker protocol gains versioned load, abort, ready, and failed messages with
request correlation. Error payloads include a stable asset error code, stage,
message, and optional cause text safe for cross-thread transfer. Internal URLs,
stack traces, or response bodies are not exposed unless already available to
the application and safe to report.

Expected error categories include:

- `LUME_ASSET_ABORTED`;
- `LUME_ASSET_NETWORK`;
- `LUME_ASSET_FORMAT`;
- `LUME_ASSET_UNSUPPORTED`;
- `LUME_ASSET_CAPACITY_EXHAUSTED`;
- `LUME_ASSET_BUDGET_EXCEEDED`; and
- `LUME_ASSET_GPU_UPLOAD`.

## Consequences

### Positive

- The common API is one await plus an opaque geometry handle.
- Main-thread UI and memory remain isolated from decoding.
- Failed and cancelled loads cannot publish partial renderer or lifecycle state.
- Existing mesh creation, generational validation, and device recovery remain
  the only path from a ready geometry to rendering.

### Negative

- A handle is unavailable while loading, so Milestone 7 cannot attach pending
  geometry to an entity or expose progressive rendering.
- Duplicate URLs load duplicate resources until caching is designed.
- Worker fetch behavior requires browser integration tests in addition to pure
  decoder tests.
- Progress and retry APIs are deferred.

## Validation requirements

- Synchronous rejection for invalid lifecycle and already-aborted requests.
- Correlated concurrent success/failure responses resolving only their matching
  promises.
- Abort at fetch, decode, renderer upload, and immediately before publication.
- Late completion after abort, disposal, slot reuse, and engine failure.
- Transactional cleanup for every allocation/upload failure boundary.
- Ready geometry usage, retirement while referenced, final destruction, and
  stale/foreign handle rejection under ADR 004.
- Device-loss replay during and after loading.
- Protocol version mismatch coverage.
- Browser worker tests proving fetch/decode does not execute on the main thread.
- Benchmarks for latency, throughput, peak/retained memory, and steady-state
  frame allocation after load completion.

## Future impact

A future `engine.load.asset()` may compose geometry, material, texture, and
scene-recipe loads over this request and transaction model. Streaming may expose
progressive readiness, but it must add explicit publication epochs and cannot
weaken the ready-handle guarantee of `engine.load.geometry()`.
