# ADR 011: GLB Geometry Ingestion Boundary

## Status

Accepted

## Date

2026-08-25

## Context

The engine currently creates renderer geometry only from two built-in CPU
descriptors. ADR 004 defines generational resource identity, ownership,
retirement, budgets, and device-loss replay, but it intentionally does not
choose an external asset format or a decoded geometry representation.

Milestone 7 needs the smallest production-shaped path from external bytes to an
immutable geometry resource. It must preserve these boundaries:

```text
GLB bytes
  -> asset decoder and validation
  -> device-independent geometry descriptor
  -> Resource Coordinator
  -> renderer geometry registry
  -> GPU buffers
```

The decoder must not create ECS entities, components, WebGPU objects, or public
scene graphs. Runtime work must remain outside frame execution, malformed input
must fail before publication, and the result must be replayable after device
loss.

## Options considered

### Load arbitrary glTF scenes directly into ECS

This provides an immediately familiar scene-loading API, but couples file node
hierarchy to engine entities, requires transform hierarchy semantics, and
combines geometry, materials, textures, animation, and instantiation in one
change. It violates the milestone's geometry-only boundary.

### Define a custom engine bundle before supporting GLB

A custom bundle could be fully runtime-ready and streaming-oriented. Defining
it now would freeze vertex, texture, dependency, and packaging decisions before
the engine has measured one real ingestion path. Tooling and ecosystem support
would also be required before the format could be useful.

### Accept application-provided typed arrays as the primary asset workflow

Typed arrays are a useful advanced escape hatch, but they do not define a web
delivery format, validation policy, offline workflow, or shared loading model.
They are not a substitute for an asset pipeline.

### Decode a deliberately limited GLB geometry profile

GLB 2.0 is broadly supported by creative tools and keeps JSON metadata and
binary payloads in one fetchable object. A constrained profile allows the
engine to validate and measure the complete loading boundary without committing
to scene hierarchy, materials, or a custom bundle.

Selected.

## Decision

Milestone 7 accepts GLB 2.0 as its only external runtime input. The public entry
point loads one immutable mesh-local geometry resource. The accepted profile is:

- one glTF `mesh` containing exactly one primitive;
- triangle-list topology (`mode` omitted or `4`);
- required indexed geometry;
- required `POSITION` and `NORMAL` attributes;
- `FLOAT` `VEC3` positions and normals;
- `UNSIGNED_SHORT` or `UNSIGNED_INT` scalar indices;
- tightly packed or validly strided buffer views;
- finite attribute values and in-range indices; and
- no sparse accessors, morph targets, skin attributes, compression extensions,
  materials, textures, animation, or required unknown extensions.

The loader returns mesh-local geometry. glTF scenes, nodes, node transforms,
cameras, lights, and hierarchy are not instantiated or interpreted. Their
presence may be ignored when they do not alter the selected mesh payload, but
multiple meshes or primitives are rejected rather than selected implicitly.

The decoder converts accepted input into one internal, device-independent
descriptor:

```text
DecodedGeometry
  interleavedVertices: Float32Array  // position.xyz + normal.xyz
  indices: Uint32Array
  vertexCount: u32
  indexCount: u32
  bounds: { min: Vec3, max: Vec3 }  // verified mesh-local POSITION bounds
  replay metadata and accounted byte lengths
```

Six interleaved floats preserve the renderer's current immutable mesh vertex
layout. Sixteen-bit source indices are widened once during decode; the renderer
continues using `uint32` index buffers. This one-time conversion is measured as
decode cost and never occurs in a frame path.

`DecodedGeometry` is internal. The public API exposes only an opaque
`GeometryHandle`. The descriptor belongs to the worker resource record, while
the renderer owns GPU buffers derived from it. Rust ECS components and
RenderWorld continue carrying only the complete generational geometry key.

## Validation and security

GLB input is untrusted. Validation occurs before resource publication and must
check at minimum:

- GLB magic, version, declared length, chunk order, and chunk bounds;
- JSON schema fields used by the accepted profile;
- integer overflow in byte-offset, stride, count, and allocation calculations;
- accessor and buffer-view bounds, alignment, component types, and shapes;
- configured download, decoded-CPU, vertex, and index limits;
- finite position and normal values;
- every index against vertex count; and
- unsupported required extensions.

The decoder reserves estimated peak bytes before allocating decoded arrays. A
limit violation produces a typed asset error and publishes no partial resource.
Exact default budgets are selected from committed benchmark fixtures before the
milestone is marked implemented.

## Offline-first policy

Milestone 7 includes a runtime decoder because web applications need a complete
loading path. It does not ship an optimizer CLI. Production guidance requires
assets to be exported or preprocessed into the accepted GLB profile before
deployment.

A later CLI should reuse the same validation and descriptor rules to optimize
vertex/index order and emit compliant GLB. A custom runtime bundle, meshopt or
Draco compression, LOD generation, and texture processing require separate
measured decisions. Runtime support must not perform work merely because it
could have been done offline.

## Ownership and recovery

ADR 004 remains authoritative for handles, strong edges, retirement, and
generation safety. For Milestone 7, a ready external geometry retains its
validated decoded arrays in the worker-owned resource record until retirement
or engine disposal. Device-loss recovery replays those arrays into a replacement
renderer registry without refetching and without changing the handle.

Retaining decoded arrays intentionally trades CPU memory for deterministic,
low-latency replay in the first implementation. Eviction, encoded-source-only
replay, refetch policy, and caching are deferred until memory measurements
justify the added state machine.

## Consequences

### Positive

- The first external asset path is small, testable, and aligned with the current
  renderer layout.
- GLB parsing remains separate from ECS and WebGPU ownership.
- Resource publication is all-or-nothing and device-loss replay is deterministic.
- The design leaves room for offline optimization and richer asset containers
  without prematurely freezing them.

### Negative

- Common multi-primitive and textured glTF assets are rejected in Milestone 7.
- Widening 16-bit indices adds one decoded copy and can increase GPU index bytes.
- Retaining decoded arrays increases worker CPU memory until eviction exists.
- The accepted profile is an ingestion foundation, not a complete glTF loader.

## Validation requirements

- Fixture tests for valid 16-bit and 32-bit indexed GLBs.
- Rejection tests for malformed chunks, overflow, out-of-range accessors and
  indices, non-finite attributes, unsupported modes, sparse data, multiple
  meshes/primitives, and unknown required extensions.
- Exact accounting tests for encoded, temporary, decoded, and GPU bytes.
- Device-loss replay tests proving identical handle and buffer contents.
- No decoder, allocation, or validation work in extraction or rendering.
- Benchmarks for parse, validation, index widening, upload, retained memory, and
  recovery using small, medium, and large deterministic fixtures.

## Future impact

Textures/KTX2, materials, multi-primitive assets, scene recipes, compression,
streaming, caching, and an offline CLI build on this boundary but are not implied
by accepting GLB geometry ingestion.
