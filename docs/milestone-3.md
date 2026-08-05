# Milestone 3 — visibility and frame orchestration

## Scope

Milestone 3 changes rendering architecture rather than visual output. The frame
pipeline becomes:

```text
World -> systems -> RenderWorld -> visibility -> VisibleRenderBuffer
      -> reusable FrameGraph -> WebGPU commands
```

## Visibility ownership

The Rust core owns visibility because it already owns transforms, bounds, and
camera matrices. Extraction writes world-space bounding spheres. A dedicated
frustum-culling system consumes RenderWorld and writes a fixed-capacity visible
buffer. The renderer never evaluates bounds or decides whether an item is
visible.

Visible items are compacted and ordered by `(pipeline, material, mesh)` before
crossing the WASM boundary. Sorting and compaction reuse reserved storage and
must remain allocation-free in benchmarks.

## Materials

`MaterialHandle` is a compact ID into `MaterialRegistry`. Milestone 3 supports
only `BasicMaterial { color, pipeline_id }`. Mesh components retain handles,
never material objects. The renderer resolves pipeline IDs and consumes
already-grouped items; textures, PBR, lighting variants, and bindless resources
are intentionally out of scope.

## Frame graph

The TypeScript renderer owns a small, reusable FrameGraph. Pass declarations,
resource handles, dependencies, and execution order are compiled during
initialization. A frame only updates the existing context and executes the
precomputed pass order. Upload and main-render are separate passes, providing a
real dependency seam without a general-purpose render-graph framework.

## GPU profiling

Timestamp queries are requested only when the adapter reports
`timestamp-query`. The profiler owns its query set, resolve buffer, readback
ring, and nanosecond-to-millisecond conversion. Results are delayed and
asynchronous; the latest completed value is returned. Unsupported or not-yet-
resolved GPU time is `null` and is never inferred from CPU timings.

## Public API review

The existing `engine.world` surface exposes ECS vocabulary and remains an
advanced compatibility layer. Milestone 3 adds a functional authoring layer:

```text
createEngine(canvas)
engine.create.basicMaterial(...)
engine.create.mesh(...)
engine.camera.setPerspective(...)
engine.set.transform(handle, ...)
engine.destroy(handle)
```

Handles are immutable values. Mutation remains an explicit engine operation;
there are no scene objects with hidden mutable state.

## Acceptance rules

- World update, extraction, culling, visible compaction, frame-graph execution,
  and render submission allocate no engine-owned memory per frame.
- Culling is benchmarked at 100%, 50%, 10%, and 1% visibility for 100k items.
- Browser render results contain raw samples and environment metadata.
- Three.js comparison data is raw JSON only; this milestone publishes no
  comparative conclusion.

The native culling report is committed under `benchmarks/results`. The browser
comparison harness is production-build validated, but a raw comparison run
requires a connected WebGPU-capable Browser or Chrome session. A `not-run`
status artifact is committed when that execution environment is unavailable;
it must never be interpreted as measurement data.
