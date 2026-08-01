# Milestone 2 — render extraction and indexed meshes

## Architecture change

Milestone 1 proved the worker, raw-WASM, and WebGPU path. Milestone 2 removes the
remaining direct coupling between simulation data and drawing:

```text
ECS World -> Transform/Camera Systems -> Render Extraction -> RenderWorld
                                                        -> WebGPU Renderer
```

`World` remains the canonical simulation store. `RenderWorld` is a transient,
flat, renderer-facing snapshot with preallocated capacity. Extraction joins
`MeshRenderer`, `Transform`, and `Material` sparse sets and writes interleaved
GPU instance records plus geometry handles. Cameras are extracted into a
separate uniform-ready array. Neither structure contains object references or a
scene graph.

This boundary is necessary because simulation layout and GPU layout evolve for
different reasons. It permits future interpolation, visibility filtering,
level-of-detail selection, multi-camera rendering, and parallel extraction
without making renderer code understand ECS queries.

## Frame memory contract

- Structural commands may allocate before or between frames.
- `World::update` and render extraction do not allocate.
- `RenderWorld` has a fixed configured capacity and reports overflow instead of
  growing during extraction.
- The WebAssembly bridge exposes stable pointers to full-capacity render arrays.
  TypeScript creates typed-array views once and only changes logical counts.
- Camera and instance GPU buffers are allocated once. Frame updates use
  `queue.writeBuffer` into those existing buffers.
- WebGPU-mandated current-texture, view, encoder, pass, and command-buffer
  handles remain unavoidable browser allocations.

## Mesh ownership

Application geometry is represented by immutable numeric handles. The renderer
owns a mesh registry mapping each handle to one vertex buffer, one index buffer,
index metadata, and its byte cost. CPU mesh data is accepted only at upload
time. Registry disposal destroys every owned GPU buffer exactly once.

Built-in triangle and indexed cube meshes use the same upload path. Consecutive
instances of the same geometry are submitted as one instanced indexed draw;
material color and world matrix are fetched by instance index from a storage
buffer.

## Camera model

Transform stores local position, quaternion rotation, scale, and a derived world
matrix. With no scene graph, local and world space are intentionally identical
in this milestone. CameraSystem derives a view matrix from the camera transform
and a WebGPU depth-range projection matrix. Extraction places both matrices in a
128-byte uniform-ready record.

## Performance validation

`benchmarks/runner` measures ECS creation, transform insertion/iteration/query,
10k and 100k transform systems, extraction, and allocation counts. Browser
harnesses under `benchmarks/renderer` and `benchmarks/comparison` record render
submission and matched Three.js scenarios. Every emitted JSON record includes
engine version, configuration, platform/browser metadata, raw samples, and
summary metrics.

Renderer comparisons are diagnostic rather than promotional. A result is valid
only when browser, hardware, resolution, warmup, geometry, camera, and workload
match. GPU timing is reported only when timestamp queries are actually available;
it is never inferred from CPU frame time.
